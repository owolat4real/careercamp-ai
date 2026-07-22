#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREER STUDIO — Self-hosted video generation, RunPod Serverless entrypoint
═══════════════════════════════════════════════════════════════════════

Same job-queue shape as _sadtalker_src/ and _xtts_src/: JSON in, JSON out,
output uploaded to S3 and returned as a URL.

Input: job['input']['image_base64'] — the still frame to animate
       (Pollinations.ai, generated Node-side before submitting this job —
       see cs_fixed/services/videoGen.js).

See cs_fixed/services/videoGen.js for the Node-side client that submits
to /run and polls /status against this handler's output shape — it tries
this INTERNAL engine first and only falls back to Stability AI's hosted
API if this endpoint is unconfigured, unreachable, or fails.
"""

import os
import time
import base64
import logging
import uuid

import boto3
import runpod

import _engine

logger = logging.getLogger("svd-runpod")

_s3 = None


def _s3_client():
    global _s3
    if _s3 is not None:
        return _s3
    key = os.environ.get("AWS_ACCESS_KEY_ID")
    if not key:
        return None
    _s3 = boto3.client(
        "s3",
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        aws_access_key_id=key,
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )
    return _s3


def _upload_video(video_bytes: bytes) -> str:
    bucket = os.environ.get("AWS_S3_BUCKET", "career-studio-uploads")
    key = f"media/self-hosted-video/{uuid.uuid4().hex}.mp4"
    s3 = _s3_client()
    if not s3:
        raise RuntimeError("AWS_ACCESS_KEY_ID not set — cannot upload rendered video")
    s3.put_object(Bucket=bucket, Key=key, Body=video_bytes, ContentType="video/mp4")
    cf = os.environ.get("AWS_CLOUDFRONT_URL")
    if cf:
        return f"{cf.rstrip('/')}/{key}"
    return f"https://{bucket}.s3.amazonaws.com/{key}"


def handler(job):
    t0 = time.time()
    job_input = job.get("input") or {}
    image_b64 = job_input.get("image_base64")
    motion_bucket_id = job_input.get("motion_bucket_id", 127)
    cfg_scale = job_input.get("cfg_scale", 1.8)
    seed = job_input.get("seed", 0)

    if not image_b64:
        return {"error": "image_base64 is required"}

    try:
        image_bytes = base64.b64decode(image_b64)
        video_bytes = _engine.generate(image_bytes, motion_bucket_id, cfg_scale, seed)
        elapsed = round(time.time() - t0, 1)
        video_url = _upload_video(video_bytes)
        logger.info(f"[SVD] Generated + uploaded video in {elapsed}s")
        return {
            "video_url": video_url,
            "engine": "self-hosted-svd-runpod-serverless",
            "inferenceSeconds": elapsed,
        }
    except Exception as e:
        logger.warning(f"[SVD] Generation failed: {e}", exc_info=True)
        return {"error": str(e)}


runpod.serverless.start({"handler": handler})
