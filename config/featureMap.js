'use strict';
/**
 * FEATURE MAP — Every one of 274 Career Studio features mapped to:
 *   model:      which local model handles it
 *   maxTokens:  token budget
 *   schema:     expected output format (null = free text)
 *   streaming:  whether to stream the response
 *   piiScrub:   whether input contains PII risk
 *   task:       system prompt variant
 */

const FEATURE_MAP = {

  /* ── RESUME INTELLIGENCE (Features 1-35) ───────────────────── */
  'resume_scorer':               { model:'cs-sonnet', maxTokens:800,  schema:'score_report',    streaming:false, piiScrub:true,  task:'cv_analysis'    },
  'resume_auto_optimiser':       { model:'cs-sonnet', maxTokens:1200, schema:'cv_rewrite',      streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'resume_rewriter':             { model:'cs-sonnet', maxTokens:1500, schema:'cv_rewrite',      streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'ats_keyword_heatmap':         { model:'cs-sonnet', maxTokens:600,  schema:'keyword_map',     streaming:false, piiScrub:true,  task:'ats_analysis'   },
  'achievement_quantifier':      { model:'cs-sonnet', maxTokens:400,  schema:'cv_bullet',       streaming:false, piiScrub:true,  task:'cv_bullet'      },
  'impact_scorer':               { model:'cs-haiku',  maxTokens:200,  schema:'impact_score',    streaming:false, piiScrub:false, task:'classify'       },
  'cv_gap_detector':             { model:'cs-sonnet', maxTokens:600,  schema:'gap_report',      streaming:false, piiScrub:true,  task:'gap_analysis'   },
  'action_verb_optimizer':       { model:'cs-haiku',  maxTokens:150,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_formatter':                { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:true,  task:'summarise'      },
  'cv_length_analyser':          { model:'cs-haiku',  maxTokens:100,  schema:'length_report',   streaming:false, piiScrub:false, task:'classify'       },
  'cv_design_checker':           { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'multi_version_manager':       { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:false, piiScrub:true,  task:'cv_analysis'    },
  'cv_tailoring_engine':         { model:'cs-sonnet', maxTokens:1200, schema:'cv_rewrite',      streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'linkedin_cv_sync':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:true,  task:'career_advice'  },
  'cv_portfolio_bridge':         { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'career_advice'  },

  /* ── RESUME INTELLIGENCE continued (Features 16-35) ──────── */
  'cv_personal_statement':       { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'cv_skills_section':           { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'cv_rewrite'     },
  'cv_education_optimiser':      { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_hobbies_advisor':          { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_career_break_writer':      { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'cv_rewrite'     },
  'cv_graduate_template':        { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'cv_executive_template':       { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'cv_tech_template':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'cv_creative_template':        { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'cv_referees_section':         { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:true,  task:'quick_reply'    },
  'cv_languages_section':        { model:'cs-haiku',  maxTokens:150,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_volunteer_section':        { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_projects_section':         { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'cv_rewrite'     },
  'cv_publications_section':     { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_awards_section':           { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_certifications_section':   { model:'cs-haiku',  maxTokens:250,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_linkedin_url_advisor':     { model:'cs-haiku',  maxTokens:100,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'cv_header_optimiser':         { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:true,  task:'quick_reply'    },
  'cv_keywords_extractor':       { model:'cs-sonnet', maxTokens:400,  schema:'keyword_map',     streaming:false, piiScrub:false, task:'ats_analysis'   },
  'cv_summary_writer':           { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },

  /* ── COVER LETTER INTELLIGENCE (Features 36-65) ────────────── */
  'cover_letter_m01':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m02':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m03':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m04':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m05':            { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m06':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m07':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m08':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m09':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m10':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m11':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m12':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m13':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m14':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m15':            { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },

  /* ── COVER LETTER continued (m16-m30) ──────────────────────── */
  'cover_letter_m16':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m17':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m18':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m19':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m20':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m21':            { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m22':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m23':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m24':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m25':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m26':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m27':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m28':            { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m29':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'cover_letter_m30':            { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },

  /* ── INTERVIEW INTELLIGENCE (Features 66-95) ───────────────── */
  'interview_engine_1':          { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_2':          { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_3':          { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_4':          { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_5':          { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_6':          { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'live_interview_mode':         { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'devils_advocate':             { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'star_answer_builder':         { model:'cs-sonnet', maxTokens:800,  schema:'star_answer',     streaming:true,  piiScrub:false, task:'interview_prep' },
  'deep_prep_pack':              { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'post_interview_report':       { model:'cs-sonnet', maxTokens:800,  schema:'interview_report', streaming:false, piiScrub:false, task:'reasoning'     },
  'company_culture_analyser':    { model:'cs-haiku',  maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'summarise'      },
  'salary_negotiation_coach':    { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'salary_analysis'},

  /* ── INTERVIEW continued (7-23 of 30) ──────────────────────── */
  'interview_engine_7':          { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_8':          { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_9':          { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_10':         { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_11':         { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'interview_engine_12':         { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'psychometric_prep':           { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'technical_interview_prep':    { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'portfolio_presentation_coach':{ model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'culture_fit_coach':           { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'interview_prep' },
  'second_interview_coach':      { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'assessment_centre_coach':     { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'video_interview_coach':       { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'interview_prep' },
  'case_study_coach':            { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'group_exercise_coach':        { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'interview_prep' },
  'panel_interview_coach':       { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'competency_mapper':           { model:'cs-sonnet', maxTokens:600,  schema:'gap_report',      streaming:false, piiScrub:false, task:'gap_analysis'   },

  /* ── SALARY INTELLIGENCE (Features 96-120) ─────────────────── */
  'salary_benchmark':            { model:'cs-sonnet', maxTokens:600,  schema:'salary_report',   streaming:false, piiScrub:false, task:'salary_analysis'},
  'offer_evaluation':            { model:'cs-sonnet', maxTokens:800,  schema:'offer_report',    streaming:false, piiScrub:true,  task:'salary_analysis'},
  'negotiation_playbook':        { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'salary_analysis'},
  'total_comp_analyser':         { model:'cs-sonnet', maxTokens:600,  schema:'comp_report',     streaming:false, piiScrub:true,  task:'salary_analysis'},
  'equity_evaluator':            { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:true,  task:'reasoning'      },
  'pay_equity_analyser':         { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'salary_analysis'},
  'salary_letter_drafter':       { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'cover_letter'   },
  'market_value_calculator':     { model:'cs-sonnet', maxTokens:400,  schema:'value_score',     streaming:false, piiScrub:false, task:'salary_analysis'},
  'crowd_salary_engine':         { model:'cs-haiku',  maxTokens:200,  schema:'salary_range',    streaming:false, piiScrub:true,  task:'classify'       },
  'salary_trend_detector':       { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'summarise'      },

  /* ── SALARY continued (11-25 of 25) ────────────────────────── */
  'benefits_package_analyser':   { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:true,  task:'salary_analysis'},
  'stock_options_explainer':     { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'remote_work_premium':         { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'international_salary':        { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'pension_evaluator':           { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'salary_analysis'},
  'contractor_rate_calculator':  { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'ir35_advisor':                { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'redundancy_calculator':       { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:false, piiScrub:true,  task:'salary_analysis'},
  'side_income_advisor':         { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'tax_bracket_advisor':         { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'relocation_package_analyser': { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'salary_increase_planner':     { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'gender_pay_gap_advisor':      { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'bonus_structure_decoder':     { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:true,  task:'classify'       },
  'counter_offer_coach':         { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'salary_analysis'},

  /* ── LINKEDIN INTELLIGENCE (Features 121-145) ──────────────── */
  'linkedin_headline_gen':       { model:'cs-haiku',  maxTokens:150,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_about_writer':       { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'career_advice'  },
  'linkedin_experience_rewrite': { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'cv_rewrite'     },
  'viral_post_generator':        { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'linkedin_seo_optimizer':      { model:'cs-haiku',  maxTokens:300,  schema:'keyword_map',     streaming:false, piiScrub:false, task:'classify'       },
  'connection_msg_writer':       { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_growth_dashboard':   { model:'cs-haiku',  maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'summarise'      },
  'endorsement_request_writer':  { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'thought_leader_post':         { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'linkedin_analytics_coach':    { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },

  /* ── LINKEDIN continued (11-25 of 25) ──────────────────────── */
  'linkedin_skills_endorser':    { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_featured_section':   { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'linkedin_banner_advisor':     { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_content_calendar':   { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'linkedin_engagement_coach':   { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_dm_coach':           { model:'cs-haiku',  maxTokens:250,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_company_page_audit': { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'cv_analysis'    },
  'linkedin_recommendations_writer':{ model:'cs-sonnet', maxTokens:400, schema:null,            streaming:false, piiScrub:false, task:'cover_letter'   },
  'linkedin_jobs_search_coach':  { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_open_to_work':       { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'linkedin_creator_mode':       { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'linkedin_newsletter_writer':  { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'linkedin_profile_audit':      { model:'cs-sonnet', maxTokens:600,  schema:'gap_report',      streaming:false, piiScrub:false, task:'cv_analysis'    },
  'linkedin_job_alert_optimiser':{ model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'linkedin_networking_strategy':{ model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },

  /* ── INTELLIGENT JOB HUNT (Features 146-175) ──────────────── */
  'job_match_scorer':            { model:'cs-sonnet', maxTokens:600,  schema:'job_match',       streaming:false, piiScrub:false, task:'job_match'      },
  'jd_sentiment_analyser':       { model:'cs-haiku',  maxTokens:300,  schema:'sentiment',       streaming:false, piiScrub:false, task:'classify'       },
  'company_intel_brief':         { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:false, piiScrub:false, task:'summarise'      },
  'application_tracker':         { model:'cs-haiku',  maxTokens:200,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'job_alert_engine':            { model:'cs-haiku',  maxTokens:150,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'hidden_job_market':           { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'rejection_analyser':          { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'follow_up_writer':            { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'referral_request_writer':     { model:'cs-haiku',  maxTokens:250,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },

  /* ── JOB HUNT continued (10-30 of 30) ──────────────────────── */
  'cold_email_writer':           { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'networking_email_writer':     { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'job_board_strategy':          { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'recruiter_outreach_writer':   { model:'cs-haiku',  maxTokens:250,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'job_description_decoder':     { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'cv_analysis'    },
  'application_checklist':       { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'agency_vs_direct_advisor':    { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'job_search_timeline_planner': { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'industry_pivot_planner':      { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'startup_vs_corporate_advisor':{ model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'contract_vs_perm_advisor':    { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'remote_job_finder':           { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'visa_sponsorship_advisor':    { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'job_offer_comparison':        { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'probation_period_coach':      { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'notice_period_negotiator':    { model:'cs-sonnet', maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'resignation_letter_writer':   { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'exit_interview_coach':        { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'interview_prep' },
  'onboarding_30_60_90':         { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'new_job_first_week_coach':    { model:'cs-haiku',  maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'job_scam_detector':           { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },

  /* ── LIFEPATH ENGINE (Features 176-200) ────────────────────── */
  'lifepath_mode_01':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_02':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_03':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_04':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_05':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_06':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_07':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_08':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_09':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_10':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_11':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_12':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_13':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_14':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_15':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_16':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_17':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_18':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_19':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_20':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_21':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },

  /* ── LIFEPATH continued (22-25) ────────────────────────────── */
  'lifepath_mode_22':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_23':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_24':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'lifepath_mode_25':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },

  /* ── CAREER GOALS (Features 201-215) ───────────────────────── */
  'goal_setting_engine':         { model:'cs-sonnet', maxTokens:800,  schema:'goal_plan',       streaming:true,  piiScrub:false, task:'career_advice'  },
  'goal_progress_tracker':       { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  '90_day_planner':              { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'milestone_generator':         { model:'cs-haiku',  maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'career_vision_builder':       { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'habit_stack_builder':         { model:'cs-haiku',  maxTokens:350,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'accountability_system':       { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'summarise'      },

  /* ── CAREER GOALS continued (8-15 of 15) ───────────────────── */
  'skills_investment_planner':   { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'promotion_roadmap':           { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'leadership_readiness':        { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'gap_analysis'   },
  'side_project_advisor':        { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'networking_goal_setter':      { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'personal_brand_builder':      { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'career_values_clarifier':     { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'work_life_balance_coach':     { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },

  /* ── BRAIN AI CHAT (Features 216-230) ──────────────────────── */
  'brain_ai_chat':               { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'career_advice'  },
  'career_qa':                   { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'translation_engine':          { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:true,  task:'translation'    },
  'document_analyser':           { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:false, piiScrub:true,  task:'cv_analysis'    },
  'contract_explainer':          { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:true,  task:'reasoning'      },
  'quick_definition':            { model:'cs-haiku',  maxTokens:150,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'concept_explainer':           { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },

  /* ── BRAIN AI continued (8-15 of 15) ───────────────────────── */
  'email_tone_fixer':            { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'workplace_conflict_advisor':  { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'career_quiz':                 { model:'cs-haiku',  maxTokens:400,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'sector_explorer':             { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'job_title_explorer':          { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'work_style_analyser':         { model:'cs-haiku',  maxTokens:350,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'mentor_finder_advisor':       { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'feedback_interpreter':        { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },

  /* ── TOOL INTELLIGENCE (Features 231-250) ──────────────────── */
  'tool_proficiency_scanner':    { model:'cs-sonnet', maxTokens:600,  schema:'proficiency',     streaming:false, piiScrub:false, task:'cv_analysis'    },
  'tool_roi_calculator':         { model:'cs-sonnet', maxTokens:500,  schema:'roi_report',      streaming:false, piiScrub:false, task:'salary_analysis'},
  'tool_gap_compass':            { model:'cs-sonnet', maxTokens:700,  schema:'gap_report',      streaming:false, piiScrub:false, task:'gap_analysis'   },
  'tool_demand_oracle':          { model:'cs-haiku',  maxTokens:300,  schema:'demand_score',    streaming:false, piiScrub:false, task:'classify'       },
  'learning_path_builder':       { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'certification_tracker':       { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'summarise'      },
  'studio_generator':            { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'workflow_dna':                { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'obsolescence_radar':          { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },

  /* ── TOOL INTELLIGENCE continued (10-20 of 20) ─────────────── */
  'ai_tool_readiness':           { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'gap_analysis'   },
  'no_code_tool_guide':          { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'tool_stack_builder':          { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'tool_certification_advisor':  { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'industry_tool_map':           { model:'cs-sonnet', maxTokens:600,  schema:'keyword_map',     streaming:false, piiScrub:false, task:'tool_analysis'  },
  'tool_salary_impact':          { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'emerging_tech_radar':         { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'tool_analysis'  },
  'tool_interview_prep':         { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'interview_prep' },
  'automation_risk_checker':     { model:'cs-haiku',  maxTokens:350,  schema:null,              streaming:false, piiScrub:false, task:'classify'       },
  'cloud_skills_advisor':        { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'career_advice'  },
  'data_skills_roadmap':         { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },

  /* ── ENTERPRISE & EMPLOYER HUB (Features 251-274) ──────────── */
  'bulk_cv_screener':            { model:'cs-sonnet', maxTokens:2048, schema:null,              streaming:true,  piiScrub:true,  task:'cv_analysis'    },
  'jd_writer':                   { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'talent_pipeline_ai':          { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:false, piiScrub:true,  task:'reasoning'      },
  'candidate_match_engine':      { model:'cs-sonnet', maxTokens:600,  schema:'job_match',       streaming:false, piiScrub:true,  task:'job_match'      },
  'team_skill_map':              { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:true,  task:'cv_analysis'    },
  'org_chart_analyser':          { model:'cs-haiku',  maxTokens:400,  schema:null,              streaming:false, piiScrub:true,  task:'summarise'      },
  'salary_band_builder':         { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'salary_analysis'},
  'diversity_analyser':          { model:'cs-sonnet', maxTokens:500,  schema:null,              streaming:false, piiScrub:true,  task:'reasoning'      },
  'onboarding_kit_builder':      { model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'retention_risk_detector':     { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:true,  task:'reasoning'      },
  'performance_review_writer':   { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:true,  task:'career_advice'  },
  'interview_pack_builder':      { model:'cs-sonnet', maxTokens:1200, schema:null,              streaming:true,  piiScrub:false, task:'interview_prep' },
  'headcount_planner':           { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'career_growth_map':           { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },

  /* ── ENTERPRISE continued (15-24 of 24) ────────────────────── */
  'employer_brand_builder':      { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'career_advice'  },
  'job_ad_writer':               { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:true,  piiScrub:false, task:'cover_letter'   },
  'competency_framework_builder':{ model:'cs-sonnet', maxTokens:1000, schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'interview_scorecard_builder': { model:'cs-sonnet', maxTokens:700,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'employee_survey_analyser':    { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:true,  task:'cv_analysis'    },
  'learning_budget_advisor':     { model:'cs-haiku',  maxTokens:300,  schema:null,              streaming:false, piiScrub:false, task:'quick_reply'    },
  'succession_planner':          { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:false, piiScrub:true,  task:'reasoning'      },
  'hybrid_policy_advisor':       { model:'cs-sonnet', maxTokens:600,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },
  'dei_strategy_builder':        { model:'cs-sonnet', maxTokens:800,  schema:null,              streaming:true,  piiScrub:false, task:'reasoning'      },
  'workforce_planning_ai':       { model:'cs-sonnet', maxTokens:900,  schema:null,              streaming:false, piiScrub:false, task:'reasoning'      },

  /* ── SCORING PROXY FEATURES (3-layer hybrid engine) ──────── */
  'linkedin_profile_scorer':     { model:'cs-haiku',  maxTokens:1000, schema:'score_report',    streaming:false, piiScrub:true,  task:'cv_analysis'    },
  'cover_letter_scorer':         { model:'cs-haiku',  maxTokens:1000, schema:'score_report',    streaming:false, piiScrub:true,  task:'cover_letter'   },
};

/* Default config for unknown feature IDs */
const DEFAULT_FEATURE = { model:'cs-sonnet', maxTokens:800, schema:null, streaming:false, piiScrub:false, task:'career_advice' };

function getFeature(featureId) {
  return FEATURE_MAP[featureId] || DEFAULT_FEATURE;
}

module.exports = { FEATURE_MAP, DEFAULT_FEATURE, getFeature };
