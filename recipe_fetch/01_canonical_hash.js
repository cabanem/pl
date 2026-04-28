/**
 * Canonical JSON + hashing utilities.
 *
 * Pure functions. No I/O.
 *
 * Why this exists: JSON.stringify serializes object keys in insertion
 * order. Two semantically identical structures can produce different
 * bytes simply because their keys were assembled in different orders.
 * Canonicalization (recursive key sort) makes serialization deterministic.
 *
 * Critical invariant: arrays are walked but their element order is
 * preserved. Step blocks in Workato recipes are positionally meaningful.
 */


/**
 * Recursively rebuild a value so that every object has its keys in
 * sorted order. Arrays are walked, never reordered. Primitives pass through.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  return Object.keys(value).sort().reduce(function (acc, key) {
    acc[key] = canonicalize(value[key]);
    return acc;
  }, {});
}


/** Canonical JSON string. Suitable for hashing or byte-level comparison. */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}


/** Strip a set of keys at any depth. */
function stripKeysDeep(value, keysToStrip) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(function (v) { return stripKeysDeep(v, keysToStrip); });
  }
  const skip = {};
  (keysToStrip || []).forEach(function (k) { skip[k] = true; });

  const out = {};
  Object.keys(value).forEach(function (k) {
    if (skip[k]) return;
    out[k] = stripKeysDeep(value[k], keysToStrip);
  });
  return out;
}


/** SHA-256 over the canonical JSON of a value. Hex-encoded. */
function canonicalHash(value, opts) {
  const cleaned   = (opts && opts.stripKeys) ? stripKeysDeep(value, opts.stripKeys) : value;
  const canonical = canonicalJson(cleaned);

  const rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonical,
    Utilities.Charset.UTF_8
  );
  return rawHash.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}


/** Strict: any change anywhere in the tree produces a new hash. */
function recipeStrictHash(recipeCodeObj) {
  return canonicalHash(recipeCodeObj);
}


/**
 * Logical: ignore fields that drift even when functionally unchanged.
 * Tune the strip list per context.
 */
function recipeLogicalHash(recipeCodeObj) {
  return canonicalHash(recipeCodeObj, {
    stripKeys: ['as', 'uuid', 'updated_at', 'created_at']
  });
}


function recipesLogicallyEqual(a, b) {
  return recipeLogicalHash(a) === recipeLogicalHash(b);
}
