'use strict';
/**
 * INFERENCE ENGINE — The complete local-first AI pipeline.
 *
 * Every request flows through 12 steps:
 *   1. PII strip          — protect user data before model sees it
 *   2. Memory load        — inject persistent career context
 *   3. Model selection    — task → optimal local model
 *   4. Dynamic prompt     — feature-specific assembled system prompt
 *   5. Reasoning chain    — inject HRC for structured thinking
 *   6. Message build      — compose final messages array
 *   7. Local inference    — call Ollama (cs-sonnet → cs-haiku → careerlm-nano)
 *   8. Leak check         — detectLeak → auto-retry with cs-sonnet
 *   9. External fallback  — Groq → OpenRouter ONLY if all local fail
 *  10. Guardrail pipeline — 6-layer quality + safety gate
 *  11. Memory save        — async extract + persist career facts
 *  12. Metrics            — record latency, tokens, quality
 */
const axios = require('axios');

const { PIIShield }              = require('./piiShield');
const { HumanReasoningChain }    = require('./humanReasoningChain');
const { MemoryInSaver }          = require('./memoryInSaver');
const { DynamicPromptAssembler } = require('./dynamicPromptAssembler');
const { GuardrailPipeline }      = require('./guardrailPipeline');
const { detectLeak, StreamingLeakGuard, cleanBannedPhrases } = require('./haikuGuard');
const { MetricsCollector }       = require('../monitoring/metrics');
const { buildOfflineResponse }   = require('../core/offlineResponder');

// ── GPU Resource Manager (Innovation layer — additive) ───────────
const { calculateOptimalGpuLayers } = require('../core/gpuLayerCalculator');
const gpuResidency                  = require('../core/gpuResidency');
const gpuScheduler                  = require('../core/gpuScheduler');

const pii       = new PIIShield();
const hrc       = new HumanReasoningChain();
const memory    = new MemoryInSaver();
const assembler = new DynamicPromptAssembler();
const guardrail = new GuardrailPipeline();
const metrics   = new MetricsCollector();

const OLLAMA = process.env.CS_INFERENCE_URL || 'http://localhost:11434';
const OLLAMA_TIMEOUT = 45000;

/* ── MODEL REGISTRY ────────────────────────────────────────────── */
const MODELS = {
  'cs-sonnet':     { ollamaName: 'cs-sonnet',     maxTokens: 4096, contextWindow: 32768, tier: 'quality' },
  'cs-haiku':      { ollamaName: 'cs-haiku',      maxTokens: 1024, contextWindow: 16384, tier: 'fast'    },
  'careerlm-nano': { ollamaName: 'cs-haiku',      maxTokens: 512,  contextWindow: 8192,  tier: 'nano'    },
};

/* ── TASK → MODEL MAP ──────────────────────────────────────────── */
const TASK_MODELS = {
  summarise:          'cs-haiku',
  classify:           'cs-haiku',
  quick_reply:        'cs-haiku',
  sentiment:          'cs-haiku',
  keyword_extract:    'cs-haiku',
  greeting:           'cs-haiku',
  title_generate:     'cs-haiku',
  format_check:       'cs-haiku',
  compress_history:   'careerlm-nano',
  extract_facts:      'careerlm-nano',
  tag_suggest:        'careerlm-nano',
  career_advice:      'cs-sonnet',
  cv_bullet:          'cs-sonnet',
  cover_letter:       'cs-sonnet',
  interview_prep:     'cs-sonnet',
  salary_analysis:    'cs-sonnet',
  json_extract:       'cs-sonnet',
  skill_gap:          'cs-sonnet',
  job_match:          'cs-sonnet',
  tool_analysis:      'cs-sonnet',
  linkedin_optimise:  'cs-sonnet',
  lifepath_sim:       'cs-sonnet',
  reasoning:          'cs-sonnet',
  achievement_format: 'cs-sonnet',
  negotiation:        'cs-sonnet',
  translation:        'cs-sonnet',
};

/* ── MAIN INFER ─────────────────────────────────────────────────── */
async function infer({
  featureId    = null,
  task         = 'career_advice',
  messages     = [],
  userInput    = '',
  userId       = null,
  language     = 'en',
  toolName     = null,
  maxTokens    = null,
  forceModel   = null,
  schema       = null,
  keepSalary   = false,
  keepLinkedIn = false,
  _skipMemory  = false,
} = {}) {
  const startTime = Date.now();
  const requestId = `ie_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  /* STEP 1: PII STRIP */
  const { clean: cleanInput, vault }        = pii.strip(userInput || '', { keepSalary, keepLinkedIn });
  const { messages: cleanMessages, vault: msgVault } = pii.stripThread(messages, { keepSalary, keepLinkedIn });
  const combinedVault = { ...vault, ...msgVault };

  /* STEP 2: MEMORY LOAD */
  const userMemory    = (userId && !_skipMemory) ? await memory.get(userId).catch(() => null) : null;
  const memoryContext = userMemory ? memory.toContextBlock(userMemory) : '';

  /* STEP 3: MODEL SELECTION */
  const modelKey  = forceModel || TASK_MODELS[task] || 'cs-sonnet';
  const modelCfg  = MODELS[modelKey] || MODELS['cs-sonnet'];
  const tokenLimit = maxTokens || modelCfg.maxTokens;

  /* STEP 4: DYNAMIC SYSTEM PROMPT */
  let systemPrompt = assembler.assemble({ featureId, taskType: task, language, memoryContext, toolName });

  /* STEP 5: INJECT REASONING CHAIN */
  if (modelKey === 'cs-sonnet') {
    systemPrompt = hrc.inject(systemPrompt, task);
  } else {
    systemPrompt = hrc.injectShort(systemPrompt, task);
  }

  /* STEP 6: BUILD MESSAGES */
  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...cleanMessages.filter(m => m.role !== 'system').slice(-6),
    ...(cleanInput ? [{ role: 'user', content: cleanInput }] : []),
  ];

  /* STEP 7 + 8: LOCAL INFERENCE + LEAK CHECK */
  let result;
  try {
    result = await _callWithLeakRetry(modelKey, modelCfg, fullMessages, tokenLimit, task);
  } catch (localErr) {
    console.error(`[InferenceEngine] All local models failed: ${localErr.message}`);
    /* STEP 9: EXTERNAL FALLBACK */
    result = await _externalFallback(task, fullMessages, tokenLimit);
    result.usedFallback = true;
  }

  /* STEP 10: GUARDRAIL PIPELINE */
  const guarded = guardrail.process(result.content, {
    vault:      combinedVault,
    keepSalary,
    expectLong: tokenLimit > 500,
  });

  /* STEP 11: SAVE MEMORY ASYNC */
  if (userId && guarded.passed && !_skipMemory) {
    setImmediate(async () => {
      try {
        await memory.extractAndSave(
          userId,
          [...messages, { role: 'user', content: userInput }, { role: 'assistant', content: guarded.content }],
          (args) => infer({ ...args, userId: null, _skipMemory: true })
        );
      } catch (_) {}
    });
  }

  /* STEP 12: METRICS */
  metrics.record({
    model:     result.model || modelKey,
    task,
    featureId,
    latencyMs: Date.now() - startTime,
    tokens:    result.usage?.completion_tokens || Math.round((result.content || '').length / 4),
    quality:   guarded.qualityScore,
    fallback:  !!result.usedFallback,
  });

  return {
    content:         guarded.content,
    model:           result.model || modelKey,
    featureId,
    task,
    qualityScore:    guarded.qualityScore,
    guardrailIssues: guarded.issues,
    latencyMs:       Date.now() - startTime,
    requestId,
    usage:           result.usage,
    piiProtected:    Object.keys(combinedVault).length > 0,
    memoryUsed:      !!userMemory,
    retriedWith:     result.retriedWith,
    usedFallback:    result.usedFallback || false,
  };
}

/* ── LOCAL INFERENCE WITH LEAK RETRY ───────────────────────────── */
async function _callWithLeakRetry(modelKey, modelCfg, messages, tokenLimit, task) {
  // Try the selected model first
  const tryModels = [modelKey];
  // If not sonnet already, add sonnet as automatic retry target
  if (modelKey !== 'cs-sonnet') tryModels.push('cs-sonnet');
  // Final safety net: if sonnet also fails, try haiku
  if (!tryModels.includes('cs-haiku')) tryModels.push('cs-haiku');

  let lastErr;
  for (const key of tryModels) {
    const cfg = MODELS[key] || MODELS['cs-sonnet'];
    try {
      const result = await _callOllama({
        model:     cfg.ollamaName,
        messages,
        maxTokens: key === modelKey ? tokenLimit : Math.max(tokenLimit, 800),
        task,
        numCtx:    cfg.contextWindow,
      });

      // Haiku/nano leak guard
      if (key === 'cs-haiku' || key === 'careerlm-nano') {
        const leak = detectLeak(result.content);
        if (leak.leaked) {
          console.warn(`[InferenceEngine] ${key} leaked (${leak.reason}) → trying cs-sonnet`);
          lastErr = new Error(`${key}_leak`);
          continue;
        }
      }

      result.model = key;
      if (key !== modelKey) result.retriedWith = key;
      return result;
    } catch (e) {
      console.warn(`[InferenceEngine] ${key} failed:`, e.message?.slice(0, 80));
      lastErr = e;
    }
  }
  throw lastErr || new Error('all_local_models_failed');
}

/* ── OLLAMA BLOCKING CALL ───────────────────────────────────────── */
async function _callOllama({ model, messages, maxTokens, task, numCtx }) {
  // GPU Resource Manager: ensure correct model is resident, then acquire a
  // concurrency slot for this tier before issuing the Ollama request.
  const tierName = model.replace('cs-', '').replace('careerlm-', '')

  await gpuResidency.ensureResident(model)
  const numGpu = await calculateOptimalGpuLayers(model, numCtx || 8192)

  return gpuScheduler.withGpuSlot(tierName, async () => {
    const resp = await axios.post(`${OLLAMA}/v1/chat/completions`, {
      model,
      messages,
      max_tokens:  maxTokens,
      temperature: task === 'json_extract' || task === 'classify' ? 0.1 : 0.7,
      stream:      false,
      options:     { num_gpu: numGpu, num_batch: 512, num_ctx: numCtx || 32768 },
    }, { timeout: OLLAMA_TIMEOUT });

    if (!resp.data?.choices?.[0]) throw new Error(`Ollama empty response for ${model}`);
    const content = resp.data.choices[0].message?.content || '';
    return { content: cleanBannedPhrases(content), usage: resp.data.usage };
  });
}

/* ── STREAMING INFERENCE ────────────────────────────────────────── */
async function* stream({
  featureId    = null,
  task         = 'career_advice',
  messages     = [],
  userInput    = '',
  userId       = null,
  language     = 'en',
  toolName     = null,
  maxTokens    = null,
  forceModel   = null,
  keepSalary   = false,
  keepLinkedIn = false,
} = {}) {
  const startTime = Date.now();

  const { clean: cleanInput, vault }        = pii.strip(userInput || '', { keepSalary, keepLinkedIn });
  const { messages: cleanMessages, vault: msgVault } = pii.stripThread(messages, { keepSalary, keepLinkedIn });
  const combinedVault = { ...vault, ...msgVault };

  const userMemory    = userId ? await memory.get(userId).catch(() => null) : null;
  const memoryContext = userMemory ? memory.toContextBlock(userMemory) : '';

  const modelKey  = forceModel || TASK_MODELS[task] || 'cs-sonnet';
  const modelCfg  = MODELS[modelKey] || MODELS['cs-sonnet'];
  const tokenLimit = maxTokens || modelCfg.maxTokens;

  let systemPrompt = assembler.assemble({ featureId, taskType: task, language, memoryContext, toolName });
  if (modelKey === 'cs-sonnet') systemPrompt = hrc.inject(systemPrompt, task);
  else systemPrompt = hrc.injectShort(systemPrompt, task);

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...cleanMessages.filter(m => m.role !== 'system').slice(-6),
    ...(cleanInput ? [{ role: 'user', content: cleanInput }] : []),
  ];

  yield* _streamWithFallback({ modelKey, modelCfg, fullMessages, tokenLimit, task, combinedVault, keepSalary, startTime });
}

async function* _streamWithFallback({ modelKey, modelCfg, fullMessages, tokenLimit, task, combinedVault, keepSalary, startTime, _retried = false }) {
  const guard = (modelKey === 'cs-haiku' || modelKey === 'careerlm-nano')
    ? new StreamingLeakGuard(120)
    : null;

  let aborted    = false;
  let fullContent = '';

  // GPU Resource Manager: acquire residency + calculate exact layers + concurrency slot.
  // acquireSlot/releaseSlot used (not withGpuSlot) because yield can't appear inside
  // a regular async function wrapper.
  const _streamTier = modelKey.replace('cs-', '').replace('careerlm-', '')
  await gpuResidency.ensureResident(modelCfg.ollamaName)
  const _numGpu = await calculateOptimalGpuLayers(modelCfg.ollamaName, modelCfg.contextWindow || 8192)
  await gpuScheduler.acquireSlot(_streamTier)

  try {
    const resp = await axios.post(`${OLLAMA}/v1/chat/completions`, {
      model:      modelCfg.ollamaName,
      messages:   fullMessages,
      max_tokens: tokenLimit,
      stream:     true,
      options:    { num_gpu: _numGpu, num_batch: 512, num_ctx: modelCfg.contextWindow || 32768 },
    }, { responseType: 'stream', timeout: OLLAMA_TIMEOUT });

    let buf = '';
    for await (const chunk of resp.data) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.replace(/^data: /, '').trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        try {
          const data  = JSON.parse(trimmed);
          const token = data.choices?.[0]?.delta?.content || '';
          if (!token) continue;

          fullContent += token;

          if (guard) {
            const r = guard.feed(token);
            if (r.action === 'abort') {
              aborted = true;
              yield { type: 'model_switch', from: modelKey, to: 'cs-sonnet' };
              // Retry with cs-sonnet
              yield* _streamWithFallback({
                modelKey: 'cs-sonnet', modelCfg: MODELS['cs-sonnet'],
                fullMessages, tokenLimit: Math.max(tokenLimit, 800),
                task, combinedVault, keepSalary, startTime, _retried: true,
              });
              return;
            }
            if (r.action === 'flush_and_emit' || r.action === 'emit') yield { type: 'token', content: r.token };
          } else {
            yield { type: 'token', content: token };
          }
        } catch (_) {}
      }
    }

    // Drain guard buffer at stream end
    if (guard && !aborted) {
      const end = guard.end();
      if (end.action === 'flush') yield { type: 'token', content: end.token };
      else if (end.action === 'aborted' && !_retried) {
        yield* _streamWithFallback({
          modelKey: 'cs-sonnet', modelCfg: MODELS['cs-sonnet'],
          fullMessages, tokenLimit: Math.max(tokenLimit, 800),
          task, combinedVault, keepSalary, startTime, _retried: true,
        });
        return;
      }
    }

    yield { type: 'done', model: modelKey, latencyMs: Date.now() - startTime };

  } catch (err) {
    console.error(`[InferenceEngine:stream] ${modelKey} failed:`, err.message?.slice(0, 80));
    if (!_retried) {
      // External streaming fallback
      yield { type: 'model_switch', from: modelKey, to: 'groq' };
      yield* _externalFallbackStream(task, fullMessages, tokenLimit);
    } else {
      // All providers exhausted — yield offline response, never a dead-end error
      const offline = buildOfflineResponse(task, fullMessages.at(-1)?.content || '');
      yield { type: 'token', content: offline };
      yield { type: 'done', model: 'degraded' };
    }
  } finally {
    gpuScheduler.releaseSlot(_streamTier)
  }
}

/* ── GROQ POOL + CIRCUIT BREAKER (shared by blocking + streaming paths) ── */
const _IE_GROQ_POOL = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
];
const _ieGroqRL   = new Map(); // modelId → { ts, cd }
const _IE_RL_SHORT = 65_000;

function _ieGroqAvail(id) {
  const r = _ieGroqRL.get(id);
  if (!r) return true;
  if (Date.now() - r.ts > r.cd) { _ieGroqRL.delete(id); return true; }
  return false;
}
function _ieGroqMark429(id, msg = '') {
  _ieGroqRL.set(id, { ts: Date.now(), cd: /per.day|tokens per day/i.test(msg) ? 86_400_000 : _IE_RL_SHORT });
}
function _ieGroqPool() { return _IE_GROQ_POOL.filter(_ieGroqAvail); }

// Circuit breaker — opens after 4 consecutive total failures (90s cooldown)
const _ieCB = { failures: 0, openUntil: 0, THRESHOLD: 4, COOLDOWN_MS: 90_000 };

/* ── EXTERNAL FALLBACK (blocking) ───────────────────────────────── */
// Priority: internal Ollama (caller) → Groq pool → Anthropic → OpenRouter → offline
async function _externalFallback(task, messages, maxTokens) {
  const inputText = messages.at(-1)?.content || '';

  if (_ieCB.openUntil > Date.now()) {
    return { content: buildOfflineResponse(task, inputText), model: 'degraded' };
  }

  const _ok = (content, model, usage) => {
    _ieCB.failures = 0;
    return { content: cleanBannedPhrases(content), model, usage };
  };

  // ── 1. Groq — model pool with per-model 429 cooldown ──
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    for (const modelId of _ieGroqPool()) {
      try {
        const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: modelId, messages, max_tokens: maxTokens, temperature: 0.7,
        }, {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
          timeout: 30_000,
        });
        const content = resp.data?.choices?.[0]?.message?.content || '';
        if (content) { console.log(`[InferenceEngine] groq:${modelId} fallback`); return _ok(content, `groq:${modelId}`, resp.data?.usage); }
      } catch (e) {
        if (e.response?.status === 429) { _ieGroqMark429(modelId, e.response?.data?.error?.message || ''); }
        else { console.warn(`[InferenceEngine] groq:${modelId}:`, e.message?.slice(0, 60)); }
      }
    }
  }

  // ── 2. Anthropic — complexity-aware model selection ──
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && !anthropicKey.includes('your-')) {
    const anthropicModel = maxTokens > 1500
      ? (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6')
      : 'claude-haiku-4-5-20251001';
    try {
      const sysMsg   = messages.find(m => m.role === 'system')?.content || '';
      const userMsgs = messages.filter(m => m.role !== 'system');
      const resp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: anthropicModel, max_tokens: maxTokens, system: sysMsg,
        messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
      }, {
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 35_000,
      });
      const content = resp.data?.content?.[0]?.text || '';
      if (content) { console.log(`[InferenceEngine] anthropic:${anthropicModel} fallback`); return _ok(content, `anthropic:${anthropicModel}`); }
    } catch (e) { console.warn('[InferenceEngine] anthropic:', e.message?.slice(0, 60)); }
  }

  // ── 3. OpenRouter ──
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    try {
      const orModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-70b-instruct';
      const resp = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: orModel, messages, max_tokens: maxTokens, temperature: 0.7,
      }, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}`,
                   'HTTP-Referer': 'https://careerstudiomax.com', 'X-Title': 'Career Studio' },
        timeout: 30_000,
      });
      const content = resp.data?.choices?.[0]?.message?.content || '';
      if (content) { console.log('[InferenceEngine] openrouter fallback'); return _ok(content, 'openrouter', resp.data?.usage); }
    } catch (e) { console.warn('[InferenceEngine] openrouter:', e.message?.slice(0, 60)); }
  }

  // All providers exhausted
  _ieCB.failures++;
  if (_ieCB.failures >= _ieCB.THRESHOLD) {
    _ieCB.openUntil = Date.now() + _ieCB.COOLDOWN_MS;
    _ieCB.failures  = 0;
    console.warn(`[InferenceEngine] External fallback circuit open for ${_ieCB.COOLDOWN_MS / 1000}s`);
  }
  return { content: buildOfflineResponse(task, inputText), model: 'degraded' };
}

/* ── EXTERNAL FALLBACK (streaming) ─────────────────────────────── */
// Priority: internal Ollama (caller) → Groq pool SSE → offline
async function* _externalFallbackStream(task, messages, maxTokens) {
  const inputText = messages.at(-1)?.content || '';

  if (_ieCB.openUntil > Date.now()) {
    yield { type: 'token', content: buildOfflineResponse(task, inputText) };
    yield { type: 'done', model: 'degraded' };
    return;
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    for (const modelId of _ieGroqPool()) {
      try {
        const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: modelId, messages, max_tokens: maxTokens, temperature: 0.7, stream: true,
        }, {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
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
              if (token) yield { type: 'token', content: token };
            } catch (_) {}
          }
        }
        _ieCB.failures = 0;
        yield { type: 'done', model: `groq:${modelId}` };
        return; // first successful stream wins
      } catch (e) {
        if (e.response?.status === 429) { _ieGroqMark429(modelId, e.response?.data?.error?.message || ''); }
        else { console.warn(`[InferenceEngine:stream] groq:${modelId}:`, e.message?.slice(0, 60)); }
      }
    }
  }

  // Groq exhausted — blocking Anthropic/OpenRouter fallback, streamed as one token
  const fallback = await _externalFallback(task, messages, maxTokens);
  yield { type: 'token', content: fallback.content };
  yield { type: 'done', model: fallback.model };
}

/* ── EXPORTS ────────────────────────────────────────────────────── */
module.exports = { infer, stream, metrics, TASK_MODELS, MODELS };
