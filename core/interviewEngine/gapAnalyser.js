'use strict';
/* ═══════════════════════════════════════════════════════════════════
   GAP ANALYSER — builds a personalised interview plan by diffing
   the candidate's real CV against the real JD.
   Only references skills/requirements ACTUALLY present in the texts.
═══════════════════════════════════════════════════════════════════ */
const llm = require('../../engine/llm');

const SYSTEM_PROMPT = `You are CareerLM's interview planning engine.
Your job: analyse a CV against a job description and produce a grounded, targeted interview plan.

ABSOLUTE RULES:
- Only reference skills or experience ACTUALLY present in the CV text
- Only reference requirements ACTUALLY present in the JD text
- Never invent a gap or strength that is not evidenced in the texts given
- Identify 3-5 topics per competency section
- Each topic should be specific (e.g. "Python async programming" not just "Python")

Output ONLY valid JSON — no markdown fences, no commentary:
{
  "technicalTopics":   ["specific technical skill or tool to probe based on CV/JD overlap"],
  "behaviouralTopics": ["specific behavioural competency from the JD requirements"],
  "softSkillTopics":   ["specific soft skill evidenced or required by JD"],
  "cvGaps":            ["specific requirement in the JD not clearly evidenced in the CV"],
  "cvStrengths":       ["specific genuine strength from the CV that matches a JD requirement"]
}`;

async function buildInterviewPlan(cvText, jdText, role) {
  const prompt = `Build a targeted interview plan for the role of "${role}".

CV TEXT:
${cvText.slice(0, 3000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}`;

  let result;
  try {
    result = await llm.infer(prompt, SYSTEM_PROMPT, 'careerlm-base', { temp: 0.4, maxTokens: 800 });
    const raw     = result.text || '';
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/g, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (err) {
    console.error('[GAP-ANALYSER] Plan build error:', err.message);
  }

  /* Safe fallback — never crash the interview start */
  return {
    technicalTopics:   [`Core technical skills required for ${role}`],
    behaviouralTopics: ['Teamwork and collaboration', 'Handling pressure and deadlines'],
    softSkillTopics:   ['Communication style and clarity'],
    cvGaps:            ['Specific gaps could not be determined — will ask targeted questions'],
    cvStrengths:       ['Specific strengths could not be determined — will explore background'],
  };
}

module.exports = { buildInterviewPlan };
