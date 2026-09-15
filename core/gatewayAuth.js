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

// ── Log-safe URL redaction ──────────────────────────────────────────────
// Shared by this module's own auth-failure warnings AND server.js's global
// morgan access logger (via a custom :url token override) -- one regex,
// one place, rather than two independent redaction implementations that
// could drift. Redacts the *value* only, keeping "api_key=" so a log
// reader can still see that transport was used, per CS-1 gateway auth
// review Priority 1 (2026-09-15): "?api_key=..." must never reach any log
// unredacted, on success, failure, OR when a different transport ends up
// actually deciding the request (the query value can appear in the logged
// URL even when it was never read for authorization).
function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  // Normalizes any api_key transport variant -- plain (?api_key=x), repeated
  // (&api_key=x), or a structured/bracket key name (?api_key[toString]=x,
  // itself never a valid credential, see extractPresented's own handling of
  // this shape) -- down to exactly "api_key=[REDACTED]". Discarding any
  // bracket content rather than merely blanking the value keeps an
  // attacker-chosen key name (which could itself be arbitrary text) out of
  // the log too, not just the credential value.
  return url.replace(/([?&])api_key(?:\[[^\]]*\])?=[^&]*/gi, '$1api_key=[REDACTED]');
}

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
  // A configured credential longer than classify() will ever accept is a
  // silent availability defect, not a security one: it passes startup but
  // can never actually authenticate (classify() rejects any *presented*
  // value over this length as malformed before ever comparing it). Catch
  // it at boot instead of leaving that class permanently, confusingly
  // unusable. Checked against the SAME MAX_CREDENTIAL_LENGTH used for
  // presented values, per CS-1 gateway auth review Priority 5 (2026-09-15).
  const tooLong = _configured.filter(c => c.value.length > MAX_CREDENTIAL_LENGTH);
  if (tooLong.length) {
    return {
      ok: false,
      reason: 'credential_too_long',
      detail: tooLong.map(c => c.envVar),
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
//
// Timing-accuracy note (CS-1 gateway auth review Priority 9, 2026-09-15):
// only the individual value-vs-value comparison inside _safeEqual() is
// constant-time (fixed-size HMAC digests through crypto.timingSafeEqual).
// classify() AS A WHOLE is not: the length check above short-circuits
// before any comparison for an over-long input, and the loop below exits
// on the FIRST matching configured class, so total wall-clock time still
// depends on input length and on which class (if any) matches. This is a
// real, acknowledged gap, not a claimed guarantee -- it means classify()
// cannot be assumed to hide "how close" an incorrect guess was, only that
// a single value-to-value comparison itself doesn't leak via timing. No
// credential-recovery timing attack has been demonstrated against it, and
// hiding match-order/length timing too would need a fixed-work classifier
// (e.g. always comparing against every configured class, and normalizing
// input length before hashing) with no known real benefit at this
// credential count (<=3) and over this gateway's real network path.
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
  // Express's query parser (qs) turns `?api_key[toString]=x` into a plain
  // OBJECT `{ toString: 'x' }` -- a naive `String(fromQuery)` then invokes
  // that object's own `toString` PROPERTY (a string, not a function) as a
  // function call, throwing a TypeError that used to reach the server's
  // generic error handler as an HTTP 500. Strings (the normal case) and
  // arrays (repeated `?api_key=a&api_key=b`, or the single-element
  // `?api_key[]=x` form) are safe to stringify via a built-in that never
  // invokes attacker-supplied properties; anything else (a structured/
  // bracket-object query value) is treated as though no query credential
  // were presented at all, falling through to x-api-key rather than ever
  // being coerced. Fixed 2026-09-15, CS-1 gateway auth review Priority 4.
  const rawQuery = req && req.query ? req.query.api_key : undefined;
  if (typeof rawQuery === 'string' || Array.isArray(rawQuery)) {
    const fromQuery = String(rawQuery);
    if (fromQuery) return fromQuery;
  }
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
    // redactUrl strips any ?api_key=... value before this ever reaches a
    // log line -- the credential must not appear here even when it was
    // the query param that got REJECTED, and even when a different,
    // higher-precedence transport is what actually decided the outcome
    // (the raw query string is still part of req.originalUrl either way).
    const route = `${req.method} ${redactUrl(req.originalUrl || req.url)}`;

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
  redactUrl,
};
