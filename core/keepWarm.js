'use strict'
const axios = require('axios')

const OLLAMA_URL  = process.env.OLLAMA_URL  || 'http://127.0.0.1:11434'
const INTERVAL_MS = parseInt(process.env.KEEP_WARM_INTERVAL_MS) || 4 * 60 * 1000  // 4 min
const MODELS      = ['cs-haiku', 'cs-sonnet']

async function _pingModel(model) {
  try {
    await axios.post(`${OLLAMA_URL}/api/generate`, {
      model,
      prompt:     'ping',
      keep_alive: '10m',
      options:    { num_predict: 1 },
    }, { timeout: 10_000 })
  } catch (_) {
    /* silent — model may not be loaded yet; heartbeat will retry */
  }
}

async function warmAll() {
  await Promise.allSettled(MODELS.map(_pingModel))
}

function startKeepWarm() {
  warmAll()  // fire immediately on startup
  setInterval(warmAll, INTERVAL_MS)
}

module.exports = { startKeepWarm, warmAll }
