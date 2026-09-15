'use strict';
/**
 * Focused authentication tests for core/gatewayAuth.js — the purpose-
 * specific credential authorization layer that replaced the old
 * "any of CAREERCAMP_API_KEY / CS_TRANSFORMER_API_KEY / CAREERCAMP_SECRET_KEY
 * grants identical access" check.
 *
 * Runs with Node's built-in test runner (no new dependency needed):
 *   node --test test/gatewayAuth.test.js
 *
 * Tests only require core/gatewayAuth.js directly, never server.js -- server.js
 * boots real engines/GPU probes on require and is not something a unit test
 * should start.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SECRET_VAL = 'csk_test_secret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CAMP_VAL   = 'csk_test_camp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const XFORM_VAL  = 'csk_test_xform_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Run `fn(gatewayAuth)` with the three credential env vars set exactly as
 *  given (undefined = unset), restoring the previous values afterward. */
function withEnv(vars, fn) {
  const keys = ['CAREERCAMP_SECRET_KEY', 'CAREERCAMP_API_KEY', 'CS_TRANSFORMER_API_KEY'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const gatewayAuth = require('../core/gatewayAuth');
  gatewayAuth.reload();
  try {
    return fn(gatewayAuth);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    gatewayAuth.reload();
  }
}

function mockReq({ authorization, xApiKey, apiKeyQuery, method = 'GET', url = '/test' } = {}) {
  const headers = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (xApiKey !== undefined) headers['x-api-key'] = xApiKey;
  return { method, originalUrl: url, headers, query: apiKeyQuery !== undefined ? { api_key: apiKeyQuery } : {} };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function runMiddleware(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const ALL_THREE = { CAREERCAMP_SECRET_KEY: SECRET_VAL, CAREERCAMP_API_KEY: CAMP_VAL, CS_TRANSFORMER_API_KEY: XFORM_VAL };

// ── classify() / identify() ──────────────────────────────────────────────

test('classify: correct value resolves to its own credential class', () => {
  withEnv(ALL_THREE, (ga) => {
    assert.equal(ga.classify(SECRET_VAL).class, 'secret');
    assert.equal(ga.classify(CAMP_VAL).class, 'camp');
    assert.equal(ga.classify(XFORM_VAL).class, 'transformer');
  });
});

test('classify: missing credential is rejected as missing_credential, not matched to any class', () => {
  withEnv(ALL_THREE, (ga) => {
    assert.deepEqual(ga.classify(''), { class: null, reason: 'missing_credential' });
    assert.deepEqual(ga.classify(undefined), { class: null, reason: 'missing_credential' });
    assert.deepEqual(ga.classify('   '), { class: null, reason: 'missing_credential' });
  });
});

test('classify: malformed (absurdly long) credential is rejected without being compared as unknown', () => {
  withEnv(ALL_THREE, (ga) => {
    const tooLong = 'x'.repeat(ga.MAX_CREDENTIAL_LENGTH + 1);
    assert.deepEqual(ga.classify(tooLong), { class: null, reason: 'malformed_credential' });
  });
});

test('classify: a well-formed but unconfigured value is rejected as unknown_credential', () => {
  withEnv(ALL_THREE, (ga) => {
    assert.deepEqual(ga.classify('csk_some_value_nobody_configured_00000000000000000000'), { class: null, reason: 'unknown_credential' });
  });
});

test('classify: empty configured env value can never accidentally authorize an empty presented value', () => {
  // CAREERCAMP_SECRET_KEY deliberately unset (empty string) here.
  withEnv({ CAREERCAMP_SECRET_KEY: '', CAREERCAMP_API_KEY: CAMP_VAL, CS_TRANSFORMER_API_KEY: XFORM_VAL }, (ga) => {
    // An empty presented credential must be rejected as missing, never
    // matched against the (dropped, non-matchable) empty secret slot.
    assert.equal(ga.classify('').class, null);
    assert.equal(ga.classify('').reason, 'missing_credential');
  });
});

test('identify() is a thin wrapper returning just the class name or null', () => {
  withEnv(ALL_THREE, (ga) => {
    assert.equal(ga.identify(CAMP_VAL), 'camp');
    assert.equal(ga.identify('not-a-real-key'), null);
  });
});

// ── extractPresented() — both transports, existing precedence preserved ──

test('extractPresented: Authorization Bearer header', () => {
  withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ authorization: `Bearer ${CAMP_VAL}` });
    assert.equal(ga.extractPresented(req), CAMP_VAL);
  });
});

test('extractPresented: x-api-key header (no Authorization present)', () => {
  withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ xApiKey: XFORM_VAL });
    assert.equal(ga.extractPresented(req), XFORM_VAL);
  });
});

test('extractPresented: legacy ?api_key= query param still works', () => {
  withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ apiKeyQuery: CAMP_VAL });
    assert.equal(ga.extractPresented(req), CAMP_VAL);
  });
});

test('extractPresented: Authorization header takes precedence over x-api-key when both are sent', () => {
  withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ authorization: `Bearer ${SECRET_VAL}`, xApiKey: CAMP_VAL });
    assert.equal(ga.extractPresented(req), SECRET_VAL);
  });
});

// ── authorize() middleware — the core Phase 10 matrix ────────────────────

test('1. correct key + allowed route -> success (next called, no response written)', () => {
  withEnv(ALL_THREE, (ga) => {
    const mw = ga.authorize(['camp']);
    const { res, nextCalled } = runMiddleware(mw, mockReq({ authorization: `Bearer ${CAMP_VAL}` }));
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });
});

test('2. correct key + forbidden route -> 403 (valid credential, wrong purpose)', () => {
  withEnv(ALL_THREE, (ga) => {
    // XFORM_VAL is a real, correctly-configured credential -- just not for a 'camp'-only route.
    const mw = ga.authorize(['camp']);
    const { res, nextCalled } = runMiddleware(mw, mockReq({ authorization: `Bearer ${XFORM_VAL}` }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});

test('3. another valid credential + forbidden route -> reject, never falls back to a different class', () => {
  withEnv(ALL_THREE, (ga) => {
    const mw = ga.authorize(['secret']);
    for (const wrongVal of [CAMP_VAL, XFORM_VAL]) {
      const { res, nextCalled } = runMiddleware(mw, mockReq({ authorization: `Bearer ${wrongVal}` }));
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
    }
  });
});

test('4. malformed key -> reject (401)', () => {
  withEnv(ALL_THREE, (ga) => {
    const mw = ga.authorize(['camp', 'secret', 'transformer']);
    const tooLong = 'x'.repeat(ga.MAX_CREDENTIAL_LENGTH + 1);
    const { res, nextCalled } = runMiddleware(mw, mockReq({ authorization: `Bearer ${tooLong}` }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test('5. missing key -> reject (401)', () => {
  withEnv(ALL_THREE, (ga) => {
    const mw = ga.authorize(['camp', 'secret', 'transformer']);
    const { res, nextCalled } = runMiddleware(mw, mockReq({}));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test('6. empty configured env value cannot accidentally authorize an empty presented credential', () => {
  withEnv({ CAREERCAMP_SECRET_KEY: '', CAREERCAMP_API_KEY: CAMP_VAL, CS_TRANSFORMER_API_KEY: XFORM_VAL }, (ga) => {
    const mw = ga.authorize(['secret']);
    const { res, nextCalled } = runMiddleware(mw, mockReq({ authorization: 'Bearer ' })); // empty after "Bearer "
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test('7. duplicate configured values are detected and reported (fail-safe configuration check)', () => {
  withEnv({ CAREERCAMP_SECRET_KEY: SECRET_VAL, CAREERCAMP_API_KEY: SECRET_VAL, CS_TRANSFORMER_API_KEY: XFORM_VAL }, (ga) => {
    const result = ga.checkConfiguration();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'duplicate_secret_value');
    // Reports variable NAMES only -- never the shared value.
    assert.deepEqual(result.detail.sort(), ['CAREERCAMP_API_KEY', 'CAREERCAMP_SECRET_KEY'].sort());
    assert.ok(!JSON.stringify(result).includes(SECRET_VAL), 'duplicate-check result must never contain the secret value');
  });
});

test('7b. checkConfiguration reports no_credentials_configured when all three are unset', () => {
  withEnv({}, (ga) => {
    const result = ga.checkConfiguration();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_credentials_configured');
  });
});

test('7c. checkConfiguration passes when all three are configured and mutually distinct', () => {
  withEnv(ALL_THREE, (ga) => {
    assert.deepEqual(ga.checkConfiguration(), { ok: true });
  });
});

test('8. both supported header transports authorize identically for the same credential', () => {
  withEnv(ALL_THREE, (ga) => {
    const mw = ga.authorize(['camp']);
    const viaBearer = runMiddleware(mw, mockReq({ authorization: `Bearer ${CAMP_VAL}` }));
    const viaApiKeyHeader = runMiddleware(mw, mockReq({ xApiKey: CAMP_VAL }));
    assert.equal(viaBearer.nextCalled, true);
    assert.equal(viaApiKeyHeader.nextCalled, true);
  });
});

// ── Specific purpose-isolation proofs required by this task ─────────────

test('CS_TRANSFORMER_API_KEY cannot access a CareerCamp-only route (chat/search/vision policy)', () => {
  withEnv(ALL_THREE, (ga) => {
    const campOnly = ga.authorize(['camp']); // matches /v1/images, /v1/bert, /v1/search, /api/show, /v1/vision/analyze
    const { res, nextCalled } = runMiddleware(campOnly, mockReq({ authorization: `Bearer ${XFORM_VAL}` }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});

test('CAREERCAMP_API_KEY cannot access a Transformer-only policy', () => {
  withEnv(ALL_THREE, (ga) => {
    // No real route is transformer-only today (CS_TRANSFORMER_API_KEY's one
    // confirmed use, /v1/audio, is shared with 'camp'), but the mechanism
    // itself must correctly enforce this boundary if such a route existed.
    const transformerOnly = ga.authorize(['transformer']);
    const { res, nextCalled } = runMiddleware(transformerOnly, mockReq({ authorization: `Bearer ${CAMP_VAL}` }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});

test("CAREERCAMP_SECRET_KEY's privileges are explicit, not automatically universal", () => {
  withEnv(ALL_THREE, (ga) => {
    // secret IS allowed on /v1/models and the privileged v2.0/diagnostic
    // routes, but must NOT be silently allowed on a camp-only route just
    // because it used to be a universal master key.
    const campOnly = ga.authorize(['camp']);
    const { res, nextCalled } = runMiddleware(campOnly, mockReq({ authorization: `Bearer ${SECRET_VAL}` }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);

    // It DOES work where explicitly listed.
    const models = ga.authorize(['secret', 'camp']);
    const ok = runMiddleware(models, mockReq({ authorization: `Bearer ${SECRET_VAL}` }));
    assert.equal(ok.nextCalled, true);
  });
});

test('diagnostic-route policy (secret-only) rejects the value that used to grant it access under the old single-value check', () => {
  withEnv(ALL_THREE, (ga) => {
    // Before this hardening, /v1/gpu-status, /v1/perf and /metrics accepted
    // CS_TRANSFORMER_API_KEY || CAREERCAMP_API_KEY directly. They are now
    // wired to authorize(['secret']) in server.js -- prove that policy
    // rejects both values the old check used to accept.
    const diagnosticPolicy = ga.authorize(['secret']);
    for (const oldAcceptedVal of [CAMP_VAL, XFORM_VAL]) {
      const { res, nextCalled } = runMiddleware(diagnosticPolicy, mockReq({ authorization: `Bearer ${oldAcceptedVal}` }));
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
    }
    // Only the privileged credential works now.
    const ok = runMiddleware(diagnosticPolicy, mockReq({ authorization: `Bearer ${SECRET_VAL}` }));
    assert.equal(ok.nextCalled, true);
  });
});

test('a value presented as Bearer does not gain a different class\'s privileges just because of transport format', () => {
  withEnv(ALL_THREE, (ga) => {
    // CS_TRANSFORMER_API_KEY sent as Bearer (its native transport is x-api-key
    // in existing CareerStudioMax code) must still classify as 'transformer',
    // not somehow present as 'camp' just because Bearer is camp's normal transport.
    assert.equal(ga.classify(XFORM_VAL).class, 'transformer');
    const campOnly = ga.authorize(['camp']);
    const viaBearer = runMiddleware(campOnly, mockReq({ authorization: `Bearer ${XFORM_VAL}` }));
    assert.equal(viaBearer.nextCalled, false);
    assert.equal(viaBearer.res.statusCode, 403);
  });
});

test('authorize() throws synchronously on a misconfigured (empty) allowedClasses list, never silently allow-all', () => {
  withEnv(ALL_THREE, (ga) => {
    assert.throws(() => ga.authorize([]), /non-empty allowedClasses/);
    assert.throws(() => ga.authorize(), /non-empty allowedClasses/);
  });
});
