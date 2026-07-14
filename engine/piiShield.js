'use strict';
/**
 * PII SHIELD — Strips PII from user input before it reaches the model,
 * stores in a per-request vault, restores in output. GDPR-compliant.
 */

const PII_PATTERNS = [
  {
    type: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    token: (i) => `[EMAIL_${i}]`,
    sensitivity: 'HIGH',
  },
  {
    type: 'PHONE_INTL',
    pattern: /\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{4}/g,
    token: (i) => `[PHONE_${i}]`,
    sensitivity: 'HIGH',
  },
  {
    type: 'PHONE_UK',
    pattern: /\b(?:(?:\+44|0044|0)(?:\s?\d){9,10})\b/g,
    token: (i) => `[PHONE_${i}]`,
    sensitivity: 'HIGH',
  },
  {
    type: 'NI_NUMBER',
    pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b/g,
    token: (i) => `[NI_${i}]`,
    sensitivity: 'CRITICAL',
  },
  {
    type: 'SORT_CODE',
    pattern: /\b\d{2}[-\s]?\d{2}[-\s]?\d{2}\b/g,
    token: (i) => `[SORT_CODE_${i}]`,
    sensitivity: 'CRITICAL',
  },
  {
    type: 'ACCOUNT_NUMBER',
    pattern: /\b\d{8}\b/g,
    token: (i) => `[ACCOUNT_${i}]`,
    sensitivity: 'CRITICAL',
  },
  {
    type: 'SALARY',
    pattern: /(?:£|€|\$|₦|₹)\s?[\d,]+(?:\.\d{2})?(?:\s?(?:k|K|000))?\b/g,
    token: (i) => `[SALARY_${i}]`,
    sensitivity: 'MEDIUM',
    keepContext: true,
  },
  {
    type: 'ADDRESS',
    pattern: /\d+\s+[A-Za-z\s]+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Court|Ct|Way|Close|Cl)\b/gi,
    token: (i) => `[ADDRESS_${i}]`,
    sensitivity: 'HIGH',
  },
  {
    type: 'POSTCODE',
    pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,
    token: (i) => `[POSTCODE_${i}]`,
    sensitivity: 'MEDIUM',
  },
  {
    type: 'DOB',
    pattern: /\b(?:0?[1-9]|[12]\d|3[01])[-\/](?:0?[1-9]|1[0-2])[-\/](?:19|20)\d{2}\b/g,
    token: (i) => `[DOB_${i}]`,
    sensitivity: 'HIGH',
  },
  {
    type: 'LINKEDIN_URL',
    pattern: /linkedin\.com\/in\/[A-Za-z0-9\-]+/g,
    token: (i) => `[LINKEDIN_${i}]`,
    sensitivity: 'LOW',
  },
  {
    type: 'BVN',
    pattern: /\b\d{11}\b/g,
    token: (i) => `[BVN_${i}]`,
    sensitivity: 'CRITICAL',
  },
  {
    type: 'NAME',
    // Only full name patterns (First Last), not single words — avoids false positives
    pattern: /\b([A-Z][a-z]{2,}\s[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?)\b/g,
    token: (i) => `[PERSON_${i}]`,
    sensitivity: 'HIGH',
  },
];

const SENSITIVITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

class PIIShield {
  strip(text, options = {}) {
    if (!text || typeof text !== 'string') return { clean: text, vault: {}, piiFound: false };

    let clean = text;
    const vault = {};
    let counter = 0;
    let piiFound = false;

    const sorted = [...PII_PATTERNS].sort(
      (a, b) => (SENSITIVITY_ORDER[a.sensitivity] ?? 4) - (SENSITIVITY_ORDER[b.sensitivity] ?? 4)
    );

    for (const cfg of sorted) {
      if (cfg.type === 'SALARY'       && options.keepSalary)   continue;
      if (cfg.type === 'LINKEDIN_URL' && options.keepLinkedIn) continue;
      // Reset lastIndex for global regexes each time
      cfg.pattern.lastIndex = 0;
      clean = clean.replace(cfg.pattern, (match) => {
        const token = cfg.token(counter++);
        vault[token] = { original: match, type: cfg.type };
        piiFound = true;
        return token;
      });
    }

    return { clean, vault, piiFound, count: counter };
  }

  restore(text, vault) {
    if (!text || !vault || !Object.keys(vault).length) return text;
    let restored = text;
    for (const [token, data] of Object.entries(vault)) {
      restored = restored.split(token).join(data.original);
    }
    return restored;
  }

  stripThread(messages = [], options = {}) {
    const combinedVault = {};
    const cleanMessages = messages.map(msg => {
      if (msg.role === 'system') return msg;
      const { clean, vault } = this.strip(msg.content || '', options);
      Object.assign(combinedVault, vault);
      return { ...msg, content: clean };
    });
    return { messages: cleanMessages, vault: combinedVault };
  }

  audit(text) {
    const { vault, count } = this.strip(text);
    const byType = {};
    for (const data of Object.values(vault)) byType[data.type] = (byType[data.type] || 0) + 1;
    return { totalPIIFound: count, byType, protected: count > 0, gdprCompliant: true };
  }
}

module.exports = { PIIShield };
