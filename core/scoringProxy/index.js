'use strict';
/* ══════════════════════════════════════════════════════════════
   SCORING PROXY — 3-layer hybrid scoring engine
   Layer 1: deterministic rule engine  (40% weight)
   Layer 2: cs-haiku qualitative AI    (60% weight)
   Layer 3: weighted merge + full breakdown

   Supported tools: linkedin, cv, cover_letter
══════════════════════════════════════════════════════════════ */
const { runRuleEngine }       = require('./ruleEngine');
const { runQualitativeScorer } = require('./qualitativeScorer');

const RULE_WEIGHT = 0.40;
const AI_WEIGHT   = 0.60;

const SCORE_BANDS = [
  { min: 90, grade: 'A+', label: 'Exceptional' },
  { min: 80, grade: 'A',  label: 'Strong' },
  { min: 70, grade: 'B+', label: 'Good' },
  { min: 60, grade: 'B',  label: 'Decent — some gaps' },
  { min: 50, grade: 'C',  label: 'Needs work' },
  { min:  0, grade: 'D',  label: 'Major overhaul needed' },
];

function getGrade(score) {
  return SCORE_BANDS.find(b => score >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];
}

/* ── MAIN ENTRY ──────────────────────────────────────────────── */
/**
 * @param {string} toolName   - 'linkedin' | 'cv' | 'cover_letter'
 * @param {string} text       - raw user input
 * @param {object} [context]  - optional hints: { targetRole, companyName, jobTitle }
 * @returns {Promise<ScoringResult>}
 */
async function scoreWithProxy(toolName, text, context = {}) {
  if (!text || typeof text !== 'string' || text.trim().length < 30) {
    return {
      finalScore:  0,
      grade:       'D',
      gradeLabel:  'Too short to score',
      ruleScore:   0,
      aiScore:     0,
      summary:     'Input too short — please provide the full document.',
      strengths:   [],
      improvements: [{ priority: 'high', action: 'Provide the complete document to get a meaningful score.' }],
      ruleBreakdown: [],
      rewriteSuggestion: null,
      error:       'input_too_short',
    };
  }

  /* Layer 1 — deterministic rules */
  const ruleResult = runRuleEngine(toolName, text, context);

  /* Layer 2 — qualitative AI judgment (informed by rule results) */
  const aiResult = await runQualitativeScorer(toolName, text, ruleResult, context);

  /* Layer 3 — weighted merge */
  const finalScore = Math.round(
    ruleResult.ruleScore * RULE_WEIGHT +
    aiResult.aiScore     * AI_WEIGHT
  );

  const band = getGrade(finalScore);

  return {
    finalScore,
    grade:             band.grade,
    gradeLabel:        band.label,
    ruleScore:         ruleResult.ruleScore,
    aiScore:           aiResult.aiScore,
    summary:           aiResult.summary,
    strengths:         aiResult.strengths,
    improvements:      aiResult.improvements,
    ruleBreakdown:     ruleResult.breakdown,
    passedChecks:      ruleResult.passedChecks,
    totalChecks:       ruleResult.totalChecks,
    rewriteSuggestion: aiResult.rewriteSuggestion || null,
  };
}

module.exports = { scoreWithProxy };
