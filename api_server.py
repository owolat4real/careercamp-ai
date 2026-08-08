#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREERCAMP AI — Python ML Inference Server (port 3003)
═══════════════════════════════════════════════════════════════════════

Handles heavy ML workloads that Node.js cannot do efficiently:
  • BERT fine-tuning and inference (PyTorch)
  • LLaVA vision-language model (transformers)
  • Faster-Whisper STT (faster-whisper)
  • Coqui XTTS TTS (TTS library)
  • Full LLM inference via HuggingFace pipeline

FastAPI server — auto-starts when ollama is not sufficient.

Setup:
  pip install -r requirements.txt
  python api_server.py

GPU support: CUDA 11.8+ or ROCm 5.6+ (auto-detected)
CPU fallback: slower but functional on any machine
"""

import os
import io
import json
import logging
import asyncio
from contextlib import asynccontextmanager
from typing import Optional, List, Union
import base64

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("careercamp-ai")

# ── Device detection ───────────────────────────────────────
import torch
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
logger.info(f"[CareerCamp AI Python] Device: {DEVICE}")

# ── Lazy model loading (only load what's needed) ───────────
_models = {}

def get_model(key: str):
    return _models.get(key)

# ── VRAM eviction for the vision fallback tier ──────────────
# Mirrors _svd_src/svd_server.py's proven eviction pattern: Ollama's
# keep_alive:0 unloads a model lazily (reloads on next real chat request,
# no explicit reload code needed), and the driver's release is
# asynchronous, so poll _free_mib() briefly after asking rather than
# assuming it already landed.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MIN_FREE_MIB = 5000  # LLaVA-1.6-mistral-7B in 4-bit needs ~4GB + headroom
MODELS_TO_EVICT_FOR_VISION = ["cs-opus", "cs-sonnet", "cs-embed", "cs-haiku"]

def _free_mib() -> int:
    import subprocess, re
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip()
    return int(re.search(r"\d+", out).group())

def _make_room_for_vision():
    import requests, time
    if _free_mib() >= VISION_MIN_FREE_MIB:
        return
    for model in MODELS_TO_EVICT_FOR_VISION:
        try:
            requests.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "prompt": "", "keep_alive": 0}, timeout=10)
        except Exception as e:
            logger.warning(f"[CareerVision] Could not evict {model}: {e}")
    for _ in range(20):
        if _free_mib() >= VISION_MIN_FREE_MIB:
            break
        time.sleep(0.5)
    logger.info(f"[CareerVision] Free VRAM after eviction: {_free_mib()}MiB")

def load_bert_model():
    """Career BERT — sentence transformers for embeddings + NER"""
    if "bert" in _models: return _models["bert"]
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2", device=DEVICE)
    _models["bert"] = model
    logger.info("[CareerBERT] all-MiniLM-L6-v2 loaded")
    return model

def load_llm(model_name: str = "mistralai/Mistral-7B-Instruct-v0.3"):
    """Load LLM via HuggingFace"""
    if f"llm:{model_name}" in _models: return _models[f"llm:{model_name}"]
    from transformers import AutoTokenizer, AutoModelForCausalLM, pipeline
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16 if DEVICE == "cuda" else torch.float32,
        device_map="auto" if DEVICE == "cuda" else None,
        low_cpu_mem_usage=True,
    )
    pipe = pipeline("text-generation", model=model, tokenizer=tokenizer, device_map="auto" if DEVICE == "cuda" else 0 if DEVICE == "cuda" else -1)
    _models[f"llm:{model_name}"] = pipe
    return pipe

def load_whisper(model_size: str = "base"):
    """Faster-Whisper STT"""
    if f"whisper:{model_size}" in _models: return _models[f"whisper:{model_size}"]
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device=DEVICE, compute_type="float16" if DEVICE == "cuda" else "int8")
    _models[f"whisper:{model_size}"] = model
    logger.info(f"[CareerVoice] Whisper {model_size} loaded")
    return model

def load_vision():
    """LLaVA vision model"""
    if "vision" in _models: return _models["vision"]
    # This 7B model's first load competes for VRAM with whatever Ollama
    # models happen to be resident (cs-opus/sonnet/haiku/embed/llava-phi3
    # aren't proactively evicted between requests, unlike svd_server.py's
    # generation path) - confirmed live: a real request here OOM'd with
    # under 30MiB free while Ollama held ~10GB+ across multiple models.
    # This is only ever the SECOND vision tier anyway (engine/vlm.js tries
    # Ollama's llava-phi3 first and only falls through here if that fails),
    # so evicting Ollama's models to make room is safe - a real fallback
    # call is already the rare case where the faster primary path failed.
    _make_room_for_vision()
    from transformers import LlavaNextProcessor, LlavaNextForConditionalGeneration
    processor = LlavaNextProcessor.from_pretrained("llava-hf/llava-v1.6-mistral-7b-hf")
    # fp16 needs ~14GB for a 7B model - confirmed live: OOM'd even as the
    # ONLY resident model on this 16GB card, with nothing left over for
    # TalkingHead/BERT/the forward pass itself. Evicting Ollama alone
    # (above) was never going to be enough. 4-bit quantization (already
    # have bitsandbytes installed) shrinks this to ~4GB, which genuinely
    # coexists after eviction - real fix, not just moving the OOM around.
    if DEVICE == "cuda":
        from transformers import BitsAndBytesConfig
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
        )
        model = LlavaNextForConditionalGeneration.from_pretrained(
            "llava-hf/llava-v1.6-mistral-7b-hf",
            quantization_config=quant_config,
            device_map="auto",
        )
    else:
        model = LlavaNextForConditionalGeneration.from_pretrained(
            "llava-hf/llava-v1.6-mistral-7b-hf",
            torch_dtype=torch.float32,
            low_cpu_mem_usage=True,
        )
    _models["vision"] = (processor, model)
    logger.info("[CareerVision] LLaVA-1.6 loaded (4-bit)" if DEVICE == "cuda" else "[CareerVision] LLaVA-1.6 loaded (cpu fp32)")
    return _models["vision"]

# ── FastAPI app ────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("[CareerCamp AI] Python ML server starting…")
    # Eagerly load only the small BERT model; others load on demand
    try:
        load_bert_model()
    except Exception as e:
        logger.warning(f"[CareerBERT] Could not pre-load: {e}")
    yield
    logger.info("[CareerCamp AI] Python ML server shutting down")

app = FastAPI(title="CareerCamp AI ML Server", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Request models ─────────────────────────────────────────
class InferRequest(BaseModel):
    prompt:      str
    system:      Optional[str] = ""
    model:       Optional[str] = "careerlm-base"
    max_tokens:  Optional[int] = 2048
    temperature: Optional[float] = 0.78

class EmbedRequest(BaseModel):
    texts: List[str]
    model: Optional[str] = "careerembed-v1"

class STTRequest(BaseModel):
    audio_base64: str
    language:     Optional[str] = "en"
    model:        Optional[str] = "base"

# ── Health ─────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status":  "ok",
        "device":  DEVICE,
        "models":  list(_models.keys()),
        "service": "CareerCamp AI Python ML Server",
        "version": "1.0.0",
    }

# ── LLM inference ──────────────────────────────────────────
# Only careerlm-nano (Phi-3-mini, 3.8B/~7.6GB fp16) is even plausibly
# loadable here alongside Ollama + SVD + TTS + vision, all resident on
# this pod's single 16GB card. careerlm-small/base/large/xl were mapped
# to 7B/8B/8x7B/72B models (14GB-144GB+ fp16) with NO size gating before
# this fix — confirmed in production: a request for careerlm-large
# triggered AutoModelForCausalLM.from_pretrained() to actually start
# downloading Mixtral-8x7B, filled the pod's 60GB local disk to 100%
# (33GB partial download alone), and broke unrelated services (SVD's
# ffmpeg write failing with "No space left on device"). This tier is
# also redundant, not just dangerous — Groq and OpenRouter already serve
# every model tier reliably as external fallbacks (see engine/llm.js's
# waterfall, steps 3-4), so there is no real capability lost by refusing
# the sizes that can't work here instead of attempting them.
HF_MAP = {
    "careerlm-nano": "microsoft/Phi-3-mini-4k-instruct",
}

@app.post("/v1/infer")
async def infer(req: InferRequest):
    try:
        hf_model = HF_MAP.get(req.model)
        if not hf_model:
            raise HTTPException(status_code=503, detail=f"Model '{req.model}' too large for local HF inference on this GPU — use Ollama or an external provider instead.")
        pipe = load_llm(hf_model)
        prompt = f"<|system|>\n{req.system}\n<|user|>\n{req.prompt}\n<|assistant|>\n"
        result = pipe(prompt, max_new_tokens=req.max_tokens, temperature=req.temperature, do_sample=True, return_full_text=False)
        text = result[0]["generated_text"]
        return {"text": text, "model": req.model, "engine": "huggingface"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

# ── LLM streaming ──────────────────────────────────────────
@app.post("/v1/stream")
async def stream_infer(req: InferRequest):
    async def generate():
        try:
            from transformers import TextIteratorStreamer
            from threading import Thread
            HF_MAP = { "careerlm-base": "meta-llama/Llama-3.1-8B-Instruct" }
            hf_model = HF_MAP.get(req.model, HF_MAP["careerlm-base"])
            pipe = load_llm(hf_model)
            streamer = TextIteratorStreamer(pipe.tokenizer, skip_prompt=True, skip_special_tokens=True)
            inputs = pipe.tokenizer(f"<|system|>\n{req.system}\n<|user|>\n{req.prompt}\n<|assistant|>\n", return_tensors="pt")
            kwargs = dict(inputs, max_new_tokens=req.max_tokens, temperature=req.temperature, do_sample=True, streamer=streamer)
            thread = Thread(target=pipe.model.generate, kwargs=kwargs)
            thread.start()
            for token in streamer:
                if token:
                    yield f"data: {json.dumps({'text': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")

# ── Embeddings ─────────────────────────────────────────────
@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest):
    try:
        model = load_bert_model()
        embeddings = model.encode(req.texts, normalize_embeddings=True).tolist()
        return {"embeddings": embeddings, "model": "all-MiniLM-L6-v2", "dims": len(embeddings[0]) if embeddings else 384}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

# ── STT (Faster-Whisper) ───────────────────────────────────
@app.post("/v1/stt")
async def stt(file: UploadFile = File(None), audio_base64: str = Form(None), language: str = Form("en"), model: str = Form("base")):
    try:
        whisper = load_whisper(model)
        if file:
            audio_bytes = await file.read()
        elif audio_base64:
            audio_bytes = base64.b64decode(audio_base64)
        else:
            raise HTTPException(400, "No audio provided")
        # Write to temp file
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        segments, info = whisper.transcribe(tmp_path, language=language)
        text = " ".join(s.text for s in segments)
        os.unlink(tmp_path)
        return {"text": text.strip(), "language": info.language, "engine": f"faster-whisper-{model}"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

# TTS moved to tts_server.py (Chatterbox, own venv/port 3004) 2026-08-08 —
# replaces Coqui XTTS-v2, which is gone from this file. See that file's
# header for why it's a separate service rather than a route here
# (real, confirmed dependency conflict between chatterbox-tts's required
# transformers==5.2.0/torch==2.6.0 and this server's transformers==
# 4.45.1/torch==2.4.1 LLM/vision/embedding stack).

# ── Vision (LLaVA-1.6) ────────────────────────────────────
@app.post("/v1/vision")
async def vision(
    file:         UploadFile = File(None),
    image_base64: str = Form(None),
    prompt:       str = Form("Describe this image in detail"),
    model:        str = Form("llava-1.6"),
    mime_type:    str = Form("image/jpeg"),
):
    try:
        from PIL import Image
        processor, llava_model = load_vision()
        if file:
            image_bytes = await file.read()
        elif image_base64:
            image_bytes = base64.b64decode(image_base64)
        else:
            raise HTTPException(400, "No image provided")
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        conversation = [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image"}]}]
        text_input = processor.apply_chat_template(conversation, add_generation_prompt=True)
        inputs = processor(text=text_input, images=image, return_tensors="pt")
        if DEVICE == "cuda":
            inputs = {k: v.cuda() for k, v in inputs.items()}
        with torch.no_grad():
            output = llava_model.generate(**inputs, max_new_tokens=2048, do_sample=False)
        generated = processor.decode(output[0][len(inputs["input_ids"][0]):], skip_special_tokens=True)
        return {"text": generated, "model": "llava-1.6", "engine": f"llava-{DEVICE}"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

if __name__ == "__main__":
    port = int(os.getenv("ML_SERVER_PORT", 3003))
    logger.info(f"[CareerCamp AI] Python ML server → http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, workers=1, log_level="info")
