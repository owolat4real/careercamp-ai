'use strict';
/**
 * PRODUCT AREAS — every major platform section that is NOT a granular
 * AI-task in featureMap.js (calendars, research systems, marketplaces,
 * simulators, community/content hubs, CRUD trackers, etc).
 *
 * Additive only — this never touches FEATURE_MAP or model routing.
 * Feeds maxKnowledgeBase.js so Max can describe these sections too.
 *
 * Each `description` is grounded in real UI copy / route comments found
 * in the codebase (see evidence in the cataloguing pass) — never invented.
 */

const PRODUCT_AREAS = [
  /* ── Office Intelligence ─────────────────────────────────────── */
  { id: 'office_calendar', title: 'Office Command Centre (Week Planner)', domain: 'Office Intelligence',
    description: 'Career ROI for every office decision — not just where to be, but whether being there advances your career.',
    path: '/#office-calendar' },
  { id: 'meeting_intelligence', title: 'Meeting Intelligence', domain: 'Office Intelligence',
    description: 'Classifies every meeting as career-advancing, neutral, or career-draining, calculates its real salary cost, and flags meetings that should have been an email.',
    path: '/#cal-meetings' },
  { id: 'weekly_debrief', title: 'Career Week Debrief', domain: 'Office Intelligence',
    description: 'A weekly career performance review from AI — XP earned, momentum delta, and a concrete playbook for next week.',
    path: '/#cal-debrief' },
  { id: 'office_network_intelligence', title: 'Network Map (Office Calendar)', domain: 'Office Intelligence',
    description: 'Tracks relationship temperature, flags cooling professional connections before they go cold, and maps influence pathways to your next promotion.',
    path: '/#cal-network' },
  { id: 'meeting_room', title: 'Meeting Room', domain: 'Office Intelligence',
    description: 'Live video meetings with an AI co-pilot — pre-meeting briefs, a live question bank, in-call suggestions, and a post-meeting debrief.',
    path: '/meeting-room' },

  /* ── Growth & Leads ───────────────────────────────────────────── */
  { id: 'lead_generation', title: 'Lead Generation Platform', domain: 'Growth & Leads',
    description: 'B2B lead intelligence — discover leads, enrich data, score and qualify, build ICPs, automate multichannel outreach, verify emails and phones, monitor intent signals, and manage the pipeline. GDPR/CCPA/CAN-SPAM compliant.',
    path: '/#leads' },

  /* ── Automation & Agents ──────────────────────────────────────── */
  { id: 'work_automation', title: 'Work Automation', domain: 'Automation & Agents',
    description: 'AI builds ready-to-use automation workflows, generates the code, creates a shareable URL, and emails it to you. Includes a template library, and PaaS/IaaS/SaaS builders.',
    path: '/#automation' },
  { id: 'ai_job_search_agent', title: 'AI Job Hunter (Autonomous Job Agent)', domain: 'Automation & Agents',
    description: 'A 24/7 multi-agent pipeline that scans, matches, tailors, and applies to jobs autonomously across dedicated planner, resume, search, matching, cover-letter, application, and notification agents.',
    path: '/job-hunter' },
  { id: 'app_factory', title: 'AI App Factory', domain: 'Automation & Agents',
    description: 'An AI coding-agent workspace that scaffolds full projects (Node/Express, Next.js, React+Vite, static sites) with file editing, plugin installs, env-var management, rollback, and deploy.',
    path: '/app-factory' },
  { id: 'bot_builder', title: 'Bot Builder', domain: 'Automation & Agents',
    description: 'Build your own WhatsApp agent, Telegram bot, or email automation with AI — no coding needed.',
    path: '/#bots' },
  { id: 'application_assist', title: 'Application Assistant', domain: 'Automation & Agents',
    description: 'AI tailors a CV and cover letter per job with honest risk labelling and hard rate limits. Only direct-ATS submission (Workday/Greenhouse/Lever) is automated — LinkedIn, Indeed, and Glassdoor always require your own manual click.',
    path: '/api/application-assist' },

  /* ── Research Platforms ───────────────────────────────────────── */
  { id: 'nexus_research', title: 'NEXUS AI Research Systems', domain: 'Research Platforms',
    description: 'A set of advanced AI research engines covering career world-modelling, causal reasoning, collective intelligence, adversarial red-teaming, and more.',
    path: '/#nexus' },
  { id: 'cstm_intelligence_heads', title: 'CSTM-1 Intelligence Heads', domain: 'Research Platforms',
    description: 'Five precision career-intelligence tasks powered by CSTM-1, a model trained on career data: job matching, salary intelligence, career path, resume scoring, and skill gap.',
    path: '/#cstm-intel' },
  { id: 'data_intelligence_agent', title: 'Data Intelligence Agent', domain: 'Research Platforms',
    description: 'A live scan of emerging skills, declining roles, hot markets, industry hiring signals, and AI disruption risk across countries.',
    path: '/#data-intel' },
  { id: 'model_intelligence', title: 'Model Intelligence', domain: 'Research Platforms',
    description: 'Shows CSTM-1 model status, knowledge domain freshness, training data sources, update schedule, and changelog.',
    path: '/#model-intel' },
  { id: 'developer_portal', title: 'Developer Portal', domain: 'Research Platforms',
    description: 'Integrate CareerStudioMax AI into your own application — isolated API credentials, multi-language code examples, and a live API playground.',
    path: '/developer' },
  { id: 'camp_platform', title: 'CAMP Career AI Model Platform', domain: 'Research Platforms',
    description: 'A multimodal AI platform spanning text, voice, video, embeddings, agent, and scoring model families, plus a career web-intelligence layer covering many platforms and countries.',
    path: '/#camp' },
  { id: 'cstm2_developer_api', title: 'CSTM-2 Developer API', domain: 'Research Platforms',
    description: 'Seven isolated model families, each with its own credentials, prefix-enforced auth, and rate limits, for building career intelligence into other products.',
    path: '/#cstm2' },
  { id: 'transformer_engine', title: 'Career Transformer Engine', domain: 'Research Platforms',
    description: 'A NER + transformer API that extracts career entities, builds knowledge graphs, and precision-matches candidates to jobs via REST API.',
    path: '/#transformer' },

  /* ── Marketplace ───────────────────────────────────────────────── */
  { id: 'job_marketplace', title: 'Marketplace (jobs, internships & employers)', domain: 'Marketplace',
    description: 'A tri-sided marketplace: employers post jobs, candidates browse jobs and internships and apply, and recruiters operate their own side — with a My Activity panel and employer-candidate messaging.',
    path: '/marketplace' },
  { id: 'integration_marketplace', title: 'Integration Marketplace', domain: 'Marketplace',
    description: 'Connect third-party tools across many categories in seconds; integration credentials are stored encrypted at rest.',
    path: '/#integration-market' },

  /* ── Simulation & Future Intelligence ─────────────────────────── */
  { id: 'career_intelligence_bets', title: 'Career Intelligence Bets (Career Time Machine)', domain: 'Simulation & Future Intelligence',
    description: 'AI-modelled predictions on your career trajectory, industry disruption, and the optimal timing for major moves — staying, leaving, switching industries, or going freelance — each scored with probability, payoff, and risk.',
    path: '/#betting' },
  { id: 'life_simulator', title: 'Life Simulator', domain: 'Simulation & Future Intelligence',
    description: 'Simulates parallel career paths — micro-internships, shadow days, decision stress tests, skill heatmaps, opportunity timing, and life trade-off sliders.',
    path: '/#life-sim' },
  { id: 'future_self_engine', title: 'Future Self Engine', domain: 'Simulation & Future Intelligence',
    description: 'Simulates your daily routine, emotional state, and income 5-10 years ahead for a chosen path, forecasts regret probability, and maps your career timeline.',
    path: '/#future-self' },
  { id: 'future_self_chat', title: 'Talk to Future Me', domain: 'Simulation & Future Intelligence',
    description: 'A live AI conversation with four versions of your future self — the successful one, the burnt-out one, the fearful one, and the authentic one.',
    path: '/#ai-self-chat' },
  { id: 'identity_mind', title: 'Identity Mind', domain: 'Simulation & Future Intelligence',
    description: 'Scores your personality against career fit, detects identity drift over time, and alerts you when your current trajectory is misaligned with who you are.',
    path: '/#identity-mind' },
  { id: 'psychology_layer', title: 'Psychology Layer', domain: 'Simulation & Future Intelligence',
    description: 'A burnout-risk predictor, a meaning-vs-money analyser grounded in happiness economics, and a career regret story engine.',
    path: '/#psychology-layer' },

  /* ── Career Intelligence ──────────────────────────────────────── */
  { id: 'skill_gap_simulator', title: 'Skill Gap Simulator (Career GPS)', domain: 'Career Intelligence',
    description: 'Pinpoints exactly what skills you need to reach a target role, given your current role, skills, timeline, and country.',
    path: '/#skillgap' },

  /* ── Career Tools ──────────────────────────────────────────────── */
  { id: 'goals_tracker', title: 'Goals Tracker', domain: 'Career Tools',
    description: 'Set, track, and achieve career milestones by breaking big ambitions into measurable goals.',
    path: '/#goals' },
  { id: 'achievements_tracker', title: 'Career Achievements', domain: 'Career Tools',
    description: 'Document your wins, quantify your impact, and build a bank of STAR stories for interviews.',
    path: '/#achievements' },
  { id: 'references_manager', title: 'Professional References', domain: 'Career Tools',
    description: 'Manage reference contacts and generate tailored outreach emails to them instantly.',
    path: '/#references' },
  { id: 'certifications_tracker', title: 'Certification Tracker', domain: 'Career Tools',
    description: 'Tracks your credentials, warns before they expire, and lets AI recommend what to earn next.',
    path: '/#certifications' },
  { id: 'scholarships_finder', title: 'Scholarships & Funding', domain: 'Career Tools',
    description: 'AI-powered scholarship search across government, corporate, university, and professional-body grants.',
    path: '/#scholarships' },
  { id: 'visa_guidance', title: 'Visa Guidance', domain: 'Career Tools',
    description: 'AI-powered visa intelligence for work, study, and relocation, covering requirements, timelines, and costs.',
    path: '/#visa' },

  /* ── Create & Media ────────────────────────────────────────────── */
  { id: 'portfolio_builder', title: 'Portfolio (Living Career Identity)', domain: 'Create & Media',
    description: 'An AI-generated, live public portfolio site built entirely from your real profile data and live computation — no hardcoded content.',
    path: '/#portfolio' },
  { id: 'video_intelligence', title: 'CSVM-1 Video Intelligence', domain: 'Create & Media',
    description: 'Watches and understands video content to extract structured career intelligence — analysing interviews, extracting salary data, coaching your on-camera performance, and curating a learning library.',
    path: '/#video-intel' },
  { id: 'media_studio', title: 'Media Studio', domain: 'Create & Media',
    description: 'An AI content engine that generates images, video scripts, HTML artifacts, and content packages, all downloadable in one click.',
    path: '/#media' },

  /* ── Market & Global ───────────────────────────────────────────── */
  { id: 'job_platform_hub', title: 'Job Platform Hub', domain: 'Market & Global',
    description: 'A directory of global job platforms filterable by tier, specialty, and country, with direct apply links.',
    path: '/#platforms' },

  /* ── Community & Content ──────────────────────────────────────── */
  { id: 'community_hub', title: 'Career Community', domain: 'Community & Content',
    description: 'Connect with professionals across fields globally — share wins, ask questions, and grow together.',
    path: '/#community' },
  { id: 'career_blog', title: 'Career Blog', domain: 'Community & Content',
    description: 'AI-written career articles, insights, and guides — read published posts or write your own with the AI Blog Writer.',
    path: '/#blog' },
  { id: 'knowledge_base', title: 'Career Knowledge Base', domain: 'Community & Content',
    description: 'A live-indexed hub of answers to career questions, grounded with real market data and salary intelligence.',
    path: '/#knowledge' },
  { id: 'tools_library', title: 'Career Tools Library', domain: 'Community & Content',
    description: 'A directory of career tools rated, compared, and matched to your role and budget — from resume builders to salary databases to networking platforms.',
    path: '/#tools-lib' },

  /* ── Analytics & Notifications ─────────────────────────────────── */
  { id: 'analytics_dashboard', title: 'Performance Analytics', domain: 'Analytics & Notifications',
    description: 'A live dashboard tracking your career progress, session scores, confidence trends, and badge achievements.',
    path: '/#analytics' },
  { id: 'smart_notifications', title: 'Smart Notifications', domain: 'Analytics & Notifications',
    description: 'Job alerts, career milestones, and market intelligence delivered to email, Telegram, and WhatsApp.',
    path: '/#notifications' },
  { id: 'activity_tracker', title: 'Activity Tracker (My Activity)', domain: 'Analytics & Notifications',
    description: 'Cross-platform activity and XP tracking — applications, saved jobs, posting history — feeding the Weekly Debrief XP system.',
    path: '/#myactivity' },

  /* ── Novelty / Personalization ─────────────────────────────────── */
  { id: 'cosmic_intelligence', title: 'Cosmic Intelligence', domain: 'Novelty / Personalization',
    description: 'A date-of-birth-powered astrology, numerology, and career-oracle widget, computed live from real data.',
    path: '/#cosmic' },
];

module.exports = { PRODUCT_AREAS };
