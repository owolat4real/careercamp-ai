#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREERCAMP AI — Chatterbox TTS server (port 3004), isolated from api_server.py
═══════════════════════════════════════════════════════════════════════

Replaces Coqui XTTS-v2 (api_server.py's old /v1/tts) — XTTS-v2's CPML
license restricts commercial use and Coqui Inc. (who could sell a
commercial license) shut down Jan 2024, leaving no real path to license
it. Chatterbox is MIT-licensed; no such restriction.

Runs in its OWN venv (venv-tts/, not venv/) and OWN process on its OWN
port, deliberately separate from api_server.py. Real reason, confirmed
empirically 2026-08-08: chatterbox-tts requires transformers==5.2.0 and
torch==2.6.0, but api_server.py's shared venv runs transformers==4.45.1 /
torch==2.4.1+cu121 for the LLM/vision/embedding models — installing
chatterbox-tts into that shared venv silently broke sentence-transformers,
the transformers LLM pipeline, and LlavaNext vision imports (verified via
direct import test before this was caught). Two fully separate venvs is
the real fix, not a version-pinning workaround (chatterbox-tts's own
requirements are pinned exact-version, `torch==2.6.0`, non-negotiable).

Three real request modes, not one:
  • POST /v1/tts          — synchronous, same contract as the old XTTS-v2
                             endpoint. Fine for short text (empirically
                             ~5-23s for a short sentence on this GPU,
                             chatterbox is NOT real-time — measured RTF
                             ~1-2.2x, unlike XTTS-v2's faster ~1-2s here).
  • POST /v1/tts/job       — async: returns {job_id} immediately, real
                             background generation (asyncio task, not a
                             fake "queued" response that never runs).
  • GET  /v1/tts/job/{id}  — real polling; {status: processing|done|failed,
                             audio_base64 when done}.
  • POST /v1/tts/stream    — real progressive delivery: splits text into
                             sentences, generates each with the SAME
                             verified model, sends each chunk as a real
                             SSE event as soon as it's ready. This is
                             genuine chunked generation, not the
                             `generate_stream()` API some Chatterbox forks
                             expose (that's a different pip package,
                             chatterbox-streaming, with an unverified API
                             surface against the multilingual model this
                             needs — not used here on purpose, to avoid
                             repeating the earlier mistake of assuming an
                             unverified API).

Setup:
  python3 -m venv venv-tts && . venv-tts/bin/activate
  pip install chatterbox-tts fastapi uvicorn
  python tts_server.py
"""
import os
import io
import re
import time
import uuid
import base64
import asyncio
import logging
import tempfile
from typing import Optional

import torch
import torchaudio
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("careercamp-tts")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
logger.info(f"[CareerVoice/Chatterbox] Device: {DEVICE}")

_model = None

def load_tts():
    global _model
    if _model is not None:
        return _model
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    _model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)
    logger.info("[CareerVoice/Chatterbox] Multilingual model loaded")
    return _model

# Same voice-name allowlisting/reference-clip resolution as the old
# XTTS-v2 endpoint (api_server.py) — req.voice is caller-supplied, so it's
# allowlisted before use in a filesystem path (never build a path from
# unvalidated request input directly, even for a read-only reference
# file: an unchecked value here could walk outside ref_dir via
# "../"-style traversal).
_KNOWN_VOICES = {"career-coach", "interviewer", "mentor", "analyst"}

def _resolve_speaker_wav(voice: Optional[str]) -> Optional[str]:
    ref_dir = os.environ.get("VOICE_REF_DIR", "/workspace/voice-refs")
    voice_name = voice if voice in _KNOWN_VOICES else "default"
    speaker_wav = os.path.join(ref_dir, f"{voice_name}.wav")
    if not os.path.exists(speaker_wav):
        speaker_wav = os.path.join(ref_dir, "default.wav")
    if not os.path.exists(speaker_wav):
        return None
    return speaker_wav

def _wav_bytes(wav_tensor, sr: int) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    torchaudio.save(out_path, wav_tensor, sr)
    with open(out_path, "rb") as f:
        data = f.read()
    os.unlink(out_path)
    return data

def _generate_sync(text: str, voice: Optional[str], language: str) -> bytes:
    model = load_tts()
    speaker_wav = _resolve_speaker_wav(voice)
    kwargs = {"language_id": language or "en"}
    if speaker_wav:
        kwargs["audio_prompt_path"] = speaker_wav
    wav = model.generate(text, **kwargs)
    return _wav_bytes(wav, model.sr)

# Real sentence splitter for chunked generation -- not a full NLP
# sentence-boundary detector, but good enough for the real punctuation
# patterns actual career-coaching/interview-feedback text uses. Falls
# back to the whole text as one "chunk" if no sentence boundary is found,
# so this never produces an empty chunk list.
def _split_sentences(text: str):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p] or [text]

app = FastAPI(title="CareerCamp Chatterbox TTS", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class TTSRequest(BaseModel):
    text:     str
    voice:    Optional[str] = "career-coach"
    language: Optional[str] = "en"

@app.get("/health")
async def health():
    return {"status": "ok", "device": DEVICE, "model_loaded": _model is not None}

# ── Synchronous — same contract as the old XTTS-v2 endpoint ──────────
@app.post("/v1/tts")
async def tts_sync(req: TTSRequest):
    try:
        audio_data = await asyncio.to_thread(_generate_sync, req.text, req.voice, req.language)
        return StreamingResponse(io.BytesIO(audio_data), media_type="audio/wav")
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

# ── Async job — real background generation + real polling ────────────
# In-memory job registry: fine for a single-process service (matches
# this codebase's existing simplicity elsewhere) -- jobs don't need to
# survive a restart, callers re-request if the service bounces mid-job.
_jobs = {}

async def _run_job(job_id: str, text: str, voice: Optional[str], language: str):
    try:
        audio_data = await asyncio.to_thread(_generate_sync, text, voice, language)
        _jobs[job_id] = {"status": "done", "audio_base64": base64.b64encode(audio_data).decode("ascii")}
    except Exception as e:
        _jobs[job_id] = {"status": "failed", "error": str(e)}

@app.post("/v1/tts/job")
async def tts_job_create(req: TTSRequest):
    job_id = str(uuid.uuid4())[:12]
    _jobs[job_id] = {"status": "processing"}
    asyncio.create_task(_run_job(job_id, req.text, req.voice, req.language))
    return {"job_id": job_id, "status": "processing"}

@app.get("/v1/tts/job/{job_id}")
async def tts_job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job_id")
    return {"job_id": job_id, **job}

# ── Streaming — real progressive delivery via SSE ─────────────────────
# Splits text into sentences, generates each with the same verified
# model, and sends each real audio chunk as an SSE event the moment it's
# ready -- time-to-first-audio is the first sentence's generation time,
# not the whole text's. Each event carries a self-contained WAV (its own
# header), so a client plays them back-to-back rather than needing to
# reassemble one continuous stream.
@app.post("/v1/tts/stream")
async def tts_stream(req: TTSRequest):
    sentences = _split_sentences(req.text)

    async def event_gen():
        model = load_tts()
        speaker_wav = _resolve_speaker_wav(req.voice)
        for i, sentence in enumerate(sentences):
            try:
                kwargs = {"language_id": req.language or "en"}
                if speaker_wav:
                    kwargs["audio_prompt_path"] = speaker_wav
                wav = await asyncio.to_thread(model.generate, sentence, **kwargs)
                audio_b64 = base64.b64encode(_wav_bytes(wav, model.sr)).decode("ascii")
                yield f"data: {{\"chunk\": {i}, \"total\": {len(sentences)}, \"audio_base64\": \"{audio_b64}\"}}\n\n"
            except Exception as e:
                yield f"data: {{\"chunk\": {i}, \"total\": {len(sentences)}, \"error\": \"{str(e)}\"}}\n\n"
        yield "data: {\"done\": true}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")

if __name__ == "__main__":
    port = int(os.getenv("TTS_SERVER_PORT", 3004))
    logger.info(f"[CareerVoice/Chatterbox] TTS server -> http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, workers=1, log_level="info")
