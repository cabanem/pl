# SDC Data Collection — Recipe Plan (v1, Stage 2 pure-compute capabilities)

## Status

Continuation of `sdc-recipe-plan-v1.md`. Same template, three more recipes — the pure-compute capabilities the build queue calls out for Stage 2.

All three are "thin orchestrators over the connector" by design. The substantive validation, parsing, and rendering logic lives in the SDC Platform Connector's Ruby actions; the recipes handle persistence, FileStorage I/O, event emission, and the orchestration shell.

---

## CFG-01 — Validate Config

### Identity
- **Code:** CFG-01
- **Name:** Validate Config
- **Domain:** CFG
- **Role:** Callable

### Build queue stage
Stage 2 (pure-compute capabilities). Built concurrently with TPL-01 and VAL-01 — all three depend on Stage 1 foundation but not on each other.

### Capability
Primary deep dive — Validate Config. Pure-inspection capability: reads a parsed configuration object and returns a verdict. No persistence. The connector's `validate_config` action does the work; CFG-01 is the orchestration shell.

### Contract

**Input (trigger schema):**
- `parsed_config_path` (string, required) — FileStorage path to the parsed config JSON (output of an upstream parse step)
- `form_field_limit` (integer, optional, default 20) — passes through to the connector

**Output (return schema):**
- `status` (string) — `valid` | `invalid`
- `error_count` (integer)
- `warning_count` (integer)
- `checks` (array of objects) — per-check results from the connector

### Substage outline

1. **Read the parsed config.** FileStorage read at `parsed_config_path`. Returns JSON content.
2. **Call the connector.** `validate_config` action with `parsed_config_json` content and `form_field_limit`. The connector runs all eight check categories plus constraint and syntax checks.
3. **Emit the verdict.** OBS-01 with phase `config_validated` (on pass) or `config_rejected` (on fail). `details_json` carries check counts and a digest of failed checks.
4. **Return the connector's output verbatim.** The caller (typically PRV-02 or an E1/E2 driver) decides what to do with `invalid` status.

CFG-01 has no persistence side effects. The deep dive is explicit: validation is read-only against the system. Persisting the validation outcome (if needed) is the caller's job.

### Cross-cutting calls
- **OBS-01** — for the verdict event

### Phases emitted
- `config_validated` (on pass)
- `config_rejected` (on fail)
- `recipe_failed` (on infrastructure failure — FileStorage unreachable, connector crashed)

### Error types possible
- `config_unparseable` — `parsed_config_path` content wasn't valid JSON (the upstream parser produced bad output)
- `config_invalid` — `validate_config` returned `status: invalid`
- `external_action_failed` — FileStorage read failed, or connector returned an error
- `recipe_invariant` — `parsed_config_path` was empty or the file didn't exist

### State transitions triggered
None. CFG-01 doesn't write any state. The caller (PRV chain) handles state movement.

### Invariants honored
- **Pure inspection.** No data table writes, no FileStorage writes, no outward-facing effects. CFG-01 returns a verdict; the caller decides.
- **Snapshot semantics deferred.** CFG-01 validates *parsed* configs (pre-publish, draft-state work). It doesn't enforce snapshot semantics — that invariant kicks in at publish time, which is a PRV concern.

### Open questions
- **`config_unparseable` vs `external_action_failed` at FileStorage read.** If the file is missing entirely, that's `external_action_failed` (the operation failed). If the file exists but contains malformed JSON, that's `config_unparseable` (the content is wrong). The recipe needs to distinguish these — likely by catching the FileStorage error and the JSON parse error separately.
- **Where does CFG-01 fit in the PRV chain?** Two options. (a) CFG-01 is called by PRV-02 (parse-and-build-canonical-model) before canonical-model construction — validation gates whether the canonical model is even built. (b) CFG-01 is called by PRV-01 (webhook trigger) right after parsing — validation is a top-level orchestration step. Lean (a) — the canonical model only makes sense for valid configs, and tying validation to the recipe that consumes the verdict keeps the contract tight. Worth confirming during PRV-02 design.
- **Soft-fail handling.** The connector returns warnings as well as errors. CFG-01 currently just passes them through. If a future caller wants "valid with warnings → emit at severity `warn` and continue" behavior, that's a CFG-01 enhancement. Defer until the caller exists.

---

## TPL-01 — Build XLSX Template

### Identity
- **Code:** TPL-01
- **Name:** Build XLSX Template
- **Domain:** TPL (template construction)
- **Role:** Callable

### Build queue stage
Stage 2. Independent of CFG-01 and VAL-01; can be built in parallel.

### Capability
Primary deep dive — Build XLSX Template. Pure-construction capability: takes a validated configuration plus a variant identifier and returns XLSX bytes. No persistence inside the recipe — the caller stores.

### Contract

**Input (trigger schema):**
- `canonical_model_path` (string, required) — FileStorage path to the version's canonical model JSON
- `variant_id` (string, required) — which variant to build, or sentinel value for the synthetic base variant
- `labelling_context` (object, optional) — `client_name`, `variant_name` for filename and header banner

**Output (return schema):**
- `xlsx_content` (string) — base64-encoded XLSX bytes
- `suggested_filename` (string) — derived from variant name + client name
- `sheet_metadata` (object) — sheet names produced, data area dimensions, useful for the caller's bookkeeping

### Substage outline

1. **Read the canonical model.** FileStorage read at `canonical_model_path`. Parse JSON.
2. **Resolve the variant.** Filter `cfg_fields` to those claimed by `variant_id`. Sort by position. The result is the column list for the data entry sheet.
3. **Resolve the lookups.** For each field that references a lookup, collect the values from `cfg_lookups`. Group dependent-lookup values by parent.
4. **Build the workbook.** This is the substantive work. A Python step using openpyxl: creates the workbook, lays out the reference sheet with sanitized column names, writes the data entry sheet with headers and validation rules, applies formatting. **The shared sanitization function from the P-02a close-read in the triage doc lives here** — one definition, called from both the named-range step and the INDIRECT-formula step.
5. **Serialize.** Workbook → bytes → base64.
6. **Emit.** OBS-01 with phase `template_built`. `details_json` carries variant_id, field count, lookup count.
7. **Return** the bytes, filename, and metadata.

The caller (typically PRV-04 publishing a version) is responsible for putting the bytes at `CFG_Variant.template_path` in FileStorage.

### Cross-cutting calls
- **OBS-01** — for the success event

### Phases emitted
- `template_built` (success, one emit per variant)
- `recipe_failed` (on failure)

### Error types possible
- `recipe_invariant` — canonical model path missing or empty; variant_id not present in the canonical model; configuration has unresolvable references (should have been caught by CFG-01)
- `external_action_failed` — FileStorage read failed
- `unexpected_error` — Python step crashed in the workbook build (openpyxl error, malformed canonical model)

### State transitions triggered
None.

### Invariants honored
- **Pure construction.** No persistence — bytes returned, caller stores.
- **Shared sanitization.** The bug the triage doc named (P-02a had two sanitization rules that didn't match) is the test this recipe must not fail. One function, called from both sites, exercised by the pre-positioned test cases.

### Open questions
- **Where the sanitization function lives.** Two options. (a) Inside the Python step in TPL-01 — local to the recipe, simple, but means the connector and the recipe each have their own sanitization rule and they could drift. (b) As a connector method exposed via an action — guarantees parity with anything else the connector might sanitize, but it's a new connector surface. Lean (a) for now; the connector doesn't currently need to sanitize names for this purpose, and adding a surface speculatively is the kind of thing the triage doc cautioned against.
- **Static instruction sheet.** The deep dive flagged this. If the canonical model carries instruction text, TPL-01 writes it as a hidden or visible "Read me" sheet. If not, skip. Currently planned: read an optional `instructions_text` field from the canonical model; emit a sheet if present, skip if not. Worth confirming the canonical model schema supports this — if not, this is a Stage 3 (PRV-02) schema decision.
- **Filename collision risk.** The caller is responsible for paths, but the suggested_filename TPL-01 returns is derived from variant_name only. If the caller naively stores by filename, two engagements with a variant named "base" would collide. The deep dive notes this as a caller-side concern; worth making sure PRV-04 includes the version number or variant_id in the storage path.
- **Memory size.** For configurations with many lookups (especially dependent lookups with large parent value sets), the reference sheet can grow. Workato Python steps have memory limits. Unknown whether real-world configs hit them. Worth a stress test during build — a synthetic config with 50 dependent lookups, 100 parents each, 20 children per parent.

---

## VAL-01 — Validate Supplier Input

### Identity
- **Code:** VAL-01
- **Name:** Validate Supplier Input
- **Domain:** VAL
- **Role:** Callable

### Build queue stage
Stage 2. Independent of CFG-01 and TPL-01.

### Capability
Primary deep dive — Validate Supplier Input. Orchestrator over the connector's `validate_upload`, with upstream submission-shape adaptation (XLSX or manual entry) and downstream persistence of `RUN_ValidationResult` and `RUN_FieldError` rows. The capability with internal persistence side effects — distinct from CFG-01 (pure inspection) and TPL-01 (pure construction).

### Contract

**Input (trigger schema):**
- `upload_id` (string, required)
- `submission_source` (string, required) — `file` | `manual_entry`

**Output (return schema):**
- `validation_result_id` (string)
- `verdict` (string) — `passed` | `failed` | `empty` | `structural_failure` | `error`
- `valid_row_count` (integer)
- `invalid_row_count` (integer)
- `trigger_context` (string) — for the caller to pass to STS-01

### Substage outline

Four phases, per the design pass:

**Phase 1 — Read context.**
1. Search `RUN_Upload` by `upload_id`. Resolve `supplier_request_id`, `template_version_id`, `submission_attempt`.
2. Search `CFG_TemplateVersion` by `template_version_id`. Get `canonical_model_path`.
3. FileStorage read at `canonical_model_path`.
4. Update `RUN_Upload.status` to `validating`.

**Phase 2 — Extract rows.** Branch on `submission_source`:
- *File:* FileStorage read `submitted_path`; Python step parses XLSX, validates structure (sheet name, headers), transposes to record-shape rows. On Python crash, route to structural-failure path: persist a minimal `RUN_ValidationResult` + one summary `RUN_FieldError`, return with `verdict=structural_failure`.
- *Manual entry:* FileStorage read `extracted_path` (R3 has already written serialized rows here before calling VAL-01).

**Phase 3 — Validate.** Call connector's `validate_upload` with `canonical_model_json`, `upload_data`, empty `prior_values` and `variant_field_ids` (Stage 2 doesn't filter by variant or fetch prior values). On connector crash, set `verdict.status=error` and continue to Phase 4 — the persistence path handles `error` the same as `failed`.

**Phase 4 — Persist.**
1. Create `RUN_ValidationResult` row. Map verdict status to the table enum (`passed | failed | error`; `empty` maps to `failed`).
2. Batch create `RUN_FieldError` rows from `verdict.errors`.
3. Update `SUP_SupplierRequest`: `current_validation_result_id`, `last_valid_row_count`, `last_invalid_row_count`, `submission_attempt + 1`.
4. Update `RUN_Upload.status` to `validated` (verdict in passed/failed/empty/structural_failure) or `error` (verdict is error).
5. Emit OBS-01 with phase `validation_passed` or `validation_failed` (or `validation_errored` if connector crashed).
6. Return.

### Cross-cutting calls
- **OBS-01** — for the terminal verdict event

### Phases emitted
- `validation_passed` (on `verdict=passed`)
- `validation_failed` (on `verdict=failed | empty | structural_failure`)
- `validation_errored` (on `verdict=error` — the validation engine itself crashed)
- `recipe_failed` (on Phase 1 invariant violation — upload row missing, canonical model file unreadable)

### Error types possible
- `submission_unparseable` — XLSX couldn't be opened
- `submission_structurally_invalid` — XLSX opened but headers don't match canonical model
- `submission_empty` — connector returned `verdict=empty`
- `submission_content_invalid` — connector returned `verdict=failed` with per-cell errors
- `recipe_invariant` — upload row missing, canonical model file missing, `submission_source` unrecognized
- `external_action_failed` — FileStorage read failed, Data Tables operation failed, connector returned an error
- `unexpected_error` — Python extraction step crashed in an unexpected way (covered by Phase 2 structural-failure routing)

### State transitions triggered
**None directly.** VAL-01 returns a verdict and a `trigger_context`; the caller (R2 or R3) invokes STS-01 with the appropriate target_state and trigger_context. The mapping:

| VAL-01 verdict | Caller's STS-01 target_state | Caller's STS-01 trigger_context |
|---|---|---|
| `passed` | `pending_review` | `system_validation_passed` |
| `failed` | `supplier_action_required` | `system_validation_failed` |
| `empty` | `supplier_action_required` | `system_validation_failed` |
| `structural_failure` | `supplier_action_required` | `system_structural_failure` |
| `error` | (current state, refresh-only) | `pipeline_error_alert` |

### Invariants honored
- **Invariant 1 (Single-writer rule).** VAL-01 does **not** write `SUP_SupplierRequest.status`, `current_state_entered_at`, `supplier_display_status`, or `supplier_message`. Those are STS-01's exclusive territory. VAL-01 writes only the denormalized count fields and the `current_validation_result_id` pointer.
- **Invariant 7 (Repeated failures don't churn state).** When a supplier resubmits from `supplier_action_required` and fails again, VAL-01 creates a new `RUN_ValidationResult` row and updates pointers, but the state doesn't move. That non-transition is STS-01's concern (detected via `current_state == target_state`); VAL-01 just returns the verdict.
- **Frozen at issuance.** VAL-01 reads `template_version_id` from `RUN_Upload`, which was frozen at upload creation. Validation always runs against the version stamped on the request, regardless of whether newer versions have been published.

### Open questions
- **Structural-failure path's Python parser.** The XLSX extraction in Phase 2 is the heaviest substage and the most likely source of subtle bugs (cell types, date format, header matching strictness). Worth a focused walkthrough during build. Reference: V-01b's transpose py_eval from the old workspace.
- **`EXPECTED_SHEET_NAME` hardcode.** The Python step needs to know what sheet to look for. Currently planned: hardcode `"Data"` (or whatever TPL-01 produces). When TPL-01 is built, lock down the value. Alternative: add an `expected_sheet_name` field to the canonical model. Defer this decision until TPL-01 lands.
- **Cross-row scope deferred.** The deep dive flagged `ValidationRule.scope` (`submission | supplier | engagement`) as the open question. Stage 2 implements only `submission` scope; `prior_values` is always empty on the connector call. Cross-row scope is a Stage 5+ concern. Worth documenting that `prior_values` plumbing exists in the connector even though VAL-01 doesn't populate it yet.
- **Validation report generation.** The deep dive's sibling capability — `generate_validation_report` — already exists as a connector action. Whether VAL-01 calls it in Phase 4 (producing `RUN_ValidationResult.report_path`) or whether it's a separate post-validation step is undecided. Lean: defer to a Stage 5 decision; for Stage 2, `report_path` stays null and the analyst-facing report is generated lazily on demand by R5 or via a sibling capability.

---

## Stage 2 cross-cutting notes

All three Stage 2 recipes are **pure-compute** from the system's perspective:
- CFG-01 has no persistence side effects at all.
- TPL-01 returns bytes; persistence is the caller's job.
- VAL-01 has internal persistence (`RUN_*` tables and denormalized pointers) but no outward-facing effects.

This shared property is what makes Stage 2 the safest place to verify the foundation (Stage 1) works. None of these recipes can corrupt the supplier-facing world — the worst they can do is fail to produce a verdict or a workbook. The build queue's verification milestone after Stage 2 ("pure-compute path works end-to-end") is the natural pause point before any outward-facing capability (Stage 4's INV-01) gets built.

All three depend on Stage 1 foundation utilities being in place:
- All three call OBS-01 for events.
- VAL-01 does not call STS-01 directly — the caller does. But STS-01 must exist before VAL-01 can be tested end-to-end through R2/R3.
- None of the three calls UTL-01 directly. (UTL-01 is for supplier-facing links; pure-compute recipes don't surface anything to suppliers.)

### Pre-positioned test cases for Stage 2

From the build queue, worth writing during this stage rather than after:

- **TPL-01: dependent-dropdown parent values with awkward characters.** `R&D`, `IT/Security`, `1st Quarter`, leading punctuation, Unicode. Locks in the shared-sanitization invariant.
- **VAL-01: resubmit-after-failure with supplier-scope uniqueness rule.** Deferred along with cross-row scope itself — write the test fixture, mark it as expected-skip until Stage 5+ when scope is wired.
- **VAL-01: corrupt XLSX.** Verifies the structural-failure path persists correctly.
- **VAL-01: empty submission.** Verifies the connector's empty-submission gate fires and VAL-01 returns `verdict=empty`.
- **VAL-01: connector crash.** Forced via a test fixture. Verifies the pipeline-error path persists `RUN_ValidationResult.status=error` and returns `trigger_context=pipeline_error_alert`.

---

## What's next

Stage 3 (provisioning workflows):
- PRV-01 (Provisioning webhook trigger)
- PRV-02 (Parse config, build canonical model)
- PRV-03 (Hydrate CFG tables)
- PRV-04 (Publish version)

These four together implement E1 (initial provisioning) and E2 (config update). PRV-02 is the substantive piece — it's where the canonical model gets built, which has been the blocker on VAL-01 end-to-end testing.
