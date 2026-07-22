#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
XTTS-v2 VOICE SYNTHESIS ENGINE — RunPod Serverless build
═══════════════════════════════════════════════════════════════════════

Extracted out of api_server.py's load_tts()/`/v1/tts` (the always-on
multi-purpose ML server at port 3003, which also carries BERT/LLaVA/
Whisper) so voice synthesis for Cinematic Reels can run as its own
scale-to-zero RunPod Serverless worker instead of requiring that whole
gateway process (and its GPU) to stay resident 24/7 — the same
bursty-job-vs-always-on-service split already applied to talking-head
video (see _sadtalker_src/).

Speaker names are the same VERIFIED real XTTS-v2 built-in speakers used
by engine/voice.js's VOICES map (confirmed against the actual
speakers_xtts.pth checkpoint, not guessed) — kept in sync manually since
this is a separate deployable, not a shared import, across the Node/
Python boundary.
"""

import os

_model = None

VOICES = {
    "career-coach": "Alison Dietlinde",
    "interviewer":  "Damien Black",
    "mentor":       "Viktor Eka",
    "analyst":      "Alexandra Hisakawa",
}

# Mirrors careercamp-ai/engine/voice.js's SUPPORTED_LANGUAGES exactly —
# XTTS-v2's real supported-language list, not a guess.
SUPPORTED_LANGUAGES = [
    "en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko", "hi",
]


def _load_model():
    global _model
    if _model is not None:
        return _model
    from TTS.api import TTS
    device = "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES", "0") != "" else "cpu"
    _model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    return _model


def synthesize(text: str, voice: str = "career-coach", language: str = "en") -> bytes:
    """
    Synthesize speech and return raw WAV bytes.
    Raises ValueError if `language` isn't in SUPPORTED_LANGUAGES — callers
    should check that before submitting a job rather than let XTTS-v2
    silently mispronounce an unsupported language.
    """
    if language not in SUPPORTED_LANGUAGES:
        raise ValueError(f"XTTS-v2 does not support language '{language}'. Supported: {SUPPORTED_LANGUAGES}")

    model = _load_model()
    speaker = VOICES.get(voice, VOICES["career-coach"])

    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        model.tts_to_file(text=text, speaker=speaker, language=language, file_path=out_path)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except Exception:
            pass
