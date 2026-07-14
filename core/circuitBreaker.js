'use strict';

/**
 * circuitBreaker — skip repeatedly-failing providers for a cooldown period.
 *
 * Pattern 4 defense: stops wasting retry budget on a provider that's
 * clearly down, making fallback to the NEXT provider faster.
 *
 * State: CLOSED (normal) → OPEN (skip for cooldown) → CLOSED (auto-reset)
 *
 * Usage:
 *   const cb = require('./circuitBreaker');
 *   if (cb.isOpen('groq')) continue;
 *   try   { const r = await callGroq(...); cb.recordSuccess('groq'); return r; }
 *   catch { cb.recordFailure('groq'); }
 */
class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 60_000 } = {}) {
    this.failures  = new Map();   /* providerId → { count, openedAt } */
    this.threshold = threshold;
    this.cooldown  = cooldownMs;
  }

  /**
   * Returns true when the circuit is open and the provider should be skipped.
   * Automatically resets after cooldown expires.
   */
  isOpen(provider) {
    const state = this.failures.get(provider);
    if (!state || state.count < this.threshold) return false;
    if (Date.now() - state.openedAt > this.cooldown) {
      this.failures.delete(provider);   /* cooldown expired — allow one attempt */
      return false;
    }
    return true;
  }

  /** Call after every failed provider attempt */
  recordFailure(provider) {
    const state = this.failures.get(provider) || { count: 0, openedAt: 0 };
    state.count++;
    if (state.count >= this.threshold && !state.openedAt) {
      state.openedAt = Date.now();
      console.warn(`[CIRCUIT-BREAKER] ⚡ Circuit OPEN for ${provider} — skipping for ${Math.round(this.cooldown / 1000)}s`);
    }
    this.failures.set(provider, state);
  }

  /** Call after every successful provider call to reset failure count */
  recordSuccess(provider) {
    if (this.failures.has(provider)) {
      this.failures.delete(provider);
    }
  }

  /** Status for debugging / admin endpoints */
  getStatus() {
    const out = {};
    for (const [id, state] of this.failures.entries()) {
      const remainingMs = this.cooldown - (Date.now() - state.openedAt);
      out[id] = {
        failures:    state.count,
        open:        state.count >= this.threshold,
        remainingSec: Math.max(0, Math.round(remainingMs / 1000)),
      };
    }
    return out;
  }
}

/* Export a singleton so all callers share the same breaker state */
module.exports = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
