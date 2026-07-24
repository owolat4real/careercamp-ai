#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREER STUDIO — Self-Hosted Image-to-Video Server (Stable Video Diffusion, port 3005)
═══════════════════════════════════════════════════════════════════════

Persistent HTTP wrapper around _engine.py's SVD pipeline, for a
GPU pod that also runs Ollama + other model servers on the same card.

The single-GPU VRAM problem and how this solves it: SVD-XT's own
enable_model_cpu_offload() (already used in _engine.py) keeps its own
per-step footprint low by shuttling weights to CPU RAM between denoising
stages, but this pod's GPU is otherwise nearly full — Ollama's LLM
models, the Python ML server (BERT + TTS), and SadTalker's talking-head
server are all resident at once. Measured directly: with only Ollama's
models evicted there was still just ~1.8GB free and generation OOM'd —
the real headroom hog turns out to be the other two persistent Python
processes, not Ollama. So this evicts in two stages: first ask Ollama to
release its models (keep_alive=0 against a 1-token generate call —
reloads lazily on the next real chat request, no explicit reload code
needed), then actually stop the talking-head server process for the
duration of generation (it has no equivalent "release VRAM but stay up"
mode — its three model classes load once at import time and stay
resident until the process exits) and restart it fresh afterward.
Net effect: real local SVD without extra GPU rental, at the cost of a
brief talking-head cold-start after each video generation and a
one-time LLM reload delay on the next chat call.
"""

import io
import os
import re
import time
import signal
import logging
import subprocess
import tempfile

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import Response

import _engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("svd")

app = FastAPI(title="CareerStudio Image-to-Video Server")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
# Evicted before generation — reloads lazily on next real chat request,
# no explicit reload needed.
MODELS_TO_EVICT = ["cs-opus", "cs-sonnet", "cs-embed", "llava-phi3"]

MIN_FREE_MIB_TARGET = 12000  # measured SVD-XT peak (~10-11GB) + margin


def _free_mib() -> int:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip()
    return int(re.search(r"\d+", out).group())


def _evict_ollama():
    for model in MODELS_TO_EVICT:
        try:
            requests.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": model, "prompt": "", "keep_alive": 0},
                timeout=10,
            )
            logger.info(f"[SVD] Evicted {model} from VRAM to make room")
        except Exception as e:
            # Model may not be loaded yet, or Ollama momentarily busy —
            # either way this is a best-effort headroom step, not a
            # precondition generation can't proceed without.
            logger.warning(f"[SVD] Could not evict {model}: {e}")


# (pattern to pkill, cwd, argv, log path) for each auxiliary GPU process
# that can be safely stopped-and-restarted around a generation — unlike
# Ollama models these have no keep_alive=0 equivalent, their model
# classes load once at import time and stay resident until the process
# exits.
AUX_SERVERS = [
    (
        "talkinghead_server.py",
        "/workspace/careercamp-ai/_sadtalker_src",
        ["./venv/bin/python", "talkinghead_server.py"],
        "/tmp/talkinghead.log",
    ),
    (
        "python3 api_server.py",
        "/workspace/careercamp-ai",
        ["python3", "api_server.py"],
        "/tmp/mlserver.log",
    ),
]


def _stop_aux_servers() -> list:
    """Stops each auxiliary server in turn, checking free VRAM after each,
    so only as many get sacrificed as are actually needed. Returns the
    list of (cwd, argv, log) tuples that were actually stopped, to
    restart afterward."""
    stopped = []
    for pattern, cwd, argv, log in AUX_SERVERS:
        if _free_mib() >= MIN_FREE_MIB_TARGET:
            break
        result = subprocess.run(["pkill", "-f", pattern])
        if result.returncode == 0:
            stopped.append((cwd, argv, log))
            # Give CUDA a moment to actually release the freed allocations
            # — pkill returning doesn't guarantee the driver has reclaimed
            # VRAM yet on the very next query.
            for _ in range(20):
                time.sleep(0.5)
                if _free_mib() >= MIN_FREE_MIB_TARGET:
                    break
            logger.info(f"[SVD] Stopped '{pattern}', free VRAM now {_free_mib()}MiB")
    return stopped


def _restart_aux_servers(stopped: list):
    for cwd, argv, log in stopped:
        subprocess.Popen(
            argv, cwd=cwd,
            stdout=open(log, "a"), stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        logger.info(f"[SVD] Restarting {' '.join(argv)} in background")


def _make_room():
    _evict_ollama()
    return _stop_aux_servers()


@app.get("/health")
async def health():
    import torch
    return {
        "status": "ok",
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "service": "svd-selfhosted",
        "pipeline_loaded": _engine._pipe is not None,
    }


@app.post("/v1/video/image-to-video")
async def image_to_video(
    image: UploadFile = File(...),
    motion_bucket_id: int = Form(default=127),
    cfg_scale: float = Form(default=1.8),
    seed: int = Form(default=0),
    fps: int = Form(default=7),
):
    t0 = time.time()
    image_bytes = await image.read()

    stopped_servers = _make_room()

    try:
        video_bytes = _engine.generate(
            image_bytes,
            motion_bucket_id=motion_bucket_id,
            cfg_scale=cfg_scale,
            seed=seed,
            fps=fps,
        )
    except Exception as e:
        logger.warning(f"[SVD] Generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=503, detail=str(e))
    finally:
        _restart_aux_servers(stopped_servers)

    elapsed = round(time.time() - t0, 1)
    logger.info(f"[SVD] Generated video in {elapsed}s")
    return Response(
        content=video_bytes,
        media_type="video/mp4",
        headers={
            "X-Inference-Seconds": str(elapsed),
            "X-Engine": "svd-selfhosted",
        },
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3005)
