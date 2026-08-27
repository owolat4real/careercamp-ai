#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# CAREER STUDIO — Full pod recovery + startup script
# ═══════════════════════════════════════════════════════════════════════
#
# Run this after ANY pod restart (whether triggered by us or by RunPod's
# own infrastructure) — the container's local disk (everything outside
# /workspace) does not survive a restart, but /workspace itself does.
# Model weights and checkpoints (Ollama models, SadTalker's checkpoints/
# gfpgan) already live under /workspace/careercamp-ai and survive on
# their own — only the installed *packages* (venvs, apt packages, the
# HuggingFace-cached SVD checkpoint) need reinstalling here.
#
# A backup-and-restore approach for the venvs was tried and abandoned:
# /workspace has a real (if invisible to `df`) per-pod write quota that
# a ~12GB venv backup exceeded. Reinstalling from PyPI directly takes a
# few minutes per venv, which turned out to be perfectly fine — not
# worth the quota fight.
set -e

# POD_NAME identifies which pod this is (e.g. "pod1", "pod2") — required
# so a second pod doesn't collide with the first on Cloudflare Tunnel
# hostnames (2026-08-23, added alongside the second-GPU-pod rollout, see
# .claude/plans/serene-floating-coral.md). pod1 needs no environment
# change: it falls back to today's plain CLOUDFLARE_TUNNEL_TOKEN/hostnames
# when POD_NAME is unset or literally "pod1".
#
# Real gap found live (2026-08-27): this used to hard-fail the ENTIRE
# script (via bash's ${VAR:?msg}, under set -e) if the pod-specific
# tunnel token wasn't set -- which a freshly recreated pod instance
# never has, since only /workspace survives a pod recreation, not the
# old instance's own shell environment. That meant a brand-new pod2
# could never get ollama/the gateway/the ML server started at all over
# one missing Cloudflare token, even though production's real AI
# traffic doesn't route through these Cloudflare hostnames at all
# (confirmed live: Render's CS_INFERENCE_URL_POD1/POD2 point directly at
# RunPod's own *.proxy.runpod.net URLs). Downgraded to a warning: the
# tunnel is skipped (see the guard near the bottom) rather than blocking
# every other service on this pod.
POD_NAME="${POD_NAME:-pod1}"
if [ "$POD_NAME" = "pod1" ]; then
  TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
  LLM_HOST="llm.careerstudiomax.com"; VIDEO_HOST="video.careerstudiomax.com"; SVD_HOST="svd.careerstudiomax.com"
else
  TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN_POD2:-}"
  LLM_HOST="llm2.careerstudiomax.com"; VIDEO_HOST="video2.careerstudiomax.com"; SVD_HOST="svd2.careerstudiomax.com"
fi
if [ -z "$TUNNEL_TOKEN" ]; then
  echo "⚠️  No Cloudflare Tunnel token set for POD_NAME=$POD_NAME -- skipping the tunnel (ollama/gateway/ML server are unaffected; production doesn't route through it)."
fi

echo "=== 1. System packages ==="
command -v ollama >/dev/null || {
  apt-get update -qq
  apt-get install -y -qq zstd pciutils lshw ffmpeg curl
}
command -v node >/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
}
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
command -v cloudflared >/dev/null || {
  curl -fsSL -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
}

echo "=== 2. SadTalker venv ==="
if [ ! -d /root/sadtalker-venv ]; then
  python3 -m venv /root/sadtalker-venv
  ln -sfn /root/sadtalker-venv /workspace/careercamp-ai/_sadtalker_src/venv
  cd /workspace/careercamp-ai/_sadtalker_src
  ./venv/bin/pip install --upgrade pip >/dev/null 2>&1
  ./venv/bin/pip install torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cu121 >/dev/null 2>&1
  ./venv/bin/pip install --no-cache-dir -r ../talkinghead/requirements-py312.txt >/dev/null 2>&1
  rm -rf /root/.cache/pip
fi
ln -sfn /root/sadtalker-venv /workspace/careercamp-ai/_sadtalker_src/venv
# basicsr's bundled torchvision API call is one version behind what's
# actually installed — patch applies fresh every time the venv is
# recreated. Idempotent: sed just no-ops if already patched.
# Real fix (2026-08-23): this was hardcoded to python3.11, but a fresh
# `python3 -m venv` on this image actually creates a python3.12 venv --
# confirmed live (both pod1 and pod2's real venvs use lib/python3.12/,
# not python3.11/), so this patch was silently never applying and
# basicsr's import of the real, live install would still have failed.
# Resolved dynamically instead of hardcoding a version that can drift
# again on a future base-image change.
BASICSR_FILE=$(find /workspace/careercamp-ai/_sadtalker_src/venv/lib -maxdepth 5 -path '*/basicsr/data/degradations.py' 2>/dev/null | head -1)
[ -n "$BASICSR_FILE" ] && [ -f "$BASICSR_FILE" ] && sed -i \
  's/from torchvision.transforms.functional_tensor import rgb_to_grayscale/from torchvision.transforms.functional import rgb_to_grayscale/' \
  "$BASICSR_FILE"

echo "=== 3. SVD venv (checkpoint re-downloads on first generation call — lazy) ==="
if [ ! -d /root/svd-venv ]; then
  python3 -m venv /root/svd-venv
  ln -sfn /root/svd-venv /workspace/careercamp-ai/_svd_src/venv
  cd /workspace/careercamp-ai/_svd_src
  ./venv/bin/pip install --upgrade pip >/dev/null 2>&1
  ./venv/bin/pip install torch==2.4.1 torchvision==0.19.1 \
    --index-url https://download.pytorch.org/whl/cu121 >/dev/null 2>&1
  ./venv/bin/pip install --no-cache-dir numpy==1.26.4 diffusers==0.31.0 transformers==4.46.3 \
    accelerate==1.1.1 safetensors==0.4.5 imageio==2.36.0 imageio-ffmpeg==0.5.1 Pillow==10.4.0 \
    fastapi uvicorn python-multipart >/dev/null 2>&1
  rm -rf /root/.cache/pip
fi
ln -sfn /root/svd-venv /workspace/careercamp-ai/_svd_src/venv

echo "=== 4. Node.js gateway deps (node_modules lives on /workspace, survives) ==="
cd /workspace/careercamp-ai && npm install --no-audit --no-fund >/dev/null 2>&1 || true

echo "=== 5. Python ML server deps ==="
# Real bug caught live (2026-08-23), on a genuinely fresh full-pod restart
# (the exact scenario this whole script exists for): this image's system
# Python now enforces PEP 668 ("externally-managed-environment") -- a
# plain `pip3 install` at the system level fails outright with no GPU/
# network/disk cause, and since it's piped to >/dev/null 2>&1 under
# `set -e`, the script died here with ZERO log output explaining why,
# looking like a silent hang. --break-system-packages is the standard,
# correct override for an intentional system-wide install like this one
# (not a venv -- api_server.py is meant to run against the system
# interpreter, matching how it's invoked in step 6 below).
python3 -c "import fastapi" 2>/dev/null || {
  cd /workspace/careercamp-ai
  grep -vE '^openai-whisper|^datasets|^pandas==' requirements.txt > /tmp/requirements-trimmed.txt
  pip3 install -r /tmp/requirements-trimmed.txt --ignore-installed blinker --break-system-packages >/dev/null 2>&1
}

# Real gap found live (2026-08-24): tts_server.py existed in this repo,
# deliberately isolated in its own venv (torch==2.6.0/transformers==5.2.0,
# incompatible with api_server.py's shared venv -- see this file's own
# header comment), but was NEVER added here -- it simply never ran on
# either pod, so every voice request silently fell through to the
# "browser TTS" JSON fallback (services/voiceSynth.js's callers saw
# voiceAvailable:false on every real request). Idempotent: only runs the
# real install (torch download + chatterbox-tts, several GB) if venv-tts
# doesn't already have it. TMPDIR/pip cache-dir/HF_HOME are all redirected
# to /workspace -- the container's own root disk is only ~30GB and pip's
# default cache + HuggingFace's default model cache both live on it,
# confirmed live to genuinely exhaust it (ENOSPC) on both pods otherwise;
# /workspace is a much larger persistent network volume.
cd /workspace/careercamp-ai
./venv-tts/bin/python -c "import chatterbox" 2>/dev/null || {
  python3 -m venv venv-tts
  mkdir -p /workspace/pip_tmp /workspace/pip_cache
  TMPDIR=/workspace/pip_tmp ./venv-tts/bin/pip install --no-cache-dir --cache-dir=/workspace/pip_cache \
    torch==2.6.0 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 >/dev/null 2>&1
  TMPDIR=/workspace/pip_tmp ./venv-tts/bin/pip install --no-cache-dir --cache-dir=/workspace/pip_cache \
    chatterbox-tts fastapi uvicorn >/dev/null 2>&1
}

echo "=== 6. Starting all services ==="
pkill -f 'ollama serve' 2>/dev/null || true
pkill -f 'node server.js' 2>/dev/null || true
pkill -f 'cloudflared tunnel' 2>/dev/null || true
pkill -f 'python3 api_server.py' 2>/dev/null || true
pkill -f 'talkinghead_server.py' 2>/dev/null || true
pkill -f 'svd_server.py' 2>/dev/null || true
pkill -f 'tts_server.py' 2>/dev/null || true
sleep 2

# Real fix (2026-08-23): this inline invocation had drifted from
# /root/start_ollama.sh's real, live-tuned values (OLLAMA_NUM_PARALLEL=1
# here vs. =4 there, no OLLAMA_KV_CACHE_TYPE/OLLAMA_MAX_QUEUE at all) --
# a full pod restart run through THIS script (the documented recovery
# path) would have silently reverted that day's live capacity fix. Synced
# to match. OLLAMA_MAX_LOADED_MODELS=4 was also live-fixed today (was 2,
# see /root/start_ollama.sh's own history) -- already correct here, kept.
OLLAMA_MODELS=/workspace/ollama-models OLLAMA_MAX_LOADED_MODELS=4 OLLAMA_NUM_PARALLEL=4 \
  OLLAMA_KEEP_ALIVE=-1 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_MAX_QUEUE=512 \
  nohup ollama serve > /tmp/ollama.log 2>&1 &
disown
sleep 5

# TTS_SERVER_URL=http://localhost:3006 -- tts_server.py binds
# TTS_SERVER_PORT (below), deliberately NOT 3004 (talkinghead_server.py
# already owns that port; tts_server.py's own header comment says 3004
# but that was never actually reconciled against talkinghead's real
# claim on it, confirmed live 2026-08-24). engine/voice.js needs this
# env var so it targets the real port instead of the wrong default.
cd /workspace/careercamp-ai && TTS_SERVER_URL=http://localhost:3006 nohup node server.js > /tmp/gateway.log 2>&1 &
disown
cd /workspace/careercamp-ai && COQUI_TOS_AGREED=1 nohup python3 api_server.py > /tmp/mlserver.log 2>&1 &
disown
cd /workspace/careercamp-ai/_sadtalker_src && nohup ./venv/bin/python talkinghead_server.py > /tmp/talkinghead.log 2>&1 &
disown
# PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True (2026-08-27): live-
# caught a genuine CUDA OOM on scene 7 of an 8-scene cinematic reel
# (907MB free of 47.4GB total) with PyTorch's own error message
# explicitly recommending this exact setting for fragmentation --
# enable_model_cpu_offload() cycles submodules on/off GPU on every one of
# SVD's many sequential generations within this one long-lived process,
# and CUDA's default allocator doesn't always reclaim the resulting
# fragmented free blocks efficiently across that many cycles. Expandable
# segments let the allocator grow/shrink existing reservations instead of
# always hunting for a new contiguous block, directly targeting this.
cd /workspace/careercamp-ai/_svd_src && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True nohup ./venv/bin/python svd_server.py > /tmp/svd.log 2>&1 &
disown
cd /workspace/careercamp-ai && HF_HOME=/workspace/hf_cache TTS_SERVER_PORT=3006 nohup ./venv-tts/bin/python tts_server.py > /tmp/tts_server.log 2>&1 &
disown
sleep 3

# Real gap found live (2026-08-27): talkinghead_server.py crashed from a
# CUDA OOM under heavy load and sat dead for over an hour, unnoticed --
# none of the 4 aux Python servers above have any restart-on-crash
# supervision. This plain polling watchdog fixes that going forward
# without changing how the container itself boots (see the script's own
# header for why that specific approach is deliberately avoided here).
cd /workspace/careercamp-ai/scripts && chmod +x aux-server-watchdog.sh && nohup ./aux-server-watchdog.sh > /tmp/watchdog.log 2>&1 &
disown
sleep 1

# CLOUDFLARE_TUNNEL_TOKEN (pod1) / CLOUDFLARE_TUNNEL_TOKEN_POD2 (pod2)
# must be set in the shell environment before running this script — not
# hardcoded here. TUNNEL_TOKEN resolved by POD_NAME above. Skipped
# entirely (not just left to fail) when unset -- see the warning above.
if [ -n "$TUNNEL_TOKEN" ]; then
  nohup cloudflared tunnel run --token "$TUNNEL_TOKEN" > /tmp/cloudflared.log 2>&1 &
  disown
fi
sleep 10

echo "=== 7. Health check ==="
OLLAMA_MODELS=/workspace/ollama-models ollama ps
# Real bug found live (2026-08-24): this always curled the Node app's
# hardcoded 3002 fallback (server.js's own `process.env.PORT ||
# process.env.CAREERCAMP_PORT || 3002`), but both pods' real .env sets
# CAREERCAMP_PORT=19123, confirmed live via /proc/<pid>/environ and a
# real netstat — the gateway has never actually listened on 3002 here.
# This summary line has been silently checking the wrong port on every
# boot; read the real value from .env instead of a second hardcoded
# guess that can drift from it again.
GATEWAY_PORT=$(grep -m1 '^CAREERCAMP_PORT=' /workspace/careercamp-ai/.env 2>/dev/null | cut -d= -f2)
GATEWAY_PORT="${GATEWAY_PORT:-3002}"
curl -s "http://localhost:$GATEWAY_PORT/health" -o /dev/null -w "gateway    ($GATEWAY_PORT): %{http_code}\n"
curl -s http://localhost:3003/health -o /dev/null -w 'ml-server  (3003): %{http_code}\n'
curl -s http://localhost:3004/health -o /dev/null -w 'talkinghead(3004): %{http_code}\n'
curl -s http://localhost:3005/health -o /dev/null -w 'svd        (3005): %{http_code}\n'
curl -s -X POST http://localhost:3006/v1/tts -H 'Content-Type: application/json' -d '{"text":"ok"}' -o /dev/null -w 'tts        (3006): %{http_code} (200 once the model is warm; POST-only, no /health route)\n'

echo ""
echo "Public URLs (stable, named Cloudflare Tunnel — $POD_NAME):"
echo "  https://$LLM_HOST"
echo "  https://$VIDEO_HOST"
echo "  https://$SVD_HOST"
