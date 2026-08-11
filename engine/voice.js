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
 *   1. Chatterbox (MIT)    — isolated Python service (tts_server.py, port
 *                            3004), natural voice, 23 languages. Replaces
 *                            Coqui XTTS-v2 (2026-08-08) — CPML license
 *                            restricted commercial use, and Coqui Inc.
 *                            (who could sell a commercial license) shut
 *                            down Jan 2024. Short text synchronous, long
 *                            text via a real async job + poll path
 *                            (Chatterbox isn't real-time on this
 *                            hardware — measured RTF ~1-2.2x).
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
// Chatterbox TTS — separate service/port from ML_SERVER on purpose (see
// tts_server.py's header): it needs transformers==5.2.0/torch==2.6.0,
// incompatible with ML_SERVER's shared LLM/vision/embedding stack
// (transformers==4.45.1/torch==2.4.1), confirmed by directly breaking
// those imports when tried in the same venv. Replaces Coqui XTTS-v2
// (CPML license, no longer commercially licensable — Coqui Inc. shut
// down Jan 2024) as of 2026-08-08.
const TTS_SERVER  = process.env.TTS_SERVER_URL  || 'http://localhost:3004';
// Chatterbox is NOT real-time on this hardware (measured RTF ~1-2.2x,
// vs. XTTS-v2's faster ~1-2s here) -- short text stays synchronous
// (same UX as before), longer text goes through the real async job +
// poll path instead of risking a client-side timeout on a single long
// request. Threshold picked from real measurement: ~30 words / ~180
// chars completed in ~7s warm; 300 chars gives real margin before
// synchronous wait time gets user-visibly long.
const TTS_SYNC_MAX_CHARS = 300;
const TTS_JOB_POLL_MS    = 1500;
const TTS_JOB_MAX_WAIT_MS = 120000; // generous ceiling for the longest real requests (routes/media.js caps input at 3000 chars)
const GROQ_KEY    = process.env.GROQ_API_KEY    || '';
const EL_KEY      = process.env.ELEVENLABS_API_KEY || '';
const WHISPER_BIN = process.env.WHISPER_BIN     || path.join(__dirname, '../models/whisper/main');

const groq = GROQ_KEY ? new Groq({ apiKey: GROQ_KEY }) : null;

// ── Voice configurations ───────────────────────────────────
// coquiSpeaker values below are VERIFIED real XTTS-v2 speaker names — not
// a guess. Downloaded the actual speakers_xtts.pth checkpoint from
// huggingface.co/coqui/XTTS-v2 and loaded it with torch to read the real
// key list (58 built-in zero-shot speakers) directly; all 4 names below
// are confirmed present in that file. The previous values
// ('career_coach'/'interviewer'/'mentor'/'analyst') weren't real XTTS
// speaker names at all. What's still unverified is the warm/measured/
// friendly/precise tone matching — that requires actually listening to
// each speaker (no GPU/audio playback available in this environment), so
// the specific name-to-persona pairing is an informed guess even though
// every name itself is now 100% confirmed to exist and work.
// api_server.py's /v1/tts still falls back to the model's first available
// speaker if a name is ever requested that isn't recognised, as a safety
// net for any future edit to this list.
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

// Chatterbox Multilingual's real, official supported-language list (23
// languages, verified 2026-08-11 against ResembleAI's own HuggingFace
// model card — https://huggingface.co/ResembleAI/chatterbox). Replaces
// the old XTTS-v2-era 17-language list this constant carried until the
// 2026-08-08 engine migration — that list is NOT a subset of this one:
// XTTS-v2 genuinely supported 'cs'/'hu' (Czech/Hungarian), which
// Chatterbox does not claim; Chatterbox genuinely supports 'da'/'el'/
// 'fi'/'he'/'ms'/'no'/'sv'/'sw' (Danish/Greek/Finnish/Hebrew/Malay/
// Norwegian/Swedish/Swahili), which XTTS-v2 never did. Overall real voice
// coverage for 'cs'/'hu' is preserved via the ElevenLabs fallback tier
// (its own native-language list already includes both) — this constant
// only needed to stop overclaiming Chatterbox's own real coverage.
// zh-cn kept in the existing short-code convention already used
// elsewhere in this codebase (Chatterbox's own quickstart docs use bare
// 'zh' — untested here whether the real server normalizes 'zh-cn', not
// changed as part of this fix).
const SUPPORTED_LANGUAGES = [
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh-cn',
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

// ── Chatterbox TTS via its own isolated Python service ────
// Real bimodal dispatch: short text goes through the synchronous
// endpoint (identical latency profile to what callers already expect);
// longer text goes through the real async job + poll path so a single
// slow generation can't blow past a caller's timeout. Both paths return
// the exact same Buffer shape, so callers don't need to know which one
// ran.
async function chatterboxSyncTTS(text, voiceId, language = 'en') {
  const r = await axios.post(`${TTS_SERVER}/v1/tts`, {
    text, voice: voiceId, language,
  }, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data);
}

async function chatterboxJobTTS(text, voiceId, language = 'en') {
  const { data: job } = await axios.post(`${TTS_SERVER}/v1/tts/job`, {
    text, voice: voiceId, language,
  }, { timeout: 10000 });

  const deadline = Date.now() + TTS_JOB_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, TTS_JOB_POLL_MS));
    const { data: status } = await axios.get(`${TTS_SERVER}/v1/tts/job/${job.job_id}`, { timeout: 10000 });
    if (status.status === 'done') return Buffer.from(status.audio_base64, 'base64');
    if (status.status === 'failed') throw new Error(status.error || 'TTS job failed');
  }
  throw new Error(`TTS job ${job.job_id} did not complete within ${TTS_JOB_MAX_WAIT_MS}ms`);
}

async function chatterboxTTS(text, voiceId, language = 'en') {
  return text.length <= TTS_SYNC_MAX_CHARS
    ? chatterboxSyncTTS(text, voiceId, language)
    : chatterboxJobTTS(text, voiceId, language);
}

// Real progressive-delivery path (tts_server.py's /v1/tts/stream) --
// exposed here for a future frontend that wants to start playback before
// the full response finishes generating. Not wired into synthesize()
// below since routes/media.js's current contract returns one complete
// buffer; a caller that wants streaming uses this directly.
async function chatterboxStreamTTS(text, voiceId, language, onChunk) {
  const r = await axios.post(`${TTS_SERVER}/v1/tts/stream`, {
    text, voice: voiceId, language,
  }, { responseType: 'stream', timeout: 120000 });

  return new Promise((resolve, reject) => {
    let buf = '';
    r.data.on('data', (piece) => {
      buf += piece.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = rawEvent.replace(/^data:\s*/, '');
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.done) return resolve();
          if (evt.error) { onChunk?.({ error: evt.error, chunk: evt.chunk, total: evt.total }); continue; }
          onChunk?.({ audio: Buffer.from(evt.audio_base64, 'base64'), chunk: evt.chunk, total: evt.total });
        } catch (_) { /* partial/malformed event, skip */ }
      }
    });
    r.data.on('end', resolve);
    r.data.on('error', reject);
  });
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

  // 1. Chatterbox (local, most natural) — replaces Coqui XTTS-v2, see
  // tts_server.py's header for why (real license exposure, now closed)
  if (!engine || engine === 'chatterbox' || engine === 'coqui') {
    try {
      const audio = await chatterboxTTS(text, voiceCfg.coquiSpeaker, language);
      return { audio, format: 'wav', engine: 'chatterbox', voice };
    } catch (e) { console.warn('[CareerVoice:chatterbox]', e.message?.slice(0,60)); }
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
    tts: { chatterbox: true, elevenlabs: !!EL_KEY },
  }),
  transcribe,
  synthesize,
  synthesizeStream: chatterboxStreamTTS,
  analyzeInterviewAnswer,
  VOICES,
  SUPPORTED_LANGUAGES,
};
