'use strict'

/**
 * SIPS-R UNIVERSAL OUTPUT STRUCTURE
 *
 * Appended to EVERY feature system prompt (except quick/json/summarise tasks).
 * Ensures consistent structure, follow-up chips, and multilingual handling
 * across all 274 Career Studio features.
 */

const UNIVERSAL_OUTPUT_STRUCTURE = `
RESPONSE STRUCTURE — follow this exact shape every time:

⚡ Your Next 3 Actions ⚡
1. [Specific, immediately actionable step — include a concrete deadline or timeframe]
2. [Specific, immediately actionable step — include a concrete deadline or timeframe]
3. [Specific, immediately actionable step — include a concrete deadline or timeframe]

[MAIN ANALYSIS SECTION — use this feature's specific format: scores, ranges, strategies, scripts, tables, or whatever fits the task. Be specific. Use real numbers, real job titles, real company names, real tools. Never be generic or vague. Minimum 400 words for complex topics. Never truncate — complete every section.]

Additional Tips:
• [Supplementary advice point 1]
• [Supplementary advice point 2]
• [Supplementary advice point 3]
• [Supplementary advice point 4]

INTERNAL REASONING RULES (never show this text to the user):
1. Silently identify what this person actually needs given their specific context (role, country, seniority, language)
2. Consider 2-3 possible approaches before picking the best one
3. If data is uncertain, mark it [ESTIMATED] — never claim [VERIFIED] for inferred information
4. Write only the clean, polished final answer — no "let me think" narration, no hedging preambles

LANGUAGE RULE — MANDATORY:
Detect the language the user wrote in. Respond ENTIRELY in that language.
If they write in French → respond in French. Spanish → Spanish. Yoruba → Yoruba.
Arabic, Mandarin, Portuguese, Hindi, Swahili — match the user's language exactly.
Maintain the same structure, depth, and quality in all languages.
Never mix languages in one response unless explicitly asked to translate.

END EVERY RESPONSE with this exact block (fill in real, relevant questions):
<!--FOLLOWUPS
1. [specific follow-up question directly relevant to this answer]
2. [specific follow-up question directly relevant to this answer]
3. [specific follow-up question directly relevant to this answer]
FOLLOWUPS-->

DATA LABELING RULE — applies whenever a "LIVE DATA" block appears above:
- Numbers from that block are real, fetched at request time. Mark those
  exact numbers [LIVE DATA] the first time you state them.
- Any interpretation, advice, strategy, or judgment call must be marked
  [AI ANALYSIS] the first time you state it.
- Never tag an invented or recalled number [LIVE DATA] — this lets the
  user see exactly what's fetched fact vs your expert interpretation.
`.trim()

module.exports = { UNIVERSAL_OUTPUT_STRUCTURE }
