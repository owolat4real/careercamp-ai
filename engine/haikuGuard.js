'use strict';
/**
 * HAIKU GUARD — Shared protection for all cs-haiku call sites in CAMP gateway.
 * Mirror of careerstudio/services/haikuGuard.js — keep in sync.
 */

const LEAK_PATTERNS = [
  /\b(i am|i'm|this is|powered by)\s+(llama|mistral|gpt|chatgpt|gemini|anthropic|claude)\b/i,
  /\bllama\s*\d+(?:\.\d+)?\b/i,
  /\bmeta(?:'s)?\s+(?:ai|llama)\b/i,
  /\bhugging\s*face\b/i,
  /^you (are|must be) careerlm/i,
  /^you must always/i,
  /^these are (?:the )?(?:rules|guidelines)/i,
  /^as (?:an ai|cstm|careerlm|a career)/i,
  /^1\.\s*when asked for json/i,
  /^guidelines:\s*\n/i,
  /^system:/i,
  /never reveal.*identity/i,
  /your identity is/i,
  /system prompt/i,
  /as an ai language model/i,
  /i'm just an ai/i,
  /i cannot provide personal/i,
  /i don't have (feelings|emotions|opinions|personal)/i,
  /i was (trained|created|built) by/i,
  /^(sure|certainly|of course|absolutely)[,!.]\s*here(?:'?s| is| are)/i,
  /^here(?:'s| is| are) (?:the |your |a )/i,
  /^below (?:is|are) (?:the |your |a )/i,
];

const BANNED_PHRASES = [
  'passionate about', 'team player', 'results-driven', 'hard worker',
  'detail-oriented', 'go-getter', 'synergy', 'leverage', 'dynamic',
  'innovative solutions', 'proven track record', 'excellent communication skills',
  'highly motivated', 'seeking opportunities', 'think outside the box',
  'hit the ground running', 'value-add', 'low-hanging fruit', 'move the needle',
  'deep dive', 'circle back', 'bandwidth', 'as an AI language model',
  'I am an AI', 'large language model',
];

function detectLeak(text) {
  if (!text || typeof text !== 'string') return { leaked: true, reason: 'empty_response' };
  const trimmed = text.trimStart();
  for (const re of LEAK_PATTERNS) {
    if (re.test(trimmed)) return { leaked: true, reason: 'identity_or_preamble_leak', pattern: re.toString(), snippet: text.slice(0, 120) };
  }
  if (trimmed.split(/\s+/).length < 3) return { leaked: true, reason: 'too_short', snippet: text };
  const firstLine = trimmed.split('\n')[0].trim();
  if (firstLine.length > 200 && /careerlm/i.test(firstLine)) return { leaked: true, reason: 'system_prompt_preamble', snippet: firstLine.slice(0, 120) };
  return { leaked: false };
}

class StreamingLeakGuard {
  constructor(bufferSize = 120) {
    this.bufferSize = bufferSize;
    this.buffer = '';
    this.released = false;
    this.aborted = false;
    this.fullText = '';
  }
  feed(token) {
    this.fullText += token;
    if (this.aborted) return { action: 'drop', token: null };
    if (this.released) return { action: 'emit', token };
    this.buffer += token;
    if (this.buffer.length >= this.bufferSize) {
      const leak = detectLeak(this.buffer);
      if (leak.leaked) {
        this.aborted = true;
        console.warn('[HaikuGuard:CAMP] Stream leak:', leak.reason, '|', leak.snippet?.slice(0, 50));
        return { action: 'abort', reason: leak.reason };
      }
      this.released = true;
      const toEmit = this.buffer;
      this.buffer = '';
      return { action: 'flush_and_emit', token: toEmit };
    }
    return { action: 'buffer', token: null };
  }
  end() {
    if (this.aborted) return { action: 'aborted', fullText: this.fullText };
    if (!this.released && this.buffer.length > 0) {
      const leak = detectLeak(this.buffer);
      if (leak.leaked) return { action: 'aborted', reason: leak.reason };
      return { action: 'flush', token: this.buffer };
    }
    return { action: 'done', fullText: this.fullText };
  }
}

function cleanBannedPhrases(text) {
  if (!text) return '';
  let clean = text;
  for (const phrase of BANNED_PHRASES) {
    clean = clean.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const _HAIKU_PROMPTS = {
  default:     'CareerLM career AI. Be brief and helpful.',
  summarise:   'Summarise clearly. Bullet points. Be concise.',
  classify:    'Reply with ONE category word only.',
  quick_reply: 'CareerLM. Short direct answer only.',
  sentiment:   'Reply: POSITIVE, NEGATIVE, or NEUTRAL only.',
  keyword:     'List keywords only. Comma separated.',
  compress:    'Compress to key facts. Under 100 words.',
  job_match:   'Score job match. Return JSON numbers only.',
};

function getHaikuSystemPrompt(task) {
  return _HAIKU_PROMPTS[task] || _HAIKU_PROMPTS.default;
}

function truncateForHaiku(text, maxWords = 150) {
  if (!text) return '';
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(' ') + '…';
}

function compressForHaiku(messages) {
  if (!Array.isArray(messages) || messages.length <= 3) return messages;
  const sys = messages.find(m => m.role === 'system');
  const recent = messages.filter(m => m.role !== 'system').slice(-2);
  return sys ? [sys, ...recent] : recent;
}

module.exports = { detectLeak, cleanBannedPhrases, StreamingLeakGuard, getHaikuSystemPrompt, truncateForHaiku, compressForHaiku, LEAK_PATTERNS, BANNED_PHRASES };
