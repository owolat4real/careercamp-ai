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
const OLLAMA_MAP = {
  'careerlm-nano':   'careerlm-nano:latest',
  'careerlm-small':  'careerlm-base:latest',
  'careerlm-base':   'careerlm-base:latest',
  'careerlm-large':  'careerlm-base:latest',
  'careerlm-xl':     'careerlm-base:latest',
  'careeragent-v1':  'careerlm-base:latest',
  'careerscore-v1':  'mistral:7b',
};

// Ordered chain of locally-pulled models tried automatically when the
// primary mapped model is missing or fails — keeps everything on-device.
const LOCAL_FALLBACK_CHAIN = ['careerlm-base:latest', 'careerlm-nano:latest', 'mistral:7b', 'tinyllama:1.1b'];

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
    model:   modelTag,
    stream:  false,
    // num_ctx: the CSTM-1 system prompt (career taxonomy, formatting rules,
    // intelligence protocol) alone runs several thousand tokens — the
    // Modelfile default of 4096 leaves almost no room for the response,
    // which is why generation was capping out far below num_predict.
    options: { temperature: opts.temp || 0.78, num_predict: opts.maxTokens || 4096, num_ctx: opts.numCtx || 8192 },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ],
  // careerlm-base runs ~3 tok/s on CPU — a 600s timeout meant a single
  // slow/oversized model could block the whole infer() chain for up to
  // 10 minutes before falling through to the next candidate or to the
  // Groq/OpenRouter cloud fallback. 15s keeps each local attempt inside
  // the 5-30s response budget while still giving small models (nano,
  // tinyllama) plenty of room to finish.
  }, { timeout: opts.timeout || 15000 });
  return r.data?.message?.content || '';
}

async function* ollamaStream(prompt, system, modelTag, opts = {}) {
  const r = await axios.post(`${OLLAMA_URL}/api/chat`, {
    model:   modelTag,
    stream:  true,
    options: { temperature: opts.temp || 0.82, num_predict: opts.maxTokens || 8000, num_ctx: opts.numCtx || 8192 },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: prompt },
    ],
  // careerlm-base runs ~3 tok/s on CPU — at the old 600s timeout a single
  // slow model could occupy the whole response for 10 minutes with no
  // chance to fall through to a fast cloud model. 20s keeps local Ollama
  // in the 5-30s budget; Groq/OpenRouter cloud streaming picks up the
  // rest if it doesn't finish in time.
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
      'HTTP-Referer': 'https://careerstudio.ai',
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
 * Non-streaming inference
 * @returns {Promise<{text:string, model:string, engine:string}>}
 */
async function infer(prompt, system, modelId, opts = {}) {
  const hfId      = HF_MAP[modelId]     || HF_MAP['careerlm-base'];
  const orId      = OR_MAP[modelId]     || OR_MAP['careerlm-base'];
  const groqId    = GROQ_MAP[modelId]   || GROQ_MAP['careerlm-base'];

  // 1. Ollama (local, fastest) — try the preferred tag, then self-heal by
  // walking LOCAL_FALLBACK_CHAIN until one of the locally-pulled models responds.
  // Capped at 2 attempts (15s each = 30s worst case) so a run of slow/missing
  // models can't eat the whole 5-30s budget before cloud fallback kicks in.
  if (ollamaAvailable) {
    const tried = new Set();
    const candidates = [resolveOllamaTag(modelId), ...LOCAL_FALLBACK_CHAIN].slice(0, 2);
    for (const tag of candidates) {
      if (tried.has(tag)) continue;
      tried.add(tag);
      try {
        const text = await ollamaInfer(prompt, system, tag, opts);
        if (text && text.length > 20) return { text, model: tag, engine: 'ollama' };
      } catch (e) { console.warn(`[CareerLM:ollama:${tag}]`, e.message?.slice(0,60)); }
    }
  }

  // 2. Python ML server (local heavy inference, optional)
  if (mlServerAvailable) {
    try {
      const text = await mlServerInfer(prompt, system, modelId, opts);
      if (text && text.length > 20) return { text, model: modelId, engine: 'mlserver' };
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
      if (text && text.length > 20) return { text, model: groqId, engine: 'groq' };
    } catch (e) { console.warn('[CareerLM:groq]', e.message?.slice(0,60)); }
  }

  // 4. OpenRouter (free tier — DeepSeek fallback)
  try {
    const text = await orInfer(prompt, system, orId, opts);
    if (text && text.length > 20) return { text, model: orId, engine: 'openrouter' };
  } catch (e) { console.warn('[CareerLM:openrouter]', e.message?.slice(0,60)); }

  // 5. HuggingFace (only if token is set — avoids 45s auth timeout)
  if (HF_TOKEN) {
    try {
      const text = await hfInfer(prompt, system, hfId, opts);
      if (text && text.length > 20) return { text, model: hfId, engine: 'huggingface' };
    } catch (e) { console.warn('[CareerLM:hf]', e.message?.slice(0,60)); }
  }

  throw new Error('All CareerLM engines unavailable');
}

/**
 * Streaming inference — yields text chunks
 */
async function* stream(prompt, system, modelId, opts = {}) {
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
    throw new Error('All internal CareerLM streaming engines unavailable (external AI disabled)');
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
        headers: { Authorization: `Bearer ${OR_KEY}`, 'HTTP-Referer': 'https://careerstudio.ai', 'X-Title': 'CareerCamp AI' },
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

  throw new Error('All CareerLM streaming engines unavailable');
}

module.exports = {
  async init() {
    await Promise.all([checkOllama(), checkMLServer()]);
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
};
