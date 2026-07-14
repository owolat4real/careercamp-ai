'use strict'

const MAX_SAMPLES = 1_000  // rolling window

class PerfMonitor {
  constructor() {
    this.samples = []   // { ms, cached, ts }
    this.cacheHits  = 0
    this.cacheMisses = 0
  }

  recordLatency(ms, cached = false) {
    if (cached) this.cacheHits++; else this.cacheMisses++
    this.samples.push({ ms, cached, ts: Date.now() })
    if (this.samples.length > MAX_SAMPLES) this.samples.shift()
  }

  getStats() {
    const all = this.samples.map(s => s.ms).sort((a, b) => a - b)
    if (!all.length) {
      return { p50: 0, p95: 0, p99: 0, count: 0, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, hitRate: '0%' }
    }
    const p = (pct) => all[Math.floor(all.length * pct / 100)] || 0
    const total = this.cacheHits + this.cacheMisses
    return {
      p50:          p(50),
      p95:          p(95),
      p99:          p(99),
      count:        total,
      cacheHits:    this.cacheHits,
      cacheMisses:  this.cacheMisses,
      hitRate:      total ? `${Math.round(this.cacheHits / total * 100)}%` : '0%',
    }
  }
}

module.exports = new PerfMonitor()
