/**
 * ═══════════════════════════════════════════════════════════════════════
 * CAREERCAMP AI — Inference Gateway v1.0
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Standalone AI platform — does NOT depend on OpenAI, Anthropic, Groq,
 * or any third-party LLM service. All inference is self-hosted.
 *
 * Architecture:
 *   Node.js Gateway (port 3002)  ←──── Career Studio calls here
 *       │
 *       ├── CareerBERT Engine   — BERT-based NLP (skill extraction, scoring, NER)
 *       ├── CareerLM Engine     — Local LLM via Ollama / HuggingFace
 *       ├── CareerVision Engine — VLM for CV images, portfolio, video frames
 *       ├── CareerVoice Engine  — Whisper STT + XTTS TTS
 *       ├── Internet Engine     — Real-time web grounding (Brave / Tavily)
 *       └── Python ML Server    (port 3003)  ←── heavy inference offloaded here
 *
 * DNS Subdomains (configure in nginx/careerstudio.conf):
 *   llm.careerstudio.ai    → this gateway /v1/chat/completions
 *   vlm.careerstudio.ai    → this gateway /v1/vision/*
 *   voice.careerstudio.ai  → this gateway /v1/audio/*
 *   embed.careerstudio.ai  → this gateway /v1/embeddings
 *   api.careerstudio.ai    → this gateway /v1/* (all)
 *
 * OpenAI-compatible API — Career Studio's camp-client.js connects without changes.
 *
 * @author   CareerCamp AI Team
 * @version  1.0.0
 * @license  Proprietary — Career Studio AI
 */

'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const http       = require('http');

const app  = express();
const PORT = process.env.PORT || process.env.CAREERCAMP_PORT || 3002;

// ── Security & middleware ──────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
// SSE responses (text/event-stream) must NOT be gzip-buffered — compression
// holds chunks until the stream ends, turning real-time token streaming into
// one big burst at the end. Skip compression for those, compress everything else.
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS || '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('combined', { skip: (req) => req.url === '/health' }));

// Rate limiting — generous limits for internal use
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.headers['x-internal'] === process.env.INTERNAL_SECRET,
}));

// ── Engine imports ─────────────────────────────────────────
const careerBERT     = require('./engine/careerbert');
const careerLM       = require('./engine/llm');
const careerVision   = require('./engine/vlm');
const careerVoice    = require('./engine/voice');
const internetEngine = require('./engine/internet');
const multiModal     = require('./engine/multimodal');
const contextEngine  = require('./intelligence/context');

// ── Route imports ──────────────────────────────────────────
const completionsRoute  = require('./api/completions');
const embeddingsRoute   = require('./api/embeddings');
const visionRoute       = require('./api/vision');
const audioRoute        = require('./api/audio');
const modelsRoute       = require('./api/models');
const bertRoute         = require('./api/bert');
const agentRoute        = require('./api/agent');

// ── Attach engines to app for routes ──────────────────────
app.locals.engines = {
  bert:     careerBERT,
  llm:      careerLM,
  vision:   careerVision,
  voice:    careerVoice,
  internet: internetEngine,
  modal:    multiModal,
  context:  contextEngine,
};

// ── API key authentication ─────────────────────────────────
function apiKeyAuth(req, res, next) {
  const key = (req.headers.authorization || '').replace('Bearer ', '') ||
              req.query.api_key || req.headers['x-api-key'];
  const validKeys = [
    process.env.CAREERCAMP_API_KEY || '',
    process.env.CS_TRANSFORMER_API_KEY || '',
    process.env.CAREERCAMP_SECRET_KEY || '',
  ].filter(Boolean);

  if (!validKeys.length || validKeys.some(k => k === key)) {
    return next();
  }
  res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error', code: 401 } });
}

// ── Health & status ────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'CareerCamp AI Gateway',
    version: '1.0.0',
    uptime:  process.uptime(),
    time:    new Date().toISOString(),
    engines: {
      bert:    careerBERT.status(),
      llm:     careerLM.status(),
      vision:  careerVision.status(),
      voice:   careerVoice.status(),
      internet: internetEngine.status(),
    },
  });
});

// Root info — visible in browser so you know the gateway is live
app.get('/', (req, res) => {
  res.json({
    service: 'CareerCamp AI Gateway',
    version: '1.0.0',
    status:  'online',
    docs:    'https://github.com/owolat4real/careercamp-ai',
    endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/embeddings', '/v1/bert', '/v1/images', '/v1/audio'],
  });
});

app.get('/v1', (req, res) => {
  res.json({
    service: 'CareerCamp AI Gateway — OpenAI-compatible API',
    version: '1.0.0',
    status:  'online',
    routes: {
      models:      'GET  /v1/models',
      chat:        'POST /v1/chat/completions',
      embeddings:  'POST /v1/embeddings',
      bert:        'POST /v1/bert/extract',
      vision:      'POST /v1/images/analyze',
      audio:       'POST /v1/audio/transcribe',
      agent:       'POST /v1/agent/run',
    },
    auth: 'Authorization: Bearer YOUR_CAREERCAMP_API_KEY',
  });
});

app.get('/v1/models', apiKeyAuth, (req, res, next) => {
  req.engines = app.locals.engines;
  next();
}, modelsRoute);

// ── OpenAI-compatible routes ───────────────────────────────
app.use('/v1/chat/completions',  apiKeyAuth, (req, _, next) => { req.engines = app.locals.engines; next(); }, completionsRoute);
app.use('/v1/embeddings',        apiKeyAuth, (req, _, next) => { req.engines = app.locals.engines; next(); }, embeddingsRoute);
app.use('/v1/images',            apiKeyAuth, (req, _, next) => { req.engines = app.locals.engines; next(); }, visionRoute);
app.use('/v1/audio',             apiKeyAuth, (req, _, next) => { req.engines = app.locals.engines; next(); }, audioRoute);

// ── CareerCamp-specific routes ─────────────────────────────
app.use('/v1/bert',   apiKeyAuth, (req, _, next) => { req.engines = app.locals.engines; next(); }, bertRoute);
app.use('/v1/agent',  apiKeyAuth, (req, _, next) => { req.engines = app.locals.engines; next(); }, agentRoute);

// ── Vision endpoint alias ──────────────────────────────────
app.post('/v1/vision/analyze', apiKeyAuth, (req, res, next) => {
  req.engines = app.locals.engines;
  req.url     = '/analyze';
  visionRoute(req, res, next);
});

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[CareerCamp] Error:', err.message);
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      type:    'api_error',
      code:    err.status || 500,
    },
  });
});

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  CareerCamp AI — World-First Career Intelligence     ║');
  console.log('║  LLM · VLM · Voice · BERT · Multimodal · Internet   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Initialise engines in parallel
  const results = await Promise.allSettled([
    careerBERT.init(),
    careerLM.init(),
    careerVision.init(),
    careerVoice.init(),
    internetEngine.init(),
    contextEngine.init(),
  ]);

  results.forEach((r, i) => {
    const names = ['CareerBERT', 'CareerLM', 'CareerVision', 'CareerVoice', 'InternetEngine', 'ContextEngine'];
    if (r.status === 'fulfilled') console.log(`  ✅ ${names[i]} ready`);
    else console.warn(`  ⚠  ${names[i]} degraded: ${r.reason?.message?.slice(0, 60)}`);
  });

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`\n  🚀 CareerCamp AI Gateway → http://localhost:${PORT}/v1`);
    console.log(`  📡 DNS targets:`);
    console.log(`       llm.careerstudio.ai    → /v1/chat/completions`);
    console.log(`       vlm.careerstudio.ai    → /v1/images/analyze`);
    console.log(`       voice.careerstudio.ai  → /v1/audio/*`);
    console.log(`       embed.careerstudio.ai  → /v1/embeddings`);
    console.log(`       bert.careerstudio.ai   → /v1/bert/*\n`);
  });
}

boot().catch(e => {
  console.error('[CareerCamp] Boot failed:', e.message);
  process.exit(1);
});
