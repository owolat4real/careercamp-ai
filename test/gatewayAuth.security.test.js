'use strict';
/**
 * Independent adversarial review of core/gatewayAuth.js and its wiring in
 * server.js (commit 4ee4d71). Written as a SEPARATE reviewer, not a rerun
 * of core/gatewayAuth.js's own author's test suite (test/gatewayAuth.test.js).
 *
 *   node --test test/gatewayAuth.security.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const SECRET_VAL = 'csk_test_secret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CAMP_VAL   = 'csk_test_camp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const XFORM_VAL  = 'csk_test_xform_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ALL_THREE = { CAREERCAMP_SECRET_KEY: SECRET_VAL, CAREERCAMP_API_KEY: CAMP_VAL, CS_TRANSFORMER_API_KEY: XFORM_VAL };

// withEnv is async and its returned promise MUST be awaited by every
// caller. A bare try/finally around an async fn would restore env vars
// (and call ga.reload()) as soon as fn's synchronous prefix returns a
// PENDING promise -- before its awaited body actually runs -- silently
// resetting _configured out from under any assertion that fires after an
// `await`, and (worse) swallowing a synchronous assertion failure inside
// an async fn as an unawaited rejected promise instead of failing the test.
// Every test() below is itself async and does `await withEnv(...)`.
async function withEnv(vars, fn) {
  const keys = ['CAREERCAMP_SECRET_KEY', 'CAREERCAMP_API_KEY', 'CS_TRANSFORMER_API_KEY'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const ga = require('../core/gatewayAuth');
  ga.reload();
  try {
    return await fn(ga);
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    ga.reload();
  }
}

function mockReq({ authorization, xApiKey, apiKeyQuery, method = 'GET', url = '/test', headersOverride } = {}) {
  const headers = headersOverride || {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (xApiKey !== undefined) headers['x-api-key'] = xApiKey;
  return { method, originalUrl: url, headers, query: apiKeyQuery !== undefined ? { api_key: apiKeyQuery } : {} };
}
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function run(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

// ══════════════════════════════════════════════════════════════════════
// PHASE 1/8 — independent review of _safeEqual / classify robustness
// ══════════════════════════════════════════════════════════════════════

test('DEFENSE: classify() never throws on non-string presented values (object/array/number)', async () => {
  await withEnv(ALL_THREE, (ga) => {
    for (const weird of [{}, [], 42, true, Symbol('x'), () => {}, Buffer.from('x')]) {
      assert.doesNotThrow(() => ga.classify(weird));
      // None of these must ever resolve to a real class.
      assert.equal(ga.classify(weird).class, null);
    }
  });
});

test('DEFENSE: classify() on the exact configured value of a DIFFERENT env var never cross-matches after reconfiguration', async () => {
  // Regression-shaped check: reload() must fully replace _configured, not append.
  await withEnv({ CAREERCAMP_SECRET_KEY: SECRET_VAL }, (ga) => {
    assert.equal(ga.classify(SECRET_VAL).class, 'secret');
    assert.equal(ga.classify(CAMP_VAL).class, null); // camp not configured yet
  });
  await withEnv(ALL_THREE, (ga) => {
    assert.equal(ga.classify(CAMP_VAL).class, 'camp');
  });
  // Back to only 'secret' configured -- CAMP_VAL must stop being valid, proving
  // reload() doesn't leak stale configured entries across reconfiguration.
  await withEnv({ CAREERCAMP_SECRET_KEY: SECRET_VAL }, (ga) => {
    assert.equal(ga.classify(CAMP_VAL).class, null);
  });
});

test('DEFENSE: an extremely long presented value (10k chars) is rejected as malformed, not slow or crashing', async () => {
  await withEnv(ALL_THREE, (ga) => {
    const huge = 'a'.repeat(10000);
    const start = process.hrtime.bigint();
    const result = ga.classify(huge);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(result.class, null);
    assert.equal(result.reason, 'malformed_credential');
    assert.ok(elapsedMs < 50, `classify() on a 10k-char input took ${elapsedMs}ms -- unexpectedly slow`);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PHASE 5 — header confusion
// ══════════════════════════════════════════════════════════════════════

test('HEADER CONFUSION: conflicting Bearer (secret) vs x-api-key (camp) -- Authorization must win, camp value must be ignored entirely', async () => {
  await withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ authorization: `Bearer ${SECRET_VAL}`, xApiKey: CAMP_VAL });
    assert.equal(ga.extractPresented(req), SECRET_VAL);
    const secretOnly = ga.authorize(['secret']);
    const campOnly = ga.authorize(['camp']);
    assert.equal(run(secretOnly, req).nextCalled, true, 'must authenticate as secret (the Authorization value)');
    assert.equal(run(campOnly, req).nextCalled, false, 'must NOT authenticate as camp -- x-api-key must be fully ignored when Authorization is present');
  });
});

test('HEADER CONFUSION: conflicting query api_key (transformer) vs x-api-key (camp), no Authorization -- query must win per documented precedence', async () => {
  await withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ apiKeyQuery: XFORM_VAL, xApiKey: CAMP_VAL });
    assert.equal(ga.extractPresented(req), XFORM_VAL);
  });
});

test('HEADER CONFUSION: empty "Bearer " (nothing after the scheme) falls through to x-api-key rather than authenticating as empty', async () => {
  await withEnv(ALL_THREE, (ga) => {
    // "Bearer " with a trailing space and nothing else strips to '' via the
    // regex, which is falsy -- extractPresented must fall through to the
    // next transport rather than presenting an empty string as "the" credential.
    const req = mockReq({ authorization: 'Bearer ', xApiKey: CAMP_VAL });
    assert.equal(ga.extractPresented(req), CAMP_VAL);
  });
});

test('HEADER CONFUSION: whitespace-only Authorization value is rejected as missing, not treated as a distinct malformed credential class', async () => {
  await withEnv(ALL_THREE, (ga) => {
    const req = mockReq({ authorization: 'Bearer    ' });
    const result = ga.classify(ga.extractPresented(req));
    assert.equal(result.class, null);
    assert.equal(result.reason, 'missing_credential');
  });
});

test('HEADER CONFUSION: malformed Bearer syntax without a separating space is treated as an opaque unknown credential, not stripped', async () => {
  await withEnv(ALL_THREE, (ga) => {
    // No literal "Bearer " (no space) -- the whole string is presented verbatim.
    const req = mockReq({ authorization: `Bearer${CAMP_VAL}` });
    assert.equal(ga.extractPresented(req), `Bearer${CAMP_VAL}`);
    assert.equal(ga.classify(ga.extractPresented(req)).class, null);
  });
});

test('HEADER CONFUSION: case-insensitive Bearer scheme is stripped correctly (bearer / BEARER / BeArEr)', async () => {
  await withEnv(ALL_THREE, (ga) => {
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const req = mockReq({ authorization: `${scheme} ${CAMP_VAL}` });
      assert.equal(ga.extractPresented(req), CAMP_VAL);
    }
  });
});

test('HEADER CONFUSION: repeated x-api-key header (Node comma-joins non-special headers) never accidentally equals a real secret', async () => {
  await withEnv(ALL_THREE, (ga) => {
    // Simulates what Node's http parser actually produces for a duplicated
    // x-api-key header: a single comma-joined string.
    const req = mockReq({ headersOverride: { 'x-api-key': `${CAMP_VAL}, somethingElse` } });
    assert.equal(ga.classify(ga.extractPresented(req)).class, null);
  });
});

test('HEADER CONFUSION: repeated ?api_key= query params (array-shaped by the query parser) never accidentally equals a real secret', async () => {
  await withEnv(ALL_THREE, (ga) => {
    const req = { method: 'GET', originalUrl: '/test', headers: {}, query: { api_key: [CAMP_VAL, 'second'] } };
    // extractPresented stringifies whatever req.query.api_key is -- for a
    // 2+-element array this joins with a comma, which must not coincide
    // with any configured secret.
    assert.equal(ga.classify(ga.extractPresented(req)).class, null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PHASE 4 — full N x M authorization matrix, independently constructed
// ══════════════════════════════════════════════════════════════════════

test('MATRIX: full cross-product of {secret,camp,transformer,unknown,missing} x {secret-only,camp-only,transformer-only,camp+transformer}', async () => {
  await withEnv(ALL_THREE, (ga) => {
    const policies = {
      'secret-only':        ga.authorize(['secret']),
      'camp-only':          ga.authorize(['camp']),
      'transformer-only':   ga.authorize(['transformer']),
      'camp+transformer':   ga.authorize(['camp', 'transformer']),
    };
    const presented = {
      secret: SECRET_VAL, camp: CAMP_VAL, transformer: XFORM_VAL,
      unknown: 'csk_totally_unconfigured_0000000000000000000000000000000000',
      missing: undefined,
    };
    // expected[policyName][presentedName] = true (allow) / false (deny)
    const expected = {
      'secret-only':      { secret: true,  camp: false, transformer: false, unknown: false, missing: false },
      'camp-only':        { secret: false, camp: true,  transformer: false, unknown: false, missing: false },
      'transformer-only': { secret: false, camp: false, transformer: true,  unknown: false, missing: false },
      'camp+transformer': { secret: false, camp: true,  transformer: true,  unknown: false, missing: false },
    };
    for (const [policyName, mw] of Object.entries(policies)) {
      for (const [presName, val] of Object.entries(presented)) {
        const req = mockReq(val === undefined ? {} : { authorization: `Bearer ${val}` });
        const { nextCalled } = run(mw, req);
        assert.equal(
          nextCalled, expected[policyName][presName],
          `policy=${policyName} presented=${presName} expected allow=${expected[policyName][presName]} got=${nextCalled}`
        );
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// PHASE 9 — duplicate-secret startup guard, full combination table
// ══════════════════════════════════════════════════════════════════════

test('STARTUP GUARD: full combination table (10 scenarios, synthetic values only)', async () => {
  const A = 'csk_A_0000000000000000000000000000000000000000000000000000';
  const B = 'csk_B_1111111111111111111111111111111111111111111111111111';
  const C = 'csk_C_2222222222222222222222222222222222222222222222222222';

  const scenarios = [
    { name: '1. all distinct',            env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: B, CS_TRANSFORMER_API_KEY: C }, ok: true },
    { name: '2. camp == transformer',     env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: B, CS_TRANSFORMER_API_KEY: B }, ok: false, reason: 'duplicate_secret_value' },
    { name: '3. camp == secret',          env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: A, CS_TRANSFORMER_API_KEY: C }, ok: false, reason: 'duplicate_secret_value' },
    { name: '4. transformer == secret',   env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: B, CS_TRANSFORMER_API_KEY: A }, ok: false, reason: 'duplicate_secret_value' },
    { name: '5. all three equal',         env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: A, CS_TRANSFORMER_API_KEY: A }, ok: false, reason: 'duplicate_secret_value' },
    { name: '6. one missing (distinct remaining two)', env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: B, CS_TRANSFORMER_API_KEY: undefined }, ok: true },
    { name: '7. two missing (one configured)',         env: { CAREERCAMP_SECRET_KEY: A, CAREERCAMP_API_KEY: undefined, CS_TRANSFORMER_API_KEY: undefined }, ok: true },
    { name: '8. all missing',             env: { CAREERCAMP_SECRET_KEY: undefined, CAREERCAMP_API_KEY: undefined, CS_TRANSFORMER_API_KEY: undefined }, ok: false, reason: 'no_credentials_configured' },
    { name: '9. empty strings (all three)', env: { CAREERCAMP_SECRET_KEY: '', CAREERCAMP_API_KEY: '', CS_TRANSFORMER_API_KEY: '' }, ok: false, reason: 'no_credentials_configured' },
    { name: '10. whitespace-only strings (all three)', env: { CAREERCAMP_SECRET_KEY: '   ', CAREERCAMP_API_KEY: '  ', CS_TRANSFORMER_API_KEY: ' ' }, ok: false, reason: 'no_credentials_configured' },
  ];

  for (const s of scenarios) {
    await withEnv(s.env, (ga) => {
      const result = ga.checkConfiguration();
      assert.equal(result.ok, s.ok, `${s.name}: expected ok=${s.ok}, got ${JSON.stringify(result)}`);
      if (!s.ok) assert.equal(result.reason, s.reason, s.name);
    });
  }
});

test('STARTUP GUARD: whitespace-only value used as a credential is never authorizable even if checkConfiguration treats it as "unconfigured"', async () => {
  // Scenario 10 above: whitespace-only values are trimmed to '' by
  // _loadConfigured and dropped -- confirm this also means NOTHING can
  // authenticate using that literal whitespace string.
  await withEnv({ CAREERCAMP_SECRET_KEY: '   ', CAREERCAMP_API_KEY: CAMP_VAL, CS_TRANSFORMER_API_KEY: XFORM_VAL }, (ga) => {
    const req = mockReq({ authorization: 'Bearer    ' }); // literal spaces as the "credential"
    assert.equal(ga.classify(ga.extractPresented(req)).class, null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PHASE 10 — partial configuration: one class fully undefined
// ══════════════════════════════════════════════════════════════════════

test('PARTIAL CONFIG: when CS_TRANSFORMER_API_KEY is unset, nothing can ever classify as transformer, and camp/secret are unaffected', async () => {
  await withEnv({ CAREERCAMP_SECRET_KEY: SECRET_VAL, CAREERCAMP_API_KEY: CAMP_VAL, CS_TRANSFORMER_API_KEY: undefined }, (ga) => {
    assert.deepEqual(ga.checkConfiguration(), { ok: true }); // 2 of 3 configured is a valid, non-ambiguous state
    assert.equal(ga.classify(XFORM_VAL).class, null); // the value nobody configured can't match anything
    assert.equal(ga.classify(SECRET_VAL).class, 'secret');
    assert.equal(ga.classify(CAMP_VAL).class, 'camp');
    // Critically: a route policy of ['camp','transformer'] (the real /v1/audio
    // policy) must still ONLY accept camp here -- transformer being unset
    // must not silently make camp "cover" for it via some fallback.
    const audioPolicy = ga.authorize(['camp', 'transformer']);
    assert.equal(run(audioPolicy, mockReq({ authorization: `Bearer ${CAMP_VAL}` })).nextCalled, true);
    assert.equal(run(audioPolicy, mockReq({ authorization: `Bearer ${XFORM_VAL}` })).nextCalled, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PHASE 12 — privileged-route policy sanity (the 10 routes assigned 'secret'-only)
// ══════════════════════════════════════════════════════════════════════

test("PRIVILEGED ROUTES: the 'secret'-only policy used for /v1/infer,/v1/features,/v1/tools,/v1/memory,/v1/developer,/v1/camp,/v1/gpu-status,/v1/perf,/metrics,/v1/agent rejects both camp and transformer", async () => {
  await withEnv(ALL_THREE, (ga) => {
    const privileged = ga.authorize(['secret']);
    assert.equal(run(privileged, mockReq({ authorization: `Bearer ${CAMP_VAL}` })).nextCalled, false);
    assert.equal(run(privileged, mockReq({ authorization: `Bearer ${XFORM_VAL}` })).nextCalled, false);
    assert.equal(run(privileged, mockReq({ authorization: `Bearer ${SECRET_VAL}` })).nextCalled, true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PHASE 13 — REAL log-exposure proof-of-concept (not a mock -- a live
// Express + morgan pipeline matching server.js's actual global middleware
// order, minus the GPU/engine boot).
// ══════════════════════════════════════════════════════════════════════

test('LOGGING PoC: the legacy ?api_key= query transport writes the raw credential into morgan(\'combined\') request logs', async () => {
  const express = require('express');
  const morgan = require('morgan');
  await withEnv(ALL_THREE, async (ga) => {
    const app = express();
    const logLines = [];
    // Same format token server.js uses ('combined'), writing to an
    // in-memory sink instead of stdout so the test can inspect it directly.
    app.use(morgan('combined', { stream: { write: (line) => logLines.push(line) } }));
    app.get('/v1/search', ga.authorize(['camp']), (req, res) => res.json({ ok: true }));

    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;

    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/v1/search?q=hello&api_key=${CAMP_VAL}`, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });

    await new Promise((resolve) => server.close(resolve));

    assert.equal(logLines.length, 1);
    // THE FINDING: the raw credential value is present verbatim in the
    // gateway's own request log line, because morgan('combined')'s :url
    // token logs req.originalUrl (which includes the query string), and
    // the ?api_key= transport puts the credential directly in that URL.
    // This is not introduced by 4ee4d71 (the query transport pre-dates it
    // and was preserved for backward compatibility), but 4ee4d71 did not
    // address it either, despite the task's own Phase 12 explicitly
    // requiring gateway logs never contain "query credential". This test
    // ALSO proves the request authenticated successfully (the credential
    // was live/valid at request time) -- the exposure happens on a real,
    // successful, authorized request, not just a failed one.
    assert.ok(
      logLines[0].includes(CAMP_VAL),
      `expected the credential to appear in the log line (demonstrating the exposure), got: ${logLines[0]}`
    );
  });
});

test('LOGGING PoC (control): the Authorization/x-api-key transports do NOT appear in morgan(\'combined\') logs', async () => {
  const express = require('express');
  const morgan = require('morgan');
  await withEnv(ALL_THREE, async (ga) => {
    const app = express();
    const logLines = [];
    app.use(morgan('combined', { stream: { write: (line) => logLines.push(line) } }));
    app.get('/v1/search', ga.authorize(['camp']), (req, res) => res.json({ ok: true }));

    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const port = server.address().port;

    await new Promise((resolve, reject) => {
      const reqOpts = { host: '127.0.0.1', port, path: '/v1/search?q=hello', headers: { 'x-api-key': CAMP_VAL } };
      http.get(reqOpts, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });

    await new Promise((resolve) => server.close(resolve));

    assert.equal(logLines.length, 1);
    assert.ok(!logLines[0].includes(CAMP_VAL), 'the header-based transport must never appear in the request log (combined format does not log custom headers)');
  });
});
