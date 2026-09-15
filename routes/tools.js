'use strict';
/**
 * /v1/tools/:toolId — Tool Intelligence endpoints.
 * Analyse any professional tool: demand score, salary premium, learning path.
 */
const express = require('express');
const router  = express.Router();
const { infer } = require('../engine/inferenceEngine');

// Auth: enforced by core/gatewayAuth.js's centralized `authorize(['secret'])`
// policy at this router's mount point in server.js. A router-local
// apiKeyGuard checking CS_TRANSFORMER_API_KEY/CAREERCAMP_API_KEY used to
// live here too -- removed 2026-09-15 (CS-1 gateway auth review) because it
// conflicted with the outer 'secret'-class policy. See routes/inference.js's
// identical comment for the full rationale.

/* POST /v1/tools/:toolId — analyse a specific tool */
router.post('/:toolId', async (req, res) => {
  const { toolId } = req.params;
  const { userId, userRole, country, language, currentLevel } = req.body;

  const toolName = toolId.replace(/-/g, ' ');
  const prompt   = `Analyse ${toolName} for a ${userRole || 'professional'} in ${country || 'the UK'}.
Provide:
1. Demand Score (0-100) based on job posting frequency
2. Current salary premium for proficiency (%)
3. Proficiency levels: L1 Aware → L5 Expert learning path
4. Top 5 job titles that require or prefer this tool
5. 3 quick wins to reach L3 Proficient in under 30 days
6. Complementary tools to learn alongside ${toolName}
Current user level: ${currentLevel || 'L1 Aware'}`;

  try {
    const result = await infer({
      userInput:  prompt,
      userId,
      featureId:  `tools_${toolId}`,
      task:       'tool_analysis',
      language,
      toolName,
    });
    res.json({ success: true, toolId, toolName, ...result });
  } catch (err) {
    console.error(`[/v1/tools/${toolId}] Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* POST /v1/tools/:toolId/compare — compare two tools */
router.post('/:toolId/compare', async (req, res) => {
  const { toolId }                  = req.params;
  const { compareWith, userId, country, language } = req.body;

  if (!compareWith) return res.status(400).json({ error: 'compareWith is required' });

  const tool1 = toolId.replace(/-/g, ' ');
  const tool2 = compareWith.replace(/-/g, ' ');

  const prompt = `Compare ${tool1} vs ${tool2} for a professional career in ${country || 'the UK'}.
Include:
1. Demand trend (6 months)
2. Salary premium each adds to your package
3. Learning time to proficiency for each
4. Which to learn first and why
5. Can they be used together? Synergies?`;

  try {
    const result = await infer({ userInput: prompt, userId, featureId: 'tools_compare', task: 'tool_analysis', language });
    res.json({ success: true, tools: [tool1, tool2], ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
