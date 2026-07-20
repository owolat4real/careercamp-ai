#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# CAREER STUDIO — Self-Hosted Talking-Head Video Setup (SadTalker)
# ═══════════════════════════════════════════════════════════════════════
#
# Reproduces the self-hosted talking-avatar video engine from scratch:
# clones SadTalker (open-source, https://github.com/OpenTalker/SadTalker),
# applies the Python-3.12/Windows compatibility patches captured in
# patches/sadtalker-py312-windows-fixes.patch, sets up an isolated venv
# (deliberately separate from careercamp-ai's main Python environment —
# SadTalker's pinned dependency versions conflict with it), and downloads
# the model checkpoints + a standalone ffprobe binary.
#
# Run from careercamp-ai/talkinghead/.
set -e

cd "$(dirname "$0")"
SADTALKER_DIR="../_sadtalker_src"

if [ ! -d "$SADTALKER_DIR" ]; then
  git clone --depth 1 https://github.com/OpenTalker/SadTalker.git "$SADTALKER_DIR"
fi

cd "$SADTALKER_DIR"
git apply --check "../talkinghead/patches/sadtalker-py312-windows-fixes.patch" 2>/dev/null \
  && git apply "../talkinghead/patches/sadtalker-py312-windows-fixes.patch" \
  || echo "Patch already applied or doesn't match — check manually if this is unexpected."

cp "../talkinghead/talkinghead_server.py" "./talkinghead_server.py"

python -m venv venv
./venv/Scripts/python.exe -m pip install --upgrade pip
./venv/Scripts/python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
./venv/Scripts/python.exe -m pip install -r "../talkinghead/requirements-py312.txt"
./venv/Scripts/python.exe -m pip install fastapi uvicorn python-multipart

# Model checkpoints (~1GB) + face-enhancer weights (~750MB)
mkdir -p checkpoints "gfpgan/weights"
curl -sL "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/mapping_00109-model.pth.tar" -o "./checkpoints/mapping_00109-model.pth.tar"
curl -sL "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/mapping_00229-model.pth.tar" -o "./checkpoints/mapping_00229-model.pth.tar"
curl -sL "https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc/SadTalker_V0.0.2_256.safetensors" -o "./checkpoints/SadTalker_V0.0.2_256.safetensors"
curl -sL "https://github.com/xinntao/facexlib/releases/download/v0.1.0/alignment_WFLW_4HG.pth" -o "./gfpgan/weights/alignment_WFLW_4HG.pth"
curl -sL "https://github.com/xinntao/facexlib/releases/download/v0.1.0/detection_Resnet50_Final.pth" -o "./gfpgan/weights/detection_Resnet50_Final.pth"
curl -sL "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth" -o "./gfpgan/weights/GFPGANv1.4.pth"
curl -sL "https://github.com/xinntao/facexlib/releases/download/v0.2.2/parsing_parsenet.pth" -o "./gfpgan/weights/parsing_parsenet.pth"

# Standalone ffprobe (~138MB) — pydub needs it separately from ffmpeg
# (imageio-ffmpeg only bundles ffmpeg, not ffprobe); see talkinghead_server.py's
# comments for why this can't just be monkeypatched around.
mkdir -p ffprobe_bin
curl -sL "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-n7.1-latest-win64-gpl-7.1.zip" -o /tmp/ffmpeg_build.zip
./venv/Scripts/python.exe -c "
import zipfile
z = zipfile.ZipFile('/tmp/ffmpeg_build.zip')
name = [n for n in z.namelist() if n.endswith('ffprobe.exe')][0]
with z.open(name) as src, open('ffprobe_bin/ffprobe.exe', 'wb') as dst:
    dst.write(src.read())
"
rm -f /tmp/ffmpeg_build.zip

# Drop persona photos in here before starting the server for real use —
# see README.md. Falls back to the bundled SadTalker example portrait
# when a persona-specific photo is missing.
mkdir -p personas

echo ""
echo "Setup complete. Start the server with:"
echo "  cd $SADTALKER_DIR && ./venv/Scripts/python.exe talkinghead_server.py"
