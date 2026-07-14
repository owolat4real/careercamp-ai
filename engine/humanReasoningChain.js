'use strict';
/**
 * HUMAN REASONING CHAIN — Forces cs-sonnet to reason step-by-step
 * before generating output, producing quality that rivals models 10× its size.
 * cs-haiku gets simplified reasoning (cannot hold full HRC in context).
 */

const REASONING_TEMPLATES = {

  career_advice: `
THINK STEP BY STEP BEFORE ANSWERING:

Step 1 — UNDERSTAND THE SITUATION:
What exactly is the user asking?
What is their career context?
What outcome do they need?

Step 2 — APPLY MARKET KNOWLEDGE:
What does the current job market say about this?
What salary/demand data is relevant?
What do top performers in this role do?

Step 3 — IDENTIFY THE CORE INSIGHT:
What is the ONE most important thing this person needs to know?
What would a senior career director at a top firm say?

Step 4 — BUILD THE RESPONSE:
Lead with the direct answer.
Support with specific data or examples.
Give numbered action steps with timelines.
Be honest about challenges.

NOW WRITE YOUR RESPONSE:`,

  cv_bullet: `
THINK BEFORE REWRITING:

Step 1 — DIAGNOSE the weak bullet:
What is vague? What is missing?
What achievement is buried in generic language?
What specific tool, metric, or outcome is absent?

Step 2 — EXTRACT the real achievement:
What did this person actually DO?
What CHANGED because of their work?
What NUMBER can represent the impact?

Step 3 — REWRITE using the formula:
[Strong Action Verb] + [What] + [How] + [Impact with Number]
Maximum 25 words. ATS-friendly keywords included.

Step 4 — VERIFY: action verb ✓, specific number ✓, keywords ✓, under 25 words ✓, zero banned phrases ✓

NOW WRITE THE IMPROVED BULLET:`,

  salary_negotiation: `
THINK THROUGH THE NEGOTIATION:

Step 1 — ASSESS THE POWER BALANCE:
How much does this employer need this person?
What is the market rate for this role right now?
What alternatives does the candidate have?

Step 2 — IDENTIFY LEVERAGE:
What unique value does this candidate bring?
What timing factors favour the candidate?

Step 3 — BUILD THE STRATEGY:
Target number? Walk-away number? Non-salary items?

Step 4 — WRITE THE SCRIPT:
Be specific, confident, and professional. Anchor high. Always give a reason.

NOW WRITE THE NEGOTIATION APPROACH:`,

  interview_prep: `
PREPARE LIKE A SENIOR INTERVIEW COACH:

Step 1 — ANALYSE THE ROLE AND COMPANY:
What does this company value most?
What are the top 3 skills this role requires?

Step 2 — ANTICIPATE THE QUESTIONS:
What are the hardest questions they will face?
What mistake do candidates typically make here?

Step 3 — BUILD STRONG ANSWERS:
STAR format: Situation → Task → Action → Result
Include specific numbers and outcomes.

Step 4 — PREPARE THE CLOSE:
Questions to ask the interviewer? How to follow up?

NOW WRITE THE INTERVIEW PREPARATION:`,

  tool_analysis: `
ANALYSE THE TOOL CAREER INTELLIGENCE:

Step 1 — MARKET POSITION: Demand score 0-100. Trending up/stable/down?
Step 2 — PROFICIENCY LEVELS: L1→L5. What separates beginner from expert?
Step 3 — SALARY PREMIUM: How much does this skill add at each level? Which markets?
Step 4 — LEARNING PATH: Hours to each level. Free resources. Certifications.

NOW WRITE THE TOOL INTELLIGENCE REPORT:`,

  summarise: `
EXTRACT THE ESSENTIAL:

Step 1 — READ FIRST: What is the single most important point?
Step 2 — COMPRESS: 3-5 bullet points. Each under 15 words.
Step 3 — VERIFY: All key numbers preserved? Career context clear?

NOW WRITE THE SUMMARY:`,
};

const SHORT_REASONING = {
  career_advice:      'Think: What do they need? Answer directly. Be specific with numbers.',
  cv_bullet:          'Think: What is the impact? Add a number. Strong action verb.',
  summarise:          'Think: What matters most? 3 bullets only.',
  salary_negotiation: 'Think: What is fair market? Give a specific number range.',
  interview_prep:     'Think: What will they ask? Give a STAR answer.',
  tool_analysis:      'Think: Demand score? Key use cases? Learning time?',
};

class HumanReasoningChain {
  inject(systemPrompt, task) {
    const template = REASONING_TEMPLATES[task];
    return template ? systemPrompt + '\n\n' + template : systemPrompt;
  }

  injectShort(systemPrompt, task) {
    const short = SHORT_REASONING[task];
    return short ? systemPrompt + '\n' + short : systemPrompt;
  }
}

module.exports = { HumanReasoningChain, REASONING_TEMPLATES };
