#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# SaladCloud container entrypoint.
#
# 2026-09-15 (Salad startup-probe remediation): Node's gateway used to
# start ONLY after the ~2.1GB custom-model S3 restore + a separate
# llava-phi3 pull fully completed, sequentially, with no timeout on
# either. Salad's startup probe here is a plain TCP check on port 3002
# (initial delay 1s, 15s period, 15 failure threshold -- roughly a
# 3.5-3.75 minute total budget by that arithmetic; Salad's own exact
# internal timing algorithm is not verified from anything in this repo).
# On a "Low priority" community GPU node with unpredictable download
# speed, that budget was reliably exhausted before Node ever bound the
# port, producing a repeated Instance Allocated -> Starting -> Running ->
# Instance Interrupted (Startup Probe Failure) cycle. `set -eo pipefail`
# made this worse in a second, independent way: an S3 hiccup or a failed
# llava-phi3 pull didn't just delay startup, it killed the ENTIRE
# container outright (this script is the container's PID 1 until `exec`
# replaces it; PID 1 exiting under errexit/pipefail tears down the whole
# PID namespace) -- unlike the sibling "AWS creds not configured" branch,
# which already degraded gracefully.
#
# Fix: only the fast, bounded step needed before Node can usefully run
# (starting Ollama and confirming its OWN base API is reachable, with a
# bounded wait -- see wait_for_ollama below) stays on the path to
# `exec node server.js`. The slow, network-bound, potentially-failing
# model restoration (scripts/salad-model-warmup.sh) now runs as its OWN
# background job with its OWN error handling -- a failure there ends
# that job, never this script, never Node, never the container. See that
# script's own header for its full error-handling contract.
#
# PID/process lifecycle: `exec node server.js` (unchanged, still the last
# line of this script) means Node itself becomes this container's PID 1
# -- not a child of a surviving bash process. Once Node exits (gracefully
# on SIGTERM/SIGINT, which server.js now handles explicitly, or on a
# crash), the Linux kernel tears down every other process left in the
# same PID namespace, including the background warm-up job above if it's
# still running -- there is no scenario where that job outlives Node
# inside this container, and no scenario where Node isn't the process
# actually receiving the container runtime's signals.
# ═══════════════════════════════════════════════════════════════════════
set -eo pipefail

export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-3}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-2}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"

# Bounded wait -- a hung/never-starting Ollama used to loop this `until`
# forever, itself capable of starving Node's own startup indefinitely on
# top of the (separate) model-restore problem this fix addresses. Failing
# fast and loud here makes a genuinely broken Ollama visible in logs
# distinctly from "still restoring models", instead of looking identical.
wait_for_ollama() {
  local max_attempts="${1:-60}"  # 60 x 2s = 2 minutes
  local attempt=0
  until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then return 1; fi
    sleep 2
  done
  return 0
}

echo "==> Starting ollama serve..."
ollama serve &

echo "==> Waiting for ollama to accept requests (up to 2 minutes)..."
if wait_for_ollama 60; then
  echo "    ollama is up."
else
  echo "!! Ollama did not become reachable within the timeout -- starting the Node gateway"
  echo "!! anyway. engine/llm.js's own retry scheduler keeps probing Ollama independently"
  echo "!! of this script and will pick it up automatically if it comes up later."
fi

# The large, network-bound, potentially-failing model restoration now runs
# in its own background job -- never on Node's startup path. See
# scripts/salad-model-warmup.sh's own header for its full error-handling
# contract (never kills this script, Node, or the container on failure).
echo "==> Starting model warm-up in the background (scripts/salad-model-warmup.sh)..."
/app/scripts/salad-model-warmup.sh &

echo "==> Starting Python ML server on :3003 (DEVICE=${DEVICE:-cpu})..."
DEVICE="${DEVICE:-cpu}" python3 api_server.py > /tmp/mlserver.log 2>&1 &

echo "==> Starting Node gateway on :${PORT:-3002} (this becomes the container's foreground"
echo "    process; model warm-up continues in the background -- see /health for its status)..."
exec node server.js
