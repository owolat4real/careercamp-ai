'use strict';
/**
 * validateFeatureMap.js — Cross-checks feature tier coverage against the
 * ground-truth feature registry.
 *
 * Usage: node careercamp-ai/scripts/validateFeatureMap.js
 *
 * Exits 0 when every feature has an explicit tier.
 * Exits 1 when any feature is missing from the tier map (uses DEFAULT_TIER).
 */

const { FEATURE_MAP }           = require('../config/featureMap');
const { FEATURE_TIER_MAP, TIER_CONFIG, DEFAULT_TIER, getFeatureTier } = require('../engine/featureModelMap');

function validate() {
  const allIds    = Object.keys(FEATURE_MAP);
  const mappedIds = Object.keys(FEATURE_TIER_MAP);

  // Features present in FEATURE_MAP but absent from FEATURE_TIER_MAP
  // (they'll receive DEFAULT_TIER, but the gap should be visible)
  const implicit = allIds.filter(id => !mappedIds.includes(id));
  // Features in FEATURE_TIER_MAP that aren't in FEATURE_MAP (orphaned)
  const orphaned  = mappedIds.filter(id => !allIds.includes(id));

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║         FEATURE MODEL MAP — VALIDATION         ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  console.log(`  Total features in registry:    ${allIds.length}`);
  console.log(`  Features with explicit tier:   ${mappedIds.length}`);
  console.log(`  Features using DEFAULT_TIER:   ${implicit.length}`);
  console.log(`  Orphaned tier entries:         ${orphaned.length}`);

  /* ── Tier distribution ── */
  const dist = {};
  const ctxDist = {};
  for (const id of allIds) {
    const { tier, numCtx } = getFeatureTier(id);
    dist[tier]           = (dist[tier] || 0) + 1;
    ctxDist[numCtx]      = (ctxDist[numCtx] || 0) + 1;
  }

  console.log('\n  Tier distribution:');
  const tierOrder = ['careerlm-nano', 'careerlm-fast', 'careerlm-base', 'careerlm-long', 'careerlm-deep'];
  for (const tier of tierOrder) {
    const count = dist[tier] || 0;
    const cfg   = TIER_CONFIG[tier];
    const bar   = '█'.repeat(Math.round(count / 5));
    console.log(`    ${tier.padEnd(16)} ${String(count).padStart(3)} features  ${bar}  [${cfg.ollamaModel} | ${Math.round(cfg.numCtx/1024)}K ctx]`);
  }

  console.log('\n  Context-window distribution:');
  for (const [ctx, count] of Object.entries(ctxDist).sort((a,b) => +a[0] - +b[0])) {
    console.log(`    ${String(Math.round(+ctx/1024)+'K').padEnd(8)} ${count} features`);
  }

  /* ── Fallback chain ── */
  const freeOnly = process.env.FREE_ONLY_MODE !== 'false';
  console.log('\n  Fallback chain (all 274 features):');
  console.log('    1. Ollama local (tier-appropriate model, exact GPU layers, live num_ctx)');
  console.log('    2. Groq free pool (3 models, per-model 429 cooldown)');
  console.log('    3. OpenRouter free pool');
  if (freeOnly) {
    console.log('    4. offlineResponder (guaranteed non-blank)');
    console.log('    [FREE_ONLY_MODE=true — paid providers skipped]');
  } else {
    console.log('    4. Anthropic (claude-sonnet-4-6 / claude-haiku-4-5)');
    console.log('    5. Gemini 1.5 Flash');
    console.log('    6. offlineResponder');
  }

  /* ── Spot-check critical features ── */
  const checks = [
    { id: 'resume_scorer',       expect: 'careerlm-base' },
    { id: 'cover_letter_m01',    expect: 'careerlm-base' },
    { id: 'lifepath_mode_01',    expect: 'careerlm-base' },
    { id: 'deep_prep_pack',      expect: 'careerlm-long' },
    { id: 'document_analyser',   expect: 'careerlm-long' },
    { id: 'contract_explainer',  expect: 'careerlm-long' },
    { id: 'resume_auto_optimiser', expect: 'careerlm-long' },
    { id: 'impact_scorer',       expect: 'careerlm-nano' },
    { id: 'tool_demand_oracle',  expect: 'careerlm-nano' },
    { id: 'linkedin_headline_gen', expect: 'careerlm-fast' },
    { id: 'star_answer_builder', expect: 'careerlm-base' },
  ];
  console.log('\n  Spot-checks:');
  let spotFail = 0;
  for (const { id, expect } of checks) {
    const { tier } = getFeatureTier(id);
    const ok = tier === expect;
    if (!ok) spotFail++;
    console.log(`    ${ok ? '✅' : '❌'} ${id.padEnd(26)} → ${tier}${!ok ? ' (expected '+expect+')' : ''}`);
  }

  /* ── Implicit (gap) report ── */
  if (implicit.length) {
    console.log(`\n  ⚠  ${implicit.length} features using DEFAULT_TIER (${DEFAULT_TIER}):`);
    implicit.forEach(id => console.log(`     - ${id}`));
  } else {
    console.log('\n  ✅ All 274 features have an explicit tier assignment');
  }

  if (orphaned.length) {
    console.log(`\n  ⚠  ${orphaned.length} orphaned tier entries (not in FEATURE_MAP):`);
    orphaned.forEach(id => console.log(`     - ${id}`));
  }

  console.log('');

  const exitCode = (implicit.length > 0 || orphaned.length > 0 || spotFail > 0) ? 1 : 0;
  if (exitCode !== 0) {
    console.log(`  ❌ Validation FAILED (${implicit.length} gaps, ${orphaned.length} orphans, ${spotFail} spot-check failures)\n`);
  } else {
    console.log(`  ✅ Validation PASSED — complete coverage, no gaps\n`);
  }
  process.exitCode = exitCode;
}

validate();
