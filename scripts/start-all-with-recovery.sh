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
BASICSR_FILE=/workspace/careercamp-ai/_sadtalker_src/venv/lib/python3.11/site-packages/basicsr/data/degradations.py
[ -f "$BASICSR_FILE" ] && sed -i \
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
python3 -c "import fastapi" 2>/dev/null || {
  cd /workspace/careercamp-ai
  grep -vE '^openai-whisper|^datasets|^pandas==' requirements.txt > /tmp/requirements-trimmed.txt
  pip3 install -r /tmp/requirements-trimmed.txt --ignore-installed blinker >/dev/null 2>&1
}

echo "=== 6. Starting all services ==="
pkill -f 'ollama serve' 2>/dev/null || true
pkill -f 'node server.js' 2>/dev/null || true
pkill -f 'cloudflared tunnel' 2>/dev/null || true
pkill -f 'python3 api_server.py' 2>/dev/null || true
pkill -f 'talkinghead_server.py' 2>/dev/null || true
pkill -f 'svd_server.py' 2>/dev/null || true
sleep 2

OLLAMA_MODELS=/workspace/ollama-models OLLAMA_MAX_LOADED_MODELS=4 OLLAMA_NUM_PARALLEL=1 \
  OLLAMA_KEEP_ALIVE=-1 OLLAMA_FLASH_ATTENTION=1 nohup ollama serve > /tmp/ollama.log 2>&1 &
disown
sleep 5

cd /workspace/careercamp-ai && nohup node server.js > /tmp/gateway.log 2>&1 &
disown
cd /workspace/careercamp-ai && COQUI_TOS_AGREED=1 nohup python3 api_server.py > /tmp/mlserver.log 2>&1 &
disown
cd /workspace/careercamp-ai/_sadtalker_src && nohup ./venv/bin/python talkinghead_server.py > /tmp/talkinghead.log 2>&1 &
disown
cd /workspace/careercamp-ai/_svd_src && nohup ./venv/bin/python svd_server.py > /tmp/svd.log 2>&1 &
disown
sleep 3

# CLOUDFLARE_TUNNEL_TOKEN must be set in the shell environment before
# running this script — not hardcoded here.
nohup cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" > /tmp/cloudflared.log 2>&1 &
disown
sleep 10

echo "=== 7. Health check ==="
OLLAMA_MODELS=/workspace/ollama-models ollama ps
curl -s http://localhost:3002/health -o /dev/null -w 'gateway    (3002): %{http_code}\n'
curl -s http://localhost:3003/health -o /dev/null -w 'ml-server  (3003): %{http_code}\n'
curl -s http://localhost:3004/health -o /dev/null -w 'talkinghead(3004): %{http_code}\n'
curl -s http://localhost:3005/health -o /dev/null -w 'svd        (3005): %{http_code}\n'

echo ""
echo "Public URLs (stable, named Cloudflare Tunnel):"
echo "  https://llm.careerstudiomax.com"
echo "  https://video.careerstudiomax.com"
echo "  https://svd.careerstudiomax.com"
