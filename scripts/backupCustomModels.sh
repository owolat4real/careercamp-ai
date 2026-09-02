#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Back up the genuinely custom, no-public-registry Ollama models
# (cs-haiku, cs-sonnet, cs-embed — see transfer-models-to-pod.sh's own
# header comment: "there is no ollama pull cs-sonnet") to real off-pod
# storage (S3), independent of any single pod or its Network Volume.
#
# Real incident this exists to prevent (2026-08-25): both pods' AI
# backend went down (pod1 stopped, pod2's container disk reset on
# restart) with no verified, independent backup of these 3 models
# anywhere off-RunPod. The Network Volume (/workspace) survived that
# specific incident, but a volume-level failure or accidental deletion
# would have taken the only copies of real, hours-of-compute fine-tuned
# weights with it. cs-opus is deliberately excluded — it's aya-
# expanse:32b, a real public Ollama library model, trivially re-pulled.
#
# Usage (run ON the pod that currently has the real, current models —
# not necessarily pod1 specifically; whichever pod's copy is canonical):
#   ./backupCustomModels.sh
#
# Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION /
# AWS_S3_BUCKET in the environment (same real bucket cs_fixed's
# services/storage.js already uses) — source the pod's own .env first
# if these aren't already exported, e.g.:
#   set -a; source /workspace/careercamp-ai/.env; set +a
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID first}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY first}"
: "${AWS_S3_BUCKET:?Set AWS_S3_BUCKET first}"
AWS_REGION="${AWS_REGION:-us-east-1}"

OLLAMA_DIR="${OLLAMA_MODELS:-/workspace/ollama-models}"
STAGE_DIR="/workspace/model-backup-stage"
MODELS=(cs-haiku cs-sonnet cs-embed)
DATE_TAG="$(date -u +%Y-%m-%d)"
TARBALL="/workspace/cs-custom-models-backup.tar.gz"
S3_KEY="model-backups/cs-custom-models-${DATE_TAG}.tar.gz"

echo "==> Staging manifests + deduplicated blobs for: ${MODELS[*]}"
rm -rf "$STAGE_DIR"
# Real, live-caught bug (2026-09-02): these KEY=value assignments were
# placed AFTER `node -e "..."` -- in bash that only sets env vars for a
# command when they come BEFORE it; placed after, they're just extra
# positional args to `node`, so process.env.OLLAMA_DIR/STAGE_DIR/MODELS
# were always undefined and this failed immediately on
# `process.env.MODELS.split(' ')`. This script had apparently never
# actually succeeded via this exact invocation -- the one real backup in
# S3 (2026-08-25) predates this code path or was run some other way.
OLLAMA_DIR="$OLLAMA_DIR" STAGE_DIR="$STAGE_DIR" MODELS="${MODELS[*]}" node -e "
const fs = require('fs');
const path = require('path');
const ollamaDir = process.env.OLLAMA_DIR;
const stageDir = process.env.STAGE_DIR;
const models = process.env.MODELS.split(' ');
const blobDigests = new Set();
for (const m of models) {
  const manifestSrc = path.join(ollamaDir, 'manifests/registry.ollama.ai/library', m, 'latest');
  const manifestDst = path.join(stageDir, 'manifests/registry.ollama.ai/library', m, 'latest');
  fs.mkdirSync(path.dirname(manifestDst), { recursive: true });
  fs.copyFileSync(manifestSrc, manifestDst);
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  blobDigests.add(manifest.config.digest);
  for (const layer of manifest.layers) blobDigests.add(layer.digest);
}
fs.mkdirSync(path.join(stageDir, 'blobs'), { recursive: true });
for (const digest of blobDigests) {
  const name = digest.replace(':', '-');
  fs.copyFileSync(path.join(ollamaDir, 'blobs', name), path.join(stageDir, 'blobs', name));
}
console.log('    ' + blobDigests.size + ' unique blobs staged.');
"

echo "==> Compressing..."
tar -czf "$TARBALL" -C "$STAGE_DIR" .
echo "    $(du -h "$TARBALL" | cut -f1)"

echo "==> Verifying tarball integrity before upload..."
tar -tzf "$TARBALL" > /dev/null

echo "==> Uploading to s3://${AWS_S3_BUCKET}/${S3_KEY}..."
# Switched to the `aws` CLI (2026-09-02) -- the @aws-sdk/client-s3 Node
# package this used to require() is NOT installed anywhere on this pod
# (confirmed live: MODULE_NOT_FOUND, no node_modules for it in
# /workspace/careercamp-ai or anywhere else), so the upload step had
# never actually succeeded either, independent of the env-var bug fixed
# above. `aws` CLI v1 IS already present on this pod's base image and
# needs no install -- a smaller dependency footprint for a script whose
# whole point is disaster recovery (it should work even when the rest of
# this repo's node_modules is in a bad state).
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION="$AWS_REGION" \
  aws s3 cp "$TARBALL" "s3://${AWS_S3_BUCKET}/${S3_KEY}" \
  || { echo "!! S3 upload failed — leaving local tarball at $TARBALL for manual retry."; exit 1; }
echo "    Uploaded $(du -h "$TARBALL" | cut -f1)."

echo "==> Cleaning up local staging..."
rm -rf "$STAGE_DIR" "$TARBALL"

echo "==> Done. Backed up: ${MODELS[*]} -> s3://${AWS_S3_BUCKET}/${S3_KEY}"
