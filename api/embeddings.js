'use strict';
const router = require('express').Router();

router.post('/', async (req, res) => {
  const { input, model = 'careerembed-v1' } = req.body;
  const { bert } = req.engines;
  const texts = Array.isArray(input) ? input : [input];
  try {
    const embeddings = await bert.embed(texts);
    res.json({
      object: 'list',
      model,
      data: embeddings.map((e, i) => ({ object: 'embedding', index: i, embedding: e })),
      usage: { prompt_tokens: texts.reduce((s, t) => s + Math.ceil(t.length/4), 0), total_tokens: 0 },
    });
  } catch (e) {
    res.status(503).json({ error: { message: e.message, type: 'engine_error' } });
  }
});

module.exports = router;
