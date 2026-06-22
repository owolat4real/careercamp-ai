'use strict';
const router = require('express').Router();

// POST /v1/bert/:task — Direct BERT task endpoint
router.post('/:task', async (req, res) => {
  const { bert } = req.engines;
  const { task } = req.params;
  try {
    const result = await bert.infer(task, req.body, req.query);
    res.json({ object: 'bert_result', task, ...result, model: 'CareerBERT-v1' });
  } catch (e) {
    res.status(400).json({ error: { message: e.message, type: 'invalid_task' } });
  }
});

// GET /v1/bert/tasks — List available tasks
router.get('/tasks', (req, res) => {
  res.json({
    tasks: [
      { id: 'match',     description: 'Resume–JD match score (0-100)', inputs: ['resume', 'jd'] },
      { id: 'skills',    description: 'Extract skills from text',       inputs: ['text'] },
      { id: 'stage',     description: 'Detect career stage',            inputs: ['text'] },
      { id: 'normalise', description: 'Normalise job title',            inputs: ['title'] },
      { id: 'score',     description: 'Score interview answer (STAR)',   inputs: ['answer'] },
      { id: 'burnout',   description: 'Detect burnout signals',          inputs: ['text'] },
      { id: 'embed',     description: 'Generate embeddings',             inputs: ['texts'] },
    ],
    model: 'CareerBERT-v1',
    architecture: 'BERT-base + career fine-tuning (768-dim, 12-layer, 12-head)',
  });
});

module.exports = router;
