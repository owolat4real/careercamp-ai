'use strict';
/**
 * /v1/memory — Per-user persistent career memory.
 * Read, write, and clear career context that persists across sessions.
 */
const express = require('express');
const router  = express.Router();
const { MemoryInSaver } = require('../engine/memoryInSaver');

const mem = new MemoryInSaver();

function apiKeyGuard(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
  const valid = process.env.CS_TRANSFORMER_API_KEY || process.env.CAREERCAMP_API_KEY;
  if (!valid || key !== valid) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireUserId(req, res, next) {
  const userId = req.params.userId || req.body?.userId || req.query?.userId;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  req.userId = userId;
  next();
}

/* GET /v1/memory/:userId — read memory */
router.get('/:userId', apiKeyGuard, requireUserId, async (req, res) => {
  try {
    const userMemory = await mem.get(req.userId);
    if (!userMemory) return res.json({ success: true, userId: req.userId, memory: null, hasMemory: false });
    res.json({
      success:      true,
      userId:       req.userId,
      memory:       userMemory,
      hasMemory:    true,
      contextBlock: mem.toContextBlock(userMemory),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* POST /v1/memory/:userId — update memory fields */
router.post('/:userId', apiKeyGuard, requireUserId, async (req, res) => {
  const { updates } = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'updates object is required' });
  }
  try {
    await mem.update(req.userId, updates);
    const updated = await mem.get(req.userId);
    res.json({ success: true, userId: req.userId, memory: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* DELETE /v1/memory/:userId — clear memory */
router.delete('/:userId', apiKeyGuard, requireUserId, async (req, res) => {
  try {
    await mem.clear(req.userId);
    res.json({ success: true, userId: req.userId, cleared: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* POST /v1/memory/:userId/extract — extract and save facts from a conversation */
router.post('/:userId/extract', apiKeyGuard, requireUserId, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  try {
    const { infer } = require('../engine/inferenceEngine');
    await mem.extractAndSave(req.userId, messages, infer);
    const updated = await mem.get(req.userId);
    res.json({ success: true, userId: req.userId, memory: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
