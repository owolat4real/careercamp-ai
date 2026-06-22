'use strict';
const router = require('express').Router();

// POST /v1/agent/run — ReAct agentic loop with internet + BERT tools
router.post('/run', async (req, res) => {
  const { llm, bert, internet, context } = req.engines;
  const { task, input, userCtx = {}, maxSteps = 5 } = req.body;

  if (!task || !input) return res.status(400).json({ error: { message: 'task and input required' } });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  try {
    send({ type: 'start', agent: 'careeragent-v1', task });

    const TOOLS = {
      search_jobs:     async (q) => { const r = await internet.search(q + ' jobs hiring 2025', { count: 5 }); return JSON.stringify(r.results?.slice(0,3)); },
      get_salary:      async (role, loc) => { const r = await internet.getLiveSalaryData(role, loc); return JSON.stringify(r); },
      score_resume:    async (text, jd) => { const r = await bert.matchResumeJD(text, jd); return JSON.stringify(r); },
      extract_skills:  async (text) => { const r = await bert.extractSkills(text); return JSON.stringify(r.slice(0,20)); },
      company_intel:   async (co) => { const r = await internet.getCompanyNews(co); return JSON.stringify(r); },
      market_trends:   async (career, country) => { const r = await internet.getJobMarketTrends(career, country); return JSON.stringify(r); },
    };

    const sys = await context.buildFullContext(input, userCtx);
    const toolDefs = Object.keys(TOOLS).map(t => `- ${t}(${t === 'get_salary' ? 'role, location' : t === 'market_trends' ? 'career, country' : 'query'}) — use for ${t.replace(/_/g,' ')}`).join('\n');

    let history = [
      { role: 'system', content: sys + `\n\nAvailable tools:\n${toolDefs}\n\nThink step by step. Use TOOL: tool_name(args) to call tools. When done, write FINAL: answer.` },
      { role: 'user',   content: `Task: ${task}\nInput: ${input}` },
    ];

    let steps = 0;
    while (steps < maxSteps) {
      const { text } = await llm.infer(history[history.length-1].content, sys, 'careeragent-v1', { maxTokens: 2000 });
      send({ type: 'thinking', text: text.slice(0, 200) });

      const toolMatch = text.match(/TOOL:\s*(\w+)\(([^)]*)\)/);
      if (toolMatch) {
        const [, toolName, argsStr] = toolMatch;
        const args = argsStr.split(',').map(a => a.trim().replace(/['"]/g, ''));
        send({ type: 'tool_use', tool: toolName, args });
        try {
          const toolResult = await TOOLS[toolName]?.(...args) || 'Tool not found';
          send({ type: 'tool_result', tool: toolName, result: toolResult.slice(0, 500) });
          history.push({ role: 'assistant', content: text });
          history.push({ role: 'user', content: `Tool result for ${toolName}: ${toolResult}` });
        } catch (e) {
          history.push({ role: 'user', content: `Tool ${toolName} failed: ${e.message}` });
        }
      } else if (text.includes('FINAL:')) {
        const finalAnswer = text.split('FINAL:').slice(1).join('').trim();
        send({ type: 'text', text: finalAnswer });
        send({ type: 'done', engine: 'careeragent-v1', steps: steps + 1 });
        res.end();
        return;
      } else {
        send({ type: 'text', text });
        send({ type: 'done', engine: 'careeragent-v1', steps: steps + 1 });
        res.end();
        return;
      }
      steps++;
    }

    send({ type: 'done', engine: 'careeragent-v1', steps, note: 'max steps reached' });
    res.end();
  } catch (e) {
    send({ type: 'error', error: e.message });
    res.end();
  }
});

module.exports = router;
