# SDC Data Collection — PRV Chain Amendment Bundle (v1)

## Status

A focused amendment bundle that resolves the GAS-export persistence ambiguity in the PRV chain. Reorganizes responsibility so that each recipe writes to a stable, persisted artifact rather than relying on transient pill content or mis-named fields.

This bundle is **not new design**. It threads three settled decisions through the rest of the system:

1. **Add `CFG_TemplateVersion.gas_export_path`** — the raw GAS sheet_data JSON gets a dedicated, version-scoped FileStorage path. PRV-01 writes it.
2. **Drop `Project.parsed_config_path`** — engagement-level pointer was redundant given the version-level `CFG_TemplateVersion.parsed_config_path`. Removal is cleaner than ambiguity about "snapshot of v1 only" vs. "always-the-latest" semantics.
3. **PRV-01 creates the `CFG_TemplateVersion` row** — the version row exists from the moment the webhook fires, so PRV-02 receives `template_version_id` rather than carrying the GAS sheet_data forward as recipe pill content.

The amendments are mechanical given these decisions. This document specifies each one precisely.

## Scope

What the bundle includes:
- Data model amendment (add `gas_export_path`, drop `Project.parsed_config_path`)
- Build manifest amendment (same)
- PRV-01 recipe plan amendment (new substages, expanded contract)
- PRV-02 recipe plan amendment (contract change, substage restructuring)
- Spreadsheet row updates for PRV-01 and PRV-02
- One open question on failed-validation draft cleanup

What the bundle deliberately does NOT change:
- CFG-01's contract (still consumes `parsed_config_path`, now exclusively the version-scoped one on `CFG_TemplateVersion`)
- PRV-03 and PRV-04 (contracts and substages unaffected)
- Canonical model shape spec (unaffected)
- Existing invariants (snapshot semantics on invariant 2 already cover `gas_export_path`)

---

## Amendment 1 — Data model

### Add `CFG_TemplateVersion.gas_export_path`

Insert in the `CFG_TemplateVersion` field table, between `master_template_path` and `parsed_config_path`:

> `gas_export_path` (string) — FileStorage path to the raw GAS export, the `{sheet_name: 2d_array}` JSON exactly as the analyst's master config workbook produced it. Pre-parse audit artifact. Distinct from `parsed_config_path` (which holds the connector's `parse_config_file` output) and `canonical_model_path` (which holds the fully resolved configuration). Written by PRV-01 at row creation, immutable thereafter per snapshot semantics.

### Drop `Project.parsed_config_path`

Remove from the `Project` field table. The engagement-level "parsed config" pointer was inherited from the naming-doc backports of v2.1 but is redundant given `CFG_TemplateVersion.parsed_config_path` (per-version, audit-preserved, queryable by `version_number`).

Consumers wanting "the latest version's parsed config" query `CFG_TemplateVersion` for `status=published` with highest `version_number`. No recipe currently reads `Project.parsed_config_path`, so removal has no downstream caller impact.

### Invariant 2 amendment

Invariant 2 currently reads:

> Once a `CFG_TemplateVersion` is `published`, no row in any CFG_ table scoped to that version is ever updated. The same rule covers per-version file artifacts: `parsed_config_path` and `canonical_model_path` are write-once at publish and immutable thereafter.

Amend to:

> Once a `CFG_TemplateVersion` is `published`, no row in any CFG_ table scoped to that version is ever updated. The same rule covers per-version file artifacts: `gas_export_path`, `parsed_config_path`, and `canonical_model_path` are write-once and immutable. Note that `gas_export_path` is written at *row creation* (by PRV-01), not at publish — but the write-once rule still holds; PRV-01's create is the single write.

### Changelog entry

Add to the data model changelog:

> **v2.2** — Added `CFG_TemplateVersion.gas_export_path` (string, required), the per-version FileStorage path to the raw GAS sheet_data. Removed `Project.parsed_config_path` as redundant with the per-version equivalent. Amended invariant 2 to cover `gas_export_path` under snapshot semantics (write-once at row creation rather than at publish; the rule still holds because PRV-01 performs the only write). No other changes.

---

## Amendment 2 — Build manifest

### Add column to `CFG_TemplateVersion` schema

Insert between `master_template_path` and `parsed_config_path`:

```json
{
  "type": "string",
  "name": "gas_export_path",
  "optional": false,
  "hint": "FileStorage path to the raw GAS export (sheet_data JSON as produced by the analyst's master config workbook). Pre-parse audit artifact. Distinct from parsed_config_path (post-parse) and canonical_model_path (resolved). Written by PRV-01 at row creation; immutable thereafter."
}
```

### Remove column from `Project` schema

Remove the `parsed_config_path` entry from the `Project` table's `schema` array.

### Changelog entry

Add to `_meta.changelog`:

```json
{
  "version": "5.2.0",
  "date": "<today>",
  "changes": [
    "Added CFG_TemplateVersion.gas_export_path (string, required). Holds the FileStorage path to the raw GAS sheet_data export -- pre-parse audit artifact. Written by PRV-01 at row creation.",
    "Removed Project.parsed_config_path as redundant with the per-version equivalent CFG_TemplateVersion.parsed_config_path. No downstream consumers were reading Project.parsed_config_path."
  ]
}
```

### Build order note

No change to creation order. `CFG_TemplateVersion` is already created second (after `Project`); the new column is added at table creation.

---

## Amendment 3 — PRV-01 recipe plan

The PRV-01 entry in `sdc-recipe-plan-stage3.md` gains substages 3 and 5, and the contract output expands. Full restated substage outline below; the rest of the entry (Identity, Build queue stage, Capability text, Cross-cutting calls, Phases emitted, Error types possible, Invariants honored, Open questions) is unchanged except as noted.

### Contract (Output) — change

Was:

> No return value directly. PRV-01 fires PRV-02 asynchronously and returns an acknowledgment to GAS.

Becomes:

> No async return. The HTTP acknowledgment to GAS returns: `project_id`, `template_version_id`. The synchronous return lets GAS surface the version_id to the analyst for support reference.

### Substage outline — restated

1. **Validate payload shape.** Required fields present (`drive_id_config_json`, `is_initial`, `analyst_email`), types correct. On malformed payload, emit `recipe_failed` with `recipe_invariant`, return HTTP 400 to GAS without firing downstream.

2. **Determine project context.**
   - **E1** (`is_initial=true`): verify no Project exists; create one with a fresh `project_id`, `analyst_email`, and customer_name (extracted from the payload).
   - **E2** (`is_initial=false`): resolve the existing Project (singleton query). If `is_initial=true` but a Project exists, emit `recipe_failed` with `recipe_invariant` and refuse.

3. **Create the `CFG_TemplateVersion` row in `draft`.**
   - **E1:** `version_number = 1`.
   - **E2:** `version_number = MAX(version_number for this project) + 1`.
   - `status = draft`. Other version-scoped paths (`parsed_config_path`, `canonical_model_path`, `master_template_path`) stay null until the recipes that produce them run.

4. **Fetch the config JSON from Drive.** Resolve `drive_id_config_json` to file content. The content is the raw GAS sheet_data JSON.

5. **Write to FileStorage at `CFG_TemplateVersion.gas_export_path`.** Path convention: `/versions/v<NNN>/gas_export.json` (or whatever the naming doc settles on for per-version artifacts). Update the version row with the path.

6. **Emit `provisioning_triggered`.** OBS-01 with `project_id` and `template_version_id` in `details_json`. Severity `info`.

7. **Fire PRV-02.** Pass `template_version_id`. Asynchronous — PRV-01 returns immediately.

8. **Return HTTP 200 to GAS** with `project_id` and `template_version_id`.

### Cross-cutting calls — change

Add to existing list:

- **Data Tables operations**: `Project` create/read (Substage 2), `CFG_TemplateVersion` create (Substage 3), `CFG_TemplateVersion` update (Substage 5). Not other recipes, just direct table operations.

### Error types possible — addition

Add to the existing list:

- `external_action_failed` extends to: `Project` create failed, `CFG_TemplateVersion` create failed.
- `recipe_invariant` extends to: `is_initial=true` but Project exists; `is_initial=false` but no Project exists; version creation produced a duplicate `version_number` (concurrency edge case).

### Open questions — addition

Add to the existing list:

- **Drive fetch error handling.** If Drive returns an error or the file is missing, the version row has been created (Substage 3) but no `gas_export_path` written. The row is incomplete. Lean: emit `recipe_failed` with `external_action_failed`; leave the incomplete row in place as an audit artifact ("provisioning was attempted but Drive fetch failed"). The row stays in `draft` indefinitely. See "Cleanup of failed-validation drafts" cross-cutting open question.

---

## Amendment 4 — PRV-02 recipe plan

The PRV-02 entry's input contract changes, and substages 1–5 restructure to reflect that the version row already exists when PRV-02 starts. The canonical-model-build substages (formerly 6–9) shift up.

### Contract (Input) — change

Was:

- `project_id` (string, required)
- `parsed_config_path` (string, required) — FileStorage path to the GAS export
- `is_initial` (boolean, required)
- `correlation_id` (string, optional)

Becomes:

- `template_version_id` (string, required) — PRV-01 has already created the row in `draft` and written `gas_export_path` to it
- `correlation_id` (string, optional)

Note that `is_initial` and `project_id` drop from the contract — PRV-02 derives both from the version row (`is_initial` ≡ `version_number == 1`; `project_id` is the singleton). The contract is tighter and the source of truth is unambiguous.

### Substage outline — restated

1. **Read the version row.** From `CFG_TemplateVersion` by `template_version_id`. Get `gas_export_path`, `version_number`. Derive `is_initial` from `version_number == 1`.

2. **Read the GAS export.** FileStorage read at `gas_export_path`. Returns the raw sheet_data JSON.

3. **Call the connector to parse.** `parse_config_file` action with the sheet_data content. Returns structured config (`fields`, `rules`, `lookups`, `variants`, `suppliers`, `users`, `error_translations`) plus a serialized `parsed_config_json` blob and a `parse_summary`. On parse failure (`status=error` in the connector response), emit `recipe_failed` with `config_unparseable`, return early. The version row stays in `draft` with `gas_export_path` set and downstream paths null — a queryable failed-provisioning artifact.

4. **Write parsed config to FileStorage.** Path: `/versions/v<NNN>/parsed_config.json`. Update `CFG_TemplateVersion.parsed_config_path`.

5. **Emit `config_parsed`.** OBS-01 with `template_version_id` and the parse summary (field count, rule count, etc.) in `details_json`.

6. **Call CFG-01.** Pass `parsed_config_path` (the version-scoped one we just wrote). CFG-01 returns the verdict.

7. **Branch on the verdict.** If `invalid`, the chain stops. CFG-01 already emitted `config_rejected`; PRV-02 doesn't emit again. Return early with the validation summary. PRV-03 is not called. The version row stays in `draft` with two paths set (`gas_export_path`, `parsed_config_path`) and one null (`canonical_model_path`).

8. **Build the canonical model.** Python step. Take the parsed config and `template_version_id`. Mint UUIDs for each field, rule, lookup, variant, variant_field, form_slot_mapping, error_message. Resolve FK references (`depends_on_field_name` → field UUID, `target_field_name` → field UUID, `condition_field_name` → field UUID, etc.). Assign slot pool positions for form-eligible fields per the slot pool algorithm. Build the resolved canonical model object.

9. **Write the canonical model to FileStorage.** Path: `/versions/v<NNN>/canonical_model.json`. Update `CFG_TemplateVersion.canonical_model_path`.

10. **Fire PRV-03.** Pass `template_version_id`. PRV-03 hydrates the CFG tables.

11. **Return.** Output schema unchanged: `template_version_id`, `canonical_model_path`, `validation_summary`.

### Cross-cutting calls — unchanged

Same as before: OBS-01, CFG-01, PRV-03.

### Open questions — change

Two of PRV-02's existing open questions resolve:

- **"The 'is CFG-01 called by PRV-02' question from Stage 2"** — resolved earlier in the plan; now reinforced by this amendment.
- **"E2 version numbering"** — moves to PRV-01 (which is where the version is created). PRV-02 no longer concerns itself with this.

The "canonical model schema" open question persists and is unaffected.

Add a new open question:

- **What happens to draft versions that fail at parse, fail at CFG-01, or fail at canonical model build?** Three failure points before publish, all of which leave incomplete drafts in the data table. Each leaves a different state:
  - Parse failure: `gas_export_path` set, `parsed_config_path` null, `canonical_model_path` null.
  - CFG-01 failure: `gas_export_path` and `parsed_config_path` set, `canonical_model_path` null.
  - Canonical model failure: `gas_export_path` and `parsed_config_path` set, `canonical_model_path` null (same as CFG-01 failure from outside).
  
  Two cleanup options. (a) Accept incomplete drafts as audit artifacts; an orphan sweep can clean them up later if needed. (b) On each failure path, emit a cleanup event that flags the row for removal. Lean (a) — drafts are queryable, harmless (nothing reads from non-`published` versions), and useful for debugging. See "Cleanup of failed-validation drafts" cross-cutting open question.

---

## Amendment 5 — Spreadsheet updates

Two rows in `SDC-recipes-spreadsheet.xlsx` need updating: PRV-01 (row 9) and PRV-02 (row 10).

For each, the cells that change are listed below. Other cells (capability, phases emitted, etc.) stay as-is or get minor tweaks noted inline.

### Row 9 — PRV-01

**Column H (Trigger schema):** unchanged.

> `(-) drive_id_config_json, \n(-) is_initial, \n(-) correlation_id, \n(-) analyst_email`

**Column I (Return schema):** change from `None` to:

> `(-) project_id, \n(-) template_version_id (HTTP 200 to GAS)`

**Column J (Substage outline):** replace with:

> `(1) Validate payload shape. Required fields present and typed correctly. On malformed payload, emit recipe_failed with recipe_invariant and return HTTP 400. (2) Determine project context. E1: verify no Project exists, create one with project_id, analyst_email, customer_name. E2: resolve singleton Project. (3) Create CFG_TemplateVersion row in draft. E1: version_number=1. E2: version_number=MAX+1. (4) Fetch config JSON from Drive via drive_id_config_json. (5) Write the raw sheet_data to FileStorage at CFG_TemplateVersion.gas_export_path. Path convention: /versions/v<NNN>/gas_export.json. (6) Emit provisioning_triggered via OBS-01 with project_id and template_version_id in details_json. (7) Fire PRV-02 with template_version_id (async). (8) Return HTTP 200 to GAS with project_id and template_version_id.`

**Column K (Cross-cutting calls):** append:

> `\n(-) Data Tables operations: Project create/read, CFG_TemplateVersion create, CFG_TemplateVersion update`

**Column M (Error types):** append:

> `\n(-) external_action_failed extends to Project create and CFG_TemplateVersion create. \n(-) recipe_invariant extends to is_initial mismatch with Project existence and duplicate version_number on E2.`

**Column N (State transitions triggered):** unchanged at "None directly," but consider appending:

> `\nImplicit: creates CFG_TemplateVersion in draft (initial state, not a transition).`

**Column O (Invariants honored):** unchanged.

### Row 10 — PRV-02

**Column H (Trigger schema):** replace with:

> `(-) template_version_id, \n(-) correlation_id`

**Column I (Return schema):** unchanged.

> `(-) template_version_id, \n(-) canonical_model_path, \n(-) validation_summary`

**Column J (Substage outline):** replace with:

> `(1) Read version row from CFG_TemplateVersion by template_version_id. Get gas_export_path and version_number. Derive is_initial = (version_number == 1). (2) Read GAS export from FileStorage at gas_export_path. (3) Call connector parse_config_file with sheet_data content. Returns parsed_config_json, structured arrays, parse_summary. On parse failure, emit recipe_failed with config_unparseable, return early. Version stays in draft with gas_export_path set, downstream paths null. (4) Write parsed_config_json to FileStorage at /versions/v<NNN>/parsed_config.json. Update CFG_TemplateVersion.parsed_config_path. (5) Emit config_parsed via OBS-01 with template_version_id and parse_summary. (6) Call CFG-01 with parsed_config_path. CFG-01 returns the verdict. (7) Branch on verdict. If invalid, CFG-01 already emitted config_rejected; PRV-02 returns early. PRV-03 not called. Version stays in draft. If valid, continue. (8) Build the canonical model (Python step). Mint UUIDs for each entity (fields, rules, lookups, variants, variant_fields, form_slot_mappings, error_messages). Resolve FK references from names. Assign slot pool positions. (9) Write canonical model to FileStorage at /versions/v<NNN>/canonical_model.json. Update CFG_TemplateVersion.canonical_model_path. (10) Fire PRV-03 with template_version_id (async). (11) Return.`

**Columns K, L, M, N, O:** unchanged. PRV-02's cross-cutting calls, phases emitted, error types, state transitions, and invariants are unaffected by the substage restructure.

---

## Cross-cutting notes

**The PRV chain now has a consistent shape.** Every PRV recipe reads from FileStorage paths on `CFG_TemplateVersion` and writes to FileStorage paths on `CFG_TemplateVersion`. PRV-01 writes `gas_export_path`. PRV-02 writes `parsed_config_path` and `canonical_model_path`. PRV-03 writes to CFG_ tables (not files, but the pattern still holds — reads canonical_model_path, writes derived data). PRV-04 publishes the version (moves status, writes `published_at`).

**Idempotent retry becomes natural.** If PRV-02 crashes mid-way, re-invoking with the same `template_version_id` reads the same `gas_export_path`, runs the same parse, and proceeds. The version row's path state (some set, some null) indicates exactly how far the chain progressed. This is a meaningful improvement over the pre-amendment design where parts of the chain depended on transient recipe pill content.

**The PRV-02 input contract is tighter.** Dropping `project_id`, `is_initial`, and `parsed_config_path` in favor of just `template_version_id` is a real win: there's one source of truth (the version row) and PRV-02 reads from it. No more "what if `is_initial` disagrees with the project's state" defensive checks.

### Open question — cleanup of failed-validation drafts

Both amendment 3 (PRV-01) and amendment 4 (PRV-02) surfaced the same question: incomplete `CFG_TemplateVersion` rows accumulate when provisioning fails at any of three points (Drive fetch, parse, CFG-01 validation, canonical model build). Each leaves a draft row with some path columns set and others null.

Three handling options:

- **(a) Accept incomplete drafts** as queryable audit artifacts. Drafts are harmless (nothing reads from non-`published` versions); their existence aids debugging. No cleanup logic needed.
- **(b) Per-recipe cleanup**: each failure path explicitly deletes the row before returning. Cleaner data table state, more complex recipes.
- **(c) Orphan sweep**: a periodic recipe scans for `draft` versions older than N days with incomplete paths and cleans them. Decouples cleanup from the provisioning recipes.

**Lean (a).** Drafts are cheap; the audit value is real ("we tried to provision v3 last Tuesday but the analyst's GAS export was malformed"). If draft accumulation becomes a measured problem in production, layer in (c) later.

This is the only meaningful open question this bundle introduces. Worth a brief acknowledgment in PRV-01 and PRV-02's open question lists rather than a separate doc.

---

## Application sequence

If you apply these amendments in this order, each step is independently verifiable:

1. **Data model update** — add `gas_export_path` to `CFG_TemplateVersion`, drop `Project.parsed_config_path`. Update changelog. Diffable doc change.
2. **Build manifest update** — same schema changes in the JSON manifest. Update `_meta.changelog`.
3. **PRV-01 recipe plan update** — substage restructure, contract change.
4. **PRV-02 recipe plan update** — substage restructure, contract change.
5. **Spreadsheet update** — rows 9 and 10 cells.

After all five, the data model and recipe plans are coherent on the GAS-export path question, and the spreadsheet matches.

## What this does not affect

For confidence: these amendments do **not** require changes to —

- CFG-01's recipe plan
- PRV-03's recipe plan
- PRV-04's recipe plan
- The canonical model shape spec
- The phase taxonomy
- The error type taxonomy
- The state machine
- Any Stage 4+ recipe plan (INV, UPL, REV, INC, REM)
- The invariants register (invariant 2 amendment is editorial — the rule it describes is unchanged)

The bundle is genuinely scoped to the PRV chain.
