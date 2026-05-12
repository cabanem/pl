# SDC Data Collection — Data Model (v2.3, Phase 0)

## Status

This is the proposed schema for the new SDC workspace, replacing the 22-table model from the prior workspace. **v2.3 is a reconciliation pass** that brings the data model into sync with the build manifest. Earlier versions had documented an earlier conceptual state that pre-dated several backports the build manifest had already absorbed; v2.3 closes that gap. The build manifest (`data_tables_build-manifest.json`) is now the build target; the data model documents the same schema at a conceptual level.

Specifically, v2.3 applies the naming-doc backports across Project, CFG_Variant, SUP_SupplierRequest, RUN_Upload, and RUN_ValidationResult (renaming `*_file_id` → `*_path` and `*_link` → joined-via-runtime); applies the state-machine backports on Project and SUP_SupplierRequest (`default_due_days`, `current_state_entered_at`, `reminders_enabled`, `due_date`); drops the five columns on SUP_SupplierRequest the manifest dropped (`latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_link`, `last_validation_report_path`, `seeded_template_file_id`); and adds the few new columns (`seeded_data_path`, `report_path`) that landed in the manifest as part of the same backport batch.

v2.2 resolved the GAS-export persistence ambiguity in the PRV chain by adding `CFG_TemplateVersion.gas_export_path` and removing `Project.parsed_config_path`. v2.1 folded in the canonical-model decision (`CFG_TemplateVersion.canonical_model_path`) and applied the naming-doc backports for TemplateVersion. v2 added `SupplierUser.primary` and `ValidationRule.scope`.

All v2 invariants carry forward unchanged except for invariant 3, whose `template_file_id` reference is updated to `template_path` to match the renamed column.

## Foundational decisions

Three answers shaped the model:

1. **One project per workspace.** `Project` is a singleton row. No client-isolation FKs anywhere. No cross-project deferred references.
2. **Form labels via linked table.** The WFA app can join `FormSlotMapping` at render time, so the 20 `*_label` columns on the old request table are gone; labels live in one place per version.
3. **One observability table.** `EventLog` covers both routine audit logs and tracked incidents — severity plus optional resolution fields distinguish them.

## Summary of changes from the 22-table model

**Removed:**
- Cross-project FKs (`correlation_id` → HOME_Requests; `manifest_id` → HOME_Manifests; SYS_EventLogs and RUN_PipelineError cross-project references)
- `WFA_Cache` table
- 20 `*_label` columns from SupplierRequest
- `customer_name` from SupplierRequest
- `template_project_id` and `correlation_id` columns across many tables
- The split between SYS_EventLogs and RUN_PipelineError
- `Project.parsed_config_path` — redundant with `CFG_TemplateVersion.parsed_config_path` *(v2.2)*
- 5 columns on SupplierRequest: `latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_link`, `last_validation_report_path`, `seeded_template_file_id` — recipes join down to `RUN_Upload` / `RUN_ValidationResult` for these reads *(v2.3 — applies the naming-doc decision that landed in manifest v5.0.0)*

**Added:**
- `Project` singleton table
- `Supplier` extracted from the request table
- `SupplierUser.primary` (boolean) — designated primary contact per supplier *(v2)*
- `ValidationRule.scope` (enum) — uniqueness scope for cross-row validation *(v2)*
- `CFG_TemplateVersion.canonical_model_path` (string) — per-version snapshot of the fully resolved configuration *(v2.1)*
- `CFG_TemplateVersion.gas_export_path` (string) — per-version raw GAS sheet_data, pre-parse audit artifact *(v2.2)*
- `Project.default_due_days` (integer) — engagement-level default supplier due-date offset *(v2.3)*
- `Project.seeded_data_path` (string) — engagement source file for incumbent data seeding *(v2.3)*
- `SupplierRequest.current_state_entered_at` (date_time) — timestamp of most recent state transition; STS-01 single-writer *(v2.3)*
- `SupplierRequest.reminders_enabled` (boolean) — per-request reminder opt-out *(v2.3)*
- `SupplierRequest.due_date` (date) — per-request override of the engagement default *(v2.3)*
- `RUN_ValidationResult.report_path` (string) — FileStorage path to the validation report XLSX *(v2.3)*

**Renamed:**
- `Project.incumbent_data_file_id` → `incumbent_data_path` *(v2.3, naming-doc backport)*
- `CFG_Variant.template_file_id` → `template_path` *(v2.3, naming-doc backport)*
- `SupplierRequest.template_file_id` → `template_path` *(v2.3, naming-doc backport)*
- `SupplierRequest.approved_file_id` → `approved_path` *(v2.3, naming-doc backport)*
- `SupplierRequest.seeded_data_file_id` → `seeded_slice_path` *(v2.3, naming-doc backport)*
- `RUN_Upload.submitted_file_id` → `submitted_path` *(v2.3, naming-doc backport)*
- `RUN_Upload.extracted_file_version_id` → `extracted_path` *(v2.3, naming-doc backport)*
- `RUN_Upload.valid_payload` → `valid_payload_json` *(v2.3)*
- `RUN_ValidationResult.valid_rows` → `valid_row_count` *(v2.3)*
- `RUN_ValidationResult.invalid_rows` → `invalid_row_count` *(v2.3)*

**Net:** 22 → 18 tables. Every remaining FK has a single, clear purpose.

---

## Group A — Project (1 table)

### Project

Singleton row holding workspace identity and engagement-level configuration.

- `analyst_email`, `customer_name`, `target_vms`
- `output_drive_folder_id`, `incumbent_data_path`, `seeded_data_path`, `incumbent_split_config`
- `reminder_days_1`, `reminder_days_2`, `reminder_days_3`, `default_due_days`
- `project_completion_status` (active | inactive)
- `external_request_id` — was `correlation_id`; kept as plain string for upstream traceability, no FK

PK: `project_id` (UUID). No incoming FKs anywhere; the project is the implicit context for the entire workspace.

**On `default_due_days`:** engagement-level default offset (from invitation) for computing per-request due dates. Per-request override lives in `SupplierRequest.due_date`. Most suppliers in an engagement use the default; analysts can grant per-request exceptions.

**On `seeded_data_path`:** FileStorage path to the source incumbent dataset for the engagement, sliced into per-request `seeded_slice_path` files by the seeding workflow (INC-01).

---

## Group B — Configuration (8 tables, version-scoped)

### TemplateVersion

A version of the data-collection template. Snapshot semantics: once published, immutable.

- `version_number` (immutable), `version_label` (write-once)
- `status` — draft | published | deprecated; forward transitions only
- `master_template_path` (FileStorage path to the master XLSX)
- `gas_export_path` (FileStorage path to the raw GAS export — sheet_data JSON exactly as the analyst's master config workbook produced it. Pre-parse audit artifact. Distinct from `parsed_config_path` (post-parse, structurally cleaned) and `canonical_model_path` (resolved). Written by PRV-01 at row creation, immutable thereafter) *(v2.2)*
- `parsed_config_path` (per-version snapshot of the workbook's contents — structurally cleaned but pre-FK-resolution. Distinct from `gas_export_path` (pre-parse) and `canonical_model_path` (resolved). Written by PRV-02 after a successful connector parse)
- `canonical_model_path` (per-version snapshot of the fully resolved configuration — UUIDs minted, FKs wired, slot pool assigned. Audience: runtime consumers — PRV-02, VAL-01's connector, future builders)
- `published_at` (write-once), `validation_summary`

PK: `template_version_id`. **Removed:** `template_project_id`, `manifest_id`.

### Field

Column definition in the data-collection template.

- `field_name` (immutable within version), `description`, `data_type`, `data_format`, `position`
- `required`, `must_be_empty`, `column_unique`, `strict`, `visible`
- `field_length_validation`, `numeric_field_validation`, `date_field_validation`, `field_input_validation`, `data_cleaning_flags`
- `lookup_name` (soft-join to Lookup), `depends_on` (self-FK for cascading dropdowns)
- `control_type` (derived from `data_type` + `lookup_name`)

PK: `field_id`. FK: `template_version_id` (immutable).

### Lookup

One row per (lookup_name, value).

- `lookup_name` (immutable within version), `valid_value`, `parent_value` (cascade trigger), `project_specific`

PK: `lookup_id`. FK: `template_version_id` (immutable). Soft-joined from `Field.lookup_name` and `FormSlotMapping.lookup_name`.

### ValidationRule

Cross-field rules. Was `CFG_Rule`.

- `rule`, `condition_field_id`, `conditional_value`
- `error_message`, `error_message_custom` (override), `strict_enforcement`
- `scope` — enum: `submission` | `supplier` | `engagement`; default `submission` *(v2)*
- `target_field`, `condition_field` — denormalized display names for Workato Data Tables UI readability

PK: `rule_id`. FKs: `field_id` (primary, immutable), `condition_field_id`, `template_version_id`.

**On `scope`:** controls the row set against which uniqueness/aggregate rules evaluate. `submission` matches the v1 default behavior — the rule evaluates within the current upload only. `supplier` extends the row set to all validated/approved prior submissions from the same supplier (relevant for resubmission scenarios; see the resubmit-after-failure test case in the handoff). `engagement` extends to all validated/approved submissions across all suppliers in the engagement. The pre-fetch query for `supplier`- and `engagement`-scoped rules must filter to validated/approved prior rows — including failed prior attempts produces false-positive uniqueness errors against the supplier's own rejected submissions.

### Variant

A flavor of the template with a subset of fields.

- `variant_name` (immutable within version), `description`, `template_path` (variant XLSX) *(renamed in v2.3 from `template_file_id`)*

PK: `variant_id`. FK: `template_version_id` (immutable).

### VariantField

Junction. Variant ↔ Field.

PK: `variant_field_id`. FKs: `variant_id` (immutable), `field_id` (immutable).

### FormSlotMapping

Maps fields to fixed WFA slot columns. **This is where slot labels now live.**

- `slot_name` — e.g., "slot_text_01"; soft-joined to the matching column on SupplierRequest
- `display_label` — was on SupplierRequest as `*_label`
- `control_type` (text | number | dropdown | date | checkbox)
- `required`, `lookup_name` (for dropdowns), `position`

PK: `form_slot_id`. FKs: `template_version_id`, `field_id` (immutable).

### ErrorMessage

Per-version snapshot of error code → human-readable message. Decision: per-version copies (snapshot integrity over storage savings).

- `error_code`, `human_readable_message`, `required_placeholders`

PK: `error_translation_id`. FK: `template_version_id` (immutable).

---

## Group C — Supplier (3 tables)

### Supplier

**New table — extracted from the old `WFA_SupplierRequest`.** Supplier identity. Survives across template versions.

- `supplier_name`, `default_variant_id` (optional), `status` (active | deactivated), `created_at`

PK: `supplier_id`. Optional FK: `default_variant_id`. **No `template_version_id`** — suppliers exist independent of versions.

### SupplierUser

Contacts at a supplier.

- `user_email` (unique per `supplier_id`), `contact_name`, `status` (active | deactivated), `created_at`
- `primary` — boolean; designates the primary contact for this supplier *(v2)*

PK: `supplier_user_id`. FK: `supplier_id` (immutable). **Major change (v1):** previously FK was `supplier_request_id`; now it's `supplier_id`, so users are first-class to the supplier and survive re-engagement.

**On `primary`:** drives the designated-assignee logic in *Invite supplier users* and the corresponding cluster siblings. Exactly-one-per-supplier is not a column constraint — Workato Data Tables cannot express it natively — but is enforced at config-issuance time by *Validate config*. See invariant #6.

### SupplierRequest

Per-version ask of a supplier. Lifecycle state, file pointers, validation summary.

**Identity & version**
- `supplier_id`, `assigned_version_id` (immutable), `assigned_variant_id` (immutable)
- `assignee_email` (immutable), `external_request_id` (was `correlation_id`; plain string)

**Status — single source of truth**
- `status` — backend state machine value
- `current_state_entered_at` — timestamp of the most recent transition into `status`; updated atomically with `status` *(v2.3, state-machine backport)*
- `supplier_display_status`, `supplier_message` — denormalized, written by **exactly one** recipe (the status-change handler, STS-01). See invariant #1 below.
- `reminders_enabled` — boolean, default true; per-request reminder opt-out *(v2.3, state-machine backport)*

**File pointers** *(all `_path` per v2.3 naming-doc reconciliation)*
- `template_path` — the only path on this row whose contents change over its lifetime (regenerated on each resubmission cycle to carry forward valid prior rows; renamed from `template_file_id`)
- `has_seeded_data`, `seeded_slice_path` (renamed from `seeded_data_file_id`)
- `approved_path` (immutable, write-once at approval; renamed from `approved_file_id`), `approved_at` (write-once)

> **Dropped from prior versions** *(v2.3, applying manifest v5.0.0 decisions)*: `seeded_template_file_id`, `latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_path`, `last_validation_report_link`. Recipes that need the latest upload join `RUN_Upload`; recipes that need the latest validation report join `RUN_ValidationResult`; links are generated on demand by `UTL-01`.

**Validation pointers & counts**
- `current_validation_result_id` — FK to `RUN_ValidationResult` (bug fix from prior model — was wired to `FieldError.field_id` in v0)
- `last_valid_row_count`, `last_invalid_row_count` — denormalized from current ValidationResult
- `submission_attempt`

**Reminders & access**
- `last_reminder_tier`, `last_reminder_sent_at`, `template_access_time`
- `due_date` — per-request due date, defaults computed from `Project.default_due_days` at invitation; analyst-editable thereafter *(v2.3, state-machine backport)*

**Slot pool (form data binding)**
- `slot_text_01..08`, `slot_num_01..02`, `slot_bool_01..02`, `slot_sel_01..04`, `slot_date_01..04`
- All stored as strings for WFA widget compatibility; semantic types enforced downstream in validation
- **Labels are no longer stored here** — joined from `FormSlotMapping` at render

**Removed:** `template_project_id`, `correlation_id`, `customer_name`, all 20 `*_label` columns.

PK: `supplier_request_id`. FKs: `supplier_id`, `assigned_version_id`, `assigned_variant_id`, `current_validation_result_id`.

---

## Group D — Runtime (5 tables)

### Upload

Supplier file submission.

- `submitted_path` (immutable; renamed from `submitted_file_id` per v2.3)
- `extracted_path` (renamed from `extracted_file_version_id` per v2.3)
- `status` (received | extracting | validating | validated | error) — `error` renamed from `failed` per state-machine backport
- `submitted_at` (immutable)
- `valid_payload_json` (long-text JSON; renamed from `valid_payload` per v2.3)

PK: `upload_id`. FKs: `supplier_request_id` (immutable), `template_version_id` (frozen at creation, copied from `SupplierRequest.assigned_version_id`).

### ValidationResult

Outcome of validating an Upload.

- `status` (running | passed | failed | error)
- `valid_row_count`, `invalid_row_count` — both write-once; renamed from `valid_rows` / `invalid_rows` per v2.3
- `report_path` — FileStorage path to the validation report XLSX, generated by VAL-01 *(v2.3 addition)*
- `completed_at` — write-once

PK: `validation_result_id`. FKs: `upload_id` (immutable), `template_version_id`.

### FieldError

Per-cell validation failure.

- `row_number`, `submitted_value`, `error_message`

PK: `field_error_id`. FKs: `validation_result_id` (immutable), `field_id`.

### ManualEntry

Supplier-side single-row form submission via WFA.

- `row_number`, `field_id` (immutable), `field_name` (denormalized for the WFA table widget header), `submitted_value`

PK: `manual_entry_id`. FK: `supplier_request_id`.

### ReviewNote

Analyst approval/rework decisions.

- `author_email`, `note_text` (long-text), `review_action` (approved | rework), `created_at` (immutable)

PK: `review_note_id`. FK: `supplier_request_id` (immutable).

---

## Group E — Observability (1 table)

### EventLog

Unified audit log + incident tracking. Was `SYS_EventLogs` plus `RUN_PipelineError`.

**Core event**
- `timestamp`, `source_recipe`, `step_number`, `phase`, `severity` (info | warn | error)
- `human_message`, `details_json`
- `analyst_email`

**Optional context (nullable)**
- `supplier_request_id` (FK; many events aren't request-scoped)
- `error_type`

**Incident tracking (populated only for events that require follow-up)**
- `alert_sent`, `resolved`, `resolved_at`

PK: `event_id`. Optional FK: `supplier_request_id`.

**Removed:** `correlation_id` (no cross-project), `project_id` (singleton, implicit), `template_project_id`.

---

## Invariants

These are the contracts the recipes must honor. Documented here so they're not relitigated.

1. **Status writer rule.** Only the status-change handler recipe (STS-01) writes `SupplierRequest.status`, `current_state_entered_at`, `supplier_display_status`, and `supplier_message`. Every other recipe reads. Drift between the four fields is impossible by construction. *(Field list updated in v2.3 to include `current_state_entered_at` per the state-machine backport.)*

2. **Snapshot semantics.** Once a TemplateVersion transitions to `published`, no Field, Lookup, ValidationRule, Variant, VariantField, FormSlotMapping, or ErrorMessage row scoped to that version is ever updated. New version = new rows. Typo fixes flow forward via new versions, never via in-place edits to published rows. *The same rule covers per-version file artifacts: `gas_export_path`, `parsed_config_path`, and `canonical_model_path` are write-once and immutable. Note that `gas_export_path` is written at row creation by PRV-01, not at publish — but the write-once rule still holds; PRV-01's create is the only write to that column. `parsed_config_path` and `canonical_model_path` follow the standard pattern: written by PRV-02 during the draft phase, locked at publish.*

3. **FileStorage TTL re-hydration.** `SupplierRequest.template_path` is the only path on the request that's rewritten over the row's lifetime — it's regenerated on each resubmission cycle to carry forward valid prior rows. Shareable links derived from any path are 10-day TTL; UTL-01 generates them on demand. *Updated in v2.3 to reflect the rename from `template_file_id` to `template_path` and to clarify that the regeneration is recipe-driven, not link-TTL-driven.*

4. **Supplier ↔ SupplierUser independence.** A SupplierUser belongs to a Supplier, not to any one SupplierRequest. Re-engagement on a new TemplateVersion creates new SupplierRequest rows but reuses existing Supplier and SupplierUser rows.

5. **External references are strings, not FKs.** `external_request_id` (formerly `correlation_id`) traces back to upstream intake systems but does not constrain or join inside this workspace.

6. **Primary user is exactly one per supplier.** *(v2)* Each `Supplier` has exactly one `SupplierUser` row with `primary = true`. Not enforceable as a schema constraint in Workato Data Tables; enforced at config-issuance time by the *Validate config* capability. Adding, deactivating, or re-electing a primary contact flows through *Validate config* (or its sibling *Add user to request* when scoped to a single request) so the invariant is checked on every mutation that could violate it.

---

## Changelog

**v2.3** — Reconciliation pass. Brought the data model into sync with the build manifest, which had absorbed the naming-doc and state-machine backports as part of its v5.0.0 Phase 0 rebuild but those backports had only been partially documented in this data model (v2.1 noted the TemplateVersion renames, but the Project, CFG_Variant, SupplierRequest, RUN_Upload, and RUN_ValidationResult renames had not been applied to the prose). Specifically:

- Applied naming-doc renames: `Project.incumbent_data_file_id` → `incumbent_data_path`; `CFG_Variant.template_file_id` → `template_path`; `SupplierRequest.template_file_id` → `template_path`; `SupplierRequest.approved_file_id` → `approved_path`; `SupplierRequest.seeded_data_file_id` → `seeded_slice_path`; `RUN_Upload.submitted_file_id` → `submitted_path`; `RUN_Upload.extracted_file_version_id` → `extracted_path`; `RUN_Upload.valid_payload` → `valid_payload_json`; `RUN_ValidationResult.valid_rows` → `valid_row_count`; `RUN_ValidationResult.invalid_rows` → `invalid_row_count`.
- Added state-machine backports: `Project.default_due_days`, `SupplierRequest.current_state_entered_at`, `SupplierRequest.reminders_enabled`, `SupplierRequest.due_date`.
- Added new columns from the naming-doc backport batch: `Project.seeded_data_path`, `RUN_ValidationResult.report_path`.
- Dropped 5 columns on SupplierRequest per the v5.0.0 manifest decision: `latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_link`, `last_validation_report_path`, `seeded_template_file_id`. Recipes join down to `RUN_Upload` and `RUN_ValidationResult` for these reads.
- Updated invariant 1 to include `current_state_entered_at` in the STS-01 single-writer field set.
- Updated invariant 3 to reflect the `template_path` rename and to clarify the regeneration semantics (recipe-driven on resubmission, not link-TTL-driven).
- Status section: removed the assertion that state-machine work was "pending in subsequent sessions" — it has long since landed in the manifest.

No schema additions or removals beyond what the manifest already specified. The conceptual model and the build target are now coherent.

**v2.2** — Added `CFG_TemplateVersion.gas_export_path` (string, required), the per-version FileStorage path to the raw GAS sheet_data export — pre-parse audit artifact. Removed `Project.parsed_config_path` as redundant with the per-version equivalent `CFG_TemplateVersion.parsed_config_path`. Amended invariant 2 to cover `gas_export_path` under snapshot semantics, noting the write-once timing nuance (row creation rather than publish). Resolves the GAS-export persistence ambiguity in the PRV chain: PRV-01 now creates the version row and writes `gas_export_path`; PRV-02 reads from `gas_export_path`, parses, writes `parsed_config_path`, builds the canonical model, writes `canonical_model_path`. No other schema changes.

**v2.1** — Added `CFG_TemplateVersion.canonical_model_path` (string) and applied the naming-doc file-column backports to TemplateVersion (`master_template_file_id` → `master_template_path`, `parsed_config_file_id` → `parsed_config_path`). The canonical model addition reflects the architectural decision to persist a fully resolved per-version configuration snapshot for runtime consumers, distinct from the structurally-cleaned `parsed_config_path` artifact. No invariants change; both new and renamed columns follow the existing snapshot-semantics rule (invariant 2). *(In retrospect, this revision applied the naming-doc backport only to TemplateVersion; v2.3 applies it to the remaining tables.)*

**v2** — Added `SupplierUser.primary` (boolean) and `ValidationRule.scope` (enum: `submission` | `supplier` | `engagement`, default `submission`). Added invariant #6 covering the exactly-one-primary-per-supplier rule. No other changes from v1; all v1 fields, FKs, and invariants 1–5 carry forward unchanged.

**v1** — Initial Phase 0 data model. 22 → 18 tables. Removed cross-project FKs, `WFA_Cache`, the 20 `*_label` columns on SupplierRequest, `customer_name` on SupplierRequest, and the SYS_EventLogs/RUN_PipelineError split. Added `Project` singleton and extracted `Supplier` from the request table.
