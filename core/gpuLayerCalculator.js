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
  'cs-opus': {
    totalLayers:    32,
    mbPerLayer:     108,     // ~3456 MiB in layers; rest is embeddings + LM head
    kvCachePerToken: 0.021,
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
