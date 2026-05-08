/**
 * Recipe manifest builder — pure composition over the trim/canonicalize/hash
 * primitives. No I/O.
 *
 * A "manifest" is a self-describing envelope bundling a curated list of
 * trimmed recipes with the metadata needed to verify and reproduce it:
 * the trim profile version and hash, per-recipe content hashes, the
 * generation timestamp, and a deterministic envelope hash over the whole
 * thing.
 *
 * This module is the seam where downstream consumers — AI analysis stage,
 * archive, sharing — call into manifest construction without depending on
 * Sheets, Drive, or any other I/O. Pass it recipes and notes, get back a
 * canonical envelope.
 *
 * Depends on: recipe_trimmer.js, canonical_hash.js
 *
 * Envelope shape:
 *   {
 *     manifest_name:        string,
 *     manifest_version:     "1.0",
 *     generated_at:         ISO 8601 string,
 *     trim_profile_version: string,
 *     trim_profile_hash:    hex SHA-256,
 *     envelope_hash:        hex SHA-256 over canonical(envelope minus this field),
 *     recipe_count:         int,
 *     recipes_missing:      [string]  // ids the caller asked for but didn't supply
 *     recipes: [
 *       {
 *         id:                string,
 *         name:              string,
 *         folder_id:         number | null,
 *         notes:             string,                  // user-authored
 *         trimmed_hash:      hex SHA-256,
 *         trimmed_bytes:     int,                     // length of canonical JSON
 *         code:              object,                  // trimmed recipe code tree
 *         metadata: {                                 // non-code fields preserved from source
 *           description, trigger_application, action_applications, ...
 *         }
 *       }
 *     ]
 *   }
 */

const MANIFEST_VERSION = '1.0';


/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a manifest envelope.
 *
 * @param {Object} input
 * @param {string} input.name                  Human-readable manifest name
 * @param {Array<Object>} input.recipes        Structured recipes (full shape, with code)
 * @param {Object} [input.notesById]           Per-recipe notes keyed by recipe id
 * @param {Array<string>} [input.requestedIds] Ids the caller asked for; used to detect missing
 * @param {Object} [input.profile=TRIM_PROFILE]
 * @param {Date}   [input.now]                 Inject for deterministic tests; defaults to new Date()
 * @returns {Object} canonical envelope
 */
function buildRecipeManifest(input) {
  if (!input || !input.name) {
    throw new Error('buildRecipeManifest requires { name, recipes }.');
  }
  if (!Array.isArray(input.recipes)) {
    throw new Error('buildRecipeManifest: recipes must be an array.');
  }

  const profile   = input.profile  || TRIM_PROFILE;
  const notesById = input.notesById || {};
  const now       = input.now || new Date();

  const recipeEntries = input.recipes.map(function (r) {
    return buildRecipeEntry_(r, profile, notesById[r.id] || '');
  });

  const requestedIds = Array.isArray(input.requestedIds) ? input.requestedIds : null;
  const recipesMissing = requestedIds
    ? findMissingIds_(requestedIds, recipeEntries)
    : [];

  // Build the envelope without envelope_hash, then hash and stamp.
  const envelope = canonicalize({
    manifest_name:        input.name,
    manifest_version:     MANIFEST_VERSION,
    generated_at:         now.toISOString(),
    trim_profile_version: profile.version,
    trim_profile_hash:    canonicalHash(profile),
    recipe_count:         recipeEntries.length,
    recipes_missing:      recipesMissing,
    recipes:              recipeEntries
  });

  envelope.envelope_hash = canonicalHash(envelope);
  return envelope;
}


/**
 * Convenience: given a full set of cached recipes and a list of ids,
 * filter to just those ids in the order requested. Recipes not in the
 * cache are silently dropped here — the manifest builder records them
 * via `requestedIds` / `recipes_missing`.
 *
 * @param {Array<Object>} recipes  - full cache (output of loadRecipesFromDrive)
 * @param {Array<string>} ids      - desired recipe ids, in desired order
 * @returns {Array<Object>}
 */
function selectRecipesByIds(recipes, ids) {
  const byId = {};
  (recipes || []).forEach(function (r) {
    if (r && r.id != null) byId[String(r.id)] = r;
  });
  return (ids || [])
    .map(function (id) { return byId[String(id)]; })
    .filter(function (r) { return !!r; });
}


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-recipe entry: trim, hash, separate code from metadata.
 *
 * Splits trimmed recipe into `code` (the tree) and `metadata` (everything
 * else from the trimmed envelope). Downstream consumers can ignore
 * metadata if they only care about the code, or use it for context.
 */
function buildRecipeEntry_(recipe, profile, notes) {
  const trimmed       = trimRecipe(recipe, profile);
  const trimmedJson   = canonicalJson(trimmed);
  const trimmedHash   = canonicalHash(trimmed);

  // Split: code tree separately, everything else as metadata.
  const code = trimmed.code || null;
  const metadata = {};
  Object.keys(trimmed).forEach(function (k) {
    if (k === 'code') return;
    if (k === 'id')   return;   // surfaced at entry top level
    if (k === 'name') return;   // surfaced at entry top level
    metadata[k] = trimmed[k];
  });

  return {
    id:             trimmed.id,
    name:           trimmed.name,
    folder_id:      trimmed.folder_id != null ? trimmed.folder_id : null,
    notes:          String(notes || ''),
    trimmed_hash:   trimmedHash,
    trimmed_bytes:  trimmedJson.length,
    code:           code,
    metadata:       metadata
  };
}


function findMissingIds_(requestedIds, recipeEntries) {
  const have = {};
  recipeEntries.forEach(function (e) { have[String(e.id)] = true; });
  return requestedIds
    .map(String)
    .filter(function (id) { return !have[id]; });
}
