'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { build, serve, values, fullEnv, envNames } = require('./gatewayAuth.codex-harness.cjs');
const policies = { core: ['secret', 'camp'], camp: ['camp'], audio: ['camp', 'transformer'], internal: ['secret'] };
const mounts = {
  '/api/show': 'camp', '/v1/models': 'core', '/v1/chat/completions': 'core', '/v1/embeddings': 'core',
  '/v1/images': 'camp', '/v1/audio': 'audio', '/v1/bert': 'camp', '/v1/agent': 'internal', '/v1/search': 'camp',
  '/v1/infer': 'internal', '/v1/features': 'internal', '/v1/tools': 'internal', '/v1/memory': 'internal',
  '/v1/developer': 'internal', '/v1/camp': 'internal', '/v1/gpu-status': 'internal', '/v1/perf': 'internal',
  '/metrics': 'internal', '/v1/vision/analyze': 'camp',
};
const concrete = p => p.replace(':model', 'careerlm-nano').replace(/:[^/]+/g, 'review_fixture');
const inventory = build().inventory;
const protectedRoutes = inventory.filter(r => mounts[r.mount]);
const transports = ['bearer', 'header', 'query'];
function present(p, cls, transport) {
  const v = values[cls] || (cls === 'unknown' ? 'codex_unknown_fixture' : undefined);
  if (!v) return [p, {}];
  if (transport === 'query') return [p + (p.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(v), {}];
  return [p, transport === 'bearer' ? { Authorization: `Bearer ${v}` } : { 'x-api-key': v }];
}

test('source inventory includes every mounted family and exactly three public GET paths', () => {
  assert.deepEqual([...new Set(protectedRoutes.map(r => r.mount))].sort(), Object.keys(mounts).sort());
  assert.deepEqual(inventory.filter(r => !mounts[r.mount]).map(r => r.path).sort(), ['/', '/health', '/v1']);
});

test('DENY matrix: every protected source route x all disallowed classes x three transports', async () => {
  await serve(build(), async request => {
    for (const r of protectedRoutes) for (const cls of ['secret', 'camp', 'transformer', 'unknown', 'missing']) {
      if (policies[mounts[r.mount]].includes(cls)) continue;
      for (const transport of transports) {
        const response = await request(r.method, ...present(concrete(r.path), cls, transport));
        // Fixed 2026-09-15 (CS-1 gateway auth review Priority 3): /v1/models
        // is now mounted with app.use() instead of an exact app.get(), so
        // /v1/models/:model is reachable through the parent mount like every
        // other prefix-mounted route -- no special-case 404 carve-out needed
        // any more; a disallowed credential there now correctly denies with
        // the same 403/401 logic as everywhere else.
        const expected = values[cls] ? 403 : 401;
        assert.equal(response.status, expected, `${r.method} ${r.path} ${cls} ${transport}`);
      }
    }
  });
});

for (const r of protectedRoutes) test(`ALLOW regression: ${r.method} ${r.path}`, async () => {
  await serve(build(), async request => {
    const failures = [];
    for (const cls of policies[mounts[r.mount]]) for (const transport of transports) {
      const response = await request(r.method, ...present(concrete(r.path), cls, transport));
      if (response.status !== 200) failures.push(`${cls}/${transport}: ${response.status}`);
      else assert.equal(JSON.parse(response.body).reached, true);
    }
    assert.deepEqual(failures, [], 'all allowed classes/transports must reach the authorized handler');
  });
});

test('methods: all seven methods on every protected source path cannot reach a handler without auth', async () => {
  await serve(build(), async request => {
    for (const r of protectedRoutes) for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      const response = await request(method, concrete(r.path));
      if (method === 'OPTIONS') assert.equal(response.status, 204, 'global CORS answers preflight without functionality');
      else assert.ok([401, 404].includes(response.status), `${method} ${r.path}: ${response.status}`);
      assert.ok(!response.body.includes('"reached":true'));
    }
  });
});

test('path variants: trailing/repeated slashes, case, encoded literals/slashes, query and prefix boundaries', async () => {
  await serve(build(), async request => {
    for (const r of protectedRoutes) {
      const p = concrete(r.path);
      const paths = [p + '/', p.toUpperCase(), p.replace(/\//g, '//'), p.replace(/\//, '/%2f'), p.replace('v1', '%761'), p + '?x=1', r.mount + 'extra', p.replace(/\//g, '%2F'), p + '/%2e%2e'];
      for (const candidate of paths) {
        const denied = await request(r.method, candidate.startsWith('/') ? candidate : '/' + candidate);
        assert.ok([401, 404].includes(denied.status), `${r.method} ${candidate}: ${denied.status}`);
        assert.ok(!denied.body.includes('"reached":true'));
      }
    }
    // Positive controls: routing variations really can reach the same route.
    for (const p of ['/V1/AUDIO/TRANSCRIPTIONS', '/v1/audio/transcriptions/', '/v1/audio//transcriptions', '/v1/audio/transcriptions?x=1']) {
      assert.equal((await request('POST', p, { 'x-api-key': values.transformer })).status, 200, p);
    }
  });
});

test('real Node header parsing and complete conflict precedence', async () => {
  await serve(build(), async request => {
    const p = '/v1/search';
    const cases = [
      [{ Authorization: `Bearer ${values.camp}` }, p, 200],
      [{ Authorization: `bEaReR\t${values.camp}` }, p, 200],
      [{ Authorization: values.camp }, p, 200],
      [{ Authorization: `Bearer${values.camp}` }, p, 401],
      [{ Authorization: `Basic ${values.camp}` }, p, 401],
      [{ Authorization: 'Bearer ', 'x-api-key': values.camp }, p, 401],
      [{ Authorization: '   ', 'x-api-key': values.camp }, p, 200],
      [{ Authorization: `Bearer ${values.transformer}`, 'x-api-key': values.camp }, p, 403],
      [{ Authorization: 'Bearer unknown', 'x-api-key': values.camp }, p, 401],
      [{ Authorization: `Bearer ${values.camp}`, 'x-api-key': values.transformer }, p + '?api_key=unknown', 200],
      [{ 'x-api-key': values.camp }, p + '?api_key=' + values.transformer, 403],
      [{ 'x-api-key': values.camp }, p + '?api_key=unknown', 401],
      [{ 'x-api-key': values.camp }, p + '?api_key=', 200],
      [{ 'X-API-KEY': values.camp }, p, 200],
      [{ 'x-api-key': [values.camp, values.camp] }, p, 401],
      [{ Authorization: [`Bearer ${values.transformer}`, `Bearer ${values.camp}`] }, p, 403],
      [{ Authorization: [`Bearer ${values.camp}`, `Bearer ${values.transformer}`] }, p, 200],
      [{}, p + '?api_key=' + values.camp + '&api_key=' + values.transformer, 401],
      // Changed 2026-09-15 (second review remediation): production behavior
      // deliberately made MORE restrictive -- a single-element query array
      // (`?api_key[]=x`) used to be salvaged via String([x]) === 'x' and
      // authenticate normally. It is now rejected outright as malformed,
      // along with every other array/object query shape, since no
      // confirmed CareerStudioMax caller sends repeated or bracketed
      // ?api_key= query parameters at all (every real caller uses
      // Authorization or x-api-key) and inspecting array elements is
      // exactly what the previous fix got wrong (see the
      // api_key[0][toString] regressions below).
      [{}, p + '?api_key[]=' + values.camp, 401],
      [{ 'x-api-key': 'x'.repeat(10000) }, p, 401],
      [{ 'x-api-key': 'x'.repeat(20000) }, p, 431],
    ];
    for (const [headers, url, expected] of cases) assert.equal((await request('GET', url, headers)).status, expected, `case ${cases.findIndex(c => c[0] === headers)}`);
  });
});

test('two credential gates: secret Bearer alone rejects, adding transformer x-api-key reaches real inner guard', async () => {
  await serve(build(), async request => {
    for (const route of protectedRoutes.filter(r => r.innerGuard)) {
      const p = concrete(route.path);
      assert.equal((await request(route.method, p, { Authorization: `Bearer ${values.secret}` })).status, 401, p);
      assert.equal((await request(route.method, p, { Authorization: `Bearer ${values.secret}`, 'x-api-key': values.transformer })).status, 200, p);
      assert.equal((await request(route.method, p, { Authorization: `Bearer ${values.transformer}`, 'x-api-key': values.secret })).status, 403, p);
      assert.equal((await request(route.method, p, { 'x-api-key': values.transformer })).status, 403, p);
    }
  });
});

test('startup executes refusal for every duplicate pair, trimmed duplicate and all blank configurations', () => {
  for (const [a, b] of [['secret', 'camp'], ['secret', 'transformer'], ['camp', 'transformer']]) {
    const env = { ...fullEnv, [envNames[b]]: values[a] };
    assert.throws(() => build(env), e => e.exitCode === 1);
    env[envNames[b]] = '  ' + values[a] + '  ';
    assert.throws(() => build(env), e => e.exitCode === 1);
  }
  for (const env of [{}, Object.fromEntries(Object.values(envNames).map(n => [n, ''])), Object.fromEntries(Object.values(envNames).map(n => [n, '  '])), Object.fromEntries(Object.values(envNames).map(n => [n, 'same']))]) assert.throws(() => build(env), e => e.exitCode === 1);
  assert.doesNotThrow(() => build(fullEnv));
});

test('all six partial configurations: no missing class inherits authorization', async () => {
  for (let mask = 1; mask < 7; mask++) {
    const env = Object.fromEntries(Object.entries(fullEnv).filter((_v, i) => mask & (1 << i)));
    const h = build(env);
    for (const [cls, key] of Object.entries(values)) assert.equal(h.ga.identify(key), env[envNames[cls]] ? cls : null);
    await serve(h, async request => {
      for (const [p, policy] of Object.entries(mounts)) for (const cls of Object.keys(values)) {
        if (env[envNames[cls]] && policies[policy].includes(cls)) continue;
        const r = await request(p === '/api/show' || p === '/v1/vision/analyze' ? 'POST' : 'GET', p, { 'x-api-key': values[cls] });
        assert.ok([401, 403].includes(r.status), `${mask} ${cls} ${p}`);
      }
    });
  }
});

test('regression: startup rejects credentials longer than the classifier can accept', () => {
  assert.throws(() => build({ CAREERCAMP_SECRET_KEY: 'x'.repeat(513) }), e => e.exitCode === 1);
});

test('comparison construction: fixed digest size, type guards, fresh random module key and input bounds', () => {
  const source = fs.readFileSync(path.join(__dirname, '../core/gatewayAuth.js'), 'utf8');
  const keys = [], comparisons = [];
  function load() {
    const module = { exports: {} };
    vm.runInNewContext(source + '\nmodule.exports.reviewSafeEqual = _safeEqual;', {
      module, process: { env: fullEnv }, console: { warn() {} },
      require: () => ({ ...crypto, randomBytes: n => { const k = crypto.randomBytes(n); keys.push(k); return k; }, timingSafeEqual: (a, b) => { comparisons.push([a.length, b.length]); return crypto.timingSafeEqual(a, b); } }),
    });
    return module.exports;
  }
  const a = load(), b = load();
  assert.equal(keys.length, 2);
  assert.equal(keys[0].length, 32);
  assert.ok(!keys[0].equals(keys[1]));
  for (const weird of [undefined, null, {}, [], 3, true, Symbol('synthetic'), Buffer.from('x'), '']) assert.equal(a.reviewSafeEqual(weird, 'x'), false);
  assert.equal(a.reviewSafeEqual('a', 'a'.repeat(10000)), false);
  assert.equal(a.reviewSafeEqual(values.secret, values.secret), true);
  assert.ok(comparisons.every(([x, y]) => x === 32 && y === 32));
  const count = comparisons.length;
  assert.equal(a.classify('x'.repeat(10000)).reason, 'malformed_credential');
  assert.equal(comparisons.length, count);
  assert.equal(b.identify(values.secret), 'secret');
});

for (const kind of ['401', '403', 'ignored-query']) test(`regression: auth warning excludes query credential (${kind})`, async () => {
  const h = build();
  await serve(h, async request => {
    const key = kind === '401' ? 'codex_unrecognized_query_fixture' : values.secret;
    const headers = kind === 'ignored-query' ? { Authorization: 'Bearer unknown' } : {};
    const r = await request('GET', '/v1/search?api_key=' + key, headers);
    assert.equal(r.status, kind === '403' ? 403 : 401);
    assert.ok(!h.logs.warn.join('\n').includes(key), 'authentication warnings must not contain the query credential');
  });
});

test('regression: successful query authentication excludes credentials from access logs', async () => {
  const h = build();
  await serve(h, async request => {
    assert.equal((await request('GET', '/v1/search?api_key=' + values.camp)).status, 200);
    assert.ok(!h.logs.access.join('\n').includes(values.camp), 'access logs must not contain credentials');
  });
});

test('header failure logs/responses never include key, prefix, suffix or hash', async () => {
  const h = build();
  await serve(h, async request => {
    for (const cls of ['secret', 'transformer']) for (const transport of ['bearer', 'header']) {
      const r = await request('GET', ...present('/v1/search', cls, transport));
      assert.equal(r.status, 403);
      const captured = JSON.stringify(h.logs) + r.body;
      const key = values[cls];
      for (const material of [key, key.slice(0, 12), key.slice(-8), crypto.createHash('sha256').update(key).digest('hex')]) assert.ok(!captured.includes(material));
    }
    // Fixed 2026-09-15 (CS-1 gateway auth review Priority 4): a structured
    // query value used to reach String() unguarded and throw, producing a
    // generic 500 via the server's error handler. extractPresented() now
    // only stringifies string/array query values -- a bracket-object value
    // like this is treated as though no query credential were presented,
    // so this is a normal auth rejection (401), never a 500.
    const r = await request('GET', '/v1/search?api_key[toString]=synthetic');
    assert.equal(r.status, 401);
    assert.ok(!JSON.stringify([...h.logs.error, ...h.logs.warn]).includes('api_key[toString]'), 'no trace of the structured query key reaches error or auth logs');
  });
});

test('regression: structured query credential is rejected as authentication failure rather than 500', async () => {
  await serve(build(), async request => {
    const r = await request('GET', '/v1/search?api_key[toString]=synthetic');
    assert.equal(r.status, 401);
  });
});

test('public GET and HEAD handlers remain public; developer health is protected', async () => {
  await serve(build(), async request => {
    for (const p of ['/', '/health', '/v1']) for (const method of ['GET', 'HEAD']) assert.equal((await request(method, p)).status, 200);
    assert.equal((await request('GET', '/v1/developer/health')).status, 401);
  });
});

test('cs_fixed source: models consumer selects secret with all three synthetic classes configured', async () => {
  const module = { exports: {} }, calls = [];
  const source = fs.readFileSync(path.join(__dirname, '../../cs_fixed/config/aiEnvironment.js'), 'utf8');
  vm.runInNewContext(source, {
    module, process: { env: { ...fullEnv, CAREERCAMP_BASE_URL: 'http://synthetic.invalid/v1' } },
    require: id => { assert.equal(id, 'axios'); return { get: async (url, options) => { calls.push({ url, options }); return { data: { data: [] } }; } }; },
  });
  await module.exports.getAvailableModels();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://synthetic.invalid/v1/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${values.secret}`);
});

test('cs_fixed source: chat/embedding pool uses camp normally and secret as a configured fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../cs_fixed/services/inferencePool.js'), 'utf8');
  for (const useCamp of [true, false]) {
    const env = { ...fullEnv };
    if (!useCamp) delete env.CAREERCAMP_API_KEY;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, process: { env } });
    assert.equal(module.exports.listBackends()[0].campApiKey, useCamp ? values.camp : values.secret);
  }
});
