'use strict';
/**
 * Real end-to-end boot smoke test for server.js -- catches the exact class
 * of production incident from 2026-09-16 (MODULE_NOT_FOUND on
 * core/gatewayAuth.js) at the process level, not just statically.
 * test/saladPatchImageIntegrity.test.js proves the Dockerfile.salad-patch
 * COPY list is self-consistent; this test proves the actual, current
 * server.js really boots, binds its port, and serves /health -- using only
 * the checked-out source tree. No Docker, no GPU, no Ollama, no real
 * credentials.
 *
 * Synthetic-only credentials: three distinct dummy values, one per gateway
 * credential class (core/gatewayAuth.js), so its own boot-time duplicate-
 * secret check doesn't reject the boot for a reason unrelated to this test.
 * Never real secrets, never read from .env.
 *
 *   node --test test/saladPatchServerBoot.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const TEST_PORT = 13199; // unlikely to collide with a real dev server

function get(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForHealth(port, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await get(`http://127.0.0.1:${port}/health`, 1500);
      if (r.status) return r;
    } catch {
      // not up yet -- keep polling the real condition rather than guessing
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

test('server.js boots from the checked-out source tree without MODULE_NOT_FOUND, binds its port, and serves /health', async () => {
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      CAREERCAMP_SECRET_KEY: 'test-only-dummy-secret-boot-check',
      CAREERCAMP_API_KEY: 'test-only-dummy-camp-boot-check',
      CS_TRANSFORMER_API_KEY: 'test-only-dummy-transformer-boot-check',
    },
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {}); // drain, don't let the pipe back up

  let exitCode = null;
  child.on('exit', (code) => { exitCode = code; });

  try {
    const health = await waitForHealth(TEST_PORT, 15000);

    assert.ok(!/MODULE_NOT_FOUND/.test(stderr), `server.js must not throw MODULE_NOT_FOUND -- stderr:\n${stderr}`);
    assert.equal(exitCode, null, `server.js must still be running, not exited (code ${exitCode}) -- stderr:\n${stderr}`);
    assert.ok(health, 'server.js must accept a connection and respond on its configured port within 15s');
    assert.equal(health.status, 200, '/health must respond 200');

    const parsed = JSON.parse(health.body);
    assert.equal(parsed.status, 'ok');
    // Model warm-up must never be required for the gateway itself to be
    // considered up -- 'warming' (no Ollama/models in this sandbox) is the
    // expected, honest value here, not a failure of this test.
    assert.ok(['warming', 'ready', 'degraded'].includes(parsed.modelWarmup));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (exitCode === null) child.kill('SIGKILL');
  }
});
