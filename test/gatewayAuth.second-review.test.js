'use strict';
// Second independent review of abdb4fc. Synthetic credentials only; no dotenv,
// engine boot, upstream access, persistent memory operations, or production edits.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { build, serve } = require('./gatewayAuth.codex-harness.cjs');
const keys = {
  secret: 'second_review_SYNTHETIC_secret_73e9216c',
  camp: 'second_review_SYNTHETIC_camp_682df913',
  transformer: 'second_review_SYNTHETIC_transformer_194acf72',
};
const names = { secret: 'CAREERCAMP_SECRET_KEY', camp: 'CAREERCAMP_API_KEY', transformer: 'CS_TRANSFORMER_API_KEY' };
const configuration = Object.fromEntries(Object.entries(names).map(([cls, name]) => [name, keys[cls]]));
function clean(logs, value) {
  const raw = JSON.stringify(logs);
  const captured = raw + raw.replace(/%([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const material of [value, encodeURIComponent(value), value.slice(-8)]) {
    assert.equal(captured.includes(material), false, 'captured logs disclose synthetic credential material');
  }
}

test('R2 regression: percent-encoded credential name must not disclose an authenticated key', async () => {
  const h = build(configuration);
  await serve(h, async request => {
    const result = await request('GET', '/v1/models?%61pi_key=' + keys.secret);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).credentialClass, 'secret');
    clean(h.logs, keys.secret);
  });
});

// Explicit inventory independent of the old tests' route-generation logic.
const families = [
  ['core', ['GET /v1/models', 'GET /v1/models/careerlm-nano', 'POST /v1/chat/completions', 'POST /v1/embeddings']],
  ['camp', ['POST /api/show', 'POST /v1/images/analyze', 'POST /v1/images/video-frames', 'POST /v1/vision/analyze', 'POST /v1/bert/skills', 'GET /v1/bert/tasks', 'GET /v1/search']],
  ['audio', ['POST /v1/audio/transcriptions', 'POST /v1/audio/speech', 'POST /v1/audio/interview-analyze']],
  ['internal', ['POST /v1/agent/run', 'POST /v1/infer', 'GET /v1/features/review', 'POST /v1/features/review',
    'POST /v1/tools/review', 'POST /v1/tools/review/compare', 'GET /v1/memory/review', 'POST /v1/memory/review',
    'DELETE /v1/memory/review', 'POST /v1/memory/review/extract', 'GET /v1/developer/health', 'GET /v1/developer/status',
    'GET /v1/developer/metrics', 'POST /v1/developer/ping/careerlm-nano', 'GET /v1/developer/task-models',
    'GET /v1/developer/docs', 'GET /v1/camp/review', 'POST /v1/camp/review', 'GET /v1/camp',
    'GET /v1/gpu-status', 'GET /v1/perf', 'GET /metrics']],
];
const allowed = { core: ['secret', 'camp'], camp: ['camp'], audio: ['camp', 'transformer'], internal: ['secret'] };
for (const [policy, endpoints] of families) test(`R2 complete real-router matrix: ${policy}`, async () => {
  await serve(build(configuration), async request => {
    for (const endpoint of endpoints) {
      const [method, url] = endpoint.split(' ');
      for (const cls of ['secret', 'camp', 'transformer', 'unknown', 'missing']) {
        const key = keys[cls] || (cls === 'unknown' ? 'second_review_SYNTHETIC_unknown_d921ea73' : '');
        for (const transport of ['Authorization', 'x-api-key', 'query']) {
          const headers = key && transport !== 'query' ? { [transport]: transport === 'Authorization' ? `Bearer ${key}` : key } : {};
          const target = transport === 'query' && key ? `${url}?api_key=${key}` : url;
          const r = await request(method, target, headers);
          const expected = allowed[policy].includes(cls) ? 200 : keys[cls] ? 403 : 401;
          assert.equal(r.status, expected, `${endpoint} ${cls} ${transport}`);
          if (expected === 200) assert.equal(JSON.parse(r.body).credentialClass, cls);
          else assert.ok(!r.body.includes('"reached":true'));
          if (key) clean(r.body, key);
        }
      }
    }
  });
});

const encodeAll = text => [...text].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
// Three entries below (empty-bracket, numeric-bracket, encoded-brackets)
// were changed 2026-09-15 (second review remediation) from 200 to 401:
// production behavior was deliberately made MORE restrictive. All three
// are array-shaped query values (`?api_key[]=x` / `?api_key[0]=x` parse to
// req.query.api_key = ['x']); the previous fix salvaged single-element
// arrays via String(['x']) === 'x', but no confirmed CareerStudioMax
// caller sends repeated/bracketed ?api_key= query parameters at all, so
// there is no compatibility reason to keep that carve-out, and rejecting
// every array shape uniformly (rather than trying to distinguish "safe"
// single-element arrays from unsafe ones) is what closes the
// api_key[0][toString] coercion class of bug below. Every other
// expectation here (encoded NAME variants still authenticate; encoded
// VALUE content is unaffected; genuinely nested/object shapes were already
// 401) is unchanged.
const urlCases = [
  ['plain', k => `api_key=${k}`, 200],
  ['surrounding-parameters', k => `before=1&api_key=${k}&after=2`, 200],
  ['repeated', k => `api_key=${k}&api_key=${k}`, 401],
  ['empty-bracket', k => `api_key[]=${k}`, 401],
  ['numeric-bracket', k => `api_key[0]=${k}`, 401],
  ['object-bracket', k => `api_key[toString]=${k}`, 401],
  ['encoded-first-letter', k => `%61pi_key=${k}`, 200],
  ['encoded-underscore', k => `api%5fkey=${k}`, 200],
  ['encoded-entire-name', k => `${encodeAll('api_key')}=${k}`, 200],
  ['encoded-brackets', k => `api_key%5B0%5D=${k}`, 401],
  ['nested-brackets', k => `api_key[a][b]=${k}`, 401],
  ['encoded-nested-brackets', k => `api_key%5Ba%5D%5Bb%5D=${k}`, 401],
  ['case-variation', k => `API_KEY=${k}`, 401],
  ['encoded-value', k => `api_key=${encodeAll(k)}`, 200],
  ['encoded-name-and-value', k => `%61pi_key=${encodeAll(k)}`, 200],
];
for (const [label, query] of urlCases) test(`R2 redactUrl regression: ${label}`, () => {
  const h = build(configuration);
  clean(h.ga.redactUrl('/v1/models?' + query(keys.secret)), keys.secret);
});
for (const [label, query, expected] of urlCases) test(`R2 actual logging regression: ${label}`, async () => {
  const h = build(configuration);
  await serve(h, async request => {
    const r = await request('GET', '/v1/models?' + query(keys.secret));
    assert.equal(r.status, expected);
    assert.equal(h.logs.access.length, 1);
    clean([h.logs, r.body], keys.secret);
  });
});

for (const [label, route, queryKey, headers, expected] of [
  ['unknown-401', '/v1/models', 'second_review_SYNTHETIC_unknown_2da82941', {}, 401],
  ['wrong-purpose-403', '/v1/models', keys.transformer, {}, 403],
  ['conflict-401', '/v1/models', keys.secret, { Authorization: 'Bearer unknown' }, 401],
  ['not-found-404', '/no-such-route', keys.secret, {}, 404],
  // Changed 2026-09-15 (second review remediation) from 500 to 401:
  // production behavior was deliberately fixed, not weakened. extractPresented()
  // now rejects any non-string query shape (array or object, at any nesting
  // depth) outright rather than calling String() on it -- an array element
  // that is itself an object with a shadowed toString property (exactly
  // this case: api_key[0][toString] parses to [{toString:queryKey}]) can no
  // longer reach Array.prototype.toString/join()'s internal per-element
  // coercion at all, so this is now a normal, safe 401 rejection, not a
  // crash. The "establish real pipeline outcome" + log-safety assertions
  // below are otherwise unchanged and still apply.
  ['structured-error-500', '/v1/models', keys.secret, {}, 401],
]) test(`R2 encoded query disclosure regression: ${label}`, async () => {
  const h = build(configuration);
  await serve(h, async request => {
    const query = label === 'structured-error-500' ? `api_key[0][toString]=${queryKey}` : `%61pi_key=${queryKey}`;
    const r = await request('GET', route + '?' + query, headers);
    assert.equal(r.status, expected, 'establish real pipeline outcome before checking logs');
    clean([h.logs, r.body], queryKey);
  });
});

test('R2 regression: Referer query credential must not appear in Morgan combined log', async () => {
  const h = build(configuration);
  await serve(h, async request => {
    const r = await request('GET', '/v1/models', { Authorization: `Bearer ${keys.secret}`, Referer: `https://synthetic.invalid/v1/models?api_key=${keys.secret}` });
    assert.equal(r.status, 200);
    clean(h.logs, keys.secret);
  });
});

for (const query of ['api_key[toString]=x', 'api_key[]=x', 'api_key=x&api_key=y', 'api_key[a][b]=x',
  'api_key[0][toString]=x', 'api_key[][toString]=x', 'api_key%5B0%5D%5BtoString%5D=x',
  'api_key[0][valueOf]=x&api_key[0][toString]=x', 'api_key=', 'api_key=%20%20']) {
  test(`R2 malformed query regression: ${query}`, async () => {
    await serve(build(configuration), async request => assert.equal((await request('GET', '/v1/models?' + query)).status, 401));
  });
}

test('R2 reserved characters in query credentials remain usable and fully redacted', async () => {
  const key = 'second_review_SYNTHETIC_+&=%?#/[]_f241a763';
  const h = build({ ...configuration, CAREERCAMP_SECRET_KEY: key });
  await serve(h, async request => {
    const r = await request('GET', '/v1/models?api_key=' + encodeURIComponent(key));
    assert.equal(r.status, 200);
    clean(h.logs, key);
  });
});

test('R2 deterministic conflicts on formerly double-guarded endpoint', async () => {
  const h = build(configuration);
  await serve(h, async request => {
    const url = '/v1/features/review';
    for (const [auth, query, header, status, cls] of [
      [keys.transformer, '', keys.secret, 403], [keys.secret, '', keys.transformer, 200, 'secret'],
      ['unknown', keys.secret, '', 401], [keys.camp, '', keys.secret, 403],
      ['', keys.secret, keys.transformer, 200, 'secret'], ['', keys.transformer, keys.secret, 403],
      [keys.secret, keys.secret, keys.secret, 200, 'secret'],
    ]) {
      const headers = { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(header ? { 'x-api-key': header } : {}) };
      const r = await request('GET', url + (query ? '?api_key=' + query : ''), headers);
      assert.equal(r.status, status);
      if (cls) assert.equal(JSON.parse(r.body).credentialClass, cls);
    }
    for (const key of Object.values(keys)) clean(h.logs, key);
  });
});

test('R2 models actual handlers: known models list/detail, bad keys, unknown model, methods', async () => {
  const h = build(configuration);
  // Replace ONLY the already-reviewed test sentinel router with the original
  // side-effect-free models router; retain actual server mount and auth layers.
  const layer = h.app._router.stack.find(l => l.handle && l.handle.stack && l.handle.stack.some(s => s.route && s.route.path === '/:model'));
  assert.ok(layer);
  layer.handle = require('../api/models');
  await serve(h, async request => {
    for (const cls of ['secret', 'camp', 'transformer', 'missing', 'malformed']) {
      const headers = cls === 'missing' ? {} : { 'x-api-key': keys[cls] || 'x'.repeat(513) };
      for (const p of ['/v1/models', '/v1/models/careerlm-nano']) {
        const r = await request('GET', p, headers);
        const expected = ['secret', 'camp'].includes(cls) ? 200 : cls === 'transformer' ? 403 : 401;
        assert.equal(r.status, expected);
        if (expected === 200) {
          const data = JSON.parse(r.body);
          if (p.endsWith('careerlm-nano')) assert.equal(data.id, 'careerlm-nano');
          else assert.ok(data.data.some(m => m.id === 'careerlm-nano'));
        }
      }
    }
    assert.equal((await request('GET', '/v1/models/not-a-model', { 'x-api-key': keys.camp })).status, 404);
    assert.equal((await request('HEAD', '/v1/models', { 'x-api-key': keys.secret })).status, 200);
    assert.equal((await request('POST', '/v1/models')).status, 401);
    assert.equal((await request('POST', '/v1/models', { 'x-api-key': keys.secret })).status, 404);
  });
});

test('R2 length boundaries and configuration diagnostics are consistent and secret-free', async () => {
  const key512 = 'second_review_SYNTHETIC_'.padEnd(512, 'a');
  assert.equal(key512.length, 512);
  assert.throws(() => build({ CAREERCAMP_SECRET_KEY: key512 + 'x' }), e => e.exitCode === 1 && !e.stack.includes(key512));
  const h = build({ CAREERCAMP_SECRET_KEY: key512 });
  await serve(h, async request => {
    for (const [key, expected] of [[key512, 200], ['b'.repeat(512), 401], [key512 + 'x', 401], ['c'.repeat(10000), 401]]) {
      assert.equal((await request('GET', '/v1/models', { 'x-api-key': key })).status, expected);
    }
    clean(h.logs, key512);
  });
});

test('R2 equivalent legacy checks are absent and memory resource validation remains', () => {
  for (const file of ['inference', 'features', 'tools', 'memory', 'developer', 'camp']) {
    const source = fs.readFileSync(path.join(__dirname, '../routes', file + '.js'), 'utf8');
    // Ignore explanatory comments, inspect remaining executable auth references.
    const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    assert.ok(!/req\.headers|req\.query\.api_key|process\.env\.(CAREERCAMP_(?:SECRET|API)_KEY|CS_TRANSFORMER_API_KEY)|apiKeyGuard/.test(code), file);
    if (file === 'memory') assert.equal((code.match(/requireUserId, async/g) || []).length, 4);
  }
});

test('R2 header credentials stay out of success, auth, and 404 logs', async () => {
  const h = build(configuration);
  await serve(h, async request => {
    for (const route of ['/v1/models', '/v1/search', '/missing']) for (const cls of Object.keys(keys)) for (const header of ['Authorization', 'x-api-key']) {
      const r = await request('GET', route, { [header]: header === 'Authorization' ? `Bearer ${keys[cls]}` : keys[cls] });
      clean([h.logs, r.body], keys[cls]);
    }
  });
});

test('R2 duplicate normalization and partial configuration preserve every class boundary', async () => {
  for (const [a, b] of [['secret', 'camp'], ['camp', 'transformer'], ['secret', 'transformer']]) {
    for (const padding of ['', ' \t']) assert.throws(() => build({ ...configuration, [names[b]]: padding + keys[a] + padding }), e => e.exitCode === 1);
  }
  assert.throws(() => build(Object.fromEntries(Object.values(names).map(n => [n, keys.secret]))), e => e.exitCode === 1);
  assert.throws(() => build({}), e => e.exitCode === 1);
  for (let mask = 1; mask <= 7; mask++) {
    const env = Object.fromEntries(Object.entries(configuration).filter((_v, index) => mask & (1 << index)));
    await serve(build(env), async request => {
      for (const [policy, endpoints] of families) for (const cls of Object.keys(keys)) {
        const [method, route] = endpoints[0].split(' ');
        const expected = !env[names[cls]] ? 401 : allowed[policy].includes(cls) ? 200 : 403;
        assert.equal((await request(method, route, { 'x-api-key': keys[cls] })).status, expected, `${mask} ${policy} ${cls}`);
      }
    });
  }
});

test('R2 dormant cstm2Infer selects the camp gateway but an unrelated CSTM2 key is rejected', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../cs_fixed/services/camp-client.js'), 'utf8');
  const start = source.indexOf('async function cstm2Infer(');
  const end = source.indexOf('// ── Error helper', start);
  assert.ok(start > 0 && end > start);
  for (const cstmKey of ['second_review_SYNTHETIC_cstm2_02a198e7', undefined, keys.secret]) {
    const calls = [], module = { exports: {} };
    class FakeOpenAI {
      constructor(options) {
        calls.push(options);
        this.chat = { completions: { create: async () => ({ choices: [{ message: { content: 'synthetic response' } }] }) } };
      }
    }
    vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = cstm2Infer;', {
      module, process: { env: cstmKey ? { CSTM2_API_KEY: cstmKey } : {} },
      pool: { pickBackend: () => ({ name: 'synthetic', campBaseUrl: 'http://synthetic.invalid/v1', campApiKey: keys.camp }) },
      isLikelyDown: () => false, _logError: () => assert.fail('unexpected synthetic call failure'),
      require: id => { assert.equal(id, 'openai'); return { default: FakeOpenAI }; },
    });
    await module.exports('synthetic prompt', 'synthetic system');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].baseURL, 'http://synthetic.invalid/v1');
    assert.equal(calls[0].apiKey, cstmKey || keys.camp);
    await serve(build(configuration), async request => {
      const r = await request('POST', '/v1/chat/completions', { Authorization: `Bearer ${calls[0].apiKey}` });
      assert.equal(r.status, cstmKey && cstmKey !== keys.secret ? 401 : 200);
    });
  }
});

test('R2 regression: array containing an object with a non-callable toString must return 401', async () => {
  const h = build(configuration);
  await serve(h, async request => {
    const result = await request('GET', '/v1/models?api_key[0][toString]=synthetic');
    assert.equal(result.status, 401);
  });
});
