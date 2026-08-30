#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# CAREER STUDIO — lightweight process supervisor for the pod's aux GPU servers
# ═══════════════════════════════════════════════════════════════════════
# Real gap found live (2026-08-27): talkinghead_server.py crashed from a
# CUDA OOM during heavy concurrent testing and sat dead for over an hour,
# completely unnoticed, because none of the bare `nohup ... &` aux Python
# servers this pod runs (talkinghead/svd/tts/api_server) have any
# supervisor to restart them on crash -- a pre-existing, documented gap
# (see this repo's own README notes on api_server.py's "Persistence
# gotcha"). This is a plain polling loop, not a new dependency like
# supervisord -- this project already tried something adjacent via
# RunPod's dockerStartCmd API field and it disabled SSH entirely by
# overriding the container's own entrypoint (a real prior incident, see
# cs_fixed session memory on that). This script instead just runs as an
# ordinary background process INSIDE the already-running container,
# touching nothing about how the container itself boots -- if it dies,
# worst case is back to today's baseline (no supervision), never worse.
#
# Scoped to the 4 aux Python servers that follow this exact fragile
# "bare nohup, no restart-on-crash" pattern, PLUS ollama serve (added
# 2026-08-30 -- see below) -- still NOT node server.js, which is a
# different failure class (an auth/session-bearing Node crash deserves
# a human looking at deploy logs, not a blind restart-loop that could
# mask a real regression under it).
#
# Real gap in the ORIGINAL scoping decision, found while completing this
# session's infra audit (2026-08-30): `ollama serve` was grouped with
# node server.js under "deserves more visible attention than a silent
# auto-restart" -- but ollama backs cs-haiku/cs-sonnet/cs-opus, i.e. it
# IS the self-hosted AI engine behind CSTM-2's careerlm, CAMP's chat,
# and Transformer's fallback path. Losing it silently for the "over an
# hour, completely unnoticed" duration this watchdog was built to
# prevent for talkinghead_server.py is a materially worse outage than
# any of the 4 processes already covered -- the exact incident class
# this script exists to close, just not yet applied to the single most
# critical process on the pod. "Visible attention" is still real here:
# every restart below is a loudly logged, greppable line in
# /tmp/watchdog.log (unlike a silent process death), and the app-side
# health-check cycle (services/csModelGateway.js, pings every 120s)
# independently surfaces a cold/unhealthy tier on the status page
# regardless of this watchdog -- so this doesn't remove visibility, it
# adds a fast local recovery on top of the visibility that already
# exists.
#
# Usage: nohup ./aux-server-watchdog.sh > /tmp/watchdog.log 2>&1 &
set -u
CHECK_INTERVAL_S=60

# pattern -> restart command (must exactly match start-all-with-recovery.sh's
# own invocation of each, so a watchdog-restarted process is byte-identical
# in behavior to a script-started one).
_restart() {
  case "$1" in
    "talkinghead_server.py")
      ( cd /workspace/careercamp-ai/_sadtalker_src && nohup ./venv/bin/python talkinghead_server.py >> /tmp/talkinghead.log 2>&1 & )
      ;;
    "svd_server.py")
      ( cd /workspace/careercamp-ai/_svd_src && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True nohup ./venv/bin/python svd_server.py >> /tmp/svd.log 2>&1 & )
      ;;
    "tts_server.py")
      ( cd /workspace/careercamp-ai && HF_HOME=/workspace/hf_cache TTS_SERVER_PORT=3006 nohup ./venv-tts/bin/python tts_server.py >> /tmp/tts_server.log 2>&1 & )
      ;;
    "python3 api_server.py")
      ( cd /workspace/careercamp-ai && COQUI_TOS_AGREED=1 nohup python3 api_server.py >> /tmp/mlserver.log 2>&1 & )
      ;;
    "ollama serve")
      # Exact env vars must match start-all-with-recovery.sh's own
      # invocation -- a watchdog-restarted ollama with a different
      # OLLAMA_MAX_LOADED_MODELS/OLLAMA_KV_CACHE_TYPE would silently
      # regress capacity/quality vs. a script-started one. OLLAMA_KEEP_ALIVE
      # bounded to 10m as of 2026-08-30 -- see start-all-with-recovery.sh's
      # own comment on this same line for the real VRAM-saturation reason.
      ( OLLAMA_MODELS=/workspace/ollama-models OLLAMA_MAX_LOADED_MODELS=4 OLLAMA_NUM_PARALLEL=4 \
        OLLAMA_KEEP_ALIVE=10m OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_MAX_QUEUE=512 \
        nohup ollama serve >> /tmp/ollama.log 2>&1 & )
      ;;
  esac
}

PATTERNS=("talkinghead_server.py" "svd_server.py" "tts_server.py" "python3 api_server.py" "ollama serve")

echo "[watchdog] $(date -u +%FT%TZ) started, checking every ${CHECK_INTERVAL_S}s: ${PATTERNS[*]}"

while true; do
  for pattern in "${PATTERNS[@]}"; do
    if ! pgrep -f "$pattern" > /dev/null 2>&1; then
      echo "[watchdog] $(date -u +%FT%TZ) '$pattern' is DOWN -- restarting"
      _restart "$pattern"
      sleep 5
    fi
  done
  sleep "$CHECK_INTERVAL_S"
done
