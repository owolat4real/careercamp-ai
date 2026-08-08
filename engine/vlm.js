/**
 * ═══════════════════════════════════════════════════════════════════════
 * CAREERVISION ENGINE — Vision Language Model
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Capabilities:
 *   • Resume image analysis    — extract text, layout, ATS issues from CV scans
 *   • Portfolio review         — score design quality, professional appearance
 *   • Interview frame analysis — body language, eye contact, expression scoring
 *   • LinkedIn profile scan    — visual brand assessment from screenshot
 *   • Document OCR             — extract text from any career document image
 *   • Video interview frames   — analyse multiple frames for interview coaching
 *
 * Models (priority order):
 *   1. Ollama LLaVA             — local VLM, fast, good for CV images
 *   2. Python ML server         — BLIP-2 / LLaVA-1.6 (heavy inference)
 *   3. HuggingFace BLIP         — free API fallback
 */

'use strict';
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL    || 'http://localhost:11434';
const ML_SERVER  = process.env.ML_SERVER_URL || 'http://localhost:3003';

let ollamaVision = false; // vision-capable model available in Ollama
let ollamaVisionModel = null; // the actual pulled model name to use

// Preference order when multiple vision models are pulled. avatarvid-2b was
// previously listed first (its baked-in system prompt is purpose-built for
// avatar/interview-frame analysis), but confirmed live (2026-08-06) that it
// HANGS INDEFINITELY on any real image+prompt request — not a slow response,
// a genuine non-terminating call. Because this Ollama instance runs with
// OLLAMA_NUM_PARALLEL=1, one hung avatarvid-2b request permanently occupies
// the pod's only inference slot and silently blocks EVERY other model too
// (cs-opus/sonnet/haiku text included) until Ollama is restarted — this is
// not a self-contained vision failure, it can take down the whole pod.
// VRAM headroom was not the cause (7GB+ free at the time, well above
// _makeRoomForVision()'s threshold below) so this is a genuine model/runtime
// bug, not a resource contention issue eviction can fix. llava-phi3 (also
// pulled) handles the identical real image correctly in ~1s once warm.
// Demoted below the working models until the underlying hang is root-caused
// separately — do not move it back above llava/moondream without first
// confirming the hang is fixed, since a single bad request here is a
// pod-wide outage, not a contained failure.
const VISION_MODEL_PREFERENCE = ['llava', 'moondream', 'bakllava', 'avatarvid-2b'];

async function checkVisionModels() {
  try {
    const r = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 3000 });
    const models = (r.data?.models || []).map(m => m.name);
    // Previously hardcoded 'llava:7b' in ollamaVisionInfer() regardless of
    // what was actually pulled — real pulled models here are llava-phi3,
    // moondream, avatarvid-2b, none of which match that literal name, so
    // every vision call 404'd against Ollama and silently fell through to
    // the (also failing) lower tiers. Store the real matched name instead.
    for (const pref of VISION_MODEL_PREFERENCE) {
      const match = models.find(m => m.toLowerCase().includes(pref));
      if (match) { ollamaVisionModel = match; break; }
    }
    ollamaVision = !!ollamaVisionModel;
    if (ollamaVision) console.log(`[CareerVision] Vision model available in Ollama: ${ollamaVisionModel}`);
    else console.warn('[CareerVision] No vision model in Ollama. Run: ollama pull llava-phi3');
  } catch (_) { ollamaVision = false; ollamaVisionModel = null; }
}

// ── Convert image to base64 ────────────────────────────────
function toBase64(input) {
  if (Buffer.isBuffer(input)) return input.toString('base64');
  if (typeof input === 'string' && input.startsWith('data:')) {
    return input.split(',')[1];
  }
  if (typeof input === 'string' && fs.existsSync(input)) {
    return fs.readFileSync(input).toString('base64');
  }
  return input; // assume already base64
}

// ── Task-specific vision prompts ──────────────────────────
const VISION_PROMPTS = {
  resume: `You are an expert ATS (Applicant Tracking System) specialist and recruiter.
Analyse this resume image carefully and provide:
1. EXTRACTED TEXT — all readable text on the CV
2. LAYOUT SCORE (0-100) — is the layout clean, readable, ATS-friendly?
3. ATS ISSUES — list any formatting problems that would break ATS parsing
4. CONTACT INFO — name, email, phone, LinkedIn (if visible)
5. SECTIONS DETECTED — which sections are present (Summary, Experience, Skills, Education, etc.)
6. VISUAL ASSESSMENT — font readability, white space, visual hierarchy
7. TOP 3 IMPROVEMENTS — most impactful visual changes to improve ATS score
Be specific. This is a professional career document requiring expert analysis.`,

  portfolio: `You are a senior UX/design reviewer and career coach.
Analyse this portfolio image and provide:
1. DESIGN QUALITY (0-100) — professional visual quality
2. BRAND CONSISTENCY — does the design reflect a coherent professional identity?
3. CONTENT CLARITY — is the work clearly presented and explained?
4. TECHNICAL SKILLS SHOWN — what technical abilities are demonstrated visually?
5. IMPROVEMENTS — 3 specific improvements to maximise recruiter impact`,

  interview_frame: `You are an expert interview coach specialising in non-verbal communication.
Analyse this video frame from an interview recording:
1. EYE CONTACT (0-100) — looking at camera vs. away
2. POSTURE SCORE (0-100) — confident, upright vs. slouched
3. EXPRESSION — what emotion/energy does the expression convey?
4. BACKGROUND — is the background professional?
5. LIGHTING — adequate lighting quality?
6. COACHING TIP — single most impactful improvement for this moment`,

  linkedin: `You are a LinkedIn profile optimisation expert.
Analyse this LinkedIn profile screenshot:
1. PROFILE COMPLETENESS (0-100) — how complete is the profile?
2. HEADLINE — is the headline compelling and keyword-rich?
3. PHOTO QUALITY — professional appearance score
4. BANNER — does the banner reinforce the personal brand?
5. FIRST IMPRESSION — what does a recruiter think in the first 5 seconds?
6. TOP IMPROVEMENT — single highest-impact change`,

  document: `Extract and transcribe ALL text visible in this document image.
Preserve the original structure as closely as possible.
If there are tables, represent them clearly.
Label each section clearly.`,
};

// ── VRAM eviction before a vision call ─────────────────────
// Mirrors api_server.py's _make_room_for_vision() for the Python LLaVA-1.6
// fallback — that path already evicts Ollama's chat models before loading
// its own heavy vision model, but this NATIVE Ollama vision path had no
// equivalent. Confirmed live on an 8GB card: a real image+prompt request to
// avatarvid-2b hung indefinitely (not a clean error) because its ~900MB
// vision projector had nowhere to fit alongside cs-haiku/sonnet/opus already
// resident — plain requests with no `images` field worked fine and fast
// (sub-second), so the hang is specifically the projector's VRAM, not the
// model or the request format. Evicting via keep_alive:0 is safe: Ollama
// reloads an evicted model lazily and automatically on its next real chat
// request, no explicit reload code needed (same reasoning already used on
// the Python side).
const VISION_MIN_FREE_MIB = 2500; // avatarvid-2b (~1.7GB) + its projector + inference headroom
const MODELS_TO_EVICT_FOR_VISION = ['cs-opus', 'cs-sonnet', 'cs-haiku'];

function _freeMiB() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', (err, stdout) => {
      if (err) return resolve(null); // no GPU visibility — skip eviction, let the call proceed as before
      const n = parseInt(String(stdout).trim(), 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

async function _makeRoomForVision() {
  const free = await _freeMiB();
  if (free === null || free >= VISION_MIN_FREE_MIB) return;
  await Promise.all(MODELS_TO_EVICT_FOR_VISION.map(model =>
    axios.post(`${OLLAMA_URL}/api/generate`, { model, prompt: '', keep_alive: 0 }, { timeout: 10000 })
      .catch(() => {}) // a model that isn't currently loaded 404s here — fine, nothing to evict
  ));
  for (let i = 0; i < 20; i++) {
    const nowFree = await _freeMiB();
    if (nowFree === null || nowFree >= VISION_MIN_FREE_MIB) break;
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Ollama vision inference ────────────────────────────────
async function ollamaVisionInfer(imageBase64, prompt) {
  if (!ollamaVisionModel) throw new Error('No Ollama vision model detected');
  await _makeRoomForVision();
  const r = await axios.post(`${OLLAMA_URL}/api/generate`, {
    model:  ollamaVisionModel,
    prompt: prompt,
    images: [imageBase64],
    stream: false,
  }, { timeout: 90000 });
  return r.data?.response || '';
}

// ── Python ML server vision inference ─────────────────────
// /v1/vision is FastAPI Form()-only (not a JSON body) and reads the field
// named "image_base64", not "image" — must post as x-www-form-urlencoded.
async function mlServerVisionInfer(imageBase64, prompt, mimeType = 'image/jpeg') {
  const body = new URLSearchParams({
    image_base64: imageBase64,
    mime_type:    mimeType,
    prompt,
    model:        'llava-1.6',
  });
  const r = await axios.post(`${ML_SERVER}/v1/vision`, body, { timeout: 120000 });
  return r.data?.text || '';
}

// ── HuggingFace vision fallback ────────────────────────────
async function hfVisionInfer(imageBase64, prompt) {
  const HF_TOKEN = process.env.HF_TOKEN || '';
  // Use BLIP-2 via HF inference API
  const imageBytes = Buffer.from(imageBase64, 'base64');
  const r = await axios.post(
    'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large',
    imageBytes,
    {
      headers: {
        'Content-Type': 'image/jpeg',
        Authorization: HF_TOKEN ? `Bearer ${HF_TOKEN}` : undefined,
      },
      timeout: 30000,
    }
  );
  const caption = r.data?.[0]?.generated_text || '';
  // Combine caption with rule-based analysis
  return `Image analysis: ${caption}\n\nNote: Full vision analysis requires LLaVA model. Install with: ollama pull llava:7b`;
}

// ── Public API ─────────────────────────────────────────────
async function analyzeImage(imageInput, task = 'resume', options = {}) {
  const base64 = toBase64(imageInput);
  const prompt  = VISION_PROMPTS[task] || VISION_PROMPTS.document;

  // 1. Ollama LLaVA
  if (ollamaVision) {
    try {
      const text = await ollamaVisionInfer(base64, prompt);
      // 50 was too strict for genuinely short-but-valid answers (e.g. a
      // near-blank image or a terse factual response) -- confirmed live: a
      // real avatarvid-2b response under 50 chars was rejected here and
      // cascaded needlessly through the heavier mlserver/HF fallbacks.
      if (text && text.length > 20) return { text, engine: 'ollama:llava', task };
    } catch (e) { console.warn('[CareerVision:ollama]', e.message?.slice(0,60)); }
  }

  // 2. Python ML server
  try {
    const text = await mlServerVisionInfer(base64, prompt, options.mimeType);
    if (text && text.length > 20) return { text, engine: 'mlserver:llava-1.6', task };
  } catch (e) { console.warn('[CareerVision:mlserver]', e.message?.slice(0,60)); }

  // 3. HuggingFace fallback
  try {
    const text = await hfVisionInfer(base64, prompt);
    return { text, engine: 'huggingface:blip', task };
  } catch (e) { console.warn('[CareerVision:hf]', e.message?.slice(0,60)); }

  return { text: `Vision analysis unavailable. Install LLaVA: ollama pull llava:7b`, engine: 'none', task };
}

// ── Video frame analysis ───────────────────────────────────
async function analyzeVideoFrames(frames, task = 'interview_frame') {
  const results = await Promise.all(
    frames.slice(0, 5).map((f, i) =>
      analyzeImage(f, task).then(r => ({ frame: i, ...r }))
    )
  );
  // Aggregate frame scores
  const avgScores = {};
  results.forEach(r => {
    const eyeMatch  = r.text?.match(/eye.?contact.*?(\d+)/i);
    const postMatch = r.text?.match(/posture.*?(\d+)/i);
    if (eyeMatch)  avgScores.eyeContact  = (avgScores.eyeContact  || 0) + parseInt(eyeMatch[1]);
    if (postMatch) avgScores.posture     = (avgScores.posture      || 0) + parseInt(postMatch[1]);
  });
  const n = results.length || 1;
  Object.keys(avgScores).forEach(k => avgScores[k] = Math.round(avgScores[k] / n));
  return { frames: results, aggregateScores: avgScores };
}

module.exports = {
  async init() { await checkVisionModels(); },
  status: () => ({ ollamaVision, ollamaVisionModel }),
  analyzeImage,
  analyzeVideoFrames,
  VISION_PROMPTS,
};
