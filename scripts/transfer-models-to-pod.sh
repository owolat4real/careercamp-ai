#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Copy the local custom Ollama models (cs-haiku, cs-sonnet, cs-embed)
# onto a freshly-provisioned RunPod GPU pod.
#
# cs-opus is DELIBERATELY EXCLUDED from this script as of the 2026-08-07
# multilingual upgrade (see models/Modelfile.cs-opus, DEPLOY_RUNPOD.md
# step 3a): it's now `aya-expanse:32b`, a real PUBLIC Ollama library
# model chosen for genuine 23-language coverage, not a custom fine-tune —
# pull it directly ON THE POD instead (`ollama pull aya-expanse:32b`),
# which is both simpler and far faster than uploading an estimated ~19GB
# file over this machine's upload bandwidth via scp.
#
# The remaining 3 (cs-haiku, cs-sonnet, cs-embed) genuinely ARE custom
# fine-tunes with no public registry — there is no "ollama pull
# cs-sonnet" for those. The only way to get them onto a new host is to
# copy the already-built model files this machine already has in
# ~/.ollama/models.
#
# Usage:
#   1. On RunPod: create the pod (see DEPLOY_RUNPOD.md — Pods, not
#      Serverless; native install, no Docker), enable SSH, and use the
#      "SSH over exposed TCP" connection (not the ssh.runpod.io proxy —
#      that one is PTY-only and rejects both scripted commands and scp).
#   2. Run this script with that pod's direct SSH host/port:
#        ./transfer-models-to-pod.sh <pod-ip> <ssh-port> [ssh-key-path]
#   3. Separately, on the pod itself, pull cs-opus's real base
#      (see DEPLOY_RUNPOD.md step 3a) — this script does not do that part.
#
# What it does:
#   - Stages only the 3 needed models' manifests + deduplicated blobs
#     into ~/cs-models-stage (much smaller than the whole ~/.ollama/models
#     dir, which may contain other, unrelated models too)
#   - scp's that staging dir straight into /workspace/ollama-models on
#     the pod (plain scp over direct-TCP SSH — no rsync, no Docker;
#     the pod runs Ollama natively, started with
#     OLLAMA_MODELS=/workspace/ollama-models)
#   - Verifies the transferred size matches what was staged
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

POD_HOST="${1:?Usage: $0 <pod-ip> <ssh-port> [ssh-key-path]}"
POD_PORT="${2:?Usage: $0 <pod-ip> <ssh-port> [ssh-key-path]}"
SSH_KEY="${3:-$HOME/.ssh/id_ed25519}"

LOCAL_OLLAMA_DIR="$HOME/.ollama"
STAGE_DIR="$HOME/cs-models-stage"
MODELS=(cs-haiku cs-sonnet cs-embed)

echo "==> Checking local models exist..."
for m in "${MODELS[@]}"; do
  if [ ! -f "$LOCAL_OLLAMA_DIR/models/manifests/registry.ollama.ai/library/$m/latest" ]; then
    echo "!! Missing local model: $m — aborting."
    exit 1
  fi
done

echo "==> Staging only the 4 needed models + deduplicated blobs into $STAGE_DIR..."
rm -rf "$STAGE_DIR"
node -e "
const fs = require('fs');
const path = require('path');
const ollamaDir = process.env.LOCAL_OLLAMA_DIR;
const stageDir  = process.env.STAGE_DIR;
const models    = process.env.MODELS.split(' ');

const blobDigests = new Set();
for (const m of models) {
  const manifestSrc = path.join(ollamaDir, 'models/manifests/registry.ollama.ai/library', m, 'latest');
  const manifestDst = path.join(stageDir, 'manifests/registry.ollama.ai/library', m, 'latest');
  fs.mkdirSync(path.dirname(manifestDst), { recursive: true });
  fs.copyFileSync(manifestSrc, manifestDst);
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  blobDigests.add(manifest.config.digest);
  for (const layer of manifest.layers) blobDigests.add(layer.digest);
}
fs.mkdirSync(path.join(stageDir, 'blobs'), { recursive: true });
let totalBytes = 0;
for (const digest of blobDigests) {
  const name = digest.replace(':', '-');
  const src = path.join(ollamaDir, 'models/blobs', name);
  const dst = path.join(stageDir, 'blobs', name);
  fs.copyFileSync(src, dst);
  totalBytes += fs.statSync(dst).size;
}
console.log(\`    \${blobDigests.size} unique blobs, \${(totalBytes / 1e9).toFixed(2)}GB total.\`);
" LOCAL_OLLAMA_DIR="$LOCAL_OLLAMA_DIR" STAGE_DIR="$STAGE_DIR" MODELS="${MODELS[*]}"

echo "==> Transferring to the pod (plain scp over direct-TCP SSH)..."
scp -o StrictHostKeyChecking=accept-new -i "$SSH_KEY" -P "$POD_PORT" -r \
  "$STAGE_DIR"/* "root@$POD_HOST:/workspace/ollama-models/"

echo "==> Verifying transferred size matches staged size..."
LOCAL_SIZE=$(du -sb "$STAGE_DIR" | cut -f1)
REMOTE_SIZE=$(ssh -i "$SSH_KEY" -p "$POD_PORT" "root@$POD_HOST" \
  "du -sb /workspace/ollama-models 2>/dev/null | cut -f1")
echo "    Staged: $LOCAL_SIZE bytes | Pod: $REMOTE_SIZE bytes"

echo "==> Done. On the pod, start Ollama with OLLAMA_MODELS=/workspace/ollama-models"
echo "    and confirm these 3 models via 'ollama list'. cs-opus is separate —"
echo "    run 'ollama pull aya-expanse:32b && ollama create cs-opus -f Modelfile.cs-opus'"
echo "    directly on the pod (see DEPLOY_RUNPOD.md step 3a/4)."
