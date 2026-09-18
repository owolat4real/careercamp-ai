'use strict';
/**
 * Real bash-execution tests for scripts/salad-model-warmup.sh — the
 * background model-restore job extracted during the Salad startup-probe
 * remediation (2026-09-15).
 *
 * Runs the ACTUAL script as a real child process, with `aws`, `ollama`,
 * `curl`, `tar`, `pkill`, `timeout` all replaced by tiny fake executables
 * on a scratch PATH so no real network call, S3 download, or Ollama
 * install is ever touched. Every fake is controlled purely via env vars
 * this test sets, never via any secret material.
 *
 *   node --test test/saladModelWarmup.test.js
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

/**
 * Builds a scratch PATH directory with fake aws/ollama/curl/tar/pkill/timeout,
 * runs the real script against it, and returns { result, stateFile, archive, binDir }.
 * `ollamaListOutput` controls what `ollama list` prints (so the "already
 * present, skip restore" branch can be exercised too).
 */
function runWarmup({
  awsExit = 0,
  tarExit = 0,
  ollamaCpExit = 0,
  ollamaPullExit = 0,
  ollamaServeAfterRestoreCurlExit = 0,
  ollamaListOutput = 'NAME\nsome-other-model',
  awsCredsPresent = true,
  createArchiveOnDownload = true,
} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'salad-warmup-test-'));
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir);
  const stateFile = path.join(scratch, 'state');
  const archive = path.join(scratch, 'models-backup.tar.gz');
  const modelsDir = path.join(scratch, 'ollama-models');

  writeFakeBin(binDir, 'curl', `exit ${ollamaServeAfterRestoreCurlExit}`);
  writeFakeBin(binDir, 'tar', `exit ${tarExit}`);
  writeFakeBin(binDir, 'pkill', 'exit 0');
  // `timeout N cmd...` -- drop the first arg (the seconds) and exec the rest,
  // exactly like the real coreutils timeout does for a command that finishes
  // well inside the limit (which every fake here always does).
  writeFakeBin(binDir, 'timeout', 'shift\nexec "$@"');
  writeFakeBin(binDir, 'aws', `
if [ "$1" = "s3" ] && [ "$2" = "cp" ]; then
  ${createArchiveOnDownload ? 'touch "$4"' : 'true'}
  exit ${awsExit}
fi
exit 0
`);
  writeFakeBin(binDir, 'ollama', `
case "$1" in
  serve) exit 0 ;;
  list) printf '%s\\n' "${ollamaListOutput.replace(/\n/g, '\\n')}"; exit 0 ;;
  cp) exit ${ollamaCpExit} ;;
  rm) exit 0 ;;
  pull) exit ${ollamaPullExit} ;;
  *) exit 0 ;;
esac
`);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    WARMUP_STATE_FILE: stateFile,
    WARMUP_ARCHIVE_PATH: archive,
    OLLAMA_MODELS: modelsDir,
    RUN_CS_CAREERADVISOR: 'false',
  };
  if (awsCredsPresent) {
    env.AWS_ACCESS_KEY_ID = 'synthetic_test_key_id';
    // 2026-09-18 S3 restore root-cause pass: the script now also validates
    // AWS_SECRET_ACCESS_KEY (previously unchecked -- a real gap, since a
    // container with an access key ID but no secret configured used to
    // fall through to a real, indistinguishable `aws s3 cp` failure
    // instead of this same fast "not configured" branch).
    env.AWS_SECRET_ACCESS_KEY = 'synthetic_test_secret_key';
    env.AWS_S3_BUCKET = 'synthetic-test-bucket';
  } else {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_S3_BUCKET;
  }

  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 30_000 });

  return { result, stateFile, archive, scratch };
}

function cleanup(scratch) {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function readState(stateFile) {
  try { return fs.readFileSync(stateFile, 'utf8').trim(); } catch (_) { return null; }
}

test('happy path: S3 download + extraction + llava pull all succeed -> state is "ready"', () => {
  const { result, stateFile, scratch } = runWarmup({});
  try {
    assert.equal(result.status, 0, `script must exit 0 on the happy path; stderr: ${result.stderr}`);
    assert.equal(readState(stateFile), 'ready');
  } finally { cleanup(scratch); }
});

test('S3 download failure: script exits 0 (never crashes/propagates), state is "degraded"', () => {
  const { result, stateFile, archive, scratch } = runWarmup({ awsExit: 1, createArchiveOnDownload: false });
  try {
    assert.equal(result.status, 0, `a failed S3 download must not make the script itself fail; stderr: ${result.stderr}`);
    assert.equal(readState(stateFile), 'degraded');
    assert.equal(fs.existsSync(archive), false, 'no archive file should be left behind after a failed download');
  } finally { cleanup(scratch); }
});

test('extraction failure: script exits 0, state is "degraded", partial archive is removed', () => {
  const { result, stateFile, archive, scratch } = runWarmup({ tarExit: 1 });
  try {
    assert.equal(result.status, 0, `a failed extraction must not make the script itself fail; stderr: ${result.stderr}`);
    assert.equal(readState(stateFile), 'degraded');
    assert.equal(fs.existsSync(archive), false, 'a partial/corrupt archive must be cleaned up after a failed extraction');
  } finally { cleanup(scratch); }
});

test('AWS credentials absent entirely: script exits 0, state is "degraded" (graceful, matches original intent)', () => {
  const { result, stateFile, scratch } = runWarmup({ awsCredsPresent: false });
  try {
    assert.equal(result.status, 0);
    assert.equal(readState(stateFile), 'degraded');
  } finally { cleanup(scratch); }
});

test('llava-phi3 pull failure: script exits 0, state is "degraded"', () => {
  const { result, stateFile, scratch } = runWarmup({ ollamaPullExit: 1 });
  try {
    assert.equal(result.status, 0, `a failed llava-phi3 pull must not make the script itself fail; stderr: ${result.stderr}`);
    assert.equal(readState(stateFile), 'degraded');
  } finally { cleanup(scratch); }
});

test('reasoning-tier model already present: restore is skipped entirely, state still reaches "ready"', () => {
  const { result, stateFile, scratch } = runWarmup({
    ollamaListOutput: 'NAME\ncs-careerreasoning\ncs-careerqueen', // also has vision model, so llava pull is skipped
    awsExit: 1, // if the restore branch ran anyway, this would force "degraded" -- proves the skip really happened
  });
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes('skipping restore'), true, 'log output should say the restore was skipped');
    assert.equal(readState(stateFile), 'ready', 'must reach ready even though aws would have failed, proving the S3 branch never ran');
  } finally { cleanup(scratch); }
});

test('state file always ends in one of the three valid states, never left as merely "warming"', () => {
  for (const opts of [{}, { awsExit: 1, createArchiveOnDownload: false }, { tarExit: 1 }, { ollamaPullExit: 1 }]) {
    const { result, stateFile, scratch } = runWarmup(opts);
    try {
      assert.equal(result.status, 0);
      assert.ok(['ready', 'degraded'].includes(readState(stateFile)), `unexpected final state for ${JSON.stringify(opts)}: ${readState(stateFile)}`);
    } finally { cleanup(scratch); }
  }
});

test('no AWS credential values, secrets, or headers appear anywhere in stdout/stderr', () => {
  const { result, scratch } = runWarmup({});
  try {
    const combined = result.stdout + result.stderr;
    assert.ok(!combined.includes('synthetic_test_key_id'), 'AWS access key ID must never be logged');
    assert.ok(!/Authorization/i.test(combined), 'no Authorization header material should ever be logged');
  } finally { cleanup(scratch); }
});
