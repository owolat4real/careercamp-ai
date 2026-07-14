'use strict';
/**
 * ETHICAL GUARDRAILS — 7-point ethics filter on every input and output.
 * Career-domain specific. Prevents harmful, discriminatory, or dangerous advice.
 */

class EthicalGuardrails {

  /* ── INPUT CHECK ─────────────────────────────────────────────── */
  static checkInput(userInput, featureId) {
    const violations = [];
    const text = userInput || '';

    /* RULE 1 — Discrimination */
    const DISC = [
      /\b(hire|reject|filter|exclude)\s+(?:only\s+)?(?:men|women|male|female|christian|muslim|jewish|hindu|white|black|asian|old|young|disabled)\b/i,
      /\b(?:age|race|gender|religion|disability)\s+(?:filter|requirement|restriction)\b/i,
      /\bno\s+(?:women|men|foreigners|immigrants|disabled\s+people)\b/i,
    ];
    for (const re of DISC) {
      if (re.test(text)) {
        violations.push({
          rule: 'discrimination', severity: 'block',
          message: 'Career Studio does not support discriminatory hiring or filtering. This request cannot be processed.',
        });
        break;
      }
    }

    /* RULE 2 — Data harvesting */
    const HARVEST = [
      /extract\s+(?:all\s+)?(?:personal|private|confidential)\s+(?:data|information|details)\s+from\b/i,
      /\bscrape\s+(?:linkedin|glassdoor|indeed)\s+(?:profiles|emails|contacts)\b/i,
      /\bbulk\s+(?:collect|harvest|extract)\s+(?:candidate|employee)\s+data\b/i,
    ];
    for (const re of HARVEST) {
      if (re.test(text)) {
        violations.push({
          rule: 'data_harvesting', severity: 'block',
          message: 'Career Studio does not support bulk personal data collection.',
        });
        break;
      }
    }

    /* RULE 3 — Mental health crisis */
    const CRISIS = [
      /\b(want to die|kill myself|end it all|no reason to live|suicidal)\b/i,
      /\b(self harm|hurt myself|cutting)\b/i,
    ];
    for (const re of CRISIS) {
      if (re.test(text)) {
        violations.push({
          rule: 'mental_health_crisis', severity: 'redirect',
          message: 'It sounds like you may be going through a very difficult time. Please reach out to a mental health helpline in your country. In the UK: Samaritans 116 123. In Nigeria: SURPIN 0800-800-2000. Career Studio is here to support your career when you are ready.',
        });
        break;
      }
    }

    /* RULE 4 — Career fraud */
    const FRAUD = [
      /\b(forge|fake|falsify)\s+(?:(?:a|my|your|their|his|her)\s+)?(?:certificate|degree|qualification|reference|credential)\b/i,
      /\bcreate\s+(?:(?:a|my|your)\s+)?fake\s+(?:job|company|employer|experience)\b/i,
      /\bhow to\s+(?:lie|cheat|fake)\s+(?:(?:on|about)\s+)?(?:(?:a|my|your)\s+)?(?:cv|resume|application|qualification|degree)\b/i,
      /\bfake\s+(?:my|your|a)\s+(?:\w+\s+)?(?:certificate|degree|qualification|experience|reference)\b/i,
    ];
    for (const re of FRAUD) {
      if (re.test(text)) {
        violations.push({
          rule: 'career_fraud', severity: 'block',
          message: 'Career Studio does not help with creating false qualifications, fake experience, or fraudulent applications.',
        });
        break;
      }
    }

    /* RULE 5 — Workplace ethics */
    const WORKPLACE = [
      /\b(sexual harassment|inappropriate relationship)\s+(?:advice|tips|how to)\b/i,
      /\bhow to\s+(?:avoid|hide|cover up)\s+(?:harassment|discrimination|misconduct)\b/i,
    ];
    for (const re of WORKPLACE) {
      if (re.test(text)) {
        violations.push({
          rule: 'workplace_ethics', severity: 'block',
          message: 'Career Studio promotes ethical and respectful workplace practices only.',
        });
        break;
      }
    }

    /* RULE 6 — Unsafe financial advice */
    const FINANCE = [
      /\b(?:quit|resign|leave)\s+(?:your|my)\s+job\s+(?:and|to)\s+(?:invest|trade|bet)\b/i,
      /\b(?:take out|borrow|loan)\s+(?:money|funds)\s+to\s+(?:invest|trade|start)\b/i,
    ];
    for (const re of FINANCE) {
      if (re.test(text)) {
        violations.push({
          rule: 'unsafe_finance', severity: 'warn',
          message: 'Career Studio is not a financial advisor. For financial decisions, please consult a qualified financial adviser.',
        });
        break;
      }
    }

    /* RULE 7 — Impersonation */
    const IMPERSONATE = [
      /\bpretend to be\s+(?:from|at|a\s+recruiter)\s+/i,
      /\bwrite (?:a\s+)?(?:message|email)\s+as\s+(?:if\s+)?(?:i am|i'm|from)\s+\w+\b/i,
    ];
    for (const re of IMPERSONATE) {
      if (re.test(text)) {
        violations.push({
          rule: 'impersonation', severity: 'block',
          message: 'Career Studio does not support impersonating others in professional communications.',
        });
        break;
      }
    }

    return {
      passed:    violations.filter(v => v.severity === 'block').length === 0,
      violations,
      blocked:   violations.filter(v => v.severity === 'block'),
      warnings:  violations.filter(v => v.severity === 'warn'),
      redirects: violations.filter(v => v.severity === 'redirect'),
    };
  }

  /* ── OUTPUT CHECK ────────────────────────────────────────────── */
  static checkOutput(output, task) {
    const violations = [];
    let text = output || '';

    /* Soften overconfident claims */
    if (/\b(you will earn|guaranteed salary|definitely get|you will definitely)\b/i.test(text)) {
      text = text
        .replace(/\byou will earn\b/gi,    'you could expect to earn')
        .replace(/\bguaranteed\b/gi,       'likely')
        .replace(/\bdefinitely get\b/gi,   'may get')
        .replace(/\byou will definitely\b/gi, 'you may');
      violations.push({ rule: 'overconfident_claim', severity: 'softened' });
    }

    /* Block discriminatory output */
    if (/\b(avoid|prefer|filter)\s+(?:candidates|applicants)\s+who are\s+(young|old|female|male)\b/i.test(text)) {
      violations.push({ rule: 'discriminatory_output', severity: 'block' });
    }

    return {
      passed:     violations.filter(v => v.severity === 'block').length === 0,
      output:     text,
      violations,
    };
  }
}

module.exports = { EthicalGuardrails };
