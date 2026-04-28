/**
 * Recipe trimmer — context_reduction profile v0.1
 *
 * Pure function over the structured recipe shape. No I/O. Removes fields
 * per the trim profile; never alters tree topology.
 *
 * Composition:
 *   const trimmed = trimRecipe(recipe);
 *   const hash    = canonicalHash({
 *     profile: TRIM_PROFILE.version,
 *     code:    canonicalize(trimmed.code)
 *   });
 */


const TRIM_PROFILE = {
  version: '0.1',

  envelopeStrip: [
    'user_id',
    'copy_count',
    'webhook_url',
    'webhook_subscribe_url',
    'lifetime_task_count',
    'last_run_at',
    'job_succeeded_count',
    'job_failed_count',
    'parameters_count',
    'created_at',
    'updated_at',
    'config'
  ],

  stepStrip: [
    'as',
    'uuid',
    'recipe_step_uuid',
    'unfinished',
    'extended_input_schema',
    'extended_output_schema',
    'dynamic_pick_list_selection',
    'dynamicPickListSelection',
    'visible_config_fields',
    'hidden_config_fields',
    'toggle_cfg',
    'toggleCfg'
  ]
};

const DATAPILL_PATTERN = /^#\{_dp\(.*\)\}$/;
const AUTO_DESCRIPTION_PATTERN = /^Step\s+\d+$/;


/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

function trimRecipe(recipe, profile) {
  profile = profile || TRIM_PROFILE;
  if (!recipe || typeof recipe !== 'object') return recipe;

  const skip = {};
  profile.envelopeStrip.forEach(function (k) { skip[k] = true; });

  const out = {};
  Object.keys(recipe).forEach(function (key) {
    if (skip[key]) return;
    if (key === 'code') {
      out.code = trimStepNode_(recipe.code, profile);
    } else {
      out[key] = recipe[key];
    }
  });

  return out;
}


function trimWithStats(recipe, profile) {
  profile = profile || TRIM_PROFILE;

  const before  = JSON.stringify(recipe).length;
  const trimmed = trimRecipe(recipe, profile);
  const after   = JSON.stringify(trimmed).length;
  const pct     = before === 0 ? 0 : ((before - after) / before) * 100;

  return {
    trimmed: trimmed,
    stats: {
      profile_version: profile.version,
      bytes_before:    before,
      bytes_after:     after,
      reduction_pct:   Math.round(pct * 10) / 10,
      flag: pct < 30  ? 'low_reduction'
           : pct > 80 ? 'high_reduction'
           : 'normal'
    }
  };
}


function trimAndReport(recipes, profile) {
  return (recipes || []).map(function (r) {
    const result = trimWithStats(r, profile);
    return {
      id:             r.id,
      name:           r.name,
      bytes_before:   result.stats.bytes_before,
      bytes_after:    result.stats.bytes_after,
      reduction_pct:  result.stats.reduction_pct,
      flag:           result.stats.flag
    };
  });
}


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function trimStepNode_(node, profile) {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object')            return node;
  if (Array.isArray(node)) {
    return node.map(function (n) { return trimStepNode_(n, profile); });
  }

  const skip = {};
  profile.stepStrip.forEach(function (k) { skip[k] = true; });

  const out = {};
  Object.keys(node).forEach(function (key) {
    if (skip[key]) return;
    const value = node[key];

    if (key === 'block' && Array.isArray(value)) {
      out.block = value.map(function (child) { return trimStepNode_(child, profile); });
      return;
    }

    if (key === 'input' && value && typeof value === 'object') {
      const trimmedInput = trimInput_(value);
      if (!isEmpty_(trimmedInput)) out.input = trimmedInput;
      return;
    }

    if (key === 'description') {
      if (isMeaningfulDescription_(value)) out.description = value;
      return;
    }

    out[key] = value;
  });

  return out;
}


function trimInput_(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value
      .map(trimInput_)
      .filter(function (v) { return !isEmpty_(v); });
  }

  const out = {};
  Object.keys(value).forEach(function (key) {
    if (key.charAt(0) === '_') return;

    const trimmedValue = trimInput_(value[key]);
    if (!isEmpty_(trimmedValue)) out[key] = trimmedValue;
  });
  return out;
}


function isEmpty_(value) {
  if (value === null || value === undefined)                          return true;
  if (value === '')                                                    return true;
  if (Array.isArray(value) && value.length === 0)                      return true;
  if (typeof value === 'object' && Object.keys(value).length === 0)    return true;
  return false;
}


function isMeaningfulDescription_(desc) {
  if (typeof desc !== 'string') return false;
  const trimmed = desc.trim();
  if (trimmed === '')                          return false;
  if (AUTO_DESCRIPTION_PATTERN.test(trimmed))  return false;
  return true;
}
