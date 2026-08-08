'use strict'
/**
 * gpuScheduler.js — GPU-aware concurrency limiter per model tier.
 *
 * Original limits below were validated on an RTX 3050 Laptop GPU (4 GB
 * VRAM, 2560 CUDA cores) — cs-opus has since moved to a real 70B model on
 * a 40-80GB pod (see gpuLayerCalculator.js), which changes ITS number
 * specifically; haiku/sonnet stay on the same small models these limits
 * were validated against, so their numbers are unchanged.
 *
 * Concurrent streams on the same model share GPU bandwidth/compute — past
 * a hardware-validated limit, queuing requests and running them
 * sequentially is faster than letting them fight each other.
 *
 * Safe concurrency limits:
 *   haiku  (1B):   3 concurrent streams — small model, wide batch headroom, validated on RTX 3050
 *   sonnet (3B):   2 concurrent streams — medium model, moderate VRAM/compute, validated on RTX 3050
 *   opus   (70B):  1 concurrent stream  — large model, no real headroom for a second stream even
 *                  on 40-80GB (a single 70B load already uses most of the budget) — not yet
 *                  re-validated with real pod throughput data, kept conservative at 1
 *   nano         :  4 concurrent streams — tiny model, negligible VRAM
 *
 * Requests that arrive when the slot is full are queued (spin-wait, 100 ms
 * intervals). The maximum wait duration is capped at 60 s to prevent requests
 * from stacking up silently behind a hung task.
 */

const CONCURRENCY_LIMITS = {
  haiku:        3,
  sonnet:       2,
  opus:         1,
  nano:         4,
  default:      1,   // safe fallback for unknown tiers
}

const SLOT_WAIT_INTERVAL_MS = 100
const MAX_WAIT_MS           = 60_000

class GPUScheduler {
  constructor() {
    this._active = {
      haiku:  0,
      sonnet: 0,
      opus:   0,
      nano:   0,
    }
  }

  /**
   * Acquires a GPU concurrency slot for the given tier, runs taskFn, then
   * releases the slot. Queues callers when at the limit.
   *
   * @param {string}   tier    'haiku' | 'sonnet' | 'opus' | 'nano'
   * @param {Function} taskFn  Async function to execute under the slot
   * @returns {Promise<*>}     Whatever taskFn returns
   */
  async withGpuSlot(tier, taskFn) {
    const limit    = CONCURRENCY_LIMITS[tier] ?? CONCURRENCY_LIMITS.default
    const waitedMs = await this._acquireSlot(tier, limit)

    if (waitedMs > 0) {
      console.log(`[GPU-SCHED] ${tier}: waited ${waitedMs}ms for a slot (active: ${this._active[tier]}/${limit})`)
    }

    this._active[tier] = (this._active[tier] || 0) + 1
    try {
      return await taskFn()
    } finally {
      this._active[tier] = Math.max(0, (this._active[tier] || 1) - 1)
    }
  }

  /** Spin-waits until a slot is free, returns how long we waited */
  async _acquireSlot(tier, limit) {
    const start = Date.now()
    while ((this._active[tier] || 0) >= limit) {
      const elapsed = Date.now() - start
      if (elapsed >= MAX_WAIT_MS) {
        console.warn(`[GPU-SCHED] ${tier}: max wait ${MAX_WAIT_MS}ms exceeded — proceeding anyway`)
        break
      }
      await new Promise(r => setTimeout(r, SLOT_WAIT_INTERVAL_MS))
    }
    return Date.now() - start
  }

  /**
   * Explicit acquire/release for async generator contexts where withGpuSlot
   * cannot wrap yield statements. Always pair acquireSlot with releaseSlot
   * in a try/finally block.
   */
  async acquireSlot(tier) {
    const limit = CONCURRENCY_LIMITS[tier] ?? CONCURRENCY_LIMITS.default
    await this._acquireSlot(tier, limit)
    this._active[tier] = (this._active[tier] || 0) + 1
  }

  releaseSlot(tier) {
    this._active[tier] = Math.max(0, (this._active[tier] || 1) - 1)
  }

  /** Returns current load across all tiers, for /v1/gpu-status */
  getLoad() {
    const load = {}
    for (const tier of Object.keys(CONCURRENCY_LIMITS)) {
      load[tier] = {
        active: this._active[tier] || 0,
        limit:  CONCURRENCY_LIMITS[tier],
      }
    }
    return load
  }
}

module.exports = new GPUScheduler()
