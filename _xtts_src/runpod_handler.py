#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREER STUDIO — Cinematic Reel Voice Synthesis, RunPod Serverless entrypoint
═══════════════════════════════════════════════════════════════════════

Same job-queue shape as _sadtalker_src/runpod_handler.py: JSON in, JSON
out, output uploaded to S3 and returned as a URL rather than embedded
base64 (RunPod's own guidance for outputs of any real size).

See cs_fixed/services/voiceSynth.js for the Node-side client that
submits to /run and polls /status against this handler's output shape.
"""

import os
import time
import logging
import uuid

import boto3
import runpod

import _engine

logger = logging.getLogger("xtts-runpod")

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


def _upload_audio(audio_bytes: bytes) -> str:
    bucket = os.environ.get("AWS_S3_BUCKET", "career-studio-uploads")
    key = f"media/cinematic-voice/{uuid.uuid4().hex}.wav"
    s3 = _s3_client()
    if not s3:
        raise RuntimeError("AWS_ACCESS_KEY_ID not set — cannot upload synthesised audio")
    s3.put_object(Bucket=bucket, Key=key, Body=audio_bytes, ContentType="audio/wav")
    cf = os.environ.get("AWS_CLOUDFRONT_URL")
    if cf:
        return f"{cf.rstrip('/')}/{key}"
    return f"https://{bucket}.s3.amazonaws.com/{key}"


def handler(job):
    t0 = time.time()
    job_input = job.get("input") or {}
    text = job_input.get("text")
    voice = job_input.get("voice") or "career-coach"
    language = job_input.get("language") or "en"

    if not text:
        return {"error": "text is required"}

    try:
        audio_bytes = _engine.synthesize(text, voice, language)
    except ValueError as e:
        # Unsupported language — an honest rejection, not a crash. The
        # Node-side caller (services/voiceSynth.js) treats any failure
        # here as voiceAvailable:false and falls back to captions.
        return {"error": str(e)}

    elapsed = round(time.time() - t0, 1)
    audio_url = _upload_audio(audio_bytes)
    logger.info(f"[XTTS] Synthesised + uploaded audio in {elapsed}s (voice={voice}, language={language})")
    return {
        "audio_url": audio_url,
        "engine": "xtts-v2-runpod-serverless",
        "inferenceSeconds": elapsed,
    }


runpod.serverless.start({"handler": handler})
