'use strict';
/**
 * Real bash-execution test for scripts/salad-entrypoint.sh — proves the
 * actual, live property the Salad startup-probe remediation (2026-09-15)
 * depends on: the Node gateway launches promptly, without waiting for the
 * (now-backgrounded) model warm-up job, even when that job would take a
 * very long time.
 *
 * The real script hardcodes absolute container paths (/app/scripts/...)
 * that don't exist on a dev machine, so this test runs a copy of the real
 * script's source with only those two absolute paths substituted for
 * test-controlled stand-ins (a fake warm-up script that sleeps, and a
 * fake "node server.js" that just announces it started) -- every other
 * line, including the actual startup order and error handling, is the
 * real, unmodified script content, byte for byte.
 *
 *   node --test test/saladEntrypoint.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENTRYPOINT = path.join(__dirname, '..', 'scripts', 'salad-entrypoint.sh');

function writeFakeBin(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

test('Node launches promptly even though the background model warm-up job is still running (would take far longer)', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'salad-entrypoint-test-'));
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir);
  const nodeStartedMarker = path.join(scratch, 'node-started');
  const warmupFinishedMarker = path.join(scratch, 'warmup-finished');
  const slowWarmupScript = path.join(scratch, 'slow-warmup.sh');
  const fakeNodeCommand = path.join(scratch, 'fake-node-command.sh');

  // Stand-ins for the two hardcoded absolute paths in the real entrypoint.
  // 12s (well beyond real subprocess-spawn/PATH-resolution overhead on any
  // platform this runs on) so the timing assertion below has real margin
  // without weakening what it actually proves.
  fs.writeFileSync(slowWarmupScript, `#!/usr/bin/env bash\nsleep 12\ntouch "${warmupFinishedMarker.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(slowWarmupScript, 0o755);
  fs.writeFileSync(fakeNodeCommand, `#!/usr/bin/env bash\ntouch "${nodeStartedMarker.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(fakeNodeCommand, 0o755);

  writeFakeBin(binDir, 'curl', 'exit 0'); // ollama "is up" immediately
  writeFakeBin(binDir, 'ollama', 'case "$1" in serve) exit 0 ;; *) exit 0 ;; esac');
  writeFakeBin(binDir, 'python3', 'exit 0');
  // Real entrypoint execs `node server.js` -- redirect that exact
  // invocation to our fake stand-in without touching the real server.js.
  writeFakeBin(binDir, 'node', `exec "${fakeNodeCommand.replace(/\\/g, '/')}"`);

  const realSource = fs.readFileSync(ENTRYPOINT, 'utf8');
  const testSource = realSource
    .replace('/app/scripts/salad-model-warmup.sh', slowWarmupScript.replace(/\\/g, '/'));
  const testEntrypoint = path.join(scratch, 'entrypoint-under-test.sh');
  fs.writeFileSync(testEntrypoint, testSource);
  fs.chmodSync(testEntrypoint, 0o755);

  const child = spawn('bash', [testEntrypoint], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });

  try {
    const start = Date.now();
    // Poll for the fake-node marker rather than a fixed sleep -- waits for
    // the real condition, not a guessed duration.
    let elapsedMs = null;
    for (let i = 0; i < 100; i++) { // up to 10s
      if (fs.existsSync(nodeStartedMarker)) { elapsedMs = Date.now() - start; break; }
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(elapsedMs !== null, 'the fake Node process must have started within 10 seconds');
    assert.ok(elapsedMs < 10_000, `Node started after ${elapsedMs}ms -- should be well under the 12s the background warm-up job takes, proving it did not wait`);
    assert.equal(fs.existsSync(warmupFinishedMarker), false, 'the background warm-up job (12s sleep) must not have finished yet when Node already started');
  } finally {
    child.kill('SIGKILL');
    // Give the background warm-up subshell (still running under the killed
    // parent) a moment, then clean up regardless of whether it finished.
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('entrypoint script itself has valid bash syntax after the refactor', () => {
  const { execFileSync } = require('node:child_process');
  assert.doesNotThrow(() => execFileSync('bash', ['-n', ENTRYPOINT]));
});
