#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# SaladCloud model warm-up — launched as a BACKGROUND job by
# salad-entrypoint.sh, never on the path to `exec node server.js`.
#
# Restores the real custom-trained models from the S3 backup (NOT
# rebuildable from a public base model + Modelfile -- see
# backupCustomModels.sh's own header) and pulls the one genuinely-public
# vision model, exactly as before. What changed (2026-09-15, Salad
# startup-probe remediation) is WHEN this runs and HOW FAILURES ARE
# HANDLED, not the work itself:
#
#   - This script has its OWN `set -eo pipefail`, but since it always
#     runs as a background job of its caller, a failure here only ever
#     ends THIS script — never salad-entrypoint.sh, never Node, never
#     the container. (Previously this exact logic lived inline in
#     salad-entrypoint.sh itself, so `set -e` there took the whole
#     container down on any failure — see that file's own header for the
#     full incident this fixes.)
#   - Every potentially-failing external operation (the S3 download, tar
#     extraction, the post-restore ollama restart, the llava-phi3 pull)
#     is wrapped in its own explicit if/then rather than left to bare
#     `set -e` propagation, so a failure is caught, logged (never with
#     credential material — only bucket/key names, which are not secret,
#     and never AWS credential values), and recorded in the warm-up state
#     file, rather than silently killing this script.
#   - Progress is recorded in $WARMUP_STATE_FILE (read on the Node side by
#     core/modelWarmupState.js) as one of: warming | ready | degraded.
#     "degraded" means the gateway is fully usable via its existing
#     provider-fallback cascade, just without one or more local models.
#
# Known cost/latency tradeoff (unchanged from before this fix): Salad
# container instances are ephemeral -- no persistent volume is attached
# by default -- so this ~2GB restore + the llava-phi3 pull repeat on
# EVERY cold start (a container restart, a scale-up replica, etc.), not
# just once. If this becomes a real, recurring cost/time problem, the fix
# is attaching a Salad persistent volume to /root/.ollama and skipping
# the restore when it's already populated (this script already checks
# for that -- see below -- it just won't have anywhere persistent to
# find it without a volume actually attached).
# ═══════════════════════════════════════════════════════════════════════
set -eo pipefail

WARMUP_STATE_FILE="${WARMUP_STATE_FILE:-/tmp/careercamp-model-warmup-state}"
OLLAMA_MODELS_DIR="${OLLAMA_MODELS:-/root/.ollama/models}"
# Generous but bounded -- a 2.1GB download or a multi-GB model pull
# hanging forever on a stalled connection would otherwise waste this
# background job's resources for the container's entire lifetime with no
# way to notice from the logs alone. 15 minutes comfortably covers even
# very poor "Low priority" community-node bandwidth for either operation
# without being so short it fails a merely-slow-but-working transfer.
NETWORK_OP_TIMEOUT_SECONDS="${WARMUP_NETWORK_TIMEOUT_SECONDS:-900}"

write_state() {
  # $1 is always one of this script's own literal constants below, never
  # a variable derived from S3/network/attacker-controlled content.
  echo "$1" > "$WARMUP_STATE_FILE.tmp" && mv "$WARMUP_STATE_FILE.tmp" "$WARMUP_STATE_FILE"
}

wait_for_ollama() {
  local max_attempts="${1:-60}"  # default 60 x 2s = 2 minutes
  local attempt=0
  until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then return 1; fi
    sleep 2
  done
  return 0
}

write_state warming

if ! ollama list | grep -qE "cs-careerreasoning|cs-sonnet"; then
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_S3_BUCKET:-}" ]; then
    BACKUP_KEY="${MODEL_BACKUP_KEY:-model-backups/cs-custom-models-2026-09-03.tar.gz}"
    ARCHIVE="${WARMUP_ARCHIVE_PATH:-/tmp/models-backup.tar.gz}"
    echo "==> [warmup] Restoring custom fine-tuned models from S3 (bucket/key come from env vars, never logged)..."

    mkdir -p "$OLLAMA_MODELS_DIR"

    if timeout "$NETWORK_OP_TIMEOUT_SECONDS" aws s3 cp "s3://${AWS_S3_BUCKET}/${BACKUP_KEY}" "$ARCHIVE"; then
      if tar -xzf "$ARCHIVE" -C "$OLLAMA_MODELS_DIR"; then
        rm -f "$ARCHIVE"
        echo "==> [warmup] Restore extracted -- restarting ollama so it picks up the new manifests/blobs..."
        pkill -f "ollama serve" || true
        sleep 2
        ollama serve &
        if wait_for_ollama 60; then
          echo "    [warmup] ollama back up. Resident: $(ollama list | tr '\n' ' ')"
        else
          echo "!! [warmup] ollama did not come back up after the restore restart -- continuing degraded."
          write_state degraded
        fi
      else
        echo "!! [warmup] Archive extraction failed -- removing partial/corrupt archive, continuing degraded."
        rm -f "$ARCHIVE"
        write_state degraded
      fi
    else
      echo "!! [warmup] S3 download failed or timed out after ${NETWORK_OP_TIMEOUT_SECONDS}s -- continuing degraded."
      echo "!! [warmup] The app's own fallback cascade (Groq/OpenRouter) carries those requests instead."
      rm -f "$ARCHIVE"
      write_state degraded
    fi
  else
    echo "!! [warmup] AWS_ACCESS_KEY_ID / AWS_S3_BUCKET not set in this container group's Environment Variables --"
    echo "!! [warmup] the custom fine-tuned models CANNOT be restored (no public base -- see backupCustomModels.sh)."
    echo "!! [warmup] Continuing; the app's own fallback cascade (Groq/OpenRouter) carries those requests instead."
    write_state degraded
  fi
else
  echo "==> [warmup] reasoning-tier model already present -- skipping restore."
fi

# Renames -- cheap (new manifest, shared blobs), idempotent. Never fatal:
# the app's own "no local model" fallback already covers this regardless
# of why a rename didn't happen.
if ollama list | grep -q "cs-sonnet" && ! ollama list | grep -q "cs-careerreasoning"; then
  echo "==> [warmup] ollama cp cs-sonnet -> cs-careerreasoning"
  ollama cp cs-sonnet cs-careerreasoning || echo "!! [warmup] rename failed, continuing"
fi
if ollama list | grep -q "cs-haiku" && ! ollama list | grep -q "cs-careerbriefing"; then
  echo "==> [warmup] ollama cp cs-haiku -> cs-careerbriefing"
  ollama cp cs-haiku cs-careerbriefing || echo "!! [warmup] rename failed, continuing"
fi
echo "==> [warmup] Models now available: $(ollama list | awk 'NR>1{print $1}' | tr '\n' ' ')"

if ! ollama list | grep -q "cs-careerqueen"; then
  echo "==> [warmup] Pulling llava-phi3 (public model) for cs-careerqueen..."
  if timeout "$NETWORK_OP_TIMEOUT_SECONDS" ollama pull llava-phi3 && ollama cp llava-phi3 cs-careerqueen; then
    ollama rm llava-phi3 || true
  else
    echo "!! [warmup] llava-phi3 pull/cp failed or timed out -- vision falls through to its own existing fallback."
    write_state degraded
  fi
fi

# Deliberately opt-in, not default -- see Dockerfile.salad's header comment
# on why a 24GB card can't reliably hold this alongside the other 3.
if [ "${RUN_CS_CAREERADVISOR:-false}" = "true" ] && ! ollama list | grep -q "cs-careeradvisor"; then
  echo "==> [warmup] RUN_CS_CAREERADVISOR=true — pulling aya-expanse:32b for cs-careeradvisor..."
  if ! (timeout "$NETWORK_OP_TIMEOUT_SECONDS" ollama pull aya-expanse:32b && ollama create cs-careeradvisor -f models/Modelfile.cs-careeradvisor); then
    echo "!! [warmup] cs-careeradvisor pull/create failed or timed out -- opus-tier requests keep falling through to cloud fallback."
  fi
fi

# Only downgrade an already-'degraded' state by mistake if nothing above
# actually set it -- never overwrite a real failure with a false 'ready'.
CURRENT_STATE="$(cat "$WARMUP_STATE_FILE" 2>/dev/null || echo warming)"
if [ "$CURRENT_STATE" != "degraded" ]; then
  write_state ready
fi
echo "==> [warmup] Model warm-up finished. State: $(cat "$WARMUP_STATE_FILE" 2>/dev/null || echo unknown)"
