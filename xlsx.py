"""
R-2b Step 15 — Remap parsed config to field-UUID-keyed records

Workato py_eval action. Takes the SDC Platform Connector's parse_config_file
output (logical field names) and table_results_map (field name → field UUID)
and produces API-ready record arrays for batch insert into each CFG table.

Inputs (via params):
  - parsed_config_json : JSON string — Action 1 output from parse_config_file
  - table_results_map  : JSON string — { table_name: { table_id, fields: { col_name: field_uuid } } }
  - template_version_id: string — UUID for the new VER_TemplateVersion

Outputs:
  - cfg_field_records         : JSON string — array of records for CFG_Field
  - cfg_rule_records          : JSON string — array of records for CFG_Rule
  - cfg_lookup_records        : JSON string — array of records for CFG_Lookup
  - cfg_variant_records       : JSON string — array of records for CFG_Variant
  - cfg_variant_field_records : JSON string — array of records for CFG_VariantField
  - cfg_error_records         : JSON string — array of records for CFG_ErrorTranslation
  - has_variants              : "true" or "false"
"""

import json
import uuid as uuid_lib


def main(params):
    parsed = json.loads(params["parsed_config_json"])
    trm = json.loads(params["table_results_map"])
    tv_id = params["template_version_id"]

    # ── Helpers ───────────────────────────────────────────────────────

    def gen_id():
        return str(uuid_lib.uuid4())

    def remap(table_name, record):
        """
        Remap a single record from logical column names to field UUIDs.
        Keys not found in the field map are silently dropped — this is
        intentional. The connector output may include working keys
        (like _index or field names used for FK resolution) that don't
        map to Data Table columns.
        """
        field_map = trm[table_name]["fields"]
        row = {}
        for col_name, value in record.items():
            if col_name in field_map:
                row[field_map[col_name]] = value
        return row

    # ── Phase 1: Generate business PKs and build cross-reference maps ─

    # CFG_Field: generate field_id, build name → id lookup for FK resolution
    field_name_to_id = {}
    fields_out = []

    for idx, f in enumerate(parsed.get("fields", [])):
        fid = gen_id()
        field_name_to_id[f["field_name"]] = fid

        fields_out.append({
            "field_id":                 fid,
            "template_version_id":      tv_id,
            "field_name":               f.get("field_name"),
            "description":              f.get("description"),
            "data_type":                f.get("data_type"),
            "data_format":              f.get("data_format"),
            "required":                 f.get("required", False),
            "must_be_empty":            f.get("must_be_empty", False),
            "column_unique":            f.get("column_unique", False),
            "data_cleaning_flags":      f.get("data_cleaning_flags"),
            "position":                 idx,
            "lookup_name":              f.get("lookup_name"),
            "depends_on":               None,  # resolved in Phase 2
            "field_length_validation":  f.get("field_length_validation"),
            "numeric_field_validation": f.get("numeric_field_validation"),
            "date_field_validation":    f.get("date_field_validation"),
            "field_input_validation":   f.get("field_input_validation"),
            "strict":                   f.get("strict", False),
            # Keep logical name for FK resolution (dropped by remap)
            "_depends_on_field_name":   f.get("depends_on_field_name"),
        })

    # ── Phase 2: Resolve depends_on FKs ──────────────────────────────

    for f in fields_out:
        dep_name = f.pop("_depends_on_field_name", None)
        if dep_name and dep_name in field_name_to_id:
            f["depends_on"] = field_name_to_id[dep_name]

    # ── Phase 3: CFG_Rule — generate rule_id, resolve field FKs ──────

    rules_out = []

    for r in parsed.get("rules", []):
        rid = gen_id()

        # Resolve target field
        target_name = r.get("target_field_name", "")
        target_fid = field_name_to_id.get(target_name)

        # Resolve condition field
        cond_name = r.get("condition_field_name", "")
        cond_fid = field_name_to_id.get(cond_name)

        rules_out.append({
            "rule_id":              rid,
            "template_version_id":  tv_id,
            "field_id":             target_fid,
            "target_field":         target_name,
            "rule":                 r.get("rule"),
            "condition_field":      cond_name,
            "condition_field_id":   cond_fid,
            "conditional_value":    r.get("conditional_value"),
            "error_message":        r.get("error_message"),
            "error_message_custom": r.get("error_message_custom"),
            "strict_enforcement":   r.get("strict_enforcement", True),
        })

    # ── Phase 4: CFG_Lookup — generate lookup_field_id ────────────────

    lookups_out = []

    for l in parsed.get("lookups", []):
        lookups_out.append({
            "lookup_field_id":     gen_id(),
            "template_version_id": tv_id,
            "lookup_name":         l.get("lookup_name"),
            "valid_values":        l.get("valid_values"),
            "display_label":       l.get("display_label"),
            "parent_value":        l.get("parent_value"),
            "project_specific":    l.get("project_specific", False),
        })

    # ── Phase 5: CFG_Variant + CFG_VariantField ──────────────────────
    # The connector returns variants as:
    #   [{ variant_name, visible_field_names: [field_name, ...] }]
    # We need to explode into:
    #   CFG_Variant:      one row per variant
    #   CFG_VariantField: one row per (variant, visible_field) pair

    variants_out = []
    variant_fields_out = []

    for v in parsed.get("variants", []):
        vid = gen_id()

        variants_out.append({
            "variant_id":           vid,
            "template_version_id":  tv_id,
            "variant_name":         v.get("variant_name"),
            "description":          v.get("description"),
        })

        for field_name in v.get("visible_field_names", []):
            fid = field_name_to_id.get(field_name)
            if fid:
                variant_fields_out.append({
                    "variant_field_id": gen_id(),
                    "variant_id":       vid,
                    "field_id":         fid,
                })

    # ── Phase 6: CFG_ErrorTranslation ────────────────────────────────

    errors_out = []

    for e in parsed.get("error_translations", []):
        errors_out.append({
            "error_translation_id":  gen_id(),
            "template_version_id":   tv_id,
            "error_code":            e.get("error_code"),
            "human_readable_message": e.get("human_readable_message"),
            "required_placeholders": e.get("required_placeholders", ""),
        })

    # ── Phase 7: Remap all records to field-UUID keys ────────────────
    # After this step, each record dict has field UUIDs as keys,
    # ready for the Data Tables API batch_create_records action.

    cfg_field_records = [remap("CFG_Field", r) for r in fields_out]
    cfg_rule_records = [remap("CFG_Rule", r) for r in rules_out]
    cfg_lookup_records = [remap("CFG_Lookup", r) for r in lookups_out]
    cfg_variant_records = [remap("CFG_Variant", r) for r in variants_out]
    cfg_variant_field_records = [remap("CFG_VariantField", r) for r in variant_fields_out]
    cfg_error_records = [remap("CFG_ErrorTranslation", r) for r in errors_out]

    # ── Output ───────────────────────────────────────────────────────

    return {
        "cfg_field_records":         json.dumps(cfg_field_records),
        "cfg_rule_records":          json.dumps(cfg_rule_records),
        "cfg_lookup_records":        json.dumps(cfg_lookup_records),
        "cfg_variant_records":       json.dumps(cfg_variant_records),
        "cfg_variant_field_records": json.dumps(cfg_variant_field_records),
        "cfg_error_records":         json.dumps(cfg_error_records),
        "has_variants":              str(len(variants_out) > 0).lower(),
    }
