'use strict';
/**
 * Focused tests for the two defects the second independent review
 * demonstrated against abdb4fc and that this remediation pass fixes:
 *   1. HIGH — credential logging disclosure via percent-encoded query names
 *   2. MEDIUM — malformed nested/array query credentials causing HTTP 500
 *
 * Numbered to match the 22-item list the remediation task specified.
 * Synthetic credentials only.
 *
 *   node --test test/gatewayAuth.final-remediation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, serve, values, fullEnv } = require('./gatewayAuth.codex-harness.cjs');

const SECRET = values.secret; // codex_synthetic_secret_7d09 (harness-defined synthetic value)
const CAMP   = values.camp;
const XFORM  = values.transformer;

function assertNoLeak(haystack, secret) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  assert.ok(!text.includes(secret), `synthetic credential must not appear in: ${text.slice(0, 200)}`);
}

// ── 1-8: redaction, structural, per encoding variant ─────────────────────

test('1. literal api_key is redacted', () => {
  const ga = require('../core/gatewayAuth');
  assertNoLeak(ga.redactUrl(`/v1/models?api_key=${SECRET}`), SECRET);
});

test('2. encoded first character (%61pi_key) is redacted', () => {
  const ga = require('../core/gatewayAuth');
  assertNoLeak(ga.redactUrl(`/v1/models?%61pi_key=${SECRET}`), SECRET);
});

test('3. encoded underscore (api%5fkey) is redacted', () => {
  const ga = require('../core/gatewayAuth');
  assertNoLeak(ga.redactUrl(`/v1/models?api%5fkey=${SECRET}`), SECRET);
});

test('4. fully encoded key name is redacted', () => {
  const ga = require('../core/gatewayAuth');
  const encodedName = [...'api_key'].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
  assertNoLeak(ga.redactUrl(`/v1/models?${encodedName}=${SECRET}`), SECRET);
});

test('5. encoded brackets (api_key%5B0%5D) are redacted', () => {
  const ga = require('../core/gatewayAuth');
  assertNoLeak(ga.redactUrl(`/v1/models?api_key%5B0%5D=${SECRET}`), SECRET);
});

test('6. nested brackets (api_key[a][b]) are redacted', () => {
  const ga = require('../core/gatewayAuth');
  assertNoLeak(ga.redactUrl(`/v1/models?api_key[a][b]=${SECRET}`), SECRET);
});

test('7. encoded name + encoded value is redacted', () => {
  const ga = require('../core/gatewayAuth');
  const encoded = s => [...s].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
  assertNoLeak(ga.redactUrl(`/v1/models?${encoded('api_key')}=${encoded(SECRET)}`), SECRET);
});

test('8. repeated api_key parameters cannot leak', () => {
  const ga = require('../core/gatewayAuth');
  assertNoLeak(ga.redactUrl(`/v1/models?api_key=${SECRET}&api_key=${SECRET}`), SECRET);
});

// ── 9-13: end-to-end, real router + real morgan/auth-warning capture ─────

test('9. successful query authentication cannot leak (real pipeline)', async () => {
  const h = build();
  await serve(h, async request => {
    const r = await request('GET', `/v1/models?api_key=${CAMP}`);
    assert.equal(r.status, 200);
    assertNoLeak(h.logs, CAMP);
    assertNoLeak(r.body, CAMP);
  });
});

test('10. failed (unknown) query authentication cannot leak', async () => {
  const h = build();
  await serve(h, async request => {
    const unknown = 'final_remediation_SYNTHETIC_unknown_5f0a91';
    const r = await request('GET', `/v1/models?api_key=${unknown}`);
    assert.equal(r.status, 401);
    assertNoLeak(h.logs, unknown);
    assertNoLeak(r.body, unknown);
  });
});

test('11. wrong-purpose query authentication cannot leak', async () => {
  const h = build();
  await serve(h, async request => {
    // transformer is valid but not in the 'core' policy for /v1/models
    const r = await request('GET', `/v1/models?api_key=${XFORM}`);
    assert.equal(r.status, 403);
    assertNoLeak(h.logs, XFORM);
    assertNoLeak(r.body, XFORM);
  });
});

test('12. Morgan access-log output cannot leak, across all three outcomes and via Referer', async () => {
  const h = build();
  await serve(h, async request => {
    await request('GET', `/v1/models?api_key=${CAMP}`);                 // success
    await request('GET', `/v1/models?api_key=unknown_${SECRET}`);       // failure (still leaks-checked below)
    await request('GET', '/v1/models', { Referer: `https://x.invalid/?api_key=${SECRET}` });
    assertNoLeak(h.logs.access, SECRET);
    assertNoLeak(h.logs.access, CAMP);
  });
});

test('13. auth-warning output cannot leak', async () => {
  const h = build();
  await serve(h, async request => {
    await request('GET', `/v1/models?api_key=${XFORM}`);   // wrong-purpose warning
    await request('GET', '/v1/models');                     // missing warning
    assertNoLeak(h.logs.warn, XFORM);
    assertNoLeak(h.logs.warn, SECRET);
    assertNoLeak(h.logs.warn, CAMP);
  });
});

// ── 14-19: malformed parsing, never 500, never coerced ────────────────────

test('14. api_key[toString]=x -> 401, not 500', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key[toString]=x');
    assert.equal(r.status, 401);
  });
});

test('15. api_key[0][toString]=x -> 401', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key[0][toString]=x');
    assert.equal(r.status, 401);
  });
});

test('16. api_key[][toString]=x -> 401', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key[][toString]=x');
    assert.equal(r.status, 401);
  });
});

test('17. encoded nested equivalent (api_key%5B0%5D%5BtoString%5D=x) -> 401', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key%5B0%5D%5BtoString%5D=x');
    assert.equal(r.status, 401);
  });
});

test('18. array containing an object -> reject without coercion (no throw reaches the process)', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key[0][toString]=x&api_key[0][valueOf]=y');
    assert.equal(r.status, 401);
  });
});

test('19. nested object (single-level bracket) -> reject', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key[a]=x');
    assert.equal(r.status, 401);
  });
});

// ── 20-22: primitives still work, missing/oversized still safe ───────────

test('20. primitive valid string still works (query transport, plain)', async () => {
  await serve(build(), async request => {
    const r = await request('GET', `/v1/models?api_key=${SECRET}`);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).credentialClass, 'secret');
  });
});

test('21. missing credential remains 401', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models');
    assert.equal(r.status, 401);
  });
});

test('22. oversized presented credential remains 401 (query transport)', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/models?api_key=' + 'x'.repeat(10000));
    assert.equal(r.status, 401);
  });
});

// ── Extra: redaction never breaks non-credential query debugging info ────

test('extra: non-credential query parameters remain visible in logs for real debugging value', () => {
  const ga = require('../core/gatewayAuth');
  const out = ga.redactUrl('/v1/search?q=resume+tips&api_key=' + SECRET);
  assert.ok(out.includes('q=resume'), 'non-sensitive params should stay readable');
  assertNoLeak(out, SECRET);
});

// ── Extra: array-rejection policy is a startup-config-independent, pure
// property of extractPresented -- prove it doesn't depend on which classes
// happen to be configured.
test('extra: array query rejection holds regardless of credential configuration', async () => {
  await serve(build({ CAREERCAMP_API_KEY: CAMP }), async request => {
    const r = await request('GET', '/v1/models?api_key[]=' + CAMP);
    assert.equal(r.status, 401, 'a single-element array must never authenticate even when its lone value is a real, valid credential');
  });
});
