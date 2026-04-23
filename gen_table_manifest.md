# SDC Data Model — JSON Schema

Re-statement of the SDC platform data layer as JSON Schema 2020-12,
generated directly from the 20 Workato data-table exports.

## Files

| File | Purpose |
|---|---|
| `sdc-base.schema.json` | Base project (4 tables): HOME_Requests, HOME_Manifests, HOME_WorkspaceRegistry, MAIN_ProvisioningResults. |
| `sdc-data-collection.schema.json` | Data collection / application project (16 tables): WFA_*, VER_*, CFG_*, RUN_*. |
| `generate_schemas.py` | Deterministic generator. Re-run when source tables change. |

Each document has `$defs/<TableName>` — one `$def` per table, keyed by
normalized table name. Cross-project references use absolute `$id` URIs
so the two files can be validated independently.

## Conventions

### Type mapping

Workato storage type → JSON Schema:

| Workato | JSON Schema |
|---|---|
| `short-text` | `{ "type": "string" }` |
| `long-text` | `{ "type": "string", "x-workato-type": "long-text" }` |
| `date-time` | `{ "type": "string", "format": "date-time" }` |
| `boolean` | `{ "type": "boolean" }` |
| `integer` | `{ "type": "integer" }` |
| `file` | `{ "type": "string", "x-workato-type": "file" }` (FileStorage ref) |
| `relation` | `{ "type": "string", "x-workato-type": "relation" }` + ref block |

### `x-*` annotations

Custom keywords carry metadata that has no native JSON Schema equivalent:

- `x-workato-field-id` — the source UUID for the column. Lets you round-trip a schema change back to a Workato column.
- `x-workato-type` — original Workato type when not inferable from `type` (e.g. `long-text`, `file`, `relation`).
- `x-workato-readonly`, `x-workato-hidden` — column flags from source.
- `x-workato-system-fields` — list of the three shared Workato system columns (`Record ID`, `Created time`, `Last modified time`) present on every table.
- `x-workato-relation` — the raw relation block when the source column is typed `relation`.
- `x-workato-table-name`, `x-workato-project`, `x-workato-tags` — table-level provenance.
- `x-fk` — normalized foreign-key block (see below).
- `x-semantic-type`, `x-slot-note` — the intended semantic type of `slot_*` columns, which are stored as `short-text` for widget compatibility.
- `x-immutable`, `x-write-once` — lifecycle flags lifted from hint prose.
- `x-name-normalized-from` — present only on `HOME_Manifests` (see Anomalies).

### The `x-fk` block

Every foreign key — real or soft — renders as a single, uniform object:

```jsonc
"x-fk": {
  "$ref": "#/$defs/VER_TemplateVersion",   // same-file ref
  "target_field": "template_version_id"
}
```

Variants:

| Variant | Added keys | Meaning |
|---|---|---|
| Same-project FK | (none) | Resolves inside the current file. |
| Cross-project FK | `deferred_relation: true`, `rationale` | `$ref` points at the other file's `$id`. Two-pass provisioning resolves it. |
| Soft join (name-based) | `soft_join: true`, `rationale` | Join happens on a shared value (e.g. `lookup_name`), not UUID. |
| Self-reference | `self_reference: true` | Column points at the same table (e.g. `CFG_Field.depends_on`). |
| Derived from Workato `relation` | `via: "workato-relation"` | `$ref` inferred from the source `relation` block, which is also preserved verbatim in `x-workato-relation`. |

### Enums

Status / type columns with clearly enumerated valid values in their
hints are emitted as `enum`. Currently enumerated:

- `HOME_Requests.status` — `PENDING | PROVISIONING | ACTIVE | FAILED | CLOSED`
- `HOME_WorkspaceRegistry.status` — `AVAILABLE | UNAVAILABLE`
- `VER_TemplateVersion.status` — `draft | published | deprecated`
- `WFA_SupplierRequest.status` — `pending | sent | in_progress | submitted | validated | accepted | rejected`
- `WFA_SupplierUser.status` — `active | deactivated`
- `WFA_TemplateProject.project_completion_status` — `active | inactive`
- `CFG_Field.data_type` — `string | integer | date | decimal | boolean`
- `CFG_FormSlot.control_type` — `text | number | dropdown | date | checkbox`
- `RUN_Upload.status` — `received | extracting | validating | validated | failed`
- `RUN_ValidationResult.status` — `running | passed | failed | error`

### `additionalProperties: false`

Set on every table `$def`. Matches Workato's fixed-column reality; any
unrecognized field should fail validation, which catches drift fast.

## Anomalies flagged during generation

Three things surfaced on read that are worth confirming or repairing
upstream. None of them block use of the schemas — all are annotated in-place.

### 1. `HOME - Manifests` source name

The source table name is literally `"HOME - Manifests"` (spaces, dash),
inconsistent with the `HOME_WorkspaceRegistry` / `HOME_Requests` convention.

Handled: `$def` key is normalized to `HOME_Manifests`; the raw name is
preserved as `x-workato-table-name: "HOME - Manifests"` and flagged via
`x-name-normalized-from`.

Recommended upstream fix: rename the source table to `HOME_Manifests`
and update the file name, then re-run the generator (which will
automatically drop the override and the `x-name-normalized-from` marker).

### 2. `WFA_SupplierRequest.current_validation_result_id` mis-wired relation

Source relation points to `RUN_FieldError.field_id`, but the column name
says it should point to `RUN_ValidationResult.validation_result_id`.

Handled: `x-fk` rewrites it to `RUN_ValidationResult`; the `note` field
on `x-fk` documents the repair and preserves the original mis-wiring
for reference (via `x-workato-relation`, which is untouched).

Recommended upstream fix: repoint the relation in Workato, then re-run
the generator.

### 3. Slot columns are stored as `short-text` regardless of semantic type

`slot_num_*`, `slot_bool_*`, `slot_date_*`, and `slot_sel_*` are all
`short-text` in storage — a deliberate choice for WFA widget
compatibility.

Handled: schema `type` reflects storage (`string`); `x-semantic-type`
and `x-slot-note` annotate the intended type. Downstream validation
(V-01b) is the layer that enforces it.

No upstream fix needed. Just documenting that the schema's `type`
should not be "corrected" to match semantics.

## Regenerating

```bash
cd /path/to/sdc-data-model
python3 generate_schemas.py
```

Source files are expected at `/mnt/user-data/uploads/*_workato_db_table.json`.
Edit `UPLOADS_DIR` and `OUT_DIR` at the top of the script if needed.

The FK and enum overlays live in the generator as hand-curated dicts
(`FK_OVERLAY`, `ENUM_OVERLAY`). When a new relation or enumerated
column is added to a source table, add an entry there rather than
hoping hint-text parsing catches it — keeps behavior deterministic and
the overlay serves as a second, auditable source of truth for the
cross-reference graph.
