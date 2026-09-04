'use strict';
/**
 * SELF-CONTRADICTION + UNEARNED-CITATION GUARD.
 *
 * Ported into careercamp-ai (2026-09-04) from cs_fixed/services/
 * careerAdviceGuard.js -- real gap closed: this service is the actual
 * CSTM-1 inference backend behind /v1/camp/:featureId (the endpoint
 * api-platform's campProxy.js calls for every external developer
 * request), and had no internal-self-consistency check on generated
 * text at all -- only engine/guardrails.js's 7-point ETHICS filter,
 * a materially different check (discrimination/fraud/crisis/etc., not
 * "does this response contradict itself" or "does it cite a search it
 * never actually ran"). Same real logic as cs_fixed's copy, no
 * re-implementation.
 *
 * A real, distinct bug class from a source-document fabrication check
 * (which verifies a generated name/number traces back to a supplied
 * SOURCE DOCUMENT). This checks INTERNAL self-consistency within the
 * generated text itself: a field the model marks unknown/unverified,
 * followed later in the SAME response by a specific percentage presented
 * as if derived from that same unverified field.
 */

const UNCERTAINTY_MARKERS = /\[unknown\]|not (?:yet )?verified|needs verification|assuming (?:a|an|this|that)|unclear from the input|no (?:current role|information) (?:was )?(?:provided|given|supplied)/i;
const PERCENT_RE = /\d{1,3}\s?%/;
const UNEARNED_CITATION_RE = /based on (?:current|recent|live|the latest) (?:market trends|data|research)|according to (?:current|recent) (?:job postings|listings|data)|(?:recent|current) [^.]{0,30}job postings|market data shows|research (?:shows|indicates) that/i;

function checkSelfContradiction(text) {
  if (!text) return { flagged: false, reason: null };
  const uncertaintyMatch = text.match(UNCERTAINTY_MARKERS);
  if (!uncertaintyMatch) return { flagged: false, reason: null };
  const afterMarker = text.slice(uncertaintyMatch.index + uncertaintyMatch[0].length);
  if (PERCENT_RE.test(afterMarker)) {
    return { flagged: true, reason: `Marked "${uncertaintyMatch[0]}" as uncertain, then still gave a specific percentage later in the same response.` };
  }
  return { flagged: false, reason: null };
}

function checkUnearnedCitation(text) {
  if (!text) return { flagged: false, reason: null };
  const match = text.match(UNEARNED_CITATION_RE);
  if (match) return { flagged: true, reason: `Claimed "${match[0]}" with no real search/grounding tool call behind this generation.` };
  return { flagged: false, reason: null };
}

module.exports = { checkSelfContradiction, checkUnearnedCitation };
