'use strict';
/**
 * MEMORY-IN-SAVER — Persistent cross-session career memory in ~200 tokens.
 * No vector database. Structured JSON compression. File-backed per user.
 * Survives across conversations, features, and days.
 */
const fs   = require('fs');
const path = require('path');

const MEMORY_SCHEMA = {
  role:           '',
  target:         '',
  sector:         '',
  country:        '',
  experience:     0,
  salary_now:     '',
  salary_target:  '',
  skills:         [],
  tools:          [],
  goals:          [],
  gaps:           [],
  last_action:    '',
  applications:   0,
  interview_next: '',
  achievements:   [],
  preferences:    { tone: 'professional', language: 'en', detail: 'comprehensive' },
  session_count:  0,
  last_updated:   '',
};

class MemoryInSaver {
  constructor(storePath = path.join(__dirname, '../data/memory')) {
    this.storePath = storePath;
    this.cache     = new Map();
    if (!fs.existsSync(storePath)) fs.mkdirSync(storePath, { recursive: true });
  }

  async get(userId) {
    if (this.cache.has(userId)) return this.cache.get(userId);
    const file = path.join(this.storePath, `${String(userId).replace(/[^a-z0-9_\-]/gi, '_')}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const mem = JSON.parse(raw);
      this.cache.set(userId, mem);
      return mem;
    } catch {
      const fresh = { ...MEMORY_SCHEMA, userId, last_updated: new Date().toISOString() };
      this.cache.set(userId, fresh);
      return fresh;
    }
  }

  async update(userId, updates) {
    const current = await this.get(userId);
    const updated = {
      ...current,
      ...updates,
      session_count: (current.session_count || 0) + 1,
      last_updated:  new Date().toISOString(),
    };
    if (updated.skills?.length       > 8) updated.skills       = updated.skills.slice(-8);
    if (updated.goals?.length        > 3) updated.goals        = updated.goals.slice(-3);
    if (updated.achievements?.length > 3) updated.achievements = updated.achievements.slice(-3);
    if (updated.gaps?.length         > 5) updated.gaps         = updated.gaps.slice(-5);

    const file = path.join(this.storePath, `${String(userId).replace(/[^a-z0-9_\-]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(updated, null, 2));
    this.cache.set(userId, updated);
    return updated;
  }

  async extractAndSave(userId, messages, inferFn) {
    const conversationText = messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role}: ${m.content}`)
      .join('\n')
      .slice(-2000);

    try {
      const extracted = await inferFn({
        task:      'classify',
        userInput: `Extract career facts from this conversation. Return JSON only. Use null for unknown.

CONVERSATION:
${conversationText}

Return: {"role":"job title or null","target":"target role or null","sector":"industry or null","country":"location or null","experience":years_or_null,"skills":[],"goals":[],"last_action":"what happened or null"}`,
        maxTokens: 200,
      });

      const raw = (extracted?.content || '{}').replace(/```json|```/g, '').trim();
      const facts = JSON.parse(raw);
      const updates = {};
      for (const [k, v] of Object.entries(facts)) {
        if (v !== null && v !== undefined && v !== '') {
          if (Array.isArray(v) && v.length === 0) continue;
          updates[k] = v;
        }
      }
      if (Object.keys(updates).length > 0) await this.update(userId, updates);
    } catch {}
  }

  toContextBlock(memory) {
    if (!memory || !memory.role) return '';
    const parts = [
      memory.role          && `Role: ${memory.role}`,
      memory.target        && `Target: ${memory.target}`,
      memory.sector        && `Sector: ${memory.sector}`,
      memory.country       && `Location: ${memory.country}`,
      memory.experience    && `Experience: ${memory.experience} years`,
      memory.skills?.length && `Skills: ${memory.skills.slice(0, 5).join(', ')}`,
      memory.goals?.length  && `Goals: ${memory.goals.join(' · ')}`,
      memory.gaps?.length   && `Gaps: ${memory.gaps.join(', ')}`,
      memory.last_action    && `Last session: ${memory.last_action}`,
      memory.interview_next && `Next interview: ${memory.interview_next}`,
    ].filter(Boolean);
    return parts.length ? `\n\nUSER CAREER CONTEXT (from memory):\n${parts.join('\n')}\n` : '';
  }

  async clear(userId) {
    this.cache.delete(userId);
    const file = path.join(this.storePath, `${String(userId).replace(/[^a-z0-9_\-]/gi, '_')}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { cleared: true, userId };
  }
}

module.exports = { MemoryInSaver, MEMORY_SCHEMA };
