'use strict'
/**
 * vramTuner.js — Live VRAM query via nvidia-smi.
 * Returns free VRAM in MiB. Falls back to 0 when no NVIDIA GPU is present
 * so callers can safely degrade to CPU-only inference.
 */

const { exec } = require('child_process')
const util      = require('util')
const execAsync = util.promisify(exec)

let _cached = null          // { mb, ts }
const CACHE_TTL_MS = 5_000  // re-query at most once per 5s

async function getFreeVRAM() {
  if (_cached && Date.now() - _cached.ts < CACHE_TTL_MS) return _cached.mb

  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits',
      { timeout: 3_000 }
    )
    const mb = parseInt(stdout.trim(), 10)
    if (!isNaN(mb)) {
      _cached = { mb, ts: Date.now() }
      return mb
    }
  } catch (_) {}

  return 0   // no GPU / nvidia-smi not available
}

async function getTotalVRAM() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      { timeout: 3_000 }
    )
    const mb = parseInt(stdout.trim(), 10)
    return isNaN(mb) ? 0 : mb
  } catch (_) { return 0 }
}

module.exports = { getFreeVRAM, getTotalVRAM }
