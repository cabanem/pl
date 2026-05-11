# SDC Data Collection — Canonical Model Shape (v1, Stage 3 prerequisite)

## Status

Companion to the data model, naming conventions, and recipe plan documents. Settles the schema of the canonical model JSON artifact — the runtime configuration record that PRV-02 produces, PRV-03 hydrates from, PRV-04 reads variants from, and VAL-01 + TPL-01 read for runtime work.

The canonical model is the most-consumed artifact in the system after the data tables themselves. Every Stage 2+ recipe reads it. Locking its shape before more recipes plan against it prevents the kind of "what fields can I rely on" drift that fragments contracts.

**Scope.** This document covers what the canonical model *contains* and what it *promises* to consumers. It does not cover *how PRV-02 constructs it* — that's a construction spec for PRV-02 build time. The two documents will exist together; the construction spec defers to this one for the target shape.

**Foundational decision.** The canonical model is runtime-only. Suppliers and users are not part of it. They live in `SUP_Supplier` and `SUP_SupplierUser` after PRV-04 stages them, and PRV-04 reads supplier/user content from the parsed config (also written to FileStorage), not from the canonical model. The separation: parsed config is the analyst's input record, canonical model is the runtime configuration, data tables are operational state.

## Where the canonical model lives

`/templates/v<NNN>/canonical_model.json` — per the naming conventions file model. One canonical model per `CFG_TemplateVersion`. Path stored on `CFG_TemplateVersion.canonical_model_path`.

**Write-once at publish.** PRV-02 writes the file during draft creation; PRV-04 marks the version `published`, after which the canonical model is immutable per snapshot semantics (invariant 2). Typo fixes flow forward via new versions, never via in-place edits.

## Top-level shape

The canonical model is a JSON object with seven entity collections plus a small metadata header. No nesting; entity FKs are by UUID and resolved lazily by consumers.

```
{
  "_meta": { ... },
  "cfg_fields": [ ... ],
  "cfg_lookups": [ ... ],
  "cfg_rules": [ ... ],
  "cfg_variants": [ ... ],
  "cfg_variant_fields": [ ... ],
  "cfg_form_slot_mappings": [ ... ],
  "cfg_error_messages": [ ... ]
}
```

Each collection maps directly to a `CFG_*` data table. The naming aligns: `cfg_fields` → `CFG_Field`, `cfg_rules` → `CFG_ValidationRule`, and so on. PRV-03's job is straightforward: read each collection, batch-create rows into the corresponding table.

---

## `_meta`

Provenance and consumer-facing constants. Small, but referenced by every consumer.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `template_version_id` | string (UUID) | always | FK to `CFG_TemplateVersion`. Matches the PK of the version this canonical model belongs to. |
| `version_number` | integer | always | Mirrors `CFG_TemplateVersion.version_number`. Useful for path construction and debugging. |
| `project_id` | string (UUID) | always | FK to `Project`. Context. |
| `expected_sheet_name` | string | always | The sheet name TPL-01 produces and VAL-01 reads. Currently `"Data"`. Stored here so VAL-01's XLSX parser doesn't hardcode it. |
| `built_at` | datetime | always | When PRV-02 built this artifact. Useful for debugging. |
| `built_by_recipe` | string | always | Almost always `"PRV-02"`. Reserved for cases where a different recipe ever builds canonical models (e.g., a re-build utility). |

**Promises to consumers.**
- `template_version_id` is the single join key for everything else. A consumer that reads the canonical model and then queries data tables uses this value.
- `expected_sheet_name` is stable within a version. VAL-01 never has to ask "what sheet?" — the model tells it.

---

## `cfg_fields`

The field definitions. One object per column the supplier sees.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `field_id` | string (UUID) | always | PK. Minted by PRV-02 at canonical-model build time. Stable across the version's lifetime. |
| `field_name` | string | always | Display name. Authoritative for header text in templates and form labels. Unique within the canonical model. |
| `description` | string | optional | Supplier-facing description. Nullable. |
| `data_type` | string | always | `boolean | date | float (2) | integer | string | none`. |
| `data_format` | string | optional | Type-specific format hint. `currency | date (YYYY-MM-DD) | dropdown | dropdown (dependent) | email address | percentage`. Nullable. |
| `position` | integer | always | Column order. Zero-indexed within the canonical model. |
| `required` | boolean | always | Default false. |
| `must_be_empty` | boolean | always | Default false. Mutually exclusive with `required` at config-validation time. |
| `column_unique` | boolean | always | Default false. Within-submission uniqueness. |
| `strict` | boolean | always | Whether a validation failure on this field is hard-fail (blocks submission) or soft-fail (warns). **Carries through unchanged from the parser**; blank workbook cells produce `false`. |
| `visible` | boolean | always | Whether the field appears on the manual-input form. Derived by the parser from the workbook's `7_form` sheet. |
| `field_length_validation` | string | optional | Length spec, e.g., `"min:1,max:255"`. Nullable. |
| `numeric_field_validation` | string | optional | Range spec for numeric types. Nullable. |
| `date_field_validation` | string | optional | Range spec for date types. Nullable. |
| `field_input_validation` | string | optional | Regex or pattern spec. Nullable. |
| `data_cleaning_flags` | string | optional | Comma-separated cleaning hints (`trim_whitespace`, `force_upper`, etc.). Nullable. |
| `lookup_name` | string | optional | **Soft-join key** to `cfg_lookups[].lookup_name`. Resolved by consumers at read time; not a UUID. Nullable. |
| `depends_on_field_id` | string (UUID) | optional | FK to another entry in `cfg_fields`. Used for cascading dropdowns. Nullable. Resolved from `depends_on_field_name` at canonical-model build time. |
| `control_type` | string | always | Form widget type. Derived by the connector from `data_type` + `data_format` at canonical-model build time. `text | number | dropdown | dependent_select | date | checkbox | email | currency`. |

**Promises to consumers.**
- Every field has a UUID-stable `field_id`. Recipes can persist FieldError rows by `field_id` and trust the reference holds for the version's lifetime.
- `position` defines column order for both templates and form layouts.
- `strict` is the per-field hard/soft toggle. The connector's verdict logic respects it.
- Lookup references go through `lookup_name` (soft join), not a `lookup_id`. The model's lookups are name-keyed; there's no `cfg_lookups[].lookup_id` PK separate from `lookup_name` + `valid_values`. Consumers index by `lookup_name`.
- `depends_on_field_id` is resolved to a UUID. Consumers don't re-resolve from name.

---

## `cfg_lookups`

Lookup values. One row per (lookup_name, value) pair.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `lookup_name` | string | always | Soft-join key. Multiple rows share the same `lookup_name`; together they form the lookup's value set. |
| `valid_value` | string | always | One allowable value. |
| `display_label` | string | optional | What suppliers see if different from the raw value. Nullable. |
| `parent_value` | string | optional | For dependent lookups, the parent value that gates this child. Nullable. |
| `project_specific` | boolean | always | Whether this row is engagement-scoped (vs. a global default). Default false. |

**Promises to consumers.**
- A lookup is identified by `lookup_name`, not by a UUID. Consumers indexing the canonical model build a `lookup_name → [rows]` map.
- A dependent lookup's child values are filtered by `parent_value` matching the supplier's selection in the parent field.
- No FK to `cfg_fields` — the relationship is the other direction: `cfg_fields[].lookup_name` points here. This matches the data model's soft-join pattern (data model Group B, naming conventions field-level rules).

---

## `cfg_rules`

Cross-field validation rules. One per rule the analyst defined.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `rule_id` | string (UUID) | always | PK. Minted at canonical-model build time. |
| `field_id` | string (UUID) | always | FK to `cfg_fields[]`. The rule's primary target field. Resolved from `target_field_name` at build time. |
| `rule` | string | always | Rule verb. `Combined fields must be unique | Must not match | Must match | Must be greater than | Must be greater than or equal to | Must be less than | Must be less than or equal to | Must be empty if | Required if | Mutually exclusive | At least one required`. |
| `condition_field_id` | string (UUID) | optional | FK to `cfg_fields[]`. The conditional dependency, if any. Nullable. |
| `conditional_value` | string | optional | Value the condition field must hold for the rule to fire. Nullable. |
| `error_message` | string | optional | Default error code, looked up in `cfg_error_messages`. Nullable (rules without an explicit code fall back to a generic message). |
| `error_message_custom` | string | optional | Override message. Wins over `error_message` when set. Nullable. |
| `strict_enforcement` | boolean | always | Whether a failure blocks submission. **Carries through unchanged from the parser**; blank cells produce `false`. |
| `scope` | string | always | `submission | supplier | engagement`. Default `submission`. Controls cross-row evaluation set. Stage 2 only implements `submission` scope; `supplier` and `engagement` scope rules are populated but not evaluated until cross-row scope is wired in Stage 5+. |
| `target_field_name` | string | always | Denormalized display name of `field_id`'s field. Useful for diagnostic output. |
| `condition_field_name` | string | optional | Denormalized display name of `condition_field_id`'s field. Nullable. |

**Promises to consumers.**
- Both field references are resolved to UUIDs at build time. Recipes never re-resolve from names.
- `scope` is always present; consumers that don't yet implement non-`submission` scope skip those rules silently rather than treating their presence as an error.
- `strict_enforcement` follows the same defaulting as `field.strict` — blank in the workbook means soft.

---

## `cfg_variants`

Template flavors. One per variant.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `variant_id` | string (UUID) | always | PK. Minted at canonical-model build time. |
| `variant_name` | string | always | Display name. Unique within the canonical model. |
| `description` | string | optional | Nullable. |
| `is_synthesized` | boolean | always | True when this variant was synthesized by the parser because no variants were defined in the config (the "base variant fallback"). False when the analyst defined the variant explicitly. |

**Promises to consumers.**
- Every canonical model has at least one variant. If the workbook defined none, the parser synthesizes a `base` variant containing every field; `is_synthesized` flags it.
- `variant_id` is what TPL-01 receives and what `CFG_Variant.template_path` is keyed on.

---

## `cfg_variant_fields`

Junction. Which fields appear in which variants.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `variant_id` | string (UUID) | always | FK to `cfg_variants[]`. |
| `field_id` | string (UUID) | always | FK to `cfg_fields[]`. |

**Promises to consumers.**
- An inclusion list: presence of a (variant_id, field_id) pair means "this field is visible in this variant."
- A field can appear in multiple variants. The pair is the unit of relationship.

---

## `cfg_form_slot_mappings`

Mapping from fields to fixed WFA slot columns on `SUP_SupplierRequest`. **This is where the form's display labels live**, per the data model decision that pulled them off SupplierRequest.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `form_slot_id` | string (UUID) | always | PK. Minted at canonical-model build time. |
| `field_id` | string (UUID) | always | FK to `cfg_fields[]`. |
| `slot_name` | string | always | E.g., `slot_text_01`, `slot_num_02`. Soft-joined to the matching column on `SUP_SupplierRequest`. |
| `display_label` | string | always | Label shown to the supplier in the WFA form. |
| `control_type` | string | always | Form widget type. Derived from the field's `data_type` + `data_format`. |
| `required` | boolean | always | Mirrors the field's `required` flag for form-render convenience. |
| `lookup_name` | string | optional | Soft-join to `cfg_lookups`. Required when `control_type` is `dropdown` or `dependent_select`. Nullable otherwise. |
| `position` | integer | always | Display order in the form. May differ from the field's `position` (which is for template column order). |

**Promises to consumers.**
- Slot pool assignment is settled at canonical-model build time. The pairing of a field to a specific `slot_name` is stable for the version's lifetime.
- WFA reads `display_label` from this collection; it is not derived at render time.
- Only form-visible fields appear here. Hidden fields (`visible: false` on `cfg_fields`) are absent.

---

## `cfg_error_messages`

Per-version snapshot of error code → human-readable message.

| Field | Type | Presence | Notes |
|---|---|---|---|
| `error_translation_id` | string (UUID) | always | PK. Minted at canonical-model build time. |
| `error_code` | string | always | Stable code referenced by `cfg_rules[].error_message`. |
| `human_readable_message` | string | always | Message shown to suppliers. Supports placeholder substitution. |
| `required_placeholders` | string | optional | Comma-separated placeholder names (`{field_name}`, `{value}`, etc.) the rendering recipe must supply. Nullable. |

**Promises to consumers.**
- The snapshot is per-version. Each canonical model carries its own copy of the error translations; changes flow forward via new versions, not via shared mutable state.
- `error_code` values are referenced by both `cfg_rules` and by the connector's built-in error codes (`err_required`, `err_data_type`, etc.). The set of codes referenced is the union.

---

## Cross-collection invariants

Things consumers can rely on across collections:

1. **All FK references resolve.** A `cfg_rules` entry's `field_id` always matches an entry in `cfg_fields`. A `cfg_variant_fields` entry's `variant_id` and `field_id` always match entries in their respective collections. CFG-01 catches violations at config-validation time before PRV-02 builds the canonical model.

2. **`lookup_name` references resolve.** A `cfg_fields[].lookup_name` value always corresponds to at least one row in `cfg_lookups` with the same `lookup_name`. Empty lookups are caught by CFG-01.

3. **`error_code` references resolve.** A `cfg_rules[].error_message` value (when present) matches an `error_code` in `cfg_error_messages`, OR is one of the connector's built-in codes. The union is closed.

4. **Slot pool assignment is unique.** Each `slot_name` in `cfg_form_slot_mappings` appears at most once. PRV-02's assignment logic guarantees this.

5. **Variant coverage.** Every field in a variant's `cfg_variant_fields` entries appears in `cfg_fields`. Implicit from invariant 1, but worth restating because it's the invariant TPL-01 leans on most.

---

## What the canonical model does **not** contain

Three deliberate absences:

**Supplier and user data.** The parsed config carries `suppliers` and `users` arrays. The canonical model does not. PRV-04 reads supplier/user content directly from the parsed config (`Project.parsed_config_path` or `CFG_TemplateVersion.parsed_config_path`, depending on whether it's E1 or E2). After PRV-04 runs, supplier and user state lives in `SUP_Supplier` and `SUP_SupplierUser` rows.

**Customer-level engagement settings.** Things like `analyst_email`, `target_vms`, `reminder_days_1/2/3` live on `Project`. They aren't duplicated into the canonical model; consumers that need them read the Project row.

**Variant template paths.** `CFG_Variant.template_path` is data-table state, written by PRV-04 after TPL-01 produces variant bytes. The canonical model knows variants exist (in `cfg_variants`) but doesn't track where their files live; that's runtime operational state.

The principle: the canonical model is the runtime *configuration*, not the runtime *operational state*. Configuration is immutable; operational state is mutable. Keeping them separated is what makes the snapshot semantics invariant tractable.

---

## Open questions

1. **Slot pool assignment algorithm.** The canonical model carries the *result* of slot pool assignment (in `cfg_form_slot_mappings`). The *algorithm* PRV-02 uses isn't specified here. Currently sketched as first-fit per type — fields are assigned to slots in `position` order, choosing the first available slot whose type matches. Type-aware: a numeric field gets a `slot_num_*`, a date field gets a `slot_date_*`, etc. If the type-specific slots are exhausted, the field doesn't get a form-slot mapping and isn't form-visible regardless of `visible: true` on the field. This will get refined during PRV-02 build. The shape of the output is locked here; the algorithm is a build concern.

2. **Multiple lookups with the same name.** The canonical model allows multiple `cfg_lookups` rows with the same `lookup_name` (they form the lookup's value set together). But what if the workbook defined two genuinely separate lookups with the same name? CFG-01 should catch this via `no_duplicate_lookup_entries`, but worth confirming. If not caught, the canonical model would conflate them silently.

3. **Form vs. template field ordering.** `cfg_fields[].position` is the template column order. `cfg_form_slot_mappings[].position` is the form display order. These can differ. Currently the parser produces the same value for both, but the schema allows them to diverge. Worth a build-time decision: do we want them to be allowed to diverge (e.g., for a form layout that's intentionally different from the template), or should we enforce parity?

4. **What's the `built_by_recipe` field for?** Currently always `"PRV-02"`. Reserved for cases where a different recipe builds canonical models — e.g., a future migration utility that re-builds a canonical model from an existing version's data tables. If that capability never exists, the field is dead weight. Lean: keep it, the cost is trivial and the audit value is real.

---

## Versioning of the canonical model shape itself

This document is v1. If the canonical model schema changes — fields added, fields removed, fields renamed — the canonical model files produced under the old schema don't automatically migrate.

Two principles:

- **Forward-compatible changes are free.** Adding a new optional field to any collection (or to `_meta`) doesn't break existing consumers. Old canonical model files lack the new field; consumers handle `null` or absent values gracefully.

- **Backward-incompatible changes require a versioned canonical model schema.** If a field is removed or renamed, every existing canonical model file becomes "schema-v1," and PRV-02 starts producing "schema-v2." Consumers either handle both or are upgraded in lockstep with PRV-02.

`_meta` should probably include a `schema_version` field. Not in v1 (no need yet), but reserved for the moment a backward-incompatible change is made. Worth flagging.

---

## What this enables

With this document locked, every Stage 4+ recipe plan can reference "the canonical model" with a stable meaning. The Stage 4 INV-01 plan can say "reads suppliers from `Project.parsed_config_path`" rather than ambiguously "from the configuration"; the Stage 5 R5 plan can say "reads the canonical model's `cfg_error_messages` for rendering" with confidence about the field name.

The construction spec for PRV-02 — how it builds this from a parsed config — is the natural next artifact for PRV-02 build time. It will reference this document as its target shape.

## What's next

With the canonical model shape locked, the next planning artifact returns to recipe plans:

**Stage 4 — Invitation:**
- INV-01 (Invite supplier users) — and a decision on its domain code (the cross-cutting open question from the sibling scopes: `INV`, `ACS`, `NTF`, or absorbed into `REM`).

That's the natural next planning step. The remaining stages (5–8) follow.
