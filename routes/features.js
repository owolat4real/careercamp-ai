'use strict';
/**
 * /v1/features/:featureId — Feature-specific AI inference.
 * Each of 274 features maps to a task type and gets a tailored system prompt.
 */
const express = require('express');
const router  = express.Router();
const { infer, stream, TASK_MODELS } = require('../engine/inferenceEngine');
const { buildOfflineResponse }       = require('../core/offlineResponder');

function apiKeyGuard(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
  const valid = process.env.CS_TRANSFORMER_API_KEY || process.env.CAREERCAMP_API_KEY;
  if (!valid || key !== valid) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* Derive the best task for a given featureId */
function featureToTask(featureId = '') {
  const f = featureId.toLowerCase();
  if (f.includes('bullet') || f.includes('cv') || f.includes('resume'))    return 'cv_bullet';
  if (f.includes('cover'))                                                   return 'cover_letter';
  if (f.includes('interview'))                                               return 'interview_prep';
  if (f.includes('salary') || f.includes('negotiat'))                       return 'salary_analysis';
  if (f.includes('linkedin'))                                                return 'linkedin_optimise';
  if (f.includes('lifepath') || f.includes('simulation'))                   return 'lifepath_sim';
  if (f.includes('tool'))                                                    return 'tool_analysis';
  if (f.includes('skill') || f.includes('gap'))                             return 'skill_gap';
  if (f.includes('job') || f.includes('match'))                             return 'job_match';
  if (f.includes('summarise') || f.includes('summary'))                     return 'summarise';
  if (f.includes('extract'))                                                 return 'json_extract';
  return 'career_advice';
}

/* GET /v1/features/:featureId — feature info */
router.get('/:featureId', apiKeyGuard, (req, res) => {
  const { featureId } = req.params;
  const task = featureToTask(featureId);
  res.json({
    featureId,
    task,
    recommendedModel: TASK_MODELS[task] || 'cs-sonnet',
    description: `Feature ${featureId} maps to task: ${task}`,
  });
});

/* POST /v1/features/:featureId — feature inference */
router.post('/:featureId', apiKeyGuard, async (req, res) => {
  const { featureId } = req.params;
  const {
    messages, userInput, userId, language, toolName,
    maxTokens, task: taskOverride, keepSalary, keepLinkedIn,
    stream: wantsStream,
  } = req.body;

  const task = taskOverride || featureToTask(featureId);

  if (!messages && !userInput) {
    return res.status(400).json({ error: 'messages or userInput is required' });
  }

  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    try {
      for await (const event of stream({ messages, userInput, userId, featureId, task, language, toolName, maxTokens, keepSalary, keepLinkedIn })) {
        // Never forward a raw error event — convert it to offline content so the
        // client always receives a useful response instead of a dead-end message.
        if (event.type === 'error') {
          console.error(`[/v1/features/${featureId}] Stream error:`, event.message);
          const offline = buildOfflineResponse(featureId, userInput || '');
          res.write(`data: ${JSON.stringify({ type: 'token', content: offline })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done', model: 'degraded', featureId })}\n\n`);
          break;
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done') break;
      }
    } catch (err) {
      // Uncaught exception from the stream generator itself
      console.error(`[/v1/features/${featureId}] Stream fatal:`, err.message);
      const offline = buildOfflineResponse(featureId, userInput || '');
      res.write(`data: ${JSON.stringify({ type: 'token', content: offline })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', model: 'degraded', featureId })}\n\n`);
    }
    return res.end();
  }

  try {
    const result = await infer({ messages, userInput, userId, featureId, task, language, toolName, maxTokens, keepSalary, keepLinkedIn });
    res.json({ success: true, featureId, ...result });
  } catch (err) {
    // Never return a 500 — always give the user something useful
    console.error(`[/v1/features/${featureId}] Fatal:`, err.message);
    const offline = buildOfflineResponse(featureId, userInput || '');
    res.json({ success: true, content: offline, model: 'degraded', featureId, task, degraded: true });
  }
});

module.exports = router;
