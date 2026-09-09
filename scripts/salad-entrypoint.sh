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

if ! ollama list | grep -q "cs-careerreasoning"; then
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_S3_BUCKET:-}" ]; then
    BACKUP_KEY="${MODEL_BACKUP_KEY:-model-backups/cs-custom-models-2026-09-03.tar.gz}"
    echo "==> Restoring cs-careerreasoning / cs-careerbriefing / cs-embed from s3://${AWS_S3_BUCKET}/${BACKUP_KEY} ..."
    aws s3 cp "s3://${AWS_S3_BUCKET}/${BACKUP_KEY}" /tmp/models-backup.tar.gz
    mkdir -p /root/.ollama
    tar -xzf /tmp/models-backup.tar.gz -C /root/.ollama
    rm -f /tmp/models-backup.tar.gz
    # Ollama needs restarting to notice manifests/blobs written directly
    # to its data dir rather than through its own API.
    pkill -f "ollama serve" || true
    sleep 2
    ollama serve &
    until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do sleep 2; done
    echo "    Restored. Now resident: $(ollama list | tr '\n' ' ')"
  else
    echo "!! AWS_ACCESS_KEY_ID / AWS_S3_BUCKET not set in this container group's Environment Variables --"
    echo "!! cs-careerreasoning / cs-careerbriefing / cs-embed CANNOT be restored (they have no public"
    echo "!! base model — see backupCustomModels.sh). Continuing without them; the app's own fallback"
    echo "!! cascade (Groq/OpenRouter) will carry those requests instead."
  fi
else
  echo "==> cs-careerreasoning already present (persistent volume?) — skipping restore."
fi

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
