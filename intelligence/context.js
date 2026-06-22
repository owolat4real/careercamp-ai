/**
 * ═══════════════════════════════════════════════════════════════════════
 * CONTEXT ENGINE — Assembles rich context for every inference request
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Before any LLM call, this engine:
 *   1. Injects temporal grounding (today's date, year, market context)
 *   2. Adds user career profile context (if provided)
 *   3. Fetches internet grounding (live job market, salary, company data)
 *   4. Adds country-specific office culture & salary norms
 *   5. Builds the full CSTM-1 system prompt for career intelligence
 */

'use strict';
const internet = require('../engine/internet');

// ── Career domain knowledge ────────────────────────────────
const COUNTRY_CAREER_CONTEXT = {
  nigeria: {
    currency: 'NGN (₦)',
    topIndustries: 'Fintech (Paystack, Flutterwave, Moniepoint), Telecom (MTN, Airtel), Oil & Gas, Consulting',
    salaryNote: 'Salaries in Lagos often 30-50% higher than other cities. Equity rare except at funded startups.',
    cultureTip: 'Relationship-building critical before business. Titles and seniority respected. WhatsApp used professionally.',
    platforms: 'LinkedIn, Jobberman, NgCareers, Andela Network, Hotnigerianjobs',
  },
  uk: {
    currency: 'GBP (£)',
    topIndustries: 'Finance/Fintech (London), Tech (London/Manchester/Edinburgh), NHS Digital, Consulting',
    salaryNote: 'London premium 20-40% vs rest of UK. IR35 affects contractors. Auto-enrolment pension.',
    cultureTip: 'Competency-based interviews. Understatement valued. Cover letter still important in traditional sectors.',
    platforms: 'LinkedIn, Glassdoor, Reed, TotalJobs, CV-Library, Tech Nation Jobs',
  },
  us: {
    currency: 'USD ($)',
    topIndustries: 'Big Tech (FAANG/MANGA), Finance (NYC), Healthcare Tech, Defence/Gov, Startups (SF/NYC/Austin)',
    salaryNote: 'Stock/RSU often 30-50% of total comp at big tech. Equity negotiation critical.',
    cultureTip: 'Direct, results-oriented. STAR method essential. References checked rigorously.',
    platforms: 'LinkedIn, Indeed, Glassdoor, Levels.fyi (for comp), AngelList (startups), Blind',
  },
  india: {
    currency: 'INR (₹)',
    topIndustries: 'IT Services (TCS, Infosys, Wipro), Startups (Bangalore/Hyderabad/Pune), BFSI, Consulting',
    salaryNote: 'CTC vs in-hand ratio important. Variable pay up to 20%. ESOP common at Series B+.',
    cultureTip: 'Hierarchy respected. Relationships matter. Long notice periods (60-90 days) common.',
    platforms: 'LinkedIn, Naukri, Indeed, Internshala (juniors), iimjobs (management)',
  },
  germany: {
    currency: 'EUR (€)',
    topIndustries: 'Automotive (BMW, VW, Mercedes), Engineering, Medtech, Chemical, Growing tech scene (Berlin)',
    salaryNote: 'Gross vs net: ~42% tax+social security. Betriebsrat (works council) has co-determination rights.',
    cultureTip: 'Formal until invited casual. Punctuality non-negotiable. PhD title matters in traditional sectors.',
    platforms: 'LinkedIn, XING, StepStone, Indeed, Glassdoor',
  },
};

function getCountryContext(country) {
  if (!country) return null;
  const key = Object.keys(COUNTRY_CAREER_CONTEXT).find(k =>
    country.toLowerCase().includes(k) || k.includes(country.toLowerCase().split(' ')[0])
  );
  return key ? COUNTRY_CAREER_CONTEXT[key] : null;
}

// ── System prompt builder ──────────────────────────────────
function buildSystemPrompt(userCtx = {}) {
  const { career, country, level, name, goals, skills } = userCtx;
  const countryData = getCountryContext(country);
  const today = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  let sys = `You are CSTM-1 — Career Studio Transformer Model v1.
You are powered by CareerCamp AI — the world's first dedicated career intelligence platform.
You have access to real-time internet data, computer vision, voice analysis, and BERT-based career NLP.

TODAY: ${today}
KNOWLEDGE: Always state "${new Date().getFullYear()}" data. Acknowledge uncertainty for post-2025 events.

## YOUR IDENTITY
- You are NOT a general assistant. You are a world-class career intelligence engine.
- You serve professionals in 196 countries across all industries and career levels.
- You speak with the authority of a 20-year career coach, senior recruiter, and salary negotiation expert combined.
- You give specific, actionable, culturally calibrated advice — never generic filler.`;

  if (name || career || country || level) {
    sys += `\n\n## USER PROFILE`;
    if (name)   sys += `\nName: ${name}`;
    if (career) sys += `\nCareer Field: ${career}`;
    if (country) sys += `\nLocation: ${country}`;
    if (level)  sys += `\nLevel: ${level}`;
    if (goals)  sys += `\nCareer Goals: ${goals}`;
    if (skills) sys += `\nKey Skills: ${skills}`;
    sys += `\n\nCalibrate ALL advice, salary data, and platform recommendations specifically for this person.`;
  }

  if (countryData) {
    sys += `\n\n## ${(country || '').toUpperCase()} MARKET INTELLIGENCE (verified)
Currency: ${countryData.currency}
Top Industries: ${countryData.topIndustries}
Salary Note: ${countryData.salaryNote}
Culture: ${countryData.cultureTip}
Best Platforms: ${countryData.platforms}`;
  }

  sys += `\n\n## RULES
1. Every salary must be in the user's local currency with (est.) or source citation.
2. Every company recommendation must be a REAL company operating in the user's country.
3. Every platform recommendation must be one the user can actually access in their country.
4. Flag knowledge gaps: [KNOWLEDGE GAP: Limited verified data for X — verify with local sources]
5. Never truncate — complete every section fully.
6. End every response with ⚡ Your Next 3 Actions (specific, executable, with timelines).`;

  return sys;
}

// ── Full context assembly ──────────────────────────────────
async function buildFullContext(prompt, userCtx = {}) {
  const sys      = buildSystemPrompt(userCtx);
  const internet_ctx = await internet.buildContextBlock(prompt, userCtx).catch(() => '');
  return sys + internet_ctx;
}

module.exports = {
  async init() { console.log('[ContextEngine] Career context engine ready'); },
  buildSystemPrompt,
  buildFullContext,
  getCountryContext,
  COUNTRY_CAREER_CONTEXT,
};
