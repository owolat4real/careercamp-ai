#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# CAREER STUDIO — DEDICATED VIDEO POD bootstrap (SVD + SadTalker only)
# ═══════════════════════════════════════════════════════════════════════
# New pod (2026-08-28), created specifically to give CSVM's video
# generation (SVD + SadTalker) a full 47.4GB GPU to itself instead of
# sharing one with 5 resident Ollama LLM models + TTS -- that contention
# was the real, confirmed root cause of cinematic reels reliably OOM'ing
# past 4 scenes even after every code-level fix (concurrency lock,
# fragmentation env var, per-request eviction) was applied and verified.
# See services/directorBrain.js's own MAX_SCENES comment in cs_fixed for
# the full real-load-test history that led here.
#
# Deliberately does NOT install/start ollama, node server.js, tts_server.py,
# or api_server.py -- this pod only ever serves SVD_BASE_URL and
# TALKINGHEAD_BASE_URL, nothing else. No LLM/TTS/vision traffic should
# ever be routed here.
#
# Unlike start-all-with-recovery.sh, this is a first-time bootstrap for a
# genuinely brand-new pod -- _sadtalker_src doesn't exist yet at all
# (it's a gitignored vendored SadTalker clone per .gitignore's own
# comment; talkinghead/ is the real tracked source, reused here the same
# way talkinghead/setup.sh does, adapted from that script's Windows venv
# paths to this pod's real Linux ones). _svd_src IS directly tracked in
# git (confirmed via `git ls-files`), so a plain repo clone already
# provides it -- only its venv needs building here.
set -e

echo "=== 1. System packages ==="
apt-get update -qq
apt-get install -y -qq zstd pciutils lshw ffmpeg curl git

echo "=== 2. Clone careercamp-ai (if not already present) ==="
if [ ! -d /workspace/careercamp-ai ]; then
  git clone https://github.com/owolat4real/careercamp-ai.git /workspace/careercamp-ai
fi
cd /workspace/careercamp-ai

echo "=== 3. Bootstrap SadTalker (first-time clone, matches talkinghead/setup.sh) ==="
if [ ! -d _sadtalker_src ]; then
  git clone --depth 1 https://github.com/OpenTalker/SadTalker.git _sadtalker_src
  cd _sadtalker_src
  git apply --check "../talkinghead/patches/sadtalker-py312-windows-fixes.patch" 2>/dev/null \
    && git apply "../talkinghead/patches/sadtalker-py312-windows-fixes.patch" \
    || echo "Patch already applied or doesn't match — check manually if this is unexpected."
  cp "../talkinghead/talkinghead_server.py" "./talkinghead_server.py"

  mkdir -p checkpoints "gfpgan/weights"
  curl -sL "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/mapping_00109-model.pth.tar" -o "./checkpoints/mapping_00109-model.pth.tar"
  curl -sL "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/mapping_00229-model.pth.tar" -o "./checkpoints/mapping_00229-model.pth.tar"
  curl -sL "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/SadTalker_V0.0.2_256.safetensors" -o "./checkpoints/SadTalker_V0.0.2_256.safetensors"
  curl -sL "https://github.com/xinntao/facexlib/releases/download/v0.1.0/alignment_WFLW_4HG.pth" -o "./gfpgan/weights/alignment_WFLW_4HG.pth"
  curl -sL "https://github.com/xinntao/facexlib/releases/download/v0.1.0/detection_Resnet50_Final.pth" -o "./gfpgan/weights/detection_Resnet50_Final.pth"
  curl -sL "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth" -o "./gfpgan/weights/GFPGANv1.4.pth"
  curl -sL "https://github.com/xinntao/facexlib/releases/download/v0.2.2/parsing_parsenet.pth" -o "./gfpgan/weights/parsing_parsenet.pth"
  cd /workspace/careercamp-ai
fi
mkdir -p _sadtalker_src/personas

echo "=== 4. SadTalker venv ==="
if [ ! -d /root/sadtalker-venv ]; then
  python3 -m venv /root/sadtalker-venv
  ln -sfn /root/sadtalker-venv /workspace/careercamp-ai/_sadtalker_src/venv
  cd /workspace/careercamp-ai/_sadtalker_src
  ./venv/bin/pip install --upgrade pip >/dev/null 2>&1
  ./venv/bin/pip install torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cu121 >/dev/null 2>&1
  ./venv/bin/pip install --no-cache-dir -r ../talkinghead/requirements-py312.txt >/dev/null 2>&1
  rm -rf /root/.cache/pip
  cd /workspace/careercamp-ai
fi
ln -sfn /root/sadtalker-venv /workspace/careercamp-ai/_sadtalker_src/venv
# Same live basicsr/torchvision patch as start-all-with-recovery.sh — see
# that script's own comment for why this is resolved dynamically.
BASICSR_FILE=$(find /workspace/careercamp-ai/_sadtalker_src/venv/lib -maxdepth 5 -path '*/basicsr/data/degradations.py' 2>/dev/null | head -1)
[ -n "$BASICSR_FILE" ] && [ -f "$BASICSR_FILE" ] && sed -i \
  's/from torchvision.transforms.functional_tensor import rgb_to_grayscale/from torchvision.transforms.functional import rgb_to_grayscale/' \
  "$BASICSR_FILE"

echo "=== 5. SVD venv (checkpoint re-downloads on first generation call — lazy) ==="
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
  cd /workspace/careercamp-ai
fi
ln -sfn /root/svd-venv /workspace/careercamp-ai/_svd_src/venv

echo "=== 6. Starting services (SVD + talkinghead only) ==="
pkill -f 'svd_server.py' 2>/dev/null || true
pkill -f 'talkinghead_server.py' 2>/dev/null || true
sleep 2

cd /workspace/careercamp-ai/_sadtalker_src && nohup ./venv/bin/python talkinghead_server.py > /tmp/talkinghead.log 2>&1 &
disown
cd /workspace/careercamp-ai/_svd_src && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True nohup ./venv/bin/python svd_server.py > /tmp/svd.log 2>&1 &
disown
sleep 3

echo "=== 7. Starting video-pod watchdog ==="
cd /workspace/careercamp-ai/scripts && chmod +x video-pod-watchdog.sh && nohup ./video-pod-watchdog.sh > /tmp/watchdog.log 2>&1 &
disown
sleep 1

echo "=== 8. Health check ==="
sleep 30
for port in 3004 3005; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://localhost:${port}/health" || echo "000")
  echo "port ${port}: ${code}"
done

echo "=== Done ==="
