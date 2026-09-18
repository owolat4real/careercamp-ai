'use strict';
/**
 * Real bash-execution tests for the 2026-09-18 S3 model-restore
 * root-cause pass to scripts/salad-model-warmup.sh -- a real production
 * Salad instance transitioned modelWarmup from "warming" to "degraded"
 * at almost exactly the script's own 900-second outer timeout, with the
 * restored model set completely absent afterward (ollamaModels=[]) and
 * no useful [warmup] log lines found. This file proves:
 *
 *   - the S3 bucket/key/region actually used in the real `aws s3 cp`
 *     invocation (region explicit and overridable, defaulting to the
 *     confirmed real region of the DR bucket, us-west-2)
 *   - a genuine network-level stall is caught and classified distinctly
 *     from a fast AWS-side error (AccessDenied / NoSuchKey / bad region)
 *   - every documented failure family (S3 timeout, S3 command failure,
 *     extraction failure, ollama restart failure, credentials missing)
 *     reaches "degraded" with a matching, non-secret reason code
 *   - MODEL_BACKUP_KEY stays optional, the documented default is used
 *     when it's unset
 *   - no credential value (access key ID or secret) is ever printed
 *
 * Same fake-executable-on-a-scratch-PATH technique as the existing
 * test/saladModelWarmup.test.js -- no real network, S3, or Ollama install
 * is ever touched, and no real AWS credential is ever used.
 *
 *   node --test test/saladModelWarmupS3Diagnostics.test.js
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
 * Builds a scratch environment with fake aws/ollama/curl/tar/pkill/timeout
 * and runs the real script. Unlike saladModelWarmup.test.js's `timeout`
 * fake (which strips the seconds and always execs immediately), this one
 * keeps the REAL `timeout` command on PATH by default so a genuine
 * timeout-vs-hang scenario can actually be exercised -- only overridden
 * per-test when a specific test doesn't care about real timeout
 * enforcement and wants speed instead.
 *
 * The fake `aws` here always logs its own argv + AWS_DEFAULT_REGION to
 * $awsArgsFile, in addition to the existing behavior controls, so tests
 * can assert on the exact invocation, not just the final state.
 */
function runWarmup({
  awsBody,               // full fake aws script body (overrides the default below)
  awsSleepSeconds = 0,   // fake aws sleeps this long before exiting (for real-timeout tests)
  awsExit = 0,
  awsStderr = '',
  tarExit = 0,
  ollamaCpExit = 0,
  ollamaPullExit = 0,
  ollamaServeAfterRestoreCurlExit = 0,
  ollamaListOutput = 'NAME\nsome-other-model',
  awsCredsPresent = true,
  createArchiveOnDownload = true,
  extraEnv = {},
  fakeRealTimeout = false, // true = use the fast no-op fake timeout instead of the real one
} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'salad-warmup-s3-test-'));
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir);
  const stateFile = path.join(scratch, 'state');
  const reasonFile = `${stateFile}.reason`;
  const archive = path.join(scratch, 'models-backup.tar.gz');
  const modelsDir = path.join(scratch, 'ollama-models');
  const awsArgsFile = path.join(scratch, 'aws-args.txt');
  const awsEnvFile = path.join(scratch, 'aws-env.txt');

  writeFakeBin(binDir, 'curl', `exit ${ollamaServeAfterRestoreCurlExit}`);
  writeFakeBin(binDir, 'tar', `exit ${tarExit}`);
  writeFakeBin(binDir, 'pkill', 'exit 0');
  if (fakeRealTimeout) {
    writeFakeBin(binDir, 'timeout', 'shift\nexec "$@"');
  }
  // else: real coreutils `timeout` stays on PATH via the inherited system PATH.

  const defaultAwsBody = `
echo "$@" > "${awsArgsFile.replace(/\\/g, '/')}"
echo "AWS_DEFAULT_REGION=$AWS_DEFAULT_REGION" > "${awsEnvFile.replace(/\\/g, '/')}"
if [ -n "${awsSleepSeconds}" ] && [ "${awsSleepSeconds}" != "0" ]; then sleep ${awsSleepSeconds}; fi
if [ "$1" = "s3" ] && [ "$2" = "cp" ]; then
  ${createArchiveOnDownload ? 'touch "$4"' : 'true'}
  ${awsStderr ? `echo "${awsStderr}" >&2` : ''}
  exit ${awsExit}
fi
exit 0
`;
  writeFakeBin(binDir, 'aws', awsBody || defaultAwsBody);
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
    ...extraEnv,
  };
  // Hermetic against whatever real AWS region vars might already be set
  // in the ambient environment this test happens to run in -- every test
  // below sets exactly the region vars it means to test, nothing carried
  // over by accident.
  delete env.AWS_REGION;
  delete env.AWS_DEFAULT_REGION;
  delete env.AWS_S3_REGION;
  Object.assign(env, extraEnv);

  if (awsCredsPresent) {
    env.AWS_ACCESS_KEY_ID = 'synthetic_test_key_id';
    env.AWS_SECRET_ACCESS_KEY = 'synthetic_test_secret_key';
    env.AWS_S3_BUCKET = 'synthetic-test-bucket';
  } else {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_S3_BUCKET;
  }

  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 30_000 });

  return { result, stateFile, reasonFile, archive, awsArgsFile, awsEnvFile, scratch };
}

function cleanup(scratch) {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return null; }
}

test('correct S3 bucket/key are used in the real aws s3 cp invocation', () => {
  const { result, awsArgsFile, scratch } = runWarmup({});
  try {
    assert.equal(result.status, 0);
    const args = readTrimmed(awsArgsFile);
    assert.match(args, /^s3 cp s3:\/\/synthetic-test-bucket\/model-backups\/cs-custom-models-2026-09-03\.tar\.gz /);
  } finally { cleanup(scratch); }
});

test('MODEL_BACKUP_KEY remains optional -- the documented default key is used when it is unset', () => {
  const { result, awsArgsFile, scratch } = runWarmup({});
  try {
    assert.equal(result.status, 0);
    const args = readTrimmed(awsArgsFile);
    assert.match(args, /cs-custom-models-2026-09-03\.tar\.gz/, 'must fall back to the real, documented default backup key');
  } finally { cleanup(scratch); }
});

test('MODEL_BACKUP_KEY, when explicitly set, overrides the default', () => {
  const { result, awsArgsFile, scratch } = runWarmup({ extraEnv: { MODEL_BACKUP_KEY: 'model-backups/some-other-backup.tar.gz' } });
  try {
    assert.equal(result.status, 0);
    const args = readTrimmed(awsArgsFile);
    assert.match(args, /some-other-backup\.tar\.gz/);
    assert.doesNotMatch(args, /cs-custom-models-2026-09-03/);
  } finally { cleanup(scratch); }
});

test('explicit region: defaults to us-west-2 (the confirmed real region of the DR bucket) when nothing else is configured', () => {
  const { result, awsEnvFile, scratch } = runWarmup({});
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(awsEnvFile), 'AWS_DEFAULT_REGION=us-west-2');
  } finally { cleanup(scratch); }
});

test('explicit region: AWS_S3_REGION, when set, takes precedence over the default', () => {
  const { result, awsEnvFile, scratch } = runWarmup({ extraEnv: { AWS_S3_REGION: 'eu-central-1' } });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(awsEnvFile), 'AWS_DEFAULT_REGION=eu-central-1');
  } finally { cleanup(scratch); }
});

test('explicit region: a generic AWS_REGION is honored when AWS_S3_REGION is not set', () => {
  const { result, awsEnvFile, scratch } = runWarmup({ extraEnv: { AWS_REGION: 'ap-southeast-2' } });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(awsEnvFile), 'AWS_DEFAULT_REGION=ap-southeast-2');
  } finally { cleanup(scratch); }
});

test('S3 timeout: a genuinely hanging download is caught by the (short, test-only) network timeout, not left to run indefinitely, and reaches "degraded" with the timeout reason', () => {
  // Real coreutils `timeout` (fakeRealTimeout left false) actually enforces
  // WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS here -- the fake `aws` sleeps far
  // longer than that budget, proving the script genuinely detects and
  // classifies a real hang rather than merely a fast non-zero exit.
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    awsSleepSeconds: 5,
    extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '1' },
  });
  try {
    assert.equal(result.status, 0, `a timed-out download must not make the script itself fail; stderr: ${result.stderr}`);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 's3_download_timeout_outer');
    assert.match(result.stdout, /reason: s3_download_timeout_outer, exit 124, budget 1s/, 'failure line must report the S3 budget actually enforced');
  } finally { cleanup(scratch); }
}, 20_000);

// S3 restore timeout remediation (2026-09-19) -- a real Salad restore was
// killed by the old shared 900s cap while a 2.1 GiB download was healthily
// progressing. The S3 download now has its own budget
// (WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS, default 3600s), separate from the
// model-pull budget (WARMUP_NETWORK_TIMEOUT_SECONDS, default 900s).
const BUDGET_LINE = /S3 download budget: (\d+)s/;
function budgetOf(stdout) {
  const m = BUDGET_LINE.exec(stdout);
  return m ? Number(m[1]) : null;
}

test('S3 timeout budget: defaults to 3600s -- long enough for a 2.1 GiB archive at ~1.25 MiB/s (~29 min), not the old shared 900s', () => {
  const { result, scratch } = runWarmup({});
  try {
    assert.equal(result.status, 0);
    assert.equal(budgetOf(result.stdout), 3600);
    // Sanity on the sizing claim itself: worst observed rate finishes with >2x headroom.
    const worstCaseSeconds = (2.1 * 1024) / 1.25;
    assert.ok(3600 >= worstCaseSeconds * 2, `3600s must leave >=2x headroom over ${Math.round(worstCaseSeconds)}s`);
    assert.ok(worstCaseSeconds > 900, 'sanity: the old 900s budget genuinely could not fit this transfer');
  } finally { cleanup(scratch); }
});

test('S3 timeout budget: WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS overrides the default', () => {
  const { result, scratch } = runWarmup({ extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '7200' } });
  try {
    assert.equal(result.status, 0);
    assert.equal(budgetOf(result.stdout), 7200);
  } finally { cleanup(scratch); }
});

test('S3 timeout budget: zero, empty, negative, zero-padded-zero and non-numeric values fall back to the default -- never an unbounded `timeout 0`', () => {
  for (const bad of ['0', '00', '', '-5', 'abc', '10s', '1.5', ' ']) {
    const { result, scratch } = runWarmup({ extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: bad } });
    try {
      assert.equal(result.status, 0, `value ${JSON.stringify(bad)}: ${result.stderr}`);
      assert.equal(budgetOf(result.stdout), 3600, `value ${JSON.stringify(bad)} must fall back to the bounded default`);
    } finally { cleanup(scratch); }
  }
});

test('S3 timeout budget: leading zeros are read as decimal, not octal', () => {
  const { result, scratch } = runWarmup({ extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '0900' } });
  try {
    assert.equal(result.status, 0);
    assert.equal(budgetOf(result.stdout), 900);
  } finally { cleanup(scratch); }
});

test('a slow-but-progressing download that outlasts the shared model-pull budget still completes and reaches "ready"', () => {
  // The shared WARMUP_NETWORK_TIMEOUT_SECONDS (model pulls) is set to 1s and
  // the fake aws takes 3s -- under the OLD behaviour the S3 download was
  // governed by that same variable and would have been killed (exit 124).
  // With its own budget it must finish, extract, and reach ready.
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    awsSleepSeconds: 3,
    extraEnv: { WARMUP_NETWORK_TIMEOUT_SECONDS: '1', WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '30' },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readTrimmed(stateFile), 'ready');
    assert.equal(readTrimmed(reasonFile), null, 'no failure reason on a successful restore');
    assert.doesNotMatch(result.stdout, /S3 download failed/);
  } finally { cleanup(scratch); }
}, 30_000);

test('the timeout stays bounded: a download exceeding the S3 budget is killed at that budget, not left running', () => {
  const started = Date.now();
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    awsSleepSeconds: 20,
    extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '2' },
  });
  try {
    const elapsedMs = Date.now() - started;
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 's3_download_timeout_outer');
    assert.ok(elapsedMs < 15_000, `must be killed near the 2s budget, not run the fake's full 20s (took ${elapsedMs}ms)`);
    assert.equal(result.status, 0);
  } finally { cleanup(scratch); }
}, 30_000);

test('the S3 budget line and failure line never leak bucket, key, or credential values', () => {
  const { result, scratch } = runWarmup({
    awsSleepSeconds: 3,
    extraEnv: { WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS: '1' },
  });
  try {
    const combined = result.stdout + result.stderr;
    assert.match(combined, BUDGET_LINE);
    for (const secret of ['synthetic-test-bucket', 'synthetic_test_key_id', 'synthetic_test_secret_key', 'cs-custom-models-2026-09-03']) {
      assert.ok(!combined.includes(secret), `output must not contain ${secret}`);
    }
  } finally { cleanup(scratch); }
}, 20_000);

test('the model-pull budget is unchanged: WARMUP_NETWORK_TIMEOUT_SECONDS still governs the llava-phi3 pull, not the S3 download', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /NETWORK_OP_TIMEOUT_SECONDS="\$\{WARMUP_NETWORK_TIMEOUT_SECONDS:-900\}"/);
  assert.match(src, /timeout "\$NETWORK_OP_TIMEOUT_SECONDS" ollama pull llava-phi3/);
  assert.match(src, /timeout "\$S3_DOWNLOAD_TIMEOUT_SECONDS" \\/);
});

test('S3 command failure: AccessDenied is classified distinctly from a generic failure', () => {
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    awsExit: 1, createArchiveOnDownload: false,
    awsStderr: 'An error occurred (AccessDenied) when calling the GetObject operation: Access Denied',
  });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 's3_access_denied');
  } finally { cleanup(scratch); }
});

test('S3 command failure: NoSuchKey is classified distinctly from AccessDenied', () => {
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    awsExit: 1, createArchiveOnDownload: false,
    awsStderr: 'An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.',
  });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 's3_no_such_key_or_bucket');
  } finally { cleanup(scratch); }
});

test('S3 command failure: an unrecognized error still safely classifies as "other", never crashes the classifier', () => {
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    awsExit: 1, createArchiveOnDownload: false,
    awsStderr: 'some completely novel error string never seen before',
  });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 's3_download_failed_other');
  } finally { cleanup(scratch); }
});

test('extraction failure: reaches "degraded" with the archive_extraction_failed reason, partial archive removed', () => {
  const { result, stateFile, reasonFile, archive, scratch } = runWarmup({ tarExit: 1 });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 'archive_extraction_failed');
    assert.equal(fs.existsSync(archive), false);
  } finally { cleanup(scratch); }
});

test('Ollama restart failure: reaches "degraded" with the ollama_restart_failed reason', () => {
  // WARMUP_OLLAMA_RESTART_WAIT_ATTEMPTS overridden to keep this test fast
  // (real default is 60 attempts x 2s = 2 real minutes) -- the fake curl
  // always failing means wait_for_ollama never sees ollama come back up,
  // exactly the real restart-failure condition, just observed quickly.
  const { result, stateFile, reasonFile, scratch } = runWarmup({
    ollamaServeAfterRestoreCurlExit: 1,
    extraEnv: { WARMUP_OLLAMA_RESTART_WAIT_ATTEMPTS: '1' },
  });
  try {
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 'ollama_restart_failed');
  } finally { cleanup(scratch); }
});

test('credentials missing entirely: reaches "degraded" with the credentials_not_configured reason', () => {
  const { result, stateFile, reasonFile, scratch } = runWarmup({ awsCredsPresent: false });
  try {
    assert.equal(result.status, 0);
    assert.equal(readTrimmed(stateFile), 'degraded');
    assert.equal(readTrimmed(reasonFile), 'credentials_not_configured');
  } finally { cleanup(scratch); }
});

test('AWS_SECRET_ACCESS_KEY missing (but AWS_ACCESS_KEY_ID present): also reaches "degraded" with credentials_not_configured, never attempts the real download', () => {
  // runWarmup()'s awsCredsPresent flag is all-or-nothing (matches
  // saladModelWarmup.test.js's own convention) -- this specific partial-
  // config case (ID present, secret absent) needs its own explicit setup.
  const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), 'salad-warmup-s3-test-'));
  const binDir = path.join(scratch2, 'bin');
  fs.mkdirSync(binDir);
  const stateFile2 = path.join(scratch2, 'state');
  writeFakeBin(binDir, 'curl', 'exit 0');
  writeFakeBin(binDir, 'tar', 'exit 0');
  writeFakeBin(binDir, 'pkill', 'exit 0');
  writeFakeBin(binDir, 'aws', 'echo "SHOULD_NOT_RUN"; exit 0');
  writeFakeBin(binDir, 'ollama', 'case "$1" in list) printf "NAME\\nsome-other-model\\n"; exit 0 ;; *) exit 0 ;; esac');
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    WARMUP_STATE_FILE: stateFile2,
    OLLAMA_MODELS: path.join(scratch2, 'ollama-models'),
    RUN_CS_CAREERADVISOR: 'false',
    AWS_ACCESS_KEY_ID: 'synthetic_test_key_id',
    AWS_S3_BUCKET: 'synthetic-test-bucket',
  };
  delete env.AWS_SECRET_ACCESS_KEY;
  const result2 = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 30_000 });
  try {
    assert.equal(result2.status, 0);
    assert.equal(readTrimmed(stateFile2), 'degraded');
    assert.equal(readTrimmed(`${stateFile2}.reason`), 'credentials_not_configured');
    assert.doesNotMatch(result2.stdout, /SHOULD_NOT_RUN/, 'must never actually attempt the S3 download without a secret key configured');
  } finally { cleanup(scratch2); }
});

test('no AWS credential values (access key ID or secret) ever appear in stdout/stderr, including on a real classified failure', () => {
  const { result, scratch } = runWarmup({
    awsExit: 1, createArchiveOnDownload: false,
    awsStderr: 'An error occurred (InvalidAccessKeyId) when calling the GetObject operation',
  });
  try {
    const combined = result.stdout + result.stderr;
    assert.ok(!combined.includes('synthetic_test_key_id'), 'AWS access key ID must never be logged');
    assert.ok(!combined.includes('synthetic_test_secret_key'), 'AWS secret access key must never be logged');
    assert.ok(!/Authorization/i.test(combined), 'no Authorization header material should ever be logged');
  } finally { cleanup(scratch); }
});
