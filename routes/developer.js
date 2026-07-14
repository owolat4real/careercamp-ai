'use strict';
/**
 * /v1/developer — Developer portal: API docs, model status, metrics, warm status.
 * No auth on GET /status and GET /health so monitoring tools can ping freely.
 */
const express = require('express');
const router  = express.Router();
const { metrics, TASK_MODELS, MODELS } = require('../engine/inferenceEngine');
const { getWarmStatus, quickPing }     = require('../engine/modelWarmer');

function apiKeyGuard(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
  const valid = process.env.CS_TRANSFORMER_API_KEY || process.env.CAREERCAMP_API_KEY;
  if (!valid || key !== valid) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* GET /v1/developer/health — public health check */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'careercamp-ai', uptime: Math.round(process.uptime()) });
});

/* GET /v1/developer/status — model warm status (no auth) */
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
router.get('/metrics', apiKeyGuard, (req, res) => {
  const summary  = metrics.getSummary();
  const detailed = metrics.getDetailed();
  res.json({ success: true, summary, detailed });
});

/* POST /v1/developer/ping/:model — ping a specific model */
router.post('/ping/:model', apiKeyGuard, async (req, res) => {
  const { model } = req.params;
  if (!MODELS[model]) return res.status(400).json({ error: `Unknown model: ${model}. Valid: ${Object.keys(MODELS).join(', ')}` });
  const start = Date.now();
  const warm  = await quickPing(model);
  res.json({ model, warm, latencyMs: Date.now() - start });
});

/* GET /v1/developer/task-models — show task → model routing table */
router.get('/task-models', apiKeyGuard, (req, res) => {
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
      { method: 'GET',  path: '/v1/developer/health',         auth: false, description: 'Public health check.' },
      { method: 'GET',  path: '/v1/developer/status',         auth: false, description: 'Model warm status and platform info.' },
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
