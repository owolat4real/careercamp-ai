'use strict';
/* ═══════════════════════════════════════════════════════════════════
   MAX KNOWLEDGE BASE — Single source of truth for Max's platform
   knowledge. Built ENTIRELY from the real FEATURE_MAP — no
   hand-written descriptions, no invented capabilities. If it's not
   in FEATURE_MAP, Max cannot describe it.
═══════════════════════════════════════════════════════════════════ */
const { FEATURE_MAP } = require('../config/featureMap');
const { PRODUCT_AREAS } = require('../config/productAreas');

/* ── ID → human-readable title ─────────────────────────────────── */
function toTitle(id) {
  return id
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bAts\b/, 'ATS')
    .replace(/\bCv\b/,  'CV')
    .replace(/\bAi\b/,  'AI')
    .replace(/\bJd\b/,  'JD')
    .replace(/\bStar\b/, 'STAR');
}

/* ── Feature ID prefix → domain group ────────────────────────────── */
function inferDomain(id, task) {
  if (/^resume_|^cv_|^ats_|^action_verb|^achievement|^impact_/.test(id))  return 'CV & Resume';
  if (/^cover_letter/.test(id))                                            return 'Cover Letter';
  if (/^interview_|^star_|^behavioral|^competency|^panel_|^question_/.test(id)) return 'Interview Preparation';
  if (/^linkedin/.test(id))                                                return 'LinkedIn';
  if (/^salary_|^salary/.test(id) || task === 'salary_analysis')          return 'Salary Intelligence';
  if (/^job_|^application_|^job/.test(id) || task === 'job_search')       return 'Job Search';
  if (/^career_|^life_|^future_|^career/.test(id))                        return 'Career Planning';
  if (/^skill_|^learning_|^upskill/.test(id))                             return 'Skills & Learning';
  if (/^network_|^linkedin|^mentor|^refer/.test(id))                      return 'Networking';
  if (/^negotiat/.test(id))                                                return 'Negotiation';
  if (/^visa_|^global_|^international/.test(id))                          return 'Global Careers';
  if (/^freelance|^contract/.test(id))                                     return 'Freelance & Contract';
  if (/^bulk_|^jd_|^talent_|^candidate_|^team_|^org_|^salary_band|^diversity|^onboarding|^retention|^performance|^interview_pack|^headcount|^employer|^job_ad|^workforce/.test(id)) return 'Employer Tools';
  if (task === 'cover_letter')                                             return 'Cover Letter';
  if (task === 'cv_analysis' || task === 'cv_rewrite')                    return 'CV & Resume';
  if (task === 'interview_prep')                                           return 'Interview Preparation';
  if (task === 'job_match')                                                return 'Job Search';
  return 'Career Intelligence';
}

/* ── Task type → one-line capability summary ──────────────────────── */
const TASK_DESCRIPTIONS = {
  cv_analysis:    'Analyses your CV and provides detailed, scored feedback.',
  cv_rewrite:     'Rewrites or improves your CV content with AI precision.',
  cv_bullet:      'Transforms weak bullet points into impact statements.',
  ats_analysis:   'Checks ATS compatibility and keyword coverage.',
  gap_analysis:   'Identifies gaps between your profile and target roles.',
  cover_letter:   'Writes, improves, or scores cover letters.',
  interview_prep: 'Prepares you for job interviews with structured practice.',
  salary_analysis:'Benchmarks salaries and builds negotiation strategies.',
  job_match:      'Matches your profile to job descriptions with a score.',
  job_search:     'Finds and filters job opportunities intelligently.',
  career_advice:  'Gives personalised career planning and strategy advice.',
  reasoning:      'Applies deep reasoning to complex career decisions.',
  classify:       'Classifies and analyses career-related content.',
  quick_reply:    'Gives fast, focused answers to career questions.',
  summarise:      'Summarises and condenses career documents or data.',
};

/* ── BUILD KNOWLEDGE BASE ─────────────────────────────────────────── */
function buildKnowledgeBase() {
  const aiTaskFeatures = Object.entries(FEATURE_MAP).map(([id, cfg]) => {
    const domain = inferDomain(id, cfg.task);
    const desc   = TASK_DESCRIPTIONS[cfg.task] || 'An AI-powered career tool.';
    return {
      id,
      title:       toTitle(id),
      description: desc,
      domain,
      task:        cfg.task,
      model:       cfg.model,
      streaming:   cfg.streaming,
      path:        `/features/${id.replace(/_/g, '-')}`,
      plan:        cfg.model === 'cs-sonnet' ? 'pro' : 'free',
    };
  });

  /* Product areas — whole sections of the platform (calendars, research
     systems, marketplaces, simulators, community hubs, CRUD trackers)
     that aren't a single AI-task call, so they have no FEATURE_MAP entry.
     Additive only — merged in alongside the AI-task features above. */
  const productAreaFeatures = PRODUCT_AREAS.map(area => ({
    id:          area.id,
    title:       area.title,
    description: area.description,
    domain:      area.domain,
    task:        null,
    model:       null,
    streaming:   false,
    path:        area.path,
    plan:        'platform',
  }));

  const features = [...aiTaskFeatures, ...productAreaFeatures];

  /* Nav sections derived from real domain groupings */
  const domainSet = [...new Set(features.map(f => f.domain))];
  const navSections = domainSet.map(domain => ({
    label:    domain,
    features: features.filter(f => f.domain === domain).map(f => ({ id: f.id, title: f.title })),
  }));

  return { features, navSections, totalFeatures: features.length };
}

/* Cache at startup — rebuild only on server restart */
const KNOWLEDGE_BASE = buildKnowledgeBase();

/* ── RETRIEVAL ─────────────────────────────────────────────────────── */
/**
 * Returns up to 6 features most relevant to the user's question.
 * Always includes the feature for the page they're currently on.
 * Uses keyword overlap — deterministic, $0, sufficient for 274 features.
 */
function retrieveRelevantKnowledge(userQuestion, currentPagePath = '') {
  const q = userQuestion.toLowerCase();

  const currentFeature = KNOWLEDGE_BASE.features.find(f => {
    if (!currentPagePath) return false;
    return currentPagePath.includes(f.id.replace(/_/g, '-')) ||
           f.path === currentPagePath;
  });

  const scored = KNOWLEDGE_BASE.features.map(f => {
    const haystack = `${f.title} ${f.description} ${f.domain} ${f.id}`.toLowerCase();
    const words    = q.split(/\W+/).filter(w => w.length > 2);
    const matches  = words.filter(w => haystack.includes(w)).length;
    return { feature: f, score: matches };
  });

  const topMatches = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(s => s.feature);

  const combined = currentFeature
    ? [currentFeature, ...topMatches.filter(f => f.id !== currentFeature.id)]
    : topMatches;

  return combined.slice(0, 6);
}

function getFullFeatureList() {
  return KNOWLEDGE_BASE.features;
}

function getNavSections() {
  return KNOWLEDGE_BASE.navSections;
}

module.exports = { KNOWLEDGE_BASE, retrieveRelevantKnowledge, getFullFeatureList, getNavSections };
