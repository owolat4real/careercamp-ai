'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /v1/audio/transcriptions — Whisper STT
router.post('/transcriptions', upload.single('file'), async (req, res) => {
  const { voice } = req.engines;
  const audioInput = req.file?.buffer || req.body.audio;
  if (!audioInput) return res.status(400).json({ error: { message: 'audio file required', type: 'invalid_request' } });
  try {
    const result = await voice.transcribe(audioInput, { language: req.body.language || 'en', model: req.body.model || 'base' });
    res.json({ text: result.text, language: result.language, engine: result.engine });
  } catch (e) { res.status(503).json({ error: { message: e.message } }); }
});

// POST /v1/audio/speech — XTTS TTS
router.post('/speech', async (req, res) => {
  const { voice } = req.engines;
  const { input, voice: voiceId = 'career-coach', language = 'en', response_format = 'mp3' } = req.body;
  if (!input) return res.status(400).json({ error: { message: 'input text required' } });
  try {
    const result = await voice.synthesize(input, { voice: voiceId, language, engine: req.body.engine });
    if (result.audio) {
      res.setHeader('Content-Type', result.format === 'wav' ? 'audio/wav' : 'audio/mpeg');
      res.send(result.audio);
    } else {
      // Browser TTS fallback
      res.json({ text: result.text, fallback: true, message: result.message, voice: voiceId });
    }
  } catch (e) { res.status(503).json({ error: { message: e.message } }); }
});

// POST /v1/audio/interview-analyze — Full interview audio analysis
router.post('/interview-analyze', upload.single('audio'), async (req, res) => {
  const { voice, bert } = req.engines;
  const audioInput = req.file?.buffer || req.body.audio;
  const question   = req.body.question || '';
  if (!audioInput) return res.status(400).json({ error: { message: 'audio required' } });
  try {
    const transcript = await voice.transcribe(audioInput, { language: req.body.language || 'en' });
    const starScore  = bert.scoreInterviewAnswer(transcript.text);
    const burnout    = bert.detectBurnout(transcript.text);
    res.json({ transcript: transcript.text, engine: transcript.engine, question, starScore, burnout });
  } catch (e) { res.status(503).json({ error: { message: e.message } }); }
});

module.exports = router;
