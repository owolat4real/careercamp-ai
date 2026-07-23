'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * GROUNDING LAYER — forces the AI to use real data, not invent it
 *
 * Two entry points into the 274-feature pipeline (routes/camp.js):
 *   1. gatherLiveData(featureId, context) + buildGroundingBlock(liveData)
 *      → for any non-salary featureId listed in FEATURE_DATA_REQUIREMENTS
 *   2. gatherSalaryLiveData(context)
 *      → every salary_analysis-tasked feature (~20 features) routes
 *        through engine/features/salaryBenchmark.js, so this one function
 *        grounds all of them in a single wiring point instead of listing
 *        each featureId individually
 *
 * BUCKET A (facts) only. This module never asks the model to reason —
 * it fetches real numbers and hands them over as non-negotiable context.
 * ═══════════════════════════════════════════════════════════════════════ */

const axios = require('axios')
const { getExchangeRate, getCountryData, getJobMarketData, countryToCode } = require('./dataSources')
const { cachedFetch } = require('./dataCache')
const { estimateSalaryViaPPP } = require('./pppEstimator')

/* careercamp-ai has no direct database access — it's a stateless LLM
 * gateway. cs_fixed owns the 179-country CountryRegistry (self-enriching,
 * see cs_fixed/services/selfOps.js) and exposes it over HTTP for exactly
 * this purpose. Failure here just means "no registry info" — the caller
 * degrades to an honest "unavailable" rather than crashing. */
const WORLD_DATA_API_URL = process.env.WORLD_DATA_API_URL || 'http://localhost:3001/api/world'

async function _checkCountryRegistry(country) {
  if (!country) return null
  try {
    const res = await axios.get(`${WORLD_DATA_API_URL}/countries/${encodeURIComponent(country)}`, { timeout: 4000 })
    return res.data?.country || null
  } catch (err) {
    console.warn('[LIVE-DATA] Country registry lookup failed:', err.message)
    return null
  }
}

const COMMUNITY_SALARY_API_URL = WORLD_DATA_API_URL.replace(/\/world$/, '/community-salary')
const DATA_AUDIT_API_URL       = WORLD_DATA_API_URL.replace(/\/world$/, '/data-audit')

/* Community Verification Loop — real crowd-submitted salaries outrank
 * a computed PPP estimate once enough exist (see cs_fixed's
 * services/communityVerification.js for the trust threshold + outlier
 * rejection). Same HTTP-bridge pattern as the registry lookup above. */
async function _checkCommunityVerified(countryCode, role, seniority) {
  if (!countryCode || !role) return null
  try {
    const res = await axios.get(
      `${COMMUNITY_SALARY_API_URL}/${encodeURIComponent(countryCode)}/${encodeURIComponent(role)}/${encodeURIComponent(seniority || 'mid')}`,
      { timeout: 4000 }
    )
    return res.data?.available ? res.data : null
  } catch (err) {
    console.warn('[LIVE-DATA] Community salary lookup failed:', err.message)
    return null
  }
}

/* Full Provenance Ledger — fire-and-forget audit log of every number
 * actually shown, so any claim can be traced back after the fact.
 * careercamp-ai has no DB, so this pushes to cs_fixed over HTTP;
 * failures here must never affect the actual user-facing response.
 * cs_fixed's /api/data-audit/log now requires this shared secret
 * (previously had no auth at all — anyone could inject fake provenance
 * records) — set the SAME value for DATA_AUDIT_INTERNAL_SECRET on both
 * this service and cs_fixed. */
function _logProvenance(entry) {
  const secret = process.env.DATA_AUDIT_INTERNAL_SECRET
  if (!secret) return // cs_fixed will reject anyway; skip the doomed request
  axios.post(`${DATA_AUDIT_API_URL}/log`, entry, {
    timeout: 3000,
    headers: { 'x-internal-secret': secret },
  }).catch(() => {})
}

/* Which non-salary features require which live data before the AI runs.
 * Salary-tasked features (salary_benchmark, offer_evaluation, negotiation_playbook,
 * total_comp_analyser, market_value_calculator, international_salary, etc.) are
 * NOT listed here — they all share one task ('salary_analysis') and are grounded
 * centrally via gatherSalaryLiveData(), called from salaryBenchmark.js. */
const FEATURE_DATA_REQUIREMENTS = {
  job_match_scorer:       ['jobMarket'],
  candidate_match_engine: ['jobMarket'],
  hidden_job_market:      ['jobMarket'],
  job_board_strategy:     ['jobMarket'],
  remote_job_finder:      ['jobMarket'],
  job_offer_comparison:   ['currency'],
  visa_sponsorship_advisor: ['country'],
}

/* ── FETCH ALL REQUIRED LIVE DATA FOR A (non-salary) FEATURE ──────────── */
async function gatherLiveData(featureId, context = {}) {
  const requirements = FEATURE_DATA_REQUIREMENTS[featureId]
  if (!requirements) return null // this feature doesn't need live data

  return _gather(requirements, { ...context, featureId })
}

/* ── FETCH LIVE DATA FOR ANY salary_analysis-TASKED FEATURE ───────────── */
async function gatherSalaryLiveData(context = {}) {
  return _gather(['jobMarket', 'currency', 'country'], { ...context, featureId: context.featureId || 'salary_benchmark' })
}

async function _gather(requirements, context) {
  const results = {}
  const { role, country, currency } = context
  /* Resolved CountryRegistry code for provenance logging — the audit
     trail is keyed by the registry's own code field ('RW', 'UK'), which
     is NOT always the same as countryToCode()'s real ISO-3166 code
     (registry stores 'UK'/'USA' for a couple of countries, see
     COUNTRY_NAME_ALIASES in cs_fixed/routes/worldData.js). Resolved
     lazily, right before logging, via the cached registry lookup below —
     never from countryToCode(), which would silently mismatch. */
  let resolvedCountryCode = null

  if (requirements.includes('currency') && currency) {
    results.currency = await cachedFetch(
      `curr:${currency}:USD`, 'currency',
      () => getExchangeRate(currency, 'USD')
    )
  }

  if (requirements.includes('country') && country) {
    const code = countryToCode(country)
    results.country = code
      ? await cachedFetch(`country:${code}`, 'country', () => getCountryData(code))
      : null
  }

  if (requirements.includes('jobMarket') && role) {
    const direct = await cachedFetch(
      `jobs:${role}:${country || 'gb'}`, 'jobMarket',
      () => getJobMarketData(role, country)
    )

    if (direct) {
      /* Genuine Adzuna coverage for this country — unchanged live path */
      results.jobMarket = { ...direct, dataQuality: 'live' }
    } else if (country) {
      /* No direct job-market source for this country (~160 of 196).
         Resolution order: community-verified crowd data (real numbers)
         outranks a computed PPP estimate — check that first. */
      const registryEntry = await cachedFetch(
        `registry:${country}`, 'countryRegistry',
        () => _checkCountryRegistry(country)
      )
      if (registryEntry?.code) resolvedCountryCode = registryEntry.code

      const community = registryEntry?.code
        ? await _checkCommunityVerified(registryEntry.code, role, context.seniority)
        : null

      if (community) {
        results.jobMarket = {
          totalJobs: null,
          avgSalaryMin: Math.round(community.communityAvgSalaryUSD * 0.85),
          avgSalaryMax: Math.round(community.communityAvgSalaryUSD * 1.15),
          source: `Community-verified (${community.source})`,
          dataQuality: 'community-verified',
        }
      } else {
        const ukBaseline = country === 'United Kingdom' ? direct : await cachedFetch(
          'jobs:' + role + ':United Kingdom', 'jobMarket',
          () => getJobMarketData(role, 'United Kingdom')
        )

        /* Adzuna's UK mean is in GBP, not USD — convert with a real rate
           before using it as a USD baseline, never assume 1:1. */
        let baselineSalaryUSD = null
        if (ukBaseline?.avgSalary) {
          const gbpToUsd = await cachedFetch('curr:GBP:USD', 'currency', () => getExchangeRate('GBP', 'USD'))
          baselineSalaryUSD = gbpToUsd?.rate ? Math.round(ukBaseline.avgSalary * gbpToUsd.rate) : null
        }

        const estimate = estimateSalaryViaPPP({
          role, country, region: registryEntry?.region,
          baselineCountry: 'United Kingdom',
          baselineSalaryUSD,
        })

        results.jobMarket = estimate.available
          ? {
              totalJobs: null,
              avgSalaryMin: estimate.estimatedSalaryUSD,
              avgSalaryMax: estimate.estimatedSalaryMaxUSD,
              source: `PPP-estimated (${estimate.methodology})`,
              dataQuality: 'estimated',
              warning: estimate.warning,
            }
          : null /* no real baseline to adjust from — honestly unavailable, not a guess */
      }
    }
  }

  if (results.jobMarket !== undefined) {
    /* The 'live' (direct Adzuna) branch above never looks up the registry,
       so resolvedCountryCode may still be unset here — resolve it now.
       cachedFetch means this only costs a real HTTP call once per country
       (24h TTL); every other path already populated it for free. */
    if (!resolvedCountryCode && country) {
      const registryEntry = await cachedFetch(
        `registry:${country}`, 'countryRegistry',
        () => _checkCountryRegistry(country)
      )
      if (registryEntry?.code) resolvedCountryCode = registryEntry.code
    }

    _logProvenance({
      /* Prefer the resolved registry code (what GET /api/data-audit/audit/:countryCode
         actually queries by) — fall back to the raw name only if no registry
         match was found at all, so logging still degrades gracefully rather
         than silently dropping the entry. */
      featureId: context.featureId, countryCode: resolvedCountryCode || context.country, role,
      dataType: 'jobMarket', valueShown: results.jobMarket,
      sourceChain: [results.jobMarket?.source].filter(Boolean),
      confidence: results.jobMarket?.dataQuality || 'unavailable',
    })
  }

  // Nothing was actually requested (e.g. role/country/currency all missing) — no block needed
  if (!Object.keys(results).length) return null

  return results
}

/* ── BUILD THE GROUNDING BLOCK INJECTED INTO THE SYSTEM PROMPT ────────── */
function buildGroundingBlock(liveData) {
  if (!liveData) return ''

  const sections = []

  if ('jobMarket' in liveData) {
    if (!liveData.jobMarket) {
      sections.push(`JOB MARKET DATA: unavailable right now — no direct live source and no real baseline to estimate from. State this clearly to the user rather than guessing a number.`)
    } else if (liveData.jobMarket.dataQuality === 'live') {
      sections.push(`LIVE JOB MARKET DATA (from ${liveData.jobMarket.source}):
- Total matching job postings found right now: ${liveData.jobMarket.totalJobs}
- Average salary from live postings: ${liveData.jobMarket.avgSalary != null ? liveData.jobMarket.avgSalary + ' (local currency, per Adzuna)' : 'N/A — Adzuna did not return a salary aggregate for this query, only a posting count'}
Tag these exact numbers [LIVE DATA] the first time you state them.`)
    } else if (liveData.jobMarket.dataQuality === 'community-verified') {
      sections.push(`COMMUNITY-VERIFIED JOB MARKET DATA (${liveData.jobMarket.source}):
- Salary range: ${liveData.jobMarket.avgSalaryMin} - ${liveData.jobMarket.avgSalaryMax} (USD)
This is real, anonymised salary data submitted by users for this exact country/role/seniority —
not a computed estimate. Tag it [LIVE DATA] the first time you state it, and mention it's
community-sourced rather than from live job postings.`)
    } else {
      sections.push(`ESTIMATED JOB MARKET DATA (${liveData.jobMarket.source}):
- Total postings: N/A — this is a computed estimate, not a live posting count
- Estimated salary range: ${liveData.jobMarket.avgSalaryMin} - ${liveData.jobMarket.avgSalaryMax} (USD)
NOTE TO INCLUDE IN YOUR RESPONSE: ${liveData.jobMarket.warning}
Tag these numbers [ESTIMATED], never [LIVE DATA] — they were computed, not fetched from live postings.`)
    }
  }

  if ('currency' in liveData) {
    sections.push(liveData.currency
      ? `LIVE EXCHANGE RATE (from ${liveData.currency.source}, as of ${liveData.currency.date}):
1 unit = ${liveData.currency.rate} USD (use this exact rate for any conversion)`
      : `LIVE EXCHANGE RATE: unavailable right now — do not invent a conversion rate, tell the user to check current rates.`)
  }

  if ('country' in liveData) {
    sections.push(liveData.country
      ? `LIVE COUNTRY DATA (from ${liveData.country.source}):
Country: ${liveData.country.name}, Currency: ${liveData.country.currency}, Region: ${liveData.country.region}${liveData.country.capital ? `, Capital: ${liveData.country.capital}` : ''}`
      : `LIVE COUNTRY DATA: unavailable right now.`)
  }

  if (!sections.length) return ''

  return `
═══ GROUNDING RULES — READ CAREFULLY ═══
The data below was fetched LIVE at the time of this request. You MUST use
these exact numbers where relevant, and tag them [LIVE DATA] the first time
you state them. You must NEVER invent, estimate, or recall a different number
from your training data for anything covered below. If a data point below
says "unavailable," you must tell the user it's currently unavailable — do
NOT fill the gap with an invented number, and do NOT tag an invented number
[LIVE DATA] or [VERIFIED].

${sections.join('\n\n')}
═══ END LIVE DATA ═══
`.trim()
}

module.exports = { gatherLiveData, gatherSalaryLiveData, buildGroundingBlock, FEATURE_DATA_REQUIREMENTS }
