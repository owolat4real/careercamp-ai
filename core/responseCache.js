'use strict'
/**
 * SEMANTIC RESPONSE CACHE — normalise + hash for near-duplicate matching.
 * Cached hits return in 5-50ms. Max 5,000 entries, 24-hour TTL, LRU eviction.
 * No Redis needed — this in-memory cache already covers the high-value hot path.
 * Upgrade to Redis later by swapping the Map for ioredis without changing the API.
 */

const crypto = require('crypto')

const DEFAULT_TTL     = 24 * 60 * 60 * 1000  // 24 h
const DEFAULT_MAX     = 5_000
/* Features that should never be cached (personalised / real-time) */
const NEVER_CACHE     = new Set(['salary_benchmark', 'career_coach', 'live_interview_mode'])

class ResponseCache {
  constructor({ maxSize = DEFAULT_MAX, ttl = DEFAULT_TTL } = {}) {
    this.cache   = new Map()
    this.maxSize = maxSize
    this.ttl     = ttl
  }

  /* Normalise text and build a stable hash key.
   * Real, live-caught bug (2026-09-05): this used to .slice(0, 500) the
   * normalised text BEFORE hashing. Several features (resume_auto_optimiser,
   * cover_letter_*, interview_engine_1, job_match_scorer...) send a long
   * fixed instructional preamble ahead of the actual per-user content (a
   * CV, job description, etc). Once that preamble alone exceeds 500
   * normalised characters, the truncated slice is IDENTICAL for every
   * request regardless of the real CV/JD content that follows it -- so
   * two completely different users' requests hashed to the same cache
   * key and one user's real cached output (potentially containing another
   * candidate's actual CV content) was served back as the response to a
   * totally different request. Confirmed live: two different test CVs
   * against resume_auto_optimiser returned byte-identical cached output.
   * Hashing the full normalised string (no truncation) costs nothing
   * material -- MD5 over a few KB is negligible -- and preserves the
   * intended "near-duplicate" normalisation (case/whitespace/punctuation)
   * for genuinely short queries, which were never affected by this bug. */
  getCacheKey(featureId, userInput, context = {}) {
    const normalised = String(userInput || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
    const ctx = `${context.country || ''}_${context.currentRole || ''}_${context.language || ''}`
    const raw = `${featureId}::${normalised}::${ctx}`
    return crypto.createHash('md5').update(raw).digest('hex')
  }

  get(featureId, userInput, context) {
    if (NEVER_CACHE.has(featureId)) return null
    const key   = this.getCacheKey(featureId, userInput, context)
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key)
      return null
    }
    entry.hits++
    return entry.response
  }

  set(featureId, userInput, context, response) {
    if (NEVER_CACHE.has(featureId)) return
    const key = this.getCacheKey(featureId, userInput, context)

    /* LRU-style eviction — remove the oldest entry when full */
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      this.cache.delete(oldest)
    }

    this.cache.set(key, { response, timestamp: Date.now(), hits: 0 })
  }

  invalidate(featureId) {
    /* Remove all entries for a feature (e.g. after model update) */
    for (const [key, entry] of this.cache) {
      if (entry.response?.featureId === featureId) this.cache.delete(key)
    }
  }

  stats() {
    let totalHits = 0
    for (const e of this.cache.values()) totalHits += e.hits
    return { size: this.cache.size, maxSize: this.maxSize, totalHits }
  }

  clear() { this.cache.clear() }
}

module.exports = new ResponseCache()
module.exports.ResponseCache = ResponseCache
