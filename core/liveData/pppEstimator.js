'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * PPP-ADJUSTED ESTIMATE ENGINE — for the ~160 countries Adzuna doesn't
 * cover directly.
 *
 * careercamp-ai has no direct database access (it's a stateless LLM
 * gateway — see groundingLayer.js's HTTP-based country lookup instead
 * of a Mongoose require). This is a pure function: given a region and a
 * real baseline salary (fetched live from an Adzuna-covered country),
 * it computes a transparent, methodologically-labeled estimate. It
 * never invents a number from nothing — the baseline itself must
 * already be real.
 *
 * This is NOT a real PPP index (World Bank PPP data would be the gold
 * standard, and requires a paid/complex integration). It's the honest
 * free-tier version: a region-based cost-tier multiplier, clearly
 * labeled as an estimate, never presented as live.
 * ═══════════════════════════════════════════════════════════════════════ */

const REGION_COST_TIERS = {
  'Northern Europe': 0.95, 'Western Europe': 0.9, 'Southern Europe': 0.7,
  'Eastern Europe': 0.5, 'Central Europe': 0.55,
  'North America': 1.0, 'Central America': 0.4, 'Caribbean': 0.45,
  'South America': 0.45,
  'Australia and New Zealand': 0.9, 'Oceania': 0.55, 'Melanesia': 0.4,
  'Micronesia': 0.4, 'Polynesia': 0.4,
  'Eastern Asia': 0.65, 'South-Eastern Asia': 0.45, 'Southern Asia': 0.3,
  'Central Asia': 0.35, 'Western Asia': 0.55,
  'Northern Africa': 0.35, 'Western Africa': 0.3, 'Eastern Africa': 0.28,
  'Middle Africa': 0.3, 'Southern Africa': 0.4,
  // Coarser region names some sources use — kept for graceful fallback
  'Europe': 0.75, 'Asia': 0.45, 'Africa': 0.32,
}
const DEFAULT_COST_TIER = 0.5 // unknown region — conservative mid estimate, never a guess dressed as precision

function estimateSalaryViaPPP({ role, country, region, baselineCountry, baselineSalaryUSD }) {
  if (!baselineSalaryUSD || baselineSalaryUSD <= 0) {
    return { available: false, reason: 'No real baseline salary available to adjust from' }
  }

  const costMultiplier = REGION_COST_TIERS[region] ?? DEFAULT_COST_TIER
  const estimatedSalary = Math.round(baselineSalaryUSD * costMultiplier)

  return {
    available: true,
    estimatedSalaryUSD: estimatedSalary,
    estimatedSalaryMaxUSD: Math.round(estimatedSalary * 1.4),
    costMultiplier,
    methodology: `Region-based cost-tier adjustment (${region || 'unknown region'}, ${costMultiplier}x) `
      + `from a real ${baselineCountry || 'UK'} baseline of $${baselineSalaryUSD.toLocaleString()} USD`,
    confidence: 'estimated', // NEVER labeled as live/verified
    warning: `This is a computed estimate for ${role || 'this role'} in ${country || 'this country'}, `
      + `not live market data — ${country || 'this country'} doesn't have direct job-market coverage yet. `
      + `For countries with direct data coverage, live figures are used instead.`,
  }
}

module.exports = { estimateSalaryViaPPP, REGION_COST_TIERS, DEFAULT_COST_TIER }
