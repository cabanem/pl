import json
import uuid


# -----------------------------------------------------------------------------
# CANONICAL MODEL HYDRATION — PARSE AND PREPARE
# Source of truth for shape: sdc-canonical-model-shape-v1.md
# Reads canonical_model.json content, validates that all seven expected
# collections are present, stamps template_version_id where required, and
# computes CFG_Variant.template_path per naming-doc invariant 10.
# Output is consumed by seven bulk-create Data Tables steps (#5 through #11).
# -----------------------------------------------------------------------------

EXPECTED_COLLECTIONS = (
    "cfg_fields",
    "cfg_lookups",
    "cfg_rules",
    "cfg_variants",
    "cfg_variant_fields",
    "cfg_form_slot_mappings",
    "cfg_error_messages",
)

# Empty-shaped payloads to return on the failure path so downstream schema
# stays satisfied even when we early-exit.
EMPTY_PAYLOAD = {
    "ok": False,
    "error": "",
    "cfg_fields": [],
    "cfg_lookups": [],
    "cfg_rules": [],
    "cfg_variants": [],
    "cfg_variant_fields": [],
    "cfg_form_slot_mappings": [],
    "cfg_error_messages": [],
    "expected_counts": {
        "cfg_field_count": 0,
        "cfg_lookup_count": 0,
        "cfg_rule_count": 0,
        "cfg_variant_count": 0,
        "cfg_variant_field_count": 0,
        "cfg_form_slot_mapping_count": 0,
        "cfg_error_message_count": 0,
    },
}


def _fail(reason):
    """Return an empty-shaped payload with ok=False and a reason string."""
    out = dict(EMPTY_PAYLOAD)
    # shallow copies for the nested dict; safe because we don't mutate further
    out["expected_counts"] = dict(EMPTY_PAYLOAD["expected_counts"])
    out["error"] = reason
    return out


def _s(value):
    """Coerce a value to a string for Data Tables. None -> empty string.
    Booleans and integers pass through to JSON serialization unchanged when
    we return them directly; this helper is only for fields the manifest
    declares as 'string'."""
    if value is None:
        return ""
    return str(value)


def _b(value):
    """Coerce a value to a boolean. Workato Data Tables stores booleans
    natively, so we return real bool. The canonical model shape doc lists
    every boolean field as 'always present', but we defensively default
    missing values to False rather than failing."""
    if value is None:
        return False
    return bool(value)


def _i(value):
    """Coerce a value to an integer. The canonical model shape doc declares
    'position' as 'always' present on cfg_fields and cfg_form_slot_mappings;
    a missing position is treated as 0 here rather than failing, on the
    theory that PRV-03 is a persistence step and shouldn't re-validate
    upstream contracts."""
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def main(input):
    canonical_model_json = input.get("canonical_model_json") or ""
    template_version_id = input.get("template_version_id") or ""

    if not canonical_model_json:
        return _fail("canonical_model_json is empty")
    if not template_version_id:
        return _fail("template_version_id is empty")

    # Parse JSON. A parse error here is a recipe_invariant — PRV-02 wrote
    # this file; if it's malformed, something is broken upstream.
    try:
        model = json.loads(canonical_model_json)
    except (ValueError, TypeError) as e:
        return _fail("canonical model not valid JSON: {}".format(str(e)))

    if not isinstance(model, dict):
        return _fail("canonical model root is not a JSON object")

    # Validate that all seven collections are present. Missing collection
    # is a recipe_invariant.
    missing = [c for c in EXPECTED_COLLECTIONS if c not in model]
    if missing:
        return _fail("missing collections: {}".format(", ".join(missing)))

    # Pull version_number from _meta for variant template path computation.
    meta = model.get("_meta") or {}
    version_number = meta.get("version_number")
    if version_number is None:
        return _fail("_meta.version_number is missing")
    try:
        version_number = int(version_number)
    except (TypeError, ValueError):
        return _fail("_meta.version_number is not an integer")

    # Build per-table row arrays. Each block stamps template_version_id where
    # the manifest schema requires it. cfg_variant_fields is the one
    # exception — no template_version_id column on that table.

    cfg_fields_rows = []
    for f in model["cfg_fields"]:
        cfg_fields_rows.append({
            "field_id": _s(f.get("field_id")),
            "template_version_id": template_version_id,
            "field_name": _s(f.get("field_name")),
            "description": _s(f.get("description")),
            "data_type": _s(f.get("data_type")),
            "data_format": _s(f.get("data_format")),
            "position": _i(f.get("position")),
            "required": _b(f.get("required")),
            "must_be_empty": _b(f.get("must_be_empty")),
            "column_unique": _b(f.get("column_unique")),
            "strict": _b(f.get("strict")),
            "visible": _b(f.get("visible")),
            "field_length_validation": _s(f.get("field_length_validation")),
            "numeric_field_validation": _s(f.get("numeric_field_validation")),
            "date_field_validation": _s(f.get("date_field_validation")),
            "field_input_validation": _s(f.get("field_input_validation")),
            "data_cleaning_flags": _s(f.get("data_cleaning_flags")),
            "lookup_name": _s(f.get("lookup_name")),
            # canonical model field is depends_on_field_id; manifest column is depends_on
            "depends_on": _s(f.get("depends_on_field_id")),
            "control_type": _s(f.get("control_type")),
        })

    cfg_lookups_rows = []
    for lk in model["cfg_lookups"]:
        # The canonical model shape doc does NOT mint a lookup_id; the lookup
        # is identified by (lookup_name, valid_value). The manifest schema
        # for CFG_Lookup DOES require a lookup_id PK. Mint one here per row.
        cfg_lookups_rows.append({
            "lookup_id": str(uuid.uuid4()),
            "template_version_id": template_version_id,
            "lookup_name": _s(lk.get("lookup_name")),
            "valid_value": _s(lk.get("valid_value")),
            "parent_value": _s(lk.get("parent_value")),
            "project_specific": _b(lk.get("project_specific")),
            # display_label is on the canonical model shape but NOT on the
            # manifest's CFG_Lookup table — dropped here. If it turns out
            # downstream needs it, the manifest needs a column added first.
        })

    cfg_rules_rows = []
    for r in model["cfg_rules"]:
        cfg_rules_rows.append({
            "rule_id": _s(r.get("rule_id")),
            "template_version_id": template_version_id,
            "field_id": _s(r.get("field_id")),
            "rule": _s(r.get("rule")),
            "condition_field_id": _s(r.get("condition_field_id")),
            "conditional_value": _s(r.get("conditional_value")),
            "error_message": _s(r.get("error_message")),
            "error_message_custom": _s(r.get("error_message_custom")),
            "strict_enforcement": _b(r.get("strict_enforcement")),
            "scope": _s(r.get("scope")) or "submission",
            # Manifest columns target_field / condition_field carry the
            # denormalized display names. Canonical model shape uses
            # *_field_name suffixes.
            "target_field": _s(r.get("target_field_name")),
            "condition_field": _s(r.get("condition_field_name")),
        })

    cfg_variants_rows = []
    for v in model["cfg_variants"]:
        variant_id = _s(v.get("variant_id"))
        # Path computation: naming-doc invariant 10. Computed once here,
        # never recomputed at read time. PRV-04 writes the variant XLSX
        # at this exact path.
        template_path = "/templates/v{}/variants/{}.xlsx".format(
            version_number, variant_id
        )
        cfg_variants_rows.append({
            "variant_id": variant_id,
            "template_version_id": template_version_id,
            "variant_name": _s(v.get("variant_name")),
            "description": _s(v.get("description")),
            "template_path": template_path,
            # is_synthesized is on the canonical model shape but NOT on the
            # manifest's CFG_Variant table — dropped here.
        })

    cfg_variant_fields_rows = []
    for vf in model["cfg_variant_fields"]:
        # The canonical model shape doc does NOT mint a variant_field_id;
        # the join is identified by (variant_id, field_id). The manifest
        # schema for CFG_VariantField DOES require a variant_field_id PK.
        # Mint one here per row.
        # NOTE: no template_version_id column on this table.
        cfg_variant_fields_rows.append({
            "variant_field_id": str(uuid.uuid4()),
            "variant_id": _s(vf.get("variant_id")),
            "field_id": _s(vf.get("field_id")),
        })

    cfg_form_slot_mappings_rows = []
    for fsm in model["cfg_form_slot_mappings"]:
        cfg_form_slot_mappings_rows.append({
            "form_slot_id": _s(fsm.get("form_slot_id")),
            "template_version_id": template_version_id,
            "field_id": _s(fsm.get("field_id")),
            "slot_name": _s(fsm.get("slot_name")),
            "display_label": _s(fsm.get("display_label")),
            "control_type": _s(fsm.get("control_type")),
            "required": _b(fsm.get("required")),
            "lookup_name": _s(fsm.get("lookup_name")),
            "position": _i(fsm.get("position")),
        })

    cfg_error_messages_rows = []
    for em in model["cfg_error_messages"]:
        cfg_error_messages_rows.append({
            "error_translation_id": _s(em.get("error_translation_id")),
            "template_version_id": template_version_id,
            "error_code": _s(em.get("error_code")),
            "human_readable_message": _s(em.get("human_readable_message")),
            "required_placeholders": _s(em.get("required_placeholders")),
        })

    # Expected counts are the lengths of the source-of-truth arrays.
    # The hydration validation step compares these to the actual row counts
    # returned by the Data Tables bulk-create calls.
    expected_counts = {
        "cfg_field_count": len(cfg_fields_rows),
        "cfg_lookup_count": len(cfg_lookups_rows),
        "cfg_rule_count": len(cfg_rules_rows),
        "cfg_variant_count": len(cfg_variants_rows),
        "cfg_variant_field_count": len(cfg_variant_fields_rows),
        "cfg_form_slot_mapping_count": len(cfg_form_slot_mappings_rows),
        "cfg_error_message_count": len(cfg_error_messages_rows),
    }

    return {
        "ok": True,
        "error": "",
        "cfg_fields": cfg_fields_rows,
        "cfg_lookups": cfg_lookups_rows,
        "cfg_rules": cfg_rules_rows,
        "cfg_variants": cfg_variants_rows,
        "cfg_variant_fields": cfg_variant_fields_rows,
        "cfg_form_slot_mappings": cfg_form_slot_mappings_rows,
        "cfg_error_messages": cfg_error_messages_rows,
        "expected_counts": expected_counts,
    }
