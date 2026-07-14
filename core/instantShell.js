'use strict'

/* Pre-computed shell text that appears before the model generates.
   Keeps it generic enough to be true for any input. */
const SHELL_TEMPLATES = {
  resume_builder:       '⚡ Your Next 3 Actions ⚡\n\n1. Scanning your experience...\n2. Identifying ATS keywords...\n3. Drafting your tailored resume...\n\n',
  cover_letter:         '⚡ Your Next 3 Actions ⚡\n\n1. Analysing the job description...\n2. Matching your strengths...\n3. Crafting your opening paragraph...\n\n',
  interview_prep:       '⚡ Your Next 3 Actions ⚡\n\n1. Researching likely questions...\n2. Structuring STAR responses...\n3. Preparing power phrases...\n\n',
  salary_negotiation:   '⚡ Your Next 3 Actions ⚡\n\n1. Benchmarking market rates...\n2. Identifying leverage points...\n3. Scripting your ask...\n\n',
  career_coach:         '⚡ Your Next 3 Actions ⚡\n\n1. Understanding your situation...\n2. Mapping possible paths...\n3. Recommending your next move...\n\n',
  linkedin_optimiser:   '⚡ Your Next 3 Actions ⚡\n\n1. Auditing your profile...\n2. Identifying keyword gaps...\n3. Rewriting your headline & summary...\n\n',
  job_search_strategy:  '⚡ Your Next 3 Actions ⚡\n\n1. Mapping the target market...\n2. Prioritising channels...\n3. Building your 30-day plan...\n\n',
  skill_gap_analysis:   '⚡ Your Next 3 Actions ⚡\n\n1. Inventorying current skills...\n2. Comparing to target role requirements...\n3. Suggesting a learning path...\n\n',
  personal_brand:       '⚡ Your Next 3 Actions ⚡\n\n1. Clarifying your unique value...\n2. Identifying your audience...\n3. Crafting your brand statement...\n\n',
  DEFAULT:              '⚡ Your Next 3 Actions ⚡\n\n1. Analysing your request...\n2. Applying career intelligence...\n3. Building your personalised response...\n\n',
}

/**
 * Returns the shell text for a given featureId.
 * Falls back to DEFAULT if no specific template is registered.
 */
function getInstantShell(featureId) {
  return SHELL_TEMPLATES[featureId] || SHELL_TEMPLATES.DEFAULT
}

module.exports = { getInstantShell, SHELL_TEMPLATES }
