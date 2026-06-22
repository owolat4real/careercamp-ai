/**
 * ═══════════════════════════════════════════════════════════════════════
 * MULTIMODAL ENGINE — Unified Cross-Modal Intelligence
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Fuses text + image + audio + video + web data into a single coherent
 * career intelligence response. This is what makes CareerCamp AI
 * world-first — no other career platform does full multimodal fusion.
 *
 * Use cases:
 *   • CV image + JD text → full match analysis with visual CV scoring
 *   • Interview video → transcript + body language + STAR analysis
 *   • Portfolio screenshot → visual quality + content analysis + career fit
 *   • LinkedIn screenshot + career goals → gap analysis + action plan
 *   • Voice answer + question text → full interview coaching
 *   • Company website screenshot → culture signals + fit assessment
 */

'use strict';

const vlm      = require('./vlm');
const voice    = require('./voice');
const careerBERT = require('./careerbert');
const internet = require('./internet');

// ═══════════════════════════════════════════════════════════
// MULTIMODAL FUSION FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Full CV analysis: image OCR + ATS scoring + JD matching
 */
async function analyzeCVImage(cvImageInput, jdText = '', options = {}) {
  // Step 1: Visual analysis
  const visual = await vlm.analyzeImage(cvImageInput, 'resume', options);

  // Step 2: Extract text from visual analysis
  const extractedText = visual.text || '';

  // Step 3: BERT-based matching if JD provided
  let match = null;
  if (jdText && extractedText.length > 50) {
    match = await careerBERT.matchResumeJD(extractedText, jdText);
  }

  // Step 4: BERT skill extraction
  const skills = await careerBERT.extractSkills(extractedText);
  const stage  = careerBERT.detectCareerStage(extractedText);

  return {
    type:          'cv_analysis',
    visualAnalysis: visual.text,
    engine:         visual.engine,
    extractedText,
    skills:         skills.slice(0, 20),
    careerStage:    stage,
    jdMatch:        match,
    score: match ? match.score : null,
  };
}

/**
 * Interview session analysis: video frames + audio transcript + STAR scoring
 */
async function analyzeInterviewSession(frames, audioInput, question, options = {}) {
  const results = {};

  // Parallel: visual analysis + transcript
  const [videoAnalysis, sttResult] = await Promise.allSettled([
    frames?.length ? vlm.analyzeVideoFrames(frames, 'interview_frame') : Promise.resolve(null),
    audioInput     ? voice.transcribe(audioInput, options)              : Promise.resolve(null),
  ]);

  if (videoAnalysis.status === 'fulfilled' && videoAnalysis.value) {
    results.videoAnalysis = videoAnalysis.value;
  }
  if (sttResult.status === 'fulfilled' && sttResult.value) {
    results.transcript = sttResult.value.text;
    results.sttEngine  = sttResult.value.engine;
  }

  // BERT interview scoring on transcript
  if (results.transcript) {
    results.answerScore  = careerBERT.scoreInterviewAnswer(results.transcript);
    results.fillerWords  = voice.analyzeInterviewAnswer ? 0 : 0;
  }

  // Aggregate scores
  const videoScore = videoAnalysis.value?.aggregateScores;
  const bertScore  = results.answerScore?.score || 0;
  results.overallScore = Math.round(
    (bertScore * 0.5) +
    ((videoScore?.eyeContact  || 70) * 0.3) +
    ((videoScore?.posture      || 70) * 0.2)
  );
  results.question = question;

  return results;
}

/**
 * Portfolio visual intelligence
 */
async function analyzePortfolio(imageInput, careerContext = {}) {
  const [visual, skills] = await Promise.all([
    vlm.analyzeImage(imageInput, 'portfolio'),
    careerContext.about ? careerBERT.extractSkills(careerContext.about) : Promise.resolve([]),
  ]);

  return {
    type:           'portfolio_analysis',
    visualAnalysis: visual.text,
    engine:         visual.engine,
    skillsFromProfile: skills,
    careerContext,
  };
}

/**
 * Full career document intelligence (multi-page PDF support via frames)
 */
async function analyzeCareerDocument(imageFrames, documentType = 'resume', context = {}) {
  const pageResults = await Promise.all(
    imageFrames.slice(0, 8).map((frame, i) =>
      vlm.analyzeImage(frame, documentType, context).then(r => ({ page: i + 1, ...r }))
    )
  );

  // Combine all page text
  const fullText = pageResults.map(r => r.text || '').join('\n\n---PAGE BREAK---\n\n');

  // Extract skills and stage from combined text
  const [skills, stage, burnout] = await Promise.all([
    careerBERT.extractSkills(fullText),
    Promise.resolve(careerBERT.detectCareerStage(fullText)),
    context.checkBurnout ? Promise.resolve(careerBERT.detectBurnout(fullText)) : Promise.resolve(null),
  ]);

  return {
    type:         'career_document',
    documentType,
    pages:        pageResults.length,
    fullText,
    skills:       skills.slice(0, 30),
    careerStage:  stage,
    burnoutSignals: burnout,
  };
}

/**
 * Company intelligence: website screenshot + news + culture analysis
 */
async function analyzeCompany(screenshotInput, companyName, ctx = {}) {
  const [visual, news] = await Promise.all([
    screenshotInput ? vlm.analyzeImage(screenshotInput, 'portfolio') : Promise.resolve({ text: '' }),
    internet.getCompanyNews(companyName),
  ]);

  return {
    type:         'company_intelligence',
    company:      companyName,
    websiteAnalysis: visual.text,
    recentNews:   (news.news || []).slice(0, 5),
    cultureSignals: extractCultureSignals(visual.text + ' ' + (news.news || []).map(n => n.snippet).join(' ')),
  };
}

function extractCultureSignals(text) {
  const signals = {
    remote_friendly:  /\b(remote|hybrid|flexible|work.?from.?home|distributed)\b/i.test(text),
    startup_culture:  /\b(startup|fast.?paced|agile|move fast|scale|series [a-d])\b/i.test(text),
    enterprise:       /\b(enterprise|fortune 500|global|corporate|established|compliance)\b/i.test(text),
    dei_focused:      /\b(diversity|inclusion|equity|belonging|erg|employee.?resource)\b/i.test(text),
    growth_focused:   /\b(grow|learn|develop|training|mentorship|career.?path)\b/i.test(text),
    mission_driven:   /\b(mission|purpose|impact|change|transform|social.?good)\b/i.test(text),
  };
  return Object.entries(signals).filter(([, v]) => v).map(([k]) => k);
}

module.exports = {
  async init() {},
  analyzeCVImage,
  analyzeInterviewSession,
  analyzePortfolio,
  analyzeCareerDocument,
  analyzeCompany,
};
