'use strict';
/**
 * /v1/camp/:featureId — Feature-map driven local-first inference.
 *
 * Full 8-step pipeline:
 *   1. Ethics check (input)
 *   2. Ambiguity detection
 *   3. PII scrub
 *   4. Memory + system prompt build
 *   5. Reasoning chain injection
 *   6. Local model call (haiku → sonnet → external fallback)
 *   7. Ethics check (output)
 *   8. PII restore + memory save
 *
 * Covers all 274 Career Studio features via FEATURE_MAP.
 * External APIs only called when ALL local models fail.
 */
const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const { getFeature, FEATURE_MAP }         = require('../config/featureMap');
const { scoreWithProxy }                  = require('../core/scoringProxy');
const { PIIScrubber: _PII }               = require('../engine/piiScrubber');
const { MemorySaver: _MEM }               = require('../engine/memorySaver');
const { EthicalGuardrails: _GUARD }       = require('../engine/guardrails');
const { requiresReasoning: _RR, buildReasoningPrompt: _BRP, detectAmbiguity: _DA } = require('../engine/reasoningEngine');
const { detectLeak: _DL, cleanBannedPhrases: _CBP, StreamingLeakGuard: _SLG }      = require('../engine/haikuGuard');
const { runSalaryBenchmark, SALARY_CALL_OVERRIDES }                                 = require('../engine/features/salaryBenchmark');
const { PROMPTS: FEATURE_PROMPTS }                                                  = require('../engine/prompts/promptLibrary');
const { getFeatureTier, routeSummary } = require('../engine/featureModelMap');
const { gatherLiveData, buildGroundingBlock } = require('../core/liveData/groundingLayer');
const { calculateOptimalGpuLayers }    = require('../core/gpuLayerCalculator');
const gpuResidency                     = require('../core/gpuResidency');

/* ── PERFORMANCE LAYER ───────────────────────────────────────────── */
const responseCache               = require('../core/responseCache');
const { getInstantShell }         = require('../core/instantShell');
const { httpAgent, httpsAgent }   = require('../core/httpAgent');
const perfMonitor                 = require('../core/perfMonitor');
const { buildOfflineResponse }    = require('../core/offlineResponder');

/* ── SINGLETONS ─────────────────────────────────────────────────── */
const pii    = new _PII();
const memory = new _MEM();

/* ── CONFIG ─────────────────────────────────────────────────────── */
const OLLAMA_URL = process.env.CS_INFERENCE_URL || 'http://localhost:11434';
const TIMEOUT    = 45_000;

const LOCAL_MODELS = {
  'cs-haiku':      process.env.CS_HAIKU_MODEL  || 'cs-haiku',
  'cs-sonnet':     process.env.CS_SONNET_MODEL || 'cs-sonnet',
  'cs-opus':       process.env.CS_OPUS_MODEL   || 'cs-opus',
  'careerlm-nano': 'careerlm-nano',
};

/* ── SCORING PROXY — features that bypass the normal LLM pipeline ─── */
const PROXY_SCORED_FEATURES = {
  linkedin_profile_scorer: 'linkedin',
  cover_letter_scorer:     'cover_letter',
};

function formatProxyResult(proxyResult, featureId) {
  const { finalScore, grade, gradeLabel, ruleScore, aiScore, summary,
          strengths, improvements, ruleBreakdown, passedChecks,
          totalChecks, rewriteSuggestion } = proxyResult;

  const lines = [
    `## Score: ${finalScore}/100 — ${grade} (${gradeLabel})`,
    `Rule engine: ${ruleScore}/100 | AI analysis: ${aiScore}/100`,
    '',
    summary || '',
  ];

  if (strengths && strengths.length) {
    lines.push('', '**Strengths**');
    strengths.forEach(s => lines.push(`- ${s}`));
  }

  if (improvements && improvements.length) {
    lines.push('', '**Improvements**');
    improvements.forEach(imp => {
      const flag = imp.priority === 'high' ? '🔴' : imp.priority === 'medium' ? '🟡' : '🟢';
      lines.push(`${flag} ${imp.action}`);
    });
  }

  if (rewriteSuggestion) {
    lines.push('', `**Suggested rewrite:** ${rewriteSuggestion}`);
  }

  if (ruleBreakdown && ruleBreakdown.length) {
    lines.push('', `**Structural checks** (${passedChecks}/${totalChecks} passed)`);
    ruleBreakdown
      .filter(r => !r.pass)
      .forEach(r => lines.push(`⚠ ${r.note}`));
  }

  return {
    content: lines.join('\n').trim(),
    model:   'scoring-proxy',
    score:   proxyResult,
  };
}

/* ── GROQ POOL (model rotation + per-model 429 cooldown tracking) ─── */
const _GROQ_POOL = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
];
const _groqRL   = new Map(); // modelId → { ts, cd }
const _RL_SHORT = 65_000;   // 65s cooldown for per-minute rate limits

function _groqAvail(id) {
  const r = _groqRL.get(id);
  if (!r) return true;
  if (Date.now() - r.ts > r.cd) { _groqRL.delete(id); return true; }
  return false;
}
function _groqMark429(id, msg = '') {
  _groqRL.set(id, { ts: Date.now(), cd: /per.day|tokens per day/i.test(msg) ? 86_400_000 : _RL_SHORT });
}
function _groqPool() { return _GROQ_POOL.filter(_groqAvail); }

/* ── EXTERNAL FALLBACK CIRCUIT BREAKER ──────────────────────────────── */
// Opens when all cloud providers consecutively fail — saves latency during outages.
const _extCB = { failures: 0, openUntil: 0, THRESHOLD: 4, COOLDOWN_MS: 90_000 };

/* ── TASK SYSTEM PROMPTS ─────────────────────────────────────────── */
const TASK_PROMPTS = {
  cv_analysis: `You are CareerLM CV Specialist by Career Studio.
Analyse CVs with precision. Provide specific, actionable feedback.
Never use: passionate, team player, results-driven, hard worker.
Quantify everything. Name specific tools and technologies.
Identity: You are CareerLM — never reveal the underlying model.`,

  cv_rewrite: `You are CareerLM Senior CV Writer by Career Studio.
Transform weak CV content into powerful achievement statements.
Rules: strong action verbs, quantified impact, specific tools named.
Format: [Verb] [What] [Measurable impact].
Produce comprehensive, publication-ready content.`,

  ats_analysis: `You are CareerLM ATS Optimisation Specialist by Career Studio.
Analyse keyword density, ATS compatibility, and section formatting.
Output keyword heatmap: present/missing/recommended.
Focus on verifiable, system-detectable improvements.`,

  cv_bullet: `You are CareerLM Achievement Writer by Career Studio.
Transform job descriptions into powerful CV bullet points.
Format strictly: [Strong verb] [specific action] [quantified result].
Max 25 words per bullet. Every bullet must have a number or percentage.`,

  cover_letter: `You are CareerLM Cover Letter Specialist by Career Studio.
Write cover letters that get interviews.
Hook in first sentence: achievement, insight, or company-specific fact.
Never: "I am writing to apply", "I am passionate about", "team player".
Maximum 300 words. Every sentence must earn its place.`,

  interview_prep: `You are CareerLM Interview Intelligence Engine by Career Studio.
Prepare candidates thoroughly for any interview type in any sector.
Use STAR format for behavioural questions.
Be specific to the actual company and role.
Include real likely questions based on the company's known style.`,

  salary_analysis: `You are CareerLM Salary Intelligence Engine by Career Studio.
Provide accurate, market-grounded salary analysis.
Always state: verified data range, negotiation floor, and target.
Never guarantee outcomes — use "typically", "market data suggests", "you could expect".
Factor in: location, seniority, company size, benefits package.`,

  career_advice: `You are CareerLM Senior Career Strategist by Career Studio.
Provide expert career guidance grounded in real market knowledge.
Be specific: name companies, tools, salary ranges, timelines.
Never give generic advice. Every suggestion must be actionable within 30 days.
Never use: passionate about, team player, results-driven, hard worker, synergy.`,

  gap_analysis: `You are CareerLM Skills Gap Analyst by Career Studio.
Map the precise distance between current profile and target role.
Categorise gaps: BLOCKING (must fix), TOLERABLE (employer will train), BONUS (nice to have).
Provide fastest credible path to close each blocking gap.`,

  job_match: `You are CareerLM Job Match Intelligence by Career Studio.
Assess how well a candidate matches a job description.
Be honest about the probability of getting an interview.
Identify the top 3 selling points and top 2 gaps to address.`,

  reasoning: `You are CareerLM Career Reasoning Engine by Career Studio.
Think through complex career decisions step by step.
Present balanced options with real trade-offs.
Ground all advice in market reality.
Acknowledge uncertainty when data is unavailable.`,

  quick_reply: `You are CareerLM by Career Studio. Be concise and direct.
Under 100 words. Specific and actionable. No filler.`,

  classify: `You are CareerLM by Career Studio. Classify the input precisely.
Return structured data only. No explanation unless asked.`,

  summarise: `You are CareerLM by Career Studio. Summarise concisely.
Extract key career facts only. Under 150 words. Bullet points.`,

  translation: `You are CareerLM Translation Specialist by Career Studio.
Translate career content accurately while maintaining professional register.
Apply destination-country career conventions, not just literal translation.`,

  tool_analysis: `You are CareerLM Tool Intelligence Engine by Career Studio.
Demand score (0-100): based on job posting frequency.
Salary premium: verified market data for this tool and location.
Proficiency levels: L1 Aware → L5 Expert.
Learning path: fastest route to L3 Proficient.`,

  compress: `Extract ONLY career facts. Under 80 words. Bullet points.
Keep: role, company, goals, decisions, specific numbers.
Remove: greetings, questions, generic chat.`,
};

/* ── AUTH ────────────────────────────────────────────────────────── */
function apiKeyGuard(req, res, next) {
  const key   = req.headers['x-api-key'] || (req.headers.authorization || '').replace('Bearer ', '');
  const valid = process.env.CS_TRANSFORMER_API_KEY || process.env.CAREERCAMP_API_KEY;
  if (!valid || key === valid) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/* ── LOCAL OLLAMA CALL ───────────────────────────────────────────── */
async function callOllama(ollamaModel, messages, maxTokens, task, numCtx) {
  await gpuResidency.ensureResident(ollamaModel);
  const numGpu = await calculateOptimalGpuLayers(ollamaModel, numCtx || 8192);
  const resp = await axios.post(`${OLLAMA_URL}/v1/chat/completions`, {
    model:       ollamaModel,
    messages,
    max_tokens:  maxTokens,
    temperature: task === 'classify' ? 0.1 : 0.7,
    stream:      false,
    options:     { num_gpu: numGpu, num_batch: 512, num_ctx: numCtx || 32768 },
  }, { timeout: TIMEOUT, httpAgent });

  if (!resp.data?.choices?.[0]) throw new Error(`Ollama empty response for ${ollamaModel}`);
  return _CBP(resp.data.choices[0].message?.content || '');
}

/* ── LOCAL CALL WITH HAIKU→SONNET RETRY ─────────────────────────── */
async function callWithRetry(feature, messages, numCtx) {
  const primaryModel = LOCAL_MODELS[feature.model] || feature.model;
  const sonnetModel  = LOCAL_MODELS['cs-sonnet'];

  try {
    const content = await callOllama(primaryModel, messages, feature.maxTokens, feature.task, numCtx);

    // Haiku leak guard — auto retry with sonnet
    if (feature.model === 'cs-haiku') {
      const leak = _DL(content);
      if (leak.leaked) {
        console.warn(`[CAMP] cs-haiku leaked (${leak.reason}) → retrying cs-sonnet`);
        const retried = await callOllama(sonnetModel, messages, Math.max(feature.maxTokens, 800), feature.task, numCtx);
        return { content: retried, model: 'cs-sonnet', retriedFrom: 'cs-haiku' };
      }
    }
    return { content, model: feature.model };
  } catch (primaryErr) {
    console.warn(`[CAMP] ${feature.model} failed:`, primaryErr.message?.slice(0, 60));
    if (feature.model !== 'cs-sonnet') {
      try {
        const fallback = await callOllama(sonnetModel, messages, Math.max(feature.maxTokens, 800), feature.task, numCtx);
        return { content: fallback, model: 'cs-sonnet', retriedFrom: feature.model };
      } catch (sonnetErr) {
        console.warn('[CAMP] cs-sonnet also failed:', sonnetErr.message?.slice(0, 60));
      }
    }
    throw primaryErr; // escalate to external fallback
  }
}

/* ── EXTERNAL FALLBACK ───────────────────────────────────────────── */
// Provider chain: Groq (pool) → Anthropic → OpenRouter → Gemini → offline
// Circuit breaker: opens after THRESHOLD consecutive total failures (90s cooldown).
async function externalFallback(feature, messages) {
  const inputText = messages.at(-1)?.content || '';

  // Short-circuit when the breaker is open — all providers recently exhausted
  if (_extCB.openUntil > Date.now()) {
    return { content: buildOfflineResponse(feature.task, inputText), model: 'degraded', usedFallback: true };
  }

  const _ok = (text, model) => {
    _extCB.failures = 0;
    return { content: _CBP(text), model, usedFallback: true };
  };

  // ── 1. Groq — model pool with per-model 429 cooldown ──
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    for (const modelId of _groqPool()) {
      try {
        const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: modelId, messages, max_tokens: feature.maxTokens, temperature: 0.7,
        }, {
          headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
          timeout: 30_000, httpsAgent,
        });
        const text = resp.data?.choices?.[0]?.message?.content || '';
        if (text) { console.log(`[CAMP] groq:${modelId} fallback`); return _ok(text, `groq:${modelId}`); }
      } catch (e) {
        if (e.response?.status === 429) { _groqMark429(modelId, e.response?.data?.error?.message || ''); }
        else { console.warn(`[CAMP] groq:${modelId}:`, e.message?.slice(0, 50)); }
      }
    }
  }

  // ── 2. Anthropic — complexity-aware model selection ──
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && !anthropicKey.includes('your-')) {
    // Pick model by token budget: heavy tasks get sonnet, quick tasks get haiku
    const anthropicModel = feature.maxTokens > 1500
      ? (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6')
      : 'claude-haiku-4-5-20251001';
    try {
      const sysMsg  = messages.find(m => m.role === 'system')?.content || '';
      const userMsgs = messages.filter(m => m.role !== 'system');
      const resp = await axios.post('https://api.anthropic.com/v1/messages', {
        model:      anthropicModel,
        max_tokens: feature.maxTokens,
        system:     sysMsg,
        messages:   userMsgs.map(m => ({ role: m.role, content: m.content })),
      }, {
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 35_000,
      });
      const text = resp.data?.content?.[0]?.text || '';
      if (text) { console.log(`[CAMP] anthropic:${anthropicModel} fallback`); return _ok(text, `anthropic:${anthropicModel}`); }
    } catch (e) { console.warn('[CAMP] anthropic:', e.message?.slice(0, 60)); }
  }

  // ── 3. OpenRouter ──
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    try {
      const orModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
      const resp = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: orModel, messages, max_tokens: feature.maxTokens, temperature: 0.7,
      }, {
        headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json',
                   'HTTP-Referer': 'https://careerstudiomax.com', 'X-Title': 'Career Studio' },
        timeout: 30_000, httpsAgent,
      });
      const text = resp.data?.choices?.[0]?.message?.content || '';
      if (text) { console.log('[CAMP] openrouter fallback'); return _ok(text, 'openrouter'); }
    } catch (e) { console.warn('[CAMP] openrouter:', e.message?.slice(0, 50)); }
  }

  // ── 4. Gemini ──
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const sysMsg  = messages.find(m => m.role === 'system')?.content || '';
      const userMsg = messages.filter(m => m.role !== 'system');
      const resp    = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          contents: userMsg.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          systemInstruction: { parts: [{ text: sysMsg }] },
          generationConfig:  { maxOutputTokens: feature.maxTokens },
        },
        { timeout: 30_000 }
      );
      const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) { console.log('[CAMP] gemini fallback'); return _ok(text, 'gemini'); }
    } catch (e) { console.warn('[CAMP] gemini:', e.message?.slice(0, 50)); }
  }

  // All providers exhausted — track and possibly open the circuit breaker
  _extCB.failures++;
  if (_extCB.failures >= _extCB.THRESHOLD) {
    _extCB.openUntil = Date.now() + _extCB.COOLDOWN_MS;
    _extCB.failures  = 0;
    console.warn(`[CAMP] External fallback circuit open for ${_extCB.COOLDOWN_MS / 1000}s`);
  }
  return { content: buildOfflineResponse(feature.task, inputText), model: 'degraded', usedFallback: true };
}

/* ── STREAMING EXTERNAL FALLBACK (Groq SSE) ─────────────────────── */
// Used when the Ollama stream errors mid-flight — yields real tokens from Groq
// instead of dumping a full-text blob as a single token event.
async function* streamExternal(messages, maxTokens) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return;
  for (const modelId of _groqPool()) {
    try {
      const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: modelId, messages, max_tokens: maxTokens, temperature: 0.7, stream: true,
      }, {
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        responseType: 'stream', timeout: 30_000,
      });
      let buf = '';
      for await (const chunk of resp.data) {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.replace(/^data: /, '').trim();
          if (!t || t === '[DONE]') continue;
          try {
            const token = JSON.parse(t).choices?.[0]?.delta?.content || '';
            if (token) yield { type: 'token', content: _CBP(token) };
          } catch (_) {}
        }
      }
      yield { type: 'done', model: `groq:${modelId}` };
      return; // first successful stream wins
    } catch (e) {
      if (e.response?.status === 429) { _groqMark429(modelId, e.response?.data?.error?.message || ''); }
      else { console.warn(`[CAMP:stream] groq:${modelId}:`, e.message?.slice(0, 50)); }
    }
  }
}

/* ── PROVIDER RACE — haiku-tier: fire Ollama + Groq simultaneously ── */
async function callRace(feature, messages, numCtx) {
  const haikuCall = callOllama(LOCAL_MODELS['cs-haiku'], messages, feature.maxTokens, feature.task, numCtx)
    .then(content => {
      const leak = _DL(content);
      if (leak.leaked) throw new Error('haiku leaked');
      return { content, model: 'cs-haiku' };
    });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return haikuCall;

  // Race with the fastest available Groq model (respects 429 cooldowns)
  const fastModel = _groqPool().find(m => m.includes('instant')) || _groqPool()[0];
  if (!fastModel) return haikuCall;

  const groqCall = axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model:       fastModel,
    messages,
    max_tokens:  feature.maxTokens,
    temperature: 0.7,
  }, {
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    timeout: 15_000,
    httpsAgent,
  }).then(resp => {
    const text = resp.data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq race: empty response');
    return { content: _CBP(text), model: `groq-race:${fastModel}`, usedFallback: true };
  }).catch(e => {
    if (e.response?.status === 429) { _groqMark429(fastModel, e.response?.data?.error?.message || ''); }
    throw e;
  });

  return Promise.any([haikuCall, groqCall]).catch(() => {
    throw new Error('callRace: both providers failed');
  });
}

/* ── STREAMING LOCAL CALL ────────────────────────────────────────── */
async function* streamLocal(ollamaModel, messages, maxTokens, task, isHaiku, numCtx) {
  const guard = isHaiku ? new _SLG(120) : null;

  await gpuResidency.ensureResident(ollamaModel);
  const numGpu = await calculateOptimalGpuLayers(ollamaModel, numCtx || 8192);
  const resp = await axios.post(`${OLLAMA_URL}/v1/chat/completions`, {
    model: ollamaModel, messages, max_tokens: maxTokens,
    temperature: task === 'classify' ? 0.1 : 0.7,
    stream: true, options: { num_gpu: numGpu, num_batch: 512, num_ctx: numCtx || 32768 },
  }, { responseType: 'stream', timeout: TIMEOUT });

  let buf = '';
  for await (const chunk of resp.data) {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.replace(/^data: /, '').trim();
      if (!t || t === '[DONE]') continue;
      try {
        const token = JSON.parse(t).choices?.[0]?.delta?.content || '';
        if (!token) continue;
        if (guard) {
          const r = guard.feed(token);
          if (r.action === 'abort') { yield { type: 'leak_abort' }; return; }
          if (r.action === 'flush_and_emit' || r.action === 'emit') yield { type: 'token', content: r.token };
        } else {
          yield { type: 'token', content: token };
        }
      } catch (_) {}
    }
  }
  if (guard) {
    const end = guard.end();
    if (end.action === 'flush') yield { type: 'token', content: end.token };
    else if (end.action === 'aborted') yield { type: 'leak_abort' };
  }
  yield { type: 'done' };
}

/* ── SIMPLE INFER FN (for memory compression) ────────────────────── */
async function localInfer({ userInput, task, maxTokens }) {
  const sysPrompt = TASK_PROMPTS[task] || TASK_PROMPTS.career_advice;
  const messages  = [
    { role: 'system', content: sysPrompt },
    { role: 'user',   content: userInput },
  ];
  try {
    const text = await callOllama(LOCAL_MODELS['cs-haiku'], messages, maxTokens || 150, task);
    return { content: text };
  } catch {
    try {
      const text = await callOllama(LOCAL_MODELS['cs-sonnet'], messages, maxTokens || 300, task);
      return { content: text };
    } catch {
      return { content: '' };
    }
  }
}

/* ── GET /v1/camp/:featureId — feature info ──────────────────────── */
router.get('/:featureId', apiKeyGuard, (req, res) => {
  const feature = getFeature(req.params.featureId);
  res.json({ featureId: req.params.featureId, ...feature, knownFeature: !!FEATURE_MAP[req.params.featureId] });
});

/* ── POST /v1/camp/:featureId — full pipeline inference ─────────── */
router.post('/:featureId', apiKeyGuard, async (req, res) => {
  const t0          = Date.now();
  const { featureId } = req.params;
  const {
    userInput  = '',
    messages   = [],
    userId     = null,
    language   = 'en',
    stream:    wantsStream = false,
  } = req.body;

  const feature    = getFeature(featureId);
  const tierCfg    = getFeatureTier(featureId);
  console.log('[ROUTE]', routeSummary(featureId));
  const inputText  = userInput || messages.filter(m => m.role === 'user').at(-1)?.content || '';

  /* STEP 1 — Ethics check */
  const ethics = _GUARD.checkInput(inputText, featureId);
  if (ethics.redirects.length) {
    return res.json({ content: ethics.redirects[0].message, isRedirect: true, featureId });
  }
  if (!ethics.passed) {
    return res.status(422).json({ error: ethics.blocked[0]?.message, rule: ethics.blocked[0]?.rule });
  }
  const warnMessage = ethics.warnings[0]?.message;

  /* STEP 2 — Ambiguity detection */
  const amb = _DA(inputText);
  if (amb.isAmbiguous && amb.clarification) {
    return res.json({ content: amb.clarification, needsClarification: true, featureId });
  }

  /* STEP 2.5 — Scoring Proxy (3-layer hybrid: rules + AI + merge) */
  if (PROXY_SCORED_FEATURES[featureId]) {
    const proxyTool    = PROXY_SCORED_FEATURES[featureId];
    const proxyContext = {
      targetRole:  req.body?.targetRole  || req.body?.target_role,
      companyName: req.body?.companyName || req.body?.company_name,
      jobTitle:    req.body?.jobTitle    || req.body?.job_title,
    };
    try {
      const proxyResult = await scoreWithProxy(proxyTool, inputText, proxyContext);
      const formatted   = formatProxyResult(proxyResult, featureId);
      perfMonitor.recordLatency(Date.now() - t0, false);
      return res.json({
        success:      true,
        content:      formatted.content,
        model:        formatted.model,
        featureId,
        task:         feature.task,
        maxTokens:    feature.maxTokens,
        piiProtected: false,
        usedFallback: false,
        score:        formatted.score,
        warning:      warnMessage,
      });
    } catch (proxyErr) {
      console.error(`[SCORING-PROXY] ${featureId} error:`, proxyErr.message);
      // Fall through to standard pipeline on proxy failure
    }
  }

  /* STEP 3 — PII scrub */
  let cleanInput = inputText;
  let piiMap     = {};
  if (feature.piiScrub && inputText) {
    const scrubbed = pii.scrub(inputText, userId);
    cleanInput = scrubbed.clean;
    piiMap     = scrubbed.map;
  }

  /* STEP 4 — System prompt + memory */
  const isSalary    = feature.task === 'salary_analysis';
  const isHaikuTier = feature.model === 'cs-haiku';

  /* STEP 3.5 — Semantic cache (skip model entirely on hit) */
  if (!wantsStream && !isSalary) {
    const cached = responseCache.get(featureId, inputText, { country: req.body?.country, currentRole: req.body?.role, language });
    if (cached) {
      perfMonitor.recordLatency(Date.now() - t0, true);
      return res.json({ success: true, content: cached, model: 'cache', featureId, task: feature.task, maxTokens: feature.maxTokens, piiProtected: false, usedFallback: false, warning: warnMessage });
    }
  }

  /* Auto-detect input language so the model matches it even when language param is 'en' */
  const inputSample = inputText.slice(0, 120);
  const langHint = language !== 'en'
    ? `LANGUAGE: Respond entirely in ${language}.`
    : `LANGUAGE: Detect and match the language of this user message: "${inputSample}"`;

  /* STEP 4.5 — Live data grounding (Bucket A features only — additive, no-op
     for the other ~260 features that aren't in FEATURE_DATA_REQUIREMENTS) */
  let groundingBlock = '';
  if (!isSalary) {
    const liveData = await gatherLiveData(featureId, {
      role:     req.body?.role     || req.body?.target_role,
      country:  req.body?.country  || req.body?.target_country,
      currency: req.body?.currency,
    }).catch(() => null);
    groundingBlock = buildGroundingBlock(liveData);
  }

  /* Compact system prompt for haiku-tier — ~70% fewer prefill tokens */
  const sysPrompt = isHaikuTier
    ? `You are CareerLM by Career Studio. ${langHint} Give direct, specific, actionable career advice.`
    : [
        FEATURE_PROMPTS[featureId] || TASK_PROMPTS[feature.task] || TASK_PROMPTS.career_advice,
        groundingBlock,
        langHint,
      ].filter(Boolean).join('\n\n');

  /* STEP 5 — Reasoning injection */
  let finalInput = cleanInput;
  if (!isSalary && feature.model === 'cs-sonnet' && _RR(feature.task)) {
    finalInput = _BRP(feature.task, cleanInput);
  }

  /* Build final messages array.
     Salary features bypass memory entirely — injecting the user's career
     history (profile, previous chats, tech skills) into a salary prompt
     causes the model to price the wrong person. The SIPS pipeline already
     has full structured context via buildSalaryUserPrompt. */
  const builtMessages = (userId && !isSalary)
    ? memory.buildMessages(userId, sysPrompt, finalInput)
    : [
        { role: 'system', content: sysPrompt },
        ...messages.filter(m => m.role !== 'system').slice(-6),
        ...(finalInput ? [{ role: 'user', content: finalInput }] : []),
      ];

  /* STEP 6 — STREAMING PATH */
  if (wantsStream && feature.streaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (warnMessage) res.write(`data: ${JSON.stringify({ type: 'warning', message: warnMessage })}\n\n`);

    /* Instant shell — user sees output in <50ms before the model starts */
    res.write(`data: ${JSON.stringify({ type: 'token', content: getInstantShell(featureId) })}\n\n`);

    const ollamaModel = LOCAL_MODELS[feature.model] || feature.model;
    const isHaiku     = feature.model === 'cs-haiku';

    try {
      for await (const event of streamLocal(ollamaModel, builtMessages, feature.maxTokens, feature.task, isHaiku, tierCfg.numCtx)) {
        if (event.type === 'leak_abort') {
          // Retry stream with sonnet
          res.write(`data: ${JSON.stringify({ type: 'model_switch', to: 'cs-sonnet' })}\n\n`);
          for await (const e2 of streamLocal(LOCAL_MODELS['cs-sonnet'], builtMessages, Math.max(feature.maxTokens, 800), feature.task, false, tierCfg.numCtx)) {
            res.write(`data: ${JSON.stringify(e2)}\n\n`);
            if (e2.type === 'done' || e2.type === 'error') break;
          }
          break;
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) {
      // External streaming fallback — try Groq SSE first (real token stream),
      // then fall back to a blocking externalFallback call if Groq is also down.
      res.write(`data: ${JSON.stringify({ type: 'fallback', provider: 'external' })}\n\n`);
      let streamedAny = false;
      for await (const ev of streamExternal(builtMessages, feature.maxTokens)) {
        streamedAny = true;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.type === 'done') break;
      }
      if (!streamedAny) {
        // All Groq models rate-limited — blocking fallback (Anthropic / OpenRouter / Gemini)
        const fallback = await externalFallback(feature, builtMessages);
        res.write(`data: ${JSON.stringify({ type: 'token', content: fallback.content })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', model: fallback.model })}\n\n`);
      }
    }

    // Async memory save after stream ends
    if (userId && inputText) {
      setImmediate(() => {
        memory.addMessage(userId, 'user', cleanInput, localInfer).catch(() => {});
      });
    }
    return res.end();
  }

  /* STEP 6 — BLOCKING PATH */
  let result;
  if (isSalary) {
    /* Salary features use the full 3-layer SIPS pipeline */
    const callModel = (msgs, overrides) => {
      const salaryFeature = { ...feature, ...SALARY_CALL_OVERRIDES, ...overrides };
      return callWithRetry(salaryFeature, msgs)
        .catch(() => externalFallback(salaryFeature, msgs));
    };
    const careerContext = {
      role:          req.body?.role         || req.body?.target_role,
      country:       req.body?.country      || req.body?.target_country,
      city:          req.body?.city,
      years:         req.body?.years_exp    || req.body?.years,
      skills:        req.body?.skills,
      currentSalary: req.body?.current_salary,
      sector:        req.body?.sector       || req.body?.industry,
      employerType:  req.body?.employer_type,
    };
    result = await runSalaryBenchmark(cleanInput, careerContext, callModel);
  } else {
    try {
      result = isHaikuTier
        ? await callRace(feature, builtMessages, tierCfg.numCtx)
        : await callWithRetry(feature, builtMessages, tierCfg.numCtx);
    } catch {
      result = await externalFallback(feature, builtMessages);
    }
  }

  /* STEP 7 — Output ethics */
  const outCheck = _GUARD.checkOutput(result.content, feature.task);
  if (!outCheck.passed) {
    result.content = 'This content could not be returned due to ethical guidelines. Please rephrase your request.';
  } else {
    result.content = outCheck.output;
  }

  /* STEP 8 — PII restore */
  if (feature.piiScrub && Object.keys(piiMap).length) {
    result.content = pii.restore(result.content, piiMap);
  }

  /* Cache the final response (non-personalised features only) */
  if (!isSalary) {
    responseCache.set(featureId, inputText, { country: req.body?.country, currentRole: req.body?.role, language }, result.content);
  }
  perfMonitor.recordLatency(Date.now() - t0, false);

  /* Save to memory async */
  if (userId) {
    setImmediate(async () => {
      await memory.addMessage(userId, 'user',      cleanInput,      localInfer).catch(() => {});
      await memory.addMessage(userId, 'assistant', result.content,  localInfer).catch(() => {});
    });
  }

  res.json({
    success:      true,
    content:      result.content,
    model:        result.model,
    featureId,
    task:         feature.task,
    maxTokens:    feature.maxTokens,
    piiProtected: Object.keys(piiMap).length > 0,
    retriedFrom:  result.retriedFrom,
    usedFallback: result.usedFallback || false,
    warning:      warnMessage,
    ...(isSalary && result.salary ? { salary: result.salary } : {}),
  });
});

/* ── GET /v1/camp — list all 274 features ────────────────────────── */
router.get('/', apiKeyGuard, (req, res) => {
  const features = Object.entries(FEATURE_MAP).map(([id, cfg]) => ({
    id, model: cfg.model, task: cfg.task, maxTokens: cfg.maxTokens,
    streaming: cfg.streaming, piiScrub: cfg.piiScrub,
  }));
  res.json({ success: true, count: features.length, features });
});

module.exports = router;
