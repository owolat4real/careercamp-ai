#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# SaladCloud container entrypoint — starts ollama, restores our real
# custom-trained models from the S3 backup (they are NOT rebuildable from
# a public base model + Modelfile, see backupCustomModels.sh's own header
# comment), pulls the one genuinely-public vision model, then starts the
# Python ML server and the Node gateway.
#
# Known cost/latency tradeoff, stated honestly rather than hidden: Salad
# container instances are ephemeral — no persistent volume is attached by
# default — so this ~2GB restore + the llava-phi3 pull repeat on EVERY
# cold start (a container restart, a scale-up replica, etc.), not just
# once. If this becomes a real, recurring cost/time problem, the fix is
# attaching a Salad persistent volume to /root/.ollama and skipping the
# restore when it's already populated (this script already checks for
# that — see below — it just won't have anywhere persistent to find it
# without a volume actually attached).
# ═══════════════════════════════════════════════════════════════════════
set -eo pipefail

export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-3}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-2}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"

echo "==> Starting ollama serve..."
ollama serve &

echo "==> Waiting for ollama to accept requests..."
until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do sleep 2; done
echo "    ollama is up."

# Where Ollama actually keeps manifests/ and blobs/ — in the ollama/ollama
# image this is /root/.ollama/models (NOT /root/.ollama). The backup
# tarball (from backupCustomModels.sh) has ./blobs/ and ./manifests/ at
# its root, so it must extract INTO the models dir.
OLLAMA_MODELS_DIR="${OLLAMA_MODELS:-/root/.ollama/models}"

# The real backups predate the 2026-09-09 rename, so they contain
# cs-sonnet / cs-haiku / cs-embed manifests, not the new names. Restore if
# NEITHER the new nor the old reasoning-tier name is already present.
if ! ollama list | grep -qE "cs-careerreasoning|cs-sonnet"; then
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_S3_BUCKET:-}" ]; then
    BACKUP_KEY="${MODEL_BACKUP_KEY:-model-backups/cs-custom-models-2026-09-03.tar.gz}"
    echo "==> Restoring custom fine-tuned models from s3://${AWS_S3_BUCKET}/${BACKUP_KEY} ..."
    aws s3 cp "s3://${AWS_S3_BUCKET}/${BACKUP_KEY}" /tmp/models-backup.tar.gz
    mkdir -p "$OLLAMA_MODELS_DIR"
    tar -xzf /tmp/models-backup.tar.gz -C "$OLLAMA_MODELS_DIR"
    rm -f /tmp/models-backup.tar.gz
    # Ollama caches its model list — restart so it picks up manifests/blobs
    # written straight to disk rather than through its own API.
    pkill -f "ollama serve" || true
    sleep 2
    ollama serve &
    until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do sleep 2; done
    echo "    Restore extracted. Resident: $(ollama list | tr '\n' ' ')"
  else
    echo "!! AWS_ACCESS_KEY_ID / AWS_S3_BUCKET not set in this container group's Environment Variables --"
    echo "!! the custom fine-tuned models CANNOT be restored (no public base — see backupCustomModels.sh)."
    echo "!! Continuing; the app's own fallback cascade (Groq/OpenRouter) carries those requests instead."
  fi
else
  echo "==> reasoning-tier model already present — skipping restore."
fi

# Map the pre-rename backup names to the names the app actually calls now
# (ollama cp is cheap — new manifest, shared blobs). Idempotent: only runs
# when the old name exists and the new one doesn't.
if ollama list | grep -q "cs-sonnet" && ! ollama list | grep -q "cs-careerreasoning"; then
  echo "==> ollama cp cs-sonnet -> cs-careerreasoning"
  ollama cp cs-sonnet cs-careerreasoning
fi
if ollama list | grep -q "cs-haiku" && ! ollama list | grep -q "cs-careerbriefing"; then
  echo "==> ollama cp cs-haiku -> cs-careerbriefing"
  ollama cp cs-haiku cs-careerbriefing
fi
echo "==> Models now available: $(ollama list | awk 'NR>1{print $1}' | tr '\n' ' ')"

if ! ollama list | grep -q "cs-careerqueen"; then
  echo "==> Pulling llava-phi3 (public model) for cs-careerqueen..."
  ollama pull llava-phi3 && ollama cp llava-phi3 cs-careerqueen && ollama rm llava-phi3
fi

# Deliberately opt-in, not default — see Dockerfile.salad's header comment
# on why a 24GB card can't reliably hold this alongside the other 3.
if [ "${RUN_CS_CAREERADVISOR:-false}" = "true" ] && ! ollama list | grep -q "cs-careeradvisor"; then
  echo "==> RUN_CS_CAREERADVISOR=true — pulling aya-expanse:32b for cs-careeradvisor..."
  ollama pull aya-expanse:32b && ollama create cs-careeradvisor -f models/Modelfile.cs-careeradvisor
fi

echo "==> Starting Python ML server on :3003 (DEVICE=${DEVICE:-cpu})..."
DEVICE="${DEVICE:-cpu}" python3 api_server.py > /tmp/mlserver.log 2>&1 &

echo "==> Starting Node gateway on :${PORT:-3002} (this becomes the container's foreground process)..."
exec node server.js
