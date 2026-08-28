#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# CAREER STUDIO — process supervisor for the DEDICATED VIDEO POD
# ═══════════════════════════════════════════════════════════════════════
# Same real gap and same plain-polling-loop approach as
# aux-server-watchdog.sh (see that file's own header for the full
# reasoning) -- a separate script here rather than parameterizing that
# one because this pod only ever runs 2 of its 4 monitored services
# (SVD + talkinghead, no Ollama/gateway so no TTS/api_server either) --
# watching for tts_server.py/api_server.py here would try to restart
# services that were never meant to run on this pod at all.
#
# Usage: nohup ./video-pod-watchdog.sh > /tmp/watchdog.log 2>&1 &
set -u
CHECK_INTERVAL_S=60

_restart() {
  case "$1" in
    "talkinghead_server.py")
      ( cd /workspace/careercamp-ai/_sadtalker_src && nohup ./venv/bin/python talkinghead_server.py >> /tmp/talkinghead.log 2>&1 & )
      ;;
    "svd_server.py")
      ( cd /workspace/careercamp-ai/_svd_src && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True nohup ./venv/bin/python svd_server.py >> /tmp/svd.log 2>&1 & )
      ;;
  esac
}

PATTERNS=("talkinghead_server.py" "svd_server.py")

echo "[watchdog] $(date -u +%FT%TZ) started (video pod), checking every ${CHECK_INTERVAL_S}s: ${PATTERNS[*]}"

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
