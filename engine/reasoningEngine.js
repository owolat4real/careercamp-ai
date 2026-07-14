'use strict';
/**
 * REASONING ENGINE — Forces cs-sonnet to reason like a human career expert.
 * Chain-of-thought injection, ambiguity detection, and self-critique loops.
 */

const REASONING_TASKS = [
  'career_advice', 'reasoning', 'salary_analysis',
  'gap_analysis', 'interview_prep', 'job_match',
];

function requiresReasoning(task) {
  return REASONING_TASKS.includes(task);
}

/* ── CHAIN OF THOUGHT PREFIXES ──────────────────────────────────── */
const COT_PREFIXES = {
  career_advice: `Before answering, think through:
1. What is the user actually asking? (not surface question, real need)
2. What do I know about their specific career context?
3. What market data is relevant to this situation?
4. What would a senior career director with 20 years experience say?
5. What is the ONE most important thing they need to hear?

Now provide your answer:`,

  salary_analysis: `Before calculating, consider:
1. What role and market are we discussing?
2. What verified salary data do I have for this combination?
3. What factors shift salary up or down in this specific case?
4. What is their negotiation leverage right now?
5. What is the honest range and the honest target?

Now provide your salary analysis:`,

  reasoning: `Think through this carefully:
1. What is the core question or decision here?
2. What are the competing options or paths?
3. What data or evidence supports each?
4. What would a rational career expert recommend?
5. What am I uncertain about that the user should verify?

Now provide your reasoning:`,

  interview_prep: `Prepare strategically:
1. What type of interview is this and what format does it use?
2. What are the three most likely themes given the role and company?
3. What achievements from their background best address these?
4. What is the one weakness or gap they need to address proactively?
5. What specific questions should they prepare for?

Now provide your interview preparation:`,

  job_match: `Assess this match honestly:
1. What are the hard requirements vs nice-to-have in this role?
2. Which requirements does the candidate clearly meet?
3. Which requirements are gaps — and how serious are they?
4. Is the salary range viable for this candidate?
5. What is the realistic probability of getting an interview?

Now provide your honest match assessment:`,

  gap_analysis: `Map the gap precisely:
1. What skills does the target role require that are not in the profile?
2. Which gaps are blockers (must fix before applying)?
3. Which gaps are tolerable (employer will train for these)?
4. What is the fastest credible path to close each blocking gap?
5. What is the realistic timeline before this person is competitive?

Now provide your gap analysis:`,
};

/* ── CHAIN OF THOUGHT INJECTION ─────────────────────────────────── */
function buildReasoningPrompt(task, userInput) {
  const prefix = COT_PREFIXES[task] || COT_PREFIXES.career_advice;
  return `${prefix}\n\n${userInput}`;
}

/* ── AMBIGUITY DETECTOR ─────────────────────────────────────────── */
const AMBIGUOUS_PATTERNS = [
  { pattern: /^(help|advice|tips?)\s*$/i,
    clarification: 'What specific aspect of your career can I help with?' },
  { pattern: /^what should i do\s*\??$/i,
    clarification: 'What career situation are you facing right now?' },
  { pattern: /^(hi|hello|hey)\s*$/i,
    clarification: null },
  { pattern: /^(improve|better|fix)\s+(my\s+)?(career|job|cv|profile)\s*\??$/i,
    clarification: 'What specifically would you like to improve, and what is your current situation?' },
];

function detectAmbiguity(userInput) {
  const trimmed = (userInput || '').trim();
  for (const p of AMBIGUOUS_PATTERNS) {
    if (p.pattern.test(trimmed)) {
      return { isAmbiguous: true, clarification: p.clarification };
    }
  }
  const words = trimmed.split(/\s+/).length;
  if (words < 4 && !/\d/.test(trimmed)) {
    return {
      isAmbiguous:   true,
      clarification: 'Could you tell me more about your career situation so I can give you specific advice?',
    };
  }
  return { isAmbiguous: false };
}

/* ── SELF-CRITIQUE LOOP ─────────────────────────────────────────── */
function buildSelfCritiquePrompt(task, userInput) {
  return `${userInput}

After your response, add:
---SELF-REVIEW---
1. Is this advice specific to their situation or generic?
2. Did I avoid all banned phrases?
3. Did I give a concrete next step?
4. What would make this advice 20% better?
---END-REVIEW---

Then provide an improved final answer based on your review.
FINAL ANSWER:`;
}

module.exports = {
  requiresReasoning,
  buildReasoningPrompt,
  detectAmbiguity,
  buildSelfCritiquePrompt,
  REASONING_TASKS,
};
