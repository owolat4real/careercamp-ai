'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * SALARY BENCHMARK — orchestrates the 3-layer SIPS pipeline
 *
 * LAYER 1: SALARY_INTELLIGENCE_PROMPT   — who the model is + rules
 * LAYER 2: buildSalaryReasoningPrefix   — forces private reasoning first
 * LAYER 3: buildSalaryUserPrompt        — structured context for this query
 *
 * Usage in camp.js:
 *   const { runSalaryBenchmark } = require('../engine/features/salaryBenchmark')
 *   const callModel = (messages, overrides) => callWithRetry({ ...feature, ...overrides }, messages)
 *                       .catch(() => externalFallback({ ...feature, ...overrides }, messages))
 *   const result = await runSalaryBenchmark(cleanInput, {}, callModel)
 * ═══════════════════════════════════════════════════════════════════════ */

const { SALARY_INTELLIGENCE_PROMPT }      = require('../prompts/salaryIntelligence')
const { buildSalaryUserPrompt,
        extractRole, extractCountry,
        extractCity, extractYears,
        extractSkills }                   = require('../prompts/salaryInputBuilder')
const { buildSalaryReasoningPrefix }      = require('../prompts/reasoningInjector')
const { gatherSalaryLiveData, buildGroundingBlock } = require('../../core/liveData/groundingLayer')

/* ── SALARY FEATURE CONFIG OVERRIDES ─────────────────────────────────── */
const SALARY_CALL_OVERRIDES = {
  model:     'cs-sonnet',   /* force sonnet — salary needs the best local model */
  maxTokens: 2048,          /* 800+ word target requires generous token budget */
  task:      'salary_analysis',
  temperature: 0.65,        /* lower = less hallucination on numeric data */
}

/**
 * Top-level entry point. Called by camp.js instead of callWithRetry
 * for any salary_analysis feature.
 *
 * @param {string}   userInput     — raw user query (PII-scrubbed if needed)
 * @param {object}   careerContext — structured context from the request body
 * @param {function} callModel     — (messages, overrides) → Promise<{content, model}>
 * @returns {Promise<{content, model, salary: {confidence, currency, keyNumbers}}>}
 */
async function runSalaryBenchmark(userInput, careerContext = {}, callModel) {
  /* Live data grounding — every salary_analysis-tasked feature routes through
     here, so this one fetch grounds ~20 features (salary_benchmark,
     offer_evaluation, negotiation_playbook, total_comp_analyser, etc.) at once. */
  const role    = careerContext.targetRole || careerContext.role    || extractRole(userInput)
  const country = careerContext.country                             || extractCountry(userInput)
  const liveData = await gatherSalaryLiveData({ role, country, currency: careerContext.currency }).catch(() => null)
  const groundingBlock = buildGroundingBlock(liveData)

  const { system, user } = buildSalaryPrompts(userInput, careerContext, groundingBlock)

  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ]

  const raw = await callModel(messages, SALARY_CALL_OVERRIDES)
  const processed = postProcessSalaryOutput(raw.content, userInput)

  return {
    content:  processed.content,
    model:    raw.model,
    salary: {
      confidence:  processed.overallConfidence,
      currency:    processed.currency,
      keyNumbers:  processed.keyNumbers,
      wordCount:   processed.wordCount,
      sectionsFound: processed.sectionsFound,
    },
  }
}

/**
 * Assemble the 3-layer prompt stack.
 * Returns { system: string, user: string }
 */
function buildSalaryPrompts(userInput, careerContext = {}, groundingBlock = '') {
  /* Extract context for the reasoning prefix */
  const role    = careerContext.targetRole || careerContext.role    || extractRole(userInput)
  const country = careerContext.country                             || extractCountry(userInput)
  const city    = careerContext.city                                || extractCity(userInput)
  const years   = careerContext.yearsExp   || careerContext.years   || extractYears(userInput)

  /* Layer 2 — reasoning chain (prepended to user message).
     hasLiveData tells the reasoning template to check the grounding block
     BEFORE deriving figures from training data — without this, the model
     follows this scratchpad's own "derive from training data" steps and
     never notices the LIVE DATA block sitting in the system prompt. */
  const reasoning = buildSalaryReasoningPrefix(role, country, city, years, !!groundingBlock)

  /* Layer 3 — structured user context */
  const userPrompt = buildSalaryUserPrompt(userInput, careerContext)

  return {
    system: [SALARY_INTELLIGENCE_PROMPT, groundingBlock].filter(Boolean).join('\n\n'),
    user:   reasoning + '\n\n---\n\n' + userPrompt,
  }
}

/**
 * Validate and post-process the raw model output.
 * Adds warnings for missing confidence tags, missing sections, short output.
 */
function postProcessSalaryOutput(rawContent, userInput) {
  if (!rawContent) {
    return {
      content: 'CareerLM could not generate a salary report at this time. Please try again.',
      overallConfidence: 'UNKNOWN',
      currency: extractCurrency(''),
      keyNumbers: [],
      wordCount: 0,
      sectionsFound: [],
    }
  }

  /* Strip <reasoning> block from output before sending to user */
  const content = rawContent.replace(/<reasoning>[\s\S]*?<\/reasoning>\n*/g, '').trim()

  const wordCount   = content.split(/\s+/).filter(Boolean).length
  const hasConfTags = /\[(VERIFIED|INFERRED|ESTIMATED|UNKNOWN)\]/.test(content)
  const currency    = extractCurrency(content) || extractCurrency(userInput)

  const REQUIRED_SECTIONS = [
    '## 💰 SALARY INTELLIGENCE REPORT',
    '## 📊 THE NUMBERS',
    '## 🗺 LOCATION BREAKDOWN',
    '## 🔧 SKILL PREMIUMS',
    '## 🏢 EMPLOYER TYPE MATTERS',
    '## 📈 THE CAREER TRAJECTORY',
    '## ⚠️ MARKET REALITY CHECK',
    '## 🤝 YOUR NEGOTIATION PLAYBOOK',
    '## 📋 YOUR NEXT 3 ACTIONS',
    '## ⚡ DATA CONFIDENCE SUMMARY',
  ]

  const sectionsFound = REQUIRED_SECTIONS.filter(s => {
    /* Match the emoji variant or a close text variant */
    const bare = s.replace(/[^\w\s]/gu, '').trim()
    return content.includes(s) || content.includes(bare)
  })

  const warnings = []
  if (wordCount < 800) {
    warnings.push(`⚠️ Output shorter than expected (${wordCount} words vs 800 minimum). For a more detailed analysis, try adding your specific role, city, and years of experience.`)
  }
  if (!hasConfTags) {
    warnings.push(`⚠️ Confidence tags were not included in this response. Treat all salary figures as estimates only.`)
  }
  if (sectionsFound.length < 7) {
    const missing = REQUIRED_SECTIONS.filter(s => !sectionsFound.includes(s))
    warnings.push(`⚠️ Some report sections were omitted: ${missing.map(s => s.replace(/^## [^\s]+ /, '')).join(', ')}.`)
  }

  const finalContent = warnings.length
    ? content + '\n\n---\n\n' + warnings.join('\n\n')
    : content

  return {
    content:           finalContent,
    overallConfidence: extractOverallConfidence(content),
    currency,
    keyNumbers:        extractKeyNumbers(content),
    wordCount,
    sectionsFound,
  }
}

/* ── DATA EXTRACTORS ──────────────────────────────────────────────────── */

/**
 * Extract the overall confidence level from the report header.
 */
function extractOverallConfidence(content) {
  const m = content.match(/Overall Confidence:\s*(VERIFIED|INFERRED|ESTIMATED)/i)
  return m ? m[1].toUpperCase() : 'ESTIMATED'
}

/**
 * Detect which currency the report used.
 */
function extractCurrency(content) {
  if (!content) return 'USD'
  if (/CAD\s*\$|CAD\$/i.test(content))  return 'CAD'
  if (/GBP|£/.test(content))            return 'GBP'
  if (/NGN|₦/.test(content))            return 'NGN'
  if (/AUD\s*\$|AUD\$/i.test(content))  return 'AUD'
  if (/EUR|€/.test(content))            return 'EUR'
  if (/INR|₹/.test(content))            return 'INR'
  if (/SGD\s*\$|SGD\$/i.test(content))  return 'SGD'
  if (/AED/.test(content))              return 'AED'
  if (/ZAR|R\s+\d/.test(content))       return 'ZAR'
  if (/KES/.test(content))              return 'KES'
  if (/GHS/.test(content))              return 'GHS'
  if (/\$/.test(content))               return 'USD'
  return 'USD'
}

/**
 * Pull the headline salary figures from the Percentile table.
 * Returns an array of { label, amount, confidence } objects.
 */
function extractKeyNumbers(content) {
  if (!content) return []
  const rows = []
  /* Match table rows: | Percentile | Amount | ... */
  const tableRowRegex = /\|\s*([^|]+?)\s*\|\s*([£$€₦₹A-Z]?\s*[\d,]+\s*k?)\s*/g
  let m
  while ((m = tableRowRegex.exec(content)) !== null) {
    const label  = m[1].trim()
    const amount = m[2].trim()
    if (/bottom|10%|25th|median|75th|top/i.test(label) && /\d/.test(amount)) {
      /* Find confidence tag on the same line */
      const lineStart = content.lastIndexOf('\n', m.index) + 1
      const lineEnd   = content.indexOf('\n', m.index)
      const line      = content.slice(lineStart, lineEnd)
      const confMatch = line.match(/\[(VERIFIED|INFERRED|ESTIMATED|UNKNOWN)\]/)
      rows.push({ label, amount, confidence: confMatch ? confMatch[1] : 'ESTIMATED' })
    }
  }
  return rows
}

module.exports = {
  runSalaryBenchmark,
  buildSalaryPrompts,
  postProcessSalaryOutput,
  extractOverallConfidence,
  extractCurrency,
  extractKeyNumbers,
  SALARY_CALL_OVERRIDES,
}
