/**
 * Trim measurement — deterministic stats over a set of recipes.
 *
 * Pure functions. No I/O. Designed to produce reproducible numbers that
 * can be compared across runs and across trim profile versions.
 *
 * Determinism guarantees:
 *
 *   1. Byte counts are measured on the *canonical* JSON serialization,
 *      not on JSON.stringify directly. Same input → same bytes, regardless
 *      of insertion order.
 *
 *   2. Per-recipe output hashes use canonicalHash, so "did this recipe's
 *      trim output change between profile v0.1 and v0.2?" is a single
 *      equality check.
 *
 *   3. Distribution stats (median, p90, p95) use a fixed, documented
 *      percentile method (linear interpolation, type 7 — same as numpy
 *      and R defaults) so they're reproducible across reimplementations.
 *
 *   4. The profile itself is hashed and the hash is included in every
 *      report. If someone edits TRIM_PROFILE and forgets to bump
 *      .version, the config hash will diverge from the version label and
 *      the mismatch is detectable.
 *
 * Depends on: recipe_trimmer.js, canonical_hash.js
 */


/* -------------------------------------------------------------------------- */
/* Per-recipe measurement                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic measurement for a single recipe.
 *
 * @param {Object} recipe  - structured recipe (output of getStructuredRecipes)
 * @param {Object} [profile]
 * @returns {Object} measurement record
 */
function measureRecipeTrim(recipe, profile) {
  profile = profile || TRIM_PROFILE;

  const before        = canonicalJson(recipe);             // canonical → reproducible bytes
  const trimmed       = trimRecipe(recipe, profile);
  const after         = canonicalJson(trimmed);

  const bytesBefore   = before.length;
  const bytesAfter    = after.length;
  const reductionPct  = bytesBefore === 0
                          ? 0
                          : Math.round(((bytesBefore - bytesAfter) / bytesBefore) * 1000) / 10;

  return {
    id:                 recipe.id,
    name:               recipe.name,
    bytes_before:       bytesBefore,
    bytes_after:        bytesAfter,
    reduction_pct:      reductionPct,
    flag:               classifyReduction_(reductionPct),
    trimmed_hash:       canonicalHash(trimmed),            // for cross-version comparison
    profile_version:    profile.version
  };
}


/* -------------------------------------------------------------------------- */
/* Distribution measurement                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic distribution stats over a set of recipes.
 *
 * @param {Array<Object>} recipes
 * @param {Object} [profile]
 * @returns {Object} report
 */
function measureTrimDistribution(recipes, profile) {
  profile = profile || TRIM_PROFILE;

  const measurements = (recipes || []).map(function (r) {
    return measureRecipeTrim(r, profile);
  });

  const reductions = measurements.map(function (m) { return m.reduction_pct; });

  const flagCounts = { low_reduction: 0, normal: 0, high_reduction: 0 };
  measurements.forEach(function (m) { flagCounts[m.flag] += 1; });

  return {
    profile_version:  profile.version,
    profile_hash:     canonicalHash(profile),  // detects unbumped edits
    measured_at:      new Date().toISOString(),
    recipe_count:     measurements.length,

    bytes_before_total: sum_(measurements.map(function (m) { return m.bytes_before; })),
    bytes_after_total:  sum_(measurements.map(function (m) { return m.bytes_after;  })),

    reduction_pct: {
      min:    min_(reductions),
      max:    max_(reductions),
      mean:   round1_(mean_(reductions)),
      median: round1_(percentile_(reductions, 50)),
      p90:    round1_(percentile_(reductions, 90)),
      p95:    round1_(percentile_(reductions, 95))
    },

    flag_counts: flagCounts,
    measurements: measurements   // per-recipe rows for drill-down
  };
}


/* -------------------------------------------------------------------------- */
/* Snapshot comparison                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Compare two distribution reports (e.g. v0.1 vs v0.2 of the trim profile).
 * Surfaces which recipes' trim output actually changed, plus distribution
 * deltas.
 *
 * @param {Object} reportA
 * @param {Object} reportB
 * @returns {Object} comparison
 */
function compareTrimReports(reportA, reportB) {
  const aById = indexBy_(reportA.measurements, 'id');
  const bById = indexBy_(reportB.measurements, 'id');

  const ids = unique_(Object.keys(aById).concat(Object.keys(bById)));
  const changed = [];
  const added   = [];
  const removed = [];

  ids.forEach(function (id) {
    const a = aById[id];
    const b = bById[id];
    if (a && !b) { removed.push(a); return; }
    if (b && !a) { added.push(b);   return; }
    if (a.trimmed_hash !== b.trimmed_hash) {
      changed.push({
        id:                 id,
        name:               b.name,
        reduction_before:   a.reduction_pct,
        reduction_after:    b.reduction_pct,
        reduction_delta:    round1_(b.reduction_pct - a.reduction_pct),
        flag_before:        a.flag,
        flag_after:         b.flag
      });
    }
  });

  return {
    profile_a:        reportA.profile_version,
    profile_b:        reportB.profile_version,
    distribution_delta: {
      median: round1_(reportB.reduction_pct.median - reportA.reduction_pct.median),
      p90:    round1_(reportB.reduction_pct.p90    - reportA.reduction_pct.p90),
      p95:    round1_(reportB.reduction_pct.p95    - reportA.reduction_pct.p95)
    },
    flag_count_delta: {
      low_reduction:  reportB.flag_counts.low_reduction  - reportA.flag_counts.low_reduction,
      normal:         reportB.flag_counts.normal         - reportA.flag_counts.normal,
      high_reduction: reportB.flag_counts.high_reduction - reportA.flag_counts.high_reduction
    },
    recipes_changed: changed,
    recipes_added:   added,
    recipes_removed: removed
  };
}


/* -------------------------------------------------------------------------- */
/* Internals — math + helpers                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Linear-interpolation percentile (type 7 — numpy/R default).
 * Documented choice so reimplementations produce identical numbers.
 */
function percentile_(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  if (sorted.length === 1) return sorted[0];

  const rank   = (p / 100) * (sorted.length - 1);
  const lower  = Math.floor(rank);
  const upper  = Math.ceil(rank);
  const weight = rank - lower;

  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function classifyReduction_(pct) {
  if (pct < 30) return 'low_reduction';
  if (pct > 80) return 'high_reduction';
  return 'normal';
}

function sum_(arr)    { return arr.reduce(function (a, b) { return a + b; }, 0); }
function mean_(arr)   { return arr.length ? sum_(arr) / arr.length : 0; }
function min_(arr)    { return arr.length ? Math.min.apply(null, arr) : 0; }
function max_(arr)    { return arr.length ? Math.max.apply(null, arr) : 0; }
function round1_(n)   { return Math.round(n * 10) / 10; }

function indexBy_(arr, key) {
  const out = {};
  (arr || []).forEach(function (item) { out[item[key]] = item; });
  return out;
}

function unique_(arr) {
  const seen = {};
  const out  = [];
  arr.forEach(function (v) {
    if (!seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}
