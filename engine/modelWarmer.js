'use strict';
/**
 * MODEL WARMER — Pings each local model at boot so Ollama loads them into VRAM.
 * Models pinged in priority order: cs-sonnet first (primary), then cs-haiku, then careerlm-nano.
 * Non-blocking — server starts even if models are cold; they warm lazily on first real call.
 */
const axios = require('axios');

const OLLAMA = process.env.CS_INFERENCE_URL || 'http://localhost:11434';

const WARM_MODELS = [
  { name: 'cs-sonnet',     alias: 'cs-sonnet-fast',   priority: 1 },
  { name: 'cs-haiku',      alias: 'cs-haiku-fast',    priority: 2 },
  { name: 'careerlm-nano', alias: 'careerlm-nano',    priority: 3 },
];

const _warm = {};

async function pingModel(ollamaName) {
  try {
    const resp = await axios.post(`${OLLAMA}/v1/chat/completions`, {
      model:      ollamaName,
      messages:   [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream:     false,
    }, { timeout: 15000 });
    return !!resp.data?.choices?.[0];
  } catch {
    return false;
  }
}

async function warmAll() {
  // Check which models are registered in Ollama first (fast registry check)
  let registered = [];
  try {
    const r = await axios.get(`${OLLAMA}/api/tags`, { timeout: 5000 });
    registered = (r.data?.models || []).map(m => m.name?.split(':')[0]);
  } catch {}

  console.log('[ModelWarmer] Probing local models…');

  await Promise.allSettled(
    WARM_MODELS.map(async ({ name, alias }) => {
      const modelId = registered.includes(alias) ? alias : (registered.includes(name) ? name : null);
      if (!modelId) {
        console.log(`  ⚠  ${name}: not found in Ollama registry`);
        _warm[name] = false;
        return;
      }
      const ok = await pingModel(modelId);
      _warm[name] = ok;
      console.log(ok ? `  ✅ ${name} (${modelId}) warm` : `  ⚠  ${name} cold — will warm on first call`);
    })
  );

  const warmCount = Object.values(_warm).filter(Boolean).length;
  console.log(`[ModelWarmer] ${warmCount}/${WARM_MODELS.length} models warm\n`);
  return _warm;
}

function isWarm(modelName) { return !!_warm[modelName]; }
function getWarmStatus()   { return { ..._warm }; }

async function quickPing(modelName) {
  const model = WARM_MODELS.find(m => m.name === modelName);
  if (!model) return false;
  const ok = await pingModel(model.alias || model.name);
  _warm[modelName] = ok;
  return ok;
}

module.exports = { warmAll, isWarm, getWarmStatus, quickPing };
