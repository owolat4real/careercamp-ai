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

// A fixed, over-length sentinel used ONLY to signal "the query transport
// was used but its shape was structurally unsafe to inspect" from
// extractPresented() to classify(), without inventing a second return
// contract. Routed through classify()'s EXISTING length check, so it is
// always reported as malformed_credential (not unknown_credential, and
// never silently treated as though no query credential were presented at
// all -- see the "distinguish missing from malformed" note on
// extractPresented() below). Guaranteed to never collide with a real
// configured secret: checkConfiguration() already refuses to boot with any
// configured credential over MAX_CREDENTIAL_LENGTH, so no real secret can
// ever equal or be mistaken for this sentinel.
const MALFORMED_QUERY_SENTINEL = 'x'.repeat(MAX_CREDENTIAL_LENGTH + 1);

// ── Log-safe URL redaction ──────────────────────────────────────────────
// Shared by this module's own auth-failure warnings AND server.js's global
// morgan access logger (via a custom :url token override) -- one function,
// one place, rather than two independent redaction implementations that
// could drift. Per CS-1 gateway auth review Priority 1 (2026-09-15):
// "?api_key=..." must never reach any log unredacted, on success, failure,
// OR when a different transport ends up actually deciding the request.
//
// STRUCTURAL fix (2026-09-15, second review remediation): the original
// implementation matched the literal substring "api_key" in the raw URL
// text via regex. That regex is blind to percent-encoding: a client (or an
// attacker deliberately evading redaction) can spell the parameter name as
// `%61pi_key`, `api%5fkey`, a fully percent-encoded name, or percent-
// encoded brackets (`api_key%5B0%5D`) -- Express's own query parser
// decodes all of these down to the literal key `api_key` before
// extractPresented() ever sees them, so authentication succeeds
// identically either way, but the OLD regex never matched the raw,
// still-encoded text, so the credential reached the log completely
// unredacted. Parsing with the built-in URLSearchParams (which performs
// the same percent-decoding on parameter NAMES, not just values, as any
// standard query-string parser including Express's) and comparing the
// DECODED key -- rather than pattern-matching the raw, possibly-encoded
// text -- closes this for every encoding variant at once, without
// enumerating them. This never touches req.url/req.originalUrl/routing;
// it only ever transforms a throwaway string copy for a log line.
function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const pathname = url.slice(0, qIndex);
  let params;
  try {
    params = new URLSearchParams(url.slice(qIndex + 1));
  } catch (_) {
    // URLSearchParams does not throw on arbitrary input in practice, but
    // fail safe rather than ever fall back to logging the raw, unparsed
    // query string if it somehow did.
    return pathname + '?[query redacted: unparsable]';
  }
  const parts = [];
  for (const [key, value] of params) {
    // Case-sensitive on purpose: req.query.api_key (what extractPresented
    // actually reads) is itself a case-sensitive property lookup, so
    // `API_KEY` is genuinely a different, non-authenticating parameter --
    // redaction mirrors real authentication semantics exactly rather than
    // over-redacting things that were never credential-bearing.
    // Bracket-descendant forms (api_key[0], api_key[toString], etc.) all
    // collapse to ONE top-level `api_key` property on req.query regardless
    // of nesting depth, so matching the key prefix "api_key[" here covers
    // every descendant shape without needing to parse the brackets myself.
    if (key === 'api_key' || key.startsWith('api_key[')) {
      parts.push(`${encodeURIComponent(key)}=[REDACTED]`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.length ? `${pathname}?${parts.join('&')}` : pathname;
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
  // Type-safe query handling (2026-09-15, second review remediation --
  // supersedes the first pass, which only rejected a top-level object and
  // still called String() on arrays; an array element can itself be an
  // object whose own `toString` PROPERTY shadows the method, e.g.
  // `?api_key[0][toString]=x` parses to `[{toString:'x'}]`, and
  // Array.prototype.toString/join() internally stringifies each element,
  // throwing exactly the same way a bare object did).
  //
  // Strict policy, in order:
  //   string  -> the candidate credential (empty string treated as absent,
  //              same as today -- falls through to x-api-key below)
  //   array/object/number/boolean -> REJECTED outright as malformed,
  //              without ever calling String()/.toString() on the value
  //              or inspecting its contents. No confirmed CareerStudioMax
  //              consumer sends repeated or bracketed ?api_key= query
  //              parameters (every real caller uses Authorization or
  //              x-api-key -- see cs_fixed compatibility notes on this
  //              task), so there is no compatibility reason to salvage a
  //              single-element array or otherwise inspect structured
  //              input; rejecting all of it is both simpler and safer.
  //   undefined/null -> missing, falls through to x-api-key below
  //
  // A malformed shape short-circuits here (mirrors how an "unknown"
  // string value in this same slot already short-circuits rather than
  // falling through) rather than being silently treated as absent --
  // see MALFORMED_QUERY_SENTINEL's own comment for how this is signalled
  // through to classify() without a second return contract.
  const rawQuery = req && req.query ? req.query.api_key : undefined;
  if (typeof rawQuery === 'string') {
    if (rawQuery) return rawQuery;
  } else if (rawQuery !== undefined && rawQuery !== null) {
    return MALFORMED_QUERY_SENTINEL;
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
