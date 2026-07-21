/**
 * ═══════════════════════════════════════════════════════════════════════
 * CAREERVOICE ENGINE — Speech-to-Text & Text-to-Speech
 * ═══════════════════════════════════════════════════════════════════════
 *
 * STT (Speech-to-Text):
 *   1. Whisper.cpp local   — fastest, offline, high accuracy
 *   2. Faster-Whisper      — Python ML server (port 3003)
 *   3. Groq Whisper API    — free cloud STT (fallback)
 *   4. HuggingFace Whisper — last resort
 *
 * TTS (Text-to-Speech):
 *   1. Coqui XTTS-v2       — Python ML server, natural voice, 16 languages
 *   2. ElevenLabs API      — professional quality (if key set)
 *   3. System TTS          — fallback
 *
 * Voices / Personas:
 *   career-coach    — warm, authoritative, encouraging
 *   interviewer     — professional, measured, formal
 *   mentor          — friendly, experienced, thoughtful
 *   analyst         — clear, precise, data-driven
 *
 * Languages: English, Spanish, French, German, Portuguese, Chinese,
 *            Japanese, Korean, Arabic, Hindi, Yoruba, Swahili, + 4 more
 */

'use strict';
const axios      = require('axios');
const FormData   = require('form-data');
const fs         = require('fs');
const path       = require('path');
const { Groq }   = require('groq-sdk');

const ML_SERVER   = process.env.ML_SERVER_URL   || 'http://localhost:3003';
const GROQ_KEY    = process.env.GROQ_API_KEY    || '';
const EL_KEY      = process.env.ELEVENLABS_API_KEY || '';
const WHISPER_BIN = process.env.WHISPER_BIN     || path.join(__dirname, '../models/whisper/main');

const groq = GROQ_KEY ? new Groq({ apiKey: GROQ_KEY }) : null;

// ── Voice configurations ───────────────────────────────────
// coquiSpeaker values below are best-effort names from Coqui XTTS-v2's
// publicly documented built-in speaker set (the checkpoint ships ~58 named
// zero-shot speakers with no reference audio needed). The previous values
// ('career_coach'/'interviewer'/'mentor'/'analyst') weren't real XTTS
// speaker names at all — api_server.py's /v1/tts already falls back to the
// model's first available speaker whenever the requested name isn't
// recognised, so if any of these four are wrong, behavior is identical to
// before this change (one shared fallback voice), never worse. Not
// verified against a running instance — this environment has no
// GPU/model weights to test against. Worth spot-checking once self-hosted
// XTTS is actually running.
const VOICES = {
  'career-coach': {
    id:          'career-coach-v1',
    description: 'Warm, authoritative, encouraging career advisor',
    elevenLabs:  'EXAVITQu4vr4xnSDxMaL', // Sarah
    coquiSpeaker: 'Alison Dietlinde', // warm female — closest XTTS analogue to ElevenLabs' Sarah
    speed:       1.0,
    pitch:       0.95,
  },
  'interviewer': {
    id:          'interviewer-v1',
    description: 'Professional, formal, measured interviewer',
    elevenLabs:  'N2lVS1w4EtoT3dr4eOWO', // Callum
    coquiSpeaker: 'Damien Black', // measured male — closest XTTS analogue to ElevenLabs' Callum
    speed:       0.95,
    pitch:       1.0,
  },
  'mentor': {
    id:          'mentor-v1',
    description: 'Friendly, experienced, thoughtful mentor',
    elevenLabs:  'pqHfZKP75CvOlQylNhV4', // Bill
    coquiSpeaker: 'Viktor Eka', // warmer, older-sounding male — closest XTTS analogue to ElevenLabs' Bill
    speed:       0.90,
    pitch:       0.92,
  },
  'analyst': {
    id:          'analyst-v1',
    description: 'Clear, precise, data-driven analyst',
    elevenLabs:  'jBpfuIE2acCO8z3wKNLl', // Gigi
    coquiSpeaker: 'Alexandra Hisakawa', // clear, precise female — closest XTTS analogue to ElevenLabs' Gigi
    speed:       1.05,
    pitch:       1.02,
  },
};

const SUPPORTED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'yo', 'sw', 'nl', 'it', 'pl', 'ru',
];

// ═══════════════════════════════════════════════════════════
// SPEECH-TO-TEXT
// ═══════════════════════════════════════════════════════════

// ── Whisper.cpp local ─────────────────────────────────────
async function whisperLocal(audioBuffer, language = 'en') {
  const tmpIn  = path.join('/tmp', `cc_audio_${Date.now()}.wav`);
  const tmpOut = path.join('/tmp', `cc_out_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpIn, audioBuffer);
    const { execSync } = require('child_process');
    execSync(`${WHISPER_BIN} -m ${path.join(__dirname,'../models/whisper/ggml-base.en.bin')} -f ${tmpIn} -l ${language} -otxt -of ${tmpOut.replace('.txt','')} --no-timestamps`, { timeout: 30000 });
    const text = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8').trim() : '';
    return text;
  } finally {
    [tmpIn, tmpOut].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
}

// ── Faster-Whisper via Python ML server ───────────────────
async function whisperMLServer(audioBuffer, language = 'en', model = 'base') {
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('language', language);
  form.append('model', model);
  const r = await axios.post(`${ML_SERVER}/v1/stt`, form, {
    headers: form.getHeaders(),
    timeout: 60000,
  });
  return r.data?.text || '';
}

// ── Groq Whisper API ───────────────────────────────────────
async function whisperGroq(audioBuffer, language = 'en') {
  if (!groq) throw new Error('No Groq key');
  const tmpFile = path.join('/tmp', `cc_groq_${Date.now()}.wav`);
  fs.writeFileSync(tmpFile, audioBuffer);
  try {
    const r = await groq.audio.transcriptions.create({
      file:     fs.createReadStream(tmpFile),
      model:    'whisper-large-v3',
      language: language,
    });
    return r.text || '';
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── Public STT ────────────────────────────────────────────
async function transcribe(audioInput, options = {}) {
  const { language = 'en', model = 'base', engine } = options;
  const buf = Buffer.isBuffer(audioInput) ? audioInput :
    typeof audioInput === 'string' && audioInput.startsWith('data:')
      ? Buffer.from(audioInput.split(',')[1], 'base64')
      : Buffer.from(audioInput, 'base64');

  // 1. Local Whisper.cpp (fastest, offline)
  if (!engine || engine === 'local') {
    if (fs.existsSync(WHISPER_BIN)) {
      try {
        const text = await whisperLocal(buf, language);
        if (text) return { text, engine: 'whisper-local', language };
      } catch (e) { console.warn('[CareerVoice:whisper-local]', e.message?.slice(0,60)); }
    }
  }

  // 2. Python ML server (Faster-Whisper)
  try {
    const text = await whisperMLServer(buf, language, model);
    if (text) return { text, engine: 'faster-whisper', language };
  } catch (e) { console.warn('[CareerVoice:mlserver]', e.message?.slice(0,60)); }

  // 3. Groq Whisper
  if (groq) {
    try {
      const text = await whisperGroq(buf, language);
      if (text) return { text, engine: 'groq-whisper-v3', language };
    } catch (e) { console.warn('[CareerVoice:groq]', e.message?.slice(0,60)); }
  }

  throw new Error('All STT engines unavailable');
}

// ═══════════════════════════════════════════════════════════
// TEXT-TO-SPEECH
// ═══════════════════════════════════════════════════════════

// ── Coqui XTTS via Python ML server ───────────────────────
async function coquiTTS(text, voiceId, language = 'en') {
  const r = await axios.post(`${ML_SERVER}/v1/tts`, {
    text,
    voice:    voiceId,
    language: language,
    model:    'xtts-v2',
  }, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data);
}

// ── ElevenLabs TTS ────────────────────────────────────────
async function elevenLabsTTS(text, voiceId, stability = 0.5, similarity = 0.75) {
  if (!EL_KEY) throw new Error('No ElevenLabs key');
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability, similarity_boost: similarity },
    },
    {
      headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );
  return Buffer.from(r.data);
}

// ── Public TTS ────────────────────────────────────────────
async function synthesize(text, options = {}) {
  const { voice = 'career-coach', language = 'en', engine } = options;
  const voiceCfg = VOICES[voice] || VOICES['career-coach'];

  // 1. Coqui XTTS (local, most natural)
  if (!engine || engine === 'coqui') {
    try {
      const audio = await coquiTTS(text, voiceCfg.coquiSpeaker, language);
      return { audio, format: 'wav', engine: 'coqui-xtts', voice };
    } catch (e) { console.warn('[CareerVoice:coqui]', e.message?.slice(0,60)); }
  }

  // 2. ElevenLabs (professional quality)
  if (EL_KEY) {
    try {
      const audio = await elevenLabsTTS(text, voiceCfg.elevenLabs);
      return { audio, format: 'mp3', engine: 'elevenlabs', voice };
    } catch (e) { console.warn('[CareerVoice:elevenlabs]', e.message?.slice(0,60)); }
  }

  // 3. Simple browser-compatible Web Speech API placeholder
  return {
    audio:   null,
    text:    text,
    engine:  'none',
    voice,
    fallbackTTS: true,
    message: 'TTS engine unavailable — use browser Web Speech API',
  };
}

// ── Interview answer analysis ─────────────────────────────
// Combines STT + BERT scoring for full interview evaluation
async function analyzeInterviewAnswer(audioInput, question, options = {}) {
  const transcript = await transcribe(audioInput, options);
  return {
    transcript:   transcript.text,
    transcriptEngine: transcript.engine,
    question,
    wordCount:    transcript.text.split(/\s+/).length,
    fillerWords:  countFillerWords(transcript.text),
    speakingPace: estimatePace(transcript.text, options.durationSeconds),
  };
}

function countFillerWords(text) {
  const fillers = /\b(um+|uh+|er+|ah+|like|you know|basically|literally|actually|sort of|kind of|i mean)\b/gi;
  return (text.match(fillers) || []).length;
}

function estimatePace(text, seconds) {
  if (!seconds) return null;
  const wpm = Math.round((text.split(/\s+/).length / seconds) * 60);
  return { wpm, assessment: wpm < 100 ? 'too slow' : wpm > 180 ? 'too fast' : 'good pace' };
}

module.exports = {
  async init() {
    console.log('[CareerVoice] STT engines:', {
      whisperLocal: fs.existsSync(WHISPER_BIN),
      groq:         !!groq,
      mlServer:     true, // checked separately
    });
  },
  status: () => ({
    stt: { local: fs.existsSync(WHISPER_BIN), groq: !!groq },
    tts: { coqui: true, elevenlabs: !!EL_KEY },
  }),
  transcribe,
  synthesize,
  analyzeInterviewAnswer,
  VOICES,
  SUPPORTED_LANGUAGES,
};
