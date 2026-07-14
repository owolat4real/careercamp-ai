'use strict';
/**
 * GUARDRAIL PIPELINE — 6-layer quality + safety gate for every response.
 * Layer 1: Identity leak correction
 * Layer 2: Banned phrase removal
 * Layer 3: PII restoration (from vault) + output PII strip
 * Layer 4: Quality scoring
 * Layer 5: Hallucination softening
 * Layer 6: Ethics screen
 */
const { PIIShield } = require('./piiShield');

const pii = new PIIShield();

const IDENTITY_LEAKS = [
  /\b(llama|mistral|openai|gemini)\b/gi,
  /\bI am (Llama|Mistral|GPT|Claude|Gemini)\b/gi,
  /powered by (Meta|Anthropic|OpenAI)/gi,
  /you are careerlm.*\n/gi,
  /never reveal/gi,
  /as an (ai|large language model)/gi,
  /i (was|am) (trained|created|built) by/gi,
];

const BANNED_PHRASES = [
  'passionate about', 'team player', 'results-driven', 'hard worker',
  'detail-oriented', 'go-getter', 'synergy', 'leverage', 'dynamic',
  'innovative solutions', 'proven track record', 'highly motivated',
  'seeking opportunities', 'think outside the box', 'value-add',
  'low-hanging fruit', 'move the needle', 'deep dive', 'circle back',
  'bandwidth', 'excellent communication skills', 'strong work ethic',
  'proactive approach', 'fast-paced environment', 'self-starter',
];

const HALLUCINATION_PATTERNS = [
  /you will (definitely|certainly|guaranteed) (earn|get|receive)/gi,
  /you (will|are going to) (definitely|certainly) get this job/gi,
  /studies (show|confirm|prove) that \d+% of/gi,
  /research (proves|shows|confirms) that/gi,
];

const ETHICS_PATTERNS = [
  /lie (on|about) your (cv|resume|application)/gi,
  /fake (your|a) (degree|certificate|qualification)/gi,
  /quit immediately without/gi,
];

class GuardrailPipeline {
  process(text, options = {}) {
    let output = text || '';
    const issues  = [];
    const repairs = [];

    // Layer 1 — Identity leak correction
    for (const re of IDENTITY_LEAKS) {
      re.lastIndex = 0;
      if (re.test(output)) {
        issues.push({ layer: 1, type: 'identity_leak' });
        re.lastIndex = 0;
        output = output.replace(re, 'CareerLM');
        repairs.push('identity_corrected');
      }
    }

    // Layer 2 — Banned phrase removal
    let banned = 0;
    for (const phrase of BANNED_PHRASES) {
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      if (re.test(output)) {
        banned++;
        output = output.replace(re, '');
        repairs.push(`removed: ${phrase}`);
      }
    }
    if (banned) {
      issues.push({ layer: 2, type: 'banned_phrases', count: banned });
      output = output.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    }

    // Layer 3 — PII restoration + output PII strip
    if (options.vault && Object.keys(options.vault).length) {
      output = pii.restore(output, options.vault);
      repairs.push('pii_restored');
    }
    const { clean: extraClean, piiFound } = pii.strip(output, { keepSalary: options.keepSalary });
    if (piiFound) {
      output = extraClean;
      issues.push({ layer: 3, type: 'output_pii_stripped' });
    }

    // Layer 4 — Quality score
    const wordCount = output.trim().split(/\s+/).length;
    let qualityScore = 100;
    if (wordCount < 10)                        { qualityScore -= 40; issues.push({ layer: 4, type: 'too_short' }); }
    if (wordCount < 30 && options.expectLong)  { qualityScore -= 20; }
    if (banned > 3)                            { qualityScore -= 15; }

    // Layer 5 — Hallucination softening
    for (const re of HALLUCINATION_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(output)) {
        issues.push({ layer: 5, type: 'hallucination_risk' });
        re.lastIndex = 0;
        output = output.replace(re, m => m.replace(/(definitely|certainly|guaranteed|always)/gi, 'typically'));
        repairs.push('hallucination_softened');
      }
    }

    // Layer 6 — Ethics screen
    for (const re of ETHICS_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(output)) {
        issues.push({ layer: 6, type: 'ethics_concern', severity: 'HIGH' });
        qualityScore -= 50;
      }
    }

    return {
      content:      output,
      qualityScore: Math.max(0, Math.min(100, qualityScore)),
      issues,
      repairs,
      passed: qualityScore >= 60 && !issues.some(i => i.layer === 6),
    };
  }
}

module.exports = { GuardrailPipeline };
