'use strict';
/**
 * /v1/developer — Developer portal: API docs, model status, metrics, warm status.
 * Every route here requires the outer 'secret'-class gateway credential (see
 * the auth comment below) -- there is no unauthenticated route in this file.
 * External monitoring should use the top-level GET /health instead, which
 * remains genuinely public.
 */
const express = require('express');
const router  = express.Router();
const { metrics, TASK_MODELS, MODELS } = require('../engine/inferenceEngine');
const { getWarmStatus, quickPing }     = require('../engine/modelWarmer');

// Auth: enforced by core/gatewayAuth.js's centralized `authorize(['secret'])`
// policy at this router's mount point in server.js -- applies to EVERY route
// below, including /health, /status and /docs (their own comments below
// predate that outer wrapping and are now stale: nothing under /v1/developer
// is actually reachable without the 'secret' credential any more). A
// router-local apiKeyGuard checking CS_TRANSFORMER_API_KEY/CAREERCAMP_API_KEY
// used to additionally gate /metrics, /ping/:model and /task-models --
// removed 2026-09-15 (CS-1 gateway auth review) because it conflicted with
// the outer 'secret'-class policy. See routes/inference.js's identical
// comment for the full rationale.

/* GET /v1/developer/health — health check (outer 'secret' policy applies) */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'careercamp-ai', uptime: Math.round(process.uptime()) });
});

/* GET /v1/developer/status — model warm status (outer 'secret' policy applies) */
router.get('/status', (req, res) => {
  const warmStatus = getWarmStatus();
  const allModels = Object.keys(MODELS).map(key => ({
    id:        key,
    tier:      MODELS[key].tier,
    warm:      !!warmStatus[key],
    maxTokens: MODELS[key].maxTokens,
  }));
  res.json({
    service:    'careercamp-ai',
    version:    '2.0.0',
    platform:   'local-first',
    models:     allModels,
    localFirst: true,
    uptime:     Math.round(process.uptime()),
  });
});

/* GET /v1/developer/metrics — detailed performance metrics (auth required) */
router.get('/metrics', (req, res) => {
  const summary  = metrics.getSummary();
  const detailed = metrics.getDetailed();
  res.json({ success: true, summary, detailed });
});

/* POST /v1/developer/ping/:model — ping a specific model */
router.post('/ping/:model', async (req, res) => {
  const { model } = req.params;
  if (!MODELS[model]) return res.status(400).json({ error: `Unknown model: ${model}. Valid: ${Object.keys(MODELS).join(', ')}` });
  const start = Date.now();
  const warm  = await quickPing(model);
  res.json({ model, warm, latencyMs: Date.now() - start });
});

/* GET /v1/developer/task-models — show task → model routing table */
router.get('/task-models', (req, res) => {
  const table = Object.entries(TASK_MODELS).map(([task, model]) => ({
    task,
    model,
    tier: MODELS[model]?.tier || 'unknown',
  }));
  res.json({ success: true, count: table.length, taskModels: table });
});

/* GET /v1/developer/docs — API documentation */
router.get('/docs', (req, res) => {
  res.json({
    name:    'CareerCamp AI Gateway',
    version: '2.0.0',
    endpoints: [
      { method: 'POST', path: '/v1/infer',                    auth: true,  description: 'OpenAI-compatible inference. Supports stream:true.' },
      { method: 'GET',  path: '/v1/features/:featureId',      auth: true,  description: 'Feature info: task mapping, recommended model.' },
      { method: 'POST', path: '/v1/features/:featureId',      auth: true,  description: 'Feature-specific inference. 274 features supported.' },
      { method: 'POST', path: '/v1/tools/:toolId',            auth: true,  description: 'Tool intelligence: demand score, salary premium, learning path.' },
      { method: 'POST', path: '/v1/tools/:toolId/compare',    auth: true,  description: 'Compare two professional tools.' },
      { method: 'GET',  path: '/v1/memory/:userId',           auth: true,  description: 'Read persistent career memory for a user.' },
      { method: 'POST', path: '/v1/memory/:userId',           auth: true,  description: 'Update career memory fields.' },
      { method: 'DELETE',path: '/v1/memory/:userId',          auth: true,  description: 'Clear all memory for a user.' },
      { method: 'POST', path: '/v1/memory/:userId/extract',   auth: true,  description: 'Extract career facts from conversation and save to memory.' },
      { method: 'GET',  path: '/v1/developer/health',         auth: true,  description: 'Health check. Use the top-level GET /health for unauthenticated monitoring.' },
      { method: 'GET',  path: '/v1/developer/status',         auth: true,  description: 'Model warm status and platform info.' },
      { method: 'GET',  path: '/v1/developer/metrics',        auth: true,  description: 'Detailed performance metrics per model.' },
      { method: 'POST', path: '/v1/developer/ping/:model',    auth: true,  description: 'Ping a specific local model to check warm status.' },
      { method: 'GET',  path: '/v1/developer/task-models',    auth: true,  description: 'Task to model routing table.' },
      { method: 'GET',  path: '/v1/camp',                       auth: true,  description: 'List all 274 CAMP features with model, task, and token budget.' },
      { method: 'GET',  path: '/v1/camp/:featureId',            auth: true,  description: 'Feature info: model tier, task type, PII scrub status, max tokens.' },
      { method: 'POST', path: '/v1/camp/:featureId',            auth: true,  description: 'Full 8-step pipeline: PII scrub → memory → ethics → reasoning → local model → guardrails → PII restore. Body: { userInput, userId?, language?, messages?, stream? }.' },
    ],
    authentication: 'Pass API key as x-api-key header or Authorization: Bearer <key>',
    localFirstGuarantee: 'Groq/OpenRouter only called if ALL local models fail simultaneously.',
    campFeatureMap: { total: 274, callPattern: 'POST /v1/camp/:featureId  { userInput, userId? }', categories: ['resume', 'cover_letter', 'interview', 'salary', 'linkedin', 'job_hunt', 'lifepath', 'career_goals', 'brain_ai', 'tool_intelligence', 'enterprise'] },
    models: Object.keys(MODELS),
  });
});

module.exports = router;
