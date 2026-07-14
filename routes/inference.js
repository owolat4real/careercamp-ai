'use strict';
/**
 * /v1/infer — OpenAI-compatible inference endpoint.
 * Routes requests through the 12-step local-first inference pipeline.
 */
const express  = require('express');
const router   = express.Router();
const { infer, stream } = require('../engine/inferenceEngine');

function apiKeyGuard(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
  const valid = process.env.CS_TRANSFORMER_API_KEY || process.env.CAREERCAMP_API_KEY;
  if (!valid || key !== valid) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* POST /v1/infer — blocking inference */
router.post('/', apiKeyGuard, async (req, res) => {
  const {
    messages, userInput, userId, featureId, task,
    language, toolName, maxTokens, forceModel, schema,
    keepSalary, keepLinkedIn, stream: wantsStream,
  } = req.body;

  if (!messages && !userInput) {
    return res.status(400).json({ error: 'messages or userInput is required' });
  }

  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      for await (const event of stream({ messages, userInput, userId, featureId, task, language, toolName, maxTokens, forceModel, keepSalary, keepLinkedIn })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }
    return res.end();
  }

  try {
    const result = await infer({ messages, userInput, userId, featureId, task, language, toolName, maxTokens, forceModel, schema, keepSalary, keepLinkedIn });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[/v1/infer] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
