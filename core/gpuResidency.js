'use strict'
/**
 * gpuResidency.js — Single-model-residency guard for 4 GB VRAM.
 *
 * On the RTX 3050 Laptop GPU (4096 MiB):
 *   - cs-haiku + cs-sonnet together = ~2662 MiB → safe to coexist
 *   - ANY pair involving cs-opus exceeds safe VRAM → must evict first
 *
 * When a model swap is needed, the current resident is evicted by sending
 * keep_alive=0 to Ollama, which unloads it from VRAM immediately before
 * the next model loads. This prevents silent OOM crashes where Ollama
 * silently degrades to CPU without warning.
 */

const axios = require('axios')

const OLLAMA = process.env.CS_INFERENCE_URL || 'http://localhost:11434'

// Pairs whose combined VRAM fits safely within 4 GB (with headroom for KV + reserve)
// cs-haiku ~716 MiB + cs-sonnet ~1946 MiB = 2662 MiB → 1434 MiB headroom ✓
const SAFE_COEXIST_PAIRS = [
  new Set(['cs-haiku', 'cs-sonnet']),
  new Set(['cs-haiku', 'careerlm-nano']),
  new Set(['cs-sonnet', 'careerlm-nano']),
]

function canCoexist(modelA, modelB) {
  return SAFE_COEXIST_PAIRS.some(pair => pair.has(modelA) && pair.has(modelB))
}

class GPUResidencyManager {
  constructor() {
    // Set of model names currently loaded in VRAM (may be >1 for safe pairs)
    this._residents = new Set()
    this.swapInProgress = false
    this.totalSwaps     = 0
  }

  /**
   * Called before every Ollama inference request.
   * Evicts any incompatible resident model, then records the new model as resident.
   * @param {string} requestedModel  The model about to be loaded/used
   * @returns {{ swapped: boolean, evicted: string[], coexisting: boolean }}
   */
  async ensureResident(requestedModel) {
    if (this._residents.size === 0) {
      this._residents.add(requestedModel)
      return { swapped: false, evicted: [], coexisting: false }
    }

    if (this._residents.has(requestedModel)) {
      return { swapped: false, evicted: [], coexisting: this._residents.size > 1 }
    }

    // Determine which current residents must be evicted
    const toEvict = []
    for (const resident of this._residents) {
      if (!canCoexist(resident, requestedModel)) {
        toEvict.push(resident)
      }
    }

    if (toEvict.length === 0) {
      // All residents are safe to coexist with the new model
      this._residents.add(requestedModel)
      return { swapped: false, evicted: [], coexisting: true }
    }

    // Must evict incompatible models
    this.swapInProgress = true
    this.totalSwaps++
    console.log(`[GPU-RESIDENCY] Evicting [${toEvict.join(', ')}] → loading ${requestedModel}`)

    await Promise.all(toEvict.map(m => this._evict(m)))

    toEvict.forEach(m => this._residents.delete(m))
    this._residents.add(requestedModel)
    this.swapInProgress = false

    return { swapped: true, evicted: toEvict, coexisting: false }
  }

  /** Evict a model from Ollama VRAM by setting keep_alive to 0 */
  async _evict(modelName) {
    try {
      await axios.post(`${OLLAMA}/api/generate`, {
        model: modelName, prompt: '', keep_alive: 0,
      }, { timeout: 5_000 })
    } catch (e) {
      // Best-effort — if Ollama is unreachable the model will be evicted
      // naturally when the new model loads and VRAM pressure forces a swap
      console.warn(`[GPU-RESIDENCY] Evict request for ${modelName} failed (ignored): ${e.message?.slice(0, 60)}`)
    }
  }

  /** Called when Ollama returns an OOM error — clears tracked state so next
      request does a fresh residency check rather than assuming stale state */
  handleOOM(failedModel) {
    console.warn(`[GPU-RESIDENCY] OOM on ${failedModel} — clearing residency state`)
    this._residents.clear()
  }

  getStatus() {
    return {
      residents:      [...this._residents],
      swapInProgress: this.swapInProgress,
      totalSwaps:     this.totalSwaps,
    }
  }
}

module.exports = new GPUResidencyManager()
