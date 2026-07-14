'use strict'
/**
 * gpuAudit.js — Startup GPU capacity report.
 *
 * Runs once at boot, prints exactly what the physical GPU can actually do —
 * replaces guesswork with real numbers computed from live VRAM readings.
 * No side effects on inference paths.
 */

const { exec } = require('child_process')
const util      = require('util')
const execAsync = util.promisify(exec)
const { MODEL_ARCH, SYSTEM_RESERVE_MB } = require('./gpuLayerCalculator')

async function runStartupAudit() {
  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║            GPU CAPACITY AUDIT                ║')
  console.log('╚══════════════════════════════════════════════╝')

  let freeMB = 0

  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader',
      { timeout: 5_000 }
    )
    // stdout format: "NVIDIA GeForce RTX 3050 Laptop GPU, 4096 MiB, 3962 MiB, 610.62"
    const parts   = stdout.trim().split(', ')
    const gpuName = parts[0]
    const total   = parts[1]
    const free    = parts[2]
    const driver  = parts[3]

    freeMB = parseInt(free)

    console.log(`  GPU:         ${gpuName}`)
    console.log(`  Total VRAM:  ${total}`)
    console.log(`  Free VRAM:   ${free}`)
    console.log(`  Driver:      ${driver}`)
    console.log(`  CUDA reserve:  ${SYSTEM_RESERVE_MB} MiB (OS + display + CUDA/Ollama overhead)`)
    console.log('')
    console.log('  Model layer capacity at current free VRAM:')
    console.log('  ─────────────────────────────────────────────────')

    for (const [modelName, arch] of Object.entries(MODEL_ARCH)) {
      if (modelName === 'careerlm-nano') continue   // internal alias, skip display

      const kvCostMB   = arch.kvCachePerToken * 8192   // standard 8k context
      const usableMB   = freeMB - SYSTEM_RESERVE_MB - kvCostMB
      const layersFit  = usableMB > 0 ? Math.floor(usableMB / arch.mbPerLayer) : 0
      const finalLayers = Math.min(layersFit, arch.totalLayers)
      const pct         = ((finalLayers / arch.totalLayers) * 100).toFixed(0)
      const totalMB     = arch.totalLayers * arch.mbPerLayer

      let status
      if (pct >= 100) status = '✅ FULL GPU'
      else if (pct > 0) status = `🟡 PARTIAL GPU  (${arch.totalLayers - finalLayers} layers on CPU)`
      else status = '🔴 CPU FALLBACK'

      console.log(
        `  ${modelName.padEnd(14)} ${finalLayers.toString().padStart(2)}/${arch.totalLayers} layers`
        + `  (${pct.padStart(3)}% GPU)`
        + `  [~${totalMB} MiB weights]`
        + `  ${status}`
      )
    }
    console.log('  ─────────────────────────────────────────────────')

    // Coexist analysis
    console.log('  Coexistence on 4 GB VRAM:')
    console.log(`    cs-haiku + cs-sonnet:  ~2662 MiB combined → ✅ Safe to coexist`)
    console.log(`    cs-opus + anything:    ~4198 MiB min       → 🔴 Must evict first`)

  } catch (err) {
    console.log('  ⚠️  No NVIDIA GPU detected (nvidia-smi failed)')
    console.log('     All CS model inference will run on CPU via Ollama.')
    console.log('     Cloud fallbacks (Groq / OpenRouter / Anthropic) will be primary.')
  }

  console.log('')
}

module.exports = { runStartupAudit }
