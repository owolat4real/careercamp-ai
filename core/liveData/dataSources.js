'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * LIVE DATA SOURCES — real, free, no-key-required-where-possible APIs
 *
 * Every function here either returns REAL data fetched at request time,
 * or returns null. Never a guessed/interpolated value. Callers (the
 * grounding layer) must treat null as "unavailable" and tell the model
 * to say so — not fill the gap with an invented number.
 * ═══════════════════════════════════════════════════════════════════════ */

const axios = require('axios')

const TIMEOUT_MS = 6000

/* ── CURRENCY: real-time exchange rates (Frankfurter — ECB data, no key) ── */
async function getExchangeRate(from, to) {
  if (!from || !to || from === to) {
    return from === to && from ? { rate: 1, date: new Date().toISOString().slice(0, 10), source: 'identity (same currency)' } : null
  }
  try {
    const res = await axios.get('https://api.frankfurter.app/latest', {
      params: { from, to }, timeout: TIMEOUT_MS,
    })
    const rate = res.data?.rates?.[to]
    if (!rate) return null
    return { rate, date: res.data.date, source: 'frankfurter.app (live, ECB reference rates)' }
  } catch (err) {
    console.warn('[LIVE-DATA] Currency fetch failed:', err.message)
    return null /* caller must handle null — never fabricate a rate */
  }
}

/* ── COUNTRY DATA: real stats (restcountries.com) ──────────────────────
 * restcountries.com's free v3.1 API is deprecated (confirmed by testing,
 * 2026-07) — v5 now requires an Authorization: Bearer API key. Sends it
 * when RESTCOUNTRIES_API_KEY is configured; degrades to "unavailable"
 * (never a partial/garbage object) when it isn't, rather than silently
 * injecting `undefined` values into a prompt. */
async function getCountryData(countryCode) {
  if (!countryCode) return null
  const apiKey = process.env.RESTCOUNTRIES_API_KEY
  if (!apiKey) {
    console.warn('[LIVE-DATA] RESTCOUNTRIES_API_KEY not configured — skipping country data (restcountries.com v3.1 free tier is deprecated)')
    return null
  }
  try {
    const res = await axios.get(`https://restcountries.com/v5/alpha/${countryCode}`, {
      timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.data?.success === false) return null /* deprecated/failed response shape — never fabricate from this */
    const data = Array.isArray(res.data) ? res.data[0] : (res.data?.data ?? res.data)
    if (!data || !data.name) return null
    return {
      name:       data.name?.common,
      currency:   Object.keys(data.currencies || {})[0],
      population: data.population,
      region:     data.region,
      subregion:  data.subregion,
      capital:    data.capital?.[0],
      source:     'restcountries.com v5 (live)',
    }
  } catch (err) {
    console.warn('[LIVE-DATA] Country fetch failed:', err.message)
    return null
  }
}

/* ── JOB MARKET DATA: real live postings via Adzuna ───────────────────── */
async function getJobMarketData(role, country) {
  const appId  = process.env.ADZUNA_APP_ID
  const appKey = process.env.ADZUNA_APP_KEY || process.env.ADZUNA_API_KEY
  if (!appId || !appKey) {
    console.warn('[LIVE-DATA] Adzuna keys not configured — skipping job market data')
    return null
  }
  if (!role) return null
  const countrySlug = mapToAdzunaCountry(country)
  if (!countrySlug) {
    /* Country genuinely isn't in Adzuna's coverage — report unavailable
       rather than silently substituting another country's job data,
       which ANTI_HALLUCINATION_BLOCK explicitly forbids. */
    console.warn(`[LIVE-DATA] Adzuna does not cover "${country}" — job market data unavailable, not substituting`)
    return null
  }
  try {
    const res = await axios.get(
      `https://api.adzuna.com/v1/api/jobs/${countrySlug}/search/1`,
      {
        params: {
          app_id: appId,
          app_key: appKey,
          what: role,
          results_per_page: 1,
        },
        timeout: TIMEOUT_MS,
      }
    )
    const data = res.data
    if (data?.count === undefined) return null
    /* Adzuna's /search endpoint returns a single "mean" salary figure —
       there is no mean_min/mean_max on this endpoint (confirmed live,
       2026-07). Report the one real number we have; don't invent a
       min/max spread around it. */
    return {
      totalJobs:  data.count,
      avgSalary:  typeof data.mean === 'number' ? Math.round(data.mean) : null,
      source:     'Adzuna API (live)',
    }
  } catch (err) {
    console.warn('[LIVE-DATA] Adzuna fetch failed:', err.message)
    return null
  }
}

/* Adzuna's ACTUAL supported country list (confirmed live via their API's own
 * UNSUPPORTED_COUNTRY error, 2026-07): at, au, be, br, ca, ch, de, es, fr,
 * gb, in, it, mx, nl, nz, pl, sg, us, za. Notably does NOT include Ireland,
 * Nigeria, Kenya, UAE, or most of Africa/Asia/South America beyond Brazil —
 * for those, job market data must honestly report "unavailable", never
 * silently substitute a different country's numbers. */
const ADZUNA_COUNTRY_MAP = {
  'United Kingdom': 'gb', 'UK': 'gb', 'United States': 'us', 'USA': 'us',
  'Australia': 'au', 'Canada': 'ca', 'Germany': 'de', 'India': 'in', 'France': 'fr',
  'Netherlands': 'nl', 'Poland': 'pl', 'Italy': 'it', 'Spain': 'es', 'Austria': 'at',
  'Switzerland': 'ch', 'Brazil': 'br', 'Mexico': 'mx', 'Singapore': 'sg', 'New Zealand': 'nz',
  'South Africa': 'za', 'Belgium': 'be',
}

function mapToAdzunaCountry(country) {
  return ADZUNA_COUNTRY_MAP[country] || null
}

const COUNTRY_CODE_MAP = {
  'United Kingdom': 'gb', 'UK': 'gb', 'Ireland': 'ie', 'United States': 'us', 'USA': 'us',
  'Australia': 'au', 'Canada': 'ca', 'Germany': 'de', 'India': 'in', 'France': 'fr',
  'Nigeria': 'ng', 'South Africa': 'za', 'Netherlands': 'nl', 'Singapore': 'sg',
  'New Zealand': 'nz', 'Brazil': 'br', 'Mexico': 'mx', 'Spain': 'es', 'Italy': 'it',
  'Kenya': 'ke', 'Ghana': 'gh', 'UAE': 'ae', 'United Arab Emirates': 'ae',
}

function countryToCode(countryName) {
  return COUNTRY_CODE_MAP[countryName] || null
}

module.exports = {
  getExchangeRate,
  getCountryData,
  getJobMarketData,
  mapToAdzunaCountry,
  countryToCode,
}
