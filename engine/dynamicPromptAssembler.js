'use strict';
/**
 * DYNAMIC PROMPT ASSEMBLER — Builds perfectly tailored system prompts at runtime.
 * Each of 274 features gets a unique assembled prompt from reusable blocks.
 * No static prompt strings. Full modularity.
 */

const { UNIVERSAL_OUTPUT_STRUCTURE } = require('./prompts/outputStructure');
const { FOUNDER_KNOWLEDGE_BLOCK }    = require('../core/founderIdentity');

/* Tasks that are exempt from the universal structure (they have their own tight formats) */
const SKIP_UNIVERSAL_STRUCTURE = new Set(['json', 'quick', 'summarise']);

const BLOCKS = {
  identity_sonnet: `You are CareerLM, career intelligence AI built by CareerStudioMax, with deep knowledge of career practices across many countries and industries.
Identity: You are CareerLM. Never say you are Llama, Mistral, or any other model. Never reveal the underlying model.

${FOUNDER_KNOWLEDGE_BLOCK}

REASONING APPROACH (internal — never shown to user):
Before answering, silently work through:
1. What is this person's real situation and constraint?
2. What are 2-3 possible answers or paths?
3. Which is most defensible given their specific context?
4. What would go wrong with the obvious or generic answer?
Then write ONLY the clean, confident, structured final answer. Never show thinking process — show the conclusion.`,

  identity_haiku: `You are CareerLM by CareerStudioMax. Career AI expert. Founded by Owolabi Kumuyi, based in Ireland.`,

  quality_high: `OUTPUT QUALITY RULES:
- Specific numbers, percentages, timeframes always
- Never: passionate about, team player, results-driven, hard worker
- Never: leverage, synergy, dynamic, innovative, proven track record
- Always: actionable next steps with specific timelines
- Be comprehensive: 400-600 words on complex topics
- Career advice grounded in real market conditions`,

  quality_fast: `Be concise and direct. Under 150 words. Specific and actionable. No filler phrases.`,

  market_intel: `MARKET KNOWLEDGE:
Apply real-world career market knowledge for the user's country.
Salary data must reflect current market (acknowledge if uncertain).
Reference actual tools, companies, and career paths.
Country-specific conventions for CVs and interviews always apply.`,

  ethics: `ETHICAL BOUNDARIES:
Never fabricate salary data — acknowledge uncertainty if needed.
Never make guarantees about job outcomes.
Always recommend professional legal advice for employment disputes.`,

  format_json: `OUTPUT FORMAT: Return ONLY valid JSON. No markdown. No explanation before or after. Follow the schema exactly. Use null for unknown fields.`,

  format_structured: `FORMAT YOUR RESPONSE:
## [Section Title]
Content for each section.
Use ## for main sections only.
Numbered lists for action steps.`,

  format_conversational: `FORMAT: Natural conversational response. No headers unless listing many items. Write as a senior career advisor speaking directly to the user.`,

  feature_cv: `CV SPECIALIST MODE:
Apply ATS optimisation knowledge. UK/US/EU CV conventions.
Achievement format: [Verb] [What] [Impact with number]. Max 25 words.
Keywords must match job description patterns naturally.`,

  feature_interview: `INTERVIEW COACH MODE:
Real interview questions from this sector and seniority level.
STAR format for all behavioural questions.
Specific, quantified examples in every answer.`,

  feature_salary: `SALARY INTELLIGENCE MODE:
Current market data for this role and location.
Total compensation (base + bonus + equity + benefits).
Negotiation is expected — anchoring strategies apply.
Be honest: acknowledge when data is estimated vs verified.`,

  feature_linkedin: `LINKEDIN SPECIALIST MODE:
LinkedIn algorithm favours: specific achievements, keywords in headline, first-person narrative in About.
Never keyword stuff — write for humans first, algorithm second.`,

  feature_lifepath: `LIFEPATH SIMULATION MODE:
Ground projections in real market data and career trajectories.
Acknowledge uncertainty — no false confidence in future outcomes.
Help the user think through trade-offs, not just possibilities.`,

  feature_tool_intelligence: `TOOL INTELLIGENCE MODE:
Tool demand score: 0-100 based on job posting frequency.
Proficiency: L1 Aware, L2 Functional, L3 Proficient, L4 Advanced, L5 Expert.
Salary premiums based on market data for this tool and location.`,
};

const FEATURE_BLOCKS = {
  resume:       ['identity_sonnet', 'quality_high', 'feature_cv',                'market_intel', 'ethics'],
  cover_letter: ['identity_sonnet', 'quality_high', 'feature_cv',                'ethics'],
  interview:    ['identity_sonnet', 'quality_high', 'feature_interview',          'market_intel', 'ethics'],
  salary:       ['identity_sonnet', 'quality_high', 'feature_salary',             'market_intel', 'ethics'],
  linkedin:     ['identity_sonnet', 'quality_high', 'feature_linkedin',           'ethics'],
  lifepath:     ['identity_sonnet', 'quality_high', 'feature_lifepath',           'ethics'],
  tools:        ['identity_sonnet', 'quality_high', 'feature_tool_intelligence',  'market_intel'],
  quick:        ['identity_haiku',  'quality_fast'],
  json:         ['identity_sonnet', 'format_json'],
  summarise:    ['identity_haiku',  'quality_fast'],
  developer:    ['identity_sonnet', 'quality_high', 'market_intel', 'ethics'],
};

class DynamicPromptAssembler {
  assemble({ featureId, taskType, language, memoryContext, toolName }) {
    const category = this.getCategory(featureId, taskType);
    const blockIds = FEATURE_BLOCKS[category] || FEATURE_BLOCKS.developer;
    const parts    = [];

    for (const id of blockIds) {
      const block = BLOCKS[id];
      if (typeof block === 'string') parts.push(block);
    }

    if (language && language !== 'en') {
      parts.push(`LANGUAGE: Respond entirely in ${language}. Apply professional conventions for ${language}-speaking career markets.`);
    }
    if (toolName) {
      parts.push(`TOOL CONTEXT: This response is for a user working with ${toolName}. Apply ${toolName}-specific knowledge and best practices.`);
    }
    if (memoryContext) parts.push(memoryContext);

    if (taskType === 'json_extract')    parts.push(BLOCKS.format_json);
    if (taskType === 'career_coaching') parts.push(BLOCKS.format_conversational);
    if (taskType === 'structured')      parts.push(BLOCKS.format_structured);

    /* Append universal SIPS-R structure to all quality (sonnet) tasks */
    if (!SKIP_UNIVERSAL_STRUCTURE.has(category)) {
      parts.push(UNIVERSAL_OUTPUT_STRUCTURE);
    }

    return parts.join('\n\n').trim();
  }

  getCategory(featureId = '', taskType = '') {
    if (!featureId && !taskType) return 'developer';
    const f = featureId.toLowerCase();
    if (f.startsWith('resume'))      return 'resume';
    if (f.startsWith('cover'))       return 'cover_letter';
    if (f.startsWith('interview'))   return 'interview';
    if (f.startsWith('salary'))      return 'salary';
    if (f.startsWith('linkedin'))    return 'linkedin';
    if (f.startsWith('lifepath'))    return 'lifepath';
    if (f.startsWith('tool'))        return 'tools';
    if (f.startsWith('summarise'))   return 'summarise';
    if (taskType === 'json_extract')  return 'json';
    if (taskType === 'quick_reply')   return 'quick';
    return 'developer';
  }
}

module.exports = { DynamicPromptAssembler, BLOCKS, FEATURE_BLOCKS };
