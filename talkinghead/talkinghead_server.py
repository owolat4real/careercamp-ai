#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREER STUDIO — Self-Hosted Talking-Head Video Server (SadTalker, port 3004)
═══════════════════════════════════════════════════════════════════════

Wraps SadTalker (https://github.com/OpenTalker/SadTalker, open-source) as a
persistent FastAPI service — the three heavy model classes (CropAndExtract,
Audio2Coeff, AnimateFromCoeff) load ONCE at startup instead of per-request,
unlike the CLI script this was adapted from.

This is the self-hosted PRIMARY engine for Cinematic Mode's talking-avatar
video, with HeyGen as external fallback when this is unavailable/fails —
see cs_fixed/services/talkingHead.js for that fallback wiring.

Honest, load-bearing limitation: no GPU is available in this environment.
CPU-only inference measured ~11-12s per rendered frame at 25fps during
testing — a several-second response can take many minutes to render.
This is NOT fast enough for a live interview turn-by-turn experience
without GPU hosting; treat it accordingly until GPU compute is available.

Personas: no real photo exists yet for any of the 12 interview personas
(see careercamp-ai's services/avatarInterview.js) — drop a
<persona_id>.png into the personas/ directory next to this file to enable
a given persona. Falls back to the bundled SadTalker example portrait
(examples/source_image/art_0.png) when a persona-specific photo is
missing, clearly reported via the `source` field in the response so
callers never mistake a placeholder for a real persona photo.
"""

import os
import re
import sys
import time
import shutil
import logging
import tempfile
import subprocess
from glob import glob

import requests
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from time import strftime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("talkinghead")

# NOTE (2026-08-27): this file has drifted from what actually runs in
# production — the real pods run a refactored version at
# _sadtalker_src/talkinghead_server.py (gitignored, a vendored SadTalker
# clone per this repo's .gitignore) that delegates model loading/
# generation to a separate _engine.py, has no ffmpeg/pydub PATH-shimming
# (unneeded on the pods' Linux image), and now also has the VRAM-eviction
# fix below. This file is the setup.sh-driven Windows/dev copy and was
# not kept in sync. Reconciling the two into one real source of truth is
# a separate, larger task; this specific fix (eviction before model
# load) is mirrored here so this file doesn't silently fall further
# behind on a real, live-caught crash fix.
#
# Live-caught (2026-08-27): the pod-deployed copy of this process
# crashed with "RuntimeError: CUDA error: out of memory" while loading
# its own models (see the model-loading section below) and had no
# supervisor to restart it -- it sat dead for over an hour, unnoticed.
# svd_server.py already has this exact pattern (_evict_ollama()) for its
# own model loading; duplicated here since this process needs the
# identical real fix: free VRAM from Ollama before loading heavy models,
# not after crashing.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MODELS_TO_EVICT = ["cs-opus", "cs-sonnet", "cs-embed", "llava-phi3"]
MIN_FREE_MIB_TARGET = 4000  # SadTalker's 3 model classes are far lighter than SVD-XT's ~10-11GB


def _free_mib() -> int:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip()
    return int(re.search(r"\d+", out).group())


def _evict_ollama_if_low():
    if _free_mib() >= MIN_FREE_MIB_TARGET:
        return
    logger.info(f"[TalkingHead] Only {_free_mib()}MiB free — evicting Ollama models for headroom")
    for model in MODELS_TO_EVICT:
        try:
            requests.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "prompt": "", "keep_alive": 0}, timeout=10)
        except Exception as e:
            logger.warning(f"[TalkingHead] Could not evict {model}: {e}")
    for _ in range(10):
        if _free_mib() >= MIN_FREE_MIB_TARGET:
            break
        time.sleep(0.5)
    logger.info(f"[TalkingHead] Free VRAM after eviction: {_free_mib()}MiB")


_evict_ollama_if_low()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# SadTalker's own facerender/animate.py uses pydub (AudioSegment) to trim
# and resample the driven audio. pydub shells out to bare "ffmpeg"/
# "ffprobe" commands via PATH by default — nothing configures that here,
# and there's no system-wide ffmpeg install, which surfaced as a bare
# "[WinError 2] The system cannot find the file specified" deep inside
# animate.py's generate() with no ffmpeg-specific error text at all.
#
# Two separate binaries needed pydub.AudioSegment.converter covers the
# ffmpeg side (bundled via imageio-ffmpeg, already a real dependency here),
# but pydub.utils.get_prober_name() has NO override hook at all — it's a
# hardcoded which("ffprobe") PATH lookup, and imageio-ffmpeg deliberately
# doesn't bundle ffprobe. Rather than monkeypatching pydub's internals,
# ffprobe_bin/ffprobe.exe (a real static build, downloaded once) is added
# to PATH here so pydub's own existing detection just finds it naturally.
import pydub
import imageio_ffmpeg
_ffmpeg_bin = imageio_ffmpeg.get_ffmpeg_exe()
pydub.AudioSegment.converter = _ffmpeg_bin
pydub.AudioSegment.ffmpeg = _ffmpeg_bin
pydub.utils.get_encoder_name = lambda: _ffmpeg_bin

_ffprobe_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ffprobe_bin')
os.environ['PATH'] = _ffprobe_dir + os.pathsep + os.environ.get('PATH', '')

from src.utils.preprocess import CropAndExtract
from src.test_audio2coeff import Audio2Coeff
from src.facerender.animate import AnimateFromCoeff
from src.generate_batch import get_data
from src.generate_facerender_batch import get_facerender_data
from src.utils.init_path import init_path

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
logger.info(f"[TalkingHead] Device: {DEVICE}")
if DEVICE == "cpu":
    logger.warning("[TalkingHead] No GPU detected — inference will be slow (many minutes per clip).")

ROOT = os.path.dirname(os.path.abspath(__file__))
PERSONAS_DIR = os.path.join(ROOT, "personas")
os.makedirs(PERSONAS_DIR, exist_ok=True)
PLACEHOLDER_IMAGE = os.path.join(ROOT, "examples", "source_image", "art_0.png")

# ── Load models once at startup ────────────────────────────
sadtalker_paths = init_path(
    os.path.join(ROOT, "checkpoints"),
    os.path.join(ROOT, "src", "config"),
    256, False, "crop",
)
preprocess_model = CropAndExtract(sadtalker_paths, DEVICE)
audio_to_coeff = Audio2Coeff(sadtalker_paths, DEVICE)
animate_from_coeff = AnimateFromCoeff(sadtalker_paths, DEVICE)
logger.info("[TalkingHead] Models loaded — ready")

app = FastAPI(title="CareerStudio Talking-Head Server")


def _resolve_persona_image(persona_id: str):
    if persona_id:
        for ext in (".png", ".jpg", ".jpeg"):
            candidate = os.path.join(PERSONAS_DIR, persona_id + ext)
            if os.path.exists(candidate):
                return candidate, "persona_photo"
    return PLACEHOLDER_IMAGE, "placeholder"


def _generate(source_image: str, audio_path: str, still: bool = True):
    save_dir = tempfile.mkdtemp(prefix="talkinghead_")
    try:
        first_frame_dir = os.path.join(save_dir, "first_frame_dir")
        os.makedirs(first_frame_dir, exist_ok=True)

        first_coeff_path, crop_pic_path, crop_info = preprocess_model.generate(
            source_image, first_frame_dir, "crop", source_image_flag=True, pic_size=256,
        )
        if first_coeff_path is None:
            raise RuntimeError("Could not extract 3DMM coefficients from source image")

        batch = get_data(first_coeff_path, audio_path, DEVICE, None, still=still)
        coeff_path = audio_to_coeff.generate(batch, save_dir, 0, None)

        data = get_facerender_data(
            coeff_path, crop_pic_path, first_coeff_path, audio_path,
            2, None, None, None,
            expression_scale=1.0, still_mode=still, preprocess="crop", size=256,
        )
        result = animate_from_coeff.generate(
            data, save_dir, source_image, crop_info,
            enhancer=None, background_enhancer=None, preprocess="crop", img_size=256,
        )

        with open(result, "rb") as f:
            video_bytes = f.read()
        return video_bytes
    finally:
        shutil.rmtree(save_dir, ignore_errors=True)


@app.get("/health")
async def health():
    return {"status": "ok", "device": DEVICE, "service": "talkinghead-sadtalker"}


@app.post("/v1/video/talking-head")
async def talking_head(audio: UploadFile = File(...), persona_id: str = Form(default="")):
    """
    Generate a talking-head video from an audio file (the caller is
    responsible for TTS — this only animates a face to match provided
    audio, same division of labour as HeyGen's voice+avatar pairing).
    """
    t0 = time.time()
    image_path, source = _resolve_persona_image(persona_id)

    # Live-caught (2026-08-28): a real cinematic reel (8 alternating
    # presenter/B-roll scenes) OOM'd on the LAST scene across 3 full runs
    # on a freshly-restarted, confirmed-clean pod -- not a leak (each run
    # started from ~0 used) or a race (already fixed), but genuine VRAM
    # creep over many sequential generations sharing one GPU with Ollama's
    # resident models. _evict_ollama_if_low() only ran once at process
    # startup before -- checking again before every real generation call
    # (matching svd_server.py's own per-request _make_room()) gives real
    # headroom back on later scenes instead of only ever having it on the
    # first one.
    _evict_ollama_if_low()

    tmp_audio = tempfile.NamedTemporaryFile(suffix=os.path.splitext(audio.filename or "audio.wav")[1] or ".wav", delete=False)
    try:
        tmp_audio.write(await audio.read())
        tmp_audio.close()

        video_bytes = _generate(image_path, tmp_audio.name)
        elapsed = round(time.time() - t0, 1)
        logger.info(f"[TalkingHead] Generated video in {elapsed}s (persona={persona_id or 'none'}, source={source})")

        return Response(
            content=video_bytes,
            media_type="video/mp4",
            headers={
                "X-Persona-Image-Source": source,
                "X-Inference-Seconds": str(elapsed),
                "X-Engine": "sadtalker-selfhosted",
            },
        )
    except Exception as e:
        logger.warning(f"[TalkingHead] Generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=503, detail=str(e))
    finally:
        try:
            os.unlink(tmp_audio.name)
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3004)
