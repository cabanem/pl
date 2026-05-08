# Stage 2 Capabilities — Revised First Pass

Three pure-compute callables. Verdict shapes settled per the reversals; structural-failure built in from the start; no shared verdict shape across CFG-01 and VAL-01.

---

## CFG-01 — Validate config

**Handle.** CFG-01.

**What it does.** Thin wrapper recipe — Triage v2's call to leave it that way is the right one. The connector's `parse_config_file` and `validate_config` actions cover the eight check categories from the deep dive end-to-end (project-level settings, field internal consistency, field-to-field references, lookups, cross-field rules, variants, form slot mapping, supplier list) plus dependency-cycle detection. Stage 1 added the v2 invariant 6 check (exactly one primary user per supplier) inside `validate_config`, so by the time CFG-01 is built the connector already knows everything that matters.

The recipe is the orchestration shell:

1. Take the config file pointer.
2. Call `parse_config_file`. If that fails (bad JSON, structural problems beneath the validate-config layer), return a `structural_failure` verdict — single blocking error, no per-error analysis.
3. Call `validate_config` against the parsed object. Always run all checks; never short-circuit on first failure. The deep dive is explicit on this — analysts should see all errors at once.
4. Compose the verdict.
5. Return.

The recipe itself does no DB writes, no event emissions, no file moves. Callers decide what to do with the result. E1 stage 4 and E2 emit `config_validated` or `config_rejected` themselves; the analyst-iteration callsite from the workbook handles its own surfacing.

**Inputs.**
- `config_drive_id` (string, required) — Drive file ID for the JSON the GAS layer wrote.
- `source_recipe` (string, required) — caller identifier for OBS-01 if the recipe crashes; doesn't appear in the verdict.

**Outputs.**
- `verdict.status` — `pass` | `fail` | `structural_failure`
- `verdict.summary` — counts (fields, lookups, rules, variants, suppliers) when status is `pass` or `fail`; null on `structural_failure`
- `verdict.errors` — array of `{ where, what, severity }`. One array, severity per item. On `pass`, may contain warning-severity items; on `fail`, contains at least one error-severity item; on `structural_failure`, exactly one item describing the parse/structural failure.
- `parsed_config` — the parsed object, returned alongside the verdict so callers don't re-parse if they want to persist it. Null on `structural_failure`.

The error-item shape `{ where, what, severity }` matches the deep dive verbatim:
- `where` — sheet plus row, or field name plus property.
- `what` — language the analyst can act on.
- `severity` — drives whether provisioning stops or proceeds with warnings.

**Side-effect signature.** None. Pure inspection. The monitor-errors path emits a `recipe_failed` event via OBS-01, but that's hygiene, not a domain effect.

---

## PRV-02 — Build XLSX template

**Handle.** PRV-02 (proposed). The naming-doc example used `PRV-02 Parse Config` as illustrative — `parse_config_file` is a connector action and doesn't need a recipe shell, so the slot's available. PRV is the closest fit (template construction is part of the version-publishing pipeline). Worth confirming, but going with PRV-02.

**What it does.** Full rebuild per substages 1–10 of the deep dive. Triage v2 disqualified P-02a (the silent dependent-dropdown sanitization bug); the Python is reference material only. The recipe is new.

The recipe is a handful of upstream reads plus one Python step:

1. Read `CFG_Field` rows for `template_version_id`. If `variant_id` is provided, narrow by joining `CFG_VariantField`. *(Substage 1.)*
2. Read `CFG_Lookup` rows for `template_version_id`, narrowed to the lookups the resolved field list points at. *(Substage 2.)*
3. Read `CFG_ValidationRule` rows for `template_version_id`, narrowed to rules whose `field_id` is in the resolved field list — needed for the data-validation rules baked into the workbook. *(Feeds substage 7.)*
4. Read `CFG_ErrorMessage` rows for `template_version_id` — for any messages the workbook surfaces for type/format violations.
5. **Python step**: substages 3–9 in memory — lay out the reference sheet, create the workbook, write the data-entry header, write the reference sheet content, apply data validation rules, apply column formatting, serialize to bytes. **The shared sanitization function (called from both the named-range step and the INDIRECT-formula step) is the build-time invariant the test cases lock in.** This is the bug class P-02a shipped with.
6. Return.

**Inputs.**
- `template_version_id` (string, required)
- `variant_id` (string, optional) — null means "no variant; include all fields the version defines"
- `customer_name` (string, required) — for filename and header banner
- `variant_name` (string, optional) — for filename. Defaults to `"base"` when `variant_id` is null; otherwise derived by reading `CFG_Variant`.

**Outputs.**
- `file_content` (string, base64-encoded XLSX bytes — Workato file conveyance shape)
- `suggested_filename` (string)
- `metadata` (object) — sheet names, byte size, row count

**Side-effect signature.** None. Pure construction. The recipe does no FileStorage writes; the caller (E1's PRV chain) writes the bytes to `/templates/v{N}/variants/{variant_id}.xlsx` per the file-model layout and records the path on `CFG_Variant.template_path`.

**Open questions.**
- Confirm domain code (PRV-02 vs. introducing TPL).
- The deep dive flagged "static instruction sheet" as in-scope but trivial — if the configuration provides instruction text, write a sheet; otherwise skip. Need to confirm whether the configuration even has a place for instruction text yet.
- Empty variant (a variant claiming zero fields) — fail loudly here, or silently produce a header-only workbook? Connected to Validate config's "empty edge cases" question. Instinct: fail loudly. Header-only is almost never what anyone wants.

---

## VAL-01 — Validate supplier input

**Handle.** VAL-01. Single recipe; the prior V-01a/V-01b split was for testability when the connector wasn't doing the validation engine. Now the connector IS the engine, so the recipe is just orchestration around it.

**What it does.** Substages 1–10 from the deep dive, with a branch-then-merge structure: substages 2 (resolve to rows) and the Upload-state portion of substage 9 differ between the file-upload (R2) and manual-entry (R3) callsites; everything else is shared. Structural failure is a first-class verdict status, surfaced before per-row checking and propagating through to a distinct trigger context for the state machine.

**Shared spine** (substages 1, 3, 4–8, persistence-shared-portion, return):

- Substage 1: read `SUP_SupplierRequest`, get `assigned_version_id`. Frozen at issuance per state-machine invariant 6 — never the latest version.
- Substage 3: empty-submission gate. Zero rows is hard-fail per the deep dive default.
- Substages 4–8: call connector's `validate_upload`, passing parsed rows, version_id (connector reads CFG_*), and the optional `prior_values` set if any rule has scope `supplier` or `engagement`. Stage 1's connector adjustment for `prior_values` and `scope` awareness is what makes the supplier/engagement scopes work.
- Persistence (shared portion): write `RUN_ValidationResult` with `valid_row_count`, `invalid_row_count`, `completed_at`; write one `RUN_FieldError` per offending cell; generate the report XLSX via `generate_validation_report` and write it at `/requests/{request_id}/validations/{validation_result_id}/report.xlsx`, recording the path on `RUN_ValidationResult.report_path`; update SupplierRequest's denormalized pointers (`current_validation_result_id`, `last_valid_row_count`, `last_invalid_row_count`).
- Return the verdict.

**Branching** (substage 2 + Upload-state portion of persistence):

- **R2 (file_upload).** Read `RUN_Upload` for `submitted_path` and `template_version_id`. Transition Upload `received → extracting`, parse the XLSX into rows. If parsing fails — wrong sheet, missing required columns, corrupt workbook — write the structural-failure shape: `RUN_Upload.status = error`, `RUN_ValidationResult.status = error`, one summary row in `RUN_FieldError` describing the structural problem, `report_path = null`, return `verdict.status = structural_failure` and stop. If parsing succeeds, write `extracted_path`, transition `extracting → validating`, run the shared spine. After persist on the success path, transition Upload `validating → validated`. If the validation engine itself crashes (distinct from validation finding problems): `RUN_Upload.status = error`, `RUN_ValidationResult.status = error`, return `verdict.status = pipeline_error`.
- **R3 (manual_entry).** Read `RUN_ManualEntry` rows for the request, transpose into row-shaped form. No Upload row, no Upload state machine. No structural-failure path — manual entry can't be unparseable. Run the shared spine.

**The `prior_values` pre-fetch** (for `supplier`- and `engagement`-scoped rules) is where the resubmit-after-failure trap lives. Filter to validated/approved prior submissions, not "any prior submission" — otherwise the supplier sees uniqueness errors against their own failed prior attempts. The pre-positioned test case from the build queue covers exactly this.

**Inputs.**
- `submission_source` (string, required) — `file_upload` | `manual_entry`
- `supplier_request_id` (string, required)
- `upload_id` (string, required only when `submission_source = file_upload`)

**Outputs.**
- `verdict.status` — `pass` | `fail` | `structural_failure` | `pipeline_error`
- `verdict.summary` — `valid_row_count`, `invalid_row_count`, error breakdown by category (when status is `pass` or `fail`); single-error description (when status is `structural_failure` or `pipeline_error`)
- `verdict.errors` — array of `{ row, field, category, code, supplier_message, severity }`. One array, severity per item. Empty on `pass`; populated on `fail`; single summary entry on `structural_failure` or `pipeline_error`.
- `validation_result_id` (string) — the persisted result the caller can hand to STS-01 for derivation
- `report_path` (string) — set when status is `fail`; null on `pass`, `structural_failure`, or `pipeline_error`

The error-item shape `{ row, field, category, code, supplier_message, severity }` is the supplier-input domain shape — different from CFG-01's `{ where, what, severity }` because supplier-input errors are about data cells (row plus field) while config errors are about workbook structure.

**Side-effect signature.** Internal persistence — substantial. Writes `RUN_ValidationResult`, `RUN_FieldError` rows, the report file (success path only), denormalized pointers on `SUP_SupplierRequest`. Updates `RUN_Upload.status` (R2 only). Does NOT write `SUP_SupplierRequest.status` (STS-01's exclusive domain per invariant 1) and does NOT notify supplier or analyst (R2/R3 orchestrators handle that downstream).

**State-machine derivation table ripple.** Adding `structural_failure` as a verdict status means R2's caller will hand STS-01 a new trigger context. Proposed: `system_structural_failure`. The derivation table needs a corresponding row for `(supplier_action_required, system_structural_failure)` whose message names the structural problem without referencing `{invalid_row_count}` or `{validation_report_link}` (neither applies). This is a state-machine doc revision; flagging that ripple. Same shape applies for `pipeline_error` if you want a distinct supplier-facing message for "validation engine crashed" — though arguably that one shouldn't transition the request at all and should just alert the analyst, leaving the request in its prior state. Worth deciding.

---

## Cross-cutting

**Stage 1 dependencies.** All three call OBS-01 from their monitor-errors block with `recipe_failed` phase. CFG-01 and PRV-02 have no other Stage 1 dependency. VAL-01 doesn't call STS-01 directly (it returns a verdict; the orchestrator calls STS-01) but it DOES depend on Stage 1's `validate_upload` connector adjustments (`prior_values` parameter, `scope`-aware rule evaluation).

**Persistence ownership.** CFG-01 and PRV-02 hand results back; callers persist. VAL-01 owns the validation chronicle's persistence (`RUN_ValidationResult`, `RUN_FieldError`, report file, SupplierRequest denorm pointers, `RUN_Upload.status`). The state-writer rule keeps VAL-01 out of `SUP_SupplierRequest.status` regardless.

**Idempotency.** CFG-01 and PRV-02 are idempotent by construction (same input → same output). VAL-01 is not — each call creates a new `RUN_ValidationResult`; calling it twice for the same upload produces two results. That's by design (the no-op transition under state-machine invariant 7 expects this), but worth knowing.

**Verdict-shape vocabulary, kept aligned across CFG-01 and VAL-01:**
- `status` values follow the same naming pattern: `pass | fail | structural_failure` for both, with VAL-01 adding `pipeline_error`.
- Severity vocabulary is shared.
- Both follow "errors live in one array, severity per item."
- Error-item shape is domain-specific: CFG-01 uses `{ where, what, severity }`; VAL-01 uses `{ row, field, category, code, supplier_message, severity }`.

---

## What's next

Three things worth settling before I draft the Workato step inventory (recipe-by-recipe, with trigger schemas, action types, and datapill maps):

1. **PRV-02 vs. introducing TPL** as a domain code.
2. **Empty-variant handling** in PRV-02 — fail loudly, or header-only workbook?
3. **State-machine derivation rows** for the new trigger contexts `system_structural_failure` and (maybe) `system_pipeline_error` — including whether `pipeline_error` should transition state at all, or just alert and leave the request in place.

Item 3 in particular is a state-machine doc revision, so worth deciding before VAL-01's wiring is concrete. Want to take those one at a time, or batch them?
