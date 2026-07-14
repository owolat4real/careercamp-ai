'use strict';
/* ══════════════════════════════════════════════════════════════
   RULE SETS — deterministic, <5ms, $0 per call.
   Each check returns { pass, points, note }.
   maxRulePoints = sum of all points when everything passes — used
   to normalise the raw tally to a 0-100 rule score.
══════════════════════════════════════════════════════════════ */

/* ── HELPER: naive section extraction (works on pasted text) */
function extractSection(text, sectionName) {
  const patterns = {
    headline: /^(.{10,220})(?:\n|$)/,
    about:    /about\s*[:.\n]([\s\S]{0,2000}?)(?=\n\n|\bexperience\b|$)/i,
  };
  const match = text.match(patterns[sectionName]);
  return match ? match[1].trim() : null;
}

const RULE_SETS = {

  /* ─────────────────────────────────────────────────────────
     LINKEDIN — 8 checks, 100 max rule points
  ───────────────────────────────────────────────────────── */
  linkedin: {
    checks: [
      {
        id: 'headline_length',
        test: (text) => {
          const headline = extractSection(text, 'headline');
          if (!headline) return { pass: false, points: 0, note: 'No headline found' };
          const len = headline.length;
          if (len > 220) return { pass: false, points: 5,  note: `Headline too long (${len}/220 chars)` };
          if (len < 30)  return { pass: false, points: 5,  note: 'Headline too short — add more keywords' };
          return          { pass: true,  points: 15, note: `Headline length good (${len}/220 chars)` };
        },
      },
      {
        id: 'about_section_present',
        test: (text) => {
          const about = extractSection(text, 'about');
          if (!about)            return { pass: false, points: 0, note: 'No About section found' };
          if (about.length < 200) return { pass: false, points: 8, note: 'About section too short (aim for 300+ chars)' };
          return                  { pass: true,  points: 15, note: 'About section present and substantial' };
        },
      },
      {
        id: 'experience_count',
        test: (text) => {
          const expCount = (text.match(/\b(19|20)\d{2}\b\s*[-–—]\s*(present|current|\b(19|20)\d{2}\b)/gi) || []).length;
          if (expCount === 0) return { pass: false, points: 0, note: 'No dated experience entries detected' };
          if (expCount < 2)   return { pass: false, points: 8, note: 'Only 1 experience entry — add more history' };
          return              { pass: true,  points: 15, note: `${expCount} experience entries found` };
        },
      },
      {
        id: 'quantified_achievements',
        test: (text) => {
          const matches = (text.match(/\d+%|\$\d+|\d+x|\d+\+|\d{2,}/g) || []).length;
          if (matches === 0) return { pass: false, points: 0, note: 'No quantified achievements — add numbers/metrics' };
          if (matches < 3)   return { pass: false, points: 8, note: `Only ${matches} quantified result(s) — add more` };
          return             { pass: true,  points: 15, note: `${matches} quantified achievements found` };
        },
      },
      {
        id: 'keyword_density',
        test: (text, context = {}) => {
          const targetRole = (context.targetRole || '').toLowerCase();
          if (!targetRole) return { pass: true, points: 10, note: 'No target role given — skipping keyword check' };
          const words = targetRole.split(/\s+/).filter(w => w.length > 2);
          const found = words.filter(w => text.toLowerCase().includes(w));
          const ratio = found.length / (words.length || 1);
          if (ratio < 0.3) return { pass: false, points: 3, note: `Low keyword match for "${targetRole}" (${found.length}/${words.length})` };
          return           { pass: true,  points: 10, note: `Good keyword match for "${targetRole}"` };
        },
      },
      {
        id: 'skills_section',
        test: (text) => {
          const hasSkills = /skills?:/i.test(text) || /\bskills?\b.*(\n|,).*\w+/i.test(text);
          return hasSkills
            ? { pass: true,  points: 10, note: 'Skills section detected' }
            : { pass: false, points: 0,  note: 'No clear skills listing found' };
        },
      },
      {
        id: 'call_to_action',
        test: (text) => {
          const hasCTA = /\b(connect|reach out|open to|contact me|let'?s talk)\b/i.test(text);
          return hasCTA
            ? { pass: true,  points: 10, note: 'Has a call to action for recruiters/connections' }
            : { pass: false, points: 3,  note: 'No call to action — add one to About section' };
        },
      },
      {
        id: 'buzzword_overuse',
        test: (text) => {
          const buzzwords = ['synergy', 'thought leader', 'ninja', 'rockstar', 'guru', 'go-getter', 'results-driven'];
          const found = buzzwords.filter(b => text.toLowerCase().includes(b));
          return found.length === 0
            ? { pass: true,  points: 10, note: 'No overused buzzwords detected' }
            : { pass: false, points: 3,  note: `Overused buzzwords found: ${found.join(', ')}` };
        },
      },
    ],
    maxRulePoints: 100,
  },

  /* ─────────────────────────────────────────────────────────
     CV — 5 checks, 100 max rule points
  ───────────────────────────────────────────────────────── */
  cv: {
    checks: [
      {
        id: 'length_check',
        test: (text) => {
          const words = text.trim().split(/\s+/).length;
          if (words < 200)  return { pass: false, points: 5,  note: 'CV too short — likely missing detail' };
          if (words > 1200) return { pass: false, points: 8,  note: 'CV likely over 2 pages — consider trimming' };
          return            { pass: true,  points: 20, note: 'CV length is appropriate' };
        },
      },
      {
        id: 'quantified_bullets',
        test: (text) => {
          const bullets     = text.split('\n').filter(l => /^[\-\*•]/.test(l.trim()));
          const quantified  = bullets.filter(b => /\d+%|\$\d+|\d+x|\d+\+/.test(b));
          const ratio       = bullets.length ? quantified.length / bullets.length : 0;
          if (ratio < 0.3) return { pass: false, points: 8, note: `Only ${quantified.length}/${bullets.length} bullets are quantified` };
          return           { pass: true,  points: 25, note: `${quantified.length}/${bullets.length} bullets are quantified` };
        },
      },
      {
        id: 'contact_info',
        test: (text) => {
          const hasEmail = /[\w.-]+@[\w.-]+\.\w+/.test(text);
          const hasPhone = /\+?\d[\d\s\-()]{7,}/.test(text);
          const score    = (hasEmail ? 15 : 0) + (hasPhone ? 10 : 0);
          return { pass: score > 0, points: score, note: `Email: ${hasEmail ? '✓' : '✗'}, Phone: ${hasPhone ? '✓' : '✗'}` };
        },
      },
      {
        id: 'action_verbs',
        test: (text) => {
          const weakVerbs = ['responsible for', 'worked on', 'helped with', 'was involved in'];
          const found     = weakVerbs.filter(v => text.toLowerCase().includes(v));
          return found.length === 0
            ? { pass: true,  points: 20, note: 'No weak passive phrases found' }
            : { pass: false, points: 5,  note: `Weak phrases: ${found.join(', ')}` };
        },
      },
      {
        id: 'skills_section_present',
        test: (text) => /skills?:?\s*\n/i.test(text)
          ? { pass: true,  points: 20, note: 'Skills section present' }
          : { pass: false, points: 0,  note: 'No dedicated skills section found' },
      },
    ],
    maxRulePoints: 100,
  },

  /* ─────────────────────────────────────────────────────────
     COVER LETTER — 4 checks, 100 max rule points
  ───────────────────────────────────────────────────────── */
  cover_letter: {
    checks: [
      {
        id: 'word_count',
        test: (text) => {
          const words = text.trim().split(/\s+/).length;
          if (words < 150) return { pass: false, points: 8,  note: 'Too short — aim for 250-400 words' };
          if (words > 500) return { pass: false, points: 10, note: 'Too long — tighten to under 400 words' };
          return           { pass: true,  points: 25, note: 'Good length' };
        },
      },
      {
        id: 'company_name_mentioned',
        test: (text, context = {}) => {
          const company = (context.companyName || '').toLowerCase();
          if (!company) return { pass: true, points: 15, note: 'No company name given to check against' };
          return text.toLowerCase().includes(company)
            ? { pass: true,  points: 25, note: 'Company name mentioned' }
            : { pass: false, points: 0,  note: 'Company name not found — personalise this letter' };
        },
      },
      {
        id: 'generic_opener_check',
        test: (text) => {
          const generic = /to whom it may concern|dear hiring manager,?\s*$/i.test(text.slice(0, 100));
          return generic
            ? { pass: false, points: 5,  note: 'Generic opener detected — personalise if possible' }
            : { pass: true,  points: 25, note: 'Opener is not generic' };
        },
      },
      {
        id: 'closing_cta',
        test: (text) => {
          const hasCTA = /\b(look forward|available|happy to discuss|schedule|interview)\b/i.test(text.slice(-300));
          return hasCTA
            ? { pass: true,  points: 25, note: 'Strong closing call-to-action' }
            : { pass: false, points: 8,  note: 'Weak or missing closing call-to-action' };
        },
      },
    ],
    maxRulePoints: 100,
  },
};

/* ── RUN ALL RULES FOR A TOOL ────────────────────────────────── */
function runRuleEngine(toolName, text, context = {}) {
  const ruleSet = RULE_SETS[toolName];
  if (!ruleSet) throw new Error(`No rule set defined for "${toolName}"`);

  const results = ruleSet.checks.map(check => ({
    id: check.id,
    ...check.test(text, context),
  }));

  const totalPoints = results.reduce((sum, r) => sum + r.points, 0);
  const ruleScore   = Math.min(100, Math.round((totalPoints / ruleSet.maxRulePoints) * 100));

  return {
    ruleScore,
    breakdown:    results,
    passedChecks: results.filter(r => r.pass).length,
    totalChecks:  results.length,
  };
}

module.exports = { runRuleEngine, RULE_SETS };
