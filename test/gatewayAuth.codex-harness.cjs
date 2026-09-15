'use strict';
// Review-only loader. Executes the actual server registrations, real Express,
// real routers/guards and real gatewayAuth with an isolated synthetic env.
// No dotenv, engine boot, network upstreams, storage, or production handlers.
// Router terminal handlers become sentinels; all preceding guards remain.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const morgan = require('morgan');
const root = path.resolve(__dirname, '..');
const values = { secret: 'codex_synthetic_secret_7d09', camp: 'codex_synthetic_camp_e162', transformer: 'codex_synthetic_transformer_82af' };
const envNames = { secret: 'CAREERCAMP_SECRET_KEY', camp: 'CAREERCAMP_API_KEY', transformer: 'CS_TRANSFORMER_API_KEY' };
const fullEnv = Object.fromEntries(Object.entries(envNames).map(([k, v]) => [v, values[k]]));

function build(env = fullEnv) {
  const logs = { warn: [], error: [], access: [], info: [] };
  const output = { warn: (...a) => logs.warn.push(a.join(' ')), error: (...a) => logs.error.push(a.join(' ')), log: (...a) => logs.info.push(a.join(' ')) };
  const processStub = { env: { ...env }, uptime: () => 123, exit: code => { throw Object.assign(new Error('synthetic startup exit'), { exitCode: code }); } };
  const cache = new Map();
  const mounts = [];
  let app;
  const sentinel = (req, res) => res.json({ reached: true, credentialClass: req.gatewayCredentialClass });
  const neutral = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : neutral, construct: () => neutral, apply: () => neutral });
  const engine = { status: () => ({ synthetic: true }) };
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    let source = fs.readFileSync(file, 'utf8');
    const isServer = file === path.join(root, 'server.js');
    if (isServer) {
      const cut = source.indexOf('// ── Boot ');
      if (cut < 0) throw new Error('Boot boundary changed; inspect harness');
      source = source.slice(0, cut) + '\nmodule.exports = app;';
    }
    function requireIsolated(id) {
      if (id === 'dotenv') return { config() {} };
      if (id === 'express') {
        if (!isServer) return express;
        return Object.assign(function () {
          app = express();
          for (const method of ['get', 'post', 'use']) {
            const original = app[method];
            app[method] = function (route, ...handlers) {
              if (typeof route === 'string' && handlers.length) {
                mounts.push({ method, path: route, handlers });
                // Preserve routers and the vision alias dispatcher. Replace
                // only resource-consuming direct endpoint handlers.
                if (method !== 'use' && !['/', '/health', '/v1', '/v1/models', '/v1/vision/analyze'].includes(route)) {
                  handlers[handlers.length - 1] = sentinel;
                }
              }
              return original.call(this, route, ...handlers);
            };
          }
          return app;
        }, express);
      }
      if (id === 'morgan') {
        // server.js calls morgan.token('url', ...) once at module load to
        // globally override the :url token before mounting the logger
        // (2026-09-15, CS-1 gateway auth review Priority 1/13) -- proxy it
        // through to the real morgan module's own .token() so that
        // override actually takes effect for the 'combined' format used
        // below, exactly as it does outside this harness.
        return Object.assign(
          (format, options) => morgan(format, { ...options, stream: { write: line => logs.access.push(line) } }),
          { token: morgan.token.bind(morgan) },
        );
      }
      if (id === 'axios') return { get: async () => ({ data: { syntheticUpstream: true } }), post: async () => ({ data: {} }) };
      if (id.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), id) + '.js';
        if (resolved === path.join(root, 'core', 'gatewayAuth.js') || /[\\/](api|routes)[\\/]/.test(resolved)) return load(resolved);
        if (id.startsWith('./engine/') && ['careerbert','llm','vlm','voice','internet','multimodal'].some(n => id.endsWith('/' + n))) return engine;
        return neutral;
      }
      return require(id);
    }
    vm.runInNewContext(source, { require: requireIsolated, module: mod, exports: mod.exports, process: processStub, console: output, Buffer, URL, setTimeout, clearTimeout, __filename: file, __dirname: path.dirname(file) }, { filename: file });
    if (!isServer && /[\\/](api|routes)[\\/]/.test(file)) {
      for (const layer of mod.exports.stack || []) {
        if (layer.route) layer.route.stack.at(-1).handle = sentinel;
      }
    }
    return mod.exports;
  }
  const ga = load('core/gatewayAuth.js');
  const application = load('server.js');
  const inventory = [];
  for (const mount of mounts) {
    const router = mount.handlers.find(h => h && h.stack);
    if (router) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
          const suffix = layer.route.path === '/' ? '' : layer.route.path;
          inventory.push({ method: method.toUpperCase(), path: mount.path + suffix, mount: mount.path, mountMethod: mount.method, innerGuard: layer.route.stack.some(l => l.name === 'apiKeyGuard'), reachable: mount.method === 'use' });
        }
      }
    } else if (mount.method !== 'use') inventory.push({ method: mount.method.toUpperCase(), path: mount.path, mount: mount.path, mountMethod: mount.method, innerGuard: false, reachable: true });
  }
  return { app: application, ga, logs, inventory };
}

async function serve(h, fn) {
  const server = http.createServer(h.app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  async function request(method, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: requestPath, headers, agent: false }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('synthetic HTTP request timeout')));
      req.on('error', reject);
      req.end();
    });
  }
  try { return await fn(request); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
module.exports = { build, serve, values, fullEnv, envNames };
