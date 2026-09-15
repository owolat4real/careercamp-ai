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
 */

const fs = require('fs');

const VALID_STATES = new Set(['warming', 'ready', 'degraded']);
const STATE_FILE = process.env.WARMUP_STATE_FILE || '/tmp/careercamp-model-warmup-state';

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

module.exports = { readWarmupState, STATE_FILE, VALID_STATES };
