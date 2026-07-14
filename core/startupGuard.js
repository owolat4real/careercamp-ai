'use strict';
const fs   = require('fs');
const path = require('path');

/* Optional modules relative to the core/ directory.
   If one is missing the server still boots — callers get a safe stub. */
const OPTIONAL_MODULES = [
  './tokenBudgets',
  './responseCache',
  './keepWarm',
  './instantShell',
  './httpAgent',
  './perfMonitor',
];

/**
 * safeRequire — require a module relative to THIS file without crashing
 * if the file is missing or throws on load.
 *
 * @param {string} relativePath  e.g. './responseCache'
 * @param {object} fallback      returned when the module cannot be loaded
 */
function safeRequire(relativePath, fallback = {}) {
  try {
    const fullPath = path.join(__dirname, relativePath.replace(/^\.\//, '') + '.js');
    if (!fs.existsSync(fullPath)) {
      console.warn(`[STARTUP-GUARD] ⚠  Missing optional module: ${relativePath} — using safe fallback`);
      return fallback;
    }
    return require(relativePath);
  } catch (err) {
    console.warn(`[STARTUP-GUARD] ⚠  Failed to load ${relativePath}: ${err.message} — using safe fallback`);
    return fallback;
  }
}

/**
 * validateStartup — log which optional modules are present/missing.
 * Call once at the top of server.js before route registration.
 * Never throws.
 */
function validateStartup() {
  console.log('[STARTUP-GUARD] Validating optional modules…');
  let missing = 0;
  for (const m of OPTIONAL_MODULES) {
    const fullPath = path.join(__dirname, m.replace(/^\.\//, '') + '.js');
    const exists   = fs.existsSync(fullPath);
    if (exists) {
      console.log(`  ✅ ${m}`);
    } else {
      console.warn(`  ⚠  ${m} — MISSING, will use safe fallback`);
      missing++;
    }
  }
  if (missing > 0) {
    console.log(`[STARTUP-GUARD] ${missing} optional module(s) missing — server will still start safely\n`);
  } else {
    console.log('[STARTUP-GUARD] ✅ All optional modules present\n');
  }
}

module.exports = { safeRequire, validateStartup };
