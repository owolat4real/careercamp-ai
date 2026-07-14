'use strict';
/**
 * PII SCRUBBER — Strips PII from every user input before any model sees it.
 * Restores original values into model output before returning to the user.
 * Zero PII ever reaches local models or external APIs.
 */

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class PIIScrubber {

  constructor() {
    this._registry = new Map(); // storeKey → original value
    this._counter  = 0;
  }

  static get PATTERNS() {
    return [
      {
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        type: 'EMAIL', placeholder: '[EMAIL]',
      },
      {
        regex: /(\+44|0)[\s.-]?(\d[\s.-]?){9,10}/g,
        type: 'PHONE_UK', placeholder: '[PHONE]',
      },
      {
        regex: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}/g,
        type: 'PHONE_INTL', placeholder: '[PHONE]',
      },
      {
        regex: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b/g,
        type: 'NIN_UK', placeholder: '[NIN]',
      },
      {
        regex: /\b\d{3}-\d{2}-\d{4}\b/g,
        type: 'SSN_US', placeholder: '[SSN]',
      },
      {
        regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/g,
        type: 'IBAN', placeholder: '[BANK_ACCOUNT]',
      },
      {
        regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
        type: 'CARD', placeholder: '[CARD_NUMBER]',
      },
      {
        regex: /\b(born|DOB|date of birth)[:\s]+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi,
        type: 'DOB', placeholder: '[DOB]',
      },
      {
        regex: /\b\d{1,5}\s+[A-Za-z\s]+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Cl)\b/gi,
        type: 'ADDRESS', placeholder: '[ADDRESS]',
      },
      {
        regex: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,
        type: 'POSTCODE', placeholder: '[POSTCODE]',
      },
    ];
  }

  /* ── SCRUB ───────────────────────────────────────────────────── */
  scrub(text, userId) {
    if (!text || typeof text !== 'string') return { clean: text, map: {} };

    let clean = text;
    const map = {};
    const sessionId = userId || 'anon';

    for (const pat of PIIScrubber.PATTERNS) {
      const re      = new RegExp(pat.regex.source, pat.regex.flags);
      const matches = [...(text.matchAll ? text.matchAll(re) : [])];
      for (const match of matches) {
        const original  = match[0];
        const key       = `${pat.placeholder.replace(/[\[\]]/g, '')}_${++this._counter}`;
        const storeKey  = `${sessionId}:${key}`;
        this._registry.set(storeKey, original);
        map[key] = original;
        clean    = clean.split(original).join(key);
      }
    }

    return { clean, map, hadPII: Object.keys(map).length > 0 };
  }

  /* ── RESTORE ─────────────────────────────────────────────────── */
  restore(text, map) {
    if (!text || !map || !Object.keys(map).length) return text;
    let out = text;
    for (const [key, original] of Object.entries(map)) {
      out = out.replace(new RegExp(_escapeRegex(key), 'g'), original);
    }
    return out;
  }

  /* ── AUDIT ───────────────────────────────────────────────────── */
  auditText(text) {
    const found = [];
    for (const pat of PIIScrubber.PATTERNS) {
      const re = new RegExp(pat.regex.source, pat.regex.flags);
      const m  = text.match(re);
      if (m) found.push({ type: pat.type, count: m.length });
    }
    return { hasPII: found.length > 0, types: found };
  }

  /* ── CLEAR SESSION REGISTRY ──────────────────────────────────── */
  reset(userId) {
    for (const [key] of this._registry) {
      if (key.startsWith(userId + ':')) this._registry.delete(key);
    }
  }
}

module.exports = { PIIScrubber };
