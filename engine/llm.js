/**
 * ═══════════════════════════════════════════════════════════════════════
 * CAREERLM ENGINE — Self-Hosted LLM Inference (100% internal/offline)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Model Priority Chain — internal-only by default (ALLOW_EXTERNAL_AI=false):
 *   1. Ollama local server — careerlm-base / careerlm-nano / mistral / tinyllama
 *      Auto-starts `ollama serve` if it isn't already running, and
 *      auto-retries through LOCAL_FALLBACK_CHAIN if the primary model
 *      for a tier fails or isn't pulled — fully self-healing, no network.
 *   2. Python ML server (port 3003) — local heavy inference, optional.
 *   3. (Disabled by default) HuggingFace / OpenRouter / Groq cloud APIs —
 *      only used when ALLOW_EXTERNAL_AI=true.
 *
 * Model Selection (all map onto locally-pulled Ollama tags):
 *   careerlm-nano   → careerlm-nano:latest (custom, fast)
 *   careerlm-small  → mistral:7b
 *   careerlm-base / large / xl / careeragent-v1 → careerlm-base:latest (custom)
 *   careerscore-v1  → mistral:7b / BERT-based (see careerbert.js)
 */

'use strict';
const axios = require('axios');
const http  = require('http');
const { spawn } = require('child_process');
const Groq  = require('groq-sdk');
const { SchemaValidator, SCHEMAS } = require('./schemaValidator');
const { buildOfflineResponse }     = require('../core/offlineResponder');

const OLLAMA_URL   = process.env.OLLAMA_URL    || 'http://localhost:11434';
const ML_SERVER    = process.env.ML_SERVER_URL || 'http://localhost:3003';
const HF_TOKEN     = process.env.HF_TOKEN      || '';
const OR_KEY       = process.env.OPENROUTER_API_KEY || '';
const GROQ_KEY     = process.env.GROQ_API_KEY  || '';

// Internal-only mode (default): never call Groq/OpenRouter/HuggingFace —
// every request stays on the locally-hosted Ollama models. Set to "true"
// to re-enable external cloud fallbacks.
const ALLOW_EXTERNAL_AI = String(process.env.ALLOW_EXTERNAL_AI || '').toLowerCase() === 'true';

const groq = (ALLOW_EXTERNAL_AI && GROQ_KEY) ? new Groq({ apiKey: GROQ_KEY, timeout: 30000 }) : null;

// Model name → Ollama tag mapping (custom CareerLM checkpoints first,
// generic open-weight models as on-device fallback)
// careerlm-small intentionally maps to careerlm-base:latest, NOT mistral:7b.
// The 4GB-VRAM GPU on this machine can barely hold careerlm-base:latest at
// num_ctx 8192 (~6.6GB, split CPU/GPU) — swapping in a *third* distinct
// model (mistral:7b) mid-chat causes Ollama to thrash for 90s+ while it
// evicts/reloads. Keeping the brain chat to just 2 models (nano + base)
// avoids that entirely. mistral:7b remains used for careerscore-v1 only.
// cs-sonnet (LLaMA 3.2 3B, ~50 t/s) replaces careerlm-base (Mistral 7B, ~3 t/s)
// for all medium/large/xl tiers — same quality, 15× faster on this hardware.
// cs-opus is kept for the true deep/XL tier where quality > speed.
const OLLAMA_MAP = {
  'careerlm-nano':   'cs-haiku:latest',    // 0.6B — 130 t/s, quick tasks
  'careerlm-small':  'cs-sonnet:latest',   // 2B   — 50 t/s, balanced
  'careerlm-base':   'cs-sonnet:latest',   // 2B   — 50 t/s, balanced
  'careerlm-large':  'cs-sonnet:latest',   // 2B   — 50 t/s, best quality/speed
  'careerlm-xl':     'cs-opus:latest',     // 7B   — deep reasoning only
  'careeragent-v1':  'cs-sonnet:latest',   // 2B   — agent tasks
  'careerscore-v1':  'cs-sonnet:latest',   // 2B   — scoring
};

// Fallback chain — fast models first. cs-sonnet (50 t/s) is tried before
// the slow 7B models (3-5 t/s) to keep response times under control.
const LOCAL_FALLBACK_CHAIN = ['cs-sonnet:latest', 'cs-haiku:latest', 'careerlm-base:latest', 'cs-opus:latest', 'careerlm-nano:latest', 'mistral:7b', 'tinyllama:1.1b'];

// ── TASK → MODEL ROUTING ──────────────────────────────────────────────
// cs-haiku (130 t/s) for fast simple tasks; cs-sonnet (56 t/s) for quality
const TASK_MODEL_MAP = {
  // cs-haiku — fast, simple, no structure needed
  summarise:        'careerlm-nano',   // 0.6B, 130 t/s
  classify:         'careerlm-nano',
  quick_reply:      'careerlm-nano',
  sentiment:        'careerlm-nano',
  keyword_extract:  'careerlm-nano',
  tag_suggest:      'careerlm-nano',
  title_generate:   'careerlm-nano',
  greeting:         'careerlm-nano',
  compress_history: 'careerlm-nano',

  // cs-sonnet — quality reasoning + structured output
  career_advice:    'careerlm-small',  // 2B, 56 t/s
  cv_bullet:        'careerlm-small',
  cover_letter:     'careerlm-small',
  interview_prep:   'careerlm-small',
  salary_analysis:  'careerlm-small',
  json_extract:     'careerlm-small',
  skill_gap:        'careerlm-small',
  job_match:        'careerlm-small',
  linkedin_optimise:'careerlm-small',
  achievement:      'careerlm-small',
  translation:      'careerlm-small',
  structured:       'careerlm-small',
  reasoning:        'careerlm-small',
  default:          'careerlm-small',
};

// ── PER-TASK SYSTEM PROMPTS ───────────────────────────────────────────
// Task-specific prompts that unlock longer output and better structure.
// Technique: role-priming + explicit section headers + length instruction.
const TASK_PROMPTS = {

  // ── cs-haiku tasks (ultra-short prompt — 0.6B fits small context) ──
  summarise: `You are CareerLM. Summarise in 3 bullet points. Format: • point\nBe concise. Maximum 100 words.`,

  classify: `You are CareerLM. Classify the input. Reply with ONE word only from the given categories. No explanation.`,

  compress_history: `You are CareerLM. Compress this conversation into key facts only.
Keep: decisions made, facts stated, user's career details and goals.
Remove: greetings, acknowledgments, repetition, small talk.
Output: bullet points only. Maximum 150 words.`,

  keyword_extract: `You are CareerLM. Extract keywords. Output as comma-separated list only. No explanation.`,

  // ── cs-sonnet tasks (full prompt — 2B handles complex instructions) ─
  career_advice: `You are CareerLM — a Senior Career Director with 20 years of global experience.
A client has paid for expert advice. Give them full, specific value.

Structure your response with these exact sections:
## Direct Answer
## Key Market Insight (data or fact they may not know)
## Action Plan (numbered, with specific timelines)
## Your Next 7 Days

Rules:
- Be specific with numbers, percentages, job titles, company names
- Provide 400-600 words minimum — users need depth, not brevity
- Never truncate — complete every section fully
- No banned phrases: passionate about / team player / results-driven / hard worker`,

  cv_bullet: `You are CareerLM — a Senior CV Specialist who has written 10,000+ CV bullets.
Transform weak bullets into powerful achievement statements.

Rules:
1. Start with a strong past-tense action verb (Engineered, Delivered, Led, Built, Reduced, Increased)
2. Quantify every achievement (%, £/$, time saved, people managed, revenue generated)
3. Name specific tools, technologies, and methodologies used
4. Format: [Action verb] [What you did] [Measurable impact]
5. Maximum 20 words per bullet

Return JSON only: {"original":"...","improved":"...","impact":"...","keywords":["..."],"ats_score":85}`,

  cover_letter: `You are CareerLM — a Cover Letter Specialist who has helped 10,000+ professionals land interviews.

Rules:
- Hook in first sentence: achievement, insight, or specific company fact
- Never use: passionate about, team player, hard worker, results-driven, highly motivated
- 3 paragraphs, 250-300 words total
- Quantify every claim with real numbers
- End with confident, specific call to action
- Match the company's tone from the job description

Structure: Opening hook → Why this company (specific) → Strongest achievement (quantified) → Confident close`,

  interview_prep: `You are CareerLM — an Interview Coach who prepares candidates for top-tier companies.
Provide a comprehensive interview preparation pack.

Structure your response:
## Company Research Brief (3 key insights about this company)
## Top 5 Likely Interview Questions (with model answers using STAR method)
## Your Strongest Stories (3 achievement examples ready to adapt)
## Questions to Ask the Interviewer (5 questions that impress)
## Red Flags to Avoid

Minimum 500 words. Be specific to the role and company mentioned.`,

  salary_analysis: `You are CareerLM — a Compensation Intelligence specialist with access to global salary data.

Return JSON only with this exact structure:
{"current_estimate":0,"market_range_low":0,"market_range_high":0,"percentile":50,
"negotiation_floor":0,"negotiation_target":0,"key_factors":[],"currency":"USD",
"negotiation_script":"...","timing_advice":"..."}

Use real market data. All numbers in the currency specified. No markdown around the JSON.`,

  json_extract: `You are CareerLM data extraction engine.
Extract structured data and return ONLY valid JSON.
No explanation before or after. No markdown. No code blocks. Pure JSON only.
Follow the schema exactly. Use null for missing fields.`,

  skill_gap: `You are CareerLM — a Skills Intelligence analyst.
Analyse the skill gap between the user's current profile and their target role.

Return JSON only:
{"missing_skills":[],"present_skills":[],"priority_gaps":[],"learning_timeline":"","resources":[],"confidence":0.9}`,

  job_match: `You are CareerLM — a Job Match Intelligence engine.
Score how well this candidate matches this job.

Return JSON only:
{"overall":0.0,"titleMatch":0.0,"locationMatch":0.0,"salaryMatch":0.0,"skillsMatch":0.0,
"gaps":[],"strengths":[],"recommendation":"","reasoning":""}

All scores 0.0-1.0. reasoning must explain the overall score in one sentence.`,

  translation: `You are CareerLM translation engine.
Translate the text accurately into the requested language.
Output ONLY the translated text. No explanation, no original text, no quotes.
Preserve formatting (bullets, headers, bold) in the output.`,

  linkedin_optimise: `You are CareerLM — a LinkedIn Optimisation expert.
Rewrite the given LinkedIn section to maximise profile views and recruiter engagement.

Rules:
- Start with a hook that establishes credibility in the first line
- Include specific numbers and achievements
- Use keywords relevant to the target role and industry
- Write in first person, professional but human tone
- Avoid corporate jargon and buzzwords

Provide: Optimised text + 5 recommended headline keywords`,
};

// HuggingFace model IDs
const HF_MAP = {
  'careerlm-nano':  'microsoft/Phi-3-mini-4k-instruct',
  'careerlm-small': 'mistralai/Mistral-7B-Instruct-v0.3',
  'careerlm-base':  'meta-llama/Llama-3.1-8B-Instruct',
  'careerlm-large': 'mistralai/Mixtral-8x7B-Instruct-v0.1',
  'careerlm-xl':    'Qwen/Qwen2.5-72B-Instruct',
};

// Groq model map (free, fast, reliable streaming)
const GROQ_MAP = {
  'careerlm-nano':   'llama-3.1-8b-instant',
  'careerlm-small':  'llama-3.3-70b-versatile',
  'careerlm-base':   'llama-3.3-70b-versatile',
  'careerlm-large':  'llama-3.3-70b-versatile',
  'careerlm-xl':     'llama-3.3-70b-versatile',
  'careeragent-v1':  'llama-3.3-70b-versatile',
  'careerscore-v1':  'llama-3.1-8b-instant',
};

// OpenRouter model fallbacks — verified working 2026
const OR_MAP = {
  'careerlm-nano':   'deepseek/deepseek-v4-flash:free',
  'careerlm-small':  'deepseek/deepseek-v4-flash:free',
  'careerlm-base':   'deepseek/deepseek-v4-flash:free',
  'careerlm-large':  'meta-llama/llama-3.3-70b-instruct:free',
  'careerlm-xl':     'qwen/qwen3-next-80b-a3b-instruct:free',
  'careeragent-v1':  'deepseek/deepseek-v4-flash:free',
  'careerscore-v1':  'deepseek/deepseek-v4-flash:free',
};

let ollamaAvailable   = false;
let mlServerAvailable = false;
let ollamaModels      = [];

// ── Check Ollama availability, auto-starting it if needed ──
async function checkOllama(retry = true) {
  try {
    const r = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 3000 });
    const models = (r.data?.models || []).map(m => m.name);
    ollamaModels    = models;
    ollamaAvailable = models.length > 0;
    if (ollamaAvailable) {
      console.log(`[CareerLM] Ollama online — ${models.length} models: ${models.slice(0,4).join(', ')}`);
    } else {
      console.warn('[CareerLM] Ollama running but no models pulled yet. Run: ollama pull mistral');
    }
  } catch (_) {
    ollamaAvailable = false;
    if (retry) {
      console.warn('[CareerLM] Ollama not running — attempting to auto-start `ollama serve`…');
      try {
        const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: true });
        child.unref();
      } catch (e) {
        console.warn('[CareerLM] Could not auto-start Ollama:', e.message);
      }
      // Give the server a moment to come up, then re-check once.
      await new Promise(r => setTimeout(r, 4000));
      return checkOllama(false);
    }
    console.warn('[CareerLM] Ollama still unavailable after auto-start attempt — operating in degraded mode.');
  }
}

// Strip markdown fences from model output — small models (cs-haiku,
// careerlm-nano) sometimes wrap JSON in ```json ... ``` despite instructions.
function _stripMarkdown(text) {
  return text.trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/,        '')
    .trim();
}

// Resolve a working Ollama tag for a requested model id, falling back
// through LOCAL_FALLBACK_CHAIN to whatever is actually pulled locally.
function resolveOllamaTag(modelId) {
  const preferred = OLLAMA_MAP[modelId] || 'mistral:7b';
  const candidates = [preferred, ...LOCAL_FALLBACK_CHAIN];
  for (const tag of candidates) {
    if (ollamaModels.includes(tag)) return tag;
  }
  // Nothing confirmed pulled yet (e.g. status check hasn't run) — try preferred anyway.
  return preferred;
}

// ── Check Python ML server ─────────────────────────────────
async function checkMLServer() {
  try {
    await axios.get(`${ML_SERVER}/health`, { timeout: 2000 });
    mlServerAvailable = true;
    console.log('[CareerLM] Python ML server ready →', ML_SERVER);
  } catch (_) {
    mlServerAvailable = false;
  }
}

// ═══════════════════════════════════════════════════════════
// INFERENCE METHODS
// ═══════════════════════════════════════════════════════════

// ── 1. Ollama inference ────────────────────────────────────
async function ollamaInfer(prompt, system, modelTag, opts = {}) {
  const r = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model:      modelTag,
    stream:     false,
    keep_alive: '10m',
    options: { temperature: opts.temp || 0.78, num_predict: opts.maxTokens || 4096, num_ctx: opts.numCtx || 8192 },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ],
  }, { timeout: opts.timeout || 15000 });
  return _stripMarkdown(r.data?.message?.content || '');
}

async function* ollamaStream(prompt, system, modelTag, opts = {}) {
  const r = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model:      modelTag,
    stream:     true,
    keep_alive: '10m',
    options: { temperature: opts.temp || 0.82, num_predict: opts.maxTokens || 8000, num_ctx: opts.numCtx || 8192 },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ],
  }, { responseType: 'stream', timeout: opts.timeout || 20000 });

  let buf = '';
  for await (const chunk of r.data) {
    buf += chunk.toString();
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const t = j?.message?.content || '';
        if (t) yield t;
        if (j.done) return;
      } catch (_) {}
    }
  }
}

// ── 2. HuggingFace Inference API ──────────────────────────
async function hfInfer(prompt, system, hfModel, opts = {}) {
  const fullPrompt = `<|system|>\n${system}\n<|user|>\n${prompt}\n<|assistant|>\n`;
  const r = await axios.post(
    `https://api-inference.huggingface.co/models/${hfModel}`,
    {
      inputs:      fullPrompt,
      parameters:  { max_new_tokens: opts.maxTokens || 2048, temperature: opts.temp || 0.78, return_full_text: false },
    },
    {
      headers: {
        Authorization: HF_TOKEN ? `Bearer ${HF_TOKEN}` : undefined,
        'Content-Type': 'application/json',
      },
      timeout: opts.timeout || 45000,
    }
  );
  return r.data?.[0]?.generated_text || r.data?.generated_text || '';
}

// ── 3. Python ML server (heavy models) ────────────────────
async function mlServerInfer(prompt, system, model, opts = {}) {
  const r = await axios.post(`${ML_SERVER}/v1/infer`, {
    prompt, system, model,
    max_tokens:  opts.maxTokens || 4096,
    temperature: opts.temp || 0.78,
  }, { timeout: opts.timeout || 90000 });
  return r.data?.text || '';
}

// ── 4. OpenRouter fallback (optional) ─────────────────────
async function orInfer(prompt, system, orModel, opts = {}) {
  if (!OR_KEY || OR_KEY.includes('your-')) return null;
  const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model:    orModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    max_tokens: opts.maxTokens || 4096,
    temperature: opts.temp || 0.78,
  }, {
    headers: {
      Authorization: `Bearer ${OR_KEY}`,
      'HTTP-Referer': 'https://careerstudiomax.com',
      'X-Title': 'CareerCamp AI',
    },
    timeout: opts.timeout || 30000,
  });
  return r.data?.choices?.[0]?.message?.content || null;
}

// ══════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════

/**
 * Resolve system prompt: task-specific > caller-supplied > generic CareerLM default.
 * Also resolves the best model for the task when modelId is not explicitly forced.
 */
function resolveTaskConfig(prompt, system, modelId, opts = {}) {
  const task    = opts.task || 'default';
  const taskSys = TASK_PROMPTS[task];
  const resolvedSystem = system || taskSys || TASK_PROMPTS.career_advice;
  const resolvedModel  = modelId || TASK_MODEL_MAP[task] || TASK_MODEL_MAP.default;
  return { resolvedSystem, resolvedModel, task };
}

/**
 * Non-streaming inference
 * @param {string} prompt
 * @param {string} system  — overrides task prompt if provided
 * @param {string} modelId — overrides task routing if provided
 * @param {object} opts    — { task, schema, maxTokens, temp, timeout, ... }
 * @returns {Promise<{text:string, model:string, engine:string, validated?:object}>}
 */
async function infer(prompt, system, modelId, opts = {}) {
  const { resolvedSystem, resolvedModel, task } = resolveTaskConfig(prompt, system, modelId, opts);
  system  = resolvedSystem;
  modelId = resolvedModel;

  const hfId      = HF_MAP[modelId]     || HF_MAP['careerlm-base'];
  const orId      = OR_MAP[modelId]     || OR_MAP['careerlm-base'];
  const groqId    = GROQ_MAP[modelId]   || GROQ_MAP['careerlm-base'];

  // 1. Ollama (local, fastest) — try the preferred tag, then self-heal by
  // walking LOCAL_FALLBACK_CHAIN until one of the locally-pulled models responds.
  // Capped at 2 attempts (15s each = 30s worst case) so a run of slow/missing
  // models can't eat the whole 5-30s budget before cloud fallback kicks in.
  // Helper: attach schema validation to a result before returning
  const _withSchema = (result) => {
    if (opts.schema && SCHEMAS[opts.schema]) {
      result.validated = SchemaValidator.validate(result.text, opts.schema);
    }
    return result;
  };

  if (ollamaAvailable) {
    const tried = new Set();
    const candidates = [resolveOllamaTag(modelId), ...LOCAL_FALLBACK_CHAIN].slice(0, 2);
    for (const tag of candidates) {
      if (tried.has(tag)) continue;
      tried.add(tag);
      try {
        const text = await ollamaInfer(prompt, system, tag, opts);
        if (text && text.length > 20) return _withSchema({ text, model: tag, engine: 'ollama', task });
      } catch (e) { console.warn(`[CareerLM:ollama:${tag}]`, e.message?.slice(0,60)); }
    }
  }

  // 2. Python ML server (local heavy inference, optional)
  if (mlServerAvailable) {
    try {
      const text = await mlServerInfer(prompt, system, modelId, opts);
      if (text && text.length > 20) return _withSchema({ text, model: modelId, engine: 'mlserver', task });
    } catch (e) { console.warn('[CareerLM:mlserver]', e.message?.slice(0,60)); }
  }

  if (!ALLOW_EXTERNAL_AI) {
    throw new Error('All internal CareerLM engines unavailable (external AI disabled)');
  }

  // 3. Groq (fast cloud, reliable, free tier)
  if (groq) {
    try {
      const res = await groq.chat.completions.create({
        model: groqId, max_tokens: opts.maxTokens || 4096, temperature: opts.temp ?? 0.78,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      });
      const text = res.choices?.[0]?.message?.content || '';
      if (text && text.length > 20) return _withSchema({ text, model: groqId, engine: 'groq', task });
    } catch (e) { console.warn('[CareerLM:groq]', e.message?.slice(0,60)); }
  }

  // 4. OpenRouter (free tier — DeepSeek fallback)
  try {
    const text = await orInfer(prompt, system, orId, opts);
    if (text && text.length > 20) return _withSchema({ text, model: orId, engine: 'openrouter', task });
  } catch (e) { console.warn('[CareerLM:openrouter]', e.message?.slice(0,60)); }

  // 5. HuggingFace (only if token is set — avoids 45s auth timeout)
  if (HF_TOKEN) {
    try {
      const text = await hfInfer(prompt, system, hfId, opts);
      if (text && text.length > 20) return _withSchema({ text, model: hfId, engine: 'huggingface', task });
    } catch (e) { console.warn('[CareerLM:hf]', e.message?.slice(0,60)); }
  }

  // All providers exhausted — return offline response so callers never throw
  console.error('[CareerLM] All engines unavailable — returning offline response');
  const offlineText = buildOfflineResponse(task, prompt?.slice(0, 200) || '');
  return _withSchema({ text: offlineText, model: 'degraded', engine: 'offline', task });
}

/**
 * Streaming inference — yields text chunks
 */
async function* stream(prompt, system, modelId, opts = {}) {
  const { resolvedSystem, resolvedModel } = resolveTaskConfig(prompt, system, modelId, opts);
  system  = resolvedSystem;
  modelId = resolvedModel;

  const orId      = OR_MAP[modelId]     || OR_MAP['careerlm-base'];
  const groqId    = GROQ_MAP[modelId]   || GROQ_MAP['careerlm-base'];

  // 1. Ollama streaming (local) — try preferred tag, then self-heal through
  // LOCAL_FALLBACK_CHAIN if it fails before yielding anything.
  // Capped at 2 attempts (20s each = 40s worst case) before cloud fallback.
  if (ollamaAvailable) {
    const tried = new Set();
    const candidates = [resolveOllamaTag(modelId), ...LOCAL_FALLBACK_CHAIN].slice(0, 2);
    for (const tag of candidates) {
      if (tried.has(tag)) continue;
      tried.add(tag);
      try {
        let yielded = false;
        for await (const chunk of ollamaStream(prompt, system, tag, opts)) {
          yield chunk; yielded = true;
        }
        if (yielded) return;
      } catch (e) { console.warn(`[CareerLM:ollama stream:${tag}]`, e.message?.slice(0,60)); }
    }
  }

  // 2. Python ML server streaming (local heavy inference, optional)
  if (mlServerAvailable) {
    try {
      const r = await axios.post(`${ML_SERVER}/v1/stream`, {
        prompt, system, model: modelId, max_tokens: opts.maxTokens || 8000,
      }, { responseType: 'stream', timeout: 120000 });
      let buf = '', yielded = false;
      for await (const chunk of r.data) {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const l of lines) {
          if (l.startsWith('data:')) {
            const d = l.slice(5).trim();
            if (d && d !== '[DONE]') { try { const t = JSON.parse(d).text || ''; if (t) { yield t; yielded = true; } } catch (_) { yield d; yielded = true; } }
          }
        }
      }
      if (yielded) return;
    } catch (e) { console.warn('[CareerLM:mlserver stream]', e.message?.slice(0,60)); }
  }

  if (!ALLOW_EXTERNAL_AI) {
    // External AI disabled and all local engines failed — yield offline response
    console.error('[CareerLM] All internal streaming engines unavailable — returning offline response');
    yield buildOfflineResponse(resolvedModel, prompt?.slice(0, 200) || '');
    return;
  }

  // 3. Groq streaming (fast, free, reliable)
  if (groq) {
    try {
      let yielded = false;
      const stream = await groq.chat.completions.create({
        model: groqId, max_tokens: opts.maxTokens || 8000, temperature: opts.temp ?? 0.82, stream: true,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      });
      for await (const chunk of stream) {
        const tok = chunk.choices?.[0]?.delta?.content || '';
        if (tok) { yield tok; yielded = true; }
      }
      if (yielded) return;
    } catch (e) { console.warn('[CareerLM:groq stream]', e.message?.slice(0,60)); }
  }

  // 3. OpenRouter streaming (DeepSeek fallback — reasoning model, yields content after reasoning)
  if (OR_KEY && !OR_KEY.includes('your-')) {
    try {
      const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: orId, stream: true, max_tokens: opts.maxTokens || 8000, temperature: opts.temp || 0.82,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }, {
        headers: { Authorization: `Bearer ${OR_KEY}`, 'HTTP-Referer': 'https://careerstudiomax.com', 'X-Title': 'CareerCamp AI' },
        responseType: 'stream', timeout: 60000,
      });
      let buf = '', yielded = false;
      for await (const chunk of r.data) {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const l of lines) {
          const t = l.replace(/^data: ?/, '').trim();
          if (!t || t === '[DONE]') continue;
          try { const tok = JSON.parse(t)?.choices?.[0]?.delta?.content || ''; if (tok) { yield tok; yielded = true; } } catch (_) {}
        }
      }
      if (yielded) return;
    } catch (e) { console.warn('[CareerLM:or stream]', e.message?.slice(0,60)); }
  }

  // All streaming providers exhausted — yield offline response instead of throwing
  console.error('[CareerLM] All streaming engines unavailable — returning offline response');
  yield buildOfflineResponse(resolvedModel, prompt?.slice(0, 200) || '');
}

// If checkOllama() fails at startup (Ollama not ready yet), retry every 15s
// until it comes up. Clears itself once Ollama is confirmed available.
function _scheduleOllamaRetry() {
  const timer = setInterval(async () => {
    if (ollamaAvailable) { clearInterval(timer); return; }
    await checkOllama(false);
    if (ollamaAvailable) {
      console.log('[CareerLM] Ollama came online (delayed start) — inference now using local models');
      clearInterval(timer);
    }
  }, 15000);
  timer.unref(); // don't keep the process alive just for this
}

module.exports = {
  async init() {
    await Promise.all([checkOllama(), checkMLServer()]);
    if (!ollamaAvailable) _scheduleOllamaRetry();
  },
  status: () => ({
    ollama:         ollamaAvailable,
    ollamaModels,
    allowExternal:  ALLOW_EXTERNAL_AI,
    groq:       !!groq,
    mlServer:   mlServerAvailable,
    hf:         ALLOW_EXTERNAL_AI && !!HF_TOKEN,
    openrouter: ALLOW_EXTERNAL_AI && !!(OR_KEY && !OR_KEY.includes('your-')),
  }),
  infer,
  stream,
  OLLAMA_MAP,
  LOCAL_FALLBACK_CHAIN,
  TASK_MODEL_MAP,
  TASK_PROMPTS,
  SchemaValidator,
  SCHEMAS,
};
