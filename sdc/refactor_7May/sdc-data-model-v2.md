# SDC Data Collection — Data Model (v2.1, Phase 0)

## Status

This is the proposed schema for the new SDC workspace, replacing the 22-table model from the prior workspace. **v2.1 folds in the canonical-model decision** (`CFG_TemplateVersion.canonical_model_path`) **and applies the naming-doc backports for TemplateVersion** (`master_template_file_id` → `master_template_path`, `parsed_config_file_id` → `parsed_config_path`). v2 folded in the two schema additions from the cluster resolutions in `sdc-callable-triage-v2.md`: `SupplierUser.primary` and `ValidationRule.scope`.

All v2 additions (and v1 fields, FKs, invariants) carry forward unchanged. The version bump exists because the authoritative schema document is referenced elsewhere and a v2 reader needs to know to look for v2.1.

Other Phase 0 work — state machine, naming and prefix conventions, ADR triage, callable reuse-vs-rebuild — is still pending in subsequent sessions.

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

**Added:**
- `Project` singleton table
- `Supplier` extracted from the request table
- `SupplierUser.primary` (boolean) — designated primary contact per supplier *(v2)*
- `ValidationRule.scope` (enum) — uniqueness scope for cross-row validation *(v2)*
- `CFG_TemplateVersion.canonical_model_path` (string) — per-version snapshot of the fully resolved configuration *(v2.1)*

**Net:** 22 → 18 tables. Every remaining FK has a single, clear purpose.

---

## Group A — Project (1 table)

### Project

Singleton row holding workspace identity and engagement-level configuration.

- `analyst_email`, `customer_name`, `target_vms`
- `output_drive_folder_id`, `parsed_config_file_id`, `incumbent_data_file_id`, `incumbent_split_config`
- `reminder_days_1`, `reminder_days_2`, `reminder_days_3`
- `project_completion_status` (active | inactive)
- `external_request_id` — was `correlation_id`; kept as plain string for upstream traceability, no FK

PK: `project_id` (UUID). No incoming FKs anywhere; the project is the implicit context for the entire workspace.

---

## Group B — Configuration (8 tables, version-scoped)

### TemplateVersion

A version of the data-collection template. Snapshot semantics: once published, immutable.

- `version_number` (immutable), `version_label` (write-once)
- `status` — draft | published | deprecated; forward transitions only
- `master_template_path` (FileStorage path to the master XLSX)
- `parsed_config_path` (per-version snapshot of the workbook's contents — structurally cleaned but pre-FK-resolution. Distinct from `Project.parsed_config_path`)
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

- `variant_name` (immutable within version), `description`, `template_file_id` (variant XLSX)

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
- `supplier_display_status`, `supplier_message` — denormalized, written by **exactly one** recipe (the status-change handler). See invariant #1 below.

**File pointers**
- `template_file_id` (regenerated on reminder due to 10-day FileStorage TTL)
- `has_seeded_data`, `seeded_data_file_id`, `seeded_template_file_id`
- `latest_upload_file_id`, `last_submitted_file_link`
- `last_validation_report_link`, `last_validation_report_path`
- `approved_at` (write-once), `approved_file_id` (immutable)

**Reminders & access**
- `last_reminder_tier`, `last_reminder_sent_at`, `template_access_time`
- `submission_attempt`
- `last_valid_row_count`, `last_invalid_row_count`

**Slot pool (form data binding)**
- `slot_text_01..08`, `slot_num_01..02`, `slot_bool_01..02`, `slot_sel_01..04`, `slot_date_01..04`
- All stored as strings for WFA widget compatibility; semantic types enforced downstream in validation
- **Labels are no longer stored here** — joined from `FormSlotMapping` at render

**Bug fix:** `current_validation_result_id` relation now correctly points at `ValidationResult.validation_result_id` (was wired to `FieldError.field_id` in the prior model).

**Removed:** `template_project_id`, `correlation_id`, `customer_name`, all 20 `*_label` columns.

PK: `supplier_request_id`. FKs: `supplier_id`, `assigned_version_id`, `assigned_variant_id`, `current_validation_result_id`.

---

## Group D — Runtime (5 tables)

### Upload

Supplier file submission.

- `submitted_file_id` (immutable), `extracted_file_version_id`
- `status` (received | extracting | validating | validated | failed)
- `submitted_at` (immutable), `valid_payload` (long-text JSON)

PK: `upload_id`. FKs: `supplier_request_id` (immutable), `template_version_id` (frozen at creation, copied from `SupplierRequest.assigned_version_id`).

### ValidationResult

Outcome of validating an Upload.

- `status` (running | passed | failed | error)
- `valid_rows`, `invalid_rows`, `completed_at` — all write-once

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

1. **Status writer rule.** Only the status-change handler recipe writes `SupplierRequest.status`, `supplier_display_status`, and `supplier_message`. Every other recipe reads. Drift between the three fields is impossible by construction.

2. **Snapshot semantics.** Once a TemplateVersion transitions to `published`, no Field, Lookup, ValidationRule, Variant, VariantField, FormSlotMapping, or ErrorMessage row scoped to that version is ever updated. New version = new rows. Typo fixes flow forward via new versions, never via in-place edits to published rows. *The same rule covers per-version file artifacts: `parsed_config_path` and `canonical_model_path` are written write-once at publish and immutable thereafter.*

3. **FileStorage TTL re-hydration.** `SupplierRequest.template_file_id` is a 10-day shareable link. The reminder workflow regenerates it before sending. Same rule applies to any `*_link` field whose source is FileStorage.

4. **Supplier ↔ SupplierUser independence.** A SupplierUser belongs to a Supplier, not to any one SupplierRequest. Re-engagement on a new TemplateVersion creates new SupplierRequest rows but reuses existing Supplier and SupplierUser rows.

5. **External references are strings, not FKs.** `external_request_id` (formerly `correlation_id`) traces back to upstream intake systems but does not constrain or join inside this workspace.

6. **Primary user is exactly one per supplier.** *(v2)* Each `Supplier` has exactly one `SupplierUser` row with `primary = true`. Not enforceable as a schema constraint in Workato Data Tables; enforced at config-issuance time by the *Validate config* capability. Adding, deactivating, or re-electing a primary contact flows through *Validate config* (or its sibling *Add user to request* when scoped to a single request) so the invariant is checked on every mutation that could violate it.

---

## Changelog

**v2.1** — Added `CFG_TemplateVersion.canonical_model_path` (string) and applied the naming-doc file-column backports to TemplateVersion (`master_template_file_id` → `master_template_path`, `parsed_config_file_id` → `parsed_config_path`). The canonical model addition reflects the architectural decision to persist a fully resolved per-version configuration snapshot for runtime consumers, distinct from the structurally-cleaned `parsed_config_path` artifact. No invariants change; both new and renamed columns follow the existing snapshot-semantics rule (invariant 2). The naming backport was queued at v2's authorship; this revision applies it.

**v2** — Added `SupplierUser.primary` (boolean) and `ValidationRule.scope` (enum: `submission` | `supplier` | `engagement`, default `submission`). Added invariant #6 covering the exactly-one-primary-per-supplier rule. No other changes from v1; all v1 fields, FKs, and invariants 1–5 carry forward unchanged.

**v1** — Initial Phase 0 data model. 22 → 18 tables. Removed cross-project FKs, `WFA_Cache`, the 20 `*_label` columns on SupplierRequest, `customer_name` on SupplierRequest, and the SYS_EventLogs/RUN_PipelineError split. Added `Project` singleton and extracted `Supplier` from the request table.
