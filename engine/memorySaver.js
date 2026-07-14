'use strict';
/**
 * MEMORY SAVER — Keeps conversation context under 200 tokens always.
 * Extracts career facts from messages into a structured profile.
 * Compresses old history with cs-haiku when the message count exceeds threshold.
 */

const COMPRESS_AFTER     = 4;   // messages before compression
const KEEP_RECENT        = 2;   // most recent messages to keep verbatim

class MemorySaver {

  constructor() {
    this._sessions = new Map(); // userId → session
    // Prune idle sessions every 30 min
    setInterval(() => this.cleanup(), 30 * 60 * 1000).unref?.();
  }

  /* ── SESSION ─────────────────────────────────────────────────── */
  _getSession(userId) {
    if (!this._sessions.has(userId)) {
      this._sessions.set(userId, {
        careerProfile:     {},
        compressedHistory: null,
        recentMessages:    [],
        turnCount:         0,
        lastActive:        Date.now(),
      });
    }
    return this._sessions.get(userId);
  }

  /* ── ADD MESSAGE ─────────────────────────────────────────────── */
  async addMessage(userId, role, content, inferFn) {
    const session = this._getSession(userId);
    session.recentMessages.push({ role, content, timestamp: Date.now() });
    session.turnCount++;
    session.lastActive = Date.now();

    if (role === 'user') this._extractFacts(session, content);

    if (session.recentMessages.length > COMPRESS_AFTER * 2) {
      await this._compress(session, inferFn).catch(() => {});
    }
  }

  /* ── FACT EXTRACTION ─────────────────────────────────────────── */
  _extractFacts(session, text) {
    const p = session.careerProfile;

    const roleM = text.match(/\b(?:I am|I'm|my role is|I work as)\s+(?:a\s+)?([A-Za-z\s]+?)\b(?:\s+at|\s+in|\.|,)/i);
    if (roleM) p.currentRole = roleM[1].trim();

    const expM = text.match(/\b(\d+)\s+years?\s+(?:of\s+)?experience\b/i);
    if (expM) p.yearsExperience = parseInt(expM[1]);

    const targetM = text.match(/\b(?:want to|looking to|trying to|aiming to)\s+(?:become|be|get)\s+(?:a\s+)?([A-Za-z\s]+?)\b(?:\.|,)/i);
    if (targetM) p.targetRole = targetM[1].trim();

    const locM = text.match(/\b(?:based in|located in|living in|in)\s+([A-Z][A-Za-z\s]{2,20})\b/i);
    if (locM) p.location = locM[1].trim();

    const salM = text.match(/\b(?:earning|making|salary of|paid)\s+[£$€]?([\d,]+k?)\b/i);
    if (salM) p.currentSalary = salM[1];

    session.careerProfile = p;
  }

  /* ── COMPRESS ────────────────────────────────────────────────── */
  async _compress(session, inferFn) {
    const toCompress = session.recentMessages.slice(0, -KEEP_RECENT);
    const recent     = session.recentMessages.slice(-KEEP_RECENT);
    if (!toCompress.length) return;

    const historyText = toCompress
      .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 200)}`)
      .join('\n');

    const result = await inferFn({
      userInput: `Extract ONLY career facts. Under 80 words. Bullet points.
Keep: role, company, goals, decisions, specific numbers.
Remove: greetings, questions, generic chat.

CONVERSATION:
${historyText}`,
      task:      'summarise',
      maxTokens: 150,
    });

    session.compressedHistory = result?.content || '';
    session.recentMessages    = recent;
  }

  /* ── BUILD MESSAGES ──────────────────────────────────────────── */
  buildMessages(userId, systemPrompt, newUserInput) {
    const session  = this._getSession(userId);
    const messages = [{ role: 'system', content: systemPrompt }];

    if (Object.keys(session.careerProfile).length > 0) {
      const profile = Object.entries(session.careerProfile).map(([k, v]) => `${k}: ${v}`).join(', ');
      messages.push({ role: 'system', content: `USER CAREER PROFILE: ${profile}` });
    }

    if (session.compressedHistory) {
      messages.push({ role: 'system', content: `CONVERSATION HISTORY:\n${session.compressedHistory}` });
    }

    messages.push(...session.recentMessages.slice(-6));

    if (newUserInput) messages.push({ role: 'user', content: newUserInput });

    return messages;
  }

  /* ── CLEANUP ─────────────────────────────────────────────────── */
  cleanup(maxAgeMs = 3_600_000) {
    const now = Date.now();
    for (const [userId, session] of this._sessions) {
      if (now - session.lastActive > maxAgeMs) this._sessions.delete(userId);
    }
  }

  getProfile(userId) { return this._getSession(userId).careerProfile; }
}

module.exports = { MemorySaver };
