'use strict';
/* ═══════════════════════════════════════════════════════════════════
   GAP ANALYSER — builds a personalised interview plan by diffing
   the candidate's real CV against the real JD.
   Only references skills/requirements ACTUALLY present in the texts.
═══════════════════════════════════════════════════════════════════ */
const llm = require('../../engine/llm');

// Default inference call — preserved exactly as before for any standalone
// reuse of this file. cs_fixed/routes/interviewEngine.js overrides this
// with an adapter onto middleware/brain.js's infer() (internal CS-models
// -> CAMP -> Groq -> OpenRouter -> OpenAI -> Anthropic), since this file
// lives in the careercamp-ai submodule (also deployed as its own separate
// Render service) and must not hardcode a path back up into cs_fixed.
async function defaultInfer(prompt, system, opts) {
  return llm.infer(prompt, system, 'careerlm-base', opts);
}

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

async function buildInterviewPlan(cvText, jdText, role, inferFn = defaultInfer) {
  const prompt = `Build a targeted interview plan for the role of "${role}".

CV TEXT:
${cvText.slice(0, 3000)}

JOB DESCRIPTION:
${jdText.slice(0, 2000)}`;

  let result;
  try {
    result = await inferFn(prompt, SYSTEM_PROMPT, { temp: 0.4, maxTokens: 800 });
    const raw = result.text || '';
    // Strip reasoning-model <think> blocks before fence/JSON extraction --
    // brain.js's Groq pool includes reasoning models (groq/compound,
    // compound-mini) that emit these; left in, a <think> block containing
    // any '{' would make the greedy JSON regex below span from inside the
    // reasoning trace instead of the real answer, producing a parse failure
    // that looks like "the AI didn't return JSON" rather than what it is.
    const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const cleaned = noThink.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/g, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    // Confirmed live: when every inference engine is unavailable, infer()
    // returns a real 200-shaped result carrying the canned "Temporary
    // Service Interruption" text (engine:'offline'), not an error -- this
    // silently fell through to the generic fallback below with zero log
    // trace, indistinguishable from a genuine "AI wrote a good plan we
    // just couldn't parse" case. Logged explicitly so this is diagnosable
    // without having to reproduce it interactively.
    console.warn('[GAP-ANALYSER] No JSON in response (engine=' + (result.engine || 'unknown') + ') — falling back:', raw.slice(0, 150));
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
