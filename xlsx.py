"""
R-2b Step 8 — Transform parsed config for hydration

Workato py_eval action. Takes the SDC Platform Connector's parse_config_file
output and produces table-ready record arrays with:
  - Generated UUIDs for all business PKs
  - Resolved FK references (field_name → field_id, variant_name → variant_id)
  - Flattened variant-field junction rows

Records use LOGICAL column names (field_id, rule_id, etc.), not Workato field
UUIDs. The batch insert steps in the recipe handle the logical → UUID mapping
via their parameters block (wired in the Workato UI).

Inputs (via params):
  - parsed_config_json   : JSON string — full output from parse_config_file
  - template_version_id  : string — UUID for the new VER_TemplateVersion row

Outputs (all arrays of objects with logical keys):
  - cfg_fields            : CFG_Field records
  - cfg_rules             : CFG_Rule records
  - cfg_lookups           : CFG_Lookup records
  - cfg_variants          : CFG_Variant records
  - cfg_variant_fields    : CFG_VariantField records
  - cfg_error_translations: CFG_ErrorTranslation records
  - has_variants          : "true" or "false"
"""

import json
import uuid as uuid_lib


def main(params):
    parsed = json.loads(params["parsed_config_json"])
    tv_id = params["template_version_id"]

    def gen_id():
        return str(uuid_lib.uuid4())

    # ── Phase 1: CFG_Field ────────────────────────────────────────────
    # Generate field_id UUIDs and build name → id map for FK resolution.

    field_name_to_id = {}
    cfg_fields = []

    for idx, f in enumerate(parsed.get("fields", [])):
        fid = gen_id()
        field_name_to_id[f["field_name"]] = fid

        cfg_fields.append({
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
            "depends_on":               None,
            "field_length_validation":  f.get("field_length_validation"),
            "numeric_field_validation": f.get("numeric_field_validation"),
            "date_field_validation":    f.get("date_field_validation"),
            "field_input_validation":   f.get("field_input_validation"),
            "strict":                   f.get("strict", False),
        })

    # ── Phase 2: Resolve depends_on FKs ──────────────────────────────

    for i, f in enumerate(parsed.get("fields", [])):
        dep_name = f.get("depends_on_field_name")
        if dep_name and dep_name in field_name_to_id:
            cfg_fields[i]["depends_on"] = field_name_to_id[dep_name]

    # ── Phase 3: CFG_Rule ────────────────────────────────────────────

    cfg_rules = []

    for r in parsed.get("rules", []):
        target_name = r.get("target_field_name", "")
        cond_name = r.get("condition_field_name", "")

        cfg_rules.append({
            "rule_id":              gen_id(),
            "template_version_id":  tv_id,
            "field_id":             field_name_to_id.get(target_name),
            "target_field":         target_name,
            "rule":                 r.get("rule"),
            "condition_field":      cond_name,
            "condition_field_id":   field_name_to_id.get(cond_name),
            "conditional_value":    r.get("conditional_value"),
            "error_message":        r.get("error_message"),
            "error_message_custom": r.get("error_message_custom"),
            "strict_enforcement":   r.get("strict_enforcement", True),
        })

    # ── Phase 4: CFG_Lookup ──────────────────────────────────────────

    cfg_lookups = []

    for l in parsed.get("lookups", []):
        cfg_lookups.append({
            "lookup_field_id":     gen_id(),
            "template_version_id": tv_id,
            "lookup_name":         l.get("lookup_name"),
            "valid_values":        l.get("valid_values"),
            "display_label":       l.get("display_label"),
            "parent_value":        l.get("parent_value"),
            "project_specific":    l.get("project_specific", False),
        })

    # ── Phase 5: CFG_Variant + CFG_VariantField ──────────────────────

    variant_name_to_id = {}
    cfg_variants = []
    cfg_variant_fields = []

    for v in parsed.get("variants", []):
        vid = gen_id()
        variant_name_to_id[v.get("variant_name")] = vid

        cfg_variants.append({
            "variant_id":          vid,
            "template_version_id": tv_id,
            "variant_name":        v.get("variant_name"),
            "description":         v.get("description"),
        })

        for field_name in v.get("visible_field_names", []):
            fid = field_name_to_id.get(field_name)
            if fid:
                cfg_variant_fields.append({
                    "variant_field_id": gen_id(),
                    "variant_id":       vid,
                    "field_id":         fid,
                })

    # ── Phase 6: CFG_ErrorTranslation ────────────────────────────────

    cfg_error_translations = []

    for e in parsed.get("error_translations", []):
        cfg_error_translations.append({
            "error_translation_id":   gen_id(),
            "template_version_id":    tv_id,
            "error_code":             e.get("error_code"),
            "human_readable_message": e.get("human_readable_message"),
            "required_placeholders":  e.get("required_placeholders", ""),
        })

    # ── Output ───────────────────────────────────────────────────────

    return {
        "cfg_fields":             cfg_fields,
        "cfg_rules":              cfg_rules,
        "cfg_lookups":            cfg_lookups,
        "cfg_variants":           cfg_variants,
        "cfg_variant_fields":     cfg_variant_fields,
        "cfg_error_translations": cfg_error_translations,
        "has_variants":           str(len(cfg_variants) > 0).lower(),
    }
