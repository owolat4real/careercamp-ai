'use strict';
/**
 * Unit tests for core/modelWarmupState.js — the Node-side reader for the
 * state file scripts/salad-model-warmup.sh writes during the Salad
 * startup-probe remediation (2026-09-15).
 *
 *   node --test test/modelWarmupState.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withStateFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warmup-state-test-'));
  const file = path.join(dir, 'state');
  const prev = process.env.WARMUP_STATE_FILE;
  process.env.WARMUP_STATE_FILE = file;
  delete require.cache[require.resolve('../core/modelWarmupState')];
  const mod = require('../core/modelWarmupState');
  try {
    return fn(mod, file);
  } finally {
    if (prev === undefined) delete process.env.WARMUP_STATE_FILE;
    else process.env.WARMUP_STATE_FILE = prev;
    delete require.cache[require.resolve('../core/modelWarmupState')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('missing state file defaults to "warming", never "ready"', () => {
  withStateFile((mod, file) => {
    assert.equal(fs.existsSync(file), false);
    assert.equal(mod.readWarmupState(), 'warming');
  });
});

test('each valid state round-trips exactly', () => {
  withStateFile((mod, file) => {
    for (const state of ['warming', 'ready', 'degraded']) {
      fs.writeFileSync(file, state);
      assert.equal(mod.readWarmupState(), state);
    }
  });
});

test('trailing whitespace/newline from a shell echo is tolerated', () => {
  withStateFile((mod, file) => {
    fs.writeFileSync(file, 'ready\n');
    assert.equal(mod.readWarmupState(), 'ready');
  });
});

test('unrecognized content defaults to "warming", not thrown or passed through', () => {
  withStateFile((mod, file) => {
    fs.writeFileSync(file, 'READY'); // wrong case -- not one of the exact literals
    assert.equal(mod.readWarmupState(), 'warming');
    fs.writeFileSync(file, 'something-unexpected');
    assert.equal(mod.readWarmupState(), 'warming');
    fs.writeFileSync(file, '');
    assert.equal(mod.readWarmupState(), 'warming');
  });
});

test('an unreadable path (e.g. a directory, not a file) is handled without throwing', () => {
  withStateFile((mod, file) => {
    fs.mkdirSync(file); // now a directory at the expected file path
    assert.doesNotThrow(() => mod.readWarmupState());
    assert.equal(mod.readWarmupState(), 'warming');
  });
});
