#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Runs backupCustomModels.sh once immediately, then every 24h, for as
# long as this pod is up. Real gap this closes (2026-09-02): the backup
# script existed but had never actually succeeded (two separate bugs,
# fixed the same day this loop was added -- see git log for
# backupCustomModels.sh), so the one backup that DID exist in S3 was 8
# days stale by the time anyone checked. A backup that only ever runs
# when someone remembers to SSH in and run it by hand isn't a real
# safety net.
#
# Not a cron job -- this pod's base image has no crond installed and
# adding one is a real new dependency for something this simple. Same
# nohup-background-loop shape as aux-server-watchdog.sh, which this pod
# already relies on.
#
# Started automatically by start-all-with-recovery.sh; can also be run
# standalone: nohup ./dailyModelBackupLoop.sh >> /workspace/logs/model-backup-loop.log 2>&1 &
# ═══════════════════════════════════════════════════════════════════════
set -u
INTERVAL_S=86400
ENV_FILE="/workspace/careercamp-ai/.env"

while true; do
  if [ -f "$ENV_FILE" ]; then
    export AWS_ACCESS_KEY_ID="$(grep -m1 '^AWS_ACCESS_KEY_ID=' "$ENV_FILE" | cut -d= -f2-)"
    export AWS_SECRET_ACCESS_KEY="$(grep -m1 '^AWS_SECRET_ACCESS_KEY=' "$ENV_FILE" | cut -d= -f2-)"
    export AWS_S3_BUCKET="$(grep -m1 '^AWS_S3_BUCKET=' "$ENV_FILE" | cut -d= -f2-)"
    export AWS_REGION="$(grep -m1 '^AWS_REGION=' "$ENV_FILE" | cut -d= -f2-)"
  fi
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ] || [ -z "${AWS_S3_BUCKET:-}" ]; then
    echo "$(date -u +%FT%TZ) [ModelBackupLoop] Missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_S3_BUCKET in $ENV_FILE -- skipping this run, will retry in ${INTERVAL_S}s."
  else
    echo "$(date -u +%FT%TZ) [ModelBackupLoop] Starting daily backup run..."
    if bash /workspace/careercamp-ai/scripts/backupCustomModels.sh; then
      echo "$(date -u +%FT%TZ) [ModelBackupLoop] Backup succeeded."
    else
      echo "$(date -u +%FT%TZ) [ModelBackupLoop] Backup FAILED (see output above) -- will retry in ${INTERVAL_S}s."
    fi
  fi
  sleep "$INTERVAL_S"
done
