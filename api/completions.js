/**
 * POST /v1/chat/completions — OpenAI-compatible completions endpoint
 *
 * Handles: streaming (stream:true) and non-streaming requests.
 * Routes to: CareerLM → Ollama → HF → OR based on model ID.
 * Injects internet context + user career profile into every request.
 */
'use strict';
const express = require('express');
const router  = express.Router();

router.post('/', async (req, res) => {
  const { messages = [], model = 'careerlm-base', stream = false, max_tokens, temperature } = req.body;
  const { llm, context } = req.engines;

  // Extract user context from messages (system message or special header)
  const sysMsg   = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const lastUser = userMsgs.findLast?.(m => m.role === 'user') || userMsgs[userMsgs.length - 1];
  const prompt   = lastUser?.content || '';

  // Extract user context from request body extras
  const userCtx = {
    career:  req.body.career  || req.body.ctx?.career  || '',
    country: req.body.country || req.body.ctx?.country || '',
    level:   req.body.level   || req.body.ctx?.level   || '',
    name:    req.body.name    || '',
    goals:   req.body.goals   || '',
    skills:  req.body.skills  || '',
  };

  // Build system prompt with internet grounding
  const systemContent = await context.buildFullContext(prompt, userCtx);
  const system        = sysMsg ? sysMsg.content + '\n\n' + systemContent : systemContent;

  const opts = {
    maxTokens: max_tokens || 8000,
    temp:      temperature || 0.82,
  };

  // ── STREAMING ────────────────────────────────────────────
  if (stream) {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    try {
      // Emit model identification (CSTM-1 branding)
      send({ type: 'cstm_model', model: 'CSTM-1', version: '1.0.0', domain: 'Career Intelligence', engine: model });

      const chunkId = `chatcmpl-cc${Date.now()}`;
      let full = '';

      for await (const token of llm.stream(prompt, system, model, opts)) {
        full += token;
        // OpenAI-compatible SSE delta
        send({
          id:      chunkId,
          object:  'chat.completion.chunk',
          model:   model,
          choices: [{ delta: { content: token }, index: 0, finish_reason: null }],
          // Also emit text type for Career Studio's reader
          type: 'text',
          text: token,
        });
      }

      // Final chunk
      send({ id: chunkId, object: 'chat.completion.chunk', model, choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], type: 'done', confidence: 95, engine: model });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      send({ type: 'error', error: e.message });
      res.end();
    }
    return;
  }

  // ── NON-STREAMING ─────────────────────────────────────────
  try {
    const { text, engine } = await llm.infer(prompt, system, model, opts);
    res.json({
      id:      `chatcmpl-cc${Date.now()}`,
      object:  'chat.completion',
      model:   model,
      created: Math.floor(Date.now() / 1000),
      choices: [{ message: { role: 'assistant', content: text }, index: 0, finish_reason: 'stop' }],
      usage:   { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil((prompt.length + text.length) / 4) },
      _engine: engine, // transparent engine disclosure
    });
  } catch (e) {
    res.status(503).json({ error: { message: e.message, type: 'engine_error', code: 503 } });
  }
});

module.exports = router;
