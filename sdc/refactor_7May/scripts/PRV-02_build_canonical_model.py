"""
PRV-02 Substage 8 — Build Canonical Model
==========================================

Workato py_eval step. Transforms the connector's parsed_config_json output
into the canonical model artifact that downstream recipes (PRV-03, PRV-04,
VAL-01, TPL-01) read from.

This step is the substantive piece of PRV-02: it mints UUIDs for every
entity, resolves all name-based FK references into ID-based ones, assigns
form fields to slot-pool positions, and self-checks the result before
returning. The output is a serialized JSON string (canonical_model_json)
that the next substage writes to FileStorage at
/templates/v<NNN>/canonical_model.json.

The structured arrays are also emitted as pills for diagnostic visibility
and for any direct-handoff test paths that don't go through FileStorage.
The authoritative artifact is the serialized JSON; the pills are
convenience.

Input schema (Workato py_eval input):
-------------------------------------
parsed_config_json    string    The connector's parse_config_file serialized
                                output. Contains: customer, fields, rules,
                                lookups, variants, suppliers, users,
                                error_translations, parse_summary.
template_version_id   string    UUID. Created in PRV-02 substage 3
                                (CFG_TemplateVersion create).
version_number        integer   The CFG_TemplateVersion.version_number.
project_id            string    UUID. The Project.project_id.
expected_sheet_name   string    Default "Data". The sheet name TPL-01
                                produces and VAL-01 reads.

Output schema (Workato py_eval output):
---------------------------------------
canonical_model_json  string    Serialized JSON. The authoritative artifact.
                                Written to FileStorage in next substage.
cfg_fields            array of object   Structured pills (for diagnostics).
cfg_lookups           array of object
cfg_rules             array of object
cfg_variants          array of object
cfg_variant_fields    array of object
cfg_form_slot_mappings array of object
cfg_error_messages    array of object
meta                  object    The _meta header.
summary               object    Counts and slot-pool usage. Useful for
                                emitting config_parsed details_json with
                                better info than the parse_summary alone.

Failure modes:
--------------
On any unresolved FK or slot-pool collision, raises ValueError with a
descriptive message. PRV-02's error handler catches this and emits
recipe_failed with error_type=unexpected_error. The version row stays in
draft with gas_export_path and parsed_config_path set, canonical_model_path
null — a queryable "canonical model build failed" audit artifact.

Per the canonical model shape spec, CFG-01 has already validated config
shape and FK resolvability before PRV-02 reaches this step. So unresolved
FKs here indicate either (a) a parser bug that produced an internally
inconsistent parsed_config, or (b) a bug in this Python step. Both warrant
unexpected_error rather than config_invalid.
"""

import json
import uuid
from datetime import datetime, timezone


# ──────────────────────────────────────────────────────────────────────────
# Slot pool layout
# ──────────────────────────────────────────────────────────────────────────
# 20 slot columns on SUP_SupplierRequest, grouped by type. Fields are
# assigned to the first available slot whose type matches. If the pool for
# a given type is exhausted, the field doesn't get a form_slot_mapping and
# is silently dropped from the form (its data is still validatable via the
# template / upload path; only manual-entry visibility is affected).

SLOT_POOL = {
    "text":     ["slot_text_01", "slot_text_02", "slot_text_03", "slot_text_04",
                 "slot_text_05", "slot_text_06", "slot_text_07", "slot_text_08"],
    "num":      ["slot_num_01", "slot_num_02"],
    "bool":     ["slot_bool_01", "slot_bool_02"],
    "sel":      ["slot_sel_01", "slot_sel_02", "slot_sel_03", "slot_sel_04"],
    "date":     ["slot_date_01", "slot_date_02", "slot_date_03", "slot_date_04"],
}

# Map from canonical-model control_type to slot-pool key.
# control_type values per canonical model shape spec section cfg_fields:
#   text | number | dropdown | dependent_select | date | checkbox | email | currency
CONTROL_TYPE_TO_SLOT_TYPE = {
    "text":             "text",
    "email":            "text",
    "currency":         "text",
    "number":           "num",
    "checkbox":         "bool",
    "dropdown":         "sel",
    "dependent_select": "sel",
    "date":             "date",
}


def main(input):
    # ──────────────────────────────────────────────────────────────────
    # Parse inputs
    # ──────────────────────────────────────────────────────────────────
    parsed_raw = input.get("parsed_config_json")
    if not parsed_raw:
        raise ValueError("parsed_config_json input is empty or missing")

    parsed = json.loads(parsed_raw) if isinstance(parsed_raw, str) else parsed_raw

    template_version_id = input["template_version_id"]
    version_number      = input["version_number"]
    project_id          = input["project_id"]
    expected_sheet_name = input.get("expected_sheet_name") or "Data"

    parsed_fields              = parsed.get("fields", [])
    parsed_rules               = parsed.get("rules", [])
    parsed_lookups             = parsed.get("lookups", [])
    parsed_variants            = parsed.get("variants", [])
    parsed_error_translations  = parsed.get("error_translations", [])

    built_at = datetime.now(timezone.utc).isoformat()

    # ──────────────────────────────────────────────────────────────────
    # Phase 1 — Build cfg_fields
    # ──────────────────────────────────────────────────────────────────
    # Mint a UUID per field. Build field_name_to_id map as we go; we use
    # it to resolve depends_on_field_name in the same loop (only if the
    # target appeared earlier — otherwise we fix it up in a second pass).

    cfg_fields = []
    field_name_to_id = {}

    for f in parsed_fields:
        fid = str(uuid.uuid4())
        field_name = f.get("field_name")
        field_name_to_id[field_name] = fid

        cfg_fields.append({
            "field_id":                  fid,
            "field_name":                field_name,
            "description":               f.get("description"),
            "data_type":                 f.get("data_type"),
            "data_format":               f.get("data_format"),
            "position":                  f.get("position"),
            "required":                  bool(f.get("required", False)),
            "must_be_empty":             bool(f.get("must_be_empty", False)),
            "column_unique":             bool(f.get("column_unique", False)),
            "strict":                    bool(f.get("strict", False)),
            "visible":                   bool(f.get("visible", True)),
            "field_length_validation":   f.get("field_length_validation"),
            "numeric_field_validation":  f.get("numeric_field_validation"),
            "date_field_validation":     f.get("date_field_validation"),
            "field_input_validation":    f.get("field_input_validation"),
            "data_cleaning_flags":       f.get("data_cleaning_flags"),
            "lookup_name":               f.get("lookup_name"),
            "depends_on_field_id":       None,  # resolved in phase 1b
            "control_type":              f.get("control_type"),
        })

    # Phase 1b — resolve depends_on_field_id from depends_on_field_name.
    # Done in a second pass so forward references (where the parent field
    # appears later in the position order) resolve correctly.
    for f_record, f_source in zip(cfg_fields, parsed_fields):
        depends_on_name = f_source.get("depends_on_field_name") or f_source.get("depends_on")
        if depends_on_name:
            resolved = field_name_to_id.get(depends_on_name)
            if resolved is None:
                raise ValueError(
                    f"Field '{f_record['field_name']}' depends_on '{depends_on_name}' "
                    f"but no field with that name exists. CFG-01 should have caught this."
                )
            f_record["depends_on_field_id"] = resolved

    # ──────────────────────────────────────────────────────────────────
    # Phase 2 — Build cfg_lookups
    # ──────────────────────────────────────────────────────────────────
    # No UUIDs minted; lookups are name-keyed. Pass-through from parser.

    cfg_lookups = []
    for l in parsed_lookups:
        cfg_lookups.append({
            "lookup_name":      l.get("lookup_name"),
            "valid_value":      l.get("valid_value"),
            "display_label":    l.get("display_label"),
            "parent_value":     l.get("parent_value"),
            "project_specific": bool(l.get("project_specific", False)),
        })

    # ──────────────────────────────────────────────────────────────────
    # Phase 3 — Build cfg_rules
    # ──────────────────────────────────────────────────────────────────
    # Resolve target_field_name → field_id; condition_field_name → field_id.

    cfg_rules = []
    for r in parsed_rules:
        target_name = r.get("target_field_name") or r.get("target_field")
        cond_name   = r.get("condition_field_name") or r.get("condition_field")

        target_id = field_name_to_id.get(target_name) if target_name else None
        if target_name and target_id is None:
            raise ValueError(
                f"Rule references target_field_name '{target_name}' "
                f"but no field with that name exists."
            )

        cond_id = field_name_to_id.get(cond_name) if cond_name else None
        if cond_name and cond_id is None:
            raise ValueError(
                f"Rule references condition_field_name '{cond_name}' "
                f"but no field with that name exists."
            )

        cfg_rules.append({
            "rule_id":              str(uuid.uuid4()),
            "field_id":             target_id,
            "rule":                 r.get("rule"),
            "condition_field_id":   cond_id,
            "conditional_value":    r.get("conditional_value"),
            "error_message":        r.get("error_message"),
            "error_message_custom": r.get("error_message_custom"),
            "strict_enforcement":   bool(r.get("strict_enforcement", False)),
            "scope":                r.get("scope") or "submission",
            "target_field_name":    target_name,
            "condition_field_name": cond_name,
        })

    # ──────────────────────────────────────────────────────────────────
    # Phase 4 — Build cfg_variants and cfg_variant_fields
    # ──────────────────────────────────────────────────────────────────
    # Variants get UUIDs minted. variant_fields are emitted as the variant
    # is built — flattened from the parser's nested `visible_field_names`.

    cfg_variants = []
    cfg_variant_fields = []
    variant_name_to_id = {}

    for v in parsed_variants:
        vid = str(uuid.uuid4())
        variant_name = v.get("variant_name")
        variant_name_to_id[variant_name] = vid

        cfg_variants.append({
            "variant_id":     vid,
            "variant_name":   variant_name,
            "description":    v.get("description"),
            "is_synthesized": bool(v.get("is_synthesized", False)),
        })

        for field_name in v.get("visible_field_names", []):
            fid = field_name_to_id.get(field_name)
            if fid is None:
                raise ValueError(
                    f"Variant '{variant_name}' references field '{field_name}' "
                    f"but no field with that name exists."
                )
            cfg_variant_fields.append({
                "variant_id": vid,
                "field_id":   fid,
            })

    # ──────────────────────────────────────────────────────────────────
    # Phase 5 — Build cfg_form_slot_mappings (slot pool assignment)
    # ──────────────────────────────────────────────────────────────────
    # Iterate visible fields in position order. For each, look up the slot
    # type from control_type. Take the first available slot in that pool;
    # if the pool is exhausted, skip the field (track in summary).

    cfg_form_slot_mappings = []
    slot_pool_cursor = {slot_type: 0 for slot_type in SLOT_POOL.keys()}
    fields_without_slots = []  # diagnostic — visible fields that didn't fit

    # Order visible fields by their template position. Slot-pool position
    # mirrors template position by default (per the canonical model shape
    # spec); divergence is a future possibility but not implemented here.
    visible_fields_sorted = sorted(
        [f for f in cfg_fields if f["visible"]],
        key=lambda f: (f["position"] if f["position"] is not None else 9999, f["field_name"])
    )

    form_position = 0
    for f in visible_fields_sorted:
        ctype = f["control_type"]
        slot_type = CONTROL_TYPE_TO_SLOT_TYPE.get(ctype)
        if slot_type is None:
            # Unrecognized control_type — flag but don't crash; this is a
            # data-quality issue the parser should not produce.
            fields_without_slots.append({
                "field_name":   f["field_name"],
                "control_type": ctype,
                "reason":       "unrecognized control_type",
            })
            continue

        cursor = slot_pool_cursor[slot_type]
        pool = SLOT_POOL[slot_type]

        if cursor >= len(pool):
            fields_without_slots.append({
                "field_name":   f["field_name"],
                "control_type": ctype,
                "reason":       f"{slot_type} slot pool exhausted "
                                f"({len(pool)} slots available)",
            })
            continue

        slot_name = pool[cursor]
        slot_pool_cursor[slot_type] = cursor + 1

        cfg_form_slot_mappings.append({
            "form_slot_id":  str(uuid.uuid4()),
            "field_id":      f["field_id"],
            "slot_name":     slot_name,
            "display_label": f["field_name"],
            "control_type":  ctype,
            "required":      f["required"],
            "lookup_name":   f["lookup_name"],  # required when dropdown/dependent_select
            "position":      form_position,
        })
        form_position += 1

    # ──────────────────────────────────────────────────────────────────
    # Phase 6 — Build cfg_error_messages
    # ──────────────────────────────────────────────────────────────────
    # UUIDs minted; pass-through from parser.

    cfg_error_messages = []
    for e in parsed_error_translations:
        cfg_error_messages.append({
            "error_translation_id":  str(uuid.uuid4()),
            "error_code":            e.get("error_code"),
            "human_readable_message": e.get("human_readable_message"),
            "required_placeholders": e.get("required_placeholders"),
        })

    # ──────────────────────────────────────────────────────────────────
    # Phase 7 — Self-check
    # ──────────────────────────────────────────────────────────────────
    # Verify the canonical model is internally consistent before returning.
    # CFG-01 has validated the parsed config; this verifies we built a
    # well-formed canonical model from it.

    field_ids_set = {f["field_id"] for f in cfg_fields}
    variant_ids_set = {v["variant_id"] for v in cfg_variants}
    lookup_names_set = {l["lookup_name"] for l in cfg_lookups}

    # Invariant 1: FK resolution complete on rules.
    for r in cfg_rules:
        if r["field_id"] and r["field_id"] not in field_ids_set:
            raise ValueError(f"Rule {r['rule_id']} field_id unresolved: {r['field_id']}")
        if r["condition_field_id"] and r["condition_field_id"] not in field_ids_set:
            raise ValueError(
                f"Rule {r['rule_id']} condition_field_id unresolved: {r['condition_field_id']}"
            )

    # Invariant 1: FK resolution complete on variant_fields.
    for vf in cfg_variant_fields:
        if vf["variant_id"] not in variant_ids_set:
            raise ValueError(f"Variant_field references missing variant: {vf['variant_id']}")
        if vf["field_id"] not in field_ids_set:
            raise ValueError(f"Variant_field references missing field: {vf['field_id']}")

    # Invariant 1: FK resolution complete on form_slot_mappings.
    for fsm in cfg_form_slot_mappings:
        if fsm["field_id"] not in field_ids_set:
            raise ValueError(
                f"Form_slot_mapping {fsm['form_slot_id']} field_id unresolved: {fsm['field_id']}"
            )

    # Invariant 1: depends_on_field_id resolves.
    for f in cfg_fields:
        if f["depends_on_field_id"] and f["depends_on_field_id"] not in field_ids_set:
            raise ValueError(
                f"Field {f['field_id']} depends_on_field_id unresolved: "
                f"{f['depends_on_field_id']}"
            )

    # Invariant 2: lookup_name references resolve.
    for f in cfg_fields:
        if f["lookup_name"] and f["lookup_name"] not in lookup_names_set:
            raise ValueError(
                f"Field {f['field_name']} references lookup_name '{f['lookup_name']}' "
                f"but no lookup with that name exists."
            )
    for fsm in cfg_form_slot_mappings:
        if fsm["lookup_name"] and fsm["lookup_name"] not in lookup_names_set:
            raise ValueError(
                f"Form_slot_mapping {fsm['form_slot_id']} references "
                f"lookup_name '{fsm['lookup_name']}' but no lookup with that name exists."
            )

    # Invariant 4: slot pool assignment is unique.
    slot_names_used = [fsm["slot_name"] for fsm in cfg_form_slot_mappings]
    if len(slot_names_used) != len(set(slot_names_used)):
        raise ValueError(
            f"Slot pool collision detected. Slots assigned: {slot_names_used}"
        )

    # ──────────────────────────────────────────────────────────────────
    # Phase 8 — Build _meta and assemble canonical model
    # ──────────────────────────────────────────────────────────────────

    meta = {
        "template_version_id":  template_version_id,
        "version_number":       version_number,
        "project_id":           project_id,
        "expected_sheet_name":  expected_sheet_name,
        "built_at":             built_at,
        "built_by_recipe":      "PRV-02",
    }

    canonical_model = {
        "_meta":                  meta,
        "cfg_fields":             cfg_fields,
        "cfg_lookups":            cfg_lookups,
        "cfg_rules":              cfg_rules,
        "cfg_variants":           cfg_variants,
        "cfg_variant_fields":     cfg_variant_fields,
        "cfg_form_slot_mappings": cfg_form_slot_mappings,
        "cfg_error_messages":     cfg_error_messages,
    }

    # ──────────────────────────────────────────────────────────────────
    # Phase 9 — Build summary (diagnostic, emitted with config_parsed)
    # ──────────────────────────────────────────────────────────────────

    summary = {
        "field_count":              len(cfg_fields),
        "visible_field_count":      sum(1 for f in cfg_fields if f["visible"]),
        "rule_count":               len(cfg_rules),
        "lookup_value_count":       len(cfg_lookups),
        "unique_lookup_name_count": len(lookup_names_set),
        "variant_count":            len(cfg_variants),
        "variant_field_count":      len(cfg_variant_fields),
        "form_slot_count":          len(cfg_form_slot_mappings),
        "error_message_count":      len(cfg_error_messages),
        "slot_pool_usage": {
            slot_type: {
                "used":      slot_pool_cursor[slot_type],
                "available": len(SLOT_POOL[slot_type]),
            }
            for slot_type in SLOT_POOL.keys()
        },
        "fields_without_slots":     fields_without_slots,
    }

    # ──────────────────────────────────────────────────────────────────
    # Return
    # ──────────────────────────────────────────────────────────────────

    return {
        "canonical_model_json":   json.dumps(canonical_model, default=str),
        "cfg_fields":             cfg_fields,
        "cfg_lookups":            cfg_lookups,
        "cfg_rules":              cfg_rules,
        "cfg_variants":           cfg_variants,
        "cfg_variant_fields":     cfg_variant_fields,
        "cfg_form_slot_mappings": cfg_form_slot_mappings,
        "cfg_error_messages":     cfg_error_messages,
        "meta":                   meta,
        "summary":                summary,
    }
