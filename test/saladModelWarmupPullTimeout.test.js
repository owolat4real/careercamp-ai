'use strict';
/**
 * Real bash-execution tests for the model-pull timeout budget in
 * scripts/salad-model-warmup.sh (2026-09-19 follow-up to the S3 restore
 * timeout remediation).
 *
 * The `ollama pull llava-phi3` step is the ONLY source of the
 * cs-careerqueen vision model (the S3 backup holds only the custom text
 * and embedding models), and it used to share the same 900s wall-clock cap
 * that killed a healthily-progressing 2.1 GiB S3 download. A multi-GB pull
 * at ~1.5 MiB/s needs ~30 minutes, so it gets its own configurable budget,
 * WARMUP_MODEL_PULL_TIMEOUT_SECONDS (default 3600s), independent of
 * WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS.
 *
 * Real coreutils `timeout` is used (not a fake) so a genuine hang is
 * actually killed; `aws`/`ollama`/`curl`/`tar`/`pkill` are fake executables
 * on a scratch PATH. No network, no real Ollama, no real credentials.
 *
 *   node --test test/saladModelWarmupPullTimeout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'salad-model-warmup.sh');

function writeFakeBin(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function runWarmup({
  pullSleepSeconds = 0,
  pullExit = 0,
  awsSleepSeconds = 0,
  // Default: the reasoning-tier model is already present, so the S3 restore
  // is skipped entirely and only the pull path is exercised.
  ollamaListOutput = 'NAME\ncs-careerreasoning',
  extraEnv = {},
} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'salad-pull-timeout-test-'));
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir);
  const stateFile = path.join(scratch, 'state');
  const ollamaLog = path.join(scratch, 'ollama-calls.txt').replace(/\\/g, '/');

  writeFakeBin(binDir, 'curl', 'exit 0');
  writeFakeBin(binDir, 'tar', 'exit 0');
  writeFakeBin(binDir, 'pkill', 'exit 0');
  writeFakeBin(binDir, 'aws', `
if [ "${awsSleepSeconds}" != "0" ]; then sleep ${awsSleepSeconds}; fi
if [ "$1" = "s3" ] && [ "$2" = "cp" ]; then touch "$4"; fi
exit 0
`);
  writeFakeBin(binDir, 'ollama', `
echo "$@" >> "${ollamaLog}"
case "$1" in
  serve) exit 0 ;;
  list) printf '%s\\n' "${ollamaListOutput.replace(/\n/g, '\\n')}"; exit 0 ;;
  cp) exit 0 ;;
  rm) exit 0 ;;
  pull) if [ "${pullSleepSeconds}" != "0" ]; then sleep ${pullSleepSeconds}; fi; exit ${pullExit} ;;
  *) exit 0 ;;
esac
`);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    WARMUP_STATE_FILE: stateFile,
    WARMUP_ARCHIVE_PATH: path.join(scratch, 'models-backup.tar.gz'),
    OLLAMA_MODELS: path.join(scratch, 'ollama-models'),
    RUN_CS_CAREERADVISOR: 'false',
    AWS_ACCESS_KEY_ID: 'synthetic_test_key_id',
    AWS_SECRET_ACCESS_KEY: 'synthetic_test_secret_key',
    AWS_S3_BUCKET: 'synthetic-test-bucket',
    ...extraEnv,
  };
  delete env.WARMUP_NETWORK_TIMEOUT_SECONDS;
  Object.assign(env, extraEnv);

  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 60_000 });
  return { result, stateFile, reasonFile: `${stateFile}.reason`, ollamaLog, scratch };
}

const cleanup = (scratch) => fs.rmSync(scratch, { recursive: true, force: true });
const readTrimmed = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) { return null; } };
const PULL_BUDGET = /model pull budget: (\d+)s/;
const pullBudgetOf = (stdout) => { const m = PULL_BUDGET.exec(stdout); return m ? Number(m[1]) : null; };

test('model-pull budget defaults to 3600s -- fits a ~2.9 GB llava-phi3 at ~1.5 MiB/s (~31 min), which the old 900s could not', () => {
  const { result, scratch } = runWarmup({});
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pullBudgetOf(result.stdout), 3600);
    const seconds = (2.9 * 1000 * 1000 * 1000) / (1.5 * 1024 * 1024);
    assert.ok(seconds > 900, 'sanity: the old 900s budget genuinely could not fit this pull');
    assert.ok(3600 >= seconds * 1.5, `3600s must leave real headroom over ~${Math.round(seconds)}s`);
  } finally { cleanup(scratch); }
});

test('WARMUP_MODEL_PULL_TIMEOUT_SECONDS overrides the default', () => {
  const { result, scratch } = runWarmup({ extraEnv: { WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '7200' } });
  try {
    assert.equal(result.status, 0);
    assert.equal(pullBudgetOf(result.stdout), 7200);
  } finally { cleanup(scratch); }
});

test('invalid values (0, 00, empty, negative, non-numeric, decimal, whitespace) fall back to the bounded default -- never `timeout 0`', () => {
  for (const bad of ['0', '00', '', '-5', 'abc', '10s', '1.5', ' ']) {
    const { result, scratch } = runWarmup({ extraEnv: { WARMUP_MODEL_PULL_TIMEOUT_SECONDS: bad } });
    try {
      assert.equal(result.status, 0, `value ${JSON.stringify(bad)}: ${result.stderr}`);
      assert.equal(pullBudgetOf(result.stdout), 3600, `value ${JSON.stringify(bad)} must fall back to 3600`);
    } finally { cleanup(scratch); }
  }
});

test('leading zeros are read as decimal, not octal', () => {
  const { result, scratch } = runWarmup({ extraEnv: { WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '0900' } });
  try {
    assert.equal(pullBudgetOf(result.stdout), 900);
  } finally { cleanup(scratch); }
});

test('the retired shared WARMUP_NETWORK_TIMEOUT_SECONDS no longer affects the pull budget', () => {
  const { result, scratch } = runWarmup({ extraEnv: { WARMUP_NETWORK_TIMEOUT_SECONDS: '5' } });
  try {
    assert.equal(pullBudgetOf(result.stdout), 3600);
  } finally { cleanup(scratch); }
});

test('successful pull path: a slow-but-progressing pull inside its budget completes, is copied to cs-careerqueen, and reaches "ready"', () => {
  const { result, stateFile, reasonFile, ollamaLog, scratch } = runWarmup({
    pullSleepSeconds: 3,
    extraEnv: { WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '30' },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readTrimmed(stateFile), 'ready');
    assert.equal(readTrimmed(reasonFile), null, 'no failure reason on a successful pull');
    const calls = fs.readFileSync(ollamaLog, 'utf8');
    assert.match(calls, /^pull llava-phi3$/m);
    assert.match(calls, /^cp llava-phi3 cs-careerqueen$/m);
    assert.match(calls, /^rm llava-phi3$/m);
  } finally { cleanup(scratch); }
}, 30_000);

test('timeout stays bounded: a pull exceeding its budget is killed at that budget, degrades with vision_pull_failed, and reports the budget', () => {
  const started = Date.now();
  const { result, stateFile, reasonFile, ollamaLog, scratch } = runWarmup({
    pullSleepSeconds: 20,
    extraEnv: { WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '2' },
  });
  try {
    const elapsedMs = Date.now() - started;
    assert.equal(result.status, 0, 'a timed-out pull must not make the script itself fail');
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 'vision_pull_failed');
    assert.match(result.stdout, /llava-phi3 pull\/cp failed or timed out \(budget 2s\)/);
    assert.ok(elapsedMs < 15_000, `must be killed near the 2s budget, not run the fake's full 20s (took ${elapsedMs}ms)`);
    assert.ok(!/^cp llava-phi3/m.test(fs.readFileSync(ollamaLog, 'utf8')), 'must not copy a model whose pull was killed');
  } finally { cleanup(scratch); }
}, 30_000);

test('a non-timeout pull failure keeps the same degraded / vision_pull_failed classification', () => {
  const { result, stateFile, reasonFile, scratch } = runWarmup({ pullExit: 1 });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 'vision_pull_failed');
  } finally { cleanup(scratch); }
});

test('independence: a tiny S3 budget does not shorten the pull -- a 3s pull under a 30s pull budget still succeeds', () => {
  // S3 restore runs here (reasoning model absent from `ollama list`), with
  // an S3 budget of 1s and an instant fake aws; the pull then takes 3s.
  const { result, stateFile, scratch } = runWarmup({
    ollamaListOutput: 'NAME\nsome-other-model',
    pullSleepSeconds: 3,
    extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '1', WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '30' },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /S3 download budget: 1s/);
    assert.equal(pullBudgetOf(result.stdout), 30);
    assert.equal(readTrimmed(stateFile), 'ready');
  } finally { cleanup(scratch); }
}, 30_000);

test('independence: a tiny pull budget does not shorten the S3 download -- a 3s download under a 30s S3 budget still succeeds', () => {
  const { result, stateFile, scratch } = runWarmup({
    ollamaListOutput: 'NAME\nsome-other-model',
    awsSleepSeconds: 3,
    extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '30', WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '1' },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /S3 download budget: 30s/);
    assert.equal(pullBudgetOf(result.stdout), 1);
    assert.equal(readTrimmed(stateFile), 'ready');
  } finally { cleanup(scratch); }
}, 30_000);

test('the S3 download budget default is unchanged at 3600s alongside the new pull budget', () => {
  const { result, scratch } = runWarmup({ ollamaListOutput: 'NAME\nsome-other-model' });
  try {
    assert.match(result.stdout, /S3 download budget: 3600s/);
    assert.equal(pullBudgetOf(result.stdout), 3600);
  } finally { cleanup(scratch); }
});

test('no bucket, key, or credential value appears in any output, including on a pull timeout', () => {
  const { result, scratch } = runWarmup({
    ollamaListOutput: 'NAME\nsome-other-model',
    pullSleepSeconds: 5,
    extraEnv: { WARMUP_MODEL_PULL_TIMEOUT_SECONDS: '1' },
  });
  try {
    const combined = result.stdout + result.stderr;
    for (const secret of ['synthetic-test-bucket', 'synthetic_test_key_id', 'synthetic_test_secret_key', 'cs-custom-models-2026-09-03']) {
      assert.ok(!combined.includes(secret), `output must not contain ${secret}`);
    }
  } finally { cleanup(scratch); }
}, 30_000);
