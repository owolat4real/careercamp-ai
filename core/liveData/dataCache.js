'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * LIVE DATA CACHE — avoid hammering free-tier API limits
 *
 * In-memory TTL cache. Deliberately simple (Map, not Redis) — live data
 * freshness windows are hours, not milliseconds, and this runs per-process
 * exactly like the rest of careercamp-ai's in-memory caches (responseCache,
 * memoryInSaver). A cache MISS always falls through to a real fetch; a
 * cache entry is never itself an invented value — it's a timestamped copy
 * of a previously-real fetch result.
 * ═══════════════════════════════════════════════════════════════════════ */

const cache = new Map()

const TTL_MS = {
  currency:       60 * 60 * 1000,          // 1 hour — rates don't change fast
  country:        7 * 24 * 60 * 60 * 1000, // 7 days — stats rarely change
  jobMarket:      6 * 60 * 60 * 1000,      // 6 hours — postings shift daily
  countryRegistry: 24 * 60 * 60 * 1000,    // 24 hours — hasDirectSource/region rarely change
}

async function cachedFetch(key, type, fetchFn) {
  const cached = cache.get(key)
  if (cached && Date.now() - cached.timestamp < (TTL_MS[type] || TTL_MS.currency)) {
    return { ...cached.data, fromCache: true }
  }
  const fresh = await fetchFn()
  if (fresh) cache.set(key, { data: fresh, timestamp: Date.now() })
  return fresh
}

/* Exposed for tests / admin introspection — never used to fabricate data */
function _cacheStats() {
  return { size: cache.size, keys: [...cache.keys()] }
}

function _clearCache() {
  cache.clear()
}

module.exports = { cachedFetch, TTL_MS, _cacheStats, _clearCache }
