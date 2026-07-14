'use strict';
/**
 * SCHEMA VALIDATOR — Pydantic-style structured output validation
 * Validates and auto-repairs JSON from local models (cs-haiku, cs-sonnet).
 * Small models produce malformed JSON — this layer heals it before it
 * reaches the caller, so every structured endpoint gets a valid object.
 */

/* ── CAREER OUTPUT SCHEMAS ──────────────────────────────────────────── */
const SCHEMAS = {

  career_advice: {
    fields: {
      summary:        { type: 'string',  required: true,  default: '' },
      key_points:     { type: 'array',   required: true,  default: [] },
      action_steps:   { type: 'array',   required: true,  default: [] },
      market_insight: { type: 'string',  required: false, default: '' },
      confidence:     { type: 'number',  min: 0, max: 1,  default: 0.8 },
    },
  },

  cv_bullet: {
    fields: {
      original:    { type: 'string',  required: true,  default: '' },
      improved:    { type: 'string',  required: true,  default: '' },
      impact:      { type: 'string',  required: true,  default: '' },
      keywords:    { type: 'array',   required: true,  default: [] },
      ats_score:   { type: 'number',  min: 0, max: 100, default: 70 },
      explanation: { type: 'string',  required: false, default: '' },
    },
  },

  job_match: {
    fields: {
      overall:          { type: 'number', min: 0, max: 1,   default: 0.5 },
      titleMatch:       { type: 'number', min: 0, max: 1,   default: 0.5 },
      locationMatch:    { type: 'number', min: 0, max: 1,   default: 0.5 },
      salaryMatch:      { type: 'number', min: 0, max: 1,   default: 0.5 },
      skillsMatch:      { type: 'number', min: 0, max: 1,   default: 0.5 },
      gaps:             { type: 'array',  required: true,    default: [] },
      strengths:        { type: 'array',  required: true,    default: [] },
      recommendation:   { type: 'string', required: true,    default: '' },
      reasoning:        { type: 'string', required: false,   default: '' },
    },
  },

  salary_analysis: {
    fields: {
      current_estimate:    { type: 'number', required: true, default: 0 },
      market_range_low:    { type: 'number', required: true, default: 0 },
      market_range_high:   { type: 'number', required: true, default: 0 },
      percentile:          { type: 'number', min: 0, max: 100, default: 50 },
      negotiation_floor:   { type: 'number', required: true, default: 0 },
      negotiation_target:  { type: 'number', required: true, default: 0 },
      key_factors:         { type: 'array',  required: true, default: [] },
      currency:            { type: 'string', required: true, default: 'USD' },
    },
  },

  summarise: {
    fields: {
      summary:    { type: 'string', required: true,  default: '' },
      key_points: { type: 'array',  required: true,  default: [] },
      word_count: { type: 'number', required: false, default: 0 },
    },
  },

  skill_gap: {
    fields: {
      missing_skills:    { type: 'array',  required: true, default: [] },
      present_skills:    { type: 'array',  required: true, default: [] },
      priority_gaps:     { type: 'array',  required: true, default: [] },
      learning_timeline: { type: 'string', required: true, default: '' },
      confidence:        { type: 'number', min: 0, max: 1,  default: 0.8 },
    },
  },

  interview_prep: {
    fields: {
      questions:        { type: 'array',  required: true, default: [] },
      company_insights: { type: 'string', required: true, default: '' },
      star_examples:    { type: 'array',  required: true, default: [] },
      ask_interviewer:  { type: 'array',  required: true, default: [] },
    },
  },
};

/* ── VALIDATOR CLASS ────────────────────────────────────────────────── */
class SchemaValidator {

  /** Full pipeline: extract → repair → apply schema constraints */
  static validate(raw, schemaName) {
    const schema = SCHEMAS[schemaName];
    if (!schema) return { __error: 'unknown_schema', raw };

    let parsed = this.extractJSON(raw);
    if (!parsed) parsed = this.repairJSON(raw);
    if (!parsed) {
      console.warn(`[SchemaValidator] parse_failed for schema="${schemaName}" raw_len=${raw?.length}`);
      return this._defaults(schema);
    }
    return this._applySchema(parsed, schema);
  }

  /** Extract JSON from common model output wrapping patterns */
  static extractJSON(text) {
    if (!text) return null;
    const patterns = [
      /```json\s*([\s\S]*?)```/i,   // ```json ... ```
      /```\s*([\s\S]*?)```/,         // ``` ... ```
      /(\{[\s\S]*\})/,               // raw object
      /(\[[\s\S]*\])/,               // raw array
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        try { return JSON.parse(m[1] || m[0]); } catch (_) {}
      }
    }
    return null;
  }

  /** Auto-repair common small-model JSON mistakes */
  static repairJSON(text) {
    if (!text) return null;
    let s = text
      .replace(/,\s*([}\]])/g, '$1')   // trailing commas
      .replace(/'/g, '"')               // single → double quotes
      .replace(/(\w+)\s*:/g, '"$1":')  // unquoted keys
      .replace(/\n/g, ' ')
      .replace(/\t/g, ' ')
      .trim();

    const start = s.indexOf('{');
    const end   = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
    }
    return null;
  }

  static _defaults(schema) {
    const out = {};
    for (const [k, r] of Object.entries(schema.fields)) out[k] = r.default;
    return out;
  }

  static _applySchema(data, schema) {
    const result = {};
    for (const [key, rules] of Object.entries(schema.fields)) {
      let val = data[key];

      // Type coercion
      if (rules.type === 'number') {
        val = parseFloat(val);
        if (isNaN(val)) val = rules.default ?? 0;
      } else if (rules.type === 'boolean') {
        if (typeof val === 'string') val = val.toLowerCase() === 'true';
      } else if (rules.type === 'array') {
        if (!Array.isArray(val)) val = val != null ? [val] : (rules.default ?? []);
      } else if (rules.type === 'string') {
        val = val != null ? String(val) : (rules.default ?? '');
      }

      // Range constraints
      if (rules.min !== undefined && typeof val === 'number') val = Math.max(rules.min, val);
      if (rules.max !== undefined && typeof val === 'number') val = Math.min(rules.max, val);

      // Required fallback
      if ((val === undefined || val === null) && rules.required) val = rules.default;

      result[key] = val !== undefined ? val : (rules.default ?? null);
    }
    return result;
  }
}

module.exports = { SchemaValidator, SCHEMAS };
