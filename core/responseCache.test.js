'use strict';
/**
 * Real behavioral tests for core/responseCache.js. Run with:
 * node core/responseCache.test.js
 *
 * No test framework dependency -- same plain-assert convention used across
 * this project's sibling repos (e.g. api-platform/services/fabricationGuard.test.js).
 */
const assert = require('assert');
const { ResponseCache } = require('./responseCache');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✕ ${name}`); console.log(`    ${e.stack || e}`); }
}

console.log('ResponseCache.getCacheKey / get / set');

test('the real live-caught bug: two different requests sharing a long (>500 char) fixed preamble no longer collide once the CV/JD content differs', () => {
  const cache = new ResponseCache();
  // A realistic anti-fabrication instructional preamble, matching the real
  // shape of api-platform's pCVOptimise prompt -- well over 500 characters
  // on its own, before any real per-user CV content appears.
  const preamble = 'Optimise this CV (market: GB). Rewrite level: moderate. Preserve voice: true. Add metrics where missing: true. CRITICAL never invent facts not present in the original CV below. Do not add any skill tool framework or technology the candidate did not already list unless those exact words already appear in the CV. Do not invent an education section degree institution or graduation year if none exists in the original -- if education is genuinely missing omit that section entirely rather than fabricate one. Do not invent employer names job titles or dates not in the original. Add metrics where missing means quantifying achievements the candidate already describes -- it does not mean inventing new responsibilities systems or results the candidate never mentioned. ORIGINAL CV: ';
  const normalisedPreambleLength = preamble.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').length;
  assert.ok(normalisedPreambleLength > 500, `test fixture must actually exceed the old 500-char cap to prove the fix (got ${normalisedPreambleLength})`);

  const inputA = preamble + 'Jane Smith, Software Engineer, worked at TechCorp.';
  const inputB = preamble + 'John Doe, Data Scientist, worked at Acme Analytics.';

  cache.set('resume_auto_optimiser', inputA, {}, 'REAL OUTPUT FOR JANE');
  const hitForB = cache.get('resume_auto_optimiser', inputB, {});
  assert.strictEqual(hitForB, null, 'a genuinely different CV must never hit another CV\'s cached response');

  const hitForA = cache.get('resume_auto_optimiser', inputA, {});
  assert.strictEqual(hitForA, 'REAL OUTPUT FOR JANE', 'the original request should still legitimately hit its own cache entry');
});

test('a genuinely identical request (same featureId + input + context) is a real cache hit', () => {
  const cache = new ResponseCache();
  cache.set('cv_score', 'score this cv: same text', {}, 'cached result');
  assert.strictEqual(cache.get('cv_score', 'score this cv: same text', {}), 'cached result');
});

test('the same input under a different featureId is not confused for the same entry', () => {
  const cache = new ResponseCache();
  cache.set('cv_score', 'identical text here', {}, 'score result');
  assert.strictEqual(cache.get('cover_letter_m01', 'identical text here', {}), null);
});

test('a different context (e.g. country) produces a different cache key', () => {
  const cache = new ResponseCache();
  cache.set('salary_report', 'role: engineer', { country: 'GB' }, 'GB result');
  assert.strictEqual(cache.get('salary_report', 'role: engineer', { country: 'US' }), null);
});

test('NEVER_CACHE features (salary_benchmark, career_coach, live_interview_mode) are never stored or served, even after set()', () => {
  const cache = new ResponseCache();
  cache.set('salary_benchmark', 'some input', {}, 'should never be stored');
  assert.strictEqual(cache.get('salary_benchmark', 'some input', {}), null);
  assert.strictEqual(cache.stats().size, 0, 'set() on a NEVER_CACHE feature must not grow the cache at all');
});

Promise.resolve().then(async () => {
  // Run the async TTL test explicitly since this file has no framework runner.
  const cache = new ResponseCache({ ttl: 10 });
  cache.set('cv_score', 'text-ttl-check', {}, 'stale result');
  await new Promise(r => setTimeout(r, 30));
  try {
    assert.strictEqual(cache.get('cv_score', 'text-ttl-check', {}), null);
    passed++; console.log('  ✓ (async) an expired entry (past TTL) is treated as a miss and evicted');
  } catch (e) {
    failed++; console.log('  ✕ (async) an expired entry (past TTL) is treated as a miss and evicted');
    console.log(`    ${e.stack || e}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
