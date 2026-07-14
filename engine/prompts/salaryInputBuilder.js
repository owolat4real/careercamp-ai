'use strict'

/* ═══════════════════════════════════════════════════════════════════════
 * SALARY INPUT BUILDER
 * Extracts maximum context from the user's raw salary question and
 * structures it so cs-sonnet has everything it needs to fill in
 * the SIPS (Structured Intelligence Prompt System) template.
 *
 * The more context extracted here, the less the model needs to guess,
 * and the lower the hallucination risk.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Build a structured user prompt for the salary intelligence system.
 * @param {string} userInput        — the raw user query
 * @param {object} careerContext    — optional structured context from app
 * @returns {string}                — enriched prompt ready for the model
 */
function buildSalaryUserPrompt(userInput, careerContext = {}) {
  const role     = careerContext.targetRole    || careerContext.role    || extractRole(userInput)
  const country  = careerContext.country                                || extractCountry(userInput)
  const city     = careerContext.city                                   || extractCity(userInput)
  const years    = careerContext.yearsExp      || careerContext.years   || extractYears(userInput)
  // Only use profile skills that are explicitly mentioned in this salary query —
  // prevents QA/tech skills from a user's profile bleeding into a Finance & Accounting salary report.
  const rawSkills   = careerContext.skills ? filterSkillsToQuery(careerContext.skills, userInput) : null
  const skills      = rawSkills?.length ? rawSkills : extractSkills(userInput)
  const current  = careerContext.currentSalary || careerContext.salary  || extractSalary(userInput)
  const sector   = careerContext.sector        || careerContext.industry || extractSector(userInput)
  const employer = careerContext.employerType  || careerContext.employer || null
  const currency = getCurrencyForCountry(country)

  const locationStr = [city, country].filter(Boolean).join(', ') || 'Not specified'
  const yearsStr    = years ? `${years} year${years === 1 ? '' : 's'}` : null
  const levelStr    = getExperienceLevel(years)
  const skillsStr   = skills?.length ? skills.join(', ') : null

  return `SALARY INTELLIGENCE REQUEST
════════════════════════════════════

USER QUERY: "${userInput}"

EXTRACTED CONTEXT:
─────────────────
Role:            ${role           || 'Not specified — use best inference from the query'}
Location:        ${locationStr}
Experience:      ${yearsStr       || 'Not specified — assume mid-level (5-8 years)'}
Experience level: ${levelStr}
Current salary:  ${current        ? formatSalary(current, currency) : 'Not disclosed'}
Key skills:      ${skillsStr      || 'Not specified — infer from role or ask'}
Sector/Industry: ${sector         || 'Infer from role context'}
Employer type:   ${employer       || 'Not specified'}
Currency to use: ${currency} — USE THIS CURRENCY THROUGHOUT. Do not switch to USD.

─────────────────
INSTRUCTIONS FOR THIS RESPONSE:
─────────────────
1. Fill in EVERY section of the salary report template above.
   Do not skip or merge any section.

2. Use ${country || 'the user\'s country'} salary data throughout.
   ${country === 'Canada'  ? 'Use CAD$. Reference Statistics Canada and Canadian construction/sector norms.' : ''}
   ${country === 'United Kingdom' ? 'Use GBP £. Reference UK ONS salary data ranges and sector norms.' : ''}
   ${country === 'Nigeria' ? 'Use NGN ₦ with USD equivalent. Reflect Lagos vs Abuja salary realities.' : ''}
   ${!country ? 'If you cannot determine the country, ask before guessing — or use USD and tag everything [ESTIMATED].' : ''}

3. If you are uncertain about any figure, tag it [ESTIMATED].
   Never invent a number you are not confident about.
   It is always better to say "I estimate approximately X [ESTIMATED]"
   than to state a confident-sounding wrong number.

4. The negotiation script must be word-for-word usable by someone
   copy-pasting it into a real salary conversation. Not a framework.
   Real sentences. Real numbers. Real specificity.

5. Minimum output: 800 words across all sections combined.

6. Every salary table must have at least 4 rows with specific figures.

7. Numbered lists must NOT restart from 1 mid-response.
   Continue numbering across list breaks.

8. The skill premiums table must have at least 5 rows with £/$
   amounts or percentages — not vague descriptions.

9. The last section (Next 3 Actions) must have exactly 3 actions,
   each with a specific timeframe and measurable outcome.

10. End every response with the Data Confidence Summary table.

${!role && !city && !country ? `
⚠️ IMPORTANT: The user's question lacks specific role/location data.
Before writing the full report, output ONE clarifying question:
"To give you the most accurate salary data, could you confirm:
[role title] and [city/country]?"
Then immediately provide the best estimate you can with [ESTIMATED] tags.
Do NOT refuse to answer — give the estimate AND ask for more context.
` : ''}

${current ? `
CONTEXT NOTE: The user mentioned a current or reference salary of
approximately ${formatSalary(current, currency)}. Factor this into your analysis:
- Is this above, at, or below the market median for this role?
- State explicitly whether they are underpaid, at market, or above market.
- This affects the negotiation strategy — address it directly.
` : ''}`
}

/* ── CONTEXT EXTRACTORS ───────────────────────────────────────────── */

function extractRole(text) {
  if (!text) return null
  const rolePatterns = [
    /* Seniority + role title */
    /\b(?:senior|junior|mid[\s-]?level|lead|principal|staff|associate|head\s+of|director\s+of|vp\s+of)\s+[\w\s]{3,40}?(?=\s+(?:in|at|for|salary|pay|earn|make|how\s+much)|[?.,]|$)/i,
    /* Role title standalone */
    /\b(?:[\w\s]{3,40}?)?\b(?:engineer|manager|developer|analyst|designer|consultant|architect|officer|specialist|coordinator|administrator|director|supervisor|superintendent|foreman|estimator|planner|scheduler)\b/i,
    /* Construction-specific */
    /\b(?:construction|site|project|quantity|civil|structural|mechanical|electrical|hvac|plumbing)\s+(?:manager|engineer|supervisor|estimator|coordinator|foreman|superintendent)\b/i,
  ]
  for (const p of rolePatterns) {
    const m = text.match(p)
    if (m && m[0].trim().length > 4) return m[0].trim()
  }
  return null
}

function extractCountry(text) {
  if (!text) return null
  const countryMap = {
    /* Canada */
    'canada': 'Canada', 'canadian': 'Canada',
    'ontario': 'Canada', 'british columbia': 'Canada', 'alberta': 'Canada',
    'quebec': 'Canada', 'manitoba': 'Canada', 'saskatchewan': 'Canada',
    'nova scotia': 'Canada', 'new brunswick': 'Canada', 'pei': 'Canada',
    'toronto': 'Canada', 'vancouver': 'Canada', 'calgary': 'Canada',
    'edmonton': 'Canada', 'ottawa': 'Canada', 'montreal': 'Canada',
    'winnipeg': 'Canada', 'halifax': 'Canada',
    /* United Kingdom */
    'uk': 'United Kingdom', 'u.k.': 'United Kingdom',
    'britain': 'United Kingdom', 'great britain': 'United Kingdom',
    'england': 'United Kingdom', 'scotland': 'United Kingdom',
    'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
    'london': 'United Kingdom', 'manchester': 'United Kingdom',
    'birmingham': 'United Kingdom', 'edinburgh': 'United Kingdom',
    'glasgow': 'United Kingdom', 'leeds': 'United Kingdom',
    'bristol': 'United Kingdom', 'liverpool': 'United Kingdom',
    /* Ireland */
    'ireland': 'Ireland', 'irish': 'Ireland',
    'dublin': 'Ireland', 'cork': 'Ireland', 'galway': 'Ireland',
    /* Nigeria */
    'nigeria': 'Nigeria', 'nigerian': 'Nigeria',
    'lagos': 'Nigeria', 'abuja': 'Nigeria', 'port harcourt': 'Nigeria',
    'ibadan': 'Nigeria', 'kano': 'Nigeria',
    /* USA */
    'usa': 'United States', 'us ': 'United States', 'u.s.': 'United States',
    'america': 'United States', 'american': 'United States',
    'new york': 'United States', 'san francisco': 'United States',
    'seattle': 'United States', 'austin': 'United States',
    'chicago': 'United States', 'boston': 'United States',
    /* Australia */
    'australia': 'Australia', 'australian': 'Australia',
    'sydney': 'Australia', 'melbourne': 'Australia',
    'brisbane': 'Australia', 'perth': 'Australia',
    /* Germany */
    'germany': 'Germany', 'german': 'Germany',
    'berlin': 'Germany', 'munich': 'Germany', 'frankfurt': 'Germany',
    /* India */
    'india': 'India', 'indian': 'India',
    'bangalore': 'India', 'bengaluru': 'India',
    'mumbai': 'India', 'delhi': 'India', 'hyderabad': 'India',
    /* UAE */
    'uae': 'UAE', 'dubai': 'UAE', 'abu dhabi': 'UAE',
    /* South Africa */
    'south africa': 'South Africa', 'johannesburg': 'South Africa',
    'cape town': 'South Africa', 'durban': 'South Africa',
    /* Singapore */
    'singapore': 'Singapore',
    /* Kenya */
    'kenya': 'Kenya', 'nairobi': 'Kenya',
    /* Ghana */
    'ghana': 'Ghana', 'accra': 'Ghana',
  }
  const lower = text.toLowerCase()
  for (const [key, country] of Object.entries(countryMap)) {
    if (lower.includes(key)) return country
  }
  return null
}

function extractCity(text) {
  if (!text) return null
  const cities = [
    /* Canada */
    'Toronto','Vancouver','Calgary','Edmonton','Ottawa','Montreal',
    'Winnipeg','Halifax','Quebec City','Saskatoon','Regina','Victoria',
    /* UK */
    'London','Manchester','Birmingham','Edinburgh','Glasgow','Leeds',
    'Bristol','Liverpool','Sheffield','Cardiff','Belfast','Nottingham',
    /* Ireland */
    'Dublin','Cork','Galway','Limerick','Waterford',
    /* Nigeria */
    'Lagos','Abuja','Port Harcourt','Ibadan','Kano','Benin City',
    /* USA */
    'New York','San Francisco','Seattle','Austin','Chicago',
    'Boston','Los Angeles','Houston','Dallas','Denver','Atlanta',
    /* Australia */
    'Sydney','Melbourne','Brisbane','Perth','Adelaide',
    /* Germany */
    'Berlin','Munich','Frankfurt','Hamburg','Cologne','Stuttgart',
    /* India */
    'Bangalore','Bengaluru','Mumbai','Delhi','Hyderabad','Chennai','Pune',
    /* UAE */
    'Dubai','Abu Dhabi',
    /* South Africa */
    'Johannesburg','Cape Town','Durban','Pretoria',
    /* Other */
    'Singapore','Nairobi','Accra',
  ]
  const lower = text.toLowerCase()
  for (const city of cities) {
    if (lower.includes(city.toLowerCase())) return city
  }
  return null
}

function extractYears(text) {
  if (!text) return null
  const patterns = [
    /(\d+)\s*\+?\s*years?\s*(?:of\s+)?(?:experience|exp|in\s+the\s+field)?/i,
    /(\d+)\s*yr?s?\.?\s*(?:exp|experience)/i,
    /(?:experienced?|experienced?)\s+(?:with\s+)?(\d+)/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) return parseInt(m[1])
  }
  return null
}

function extractSkills(text) {
  if (!text) return []
  const techSkills = [
    /* Tech */
    'Python','JavaScript','TypeScript','React','Node.js','Vue','Angular',
    'AWS','Azure','GCP','Kubernetes','Docker','Terraform','CI/CD',
    'SQL','PostgreSQL','MongoDB','Redis','Elasticsearch','dbt',
    'Spark','Snowflake','Tableau','Power BI','MATLAB','R',
    /* Engineering */
    'AutoCAD','Revit','BIM','Primavera P6','MS Project','Procore',
    'SolidWorks','CATIA','ANSYS','Navisworks','SketchUp','SAP2000',
    /* Management/Finance */
    'PMP','PMI','PRINCE2','Lean','Six Sigma','Agile','Scrum',
    'Salesforce','SAP','Oracle','HubSpot','JIRA','Confluence',
    /* Certifications */
    'CPA','CFA','ACCA','CIMA','MBA','MSc',
    'NEBOSH','IOSH','RICS','CIOB','ICE','RIBA',
    /* Design */
    'Figma','Sketch','Adobe XD','Illustrator','Photoshop',
    /* Data */
    'Machine Learning','Deep Learning','TensorFlow','PyTorch','NLP',
  ]
  const lower = text.toLowerCase()
  return techSkills.filter(s => lower.includes(s.toLowerCase()))
}

function extractSalary(text) {
  if (!text) return null
  const patterns = [
    /* £80,000 or £80k */
    /[£$€₦₹]([\d,]+)\s*k?\b/i,
    /* 80000 CAD or 80k USD */
    /([\d,]+)\s*k?\s*(?:CAD|GBP|USD|EUR|NGN|AUD|INR|SGD|AED|ZAR|KES)/i,
    /* 80,000 per year */
    /([\d,]+)\s*(?:per\s+year|\/yr|\/year|pa\.?|annual(?:ly)?)/i,
    /* currently earning 80000 */
    /(?:earn(?:ing)?|mak(?:ing)?|paid?|salary(?:\s+of)?|making?)\s+[£$€₦₹]?\s*([\d,]+)\s*k?/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) {
      const raw = parseInt(m[1].replace(/,/g, ''))
      /* Normalise: treat numbers under 500 as thousands (80 → 80000) */
      return raw < 500 ? raw * 1000 : raw
    }
  }
  return null
}

function extractSector(text) {
  if (!text) return null
  const sectorMap = {
    'construction': 'Construction',
    'civil engineering': 'Civil Engineering',
    'infrastructure': 'Infrastructure',
    'real estate': 'Real Estate',
    'property': 'Property',
    'software': 'Technology', 'tech': 'Technology',
    'engineering': 'Engineering',
    'finance': 'Finance', 'banking': 'Finance',
    'fintech': 'Fintech', 'financial services': 'Financial Services',
    'healthcare': 'Healthcare', 'medical': 'Healthcare', 'nhs': 'Healthcare',
    'pharmaceutical': 'Pharmaceuticals',
    'marketing': 'Marketing',
    'sales': 'Sales',
    'data': 'Data & Analytics', 'analytics': 'Data & Analytics',
    'design': 'Design', 'ux': 'Design', 'ui': 'Design',
    'legal': 'Legal', 'law': 'Legal',
    'education': 'Education', 'teaching': 'Education', 'school': 'Education',
    'government': 'Public Sector', 'civil service': 'Public Sector',
    'energy': 'Energy', 'oil': 'Oil & Gas', 'gas': 'Oil & Gas',
    'mining': 'Mining',
    'retail': 'Retail',
    'logistics': 'Logistics', 'supply chain': 'Supply Chain',
    'manufacturing': 'Manufacturing',
    'consulting': 'Consulting', 'consultancy': 'Consulting',
  }
  const lower = text.toLowerCase()
  for (const [key, sector] of Object.entries(sectorMap)) {
    if (lower.includes(key)) return sector
  }
  return null
}

/* ── SKILL RELEVANCE FILTER ──────────────────────────────────────── */

/**
 * Drop profile skills that aren't explicitly mentioned in the salary query.
 * If a user's profile has Python/JS/SQL but they're asking about a Finance &
 * Accounting role, those skills must not be passed to the salary prompt —
 * the model will price the wrong person.
 *
 * Only skills that appear verbatim in the user's query survive this filter,
 * ensuring the salary report is about the role the user is actually asking
 * about, not the role stored in their profile.
 */
function filterSkillsToQuery(profileSkills, userInput) {
  if (!profileSkills?.length || !userInput) return []
  const lower = userInput.toLowerCase()
  return profileSkills.filter(s => lower.includes(s.toLowerCase()))
}

/* ── HELPERS ──────────────────────────────────────────────────────── */

function getCurrencyForCountry(country) {
  const map = {
    'Canada': 'CAD $',
    'United Kingdom': 'GBP £',
    'Ireland': 'EUR €',
    'United States': 'USD $',
    'Nigeria': 'NGN ₦',
    'Germany': 'EUR €',
    'Australia': 'AUD $',
    'India': 'INR ₹',
    'UAE': 'AED',
    'South Africa': 'ZAR R',
    'Kenya': 'KES',
    'Singapore': 'SGD $',
    'Ghana': 'GHS',
  }
  return map[country] || 'USD $ (assumed — please confirm your country)'
}

function getExperienceLevel(years) {
  if (!years) return 'Mid-level assumed (5-8 years) — not specified'
  if (years < 2)  return `Junior / Entry-level (${years} yr)`
  if (years < 5)  return `Early-mid (${years} yrs)`
  if (years < 10) return `Mid-to-senior (${years} yrs)`
  if (years < 15) return `Senior (${years} yrs)`
  return `Director / Principal level (${years} yrs)`
}

function formatSalary(amount, currency) {
  if (!amount) return 'unknown'
  const sym = currency?.split(' ')[1] || '$'
  return `${sym}${amount.toLocaleString()}`
}

module.exports = {
  buildSalaryUserPrompt,
  filterSkillsToQuery,
  extractRole,
  extractCountry,
  extractCity,
  extractYears,
  extractSkills,
  extractSalary,
  extractSector,
  getCurrencyForCountry,
  getExperienceLevel,
}
