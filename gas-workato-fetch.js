/**
 * Recipe trimmer — context_reduction profile v0.1
 *
 * Pure function over the structured recipe shape returned by
 * getStructuredRecipes({ includeCode: true }). No I/O. Does not mutate
 * the input. Output is the same recursive structure with fields removed
 * per the profile in trim_profile_spec.md.
 *
 * Composition (recommended order):
 *
 *     const recipes = getStructuredRecipes({ includeCode: true });
 *     const trimmed = recipes.map(trimRecipe);
 *     const canonical = trimmed.map(canonicalize);
 *     const cacheKey = canonicalHash({
 *       profile: TRIM_PROFILE.version,
 *       code:    canonical[i].code
 *     });
 *
 * Trim before canonicalize: canonicalization is cheaper on smaller trees.
 * Hash includes the profile version so v0.1 and v0.2 outputs don't collide.
 */


/* -------------------------------------------------------------------------- */
/* Profile config — the single edit surface for v0.1 → v0.2 tuning            */
/* -------------------------------------------------------------------------- */

const TRIM_PROFILE = {
  version: '0.1',

  // Top-level recipe envelope keys to strip.
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
    'config'   // see spec note; default-strip, override per-call if needed
  ],

  // Step-node keys to strip wherever they appear in the code tree.
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

// Datapills are leaves. Pattern matches strings like "#{_dp('data.x.y')}".
const DATAPILL_PATTERN = /^#\{_dp\(.*\)\}$/;

// Auto-generated default descriptions to drop ("Step 1", "Step 23", ...).
const AUTO_DESCRIPTION_PATTERN = /^Step\s+\d+$/;


/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Trim a single recipe object (shape: output of getStructuredRecipes).
 *
 * @param {Object} recipe
 * @param {Object} [profile=TRIM_PROFILE]
 * @returns {Object}
 */
function trimRecipe(recipe, profile) {
  profile = profile || TRIM_PROFILE;
  if (!recipe || typeof recipe !== 'object') return recipe;

  const skip = new Set(profile.envelopeStrip);
  const out  = {};

  Object.keys(recipe).forEach(function (key) {
    if (skip.has(key)) return;
    if (key === 'code') {
      out.code = trimStepNode_(recipe.code, profile);
    } else {
      out[key] = recipe[key];
    }
  });

  return out;
}


/**
 * Trim + reduction stats. Useful during empirical tuning.
 *
 * @returns {{ trimmed: Object, stats: Object }}
 */
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
      flag: pct < 30  ? 'low_reduction'   // recipe was already mostly user content
           : pct > 80 ? 'high_reduction'  // suspiciously aggressive — spot check
           : 'normal'                      // expected 40–70% band
    }
  };
}


/**
 * Batch helper for the empirical-tuning step in the spec.
 * Returns a flat array suitable for writing to a Sheet or eyeballing.
 *
 * @param {Array<Object>} recipes
 * @returns {Array<Object>}
 */
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

/** Recursively trim a step node. Preserves block array order and length. */
function trimStepNode_(node, profile) {
  if (node === null || node === undefined)  return node;
  if (typeof node !== 'object')             return node;
  if (Array.isArray(node)) {
    return node.map(function (n) { return trimStepNode_(n, profile); });
  }

  const skip = new Set(profile.stepStrip);
  const out  = {};

  Object.keys(node).forEach(function (key) {
    if (skip.has(key)) return;
    const value = node[key];

    if (key === 'block' && Array.isArray(value)) {
      // block is positionally meaningful — walk children, never drop or reorder.
      out.block = value.map(function (child) {
        return trimStepNode_(child, profile);
      });
      return;
    }

    if (key === 'input' && value && typeof value === 'object') {
      const trimmedInput = trimInput_(value);
      // Drop the input key entirely if everything inside was empty/preview.
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


/**
 * Trim an `input` object: strip schema preview keys, drop empty values,
 * pass datapill strings through verbatim, recurse into nested structures.
 */
function trimInput_(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Datapills and ordinary strings: pass through. Empty strings are filtered
    // upstream by isEmpty_.
    return value;
  }

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value
      .map(trimInput_)
      .filter(function (v) { return !isEmpty_(v); });
  }

  const out = {};
  Object.keys(value).forEach(function (key) {
    // Schema/preview blobs are conventionally underscore-prefixed.
    if (key.charAt(0) === '_') return;

    const trimmedValue = trimInput_(value[key]);
    if (!isEmpty_(trimmedValue)) out[key] = trimmedValue;
  });
  return out;
}


function isEmpty_(value) {
  if (value === null || value === undefined)                return true;
  if (value === '')                                          return true;
  if (Array.isArray(value) && value.length === 0)            return true;
  if (typeof value === 'object' && Object.keys(value).length === 0) return true;
  return false;
}


function isMeaningfulDescription_(desc) {
  if (typeof desc !== 'string') return false;
  const trimmed = desc.trim();
  if (trimmed === '')                          return false;
  if (AUTO_DESCRIPTION_PATTERN.test(trimmed))  return false;
  return true;
}
