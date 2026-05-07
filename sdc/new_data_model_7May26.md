# SDC Data Collection — Data Model (v1, Phase 0)

## Status

This is the proposed schema for the new SDC workspace, replacing the 22-table model from the prior workspace. Locked decisions (data model shape, table list, key relationships) are recorded here. Other Phase 0 work — state machine, naming and prefix conventions, ADR triage, callable reuse-vs-rebuild — is still pending in subsequent sessions.

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
- `master_template_file_id` (FileStorage), `parsed_config_file_id` (per-version snapshot, distinct from `Project.parsed_config_file_id`)
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
- `target_field`, `condition_field` — denormalized display names for Workato Data Tables UI readability

PK: `rule_id`. FKs: `field_id` (primary, immutable), `condition_field_id`, `template_version_id`.

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

PK: `supplier_user_id`. FK: `supplier_id` (immutable). **Major change:** previously FK was `supplier_request_id`; now it's `supplier_id`, so users are first-class to the supplier and survive re-engagement.

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

2. **Snapshot semantics.** Once a TemplateVersion transitions to `published`, no Field, Lookup, ValidationRule, Variant, VariantField, FormSlotMapping, or ErrorMessage row scoped to that version is ever updated. New version = new rows. Typo fixes flow forward via new versions, never via in-place edits to published rows.

3. **FileStorage TTL re-hydration.** `SupplierRequest.template_file_id` is a 10-day shareable link. The reminder workflow regenerates it before sending. Same rule applies to any `*_link` field whose source is FileStorage.

4. **Supplier ↔ SupplierUser independence.** A SupplierUser belongs to a Supplier, not to any one SupplierRequest. Re-engagement on a new TemplateVersion creates new SupplierRequest rows but reuses existing Supplier and SupplierUser rows.

5. **External references are strings, not FKs.** `external_request_id` (formerly `correlation_id`) traces back to upstream intake systems but does not constrain or join inside this workspace.

---

## Deliberately omitted

- **HOME_Requests / HOME_Manifests references** — gone with cross-project boundary.
- **WFA_Cache** — its contents were a grab bag of session, share-method, and last-known-user state. Session and share metadata move into `EventLog` with typed phases. Last-known-user state, if needed, will be reintroduced as a purpose-specific table only when a recipe demands it.
- **The `*_label` columns on SupplierRequest** — replaced by linked-table join to `FormSlotMapping`.
- **`customer_name` on SupplierRequest** — sourced from the `Project` singleton.

---

## Pending in Phase 0

- **State machine design.** Status enum values, transitions, derivation rule for `supplier_display_status` and `supplier_message`. Currently inheriting the old enum (pending | sent | in_progress | submitted | validated | accepted | rejected) — to be reconsidered.
- **Naming and prefix conventions.** Table names above are conceptual. Whether to use prefixes (CFG_, VER_, RUN_, etc.), simpler prefixes, or no prefix at all is still open.
- **ADR triage.** Which of AD-1 through AD-38 still apply, which are obsolete, which need revisiting.
- **Reuse-vs-rebuild on existing callables.** Depends on naming and state machine decisions.
