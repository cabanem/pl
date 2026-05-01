# Workato Recipe & Data Tables Toolkit

> A container-bound Google Apps Script project that retrieves, normalizes,
> trims, measures, and analyzes Workato recipes and data tables. Built as
> a layered set of pure modules with thin I/O wrappers on top — designed
> to make recipe introspection, AI-stage preparation, and ad-hoc data
> table queries fast, deterministic, and bandwidth-aware.

---

## Overview

This toolkit emerged from a specific need — generating trimmed recipe
JSON for downstream AI analysis — but ended up covering the full
retrieval-to-report pipeline for both recipes and data table records.
The architecture is deliberately layered so each piece can be replaced,
ported, or composed independently.

The core design discipline: every module that *transforms* data is a
pure function. Every module that *moves* data (network, sheet, drive)
is a thin I/O wrapper that composes the pure modules. Pure modules
don't know what runtime they're in, which means they could lift to
Workato or Cloud Functions without modification.

The toolkit covers four loosely-connected workflows:

1. **Recipe sync** — Pull recipes from the Workato Platform API, write
   metadata to a Sheet, write canonical JSON to Drive.
2. **Trim measurement** — Apply a configurable trim profile, measure
   the reduction distribution, snapshot reports for v0.1 → v0.2 tuning.
3. **Recipe extraction** — Walk recipe trees to extract typed
   operations (Data Tables, Salesforce, HTTP, etc.), join against
   inventory, write report sheets.
4. **Data table queries** — Sheet-driven entry point for the records
   API, with `where`/`order`/`select` declared per-row.

---

## Architecture

### Layered modules

```
              ┌─────────────────────────────────────┐
              │       I/O & menu wiring             │
              │  ──────────────────────────────────│
   menu  ──▶  │  06 recipe_sync                     │
              │  07 recipe_drive_cache              │
              │  08 trim_measurement_sheet          │
              │  09 data_table_ops_report           │
              │  data_table_query_runner            │
              │  10 recipe_inspector  (diagnostic)  │
              └─────────────┬───────────────────────┘
                            │
              ┌─────────────▼───────────────────────┐
              │       Pure transformation           │
              │  ──────────────────────────────────│
              │  03 recipe_trimmer                  │
              │  04 recipe_extractor                │
              │  05 trim_measurement                │
              └─────────────┬───────────────────────┘
                            │
              ┌─────────────▼───────────────────────┐
              │       API clients (UrlFetchApp)     │
              │  ──────────────────────────────────│
              │  02 workato_recipes                 │
              │  data_table_records                 │
              └─────────────┬───────────────────────┘
                            │
              ┌─────────────▼───────────────────────┐
              │       Foundational                  │
              │  ──────────────────────────────────│
              │  01 canonical_hash                  │
              └─────────────────────────────────────┘
```

Layer rules — enforced by convention, not tooling:

- **Foundational & pure**: no `UrlFetchApp`, no `SpreadsheetApp`, no
  `DriveApp`, no `PropertiesService`. Take data, return data.
- **API clients**: `UrlFetchApp` only. No Sheets or Drive.
- **I/O & menu**: do whatever's needed. Compose lower-layer modules.

### Files in load order

| # | File | Layer | Purpose |
|---|---|---|---|
| 1 | `canonical_hash.js` | foundational | Canonical JSON, deep key strip, SHA-256 |
| 2 | `workato_recipes.js` | API client | Fetch structured recipes, list tables |
| 3 | `recipe_trimmer.js` | pure | Trim recipe `code` per profile v0.1 |
| 4 | `recipe_extractor.js` | pure | Walk trees, extract matching steps |
| 5 | `trim_measurement.js` | pure | Deterministic distribution stats |
| 6 | `recipe_sync.js` | I/O | onOpen menu, sync to Sheet + Drive |
| 7 | `recipe_drive_cache.js` | I/O | Read recipes from Drive, write trimmed |
| 8 | `trim_measurement_sheet.js` | I/O | Render trim reports + comparisons |
| 9 | `data_table_ops_report.js` | I/O | Extract Data Tables ops, join, write |
| — | `data_table_records.js` | API client | Records API client (POST /query) |
| — | `data_table_query_runner.js` | I/O | Sheet-driven query authoring |
| 10 | `recipe_inspector.js` | diagnostic | Inspect provider/name pairs |

### Sheets

| Sheet | Owner | Lifecycle |
|---|---|---|
| `Recipes` | sync | Overwritten on each sync run |
| `Trim Latest` | trim measurement | Overwritten on each measure run |
| `Trim Snapshots` | trim measurement | Append-only history log |
| `Trim Comparison` | trim measurement | Overwritten on each compare run |
| `Data Table Ops` | ops report | Overwritten on each report run |
| `Connector Usage` | inspector | Overwritten when inspection runs |
| `DT Queries` | query runner | User-edited; stamped on run |
| `{output_sheet}` | query runner | Per-query output, named in DT Queries |

### Drive layout

```
{RECIPE_DRIVE_FOLDER_ID}/
├── recipe_{id}.json              ← full canonical recipe (one per recipe)
├── trim_snapshot_v{v}_{ts}.json  ← measurement reports
└── trimmed/
    └── trimmed_recipe_{id}.json  ← trim profile output for inspection
```

---

## Setup

1. Open target Sheet → **Extensions → Apps Script**.
2. Add each `.js` file to the script project.
3. **Project Settings → Script Properties:**

   | Key | Required | Notes |
   |---|---|---|
   | `WORKATO_API_TOKEN` | yes | Token with read access to recipes and data tables |
   | `WORKATO_BASE_URL` | no | Defaults to `https://app.eu.workato.com` |
   | `WORKATO_RECORDS_URL` | no | Override for records API host (auto-derived from base URL) |
   | `RECIPE_DRIVE_FOLDER_ID` | yes for full sync | Where recipe JSON files are written |
   | `TRIM_DRIVE_FOLDER_ID` | no | Where trim reports go; falls back to RECIPE_DRIVE_FOLDER_ID |

4. Run `syncRecipesMetadata` once from the script editor to authorize OAuth scopes.
5. Reload the Sheet to pick up the **Workato** menu.

---

## Workflows

### W-1. Recipe sync

Fetches recipes from Workato. Two flavors:

- **Metadata only** — one paginated list call, no per-recipe detail.
  Bandwidth-cheap, suitable for routine inventory refreshes.
- **Full structure** — one detail call per recipe. Parses `code` and
  `config` from their JSON-encoded string form. Writes canonical JSON
  to Drive (one file per recipe). Bandwidth-expensive — populates the
  cache that everything downstream reads from.

After one full sync, all subsequent trim, extract, and inspect
operations run from the Drive cache without further API calls.

### W-2. Trim measurement loop

The empirical-tuning loop for the trim profile. Closed loop:

1. **Measure trim (from cache)** — Apply current `TRIM_PROFILE`,
   compute per-recipe and distribution stats, write report to Drive
   and snapshot row to `Trim Snapshots`.
2. **Edit `TRIM_PROFILE`** in `recipe_trimmer.js` — adjust
   `envelopeStrip` or `stepStrip`, bump `version`.
3. **Measure trim (from cache)** again with the new profile.
4. **Compare last two snapshots** — render distribution deltas and
   per-recipe changes to `Trim Comparison`.
5. Iterate until two consecutive runs show no meaningful drift; lock
   to v1.0.

### W-3. Recipe extraction

Walks the recipe tree to extract typed step matches. Currently wired
for Data Tables operations (read/write/table_id), but the underlying
walker is generic — `extractStepsMatching(recipe, predicate)` accepts
any node predicate.

The reports follow a join pattern: the pure extractor produces
`{table_id, ...}` rows; the I/O wrapper joins against the data tables
inventory to add `table_name`. Reference resolution is one API call
total (build the index, join in memory) rather than per-step lookup.

### W-4. Data table queries

Sheet-driven entry point for the records API. Each row in `DT Queries`
is one declarative query with `where`/`order`/`select` JSON. User
clicks a row, runs from the menu, results write to a named sheet.
See `writing_data_table_queries.md` for the user-facing guide.

---

## Design decisions

**D-1. Sheet as index, Drive as structured storage.**
Recipe `code` is a tree; Sheets is tabular. Sheets hold derived
queryable fields and pointers; Drive holds the actual structured JSON.
Trying to flatten the tree into cells loses the structure or creates
sparse columns; stuffing it into a single cell hits the 50KB limit.
Two stores, one job each.

**D-2. Container-bound, not standalone.**
Single workspace, single Sheet, `onOpen` for the menu,
`SpreadsheetApp.getActive()` instead of a hardcoded ID. The tradeoff
is portability — one script syncs one workspace. Worth it for a
single-workspace tool; revisit if/when fan-out is needed.

**D-3. Canonicalize before hashing or persisting.**
`JSON.stringify` serializes keys in insertion order, so semantically
identical structures can produce different bytes. Canonicalization
(recursive key sort, array order preserved) makes hashes stable across
runs and Drive version diffs readable.

**D-4. Sort object keys, never reorder arrays.**
Step `block` arrays are positionally meaningful — order is part of
recipe semantics. The canonicalizer treats arrays as ordered and sorts
only object keys.

**D-5. Two hashing tiers: strict and logical.**
Strict catches any change. Logical strips a configurable list of
fields (`as`, `uuid`, timestamps) for "is this functionally the same
recipe?" Both have legitimate uses.

**D-6. Drive cache as bandwidth boundary.**
Apps Script enforces a daily `UrlFetchApp` byte budget; full recipe
detail responses can chew through it quickly. The cache reader
(`loadRecipesFromDrive`) returns the same shape as the network fetcher,
so all downstream pure modules work bandwidth-free after one full sync.

**D-7. Drive overwrite preserves version history.**
`setContent` on existing files produces a new revision; `createFile`
produces unrelated files with no history. We always upsert, so Drive's
built-in version history becomes a free, readable changelog.

**D-8. Idempotency via content equality.**
`upsertTrimmedFile_` reads the existing file, compares content, and
skips if equal. Re-running on a stable cache produces zero writes and
zero new revisions — the system stays consistent regardless of where a
previous run was interrupted.

**D-9. Retry only on transient signals.**
`withDriveRetry_` matches specific transient patterns (5xx, "Service
error: Drive", "try again") and propagates everything else. Auth
errors, quota errors, validation errors fail on the first attempt.

**D-10. Configuration as data.**
`TRIM_PROFILE`, `DATA_TABLES_PROFILE`, `DT_QUERIES_HEADERS` — every
tunable is a named structure, not buried control flow. Tuning is data
editing; versioning is hashing the structure.

**D-11. Parse once at the API boundary.**
Workato returns recipe `code` and `config` as JSON-encoded strings.
The records API returns positional `[meta_values, field_values]`
arrays alongside a separate schema. Both are parsed at the API client
boundary so all downstream code sees clean object shapes.

**D-12. Match the API's terminology, not our guess at it.**
The records API uses `where` (not `filter`), `$gte` (not `>=`),
`{by, order}` (not `{field, direction}`). The query runner mirrors
these names directly. Anyone reading the code can map to the docs and
back without translation.

**D-13. Visible partial failure.**
Counters for written / skipped / failed, separately reported. A "200
written, 0 skipped" toast is not the same as a "0 written, 200
skipped" toast — both are valid runs, but the second is a
*confirmation that nothing changed*, which is information.

**D-14. Diagnostics as siblings of the tools they help.**
`inspectConnectorUsage` lives next to the extractor it helps tune.
"You can write a script to investigate" is not a diagnostic; an
actual function the user can run is.

---

## Trim profile (`context_reduction` v0.1)

The trim profile is its own subsystem with its own spec. Living
summary:

- **Goal**: reduce recipe context size for AI analysis without
  changing what the recipe does from the model's perspective.
- **Principle**: strip fields, never structure. The tree shape *is*
  the recipe's logic.
- **Bias**: when in doubt, keep. Asymmetric risk — false positives on
  stripping silently degrade analysis quality, false negatives just
  cost tokens.
- **Single edit surface**: `TRIM_PROFILE` at the top of
  `recipe_trimmer.js`. Two arrays of strings: `envelopeStrip` and
  `stepStrip`. Bump `version` when editing.
- **Expected reduction**: 40–70% by canonical byte count. Outliers
  (`<30%` or `>80%`) flagged in measurement output for spot-checking.

Full spec: `trim_profile_spec.md`.

---

## Limitations & known gotchas

**Apps Script execution time limit.**
Six minutes per script execution. A full sync of several hundred
recipes can approach this. Currently no checkpoint/resume — design for
it once you actually hit the wall.

**Apps Script bandwidth quota.**
Daily `UrlFetchApp` byte budget (~20MB consumer, ~100MB Workspace).
Full recipe detail responses are large; a few hundred recipes with
schemas can exhaust the budget. Mitigation: full sync once, then
operate from cache (D-6).

**Sheet cell size cap.**
50,000 characters per cell. Don't try to write recipe `code` to a
single cell — that's what Drive is for.

**Trim profile match-by-name.**
`stripKeysDeep` strips by key name at any depth. If a nested input
field happens to be named `updated_at` and is *semantically*
meaningful, it gets stripped as collateral damage. Adjust the profile
or use a path-aware stripper if this surfaces.

**Single workspace per project.**
Container-bound script reads one `WORKATO_API_TOKEN`. Multi-workspace
inventory needs either multiple bound projects or a refactor to
standalone with workspace-scoped properties.

**Records API connector identifiers vary.**
Workato uses `workato_data_tables`, `data_tables`, or workspace-custom
identifiers depending on age and connector setup. The default extractor
profile may need tuning per workspace — run `inspectConnectorUsage()`
first.

**Drive service errors are transient but real.**
Heavy write loops occasionally see `Service error: Drive` even with
healthy auth. `withDriveRetry_` handles three attempts at 1s/2s/4s;
unrecoverable errors are logged and surfaced in the toast count.

**Apps Script `appendRow` interprets cell content.**
Strings starting with `=`, `[`, or `{` can be reinterpreted by Sheets'
input parser. Always use `setValues` for JSON-bearing cells, with
`setNumberFormat('@')` to lock plain text.

---

## Extension points

- **Drift dashboard** — store previous recipe hashes in
  `ScriptProperties`, surface a `drift_since_last_sync` boolean column
  on the Recipes sheet.
- **Spec-vs-deployed comparison** — pair `getStructuredRecipes` with a
  generator that produces the same shape from a YAML spec; compare
  via `recipeLogicalHash`.
- **Sub-recipe inlining** — when a step references another recipe,
  optionally fetch and inline the called recipe's `code` for end-to-end
  analysis.
- **Connector usage report** — `extractStepsMatching` with
  `provider`-only predicate, grouped by connector, written to a sheet.
- **Resume-on-trigger for long syncs** — checkpoint progress in
  `ScriptProperties`, self-trigger via `ScriptApp.newTrigger` for the
  next batch.
- **Path-aware trim** — extend `TRIM_PROFILE` with rules of the form
  `{at: "input.config.*", strip: ["preview"]}` to avoid the
  match-by-name collateral damage.
- **AI stage** — call Anthropic API directly from Apps Script, or
  (preferred) fold the AI stage into the SDC platform via a Workato
  recipe that consumes `trimmed_recipe_*.json` from Drive.

---

## Companion documents

- **`writing_data_table_queries.md`** — User-facing guide for
  authoring queries in the `DT Queries` sheet.
- **`trim_profile_spec.md`** — Full spec for the `context_reduction`
  trim profile, including the principles (P-1 through P-5), the
  envelope/step strip lists, datapill handling, and the v0.1 → v0.2
  versioning plan.
- **`patterns_for_lasting_tooling.md`** — Generalized design patterns
  drawn from this work, suitable for team sharing.

---

## Conventions

- **Trailing-underscore helpers** are private to the script project
  (don't show in the Run dropdown). The convention is enforced by
  habit, not by tooling.
- **All API I/O routes through `fetchJson_`** for consistent error
  reporting.
- **All canonical-form operations route through `canonicalize` /
  `canonicalJson`** so the deterministic-key-order guarantee holds
  uniformly.
- **The shape returned by `getStructuredRecipes` is the contract.**
  Downstream code (sync, hashers, future generators, cache reader)
  depends on those field names. Treat changes as breaking.
- **The shape returned by `fetchDataTableRecords` is the contract.**
  Records are objects keyed by field name (positional response is
  transformed at the boundary). Meta-fields keep their `$` prefix.
- **Profiles carry their version in the data.** Hashing the profile
  detects unbumped edits — when the version label and the hash
  diverge, that's a bug, not a configuration.
