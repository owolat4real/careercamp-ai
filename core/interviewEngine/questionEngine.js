'use strict';
/* ═══════════════════════════════════════════════════════════════════
   QUESTION ENGINE — adaptive branching conversation logic.
   Key behaviour:
     - Score < 65 on any answer → follow-up on that topic (max depth 2)
     - Score ≥ 65 → move to next uncovered topic in the phase
     - Phase advances when QUESTIONS_PER_PHASE questions are done
═══════════════════════════════════════════════════════════════════ */
const llm = require('../../engine/llm');

const PHASE_ORDER          = ['technical', 'behavioural', 'soft_skill'];
const QUESTIONS_PER_PHASE  = 3;
const FOLLOW_UP_SCORE_GATE = 65;
const MAX_FOLLOW_UP_DEPTH  = 2;

/* ── SELECT NEXT TOPIC ──────────────────────────────────────── */
function selectNextTopic(phase, interviewPlan, qaHistory) {
  const phaseHistory = qaHistory.filter(qa => qa.competency === phase);
  const topicsKey    = phase === 'technical'   ? 'technicalTopics'
                     : phase === 'behavioural' ? 'behaviouralTopics'
                     :                           'softSkillTopics';
  const topics = interviewPlan[topicsKey] || [];

  const lastQA             = phaseHistory[phaseHistory.length - 1];
  const shouldProbeDeeper  = lastQA
    && lastQA.score < FOLLOW_UP_SCORE_GATE
    && (lastQA.followUpDepth || 0) < MAX_FOLLOW_UP_DEPTH;

  if (shouldProbeDeeper) {
    return { topic: lastQA.topic, isFollowUp: true, prevAnswer: lastQA.answer, prevScore: lastQA.score, depth: (lastQA.followUpDepth || 0) + 1 };
  }

  const coveredTopics = phaseHistory.map(qa => qa.topic);
  const nextTopic     = topics.find(t => !coveredTopics.includes(t)) || topics[0] || `${phase} skills`;
  return { topic: nextTopic, isFollowUp: false, depth: 0 };
}

/* ── GENERATE THE NEXT QUESTION ─────────────────────────────── */
async function generateNextQuestion(session) {
  const { interviewPlan, qaHistory, currentPhase, cvText, jdText, role } = session;
  const { topic, isFollowUp, prevAnswer, prevScore, depth } = selectNextTopic(currentPhase, interviewPlan, qaHistory);

  const allPrevQuestions = qaHistory.map(qa => qa.question).filter(Boolean);

  const followUpContext = isFollowUp
    ? `\nThis is a FOLLOW-UP (depth ${depth}). The candidate's last answer on "${topic}" scored ${prevScore}/100.
Their answer was: "${(prevAnswer || '').slice(0, 400)}"
Ask a sharper, more specific follow-up that probes what was missing or unclear.`
    : `\nThis is a NEW topic in this phase. Ask a fresh, grounded question.`;

  const systemPrompt = `You are CareerLM conducting a structured mock interview for the role of "${role}".
You are in the ${currentPhase.toUpperCase()} phase.

CANDIDATE'S CV (ground questions in their actual background):
${(cvText || '').slice(0, 1500)}

JOB DESCRIPTION:
${(jdText || '').slice(0, 800)}

TOPIC TO EXPLORE: ${topic}${followUpContext}

ALREADY ASKED (never repeat these):
${allPrevQuestions.slice(-8).map((q, i) => `${i + 1}. ${q}`).join('\n') || 'None yet.'}

QUESTION STYLE:
- technical: specific to their actual tech stack / tools from the CV
- behavioural: STAR-format prompt ("Tell me about a time when...")
- soft_skill: scenario-based ("How would you handle...") revealing communication/collaboration

RULES:
- Ask EXACTLY ONE question, under 50 words, conversational interviewer style
- Reference something specific from their CV or the JD when it feels natural
- No preamble, no "Great question!", no multiple questions

Output ONLY valid JSON:
{ "question": "...", "topic": "${topic}" }`;

  let result;
  try {
    result = await llm.infer('Ask the next interview question.', systemPrompt, 'careerlm-base', { temp: 0.7, maxTokens: 200 });
    const raw   = result.text || '';
    const match = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/g, '').trim().match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { question: parsed.question, topic: parsed.topic || topic, followUpDepth: depth };
    }
  } catch (err) {
    console.error('[QUESTION-ENGINE] generateNextQuestion error:', err.message);
  }

  return {
    question:     `Can you tell me more about your experience with ${topic}?`,
    topic,
    followUpDepth: depth,
  };
}

/* ── SCORE AN ANSWER ───────────────────────────────────────── */
async function scoreAnswer(question, answer, competency, cvText) {
  if (!answer || answer.trim().length < 5) {
    return { score: 10, feedback: 'Answer was too short or empty — please elaborate.' };
  }

  const systemPrompt = `You are CareerLM's interview answer scorer.
Score this answer honestly based ONLY on what was actually said — never assume unstated context.

COMPETENCY: ${competency}
QUESTION: ${question}
ANSWER: ${answer}

CANDIDATE'S CV (for consistency-checking only — do not infer unstated detail):
${(cvText || '').slice(0, 800)}

SCORING CRITERIA by competency:
- technical: accuracy, depth, specificity of technical knowledge
- behavioural: STAR structure (Situation, Task, Action, Result), specificity, quantified outcome
- soft_skill: clarity, self-awareness, concrete example vs. vague assertion

BANDS: 85-100 = exceptional; 70-84 = strong; 55-69 = adequate; 40-54 = weak; 0-39 = very poor
A vague, generic answer scores 40 or below even if pleasant.

Output ONLY valid JSON:
{ "score": <integer 0-100>, "feedback": "<one specific, honest sentence — what worked or what was missing>" }`;

  let result;
  try {
    result = await llm.infer('Score this answer now.', systemPrompt, 'careerlm-nano', { temp: 0.3, maxTokens: 150 });
    const raw   = result.text || '';
    const match = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/g, '').trim().match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        score:    Math.min(100, Math.max(0, Number(parsed.score) || 50)),
        feedback: parsed.feedback || 'Answer recorded.',
      };
    }
  } catch (err) {
    console.error('[QUESTION-ENGINE] scoreAnswer error:', err.message);
  }

  return { score: 55, feedback: 'Answer recorded — detailed scoring unavailable.' };
}

/* ── DETERMINE NEXT PHASE ──────────────────────────────────── */
function getNextPhase(session) {
  const doneInPhase = session.qaHistory.filter(qa => qa.competency === session.currentPhase).length;
  if (doneInPhase < QUESTIONS_PER_PHASE) return session.currentPhase;
  const idx = PHASE_ORDER.indexOf(session.currentPhase);
  return PHASE_ORDER[idx + 1] || 'complete';
}

module.exports = { generateNextQuestion, scoreAnswer, getNextPhase, PHASE_ORDER, QUESTIONS_PER_PHASE };
