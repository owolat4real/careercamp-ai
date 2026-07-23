#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Copy the local custom Ollama models (cs-haiku, cs-sonnet, cs-opus,
# cs-embed — ~8.7GB total) onto a freshly-provisioned RunPod GPU pod.
#
# These are custom fine-tunes (cs_fixed/training/train_lora.py), not
# public models — there is no "ollama pull cs-sonnet". The only way to
# get them onto a new host is to copy the already-built model files this
# machine already has in ~/.ollama/models.
#
# Usage:
#   1. On RunPod: create the pod, enable SSH (Pod → Connect → SSH), note
#      its SSH command (something like: ssh root@<ip> -p <port> -i ~/.ssh/id_ed25519)
#   2. Run this script with that same host/port:
#        ./transfer-models-to-pod.sh <pod-ip> <ssh-port> [ssh-key-path]
#
# What it does:
#   - rsyncs ~/.ollama (manifests + blobs) into the pod's Docker volume
#     mount point for the `ollama` service in docker-compose.yml
#   - Verifies all 4 models are visible via `ollama list` afterward
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

POD_HOST="${1:?Usage: $0 <pod-ip> <ssh-port> [ssh-key-path]}"
POD_PORT="${2:?Usage: $0 <pod-ip> <ssh-port> [ssh-key-path]}"
SSH_KEY="${3:-$HOME/.ssh/id_ed25519}"

LOCAL_OLLAMA_DIR="$HOME/.ollama"
# Matches docker-compose.yml's `ollama_data:/root/.ollama` volume mount —
# rsyncing straight into the container's bind path (Docker creates the
# volume's backing directory under /var/lib/docker/volumes/..., but it's
# simplest to rsync into the container's /root/.ollama directly via `docker
# cp`-style access if the pod already has the stack running; this script
# assumes the `ollama` container is already up so we can exec into it).
REMOTE_CONTAINER="ollama"

echo "==> Checking local models exist..."
for m in cs-haiku cs-sonnet cs-opus cs-embed; do
  if [ ! -f "$LOCAL_OLLAMA_DIR/models/manifests/registry.ollama.ai/library/$m/latest" ]; then
    echo "!! Missing local model: $m — aborting."
    exit 1
  fi
done
echo "    All 4 models found locally ($(du -sh "$LOCAL_OLLAMA_DIR/models" | cut -f1) total)."

echo "==> rsyncing ~/.ollama to the pod (this takes a while over ~9GB)..."
rsync -avz --progress -e "ssh -i $SSH_KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new" \
  "$LOCAL_OLLAMA_DIR/" "root@$POD_HOST:/tmp/ollama-transfer/"

echo "==> Moving into the running ollama container's volume..."
ssh -i "$SSH_KEY" -p "$POD_PORT" "root@$POD_HOST" bash -s <<'REMOTE'
set -e
docker cp /tmp/ollama-transfer/. ollama:/root/.ollama/
docker restart ollama
sleep 5
echo "==> Models visible in Ollama:"
docker exec ollama ollama list
rm -rf /tmp/ollama-transfer
REMOTE

echo "==> Done. Verify cs-haiku, cs-sonnet, cs-opus, cs-embed all appear above."
