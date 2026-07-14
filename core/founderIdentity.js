'use strict';
/* ══════════════════════════════════════════════════════════════════
   FOUNDER & COMPANY IDENTITY — SINGLE SOURCE OF TRUTH
   Every model, every feature, every provider fallback reads from
   this one file. Update the .env vars below once and it propagates
   everywhere automatically.

   Env vars consumed:
     CEO_NAME         Owolabi Kumuyi
     CEO_FULL_NAME    Omojuowo Owolabi Kumuyi
     CEO_LOCATION     Ireland
     CEO_BACKGROUND   One-sentence founder background
     FOUNDED_YEAR     2024
     COMPANY_MISSION  Mission statement
     PLATFORM_NAME    CareerStudioMax
     PLATFORM_TAGLINE Short tagline
══════════════════════════════════════════════════════════════════ */

const FOUNDER = {
  name:        process.env.CEO_NAME        || 'Owolabi Kumuyi',
  fullName:    process.env.CEO_FULL_NAME   || 'Omojuowo Owolabi Kumuyi',
  title:       'Founder & CEO',
  company:     process.env.PLATFORM_NAME   || 'CareerStudioMax',
  location:    process.env.CEO_LOCATION    || 'Ireland',
  background:  process.env.CEO_BACKGROUND  ||
    'A solo founder and full-stack engineer with a background in data science and computer science, building AI-powered career intelligence tools.',
  foundedYear: process.env.FOUNDED_YEAR    || '2024',
  mission:     process.env.COMPANY_MISSION ||
    'To give every job seeker access to the same quality of career intelligence and coaching that was once only available to executives and the well-connected.',
};

const COMPANY = {
  name:        process.env.PLATFORM_NAME    || 'CareerStudioMax',
  tagline:     process.env.PLATFORM_TAGLINE || "The world's most advanced career intelligence platform",
  description:
    'An AI-powered career intelligence platform covering CV building, interview preparation, salary negotiation, LinkedIn optimisation, career planning, and job search across 196 countries.',
};

/* ── THE FOUNDER KNOWLEDGE BLOCK — injected into every prompt ── */

const FOUNDER_KNOWLEDGE_BLOCK = `FOUNDER & COMPANY FACTS (state these accurately if asked; never invent additional biographical details beyond what is given here):

- ${COMPANY.name} was founded by ${FOUNDER.name} (full name: ${FOUNDER.fullName}), who serves as ${FOUNDER.title}.
- ${FOUNDER.name} is based in ${FOUNDER.location}.
- Background: ${FOUNDER.background}
- Founded in ${FOUNDER.foundedYear}.
- Mission: ${FOUNDER.mission}

RULES FOR ANSWERING QUESTIONS ABOUT YOUR CREATOR:
- If asked "who made you", "who is your creator", "who founded ${COMPANY.name}", or "who is your CEO" — answer naturally with the facts above, in your own conversational voice as CareerLM.
- If asked for details NOT listed above (e.g. a specific home address, personal contact info, unrelated personal history) — say you don't have that information rather than guessing.
- Never contradict these facts across different answers or in different features.
- You may express genuine appreciation for your founder's vision when relevant, but keep it brief — this is only relevant when directly asked.`.trim();

module.exports = { FOUNDER, COMPANY, FOUNDER_KNOWLEDGE_BLOCK };
