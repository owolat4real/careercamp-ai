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
 *   llm.careerstudiomax.com    → this gateway /v1/chat/completions
 *   vlm.careerstudiomax.com    → this gateway /v1/vision/*
 *   voice.careerstudiomax.com  → this gateway /v1/audio/*
 *   embed.careerstudiomax.com  → this gateway /v1/embeddings
 *   api.careerstudiomax.com    → this gateway /v1/* (all)
 *
 * OpenAI-compatible API — Career Studio's camp-client.js connects without changes.
 *
 * @author   CareerCamp AI Team
 * @version  1.0.0
 * @license  Proprietary — Career Studio AI
 */

'use strict';
require('dotenv').config();

// Validate optional core modules before any route import can crash the server.
// Missing optional modules log a warning and return safe fallbacks — never crash.
require('./core/startupGuard').validateStartup();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const http       = require('http');
const axios      = require('axios');
const gatewayAuth = require('./core/gatewayAuth');
const { readWarmupState, readWarmupReason } = require('./core/modelWarmupState');

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
// Overrides morgan's built-in :url token globally so EVERY format that
// references it (including 'combined' below) logs a redacted URL. A raw
// ?api_key=<credential> query value used to be written to this access log
// verbatim on every request using that transport, success or failure --
// fixed 2026-09-15, CS-1 gateway auth review Priority 1/13. Redaction
// happens at the logging-token level only; req.url/req.originalUrl
// themselves are never mutated, so routing and query parsing elsewhere are
// unaffected.
morgan.token('url', (req) => gatewayAuth.redactUrl(req.originalUrl || req.url));
// :referrer is a SEPARATE morgan token from :url -- 'combined' logs it
// independently (a Referer header is itself a URL, and can just as easily
// carry a credential-bearing "?api_key=..." if the request arrived by
// following a link from a page whose own URL had one). Default morgan
// behavior returns the header verbatim; redacting it the same way as :url
// closes this second, independent path a query credential could reach the
// access log through. Found during the second independent gateway auth
// review (2026-09-15); undefined when no Referer header was sent, matching
// morgan's own default token's return contract exactly.
morgan.token('referrer', (req) => {
  const referrer = req.headers.referer || req.headers.referrer;
  return referrer ? gatewayAuth.redactUrl(referrer) : referrer;
});
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

// ── Local-First AI Platform routes (v2.0) ─────────────────
const inferenceRoute    = require('./routes/inference');
const featuresRoute     = require('./routes/features');
const toolsRoute        = require('./routes/tools');
const memoryRoute       = require('./routes/memory');
const developerRoute    = require('./routes/developer');
const campRoute         = require('./routes/camp');
const { warmAll }       = require('./engine/modelWarmer');
const { metrics }       = require('./engine/inferenceEngine');
const { startKeepWarm } = require('./core/keepWarm');
const perfMonitor       = require('./core/perfMonitor');
const { runStartupAudit } = require('./core/gpuAudit');
const gpuResidency        = require('./core/gpuResidency');
const gpuScheduler        = require('./core/gpuScheduler');
const { getFreeVRAM }     = require('./core/vramTuner');

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
// This gateway is reachable over a public Cloudflare tunnel, so an empty
// credential configuration must NEVER mean "let everyone in" — that was a
// real bug: before any key existed in this process's env, every request
// (including ones with no Authorization header at all) was silently
// allowed through. Now a missing configuration fails CLOSED instead of open.
//
// Purpose-specific hardening (see core/gatewayAuth.js's own header comment
// for the full rationale): CAREERCAMP_API_KEY / CS_TRANSFORMER_API_KEY /
// CAREERCAMP_SECRET_KEY used to be checked as `VALID_GATEWAY_KEYS.some(k =>
// k === key)` -- ANY one of the three granting IDENTICAL access to nearly
// every route below. That defeated purpose isolation: rotating just one of
// the three achieved nothing, since the other two still unlocked the same
// surface. Each route family below now names exactly which credential
// class(es) its real, source-confirmed CareerStudioMax consumers use --
// see the route-to-credential matrix in that task's own report for the
// evidence behind each choice. (gatewayAuth itself is required near the
// top of this file, before the morgan :url token override, so it's reused
// here rather than required a second time.)
const _gwConfig = gatewayAuth.checkConfiguration();
if (!_gwConfig.ok) {
  console.error(
    `[GATEWAY-AUTH] FATAL: ${_gwConfig.reason}` +
    (_gwConfig.detail ? ` (${_gwConfig.detail.join(', ')})` : '') +
    '. Refusing to start with undefined/ambiguous authorization.'
  );
  process.exit(1);
}

// Credential classes: 'secret' = CAREERCAMP_SECRET_KEY (privileged/internal),
// 'camp' = CAREERCAMP_API_KEY (general CareerCamp API capabilities),
// 'transformer' = CS_TRANSFORMER_API_KEY (Transformer/STT).
const authInternal   = gatewayAuth.authorize(['secret']);              // privileged-only: no confirmed consumer today: diagnostics + the v2.0 platform routes' sensitive PII/memory/ethics surface
const authCampOrCore = gatewayAuth.authorize(['secret', 'camp']);      // /v1/models, chat, embeddings — confirmed callers use either
const authCamp       = gatewayAuth.authorize(['camp']);                // vision, BERT, search, /api/show — confirmed CAREERCAMP_API_KEY-only callers
const authAudio      = gatewayAuth.authorize(['camp', 'transformer']); // /v1/audio/* — careercamp-ext.js (camp) AND brain.js's STT path (transformer) both confirmed live

// ── Health & status ────────────────────────────────────────
// Real gap found live (2026-08-28): this response never reported SVD/
// SadTalker at all -- they're separate processes on their own ports
// (3005/3004), not Ollama models, so checking `engines.llm.ollamaModels`
// here (the field this project actually looks at) gave no signal on
// whether video generation was healthy, forcing a separate curl per pod
// per port just to know. Real, same-machine checks (short 3s timeout so
// a busy SVD generation in progress doesn't hang this response) added
// alongside the existing engine statuses, not replacing them.
async function _localVideoServiceHealth(port, name) {
  try {
    const r = await axios.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 });
    return { up: true, ...r.data };
  } catch (e) {
    return { up: false, service: name, error: e.code || e.message };
  }
}

app.get('/health', async (req, res) => {
  // Ports are hardcoded in svd_server.py/talkinghead_server.py themselves
  // (uvicorn.run(..., port=3005/3004)) — not actually configurable via
  // env var, so this matches that reality directly rather than implying
  // a config knob that doesn't exist.
  const [svd, talkinghead] = await Promise.all([
    _localVideoServiceHealth(3005, 'svd-selfhosted'),
    _localVideoServiceHealth(3004, 'talkinghead-sadtalker'),
  ]);
  res.json({
    status:  'ok',
    service: 'CareerCamp AI Gateway',
    version: '1.0.0',
    uptime:  process.uptime(),
    time:    new Date().toISOString(),
    // 'status: ok' above means the PROCESS is up and responding -- it has
    // never depended on any model being loaded and still doesn't. This
    // field is a SEPARATE, additive signal for the Salad model-warmup
    // background job (scripts/salad-model-warmup.sh /
    // core/modelWarmupState.js, added 2026-09-15): 'warming' | 'ready' |
    // 'degraded'. Salad's own startup probe is a plain TCP check on port
    // 3002, not an HTTP call here, so this field doesn't affect whether
    // the instance is considered started -- it's operational visibility,
    // for a human or a future readiness check to consult if they want to
    // know whether the LOCAL models specifically are ready yet, distinct
    // from "is the gateway itself up" (always answered by this endpoint
    // responding at all).
    modelWarmup: readWarmupState(),
    // Purely additive (2026-09-18, S3 restore root-cause pass) -- `null`
    // on the happy path, while still warming, or outside Salad entirely.
    // Never changes modelWarmup's own three-value contract above; existing
    // consumers of this endpoint that only read modelWarmup are unaffected.
    modelWarmupReason: readWarmupReason(),
    engines: {
      bert:    careerBERT.status(),
      llm:     careerLM.status(),
      vision:  careerVision.status(),
      voice:   careerVoice.status(),
      internet: internetEngine.status(),
      video:   { svd, talkinghead },
    },
  });
});

// Real, previously-missing proxy for Ollama's native /api/show — added
// 2026-08-08. cs_fixed's services/csModelGateway.js#_refreshOpusDeployment()
// calls `${CS_INFERENCE_URL}/api/show` to confirm which real model is
// actually deployed under the "cs-careeradvisor" name (vs what config merely
// declares) -- but CS_INFERENCE_URL in production points at THIS gateway
// (port 3002), which never had an /api/show route at all. Every real call
// was hitting a 404 and landing in that function's catch block, silently
// reporting "unverified" regardless of whether the real deployment was
// actually correct -- confirmed live: the real cs-careeradvisor model was
// genuinely the declared 32B, but this check still reported false because
// it could never actually reach Ollama's real answer. Proxies straight
// through to Ollama's own native endpoint (OLLAMA_URL, same var
// engine/llm.js already uses), not a reimplementation.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
app.post('/api/show', authCamp, async (req, res) => {
  try {
    const r = await axios.post(`${OLLAMA_URL}/api/show`, req.body, { timeout: 8000 });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 502).json({ error: e.response?.data?.error || e.message });
  }
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
      infer:       'POST /v1/infer',
      features:    'POST /v1/features/:featureId',
      tools:       'POST /v1/tools/:toolId',
      memory:      'GET|POST|DELETE /v1/memory/:userId',
      developer:   'GET  /v1/developer/health|status|metrics|docs',
    },
    auth: 'Authorization: Bearer YOUR_CAREERCAMP_API_KEY',
  });
});

// Mounted with app.use() (prefix mount), NOT app.get() (exact-path route) --
// modelsRoute is a full Router with its own GET '/' (list) and GET '/:model'
// (detail) sub-routes. An exact app.get('/v1/models', ...) used to hand the
// router the unstripped '/v1/models' request URL, which never matched
// either of the router's own patterns: GET /v1/models returned a 404 despite
// passing auth, and GET /v1/models/:model was never reachable through this
// mount at all (fixed 2026-09-15, CS-1 gateway auth review -- pre-existing
// bug, not introduced by the purpose-specific auth hardening, but it
// prevented verifying that hardening's ALLOW behavior for this route).
// app.use() strips the '/v1/models' prefix before dispatching into the
// router, so both sub-routes now resolve correctly, both still gated by the
// same authCampOrCore policy (secret, camp) as before.
app.use('/v1/models', authCampOrCore, (req, res, next) => {
  req.engines = app.locals.engines;
  next();
}, modelsRoute);

// ── OpenAI-compatible routes ───────────────────────────────
// chat/embeddings: confirmed CareerStudioMax callers (cs_fixed's
// camp-client.js, admin-server.js's pingProvider) use CAREERCAMP_API_KEY,
// and aiEnvironment.js's primaryKey chain resolves to CAREERCAMP_SECRET_KEY
// for /v1/models -- both are legitimate here.
app.use('/v1/chat/completions',  authCampOrCore, (req, _, next) => { req.engines = app.locals.engines; next(); }, completionsRoute);
app.use('/v1/embeddings',        authCampOrCore, (req, _, next) => { req.engines = app.locals.engines; next(); }, embeddingsRoute);
// vision: only CAREERCAMP_API_KEY confirmed (middleware/brain.js, careercamp-ext.js)
app.use('/v1/images',            authCamp, (req, _, next) => { req.engines = app.locals.engines; next(); }, visionRoute);
// audio: BOTH confirmed live -- careercamp-ext.js uses CAREERCAMP_API_KEY for
// transcriptions/speech/interview-analyze; middleware/brain.js's STT path
// uses CS_TRANSFORMER_API_KEY (as x-api-key) for transcriptions specifically.
app.use('/v1/audio',             authAudio, (req, _, next) => { req.engines = app.locals.engines; next(); }, audioRoute);

// ── CareerCamp-specific routes ─────────────────────────────
// bert: only CAREERCAMP_API_KEY confirmed (careercamp-ext.js)
app.use('/v1/bert',   authCamp, (req, _, next) => { req.engines = app.locals.engines; next(); }, bertRoute);
// agent: no confirmed CareerStudioMax caller today -- privileged-only default,
// consistent with the other unused-but-sensitive v2.0 platform routes below.
app.use('/v1/agent',  authInternal, (req, _, next) => { req.engines = app.locals.engines; next(); }, agentRoute);

// ── Self-hosted web search (SearXNG) ───────────────────────
// Real, live-caught gap (2026-09-06): this gateway's own /health
// `internet.duckduckgo` flag was a hardcoded `true` with no live check
// (engine/internet.js), and its actual DuckDuckGo call hits the same
// Instant-Answer API confirmed (from cs_fixed) to return empty results
// for real queries -- there was no genuinely working self-hosted search
// anywhere. SearXNG (open-source metasearch engine, /workspace/searxng-src)
// now runs locally on this pod (127.0.0.1:8888, started by
// scripts/start-all-with-recovery.sh) -- this route is the one way to
// reach it, reusing the centralized gateway auth rather than exposing
// SearXNG's own port directly (it has no auth of its own, and a public
// RunPod proxy port with zero auth would let anyone who found the URL use
// this pod as a free anonymous search proxy). CAREERCAMP_API_KEY only --
// confirmed caller is cs_fixed's services/search.js.
app.get('/v1/search', authCamp, async (req, res) => {
  const q = String(req.query.q || '').slice(0, 500);
  if (!q) return res.status(400).json({ error: { message: 'q is required', type: 'invalid_request_error', code: 400 } });
  try {
    const r = await axios.get('http://127.0.0.1:8888/search', {
      params: { q, format: 'json' },
      timeout: 12000,
    });
    const results = (r.data?.results || []).slice(0, 8).map(x => ({
      title: x.title || '', url: x.url || '', snippet: x.content || '',
    }));
    res.json({ query: q, results, engine: 'searxng-selfhosted' });
  } catch (e) {
    // Real, honest failure -- never fabricate results. A caller (cs_fixed's
    // services/search.js) falls through to its next real tier on this.
    res.status(502).json({ error: { message: `SearXNG unreachable: ${e.code || e.message}`, type: 'upstream_error', code: 502 } });
  }
});

// ── Local-First AI Platform v2.0 routes ───────────────────
// These 6 had no apiKeyAuth at all — harmless while this gateway was only
// ever reachable at localhost:3002, but a real hole once it gets a public
// IP on a GPU pod (see careercamp-ai/docker-compose.yml) — anyone who found
// the URL could hit them for free, including /v1/memory and /v1/developer.
// No confirmed CareerStudioMax caller exists for any of these 6 today (a
// full grep of cs_fixed found none) -- privileged-only ('secret' class)
// keeps them reachable for whatever intended future/partner caller they
// were built for, without handing that access to the narrower, currently
// externally-facing camp/transformer credentials. /v1/camp specifically
// fronts a "274-feature map pipeline (PII+memory+ethics+reasoning)" --
// exactly the kind of sensitive surface that should default to the most
// privileged credential, not the most broadly distributed one.
app.use('/v1/infer',      authInternal, inferenceRoute);
app.use('/v1/features',   authInternal, featuresRoute);
app.use('/v1/tools',      authInternal, toolsRoute);
app.use('/v1/memory',     authInternal, memoryRoute);
app.use('/v1/developer',  authInternal, developerRoute);
app.use('/v1/camp',       authInternal, campRoute);

// GPU Resource Manager status — internal use. No confirmed CareerStudioMax
// caller; previously a standalone single-value check accepting
// CS_TRANSFORMER_API_KEY OR CAREERCAMP_API_KEY with no route-family
// isolation at all. Now routed through the same centralized, privileged-
// only policy as the v2.0 platform routes above.
app.get('/v1/gpu-status', authInternal, async (req, res) => {
  try {
    const freeVramMB = await getFreeVRAM();
    res.json({
      success:     true,
      freeVramMB,
      residency:   gpuResidency.getStatus(),
      scheduler:   gpuScheduler.getLoad(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Performance stats — internal use
app.get('/v1/perf', authInternal, (req, res) => {
  res.json({ success: true, ...perfMonitor.getStats() });
});

// Aggregate metrics endpoint
app.get('/metrics', authInternal, (req, res) => {
  res.json({ success: true, ...metrics.getDetailed() });
});

// ── Vision endpoint alias ──────────────────────────────────
app.post('/v1/vision/analyze', authCamp, (req, res, next) => {
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
// 2026-09-15 (Salad startup-probe remediation): the TCP listener used to
// bind only AFTER runStartupAudit() and all 6 engines' .init() calls
// settled. Individually those are each bounded (a few seconds at most --
// runStartupAudit() wraps a single nvidia-smi call with its own 5s
// timeout; 5 of 6 engine inits carry their own 2-3s axios timeouts; the
// remaining one, CareerBERT's local embeddings model load, has no
// explicit timeout of its own but is wrapped in a try/catch that can
// only ever resolve, not hang the process), but stacked in front of
// server.listen() they still delayed Salad's TCP probe by a real, if
// smaller, amount on top of the (much larger, separately fixed) model-
// restore delay. None of this work affects whether the HTTP server can
// accept connections -- it only populates internal status flags
// (ollamaAvailable, modelStatus, etc.) that route handlers already check
// per-request, with their own existing fallback/retry behavior for
// exactly the "not ready yet" case (see engine/llm.js's
// _scheduleOllamaRetry, for one). So: bind the port FIRST, then run this
// startup work in the background -- it was never actually gating
// correctness, only (unnecessarily) gating the TCP listener.
function _runBackgroundStartupWork() {
  runStartupAudit()
    .then(() => Promise.allSettled([
      careerBERT.init(),
      careerLM.init(),
      careerVision.init(),
      careerVoice.init(),
      internetEngine.init(),
      contextEngine.init(),
    ]))
    .then((results) => {
      const names = ['CareerBERT', 'CareerLM', 'CareerVision', 'CareerVoice', 'InternetEngine', 'ContextEngine'];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') console.log(`  ✅ ${names[i]} ready`);
        else console.warn(`  ⚠  ${names[i]} degraded: ${r.reason?.message?.slice(0, 60)}`);
      });
    })
    .catch(e => console.error('[CareerCamp] Background engine init error:', e.message));

  // Warm local models (non-blocking — server starts regardless)
  warmAll().catch(() => {});
  startKeepWarm();  // heartbeat: ping cs-careerbriefing + cs-careerreasoning every 4 min to prevent VRAM unload
}

function boot() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  CareerCamp AI — Unique Career Intelligence          ║');
  console.log('║  LLM · VLM · Voice · BERT · Multimodal · Internet   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`\n  🚀 CareerCamp AI Gateway → http://localhost:${PORT}/v1`);
    console.log(`  📡 DNS targets:`);
    console.log(`       llm.careerstudiomax.com    → /v1/chat/completions`);
    console.log(`       vlm.careerstudiomax.com    → /v1/images/analyze`);
    console.log(`       voice.careerstudiomax.com  → /v1/audio/*`);
    console.log(`       embed.careerstudiomax.com  → /v1/embeddings`);
    console.log(`       bert.careerstudiomax.com   → /v1/bert/*\n`);

    _runBackgroundStartupWork();
  });

  // Graceful shutdown (2026-09-15, Salad startup-probe remediation): this
  // process is the container's real PID 1 after salad-entrypoint.sh's
  // `exec node server.js` -- without an explicit handler, Node does not
  // apply a default action to SIGTERM/SIGINT when running as PID 1 (a
  // standard Linux/Docker behavior for PID 1 specifically), so the
  // container runtime would otherwise wait out its full grace period and
  // SIGKILL instead of shutting down promptly. This also matters now that
  // a background model-warmup job (scripts/salad-model-warmup.sh) may
  // still be running in the same container: once this process actually
  // exits, the kernel tears down every other process left in the same PID
  // namespace, including that job -- but only if this process exits
  // promptly on a real termination signal instead of never noticing one.
  let _shuttingDown = false;
  function shutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`\n[CareerCamp] ${signal} received — shutting down gracefully...`);
    server.close(() => process.exit(0));
    // Don't hang forever waiting for slow in-flight requests to drain.
    setTimeout(() => process.exit(0), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

try {
  boot();
} catch (e) {
  console.error('[CareerCamp] Boot failed:', e.message);
  process.exit(1);
}
