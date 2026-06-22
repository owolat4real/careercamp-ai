'use strict';
const router = require('express').Router();

const MODELS = [
  { id:'careerlm-nano',    object:'model', owned_by:'careerstudio', family:'CareerLM', params:'1B',    description:'Ultra-fast career Q&A, instant responses',                  context_length:8192  },
  { id:'careerlm-small',   object:'model', owned_by:'careerstudio', family:'CareerLM', params:'7B',    description:'Fast career intelligence, good quality',                    context_length:16384 },
  { id:'careerlm-base',    object:'model', owned_by:'careerstudio', family:'CareerLM', params:'8B',    description:'Balanced speed/quality, all career tasks',                  context_length:16384 },
  { id:'careerlm-large',   object:'model', owned_by:'careerstudio', family:'CareerLM', params:'70B',   description:'High-quality deep analysis, simulation, coaching',           context_length:32768 },
  { id:'careerlm-xl',      object:'model', owned_by:'careerstudio', family:'CareerLM', params:'72B',   description:'Maximum depth — complex multi-year career planning',         context_length:65536 },
  { id:'careervision-v1',  object:'model', owned_by:'careerstudio', family:'CareerVision', params:'7B', description:'CV image analysis, portfolio review, interview frames',    context_length:4096  },
  { id:'careervoice-v1',   object:'model', owned_by:'careerstudio', family:'CareerVoice', params:'STT', description:'Whisper-based STT + XTTS TTS, 16 languages',              context_length:0     },
  { id:'careerembed-v1',   object:'model', owned_by:'careerstudio', family:'CareerEmbed', params:'22M', description:'384-dim sentence embeddings, resume/JD matching',          context_length:512   },
  { id:'careerscore-v1',   object:'model', owned_by:'careerstudio', family:'CareerScore', params:'BERT','description':'BERT-based ATS/resume/interview scoring',              context_length:512   },
  { id:'careeragent-v1',   object:'model', owned_by:'careerstudio', family:'CareerAgent', params:'ReAct','description':'Agentic career search + apply + intelligence loop',   context_length:16384 },
];

router.get('/', (req, res) => {
  res.json({ object: 'list', data: MODELS });
});

router.get('/:model', (req, res) => {
  const m = MODELS.find(m => m.id === req.params.model);
  if (!m) return res.status(404).json({ error: { message: `Model '${req.params.model}' not found`, type: 'invalid_request_error' } });
  res.json(m);
});

module.exports = router;
