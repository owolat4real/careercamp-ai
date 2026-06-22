'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// POST /v1/images/analyze
router.post('/analyze', upload.single('image'), async (req, res) => {
  const { vision, modal } = req.engines;
  const task   = req.body.task   || 'resume';
  const imageInput = req.file?.buffer || req.body.image || req.body.image_base64;
  if (!imageInput) return res.status(400).json({ error: { message: 'image required (multipart file or base64 in body)', type: 'invalid_request' } });

  // Multi-modal: if JD also provided, do full match
  if (req.body.jd_text && task === 'resume') {
    const result = await modal.analyzeCVImage(imageInput, req.body.jd_text);
    return res.json({ object: 'image_analysis', task, ...result });
  }

  const result = await vision.analyzeImage(imageInput, task, req.body);
  res.json({ object: 'image_analysis', task, ...result });
});

// POST /v1/images/video-frames (interview coaching)
router.post('/video-frames', upload.array('frames', 10), async (req, res) => {
  const { vision } = req.engines;
  const frames = req.files?.map(f => f.buffer) || JSON.parse(req.body.frames || '[]');
  const task   = req.body.task || 'interview_frame';
  const result = await vision.analyzeVideoFrames(frames, task);
  res.json({ object: 'video_analysis', task, ...result });
});

module.exports = router;
