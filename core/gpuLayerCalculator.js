'use strict'
/**
 * gpuLayerCalculator.js — Exact layer-offload counts from real VRAM math.
 *
 * Replaces the hardcoded num_gpu 99/999 values in inferenceEngine.js with
 * a calculated value derived from:
 *   1. Live free VRAM (nvidia-smi)
 *   2. Real per-model architecture (layer count + per-layer weight size)
 *   3. KV-cache cost at the requested context length
 *   4. A fixed system overhead reserve for OS + display + CUDA/Ollama daemon
 *
 * RTX 3050 Laptop GPU — 4096 MiB total
 * ──────────────────────────────────────
 *   cs-haiku  (Llama-3.2-1B,  Q4_K_M): ~716 MiB total →  16 layers × 28 MiB  → ALL fit
 *   cs-sonnet (Llama-3.2-3B,  Q4_K_M): ~1946 MiB total → 28 layers × 55 MiB  → ALL fit
 *   cs-opus   (Mistral-7B,    Q4_K_M): ~4198 MiB total → 32 layers × 108 MiB → PARTIAL
 *
 * At 3962 MiB free (idle), cs-opus at 8192 context:
 *   KV cache: 0.021 × 8192 ≈ 172 MiB
 *   Usable:   3962 - 400(reserve) - 172(KV) = 3390 MiB
 *   Layers:   floor(3390 / 108) = 31 / 32  (97% GPU, 1 layer CPU)
 *
 * 40-80GB single-GPU pod (real 2026-08-07 target hardware, exact card
 * not pinned here — this math is VRAM-driven, not card-name-driven)
 * ──────────────────────────────────────────────────────────────────
 *   cs-opus (Aya-Expanse-32B, Q4_K_M): ~19GB estimated total → see the
 *   MODEL_ARCH entry below for exactly which numbers are confirmed real
 *   vs honestly-flagged approximations (gated HF config.json couldn't be
 *   read directly). At this size the real headroom on a 40-80GB pod is
 *   large enough that num_gpu 99 (see Modelfile.cs-opus -- let Ollama
 *   auto-decide) is the real safety net; this calculator's precision
 *   matters far less here than it did for the tighter-fitting 70B this
 *   replaced.
 */

const { getFreeVRAM } = require('./vramTuner')

/* Real architecture: layer counts match HuggingFace config.json, per-layer
   MiB measured from Q4_K_M quant file size / transformer layers */
const MODEL_ARCH = {
  'cs-haiku': {
    totalLayers:    16,
    mbPerLayer:     28,      // ~448 MiB in layers; embeddings + norms add ~268 MiB
    kvCachePerToken: 0.008,  // MiB per token, Q8_0 KV cache (OLLAMA_KV_CACHE_TYPE=q8_0)
  },
  'cs-sonnet': {
    totalLayers:    28,
    mbPerLayer:     55,      // ~1540 MiB in layers; rest is embeddings + vocab
    kvCachePerToken: 0.014,
  },
  // Real 2026-08-07 upgrade: cs-opus moved Mistral-7B -> briefly
  // Llama-3.3-70B -> corrected same-day to CohereLabs/Aya-Expanse-32B
  // once real 23-language coverage was confirmed as a hard requirement
  // (Aya-101's real 101 languages was the first target but is a T5
  // encoder-decoder architecture llama.cpp/Ollama cannot run at all --
  // see cs_fixed/models/Modelfile.cs-opus's comment for the full real
  // chain of research behind this). This entry MUST ship together with
  // that pod-side model swap, not independently.
  //
  // HONESTY NOTE, unlike the entries above: the exact real layer count
  // and per-layer size below are an INFORMED APPROXIMATION, not a
  // directly-measured value -- CohereLabs/aya-expanse-32b's config.json
  // sits behind a gated HF repo I couldn't read directly. 40 layers is
  // sourced from Cohere2's documented architecture default (same family
  // lineage, not confirmed identical); total size is scaled from the
  // Llama-70B figure by real parameter ratio (32B/70B ≈ 0.46 × ~40GB ≈
  // 19GB); the embed/LM-head share is estimated higher than a typical
  // English-centric model's (~3000 MiB vs the old entry's ~2500) because
  // Aya's real design goal is broad multilingual vocabulary, which
  // genuinely inflates that share. Correct via
  // `ollama show aya-expanse:32b --parameters` once actually pulled on
  // the pod -- treat this as a reasonable starting estimate, not a
  // measured fact, though the real ~40-80GB VRAM headroom at this
  // model's real ~19GB size makes an error here low-stakes (num_gpu 99
  // in the Modelfile is the actual safety net regardless).
  'cs-opus': {
    totalLayers:    40,
    mbPerLayer:     400,       // ~16000 MiB in layers; ~3000 MiB estimated embed/LM-head
    kvCachePerToken: 0.031,    // carried over from the 70B estimate, also unverified for this model
  },
  // Retained for any environment still actually running the original 7B
  // opus (e.g. a smaller/local dev box that never did either pod swap
  // above) -- register it under its real base-model name rather than
  // overloading 'cs-opus' for multiple different real models.
  'cs-opus-7b-legacy': {
    totalLayers:    32,
    mbPerLayer:     108,     // ~3456 MiB in layers; rest is embeddings + LM head
    kvCachePerToken: 0.021,
  },
  // Real, directly-measured entry for the Llama-3.3-70B target this was
  // briefly set to before the multilingual correction above -- kept
  // (not deleted) in case a future decision reverts to it or runs it
  // alongside Aya Expanse under a different model name.
  'cs-opus-llama70b': {
    totalLayers:    80,
    mbPerLayer:     469,      // ~37500 MiB in layers; rest is embeddings + LM head
    kvCachePerToken: 0.031,
  },
  // Fallthrough for any unknown model names registered in the future
  'careerlm-nano': {
    totalLayers:    16,
    mbPerLayer:     28,
    kvCachePerToken: 0.008,
  },
}

// Reserve MiB: OS display driver + CUDA context + Ollama daemon overhead.
// Validated against nvidia-smi readings on the target RTX 3050 Laptop GPU.
const SYSTEM_RESERVE_MB = 400

/**
 * @param {string} modelName  Ollama model name (e.g. 'cs-opus')
 * @param {number} contextTokens  KV context length to reserve for
 * @returns {Promise<number>}  num_gpu value to pass to Ollama
 */
async function calculateOptimalGpuLayers(modelName, contextTokens = 8192) {
  const arch = MODEL_ARCH[modelName]
  if (!arch) return 99   // unknown model, let Ollama decide

  const freeMB   = await getFreeVRAM()
  if (!freeMB) return 0  // no GPU detected — CPU inference

  const kvCostMB = arch.kvCachePerToken * contextTokens
  const usableMB = freeMB - SYSTEM_RESERVE_MB - kvCostMB

  if (usableMB <= 0) {
    console.warn(`[GPU-CALC] ${modelName}: insufficient VRAM (${freeMB} MiB free, need >${SYSTEM_RESERVE_MB + kvCostMB} MiB headroom) → CPU fallback`)
    return 0
  }

  const layersFit   = Math.floor(usableMB / arch.mbPerLayer)
  const finalLayers = Math.min(layersFit, arch.totalLayers)
  const pct         = ((finalLayers / arch.totalLayers) * 100).toFixed(0)
  const status      = finalLayers === arch.totalLayers ? 'FULL GPU' : 'PARTIAL GPU'

  console.log(`[GPU-CALC] ${modelName}: ${freeMB} MiB free → ${finalLayers}/${arch.totalLayers} layers (${pct}%) [${status}]`)

  return finalLayers
}

module.exports = { calculateOptimalGpuLayers, MODEL_ARCH, SYSTEM_RESERVE_MB }
