# SDC Data Collection — PRV-02 Construction Spec (v1, Stage 3)

## Status

Construction spec for **PRV-02 Parse Config and Build Canonical Model**. Extends the recipe plan in `02_recipe_plan_stage3.md`; consumes the canonical model shape spec at the contract level; reads the parsed-config schema from the SDC Platform Connector's `parse_config_file` action.

The plan settled what the recipe does at substage granularity. This spec settles **how each substage is built**, with depth weighted toward Substage 6 — the canonical-model build — which is the only substage with substantive algorithmic content. The other seven substages are orchestration: connector calls, callable invocations, FileStorage reads and writes, emit calls, and a couple of branch points. They get construction-level detail, but the detail is thin because the work is thin.

Required before PRV-02 build begins. PRV-03 and PRV-04 can be specced before PRV-02 is built; they don't depend on this document, only on the canonical model shape.

---

## Foundational decisions

Three decisions that thread through the spec:

1. **The Python step is the surface of substance.** Substages 1, 2, 3, 5, 7, and 8 are Workato-native (connector action, callable invocation, Data Tables write, FileStorage write, OBS-01 emit). Substage 4 is a branch. Substage 6 is the only place where non-trivial logic lives; that logic runs in a single Python step that takes parsed config in and returns canonical model out. Splitting the algorithm across multiple Python steps or interleaving it with Workato pills introduces serialization round-trips that the SDK hash-rocket quirk has bitten us with before. One step, one return.

2. **Name maps are built once, used everywhere.** FK resolution requires `field_name → field_id`, `variant_name → variant_id`, and `lookup_name → [rows]`. The algorithm constructs each map immediately after the relevant entity collection is built, then uses the map for every subsequent FK resolution. No name lookup happens twice.

3. **PRV-02 trusts CFG-01 for config-shape validity, but verifies its own output.** CFG-01 has already confirmed referential integrity, no-duplicate-names, lookup membership, and so on. PRV-02 doesn't re-run those checks. But the canonical model produced by the algorithm is a new artifact with new failure modes (duplicate slot assignment, FK resolution gap from an algorithm bug), and the algorithm self-checks those before returning.

---

## Substage map

| # | Substage | Mechanism | Failure surface |
|---|---|---|---|
| 1 | Parse config via connector | Connector action `parse_config_file` | `config_unparseable` |
| 2 | Emit `config_parsed` | OBS-01 callable invocation | none routine |
| 3 | Call `validate_config` directly | Connector action | `external_action_failed` |
| 4 | Branch on verdict | Recipe branch + emit | n/a |
| 5 | Create or update TemplateVersion | Data Tables create | `external_action_failed` |
| 6 | Build canonical model | Python step | `unexpected_error` |
| 7 | Write canonical model to FileStorage | FileStorage write + Data Tables update | `external_action_failed` |
| 8 | Fire PRV-03 | Async callable invocation | `external_action_failed` |

Each substage gets its own section below. Substage 6 has the bulk of the spec.

---

## Substage 1 — Parse config via connector

**Input.** `parsed_config_path` from the trigger schema. This is a FileStorage path written by PRV-01.

**Mechanism.** Read the file from FileStorage (the parsed_config_path content is the GAS-exported JSON, i.e., the workbook serialized as a `{sheet_name: [[row], [row], ...], "_field_visibility": {field_name: bool}}` object). Invoke the connector's `parse_config_file` action with `sheet_data` set to that JSON string.

**Output captured.** The connector returns a structured response with seven entity collections, a parse summary, and — critically — `parsed_config_json` as a serialized JSON string. That serialized form is the canonical input to CFG-01 and to the canonical-model build. PRV-02 captures it and passes it forward unchanged; the structured Workato pills are useful for diagnostic emits but the serialized JSON is the authoritative artifact.

**Storage of the parser output.** PRV-02 writes the parser's serialized output to FileStorage at `CFG_TemplateVersion.parsed_config_path` once the version row is created (Substage 5). Per the naming conventions, this is `/templates/v<NNN>/parsed_config.json` — the per-version snapshot, distinct from the project-level `Project.parsed_config_path` that PRV-01 wrote. Naming-doc invariant 11 covers the write-once promise.

Note the timing dependency: Substage 5 creates the version row before the path is known, but the path uses the version number. Construction-time resolution: PRV-02 reads `version_number` from the new version row in Substage 5, computes the path, then writes the parsed-config JSON. The write happens between Substage 5 and Substage 6 in clock time, even though it's logically a Substage-1 output.

**Failure mode.** The connector returns `{"status": "error", "error": {"message": ..., "sheet": ...}}` when a required sheet is missing or `sheet_data` is empty. Map directly to `recipe_failed` with `error_type=config_unparseable`. Halt.

**Decision: don't re-parse on retry.** If PRV-02 is retried after failing in Substage 1, the parsed_config_path on disk hasn't changed; the connector will produce the same error. No idempotency concern here; the cleanup is for the analyst to re-export from GAS.

---

## Substage 2 — Emit `config_parsed`

OBS-01 invocation. Severity `info`. Payload includes `template_version_id` *(not yet known — see below)*, `project_id`, and the parse summary (field count, rule count, variant count, etc.).

**Sequencing issue.** The recipe plan implies `config_parsed` emits after the connector returns and before CFG-01 runs. But `template_version_id` is minted in Substage 5, which happens after the CFG-01 verdict in Substage 4. So at Substage 2 time, the version ID is not yet available.

**Decision: emit at Substage 2 without `template_version_id`, with `project_id` only.** The phase taxonomy treats `config_parsed` as a project-scope milestone. The version exists conceptually as a draft after Substage 5; before that, the emit is "this project's incoming config has been parsed." Carrying `project_id` is sufficient. `template_version_id` shows up in `version_published` (PRV-04's emit) and in `recipe_failed` payloads from later substages.

Alternative considered: defer `config_parsed` until after Substage 5 so it can include the version ID. Rejected because the natural lifecycle moment is "parser produced structured output," which is Substage 1's completion, and decoupling emits from their lifecycle moment fragments the timeline.

---

## Substage 3 — Call `validate_config` directly

Connector action invocation. The connector's `validate_config` action takes `parsed_config_json` (string) and returns a verdict object (`{status, error_count, warning_count, checks}`).

**Decision: PRV-02 calls `validate_config` directly, not via CFG-01.** CFG-01 takes a Drive file ID as input — it's the analyst-facing entry point (GAS-triggered standalone validation, where the natural reference is the Drive workbook). PRV-02 has a different entry-point shape: by Substage 3 it already holds the parsed-config JSON in memory from Substage 1. Calling the underlying connector action preserves the in-memory handoff that the construction spec wants and avoids threading a Drive ID through a path that doesn't otherwise need one.

The validation logic is identical either way — both CFG-01 and PRV-02 ultimately call the same connector action. The split is at the entry-point shape, not the logic.

**Emit responsibility shifts.** Because PRV-02 isn't routing through CFG-01, it emits `config_validated` (on `valid` verdict, in Substage 4's fall-through branch) and `config_rejected` (on `invalid` verdict, in Substage 4's `invalid` branch) itself. The phase taxonomy treats these as workflow-stage phases, not recipe-bound, so multiple recipes emitting them is consistent with the taxonomy's design.

---

## Substage 4 — Branch on verdict

Two branches:

- **`invalid`** — PRV-02 emits `config_rejected` (severity `warn`) carrying the verdict's failing checks in `details_json`. The recipe returns early with the validation summary. No `template_version_id` exists yet to publish; the workflow stops here cleanly.
- **`valid`** — PRV-02 emits `config_validated` (severity `info`) and proceeds to Substage 5.

A `warn`-count > 0 with `error_count` == 0 still routes to the `valid` branch. Warnings (e.g., `email_format_valid`, `variant_count_matches`) don't block provisioning. They surface in the `config_validated` emit's `details_json` for analyst review.

---

## Substage 5 — Create or update TemplateVersion

Branches on `is_initial`:

- **E1 (`is_initial=true`).** Create a `CFG_TemplateVersion` row. `version_number = 1`. `status = "draft"`. `project_id` from the trigger. `master_template_path`, `parsed_config_path`, `canonical_model_path` left null for now (set in Substage 7 after files are written).
- **E2 (`is_initial=false`).** Query existing `CFG_TemplateVersion` rows for this `project_id`; compute `MAX(version_number) + 1`; create a new draft version with that number. The prior published version stays untouched here — deprecation happens in PRV-04.

**Computing `MAX(version_number)`.** Workato Data Tables doesn't have a native aggregate function in the SDK we're using. Decision: a Data Tables search with `sort_by=version_number DESC` and `limit=1`, then extract the value in a small Python step (or a formula pill if it's simple enough). The version table will never have more than a handful of rows per project, so the cost is trivial. If this turns out to be cumbersome, fall back to read-all-and-compute.

**Write the parsed-config file.** Once `version_number` is known, compute `/templates/v<NNN>/parsed_config.json` and write the serialized parsed-config JSON (captured in Substage 1) to FileStorage at that path. Update `CFG_TemplateVersion.parsed_config_path` to point at it.

**Idempotency concern.** If PRV-01 retried and PRV-02 has already created a draft version for this trigger, a second invocation would create a *second* draft. The recipe plan's open question on idempotency surfaces here. **Lean toward**: at Substage 5 entry, query for an existing `draft` version on this project before creating; if one exists with a `correlation_id` matching this run's, treat it as a retry and proceed against the existing draft. If one exists with a different correlation_id, raise `recipe_invariant` — two concurrent provisioning runs is a real problem the analyst needs to see.

The correlation_id needs to land on `CFG_TemplateVersion` for this to work — a small backport queued for the data model. Until then, idempotency is best-effort: lean toward "accept the risk for now, fix when correlation_id propagation is wired."

---

## Substage 6 — Build the canonical model

The substantive piece. A single Python step. Input: the parsed-config JSON (from Substage 1) plus the `template_version_id` and `version_number` (from Substage 5). Output: the canonical model JSON as a string, ready for FileStorage write.

### Inputs to the algorithm

The parsed config is the connector's `parsed_config_json` output, deserialized. Its top-level keys, from reading `parse_config_file`:

- `customer` — engagement metadata (analyst_email, drive_folder_id, variant_count, target_vms, etc.)
- `fields` — array; each row carries `_index`, `field_name`, `data_type`, `data_format`, the boolean flags (`required`, `must_be_empty`, `column_unique`, `strict`, `visible`), the four validation strings, `data_cleaning_flags`, `lookup_name`, `depends_on_field_name`, `description`
- `rules` — array; each row carries `target_field_name`, `rule`, `condition_field_name`, `conditional_value`, `error_message`, `error_message_custom`, `strict_enforcement`
- `lookups` — array; each row carries `lookup_name`, `valid_values`, `display_label`, `parent_value`, `project_specific`
- `variants` — array; each row carries `variant_name`, `visible_field_names` (array of field name strings), `is_synthesized`
- `suppliers`, `users` — arrays; **not consumed by the canonical model build** (per canonical model shape spec, suppliers and users are out of scope for the canonical model)
- `error_translations` — array; each row carries `error_code`, `human_readable_message`, `required_placeholders`

The algorithm consumes `customer`, `fields`, `rules`, `lookups`, `variants`, and `error_translations`. The customer block is read for `_meta` projection only.

### Build order

The dependency graph dictates order:

1. `_meta` (independent)
2. `cfg_fields` — **pass 1**: mint UUIDs, copy scalar properties, leave `depends_on_field_id` null
3. `cfg_lookups` (independent — natural-keyed by `lookup_name`)
4. `cfg_variants` (independent — mint UUIDs)
5. `cfg_error_messages` (independent — mint UUIDs)
6. Build the three name maps: `{field_name: field_id}`, `{variant_name: variant_id}`, `{lookup_name: [lookup rows]}`
7. `cfg_fields` — **pass 2**: resolve `depends_on_field_name` to `depends_on_field_id` using the field-name map
8. `cfg_variant_fields` — resolve both ends via the variant-name and field-name maps
9. `cfg_rules` — resolve `target_field_name → field_id` and `condition_field_name → condition_field_id`
10. `cfg_form_slot_mappings` — filter to visible fields, run the slot pool algorithm, assemble entries
11. Cross-collection invariant self-check (Section "Cross-collection invariant checks" below)
12. Assemble the top-level object, serialize, return

The two-pass build for `cfg_fields` is needed because resolving `depends_on_field_id` requires the full field-name map, which is only complete once all fields have been minted. Doing it as one pass with a forward declaration is possible but adds bookkeeping; two passes is cleaner.

### UUID minting

**Decision: standard `uuid.uuid4()` v4 UUIDs throughout.** Random, no coordination required, collisions astronomically improbable. The canonical model is content-addressed by `template_version_id` anyway; per-entity IDs only need to be locally unique within the canonical model.

UUIDs are minted at:
- `cfg_fields[].field_id` (one per parsed field)
- `cfg_rules[].rule_id` (one per parsed rule)
- `cfg_variants[].variant_id` (one per parsed variant)
- `cfg_form_slot_mappings[].form_slot_id` (one per visible field that gets a slot)
- `cfg_error_messages[].error_translation_id` (one per error translation)

`cfg_lookups` rows have no UUID PK — they're keyed by `(lookup_name, valid_value)` per the canonical model shape spec. The algorithm preserves this.

`cfg_variant_fields` rows have no UUID PK — they're a join table keyed by `(variant_id, field_id)`. The algorithm preserves this too.

### Per-entity construction

#### `_meta`

| Field | Source |
|---|---|
| `template_version_id` | passed in from Substage 5 |
| `version_number` | passed in from Substage 5 |
| `project_id` | passed in from the trigger |
| `expected_sheet_name` | hardcoded `"Data"` (decision: hardcoded for v1; if templates ever vary sheet names, this becomes a config-driven value) |
| `built_at` | `datetime.utcnow().isoformat()` |
| `built_by_recipe` | hardcoded `"PRV-02"` |

#### `cfg_fields` (pass 1, then pass 2)

For each parsed field (in parsed order, which is `_index` order):

| Output field | Source |
|---|---|
| `field_id` | mint uuid4 |
| `field_name` | parsed `field_name` |
| `description` | parsed `description` (preserve null) |
| `data_type` | parsed `data_type` |
| `data_format` | parsed `data_format` (preserve null) |
| `position` | parsed `_index` (zero-indexed; aligns with parser's position) |
| `required`, `must_be_empty`, `column_unique`, `strict`, `visible` | parsed booleans, preserved as native booleans |
| `field_length_validation`, `numeric_field_validation`, `date_field_validation`, `field_input_validation`, `data_cleaning_flags` | parsed strings (preserve null) |
| `lookup_name` | parsed `lookup_name` (preserve null; this stays a name, not resolved to UUID) |
| `depends_on_field_id` | **pass 2**: look up parsed `depends_on_field_name` in the field-name map; null if name is blank |
| `control_type` | derive via the same mapping the connector's `resolve_form_control_type` method uses |

The `control_type` derivation should match `resolve_form_control_type` in the connector exactly. The algorithm reproduces the same mapping in Python rather than calling the connector again — the connector method is six lines and porting it preserves the single-step principle.

#### `cfg_lookups`

For each parsed lookup row:

| Output field | Source |
|---|---|
| `lookup_name` | parsed `lookup_name` |
| `valid_value` | parsed `valid_values` (note: parser column is plural; canonical model uses singular per shape spec) |
| `display_label` | parsed `display_label` (preserve null) |
| `parent_value` | parsed `parent_value` (preserve null) |
| `project_specific` | parsed boolean |

Naming note: the parsed config calls the column `valid_values` (plural), but the canonical model shape spec calls it `valid_value` (singular, because each row holds one value). The algorithm renames during transfer.

#### `cfg_variants`

For each parsed variant:

| Output field | Source |
|---|---|
| `variant_id` | mint uuid4 |
| `variant_name` | parsed `variant_name` |
| `description` | not in parser output; emit as null |
| `is_synthesized` | parsed `is_synthesized` (the parser sets this when the base-variant fallback fires) |

#### `cfg_variant_fields`

For each parsed variant, iterate its `visible_field_names`. For each name, look up `field_id` in the field-name map. Emit `{variant_id, field_id}`.

**Failure mode**: if a name doesn't resolve, CFG-01 should have caught it (`variant_field_exists`). If it slips through, the algorithm raises — see "Cross-collection invariant checks" below.

#### `cfg_rules`

For each parsed rule:

| Output field | Source |
|---|---|
| `rule_id` | mint uuid4 |
| `field_id` | look up parsed `target_field_name` in field-name map |
| `rule` | parsed `rule` |
| `condition_field_id` | look up parsed `condition_field_name` in field-name map; null if blank |
| `conditional_value` | parsed `conditional_value` (preserve null) |
| `error_message` | parsed `error_message` (preserve null) |
| `error_message_custom` | parsed `error_message_custom` (preserve null) |
| `strict_enforcement` | parsed boolean |
| `scope` | parsed `scope` if present; default `"submission"` |
| `target_field_name` | parsed (denormalized, kept for diagnostic readability) |
| `condition_field_name` | parsed (denormalized) |

`scope` defaulting: the parser doesn't currently emit a `scope` column (the workbook's validations sheet doesn't have one). The canonical model shape spec lists `scope` as always present with default `"submission"`. Decision: default to `"submission"` in the algorithm. When the workbook eventually grows a scope column and the parser surfaces it, the algorithm picks up the parsed value transparently.

#### `cfg_form_slot_mappings` — slot pool algorithm

This is the only piece of the algorithm that's non-trivial.

**Inputs**:
- The set of fields with `visible == true`, in `position` order
- The `field_id` (from pass 1) for each
- The `control_type` (from pass 1) for each

**Slot pool** (from the data model and user memory):

| Slot type | Slot column names | Count |
|---|---|---|
| text | `slot_text_01` through `slot_text_08` | 8 |
| num | `slot_num_01`, `slot_num_02` | 2 |
| bool | `slot_bool_01`, `slot_bool_02` | 2 |
| sel | `slot_sel_01` through `slot_sel_04` | 4 |
| date | `slot_date_01` through `slot_date_04` | 4 |
| **total** | | **20** |

**Control type → slot type mapping**:

| `control_type` | Slot type |
|---|---|
| `text` | text |
| `email` | text |
| `number` | num |
| `currency` | num |
| `checkbox` | bool |
| `dropdown` | sel |
| `dependent_select` | sel |
| `date` | date |

**Algorithm** (first-fit per type, position order):

```
free_slots = {
  "text": ["slot_text_01", ..., "slot_text_08"],
  "num":  ["slot_num_01", "slot_num_02"],
  "bool": ["slot_bool_01", "slot_bool_02"],
  "sel":  ["slot_sel_01", ..., "slot_sel_04"],
  "date": ["slot_date_01", ..., "slot_date_04"]
}

position_counter = 0
mappings = []

for field in visible_fields_in_position_order:
  slot_type = control_type_to_slot_type[field.control_type]
  
  if not free_slots[slot_type]:
    raise SlotPoolOverflowError(
      field_name=field.field_name,
      slot_type=slot_type
    )
  
  slot_name = free_slots[slot_type].pop(0)
  
  mappings.append({
    "form_slot_id":  mint_uuid(),
    "field_id":      field.field_id,
    "slot_name":     slot_name,
    "display_label": field.field_name,  # see below
    "control_type":  field.control_type,
    "required":      field.required,
    "lookup_name":   field.lookup_name,  # may be null
    "position":      position_counter
  })
  position_counter += 1

return mappings
```

**`display_label` source.** The canonical model shape spec requires `display_label` to be present. The parser output doesn't currently produce a per-field display label (workbook column `Field name` is used for both the column header and the form label). **Decision for v1: `display_label = field_name`.** When the workbook gains a separate "Form label" column, the parser surfaces it and the algorithm uses it. Until then, the field name serves both roles.

**`position` in form_slot_mappings.** The canonical model shape spec notes this may differ from the field's own `position` (which is template column order). For v1, the form position equals the order of iteration through `visible_fields_in_position_order` — i.e., form position mirrors template column position, just without gaps from non-visible fields. The schema permits divergence; the algorithm doesn't generate any.

**Slot pool overflow.** If `free_slots[slot_type]` is empty when a field needs a slot, the algorithm raises. This is a configuration error — the analyst has more visible fields of that type than the form supports. CFG-01's `form_field_limit` catches the aggregate case (>20 visible total) but not the type-specific case (e.g., 9 visible text fields). See open questions for the resolution path.

#### `cfg_error_messages`

For each parsed error translation:

| Output field | Source |
|---|---|
| `error_translation_id` | mint uuid4 |
| `error_code` | parsed `error_code` |
| `human_readable_message` | parsed `human_readable_message` |
| `required_placeholders` | parsed `required_placeholders` (preserve null) |

### Cross-collection invariant checks

After the seven entity collections are built, the algorithm self-checks. These checks duplicate work CFG-01 did, but on the *output* artifact rather than the *input* — they catch algorithm bugs that CFG-01 can't catch because CFG-01 doesn't see the canonical model.

Five checks, all hard-fail (raise an exception that surfaces as `recipe_invariant`):

1. **All `field_id` references resolve.** Walk `cfg_rules[].field_id`, `cfg_rules[].condition_field_id`, `cfg_variant_fields[].field_id`, `cfg_form_slot_mappings[].field_id`, `cfg_fields[].depends_on_field_id`. Every non-null value must exist in `{f.field_id for f in cfg_fields}`.

2. **All `variant_id` references resolve.** Walk `cfg_variant_fields[].variant_id`. Every value must exist in `{v.variant_id for v in cfg_variants}`.

3. **All `lookup_name` references resolve.** Walk `cfg_fields[].lookup_name`, `cfg_form_slot_mappings[].lookup_name`. Every non-null value must appear as a `lookup_name` in `cfg_lookups`.

4. **Slot pool assignment is unique.** Every `slot_name` in `cfg_form_slot_mappings` appears at most once.

5. **`error_code` references resolve.** Walk `cfg_rules[].error_message`. Every non-null value either matches an `error_code` in `cfg_error_messages` OR matches one of the connector's built-in codes (`err_required`, `err_data_type`, etc.). The union is closed per canonical model shape spec invariant 3.

Each check, if it fails, raises with a payload identifying the offending entity and the unresolved reference. The Python step's exception surfaces to Workato as a job error and PRV-02 emits `recipe_failed` with `error_type=recipe_invariant`.

### Return value

The Python step returns the canonical model as a single JSON string. Workato treats it as a string pill; Substage 7 writes that string to FileStorage as-is.

---

## Substage 7 — Write canonical model to FileStorage

Compute the path: `/templates/v<NNN>/canonical_model.json`, where `<NNN>` is the version number from Substage 5. Per the naming conventions doc's path conventions, formatted with a zero-pad width established at first use (v1: lean toward three-digit padding, so v1 → `v001`; a project would have to publish a thousand versions before this matters, and the consistent width helps human scanning of the FileStorage tree). **Decision deferred** to the build's first concrete path-format choice; flag if the connector's `build_storage_path` helper imposes a different convention.

FileStorage write: `overwrite: false`, per the FileStorage conventions established in P-01's refactor. The path is per-version and per-build, so a collision would itself be a bug (two PRV-02 runs producing canonical models for the same version) — `overwrite: false` makes that bug loud.

After the write succeeds, update `CFG_TemplateVersion.canonical_model_path` on the version row to point at the file.

**Failure mode.** FileStorage write failure → `recipe_failed` with `error_type=external_action_failed`. The draft version row exists but has no canonical_model_path; cleanup is the orphan-sweep concern flagged in the recipe plan's open questions.

---

## Substage 8 — Fire PRV-03

Asynchronous callable invocation. Pass `template_version_id` and `canonical_model_path`. Both are now populated on the version row; the canonical_model_path is passed explicitly for the convenience of PRV-03's input contract even though PRV-03 could re-read it from the version row.

PRV-02 returns from its caller's perspective at this point. The chain continues in PRV-03 without blocking.

**Failure mode.** If the async call itself fails to dispatch (Workato platform error, not a PRV-03 failure), PRV-02 emits `recipe_failed` with `error_type=external_action_failed`. The version row is left in `draft` with a complete canonical model on disk — a re-invocation of PRV-02 could pick up here, but the simpler path is for the operator to manually re-fire PRV-03 against the existing version.

---

## Failure modes — full enumeration

Mapping each error type the recipe plan named to the substage that produces it and the canonical phase taxonomy entry:

| Error type | Substage | Phase emitted | Trigger |
|---|---|---|---|
| `config_unparseable` | 1 | `recipe_failed` | Connector returned `{status: error}` from `parse_config_file`. Most common cause: required sheet missing, malformed `sheet_data`. |
| `config_invalid` | 4 | `config_rejected` (warn) | `validate_config` returned `invalid` status. PRV-02 emits the phase itself; the recipe halts cleanly without `recipe_failed`. |
| `external_action_failed` | 5, 7, 8 | `recipe_failed` | Data Tables create/update failed (5), FileStorage write failed (7), or callable dispatch failed (8). |
| `recipe_invariant` | 6 (self-check), 5 (idempotency) | `recipe_failed` | Cross-collection check failed in the canonical model build; OR two concurrent provisioning runs detected on the same project. |
| `unexpected_error` | 6 | `recipe_failed` | Python step crashed for any reason not caught as `recipe_invariant`: pill format issue, type coercion failure, JSON serialization failure. |

Note that the recipe plan listed `config_invalid` as a propagating error type. With CFG-01 out of PRV-02's path (per Substage 3's decision), PRV-02 now owns the `config_rejected` emit directly on the `invalid` verdict. `config_invalid` is the `error_type` value attached to that emit per the error taxonomy.

---

## Test cases

Beyond the four test cases pre-positioned in the recipe plan (PRV-04 idempotent retry, PRV-02 FK resolution, E2 prior-version deprecation, PRV-04 partial-variant failure), the construction needs the following cases for Substage 6 specifically:

### Algorithm correctness

1. **Synthetic config with no variants defined.** Parser produces a synthesized base variant with `is_synthesized=true`. Algorithm must build `cfg_variants` with one row and `cfg_variant_fields` with one row per visible field. The `is_synthesized` flag must pass through.

2. **Field with `depends_on_field_name` pointing at a field defined later in the workbook.** The two-pass build must handle this — pass 1 hasn't built the entire map when the later field is processed, but pass 2 has it complete. Verify forward references resolve correctly.

3. **Self-referential `depends_on_field_name`** (field A's `depends_on_field_name` is A itself). CFG-01 should catch this in the `depends_on_references` check, but if it doesn't, the algorithm needs to not loop. Two-pass build avoids the loop trivially because pass 2 is non-recursive — it does a single lookup per field. Verify the canonical model carries the self-reference if it slips through CFG-01.

4. **Cycle in depends_on chain** (A → B → A). Same reasoning: pass 2 does flat lookups, no recursion, so a cycle in the data produces a canonical model with a cyclic graph. Whether that's a problem is a runtime concern for VAL-01 and TPL-01. CFG-01 doesn't currently check for cycles; flag as open question.

5. **Lookup with only inactive rows.** Parser filters inactive rows (`Record active?` = false). If a field references a lookup that has only inactive rows, the parser produces an empty value set. CFG-01's `lookup_references` check confirms the lookup name exists in *some* row — but the rows could all be inactive and filtered out. After parser filtering, the algorithm would see zero rows for that lookup_name. Verify that `cfg_lookups` correctly contains zero rows for that name, and that the canonical model self-check #3 (`lookup_name references resolve`) doesn't crash but flags the empty lookup.

### Slot pool edge cases

6. **Exactly 20 visible fields, perfectly distributed.** 8 text, 2 num, 2 bool, 4 sel, 4 date all visible. Every slot fills exactly. No overflow.

7. **9 visible text fields.** Eighth gets the last `slot_text_08`; ninth has no slot. Algorithm raises slot-pool-overflow.

8. **Visible field with `control_type=email`.** Maps to slot_text. Verify that an email field and a regular text field compete for the same slot pool.

9. **Visible field with `control_type=dependent_select`.** Maps to slot_sel. Verify that the dependent dropdown's `depends_on_field_id` is resolved AND the dependent field itself gets a slot.

10. **All visible fields have `control_type=checkbox`** (3+ of them). Two get `slot_bool_01` and `slot_bool_02`; third raises overflow. Verify the error message is type-specific.

### Edge cases

11. **Empty rules collection.** Parsed config has fields but no validation rules. `cfg_rules` is empty array. All cross-collection checks must handle empty collections without crashing.

12. **Empty error_translations collection.** Per the parser, rules can carry their own `error_message`. Some configs may have no centralized error translations. `cfg_error_messages` is empty array. Self-check #5 must accept rule error codes that match the connector's built-in codes even when the per-version error_messages list is empty.

13. **Field with all four validation strings populated.** `field_length_validation`, `numeric_field_validation`, `date_field_validation`, `field_input_validation` all set. CFG-01 doesn't reject this (a field is allowed to have multiple constraint flavors), but the validation runtime only applies the ones matching the field's data type. Verify all four pass through to the canonical model untouched.

14. **`_field_visibility` map absent from parser input.** Older GAS exports may not include the visibility map. The parser's `merge_field_visibility` method defaults all fields to `visible=true` in that case. Verify that the algorithm doesn't distinguish "explicit visible=true" from "defaulted-to-visible" — both produce identical canonical model output.

15. **Field name with unicode or special characters.** Parser strips whitespace but allows arbitrary content otherwise. Verify the name-to-UUID map handles non-ASCII keys; verify JSON serialization of the canonical model preserves the characters; verify the `display_label` in form_slot_mappings round-trips faithfully.

### Cross-collection invariant self-check

16. **Force an invariant violation.** Inject a `cfg_rules` row whose `field_id` is a UUID not present in `cfg_fields`. (For test purposes only — production code never produces this.) Verify self-check #1 raises with a clear payload.

17. **Force a slot collision.** Inject two `cfg_form_slot_mappings` entries with the same `slot_name`. Verify self-check #4 raises.

---

## Open questions

### Blocks build

1. **Type-specific slot pool overflow check belongs to CFG-01, not PRV-02.** CFG-01 currently has `form_field_limit` (aggregate check). It should be extended to check per slot-type: at most 8 text, 2 num, 2 bool, 4 sel, 4 date visible. PRV-02 can then trust this check; the algorithm's overflow guard becomes a defense-in-depth assertion rather than a primary failure path. **Decision needed before build**: either extend CFG-01 (small connector change, queued for PRV-02 build) or accept that PRV-02 raises and flag the connector update as backport.

2. **`display_label` for form slot mappings.** v1 uses `field_name` as the display label, with a backport to add a "Form label" column to the workbook when needed. Worth confirming this is acceptable — the canonical model shape spec doesn't require a distinct label source, and the WFA renders the field name as the column header in templates anyway, so reusing it for forms is consistent. If the analyst wants different wording for the form, that's a separate workbook change. **Lean toward**: ship v1 with `field_name`, surface the question to the analyst team after first deployment.

3. **Idempotency on PRV-01 retry.** Substage 5 currently has no idempotency guard. If PRV-01 fires twice, PRV-02 creates two draft versions. **Decision needed**: (a) add `correlation_id` to `CFG_TemplateVersion` and dedup at Substage 5; (b) accept the risk and rely on orphan cleanup; (c) PRV-01 handles dedup before invoking PRV-02. Lean (c) — dedup at the trigger boundary is cleaner than scattered guards downstream. Coordinate with PRV-01 spec.

### Defer

4. **Cycle detection in `depends_on` chains.** CFG-01 doesn't currently check for cycles. Two-pass build in PRV-02 doesn't crash on cycles — it just produces a canonical model with a cyclic graph, which downstream consumers may or may not handle. Worth adding to CFG-01's checks when a cycle bug actually shows up. Until then, document as a known gap.

5. **Path format zero-pad width.** Substage 7's `/templates/v<NNN>/` formatting needs a width decision. The naming conventions doc uses `v<NNN>` notationally without specifying width. **Lean toward** three-digit zero-padded (`v001`, `v010`, `v100`) for consistent human-readable sorting. Confirm with the connector's `build_storage_path` action if it surfaces a different convention.

6. **`built_by_recipe` retention.** The canonical model shape spec keeps the field "reserved for cases where a different recipe ever builds canonical models." Currently the field carries no operational meaning. Worth removing if no use case materializes by Stage 5. Defer.

7. **Conflict to flag**: the canonical model shape spec lists `cfg_fields[].control_type` as always present, and `cfg_form_slot_mappings[].control_type` as always present. The two should be identical for any field that appears in both collections. The algorithm produces them from the same source, so they will be identical, but the spec doesn't explicitly call out the duplication. Lean toward: keep the duplication (the form_slot_mapping is self-contained and consumers shouldn't have to join back to cfg_fields for control_type), and document the redundancy as intentional in a future canonical model shape revision.

---

## Cross-cutting notes

**The Python step is a contract surface.** Substage 6's input and output are crisply defined: parsed-config JSON in, canonical-model JSON out. Treat the Python step's logic as a library function with the same testability and discipline as the connector's actions. The build should write unit tests for the algorithm independent of Workato — feed it synthetic parsed-config JSON, assert on canonical-model output. Workato's job-level testing is integration testing on top of that.

**Algorithm portability.** The canonical-model build algorithm is described in this spec in pseudocode and prose. Nothing about it is Workato-specific; it's pure data transformation. If a future need ever arises to rebuild canonical models outside Workato (a migration utility, a CLI for analyst diagnostics), the algorithm ports unchanged. The `built_by_recipe` field on `_meta` exists for exactly this case.

**Defer to CFG-01 by default.** Several construction decisions push validation work upstream to CFG-01 rather than duplicating in PRV-02 (slot pool type overflow, cycle detection, error code coverage). The principle: configuration validity is CFG-01's concern; canonical model integrity is PRV-02's concern. Anything the analyst could have fixed in the workbook belongs in CFG-01. Anything that's a bug in the algorithm itself belongs in PRV-02's self-checks.

**What this spec defers vs. locks down.**

| Locked | Deferred |
|---|---|
| Substage ordering and mechanism | Path zero-pad width |
| Algorithm structure and entity build order | Idempotency mechanism (correlation_id propagation) |
| UUID minting policy (uuid4) | Display-label source long-term |
| Slot pool algorithm (first-fit per type, position order) | Type-specific overflow ownership (CFG-01 vs PRV-02) |
| Failure mode → error type mapping | Cycle detection responsibility |
| Cross-collection self-checks (5 checks, hard-fail) | Workato-level retry policy |

The deferred items don't block build; they need decisions before the system is in stable production use, but the build can proceed against the locked decisions and circle back.