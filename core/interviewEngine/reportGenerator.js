'use strict';
/* ═══════════════════════════════════════════════════════════════════
   REPORT GENERATOR — final structured interview report.
   Everything in the report must be grounded in the actual Q&A
   transcript — no generic interview advice.
═══════════════════════════════════════════════════════════════════ */
const llm = require('../../engine/llm');

function avg(arr) {
  return arr.length ? Math.round(arr.reduce((s, qa) => s + (qa.score || 0), 0) / arr.length) : 0;
}

async function generateFinalReport(session) {
  const { qaHistory, interviewPlan, role, company } = session;

  const technical   = qaHistory.filter(qa => qa.competency === 'technical');
  const behavioural = qaHistory.filter(qa => qa.competency === 'behavioural');
  const softSkill   = qaHistory.filter(qa => qa.competency === 'soft_skill');

  const technicalScore   = avg(technical);
  const behaviouralScore = avg(behavioural);
  const softSkillScore   = avg(softSkill);
  const overallScore     = Math.round((technicalScore + behaviouralScore + softSkillScore) / 3);

  const transcript = qaHistory.map(qa =>
    `[${qa.competency.toUpperCase()}] Topic: ${qa.topic}\n` +
    `Q: ${qa.question}\n` +
    `A: ${(qa.answer || '').slice(0, 500)}\n` +
    `Score: ${qa.score}/100 — ${qa.feedback}`
  ).join('\n\n');

  const systemPrompt = `You are CareerLM generating a final interview performance report.
Base this ENTIRELY on the real Q&A transcript — never add generic interview advice.

ROLE: ${role}${company ? ` at ${company}` : ''}
SCORES: Technical ${technicalScore}/100 | Behavioural ${behaviouralScore}/100 | Soft Skill ${softSkillScore}/100 | Overall ${overallScore}/100

PRE-INTERVIEW ANALYSIS:
CV Gaps: ${(interviewPlan.cvGaps || []).join('; ')}
CV Strengths: ${(interviewPlan.cvStrengths || []).join('; ')}

FULL TRANSCRIPT:
${transcript}

RULES:
- Strengths must reference a specific strong answer from THIS transcript
- Improvement areas must reference a specific weak answer from THIS transcript
- Hire recommendation must be honest — a 60/100 overall is not a strong hire
- No generic phrases like "show enthusiasm" or "practice STAR method" unless grounded in a specific failure in this session

Output ONLY valid JSON:
{
  "strengths":           ["specific strength shown in THIS interview — reference the topic/answer"],
  "improvementAreas":    ["specific area from a weak answer in THIS session — what was missing"],
  "hireRecommendation":  "one honest paragraph: overall impression, hire/no-hire signal, top 1-2 things to address"
}`;

  let parsed;
  try {
    const result = await llm.infer('Generate the final interview report.', systemPrompt, 'careerlm-base', { temp: 0.5, maxTokens: 600 });
    const raw    = result.text || '';
    const match  = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/g, '').trim().match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  } catch (err) {
    console.error('[REPORT-GENERATOR] error:', err.message);
  }

  return {
    overallScore,
    technicalScore,
    behaviouralScore,
    softSkillScore,
    strengths:          parsed?.strengths          || ['Report generation incomplete — see individual scores above.'],
    improvementAreas:   parsed?.improvementAreas   || ['Review individual question scores and feedback for specifics.'],
    hireRecommendation: parsed?.hireRecommendation || `Overall score: ${overallScore}/100. Review the transcript for specifics.`,
  };
}

module.exports = { generateFinalReport };
