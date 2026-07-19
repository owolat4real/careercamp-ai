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

// Preference order when multiple vision models are pulled — avatarvid-2b's
// own baked-in system prompt is purpose-built for avatar/interview-frame
// analysis (gaze, pose, emotion tracking), so it's a better fit for that
// task than the generic llava/moondream base models it's built on.
const VISION_MODEL_PREFERENCE = ['avatarvid-2b', 'llava', 'bakllava', 'vision', 'moondream'];

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

// ── Ollama vision inference ────────────────────────────────
async function ollamaVisionInfer(imageBase64, prompt) {
  if (!ollamaVisionModel) throw new Error('No Ollama vision model detected');
  const r = await axios.post(`${OLLAMA_URL}/api/generate`, {
    model:  ollamaVisionModel,
    prompt: prompt,
    images: [imageBase64],
    stream: false,
  }, { timeout: 90000 });
  return r.data?.response || '';
}

// ── Python ML server vision inference ─────────────────────
async function mlServerVisionInfer(imageBase64, prompt, mimeType = 'image/jpeg') {
  const r = await axios.post(`${ML_SERVER}/v1/vision`, {
    image:     imageBase64,
    mime_type: mimeType,
    prompt,
    model:    'llava-1.6',
  }, { timeout: 120000 });
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
      if (text && text.length > 50) return { text, engine: 'ollama:llava', task };
    } catch (e) { console.warn('[CareerVision:ollama]', e.message?.slice(0,60)); }
  }

  // 2. Python ML server
  try {
    const text = await mlServerVisionInfer(base64, prompt, options.mimeType);
    if (text && text.length > 50) return { text, engine: 'mlserver:llava-1.6', task };
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
