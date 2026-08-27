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
# Deliberately scoped to the 4 aux Python servers that follow this exact
# fragile "bare nohup, no restart-on-crash" pattern -- NOT node
# server.js or ollama serve, which are started differently in
# start-all-with-recovery.sh and a real gateway/LLM crash deserves more
# visible, immediate attention than a silent auto-restart would give it.
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
      ( cd /workspace/careercamp-ai/_svd_src && nohup ./venv/bin/python svd_server.py >> /tmp/svd.log 2>&1 & )
      ;;
    "tts_server.py")
      ( cd /workspace/careercamp-ai && HF_HOME=/workspace/hf_cache TTS_SERVER_PORT=3006 nohup ./venv-tts/bin/python tts_server.py >> /tmp/tts_server.log 2>&1 & )
      ;;
    "python3 api_server.py")
      ( cd /workspace/careercamp-ai && COQUI_TOS_AGREED=1 nohup python3 api_server.py >> /tmp/mlserver.log 2>&1 & )
      ;;
  esac
}

PATTERNS=("talkinghead_server.py" "svd_server.py" "tts_server.py" "python3 api_server.py")

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
