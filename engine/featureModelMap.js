'use strict';
/**
 * featureModelMap.js — Single source of truth for feature-to-tier routing.
 *
 * Derived from the ground-truth feature registry in config/featureMap.js —
 * never invented. Adds the tier abstraction layer on top so routing logic
 * references stable tier names (careerlm-nano / fast / base / long / deep)
 * rather than raw model names that could change.
 *
 * Tier hierarchy:
 *   careerlm-nano   Classifiers, yes/no, single-value outputs    cs-haiku   4K ctx
 *   careerlm-fast   Short structured output, headlines, snippets  cs-haiku   8K ctx
 *   careerlm-base   Long-form reasoning, standard career tasks    cs-sonnet  32K ctx
 *   careerlm-long   Document/contract analysis, full CV rewrites  cs-sonnet  131K ctx
 *   careerlm-deep   Reserved — deep multi-factor analysis         cs-opus    32K ctx
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
   gpuTier:     passed to gpuScheduler for concurrency slot management     */
const TIER_CONFIG = {
  'careerlm-nano': { ollamaModel: 'cs-haiku',  numCtx:    4096, maxOut:  512, gpuTier: 'haiku' },
  'careerlm-fast': { ollamaModel: 'cs-haiku',  numCtx:    8192, maxOut: 1024, gpuTier: 'haiku' },
  'careerlm-base': { ollamaModel: 'cs-sonnet', numCtx:   32768, maxOut: 4096, gpuTier: 'sonnet' },
  'careerlm-long': { ollamaModel: 'cs-sonnet', numCtx:  131072, maxOut: 4096, gpuTier: 'sonnet' },
  'careerlm-deep': { ollamaModel: 'cs-opus',   numCtx:   32768, maxOut: 4096, gpuTier: 'opus'   },
};

/* ── LONG-CONTEXT OVERRIDES ──────────────────────────────────────────────
   Features that consume long input documents — classified as careerlm-long
   even though their underlying model is cs-sonnet. The difference is
   num_ctx: 131072 vs 32768, which reserves KV cache for document-length
   inputs without blowing VRAM on nano/fast tasks.                          */
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
function getFeatureTier(featureId) {
  const tier = FEATURE_TIER_MAP[featureId] || DEFAULT_TIER;
  return { tier, ...TIER_CONFIG[tier] };
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

module.exports = { FEATURE_TIER_MAP, TIER_CONFIG, DEFAULT_TIER, getFeatureTier, routeSummary };
