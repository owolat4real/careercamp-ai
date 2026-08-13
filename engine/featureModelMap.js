'use strict';
/**
 * featureModelMap.js — Single source of truth for feature-to-tier routing.
 *
 * Derived from the ground-truth feature registry in config/featureMap.js —
 * never invented. Adds the tier abstraction layer on top so routing logic
 * references stable tier names (careerlm-nano / fast / base / long / deep)
 * rather than raw model names that could change.
 *
 * Tier hierarchy (real numCtx values below, corrected 2026-08-11 — see
 * that date's comment on TIER_CONFIG for why these numbers changed):
 *   careerlm-nano   Classifiers, yes/no, single-value outputs    cs-haiku   2K ctx
 *   careerlm-fast   Short structured output, headlines, snippets  cs-haiku   2K ctx
 *   careerlm-base   Long-form reasoning, standard career tasks    cs-sonnet  4K ctx
 *   careerlm-long   Document/contract analysis, full CV rewrites  cs-sonnet  4K ctx (name is real but honest: see note below)
 *   careerlm-deep   Reserved — deep multi-factor analysis         cs-opus    8K ctx
 *
 * Fallback order (all tiers, all the time):
 *   Ollama (tier-appropriate model + exact GPU layers)
 *     → Groq free pool
 *     → OpenRouter free pool
 *     → [paid providers if FREE_ONLY_MODE=false]
 *     → offlineResponder (guaranteed non-blank)
 */

const { FEATURE_MAP } = require('../config/featureMap');

/* ── TIER CONFIG ─────────────────────────────────────────────────────────
   ollamaModel: the Ollama model name to call
   numCtx:      context window to allocate (input + KV cache budget)
   maxOut:      hard cap on output tokens for this tier
   gpuTier:     passed to gpuScheduler for concurrency slot management

   Real, live-caught bug (2026-08-11): these numCtx values didn't match
   what's actually baked into the real deployed Modelfiles (cs_fixed/
   models/Modelfile.cs-haiku/-sonnet/-opus). num_ctx is sent as a real
   per-request Ollama option (see routes/camp.js's callOllama/streamLocal),
   so every real request on every tier was asking Ollama to allocate a
   bigger KV cache than the Modelfile's own deliberately-tuned ceiling
   (chosen specifically to leave headroom for cs-sonnet/haiku/opus/embed/
   vision/Chatterbox to coexist on the real, single 24GB A5000 card this
   platform actually runs on — see Modelfile.cs-opus's own 2026-08-08
   production-OOM correction). Aligned every tier down to the real,
   currently-deployed ceiling. Real, honest consequence worth knowing:
   careerlm-long's whole premise (131K ctx for long documents) is NOT
   currently deliverable by the real deployed cs-sonnet model (real
   ceiling 4K) -- the tier is kept (so long-document features still route
   to cs-sonnet, still get whatever real headroom 4K gives vs nano/fast's
   2K) but the number is now honest rather than a value that was never
   actually achievable on this hardware. Closing that gap for real needs
   either a genuinely bigger-context model or more VRAM, not a bigger
   number in this file -- see the real GPU-capacity findings elsewhere. */
const TIER_CONFIG = {
  'careerlm-nano': { ollamaModel: 'cs-haiku',  numCtx: 2048, maxOut:  512, gpuTier: 'haiku' },
  'careerlm-fast': { ollamaModel: 'cs-haiku',  numCtx: 2048, maxOut: 1024, gpuTier: 'haiku' },
  'careerlm-base': { ollamaModel: 'cs-sonnet', numCtx: 4096, maxOut: 4096, gpuTier: 'sonnet' },
  'careerlm-long': { ollamaModel: 'cs-sonnet', numCtx: 4096, maxOut: 4096, gpuTier: 'sonnet' },
  'careerlm-deep': { ollamaModel: 'cs-opus',   numCtx: 8192, maxOut: 4096, gpuTier: 'opus'   },
};

/* ── LONG-CONTEXT OVERRIDES ──────────────────────────────────────────────
   Features that consume long input documents — classified as careerlm-long
   even though their underlying model is cs-sonnet. Real, current caveat:
   both careerlm-base and careerlm-long now share the same real 4096
   numCtx ceiling (see the honest note on TIER_CONFIG above) -- the real
   benefit these features still get from this classification is a
   dedicated maxOut budget and gpuTier accounting, not a bigger real
   context window, until the model/hardware question above is resolved.   */
const LONG_CTX_FEATURES = new Set([
  'document_analyser',       // reads arbitrary uploaded documents
  'contract_explainer',      // legal contracts — can be 10k-50k tokens
  'bulk_cv_screener',        // reads multiple full CVs simultaneously
  'resume_auto_optimiser',   // reads full CV to produce full rewrite
  'resume_rewriter',         // same — full CV in, full CV out
  'deep_prep_pack',          // exhaustive interview prep — long multi-part output
]);

/* ── NANO-TIER CLASSIFICATION ────────────────────────────────────────────
   All classify-task features use cs-haiku but only need minimal context.
   Mark them careerlm-nano so callOllama allocates 4K ctx (not 8K/32K)
   — saves KV VRAM and speeds up prefill significantly.                     */
const NANO_FEATURES = new Set([
  'impact_scorer',
  'cv_length_analyser',
  'crowd_salary_engine',
  'bonus_structure_decoder',
  'linkedin_seo_optimizer',
  'linkedin_job_alert_optimiser',
  'jd_sentiment_analyser',
  'application_tracker',
  'job_alert_engine',
  'application_checklist',
  'job_scam_detector',
  'goal_progress_tracker',
  'career_quiz',
  'job_title_explorer',
  'work_style_analyser',
  'tool_demand_oracle',
  'obsolescence_radar',
  'automation_risk_checker',
]);

/* ── DERIVE TIER FROM FEATURE_MAP ────────────────────────────────────────
   Derive tier for each of the 274 features in the ground-truth registry.
   Priority: explicit LONG_CTX > explicit NANO > model field inference.    */
function _deriveTier(featureId, featureCfg) {
  if (LONG_CTX_FEATURES.has(featureId)) return 'careerlm-long';
  if (NANO_FEATURES.has(featureId))     return 'careerlm-nano';
  if (featureCfg.model === 'careerlm-nano') return 'careerlm-nano';
  if (featureCfg.model === 'cs-haiku')  return 'careerlm-fast';
  if (featureCfg.model === 'cs-opus')   return 'careerlm-deep';
  return 'careerlm-base'; // cs-sonnet default
}

/* ── BUILD THE COMPLETE MAP ──────────────────────────────────────────── */
const FEATURE_TIER_MAP = {};
for (const [featureId, cfg] of Object.entries(FEATURE_MAP)) {
  FEATURE_TIER_MAP[featureId] = _deriveTier(featureId, cfg);
}

/* ── META-FEATURES (not in featureMap.js — platform identity / platform info) */
FEATURE_TIER_MAP['about_careerstudiomax'] = 'careerlm-fast';

const DEFAULT_TIER = 'careerlm-base';

/**
 * Resolve a feature to its tier config.
 * @returns {{ tier, ollamaModel, numCtx, maxOut, gpuTier }}
 */
/* ── REQUEST-TYPE TOKEN BUDGETS (opt-in, additive) ───────────────────────
   Real, separate from TIER_CONFIG's per-MODEL-tier maxOut above (which
   stays exactly as-is for every existing caller). This table lets a
   caller who already knows the shape of what it's asking for (a quick
   yes/no vs. a full career plan) request a real, request-type-scoped
   budget instead of inheriting whatever the feature's static tier
   happens to default to. Not wired into any of the ~400 existing
   getFeatureTier() call sites in this pass — available for a caller
   (e.g. cs_fixed/services/careerLMOrchestrator.js, when it calls
   through careercamp-ai rather than directly) to opt into. */
const REQUEST_TYPE_BUDGETS = {
  QUICK_ADVICE:     { min: 250,  max: 400  },
  JOB_DECISION:     { min: 300,  max: 500  },
  CAREER_DIAGNOSIS: { min: 500,  max: 800  },
  JOB_COMPARISON:   { min: 600,  max: 1000 },
  CAREER_PLAN:      { min: 1000, max: 1500 },
  DEEP_ANALYSIS:    { min: 1500, max: 2500 },
};

/**
 * Resolve a feature to its tier config. `requestType` is optional — when
 * provided and matches a real entry in REQUEST_TYPE_BUDGETS above, the
 * returned maxOut is overridden to that request type's real midpoint
 * instead of the tier's static value. Omitted (every existing caller
 * today), behavior is byte-for-byte unchanged.
 * @returns {{ tier, ollamaModel, numCtx, maxOut, gpuTier }}
 */
function getFeatureTier(featureId, requestType = null) {
  const tier = FEATURE_TIER_MAP[featureId] || DEFAULT_TIER;
  const cfg = { tier, ...TIER_CONFIG[tier] };
  const budget = requestType && REQUEST_TYPE_BUDGETS[requestType];
  if (budget) cfg.maxOut = Math.round((budget.min + budget.max) / 2);
  return cfg;
}

/**
 * One-line routing summary for [ROUTE] log lines.
 * @returns {string}  e.g. "resume_scorer → careerlm-base (cs-sonnet, 32K ctx)"
 */
function routeSummary(featureId) {
  const { tier, ollamaModel, numCtx } = getFeatureTier(featureId);
  const freeOnly = process.env.FREE_ONLY_MODE !== 'false';
  const fallback = freeOnly
    ? 'Ollama→Groq→OpenRouter→offline'
    : 'Ollama→Groq→OpenRouter→Anthropic→Together→offline';
  return `${featureId} → ${tier} (${ollamaModel}, ${Math.round(numCtx / 1024)}K ctx) | ${fallback}`;
}

module.exports = { FEATURE_TIER_MAP, TIER_CONFIG, DEFAULT_TIER, REQUEST_TYPE_BUDGETS, getFeatureTier, routeSummary };
