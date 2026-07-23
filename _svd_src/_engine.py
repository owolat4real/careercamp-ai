#!/usr/bin/env python3
# CI trigger nudge — no functional change.
"""
═══════════════════════════════════════════════════════════════════════
SELF-HOSTED STABLE VIDEO DIFFUSION ENGINE — RunPod Serverless build
═══════════════════════════════════════════════════════════════════════

The INTERNAL video-generation model: image → short video clip, using
Stability AI's own OPEN-WEIGHT checkpoint (stable-video-diffusion-img2vid-xt,
freely downloadable from HuggingFace) run on our own GPU via `diffusers`,
instead of paying per-call for Stability's HOSTED API. Same underlying
model family as the hosted API cs_fixed/services/videoGen.js already
calls — this just runs it ourselves.

Division of labour, matching the existing hosted pipeline exactly: this
engine only does image → video. The still frame is generated separately
via Pollinations.ai (free, no key — see videoGen.js's _submitInternal
helper) since self-hosting a second model just for the still frame would
duplicate a capability that's already free and instant.
"""

import io
import os

import torch
from PIL import Image

_pipe = None


def _load_pipeline():
    global _pipe
    if _pipe is not None:
        return _pipe
    from diffusers import StableVideoDiffusionPipeline
    _pipe = StableVideoDiffusionPipeline.from_pretrained(
        "stabilityai/stable-video-diffusion-img2vid-xt",
        torch_dtype=torch.float16,
        variant="fp16",
    )
    # Offloads model weights to CPU between denoising steps — SVD-XT's
    # peak VRAM footprint is otherwise steep enough to need an A100-class
    # card; this trades some speed for running on a wider range of RunPod
    # GPU tiers, matching the "occasional use, not always-on" economics
    # that justified RunPod Serverless over a persistent Pod in the first
    # place (see _sadtalker_src/Dockerfile.runpod's rationale).
    _pipe.enable_model_cpu_offload()
    return _pipe


def generate(image_bytes: bytes, motion_bucket_id: int = 127, cfg_scale: float = 1.8, seed: int = 0, fps: int = 7) -> bytes:
    """
    @param image_bytes: the still frame (JPEG/PNG) to animate.
    @param motion_bucket_id: 0-255, SVD's own native motion-amount control.
    @param cfg_scale: mapped onto SVD's max_guidance_scale — not a 1:1
      match to Stability's hosted-API parameter of the same name (SVD's
      real analogue is a min/max guidance range, not a single scale), but
      close enough to give the same "more/less adherence to the still
      frame" knob callers already expect.
    @param seed: 0 means unseeded (non-deterministic).
    @param fps: output frame rate.
    @returns: MP4 bytes.
    """
    from diffusers.utils import export_to_video

    pipe = _load_pipeline()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((1024, 576))

    generator = torch.manual_seed(seed) if seed else None
    frames = pipe(
        image,
        decode_chunk_size=8,
        generator=generator,
        motion_bucket_id=max(0, min(255, motion_bucket_id)),
        max_guidance_scale=max(1.0, min(4.0, cfg_scale)),
    ).frames[0]

    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        out_path = tmp.name
    try:
        export_to_video(frames, out_path, fps=fps)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except Exception:
            pass
