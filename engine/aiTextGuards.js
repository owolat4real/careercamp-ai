'use strict';
/* Shared placeholder-detection helpers. Ported into careercamp-ai
   (2026-09-04), byte-identical logic to cs_fixed/services/aiTextGuards.js
   -- real gap closed: this is the actual CSTM-1 inference backend behind
   /v1/camp/:featureId, serving external developers with no human review
   before the response goes out, and had no placeholder-leak detection at
   all. */

// Real bug class this catches: an unfilled template slot ([bracket] or
// {{mustache}}) echoed back verbatim in the final response instead of
// being substituted with a real value. Allowlists this platform's own
// DATA LABELING RULE tags ([LIVE DATA]/[ESTIMATED]/[INFERRED]/[VERIFIED])
// so a correctly-labeled, well-grounded response is never falsely
// flagged.
const _LEGIT_MARKERS = /^(PAUSE_SHORT|PAUSE_MEDIUM|PAUSE_LONG|TONE_WARM|TONE_PROBE|EMPHASIS|\/EMPHASIS|LIVE DATA|ESTIMATED|INFERRED|VERIFIED)$/;
function hasUnresolvedPlaceholder(text) {
  const s = String(text || '');
  if (/\{\{[^}]+\}\}/.test(s)) return true;
  const brackets = s.match(/\[([^\[\]]+)\]/g) || [];
  return brackets.some(b => !_LEGIT_MARKERS.test(b.slice(1, -1)));
}

// A bare, generic "example company" name (no bracket/brace) a model
// reaches for when it isn't confident of (or didn't retain) the real
// one -- e.g. "XYZ Company" instead of the real employer name. "Acme"
// always requires a trailing corporate suffix so a genuinely real
// company named "Acme <something>" is never flagged.
const _GENERIC_PLACEHOLDER_COMPANY_RE = /\b(?:XYZ|ABC|Acme|Example)\s+(?:Company|Corp(?:oration)?|Inc\.?|Ltd\.?)\b|\bYour\s+Company\b|\bCompany\s+(?:Name|X|Y|Z)\b|\b(?:Company|Employer)\s+A\b/i;
function hasGenericPlaceholderCompany(text) {
  return _GENERIC_PLACEHOLDER_COMPANY_RE.test(String(text || ''));
}

module.exports = { hasUnresolvedPlaceholder, hasGenericPlaceholderCompany };
