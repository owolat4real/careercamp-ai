'use strict';
/**
 * METRICS COLLECTOR — In-memory performance and quality tracking.
 * No external monitoring dependency. Exposed via /metrics endpoint.
 */

class MetricsCollector {
  constructor() {
    this._calls    = {};   // model → { count, totalMs, totalTokens, errors }
    this._features = {};   // featureId → count
    this._tasks    = {};   // task → count
    this._errors   = [];   // last 50 errors
    this._quality  = [];   // last 100 quality scores
    this._startTime = Date.now();
  }

  record({ model, task, featureId, latencyMs, tokens, quality, fallback, error }) {
    const key = model || 'unknown';
    if (!this._calls[key]) this._calls[key] = { count: 0, totalMs: 0, totalTokens: 0, errors: 0, fallbacks: 0 };
    const m = this._calls[key];
    m.count++;
    m.totalMs     += latencyMs || 0;
    m.totalTokens += tokens    || 0;
    if (error)    m.errors++;
    if (fallback) m.fallbacks++;

    if (task)      this._tasks[task]         = (this._tasks[task] || 0) + 1;
    if (featureId) this._features[featureId] = (this._features[featureId] || 0) + 1;

    if (quality !== undefined) {
      this._quality.push(quality);
      if (this._quality.length > 100) this._quality.shift();
    }
  }

  recordError(err) {
    this._errors.push({ message: err?.message, stack: err?.stack?.slice(0, 200), at: new Date().toISOString() });
    if (this._errors.length > 50) this._errors.shift();
  }

  getSummary() {
    const totalCalls = Object.values(this._calls).reduce((s, m) => s + m.count, 0);
    const avgQuality = this._quality.length ? Math.round(this._quality.reduce((a, b) => a + b, 0) / this._quality.length) : null;
    return { totalCalls, avgQuality, uptimeMs: Date.now() - this._startTime, models: Object.keys(this._calls) };
  }

  getDetailed() {
    const models = {};
    for (const [model, m] of Object.entries(this._calls)) {
      models[model] = {
        calls:        m.count,
        avgLatencyMs: m.count ? Math.round(m.totalMs / m.count) : 0,
        avgTokens:    m.count ? Math.round(m.totalTokens / m.count) : 0,
        avgTps:       m.totalMs > 0 ? Math.round(m.totalTokens / (m.totalMs / 1000)) : 0,
        errorRate:    m.count ? `${Math.round((m.errors / m.count) * 100)}%` : '0%',
        fallbackRate: m.count ? `${Math.round((m.fallbacks / m.count) * 100)}%` : '0%',
      };
    }
    return {
      models,
      topFeatures: Object.entries(this._features).sort((a, b) => b[1] - a[1]).slice(0, 10),
      topTasks:    Object.entries(this._tasks).sort((a, b) => b[1] - a[1]).slice(0, 10),
      recentErrors: this._errors.slice(-5),
      avgQuality:  this._quality.length ? Math.round(this._quality.reduce((a, b) => a + b, 0) / this._quality.length) : null,
      uptimeMs:    Date.now() - this._startTime,
    };
  }
}

module.exports = { MetricsCollector };
