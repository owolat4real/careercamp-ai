'use strict';
/* ══════════════════════════════════════════════════════════════
   QUALITATIVE SCORER — Layer 2 of the 3-layer hybrid.
   Uses cs-haiku (careerlm-fast) so it's fast and cheap.
   Returns { aiScore: 0-100, analysis: string, suggestions: [] }
══════════════════════════════════════════════════════════════ */
const llm = require('../../engine/llm');

const TOOL_LABELS = {
  linkedin:      'LinkedIn profile',
  cv:            'CV / résumé',
  cover_letter:  'cover letter',
};

/* ── SYSTEM PROMPT ─────────────────────────────────────────── */
const SYSTEM_PROMPT = `You are CareerStudioMax's expert career scoring engine.
Your job: score career documents honestly, briefly, and actionably.
ALWAYS return valid JSON — nothing else, no markdown fences, no commentary outside the object.

Output schema:
{
  "aiScore": <integer 0-100>,
  "summary": "<2-3 sentence overall quality assessment>",
  "strengths": ["<strength 1>", "<strength 2>"],
  "improvements": [
    { "priority": "high|medium|low", "action": "<specific 1-sentence fix>" }
  ],
  "rewriteSuggestion": "<optional: one rewritten sentence or bullet that shows how to improve the weakest part>"
}

Scoring bands: 90-100 = exceptional, 75-89 = strong, 60-74 = good with gaps, 40-59 = needs work, 0-39 = major overhaul needed.
Be direct. Avoid filler phrases. Give at least 2 improvements unless the score is 95+.`;

/* ── BUILD PROMPT FOR EACH TOOL TYPE ────────────────────────── */
function buildPrompt(toolName, text, ruleContext = {}) {
  const label = TOOL_LABELS[toolName] || toolName;
  const ruleHints = ruleContext.ruleScore !== undefined
    ? `\n\nRule-engine pre-score: ${ruleContext.ruleScore}/100. Flagged issues: ${
        (ruleContext.breakdown || [])
          .filter(r => !r.pass)
          .map(r => r.note)
          .join('; ') || 'none'
      }.`
    : '';

  const extras = buildExtras(toolName, ruleContext.context);

  return `Score this ${label}${ruleHints}${extras}

---
${text.slice(0, 4000)}
---

Return JSON only.`;
}

function buildExtras(toolName, ctx = {}) {
  const parts = [];
  if (toolName === 'linkedin' && ctx.targetRole) {
    parts.push(`\nTarget role the user is optimising for: "${ctx.targetRole}".`);
  }
  if (toolName === 'cover_letter') {
    if (ctx.companyName) parts.push(`\nCompany the letter is addressed to: "${ctx.companyName}".`);
    if (ctx.jobTitle)    parts.push(`\nRole applied for: "${ctx.jobTitle}".`);
  }
  if (toolName === 'cv' && ctx.targetRole) {
    parts.push(`\nTarget role: "${ctx.targetRole}".`);
  }
  return parts.join('');
}

/* ── MAIN ENTRY ──────────────────────────────────────────────── */
async function runQualitativeScorer(toolName, text, ruleResult = {}, context = {}) {
  const prompt = buildPrompt(toolName, text, { ...ruleResult, context });

  let raw;
  try {
    const result = await llm.infer(prompt, SYSTEM_PROMPT, 'careerlm-fast', { temp: 0.4, maxTokens: 800 });
    raw = result.text;
  } catch (err) {
    return {
      aiScore:        50,
      summary:        'AI analysis temporarily unavailable — rule-based score only.',
      strengths:      [],
      improvements:   [],
      rewriteSuggestion: null,
      error:          err.message,
    };
  }

  try {
    // Strip accidental markdown fences if model slips
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned);
    return {
      aiScore:           Math.min(100, Math.max(0, Number(parsed.aiScore) || 50)),
      summary:           parsed.summary           || '',
      strengths:         parsed.strengths         || [],
      improvements:      parsed.improvements      || [],
      rewriteSuggestion: parsed.rewriteSuggestion || null,
    };
  } catch (_) {
    return {
      aiScore:           50,
      summary:           raw.slice(0, 500),
      strengths:         [],
      improvements:      [],
      rewriteSuggestion: null,
    };
  }
}

module.exports = { runQualitativeScorer };
