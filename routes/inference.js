'use strict';
/**
 * /v1/infer — OpenAI-compatible inference endpoint.
 * Routes requests through the 12-step local-first inference pipeline.
 */
const express  = require('express');
const router   = express.Router();
const { infer, stream } = require('../engine/inferenceEngine');

// Auth: enforced by core/gatewayAuth.js's centralized `authorize(['secret'])`
// policy at the mount point in server.js (`app.use('/v1/infer', authInternal,
// inferenceRoute)`). A router-local apiKeyGuard checking CS_TRANSFORMER_API_KEY
// / CAREERCAMP_API_KEY used to live here too -- removed 2026-09-15 (CS-1 gateway
// auth review) because it silently rejected the outer policy's intended
// 'secret'-class caller with a second, conflicting credential check. Do not
// re-add a route-local credential comparison here; extend the outer policy
// in server.js instead so there remains exactly one authorization decision
// per request.
router.post('/', async (req, res) => {
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
