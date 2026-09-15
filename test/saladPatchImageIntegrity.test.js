'use strict';
/**
 * Regression guard for the 2026-09-16 production incident: the Salad
 * container group crash-looped with MODULE_NOT_FOUND because
 * Dockerfile.salad-patch overlaid a newer server.js (which unconditionally
 * `require('./core/gatewayAuth')`) onto owo1232011/careerstudiomax:latest's
 * older filesystem -- a full rebuild ago, that file didn't exist yet, and
 * the patch's COPY list never picked it up because it's a brand-new local
 * dependency, not a change to an existing file.
 *
 * This statically re-derives the exact same defect class: for every .js
 * file Dockerfile.salad-patch actually copies into the image, resolve its
 * local (`./`/`../`) require()s and confirm each target is EITHER also
 * copied by the patch, OR already present in the base image commit the
 * patch was built against. A require target satisfying neither would have
 * caused this exact MODULE_NOT_FOUND crash.
 *
 *   node --test test/saladPatchImageIntegrity.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DOCKERFILE_PATCH = path.join(REPO_ROOT, 'Dockerfile.salad-patch');

// The commit Dockerfile.salad-patch was FIRST created against (git log:
// introduced in 52f7683, the commit immediately after 6b20bb7 added
// Dockerfile.salad and the container group's first image was built +
// pushed from it) -- the whole point of the patch file is to avoid
// rebuilding from a newer commit, so :latest's filesystem is assumed frozen
// here. If :latest is ever rebuilt from a newer commit, update this
// constant to match (and re-run this test) -- do not delete the test.
const BASE_IMAGE_COMMIT = '6b20bb7';

function readPatchCopiedJsFiles() {
  const dockerfile = fs.readFileSync(DOCKERFILE_PATCH, 'utf8');
  const files = [];
  for (const line of dockerfile.split('\n')) {
    const m = line.match(/^COPY\s+(\S+\.js)\s+\/app\//);
    if (m) files.push(m[1]);
  }
  return files;
}

function localRequiresOf(relPath) {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const requires = [];
  const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) requires.push(m[1]);
  return requires;
}

// Resolves a require() target relative to the requiring file's own
// directory, back to a repo-relative POSIX path with a .js extension --
// matching how Node's CommonJS loader would resolve it inside /app.
function resolveRelative(fromFile, requirePath) {
  const resolved = path.join(path.dirname(fromFile), requirePath);
  const withExt = resolved.endsWith('.js') ? resolved : `${resolved}.js`;
  return withExt.split(path.sep).join('/');
}

function existsAtBaseCommit(relPath) {
  try {
    execFileSync('git', ['cat-file', '-e', `${BASE_IMAGE_COMMIT}:${relPath}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

test('sanity: Dockerfile.salad-patch copies at least one .js file', () => {
  assert.ok(readPatchCopiedJsFiles().length > 0);
});

test('every local require() reachable from a Dockerfile.salad-patch COPY target is satisfiable inside the patched image', () => {
  const copied = readPatchCopiedJsFiles();
  const copiedSet = new Set(copied);
  const problems = [];

  for (const file of copied) {
    for (const req of localRequiresOf(file)) {
      const target = resolveRelative(file, req);
      const inPatch = copiedSet.has(target);
      const inBaseImage = existsAtBaseCommit(target);
      if (!inPatch && !inBaseImage) {
        problems.push(
          `${file} requires '${req}' -> ${target}, which is neither copied by ` +
          `Dockerfile.salad-patch nor present in the base image commit ` +
          `${BASE_IMAGE_COMMIT}. This is exactly the class of bug that caused ` +
          `the MODULE_NOT_FOUND production incident (core/gatewayAuth.js, ` +
          `2026-09-16) -- add a COPY line for it.`
        );
      }
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('regression: core/gatewayAuth.js specifically is copied by the patch (root cause of the 2026-09-16 MODULE_NOT_FOUND incident)', () => {
  const copied = readPatchCopiedJsFiles();
  assert.ok(
    copied.includes('core/gatewayAuth.js'),
    "core/gatewayAuth.js must be in Dockerfile.salad-patch's COPY list -- " +
    'server.js requires it unconditionally at boot, and it did not exist ' +
    `in the base image commit ${BASE_IMAGE_COMMIT}.`
  );
});

test('regression: core/modelWarmupState.js is also new since the base image commit, and remains copied by the patch', () => {
  assert.equal(existsAtBaseCommit('core/modelWarmupState.js'), false, 'sanity: this file is expected to be new since the base commit');
  const copied = readPatchCopiedJsFiles();
  assert.ok(copied.includes('core/modelWarmupState.js'));
});
