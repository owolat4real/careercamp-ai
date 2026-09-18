'use strict';
/**
 * MODEL WARMUP STATE — reads the per-instance warm-up status that
 * scripts/salad-model-warmup.sh (a background job launched by
 * scripts/salad-entrypoint.sh) writes to a small state file, so the Node
 * gateway — which now starts well before that warm-up finishes, see
 * server.js's boot() and the entrypoint's own header comment — can report
 * an honest status instead of either blocking on it or silently
 * pretending everything is ready.
 *
 * Three states, matching salad-model-warmup.sh's own write_state() calls:
 *   'warming'  — the background restore/pull is still in progress (or the
 *                state file doesn't exist yet at all -- the default,
 *                before the warm-up script's very first write, and also
 *                the honest answer outside Salad entirely, e.g. local dev).
 *   'ready'    — the custom model set restored/renamed successfully.
 *   'degraded' — some step failed (S3 download, extraction, the ollama
 *                restart after extraction, or the llava-phi3 pull); the
 *                gateway is fully usable via its existing provider-
 *                fallback cascade (Groq/OpenRouter — see engine/llm.js's
 *                own ollamaAvailable-gated fallback paths), just without
 *                one or more local models.
 *
 * No database, no Redis -- a single small text file is all this needs,
 * and it's inherently per-instance already (Salad's own ephemeral
 * filesystem resets it on every fresh instance, which is the correct
 * behavior here — there is no cross-instance persistence to claim).
 *
 * S3 restore root-cause pass (2026-09-18): a real instance reached
 * 'degraded' with no way to tell WHY -- S3 timeout, AccessDenied,
 * NoSuchKey, a region problem, or a genuine network stall all looked
 * identical from this state alone. readWarmupReason() below reads a
 * SEPARATE, purely additive, non-secret reason-code file
 * salad-model-warmup.sh now also writes (see its own classify_aws_failure)
 * -- it does not change readWarmupState()'s own three-value return
 * contract at all, so any existing caller of readWarmupState() is
 * completely unaffected.
 */

const fs = require('fs');

const VALID_STATES = new Set(['warming', 'ready', 'degraded']);
const STATE_FILE = process.env.WARMUP_STATE_FILE || '/tmp/careercamp-model-warmup-state';
// Mirrors salad-model-warmup.sh's own WARMUP_REASON_FILE default exactly
// (${WARMUP_STATE_FILE}.reason) so the two stay in sync without either
// side needing its own separate env var by default.
const REASON_FILE = process.env.WARMUP_REASON_FILE || `${STATE_FILE}.reason`;
// The exact, closed set of reason codes classify_aws_failure() (and the
// script's other write_reason() call sites) can produce -- kept in sync
// with scripts/salad-model-warmup.sh by hand, deliberately, the same way
// VALID_STATES already is. Anything else (including a corrupt or
// attacker-controlled file, e.g. via a compromised background process)
// is treated as "no known reason" rather than passed through.
const VALID_REASONS = new Set([
  's3_download_timeout_outer',
  's3_download_timeout_cli',
  's3_access_denied',
  's3_no_such_key_or_bucket',
  's3_invalid_credentials',
  's3_network_unreachable',
  's3_region_misconfigured',
  's3_download_failed_other',
  'archive_extraction_failed',
  'ollama_restart_failed',
  'vision_pull_failed',
  'credentials_not_configured',
]);

/**
 * readWarmupState — synchronous, side-effect-free, never throws.
 * Returns one of 'warming' | 'ready' | 'degraded'. Missing file, empty
 * file, or unrecognized content all safely default to 'warming' rather
 * than ever claiming 'ready' without real evidence.
 */
function readWarmupState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    return VALID_STATES.has(raw) ? raw : 'warming';
  } catch (_) {
    return 'warming';
  }
}

/**
 * readWarmupReason — synchronous, side-effect-free, never throws.
 * Returns one of VALID_REASONS' short diagnostic codes, or `null` when no
 * reason has been recorded (the happy path, a still-warming instance, or
 * outside Salad entirely -- e.g. local dev, where this file never
 * exists). Never a raw/arbitrary string -- an unrecognized value in the
 * file is treated exactly like a missing one.
 */
function readWarmupReason() {
  try {
    const raw = fs.readFileSync(REASON_FILE, 'utf8').trim();
    return VALID_REASONS.has(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

module.exports = { readWarmupState, readWarmupReason, STATE_FILE, REASON_FILE, VALID_STATES, VALID_REASONS };
