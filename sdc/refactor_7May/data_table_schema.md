# SDC Data Collection — Schema Specification (v1, Stage 0 build target)

## Status

The build-to schema for **Stage 0 of the SDC build queue**. Folds three Phase 0 artifacts into one consolidated specification:

- `sdc-data-model-v2.md` — conceptual model, FK rationale, foundational decisions (now v2.1, applying the canonical-model decision and the TemplateVersion naming backports)
- `sdc-state-machines-v1.md` — status enums, transitions, derivation rule
- `sdc-naming-v1.md` — prefix scheme, field conventions, file model, backports

When the companion docs disagree, the latest backport wins. Conflicts are noted inline.

This document is the canonical reference for creating the 18 Workato data tables. Stage 0 closes when every table here exists, every column matches, every FK resolves, and a smoke query against each table returns the expected shape.

---

## How to read this

Each table follows the same shape:

- **Purpose** — one-line summary
- **PK** — primary key column
- **Field table** — every column with type, required/default, and notes
- **Invariants** — table-specific contracts the recipes must honor

### Type vocabulary

Workato Data Tables types used throughout:

| Spec type | Workato column type | Use |
|---|---|---|
| `string` | Short text | Names, identifiers, single-line strings |
| `long-text` | Long text | JSON payloads, free-text notes, anything multi-line |
| `integer` | Integer | Counts, day offsets, version numbers |
| `boolean` | True/false | Flags |
| `date_time` | Date/time | Timestamps |
| `enum (...)` | Short text | Fixed value set; **not enforced by the platform**, enforced by recipes |
| `relation → Table` | Relation | FK + UI navigation; targets the referenced table's PK |

### FK convention

FKs are `relation` columns. The column name mirrors the referenced PK exactly (per naming-doc field convention: "FK columns do not carry table prefixes"). So `SUP_SupplierRequest.supplier_id` is a `relation → SUP_Supplier` column targeting `SUP_Supplier.supplier_id`.

### Constraint shorthand

In the **Notes** column:

- **PK** — primary key
- **FK** — foreign key (target named on the type)
- **immutable** — set at insert time, never updated thereafter
- **write-once** — null at insert time, set exactly once, never re-written
- **default: X** — Workato Data Tables default value
- **derived** — written by exactly one recipe; never written elsewhere
- **denormalized** — copy of data living elsewhere; consciously duplicated for query/UI ergonomics

### Build order

Tables can be created in any order — Workato relation columns can be added after both endpoints exist. But populating in dependency order avoids null-relation churn:

1. `Project`
2. `CFG_TemplateVersion`
3. `CFG_Field`, `CFG_Lookup`, `CFG_Variant`, `CFG_ErrorMessage`
4. `CFG_ValidationRule`, `CFG_VariantField`, `CFG_FormSlotMapping`
5. `SUP_Supplier`
6. `SUP_SupplierUser`, `SUP_SupplierRequest`
7. `RUN_ManualEntry`
8. `RUN_Upload`
9. `RUN_ValidationResult`
10. `RUN_FieldError`
11. `RUN_ReviewNote`
12. `EventLog`

---

## Group A — Project (1 table)

### Project

**Purpose.** Workspace singleton. Engagement-level configuration; the implicit context for everything else.

**PK.** `project_id`

| Column | Type | Notes |
|---|---|---|
| `project_id` | string | PK. UUID. |
| `analyst_email` | string | Owning analyst for the engagement. |
| `customer_name` | string | End-customer name. Source of truth; was duplicated on every `SupplierRequest` in v0. |
| `target_vms` | string | Downstream VMS this engagement feeds. |
| `output_drive_folder_id` | string | Drive folder for analyst-facing outputs. |
| `parsed_config_path` | string | FileStorage path to the parsed config JSON for the engagement. Renamed from `parsed_config_file_id`. |
| `incumbent_data_path` | string | FileStorage path to the source incumbent dataset. Nullable. Renamed from `incumbent_data_file_id`. |
| `seeded_data_path` | string | FileStorage path to the source seeded dataset (sliced into per-request `seeded_slice_path`). Nullable. **New per naming doc.** |
| `incumbent_split_config` | long-text | JSON describing how to slice `seeded_data_path` per supplier (typically keyed by supplier name). Nullable. |
| `reminder_days_1` | integer | Days from invitation to tier-1 reminder. |
| `reminder_days_2` | integer | Days from invitation to tier-2 reminder. |
| `reminder_days_3` | integer | Days from invitation to tier-3 reminder. |
| `default_due_days` | integer | Days from invitation to default supplier due date. **Conditional — see decision point at the end of this doc.** |
| `project_completion_status` | enum (`active`, `inactive`) | Default `active`. Set by E3 (engagement closure). |
| `external_request_id` | string | Upstream traceability string. Not an FK. Was `correlation_id` in v0. Nullable. |

**Invariants.**
- Singleton. Exactly one row. No incoming FKs anywhere; the project is implicit context.
- `parsed_config_path`, `incumbent_data_path`, `seeded_data_path` follow file-model invariant 8 (path canonical, link volatile — generate links via `UTL-01`).

---

## Group B — Configuration (8 tables, version-scoped)

All eight CFG_ tables share two invariants:

1. **Snapshot semantics.** Once `CFG_TemplateVersion.status` transitions to `published`, no row in any CFG_ table scoped to that version is ever updated. Typo fixes flow forward via new versions, never via in-place edits.
2. **`template_version_id` is immutable on every CFG_ table that has it.** Listed per-table for clarity but the rule is uniform.

### CFG_TemplateVersion

**Purpose.** A version of the data-collection template. Snapshot lifecycle: draft → published → deprecated.

**PK.** `template_version_id`

| Column | Type | Notes |
|---|---|---|
| `template_version_id` | string | PK. UUID. |
| `version_number` | integer | immutable. Monotonic within project. |
| `version_label` | string | write-once. Human-readable label assigned at publish time. |
| `status` | enum (`draft`, `published`, `deprecated`) | Default `draft`. Forward transitions only. |
| `master_template_path` | string | FileStorage path to the master XLSX. Renamed from `master_template_file_id`. |
| `parsed_config_path` | string | FileStorage path to the per-version parsed config snapshot — the workbook's contents, structurally cleaned but pre-FK-resolution. Distinct from `Project.parsed_config_path`. Renamed from `parsed_config_file_id`. |
| `canonical_model_path` | string | **v2.1 addition.** FileStorage path to the per-version canonical model — the fully resolved, FK-wired, slot-pool-assigned configuration. write-once at publish. Distinct from `parsed_config_path` (which holds the pre-resolution structurally-cleaned config). Audience: runtime consumers (PRV-02, VAL-01's connector). |
| `published_at` | date_time | write-once. Set on draft → published. Nullable until then. |
| `validation_summary` | long-text | JSON summary of validation results from `CFG-validate_config`. |

### CFG_Field

**Purpose.** A column definition in the data-collection template.

**PK.** `field_id`

| Column | Type | Notes |
|---|---|---|
| `field_id` | string | PK. UUID. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `field_name` | string | immutable within version. |
| `description` | string | |
| `data_type` | string | One of the `_mapping` sheet's authoritative types. |
| `data_format` | string | Type-specific format hint (date format string, etc.). Nullable. |
| `position` | integer | Column order in the rendered template. |
| `required` | boolean | Default `false`. |
| `must_be_empty` | boolean | Default `false`. Mutually exclusive with `required` at config-validation time. |
| `column_unique` | boolean | Default `false`. Within-submission uniqueness for this column. |
| `strict` | boolean | Default `false`. Whether validation failures on this field block submission vs. warn. |
| `visible` | boolean | Default `true`. |
| `field_length_validation` | string | Length spec, e.g., `"min:1,max:255"`. Nullable. |
| `numeric_field_validation` | string | Range spec for numeric types. Nullable. |
| `date_field_validation` | string | Range spec for date types. Nullable. |
| `field_input_validation` | string | Regex or pattern spec. Nullable. |
| `data_cleaning_flags` | string | Comma-separated cleaning hints (`trim`, `uppercase`, etc.). Nullable. |
| `lookup_name` | string | Soft-join key to `CFG_Lookup.lookup_name`. Nullable. |
| `depends_on` | relation → CFG_Field | Self-FK for cascading dropdowns. Nullable. |
| `control_type` | enum (`text`, `number`, `dropdown`, `date`, `checkbox`) | derived from `data_type` + `lookup_name` at row-creation time. |

### CFG_Lookup

**Purpose.** One row per (lookup_name, value). Soft-joined from `CFG_Field.lookup_name` and `CFG_FormSlotMapping.lookup_name`.

**PK.** `lookup_id`

| Column | Type | Notes |
|---|---|---|
| `lookup_id` | string | PK. UUID. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `lookup_name` | string | immutable within version. |
| `valid_value` | string | One allowable value. |
| `parent_value` | string | Cascade trigger — for dependent dropdowns, the parent value that gates this child. Nullable. |
| `project_specific` | boolean | Default `false`. Whether this lookup row is engagement-scoped vs. global. |

### CFG_ValidationRule

**Purpose.** Cross-field validation rules. Evaluated by the `validate_upload` connector action.

**PK.** `rule_id`

| Column | Type | Notes |
|---|---|---|
| `rule_id` | string | PK. UUID. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `field_id` | relation → CFG_Field | FK. immutable. The rule's primary target field. |
| `rule` | string | Rule expression / type code. |
| `condition_field_id` | relation → CFG_Field | FK. The conditional dependency, if any. Nullable. |
| `conditional_value` | string | Value the condition field must hold for the rule to fire. Nullable. |
| `error_message` | string | Default error code → looked up in `CFG_ErrorMessage`. |
| `error_message_custom` | string | Override message. Wins over `error_message` when set. Nullable. |
| `strict_enforcement` | boolean | Default `true`. Whether failure blocks submission. |
| `scope` | enum (`submission`, `supplier`, `engagement`) | Default `submission`. **v2 addition.** Controls the row set against which uniqueness/aggregate rules evaluate. |
| `target_field` | string | denormalized. Display name of `field_id`'s field, for Workato Data Tables UI readability. |
| `condition_field` | string | denormalized. Display name of `condition_field_id`'s field. Nullable. |

**Invariants.**
- `scope` semantics: `submission` evaluates within current upload only. `supplier` extends to all *validated/approved* prior submissions from the same supplier. `engagement` extends across all *validated/approved* submissions in the engagement. Pre-fetch must filter to validated/approved — including failed prior attempts produces false-positive uniqueness errors against the supplier's own rejected submissions. (See pre-positioned test case in Stage 2.)

### CFG_Variant

**Purpose.** A flavor of the template with a subset of fields.

**PK.** `variant_id`

| Column | Type | Notes |
|---|---|---|
| `variant_id` | string | PK. UUID. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `variant_name` | string | immutable within version. |
| `description` | string | Nullable. |
| `template_path` | string | FileStorage path to the variant XLSX. Renamed from `template_file_id`. |

### CFG_VariantField

**Purpose.** Junction table. Variant ↔ Field.

**PK.** `variant_field_id`

| Column | Type | Notes |
|---|---|---|
| `variant_field_id` | string | PK. UUID. |
| `variant_id` | relation → CFG_Variant | FK. immutable. |
| `field_id` | relation → CFG_Field | FK. immutable. |

### CFG_FormSlotMapping

**Purpose.** Maps fields to fixed WFA slot columns on `SUP_SupplierRequest`. **This is where slot labels live** — they were 20 `*_label` columns on SupplierRequest in v0; now consolidated here.

**PK.** `form_slot_id`

| Column | Type | Notes |
|---|---|---|
| `form_slot_id` | string | PK. UUID. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `field_id` | relation → CFG_Field | FK. immutable. |
| `slot_name` | string | E.g., `slot_text_01`, `slot_num_02`. Soft-joined to the matching column on `SUP_SupplierRequest`. |
| `display_label` | string | Label shown to the supplier in the WFA form. Was `*_label` on SupplierRequest. |
| `control_type` | enum (`text`, `number`, `dropdown`, `date`, `checkbox`) | Form widget type. |
| `required` | boolean | Default `false`. |
| `lookup_name` | string | Soft-join to `CFG_Lookup.lookup_name`. Nullable. Required when `control_type = dropdown`. |
| `position` | integer | Display order in the form. |

### CFG_ErrorMessage

**Purpose.** Per-version snapshot of error code → human-readable message. Decision: per-version copies (snapshot integrity over storage savings).

**PK.** `error_translation_id`

| Column | Type | Notes |
|---|---|---|
| `error_translation_id` | string | PK. UUID. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `error_code` | string | Stable code referenced by `CFG_ValidationRule.error_message`. |
| `human_readable_message` | string | Message shown to supplier; supports placeholder substitution. |
| `required_placeholders` | string | Comma-separated placeholder names (`{field_name}`, `{value}`, etc.) that the rendering recipe must supply. Nullable. |

---

## Group C — Supplier (3 tables)

### SUP_Supplier

**Purpose.** Supplier identity. Survives across template versions — extracted from the v0 SupplierRequest.

**PK.** `supplier_id`

| Column | Type | Notes |
|---|---|---|
| `supplier_id` | string | PK. UUID. |
| `supplier_name` | string | Display name. |
| `default_variant_id` | relation → CFG_Variant | Optional default variant for re-engagement scenarios. Nullable. |
| `status` | enum (`active`, `deactivated`) | Default `active`. |
| `created_at` | date_time | immutable. |

### SUP_SupplierUser

**Purpose.** Contacts at a supplier. First-class to the supplier — not to any single SupplierRequest.

**PK.** `supplier_user_id`

| Column | Type | Notes |
|---|---|---|
| `supplier_user_id` | string | PK. UUID. |
| `supplier_id` | relation → SUP_Supplier | FK. immutable. |
| `user_email` | string | Unique within `supplier_id` (enforced at config-issuance time). |
| `contact_name` | string | |
| `primary` | boolean | Default `false`. **v2 addition.** Designates the primary contact. Exactly one per supplier; see invariant below. |
| `status` | enum (`active`, `deactivated`) | Default `active`. |
| `created_at` | date_time | immutable. |

**Invariants.**
- **Exactly one primary per supplier.** Each `SUP_Supplier` has exactly one `SUP_SupplierUser` row with `primary = true`. Workato Data Tables cannot express this natively; enforced by `CFG-validate_config` and `Add user to request`. Both call sites must use the same predicate (cross-cutting open question from Stage 7 sibling scopes).

### SUP_SupplierRequest

**Purpose.** Per-version ask of a supplier. Lifecycle state, file pointers, validation summary. The largest table in the schema.

**PK.** `supplier_request_id`

#### Identity & version

| Column | Type | Notes |
|---|---|---|
| `supplier_request_id` | string | PK. UUID. |
| `supplier_id` | relation → SUP_Supplier | FK. |
| `assigned_version_id` | relation → CFG_TemplateVersion | FK. immutable. |
| `assigned_variant_id` | relation → CFG_Variant | FK. immutable. |
| `assignee_email` | string | immutable. The supplier user assigned to fulfill this request. Joins to `SUP_SupplierUser.user_email` within the supplier. |
| `external_request_id` | string | Plain string, upstream traceability. Was `correlation_id`. Nullable. |

#### Status — single source of truth

| Column | Type | Notes |
|---|---|---|
| `status` | enum (`pending`, `sent`, `supplier_action_required`, `pending_review`, `approved`, `cancelled`) | derived. Backend state machine value. **Single writer: STS-01.** Default `pending`. |
| `current_state_entered_at` | date_time | derived. Timestamp of the most recent transition into `status`. **Backport from state-machine doc.** Updated atomically with `status`. |
| `supplier_display_status` | string | derived. denormalized. Supplier-facing status label. **Single writer: STS-01.** |
| `supplier_message` | long-text | derived. denormalized. Supplier-facing message body, including any embedded shareable links (regenerated via `UTL-01` on every handler write). **Single writer: STS-01.** |
| `reminders_enabled` | boolean | Default `true`. **Backport from state-machine doc.** Per-request reminder opt-out. |

#### File pointers (path-only per naming doc)

| Column | Type | Notes |
|---|---|---|
| `template_path` | string | FileStorage path to the supplier-facing template. **The only path that's rewritten over the row's lifetime** (invariant 11 — regenerated on each resubmission cycle to carry forward valid prior rows). Renamed from `template_file_id`. |
| `has_seeded_data` | boolean | Default `false`. Whether seeded data was applied for this supplier. |
| `seeded_slice_path` | string | FileStorage path to this request's slice of `Project.seeded_data_path`. Nullable. Renamed from `seeded_data_file_id`. |
| `approved_path` | string | immutable. FileStorage path to the approved snapshot. write-once at approval. Nullable until then. Renamed from `approved_file_id`. |

> **Dropped from v0/v2** (per naming-doc backports): `seeded_template_file_id`, `latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_path`, `last_validation_report_link`, `template_file_id` (the `_file_id` form). Recipes that need the latest upload join `RUN_Upload`; recipes that need the latest validation report join `RUN_ValidationResult`; links are generated via `UTL-01`.

#### Approval & validation summary

| Column | Type | Notes |
|---|---|---|
| `approved_at` | date_time | write-once at approval. Nullable until then. |
| `current_validation_result_id` | relation → RUN_ValidationResult | Pointer to the most recent ValidationResult. Nullable until first validation runs. |
| `last_valid_row_count` | integer | denormalized. Pulled from current ValidationResult for fast querying. |
| `last_invalid_row_count` | integer | denormalized. Pulled from current ValidationResult. |
| `submission_attempt` | integer | Default `0`. Increments on each Upload. |

#### Reminders & access

| Column | Type | Notes |
|---|---|---|
| `last_reminder_tier` | integer | Default `0`. Most recent tier sent (0 = none). |
| `last_reminder_sent_at` | date_time | Nullable until first reminder. |
| `template_access_time` | date_time | First time the supplier accessed the template via shareable link. Nullable. |
| `due_date` | date | Per-request due date. **Conditional — see decision point.** |

#### Slot pool — supplier form data binding

All slot columns are `string` even where the semantic type is numeric/date/boolean — WFA widget compatibility requires string storage. Semantic types are enforced by `validate_upload`.

| Column group | Columns |
|---|---|
| Text slots | `slot_text_01` … `slot_text_08` |
| Numeric slots | `slot_num_01`, `slot_num_02` |
| Boolean slots | `slot_bool_01`, `slot_bool_02` |
| Select slots | `slot_sel_01` … `slot_sel_04` |
| Date slots | `slot_date_01` … `slot_date_04` |

All 20 slots: `string`, all nullable, no defaults. **Slot *labels* are not stored here** — they live on `CFG_FormSlotMapping.display_label`.

**Invariants.**
- **Status writer rule (data-model invariant 1).** Only `STS-01` writes `status`, `current_state_entered_at`, `supplier_display_status`, `supplier_message`. Drift between the four fields is impossible by construction.
- **Template path is the only mutable path (file-model invariant 11).** Every other path is write-once.
- **`current_validation_result_id` is the relation, not a denormalized FK.** v0 had this wired to `FieldError.field_id`; v2 fixes it.

---

## Group D — Runtime (5 tables)

### RUN_Upload

**Purpose.** Supplier file submission.

**PK.** `upload_id`

| Column | Type | Notes |
|---|---|---|
| `upload_id` | string | PK. UUID. |
| `supplier_request_id` | relation → SUP_SupplierRequest | FK. immutable. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. **Frozen at row creation** — copied from `SUP_SupplierRequest.assigned_version_id`. Survives even if the request gets reassigned. |
| `submitted_path` | string | immutable. FileStorage path to the submitted XLSX. Renamed from `submitted_file_id`. |
| `extracted_path` | string | FileStorage path to the extracted JSON. Written by the extraction step. Nullable until extraction completes. Renamed from `extracted_file_version_id`. |
| `status` | enum (`received`, `extracting`, `validating`, `validated`, `error`) | Default `received`. **`error` renamed from `failed`** per state-machine backport. |
| `submitted_at` | date_time | immutable. |
| `valid_payload_json` | long-text | JSON of the row data that passed validation. Renamed from `valid_payload`. Nullable. |

### RUN_ValidationResult

**Purpose.** Outcome of validating an Upload.

**PK.** `validation_result_id`

| Column | Type | Notes |
|---|---|---|
| `validation_result_id` | string | PK. UUID. |
| `upload_id` | relation → RUN_Upload | FK. immutable. |
| `template_version_id` | relation → CFG_TemplateVersion | FK. Mirrors the parent Upload's version for direct join access. |
| `status` | enum (`running`, `passed`, `failed`, `error`) | Default `running`. |
| `valid_row_count` | integer | write-once. Renamed from `valid_rows`. |
| `invalid_row_count` | integer | write-once. Renamed from `invalid_rows`. |
| `report_path` | string | FileStorage path to the validation report XLSX. **New per naming doc.** Generated by VAL-01. |
| `completed_at` | date_time | write-once. |

### RUN_FieldError

**Purpose.** Per-cell validation failure. Links a ValidationResult to the specific cells that failed and why.

**PK.** `field_error_id`

| Column | Type | Notes |
|---|---|---|
| `field_error_id` | string | PK. UUID. |
| `validation_result_id` | relation → RUN_ValidationResult | FK. immutable. |
| `field_id` | relation → CFG_Field | FK. The column whose value failed. |
| `row_number` | integer | 1-indexed row in the supplier's submitted file. |
| `submitted_value` | string | The value that failed validation. Nullable (the failure may have been "value missing"). |
| `error_message` | string | Rendered human-readable message — error code resolved through `CFG_ErrorMessage` and any placeholder substitution applied at write time. |

### RUN_ManualEntry

**Purpose.** Supplier-side single-row form submissions via the WFA. Alternative submission path to file upload — used when the request asks for a small, structured payload.

**PK.** `manual_entry_id`

| Column | Type | Notes |
|---|---|---|
| `manual_entry_id` | string | PK. UUID. |
| `supplier_request_id` | relation → SUP_SupplierRequest | FK. |
| `field_id` | relation → CFG_Field | FK. immutable. |
| `field_name` | string | denormalized. The field's display name, copied here so the WFA table widget header reads correctly without a join. |
| `row_number` | integer | 1-indexed; suppliers can submit multi-row data through repeated form fills. |
| `submitted_value` | string | The value the supplier entered. |

### RUN_ReviewNote

**Purpose.** Analyst approve/rework decisions. One row per analyst action — historical record, not a single overwritten note.

**PK.** `review_note_id`

| Column | Type | Notes |
|---|---|---|
| `review_note_id` | string | PK. UUID. |
| `supplier_request_id` | relation → SUP_SupplierRequest | FK. immutable. |
| `author_email` | string | The analyst who took the action. |
| `note_text` | long-text | Free-text note. Required for `rework`; optional for `approved`. |
| `review_action` | enum (`approved`, `rework`) | The decision recorded. |
| `created_at` | date_time | immutable. |

---

## Group E — Observability (1 table)

### EventLog

**Purpose.** Unified audit log + incident tracking. Replaces the v0 split between `SYS_EventLogs` and `RUN_PipelineError`. Severity plus optional resolution fields distinguish routine audit events from tracked incidents.

**PK.** `event_id`

#### Core event

| Column | Type | Notes |
|---|---|---|
| `event_id` | string | PK. UUID. |
| `timestamp` | date_time | immutable. |
| `source_recipe` | string | Recipe identifier (`PRV-01`, `VAL-01a`, etc.) per naming-doc recipe convention. |
| `step_number` | integer | Step within the source recipe. Nullable. |
| `phase` | string | High-level phase label (`provisioning`, `validation`, `review`, etc.). |
| `severity` | enum (`info`, `warn`, `error`) | |
| `human_message` | string | One-line human-readable summary. |
| `details_json` | long-text | Structured detail payload. Nullable. |
| `analyst_email` | string | Acting analyst, if relevant. Nullable. |

#### Optional context

| Column | Type | Notes |
|---|---|---|
| `supplier_request_id` | relation → SUP_SupplierRequest | Nullable. Many events aren't request-scoped (e.g., provisioning, config validation). |
| `error_type` | string | Categorical error classifier. Nullable. |

#### Incident tracking — populated only when follow-up is needed

| Column | Type | Notes |
|---|---|---|
| `alert_sent` | boolean | Default `false`. Whether an alert was dispatched for this event. |
| `resolved` | boolean | Default `false`. |
| `resolved_at` | date_time | Nullable. |

**Invariants.**
- The only observability table. No `LOG_` prefix per naming doc — bare-naming for the singleton observability concern.

---

## Consolidated invariants

The full set across data-model, state-machine, and naming docs. Numbering carries through.

1. **Status writer rule.** Only `STS-01` writes `SUP_SupplierRequest.status`, `current_state_entered_at`, `supplier_display_status`, `supplier_message`.
2. **Snapshot semantics.** Once a `CFG_TemplateVersion` is `published`, no row in any CFG_ table scoped to that version is ever updated. The same rule covers per-version file artifacts: `parsed_config_path` and `canonical_model_path` are write-once at publish and immutable thereafter.
3. **FileStorage TTL re-hydration.** `template_path` shareable links are 10-day TTL. Reminder workflow regenerates via `UTL-01` before sending.
4. **Supplier ↔ SupplierUser independence.** A `SUP_SupplierUser` belongs to a `SUP_Supplier`, not to any `SUP_SupplierRequest`. Re-engagement creates new request rows but reuses existing supplier and user rows.
5. **External references are strings, not FKs.** `external_request_id` traces to upstream intake but does not constrain or join inside this workspace.
6. **Exactly one primary user per supplier.** Each `SUP_Supplier` has exactly one `SUP_SupplierUser` with `primary = true`. Enforced at config-issuance time by `CFG-validate_config` and on per-request user changes by `Add user to request` — both call sites use the same predicate.
7. **State no-op on resubmit-after-fail.** When a supplier resubmits from `supplier_action_required` and validation fails again, `status` does not transition. New `RUN_Upload`, new `RUN_ValidationResult` (`status=failed`), new `RUN_FieldError` rows; `current_validation_result_id` and the row counts update. The state machine has not moved.
8. **Path is canonical, link is volatile.** Every long-term file reference is a path. Links are generated on demand by `UTL-01`. Storing a link in a column is a smell.
9. **Files belong to the entity that creates them.** No parent row mirrors child file pointers. Recipes join down to `RUN_Upload` / `RUN_ValidationResult` for latest-upload / latest-report needs.
10. **No path computation at read time.** Paths are stored on the row at creation time; no recipe concatenates a base path with a suffix.
11. **Templates regenerate; everything else is write-once.** `SUP_SupplierRequest.template_path` is the only file path whose contents change over the row's lifetime. Historical state is reconstructable via `RUN_Upload`. All other paths write-once.

---

## Decision point — `due_date` location

The state-machine doc backport says: *"Add `SUP_SupplierRequest.due_date` **or** `Project.default_due_days` — pick the location based on whether due dates are per-request or per-engagement."*

Three plausible answers:

**A. `Project.default_due_days` only.** All requests in an engagement share the same offset from invitation. Simpler: zero per-request data, due date computed on the fly as `current_state_entered_at + default_due_days` when `status = sent`. Drawback: cannot stretch a single supplier's deadline without changing the project default.

**B. `SUP_SupplierRequest.due_date` only.** Per-request absolute date. Maximum flexibility. Drawback: every request needs the date computed at invitation time; project-level changes don't ripple to in-flight requests.

**C. Both.** `Project.default_due_days` is the engagement default. `SUP_SupplierRequest.due_date` is set at invitation as `current_state_entered_at + default_due_days`, then editable per request. Most flexible; one column of redundant state during the steady case.

**Recommendation: C.** It matches the operating model — most suppliers get the project default, but analysts will inevitably need to grant exceptions, and the per-request column is the natural place to record them. The per-request column is the source of truth for reminder eligibility; the project field is just a default. This is the version reflected in the spec above (both columns present).

If you'd rather start with A and add the per-request column later, drop `due_date` from `SUP_SupplierRequest` and the schema is still consistent. If you'd rather go B-only, drop `default_due_days` from `Project`.

---

## Out of scope for Stage 0

- **STS-01 transition logic.** Handled in Stage 1. The schema makes the writes possible; the recipe enforces single-writer semantics.
- **`UTL-01` link generation.** Stage 1. The schema doesn't store links; the helper materializes them on demand.
- **Connector adjustments to `validate_upload` and `validate_config`.** Stage 1. Schema is upstream of those.
- **Recipe-level enforcement of enum values.** Workato Data Tables doesn't enforce them; recipes will. The spec lists them for reference only.

---

## What's next

Once the 18 tables are realized to this spec, Stage 0 closes. Smoke-query each table (a single `SELECT *` that returns the column shape), confirm FKs resolve in both directions where applicable, and Stage 1 begins on a clean foundation.
