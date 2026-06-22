/**
 * ═══════════════════════════════════════════════════════════════════════
 * INTERNET CONTEXT ENGINE — Real-Time Grounding for CareerCamp AI
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Gives CareerCamp AI real-time internet awareness:
 *   • Job market trends (real-time)
 *   • Company news and hiring signals
 *   • Salary benchmarks (live)
 *   • Skills demand (from job postings)
 *   • Career news and industry updates
 *
 * Sources (priority order):
 *   1. Brave Search API    — real-time web index
 *   2. Tavily API          — AI-optimised RAG search
 *   3. SerpAPI             — Google results
 *   4. DuckDuckGo scraper  — no-auth fallback
 *   5. Apify actors        — LinkedIn, Glassdoor, Indeed
 */

'use strict';
const axios = require('axios');

const BRAVE_KEY   = process.env.BRAVE_SEARCH_API_KEY    || '';
const TAVILY_KEY  = process.env.TAVILY_API_KEY           || '';
const SERP_KEY    = process.env.SERPAPI_KEY              || '';
const HF_TOKEN    = process.env.HF_TOKEN                 || '';

// ── Brave Search ───────────────────────────────────────────
async function braveSearch(query, opts = {}) {
  if (!BRAVE_KEY || BRAVE_KEY.includes('your-') || BRAVE_KEY.includes('BSA-your')) return null;
  const r = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count: opts.count || 5, freshness: opts.freshness || 'pm' },
    headers: { 'X-Subscription-Token': BRAVE_KEY, 'Accept': 'application/json' },
    timeout: 8000,
  });
  return (r.data?.web?.results || []).map(x => ({
    title:   x.title   || '',
    url:     x.url     || '',
    snippet: x.description || '',
    published: x.age   || '',
  }));
}

// ── Tavily Search ──────────────────────────────────────────
async function tavilySearch(query, opts = {}) {
  if (!TAVILY_KEY || TAVILY_KEY.includes('your-') || TAVILY_KEY.includes('tvly-dev')) return null;
  const r = await axios.post('https://api.tavily.com/search', {
    api_key:        TAVILY_KEY,
    query,
    search_depth:   opts.deep ? 'advanced' : 'basic',
    include_answer: true,
    max_results:    opts.count || 5,
  }, { timeout: 10000 });
  return {
    answer:  r.data?.answer || '',
    results: (r.data?.results || []).map(x => ({
      title:   x.title   || '',
      url:     x.url     || '',
      snippet: x.content || '',
      score:   x.score   || 0,
    })),
  };
}

// ── DuckDuckGo instant answer (no-auth) ────────────────────
async function duckDuckGoSearch(query) {
  try {
    const r = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_redirect: 1, no_html: 1, skip_disambig: 1 },
      timeout: 8000,
    });
    const data = r.data;
    const results = [];
    if (data.AbstractText) results.push({ title: data.Heading, url: data.AbstractURL, snippet: data.AbstractText });
    (data.RelatedTopics || []).slice(0, 4).forEach(t => {
      if (t.Text) results.push({ title: t.Text.split(' - ')[0], url: t.FirstURL || '', snippet: t.Text });
    });
    return results;
  } catch (_) { return []; }
}

// ── Unified search (waterfall) ─────────────────────────────
async function search(query, opts = {}) {
  // Try Tavily first (gives synthesised answers)
  const tv = await tavilySearch(query, opts).catch(() => null);
  if (tv && tv.results?.length) {
    return {
      answer:   tv.answer,
      results:  tv.results,
      provider: 'tavily',
      query,
    };
  }

  // Try Brave
  const br = await braveSearch(query, opts).catch(() => null);
  if (br && br.length) {
    return { results: br, provider: 'brave', query };
  }

  // DuckDuckGo fallback (always available)
  const ddg = await duckDuckGoSearch(query);
  return { results: ddg, provider: 'duckduckgo', query };
}

// ── Career-specific grounded queries ──────────────────────
async function getJobMarketTrends(career, country = 'global') {
  const query = `${career} job market demand trends ${country} ${new Date().getFullYear()}`;
  const { results, answer } = await search(query, { count: 5, deep: true });
  return { career, country, trends: answer || results?.[0]?.snippet || '', sources: results?.slice(0,3) };
}

async function getLiveSalaryData(role, location) {
  const query = `${role} salary ${location} ${new Date().getFullYear()} average compensation`;
  const { results, answer } = await search(query, { count: 5 });
  const salaryPatterns = results?.map(r => {
    const match = (r.snippet + r.title).match(/\$[\d,]+(?:k)?(?:\s*[–-]\s*\$[\d,]+k?)?|\d+k(?:\s*[–-]\s*\d+k)?/gi);
    return match || [];
  }).flat() || [];
  return {
    role, location,
    rawData:       answer || results?.[0]?.snippet || '',
    mentionedRanges: salaryPatterns.slice(0, 5),
    sources:       results?.slice(0,3) || [],
  };
}

async function getCompanyNews(company) {
  const query = `"${company}" news hiring layoffs funding ${new Date().getFullYear()}`;
  const { results } = await search(query, { count: 5, freshness: 'pw' });
  return { company, news: results || [] };
}

async function getSkillsDemand(skills, country = 'global') {
  const query = `most in-demand tech skills ${skills.slice(0,3).join(' ')} ${country} ${new Date().getFullYear()}`;
  const { results, answer } = await search(query, { count: 5 });
  return { skills, country, demand: answer || results?.[0]?.snippet || '', sources: results?.slice(0,2) };
}

async function getIndustryNews(industry, country = 'global') {
  const query = `${industry} industry news career ${country} ${new Date().getFullYear()}`;
  const { results } = await search(query, { count: 6, freshness: 'pw' });
  return { industry, country, articles: results || [] };
}

// ── Context block generator for LLM prompts ───────────────
async function buildContextBlock(prompt, ctx = {}) {
  const parts = [];
  const { career, country, skills } = ctx;
  const today = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  parts.push(`[TEMPORAL GROUNDING] Today is ${today}. All advice should reflect ${new Date().getFullYear()} market conditions.`);

  // Job market context if career provided
  if (career) {
    const trends = await getJobMarketTrends(career, country || 'global').catch(() => null);
    if (trends?.trends) {
      parts.push(`[LIVE JOB MARKET — ${career} in ${country || 'global'}]\n${trends.trends}`);
    }
  }

  // Salary data if salary-related prompt
  if (career && /salary|compens|pay|wage|earn|rate/i.test(prompt)) {
    const salData = await getLiveSalaryData(career, country || 'global').catch(() => null);
    if (salData?.rawData) {
      parts.push(`[LIVE SALARY DATA — ${career} in ${country || 'global'}]\n${salData.rawData}\nRanges mentioned: ${salData.mentionedRanges.join(', ')}`);
    }
  }

  // Skills demand if skills-related prompt
  if (skills?.length && /skill|learn|trending|demand/i.test(prompt)) {
    const demand = await getSkillsDemand(skills, country || 'global').catch(() => null);
    if (demand?.demand) {
      parts.push(`[LIVE SKILLS DEMAND]\n${demand.demand}`);
    }
  }

  return parts.length > 1 ? '\n\n' + parts.join('\n\n') + '\n\n' : '\n\n' + parts[0] + '\n\n';
}

module.exports = {
  async init() {
    const hasKeys = (BRAVE_KEY && !BRAVE_KEY.includes('your-')) ||
                    (TAVILY_KEY && !TAVILY_KEY.includes('your-'));
    console.log(`[InternetEngine] Search: ${hasKeys ? 'Brave/Tavily configured' : 'DuckDuckGo fallback (add BRAVE_SEARCH_API_KEY)'}`);
  },
  status: () => ({
    brave:        !!(BRAVE_KEY && !BRAVE_KEY.includes('your-')),
    tavily:       !!(TAVILY_KEY && !TAVILY_KEY.includes('your-')),
    duckduckgo:   true, // always available
  }),
  search,
  getJobMarketTrends,
  getLiveSalaryData,
  getCompanyNews,
  getSkillsDemand,
  getIndustryNews,
  buildContextBlock,
};
