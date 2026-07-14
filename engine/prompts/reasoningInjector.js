'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * SALARY REASONING INJECTOR
 *
 * Forces cs-sonnet to reason privately before outputting salary data.
 * This is the primary hallucination-elimination technique:
 *   STEP 1 — model writes a private reasoning block
 *   STEP 2 — model writes the public structured output
 *
 * The reasoning prefix is prepended to the assistant turn as a
 * "pre-filled response start" — models are dramatically less likely
 * to confabulate when they've already worked through the logic.
 *
 * Technique: "reasoning prefix injection" or "scratchpad priming"
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Build the private reasoning chain that cs-sonnet must work through
 * before producing any salary data.
 *
 * This text is injected as the START of the assistant's response
 * (via the Anthropic API's messages[{role:'assistant'}] trick),
 * forcing the model to continue from this reasoning point rather
 * than starting cold with numbers it may confabulate.
 *
 * @param {string} role     — extracted role title
 * @param {string} country  — extracted country
 * @param {string} city     — extracted city (optional)
 * @param {number} years    — years of experience (optional)
 * @returns {string}        — reasoning prefix to inject as assistant turn start
 */
function buildSalaryReasoningPrefix(role, country, city, years, hasLiveData = false) {
  const level    = getLevel(years)
  const currency = getCurrency(country)
  const market   = [city, country].filter(Boolean).join(', ') || 'the specified market'

  const liveDataStep = hasLiveData ? `STEP 0: CHECK THE LIVE DATA BLOCK FIRST
My system prompt contains a "═══ GROUNDING RULES ═══" section with a LIVE DATA
block fetched moments ago from real APIs (job postings count, exchange rate,
country stats — whichever apply). Before I estimate anything from training
data, I must scan that block first. Any number in it is real and current —
I will use it exactly as given and tag it [LIVE DATA], not [VERIFIED]. If the
block says a data point is unavailable, I will say so honestly rather than
filling the gap with a training-data guess.

` : ''

  return `<reasoning>
Let me work through this salary analysis carefully before I write anything.

${liveDataStep}STEP 1: WHAT I ACTUALLY KNOW
Role: ${role || 'not specified — I will infer from context'}
Market: ${market}
Experience: ${years ? `${years} years — ${level} level` : 'not specified — I will assume mid-level (5-8 years)'}
Currency: ${currency}

I must use ${currency} throughout. I must NOT use USD data if the user is in ${country || 'a non-US market'}.

STEP 2: WHAT I AM CONFIDENT ABOUT vs. WHAT I AM ESTIMATING
Let me be honest about my data quality before I write any numbers.

For ${role || 'this role'} in ${market}:
- My training data for this market/role combination is: [assess: strong / moderate / thin]
- Specific city-level data quality: [assess: verified / inferred / estimated]
- Skill premium data is: [typically inferred from job postings and adjacent data]
- Negotiation tactics: [always high confidence — these are principles, not data]

STEP 3: SALARY RANGE DERIVATION
I will derive ranges from:
1. National/regional benchmarks for this role type
2. Experience-level adjustment (${level} typically sits at approximately [X]th percentile)
3. City-level premium/discount for ${city || 'the relevant market'}
4. Sector adjustments if industry context was provided

I must tag every number I write with [VERIFIED], [INFERRED], [ESTIMATED], or [UNKNOWN].
I will NOT write a number I cannot justify with at least [ESTIMATED] confidence.

STEP 4: SKILL PREMIUMS
For the skill premiums table, I will:
- Only list skills that genuinely command verifiable premiums in ${country || 'this market'}
- Give specific % or currency amounts, not vague "high demand" statements
- Tag each premium with its confidence level
- List at least 5 skills with real differentials

STEP 5: NEGOTIATION STRATEGY
The negotiation section requires:
- Specific numbers (not ranges) for the opening ask, target, and walk-away
- Word-for-word scripts the user can speak verbatim
- Acknowledgment of whether the user appears underpaid/at market/above market
  based on any salary they mentioned

STEP 6: COUNTRY-SPECIFIC CONTEXT FOR ${(country || 'THIS MARKET').toUpperCase()}
I will address:
- Regional salary differences within ${country || 'this country'} (at least 4 regions)
- Union/non-union dynamics if applicable
- Any language/immigration factors affecting negotiation leverage in this country

Now I will write the full structured salary report. Every section. Every table. Every number tagged.
</reasoning>

`
}

/* ── HELPERS ──────────────────────────────────────────────────────────── */

/**
 * Map country name to its correct currency string.
 * Must match the currency rules in SALARY_INTELLIGENCE_PROMPT exactly.
 */
function getCurrency(country) {
  const map = {
    'Canada':         'CAD $',
    'United Kingdom': 'GBP £',
    'Ireland':        'EUR €',
    'United States':  'USD $',
    'Nigeria':        'NGN ₦ (with USD equivalent)',
    'Germany':        'EUR €',
    'Australia':      'AUD $',
    'India':          'INR ₹ (with USD equivalent)',
    'UAE':            'AED (with USD equivalent)',
    'South Africa':   'ZAR R',
    'Kenya':          'KES (with USD equivalent)',
    'Singapore':      'SGD $',
    'Ghana':          'GHS',
  }
  return map[country] || 'USD $ (country unspecified — flag as assumed)'
}

/**
 * Map years of experience to career level label.
 */
function getLevel(years) {
  if (!years)       return 'mid-level (assumed)'
  if (years < 2)    return 'junior / entry-level'
  if (years < 5)    return 'early-career'
  if (years < 10)   return 'mid-to-senior'
  if (years < 15)   return 'senior'
  return 'director / principal'
}

module.exports = {
  buildSalaryReasoningPrefix,
  getCurrency,
  getLevel,
}
