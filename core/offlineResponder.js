'use strict';

/**
 * offlineResponder — zero-dependency last-resort fallback.
 *
 * When every provider (Ollama, Groq, OpenRouter, HuggingFace) is down,
 * users must NEVER see a dead-end error. This module always returns a
 * useful, honest, structured response so the UI never goes blank.
 *
 * This is Pattern 2 defense: guaranteed provider, no network required.
 */

const RETRY_ADVICE = `
**What happened:** CareerLM's AI engines are temporarily unreachable. This has been logged automatically.

**What to do right now:**
1. Wait 15–30 seconds and click Generate again — this usually self-resolves as models reload
2. If you see this a second time, check that the CareerCamp AI service is running
3. Your question was not lost — try again and you'll get a full response

We're sorry for the interruption. Career Studio never leaves you with a blank screen.
`.trim();

/**
 * Build a structured offline response for any feature.
 *
 * @param {string} featureId   — the feature that failed (for logging context)
 * @param {string} userInput   — what the user asked (echoed back so they don't lose it)
 * @returns {string}           — a complete, useful SIPS-R formatted response
 */
function buildOfflineResponse(featureId = 'unknown', userInput = '') {
  const inputPreview = userInput ? userInput.slice(0, 200) : '';
  const featureHint  = _featureHint(featureId);

  return `⚡ ${featureHint.title}

${featureHint.body}

---

${inputPreview ? `**Your question:** ${inputPreview}\n\n` : ''}${RETRY_ADVICE}

<!--FOLLOWUPS
1. Try asking this question again — AI reconnects within 15–30 seconds
2. Check Career Studio system status
3. Contact support if this persists for more than 2 minutes
FOLLOWUPS-->`;
}

/**
 * Build an offline response suitable for SSE streaming — returns an array
 * of content chunks that can be yielded one by one to the client.
 */
function buildOfflineChunks(featureId, userInput) {
  return [buildOfflineResponse(featureId, userInput)];
}

/* Map a featureId to a more helpful hint for the user's specific context */
function _featureHint(featureId) {
  const f = (featureId || '').toLowerCase();
  if (f.includes('salary') || f.includes('negotiat')) {
    return {
      title: 'Salary Intelligence — Temporary Service Interruption',
      body: 'Our salary benchmark engine is reconnecting. In the meantime: mid-market salary data for most roles is available on LinkedIn Salary, Glassdoor, and Levels.fyi. For your negotiation, a safe floor is your current salary + 15–20% for a lateral move, + 25–30% for a step up.',
    };
  }
  if (f.includes('cv') || f.includes('resume') || f.includes('bullet')) {
    return {
      title: 'CV Writing Engine — Temporary Service Interruption',
      body: 'Our CV engine is reconnecting. Quick rule while it recovers: every bullet point should follow [Strong verb] + [What you did] + [Quantified impact]. Use Delivered, Built, Reduced, or Increased — never "Responsible for" or "Helped with".',
    };
  }
  if (f.includes('cover')) {
    return {
      title: 'Cover Letter Engine — Temporary Service Interruption',
      body: 'Our cover letter engine is reconnecting. Strong openers to use while it recovers: start with a specific company insight, a quantified achievement, or the exact problem the role solves. Never open with "I am writing to apply for...".',
    };
  }
  if (f.includes('interview')) {
    return {
      title: 'Interview Coach — Temporary Service Interruption',
      body: 'Our interview engine is reconnecting. Preparation tip: for every role, prepare 3 STAR stories (Situation, Task, Action, Result) that demonstrate impact with real numbers. Research the company\'s last earnings call or press release for a talking point that will impress.',
    };
  }
  if (f.includes('skill') || f.includes('gap')) {
    return {
      title: 'Skills Gap Analyst — Temporary Service Interruption',
      body: 'Our skills engine is reconnecting. To identify gaps yourself: find 5 job postings for your target role and highlight every skill that appears in 3 or more of them. The ones you don\'t have are your priority gaps.',
    };
  }
  if (f.includes('job') || f.includes('match')) {
    return {
      title: 'Job Match Engine — Temporary Service Interruption',
      body: 'Our job match engine is reconnecting. Quick self-assessment: count how many of the top 5 requirements in the job description you can demonstrate with a real example. 4 out of 5 = strong match. 3 out of 5 = worth applying with a tailored cover letter.',
    };
  }
  return {
    title: 'CareerLM AI — Temporary Service Interruption',
    body: 'Our AI is reconnecting. It will be available again in 15–30 seconds. Try your question again momentarily.',
  };
}

module.exports = { buildOfflineResponse, buildOfflineChunks };
