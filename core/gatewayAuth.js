'use strict';
/**
 * GATEWAY AUTH — purpose-specific credential authorization
 *
 * Replaces the old `VALID_GATEWAY_KEYS.some(k => k === key)` check (any one
 * of CAREERCAMP_API_KEY / CS_TRANSFORMER_API_KEY / CAREERCAMP_SECRET_KEY
 * granting identical access to nearly every route) with an explicit
 * route-to-credential-class policy: each credential only authorizes the
 * route families its real, source-confirmed consumers actually use.
 *
 * Credentials are still plain environment-variable shared secrets (no
 * database persistence is introduced here — see the task this shipped
 * under). What changes is that presenting a VALID credential of the wrong
 * class for a given route is now a rejection, not a silent grant.
 */

const crypto = require('crypto');

// ── Constant-time comparison ──────────────────────────────────────────
// crypto.timingSafeEqual() throws on mismatched-length buffers, and simply
// returning early on a length mismatch leaks the secret's length through
// timing. HMAC-digesting both sides first (fixed 32-byte output) sidesteps
// both problems: comparison is always between two same-length digests, so
// timingSafeEqual is always safe to call and never itself leaks length.
// The HMAC key only needs to make the two digests un-shortcuttable to
// compare — it doesn't need to be secret from this same process, so a
// fresh random key per boot is sufficient (no persistence needed).
const _compareKey = crypto.randomBytes(32);
function _digest(value) {
  return crypto.createHmac('sha256', _compareKey).update(String(value), 'utf8').digest();
}
function _safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(_digest(a), _digest(b));
}

const MAX_CREDENTIAL_LENGTH = 512; // generous — real keys are ~50-60 chars; anything past this is malformed, not a real key

// ── Credential classes ─────────────────────────────────────────────────
// Read once at module load (server-side only) — matches the existing
// gateway's own boot-time VALID_GATEWAY_KEYS pattern; a credential can't
// be hot-swapped mid-process without a restart, which is the same
// operational assumption the rest of this gateway already makes.
const CREDENTIAL_CLASSES = [
  { name: 'secret',      envVar: 'CAREERCAMP_SECRET_KEY' },
  { name: 'camp',        envVar: 'CAREERCAMP_API_KEY' },
  { name: 'transformer', envVar: 'CS_TRANSFORMER_API_KEY' },
];

function _loadConfigured() {
  return CREDENTIAL_CLASSES
    .map(c => ({ name: c.name, envVar: c.envVar, value: (process.env[c.envVar] || '').trim() }))
    // Empty/unset values are dropped entirely, never kept as a matchable
    // "" secret — otherwise two unset vars would both be "" and a request
    // with no credential at all could accidentally match an empty entry.
    .filter(c => c.value.length > 0);
}

let _configured = _loadConfigured();

/**
 * reload — re-reads env vars into the module's working set.
 * Not used by the running server (env vars don't change mid-process on
 * this platform), but lets tests exercise different configurations
 * without spawning a new process.
 */
function reload() {
  _configured = _loadConfigured();
}

/**
 * checkConfiguration — pure, side-effect-free validation of the current
 * credential configuration. Returns { ok: true } or
 * { ok: false, reason, detail } where `detail` never contains a secret
 * value — only the configured variable NAMES involved.
 *
 * Call once at boot; the caller decides how to fail (this gateway's
 * existing convention, matched here, is to log a FATAL line and
 * process.exit(1) rather than start with weakened/undefined auth).
 */
function checkConfiguration() {
  if (!_configured.length) {
    return {
      ok: false,
      reason: 'no_credentials_configured',
      detail: CREDENTIAL_CLASSES.map(c => c.envVar),
    };
  }
  for (let i = 0; i < _configured.length; i++) {
    for (let j = i + 1; j < _configured.length; j++) {
      if (_safeEqual(_configured[i].value, _configured[j].value)) {
        return {
          ok: false,
          reason: 'duplicate_secret_value',
          detail: [_configured[i].envVar, _configured[j].envVar],
        };
      }
    }
  }
  return { ok: true };
}

// ── Credential classification ───────────────────────────────────────────
// Never logs or returns the presented value. `reason` is populated only
// when `class` is null, and is a category label, not secret material.
function classify(presented) {
  if (typeof presented !== 'string' || !presented.trim()) {
    return { class: null, reason: 'missing_credential' };
  }
  const value = presented.trim();
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    return { class: null, reason: 'malformed_credential' };
  }
  for (const c of _configured) {
    if (_safeEqual(value, c.value)) return { class: c.name, reason: null };
  }
  return { class: null, reason: 'unknown_credential' };
}

/** identify — convenience wrapper returning just the class name, or null. */
function identify(presented) {
  return classify(presented).class;
}

// ── Transport extraction ────────────────────────────────────────────────
// Both `Authorization: Bearer <key>` and `x-api-key: <key>` (plus the
// pre-existing `?api_key=` query fallback) are accepted as transports for
// ANY credential class — header format and credential purpose are
// independent concerns. A CS_TRANSFORMER_API_KEY sent as `Authorization:
// Bearer` does not gain CareerCamp-class privileges just because Bearer
// is also how CAREERCAMP_API_KEY is normally sent — authorization below is
// decided purely by which class the value matches, never by which header
// carried it. Precedence matches the original apiKeyAuth exactly (Authorization
// -> query api_key -> x-api-key) so no existing caller's transport choice breaks.
function extractPresented(req) {
  const headers = (req && req.headers) || {};
  const fromAuth = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (fromAuth) return fromAuth;
  const fromQuery = req && req.query && req.query.api_key;
  if (fromQuery) return String(fromQuery);
  return String(headers['x-api-key'] || '');
}

// ── Middleware factory ──────────────────────────────────────────────────
// allowedClasses: non-empty array of credential class names ('secret',
// 'camp', 'transformer') permitted for the route(s) this is mounted on.
// Fails closed on every path: missing, malformed, unknown, and
// valid-wrong-class credentials are all rejected — none of them silently
// fall back to another credential class.
function authorize(allowedClasses) {
  if (!Array.isArray(allowedClasses) || allowedClasses.length === 0) {
    throw new Error('gatewayAuth.authorize() requires a non-empty allowedClasses array');
  }
  const allowed = new Set(allowedClasses);

  return function gatewayAuthMiddleware(req, res, next) {
    const presented = extractPresented(req);
    const { class: cls, reason } = classify(presented);
    const route = `${req.method} ${req.originalUrl || req.url}`;

    if (!cls) {
      // reason is one of: missing_credential | malformed_credential | unknown_credential
      console.warn(`[GATEWAY-AUTH] 401 ${route} — reason: ${reason}`);
      return res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error', code: 401 } });
    }
    if (!allowed.has(cls)) {
      console.warn(`[GATEWAY-AUTH] 403 ${route} — credential class: ${cls} — reason: wrong_purpose`);
      return res.status(403).json({ error: { message: 'This credential is not authorized for this endpoint', type: 'authorization_error', code: 403 } });
    }
    req.gatewayCredentialClass = cls;
    next();
  };
}

module.exports = {
  CREDENTIAL_CLASSES,
  MAX_CREDENTIAL_LENGTH,
  reload,
  checkConfiguration,
  classify,
  identify,
  extractPresented,
  authorize,
};
