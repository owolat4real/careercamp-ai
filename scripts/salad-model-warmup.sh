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
# Non-secret diagnostic companion to WARMUP_STATE_FILE (2026-09-18, S3
# restore root-cause pass) -- a real production instance reached
# "degraded" with zero useful [warmup] log lines found, leaving no way to
# tell WHY (S3 timeout vs AccessDenied vs NoSuchKey vs a real network
# stall) without container log/runtime access. This file records a short,
# curated reason CODE only (never raw AWS CLI stderr, which in principle
# could echo back request metadata) -- additive, never read by
# readWarmupState()'s own 3-state contract, so the existing warming/ready/
# degraded semantics on /health are unchanged either way.
WARMUP_REASON_FILE="${WARMUP_REASON_FILE:-${WARMUP_STATE_FILE}.reason}"
OLLAMA_MODELS_DIR="${OLLAMA_MODELS:-/root/.ollama/models}"
# Prints $1 as a plain decimal positive integer, or $2 (the default) when
# $1 is empty, non-numeric, negative, or zero. Every wall-clock budget
# below goes through this: `timeout 0` DISABLES the limit entirely, so a
# bad value must never be passed through -- it falls back to the bounded
# default instead. Leading zeros are read as decimal, not octal.
positive_int_or_default() {
  if [[ "$1" =~ ^[0-9]+$ ]] && [ "$((10#$1))" -gt 0 ]; then
    echo "$((10#$1))"
  else
    echo "$2"
  fi
}
# S3 restore root-cause pass (2026-09-18): a real instance transitioned
# warming -> degraded at almost exactly the old shared 900s outer timeout,
# with the restored model set completely absent afterward (ollamaModels=[]).
# These give the `aws` CLI's OWN connect/read timeouts a real, much
# shorter bound, so a true network stall is caught and classified in
# seconds, not silently eating the entire outer timeout window -- the
# outer `timeout "$S3_DOWNLOAD_TIMEOUT_SECONDS"` below stays as the final,
# unconditional safety net regardless (e.g. if retries still stack up).
AWS_CLI_CONNECT_TIMEOUT_SECONDS="${WARMUP_AWS_CONNECT_TIMEOUT_SECONDS:-30}"
AWS_CLI_READ_TIMEOUT_SECONDS="${WARMUP_AWS_READ_TIMEOUT_SECONDS:-60}"
# S3 restore timeout remediation (2026-09-19): the first real Salad restore
# (Version 11) proved connectivity, region and object access all work --
# the ~2.1 GiB archive was healthily progressing (about 1.1 GiB done) when
# the shared 900s outer timeout killed it (exit 124,
# s3_download_timeout_outer), leaving Ollama with no models. The inner
# --cli-read-timeout above is a per-socket idle timeout, not a total
# budget, so it never interferes with a transfer that keeps moving; the
# only thing that ended this one was the outer wall-clock cap. 900s cannot
# fit a multi-GB archive at community-node bandwidth (~1.25-1.5 MiB/s
# observed: 2.1 GiB needs roughly 24-29 minutes), so the S3 download gets
# its own budget. 3600s = about 2x the worst observed time, i.e. still
# completes down to roughly 0.6 MiB/s, while a genuinely stalled transfer
# is still killed and classified within an hour.
S3_DOWNLOAD_TIMEOUT_DEFAULT_SECONDS=3600
S3_DOWNLOAD_TIMEOUT_SECONDS="$(positive_int_or_default "${WARMUP_S3_DOWNLOAD_TIMEOUT_SECONDS:-}" "$S3_DOWNLOAD_TIMEOUT_DEFAULT_SECONDS")"
# Model-pull budget (2026-09-19 follow-up), INDEPENDENT of the S3 budget
# above: covers the `ollama pull` of llava-phi3 (the only source of the
# cs-careerqueen vision model -- the S3 backup holds only the custom text
# and embedding models, so this pull is required for vision, not
# redundant) and the opt-in aya-expanse:32b pull. The old shared 900s
# (WARMUP_NETWORK_TIMEOUT_SECONDS, now retired -- it is no longer read)
# was a wall-clock cap that kills a pull even while it is progressing,
# exactly like the S3 case: a ~2.9 GB llava-phi3 at ~1.5 MiB/s needs
# roughly 31 minutes. 3600s leaves ~1.9x headroom; a stalled pull is still
# killed within an hour. aya-expanse:32b is far larger (tens of GB): it is
# opt-in for faster, bigger-GPU nodes and should set this variable
# explicitly for its own transfer time.
MODEL_PULL_TIMEOUT_DEFAULT_SECONDS=3600
MODEL_PULL_TIMEOUT_SECONDS="$(positive_int_or_default "${WARMUP_MODEL_PULL_TIMEOUT_SECONDS:-}" "$MODEL_PULL_TIMEOUT_DEFAULT_SECONDS")"
# The confirmed real region of the DR backup bucket (careerstudiomax-dr-usw2
# is us-west-2) -- explicit so S3 region resolution never depends on
# whatever this container's ambient AWS config (if any) happens to
# default to. AWS_S3_REGION (this restore script's own name) takes
# precedence so it can be set independently of AWS_REGION/AWS_DEFAULT_REGION
# without assuming Salad's platform-level env even defines those.
AWS_S3_REGION="${AWS_S3_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}}"

write_state() {
  # $1 is always one of this script's own literal constants below, never
  # a variable derived from S3/network/attacker-controlled content.
  echo "$1" > "$WARMUP_STATE_FILE.tmp" && mv "$WARMUP_STATE_FILE.tmp" "$WARMUP_STATE_FILE"
}

write_reason() {
  # $1 is always one of this script's own literal reason-code constants
  # (see classify_aws_failure below) -- never raw command output.
  echo "$1" > "$WARMUP_REASON_FILE.tmp" && mv "$WARMUP_REASON_FILE.tmp" "$WARMUP_REASON_FILE"
}

# Maps an aws-cli exit code + its captured stderr to a short, non-secret
# reason code -- classifies the failure family without ever echoing the
# CLI's raw stderr (which, while it doesn't contain the secret key value,
# has no reason to be logged verbatim either). 124 is coreutils `timeout`'s
# own documented exit code for "the wrapped command was killed because it
# exceeded the timeout" -- checked first because it's authoritative
# regardless of whatever partial stderr the killed process left behind.
classify_aws_failure() {
  local exit_code="$1" stderr_text="$2"
  if [ "$exit_code" -eq 124 ]; then
    echo "s3_download_timeout_outer"; return
  fi
  case "$stderr_text" in
    *"Connect timeout"*|*"Read timeout"*|*"Connection timed out"*) echo "s3_download_timeout_cli" ;;
    *AccessDenied*|*Forbidden*)                                     echo "s3_access_denied" ;;
    *NoSuchKey*|*NoSuchBucket*)                                     echo "s3_no_such_key_or_bucket" ;;
    *InvalidAccessKeyId*|*SignatureDoesNotMatch*|*UnrecognizedClientException*|*ExpiredToken*)
      echo "s3_invalid_credentials" ;;
    *"could not connect"*|*"Could not connect"*|*"Network is unreachable"*|*"Temporary failure in name resolution"*|*"Name or service not known"*)
      echo "s3_network_unreachable" ;;
    *"specify a region"*|*PermanentRedirect*|*AuthorizationHeaderMalformed*)
      echo "s3_region_misconfigured" ;;
    *) echo "s3_download_failed_other" ;;
  esac
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
  # AWS_SECRET_ACCESS_KEY added to this check (2026-09-18) -- previously
  # only AWS_ACCESS_KEY_ID/AWS_S3_BUCKET were validated, so a container
  # with an access key ID but no secret configured would fall through to
  # the real `aws s3 cp` attempt and fail there indistinguishably from a
  # genuine network/S3 problem, instead of being caught by this same
  # fast, clearly-logged "not configured" branch below.
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && [ -n "${AWS_S3_BUCKET:-}" ]; then
    BACKUP_KEY="${MODEL_BACKUP_KEY:-model-backups/cs-custom-models-2026-09-03.tar.gz}"
    ARCHIVE="${WARMUP_ARCHIVE_PATH:-/tmp/models-backup.tar.gz}"
    echo "==> [warmup] Restoring custom fine-tuned models from S3 (bucket/key/region come from env vars, never logged)..."

    mkdir -p "$OLLAMA_MODELS_DIR"

    AWS_STDERR_FILE="$(mktemp)"
    echo "    [warmup] S3 download budget: ${S3_DOWNLOAD_TIMEOUT_SECONDS}s (inner CLI connect/read timeouts still apply)"
    if AWS_DEFAULT_REGION="$AWS_S3_REGION" timeout "$S3_DOWNLOAD_TIMEOUT_SECONDS" \
         aws s3 cp "s3://${AWS_S3_BUCKET}/${BACKUP_KEY}" "$ARCHIVE" \
         --cli-connect-timeout "$AWS_CLI_CONNECT_TIMEOUT_SECONDS" \
         --cli-read-timeout "$AWS_CLI_READ_TIMEOUT_SECONDS" \
         2>"$AWS_STDERR_FILE"; then
      rm -f "$AWS_STDERR_FILE"
      if tar -xzf "$ARCHIVE" -C "$OLLAMA_MODELS_DIR"; then
        rm -f "$ARCHIVE"
        echo "==> [warmup] Restore extracted -- restarting ollama so it picks up the new manifests/blobs..."
        pkill -f "ollama serve" || true
        sleep 2
        ollama serve &
        # Overridable (2026-09-18) purely so a test can exercise a genuine
        # restart-failure without a real 2-minute wait -- default (60
        # attempts x 2s = 2 minutes) is unchanged for every real deployment.
        if wait_for_ollama "${WARMUP_OLLAMA_RESTART_WAIT_ATTEMPTS:-60}"; then
          echo "    [warmup] ollama back up. Resident: $(ollama list | tr '\n' ' ')"
        else
          echo "!! [warmup] ollama did not come back up after the restore restart -- continuing degraded."
          write_state degraded
          write_reason ollama_restart_failed
        fi
      else
        echo "!! [warmup] Archive extraction failed -- removing partial/corrupt archive, continuing degraded."
        rm -f "$ARCHIVE"
        write_state degraded
        write_reason archive_extraction_failed
      fi
    else
      AWS_EXIT_CODE=$?
      AWS_FAILURE_REASON="$(classify_aws_failure "$AWS_EXIT_CODE" "$(cat "$AWS_STDERR_FILE" 2>/dev/null)")"
      rm -f "$AWS_STDERR_FILE"
      echo "!! [warmup] S3 download failed (reason: ${AWS_FAILURE_REASON}, exit ${AWS_EXIT_CODE}, budget ${S3_DOWNLOAD_TIMEOUT_SECONDS}s) -- continuing degraded."
      echo "!! [warmup] The app's own fallback cascade (Groq/OpenRouter) carries those requests instead."
      rm -f "$ARCHIVE"
      write_state degraded
      write_reason "$AWS_FAILURE_REASON"
    fi
  else
    echo "!! [warmup] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_S3_BUCKET not all set in this container"
    echo "!! [warmup] group's Environment Variables -- the custom fine-tuned models CANNOT be restored (no"
    echo "!! [warmup] public base -- see backupCustomModels.sh)."
    echo "!! [warmup] Continuing; the app's own fallback cascade (Groq/OpenRouter) carries those requests instead."
    write_state degraded
    write_reason credentials_not_configured
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
  echo "    [warmup] model pull budget: ${MODEL_PULL_TIMEOUT_SECONDS}s"
  if timeout "$MODEL_PULL_TIMEOUT_SECONDS" ollama pull llava-phi3 && ollama cp llava-phi3 cs-careerqueen; then
    ollama rm llava-phi3 || true
  else
    echo "!! [warmup] llava-phi3 pull/cp failed or timed out (budget ${MODEL_PULL_TIMEOUT_SECONDS}s) -- vision falls through to its own existing fallback."
    write_state degraded
    write_reason vision_pull_failed
  fi
fi

# Deliberately opt-in, not default -- see Dockerfile.salad's header comment
# on why a 24GB card can't reliably hold this alongside the other 3.
if [ "${RUN_CS_CAREERADVISOR:-false}" = "true" ] && ! ollama list | grep -q "cs-careeradvisor"; then
  echo "==> [warmup] RUN_CS_CAREERADVISOR=true — pulling aya-expanse:32b for cs-careeradvisor..."
  if ! (timeout "$MODEL_PULL_TIMEOUT_SECONDS" ollama pull aya-expanse:32b && ollama create cs-careeradvisor -f models/Modelfile.cs-careeradvisor); then
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
