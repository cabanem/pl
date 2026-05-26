"""Hand-written canonical models for local TPL-02 testing. No provisioning needed.
Each is the SAME shape CAN-01 emits (verified against the builder's contract).
Edit these freely to test new config shapes."""

# A realistic config: many fields, flat + dependent lookups, a variant.
REALISTIC = {
    "cfg_fields": [
        {"field_id": "f_name",   "field_name": "Worker Name",   "position": 1, "data_type": "text",   "required": True},
        {"field_id": "f_country","field_name": "Country",       "position": 2, "data_type": "text",   "required": True,  "lookup_name": "Country"},
        {"field_id": "f_region", "field_name": "Region",        "position": 3, "data_type": "text",   "required": False, "lookup_name": "Region", "cascade_parent_field_id": "f_country"},
        {"field_id": "f_rate",   "field_name": "Bill Rate",     "position": 4, "data_type": "number", "required": True,  "data_format": {"min": 0, "max": 500, "integer": False}},
        {"field_id": "f_start",  "field_name": "Start Date",    "position": 5, "data_type": "date",   "required": False},
        {"field_id": "f_notes",  "field_name": "Notes",         "position": 6, "data_type": "text",   "required": False, "data_format": {"max_length": 200}},
        {"field_id": "f_dept",   "field_name": "Department",    "position": 7, "data_type": "text",   "required": False, "lookup_name": "Department"},
    ],
    "cfg_variant_fields": [
        # variant 'short' = first four fields only
        {"variant_id": "v_short", "field_id": "f_name"},
        {"variant_id": "v_short", "field_id": "f_country"},
        {"variant_id": "v_short", "field_id": "f_region"},
        {"variant_id": "v_short", "field_id": "f_rate"},
    ],
    "cfg_lookups": [
        {"lookup_name": "Country", "valid_value": "USA"},
        {"lookup_name": "Country", "valid_value": "Canada"},
        {"lookup_name": "Region",  "valid_value": "California", "parent_value": "USA"},
        {"lookup_name": "Region",  "valid_value": "Texas",      "parent_value": "USA"},
        {"lookup_name": "Region",  "valid_value": "Ontario",    "parent_value": "Canada"},
        {"lookup_name": "Department", "valid_value": "Engineering"},
        {"lookup_name": "Department", "valid_value": "Finance"},
    ],
    "cfg_rules": [], "cfg_variants": [], "cfg_variant_fields_extra": [],
    "cfg_form_slot_mappings": [], "cfg_error_messages": [],
}

# T1 trap: parent values that differ only by punctuation -> sanitized collision.
COLLISION = {
    "cfg_fields": [
        {"field_id": "f_grp", "field_name": "Group", "position": 1, "data_type": "text", "required": True, "lookup_name": "Group"},
        {"field_id": "f_sub", "field_name": "Sub",   "position": 2, "data_type": "text", "required": False, "lookup_name": "Sub", "cascade_parent_field_id": "f_grp"},
    ],
    "cfg_variant_fields": [],
    "cfg_lookups": [
        {"lookup_name": "Group", "valid_value": "North America"},
        {"lookup_name": "Group", "valid_value": "North-America"},
        {"lookup_name": "Sub", "valid_value": "East", "parent_value": "North America"},
        {"lookup_name": "Sub", "valid_value": "West", "parent_value": "North-America"},
    ],
    "cfg_rules": [], "cfg_variants": [], "cfg_form_slot_mappings": [], "cfg_error_messages": [],
}

# T2 trap: unbounded number + unbounded date (no min/max).
UNBOUNDED = {
    "cfg_fields": [
        {"field_id": "f_id",  "field_name": "ID",     "position": 1, "data_type": "text",   "required": True},
        {"field_id": "f_amt", "field_name": "Amount", "position": 2, "data_type": "number", "required": False},
        {"field_id": "f_dt",  "field_name": "When",   "position": 3, "data_type": "date",   "required": False},
    ],
    "cfg_variant_fields": [], "cfg_lookups": [],
    "cfg_rules": [], "cfg_variants": [], "cfg_form_slot_mappings": [], "cfg_error_messages": [],
}

MODELS = {"realistic": REALISTIC, "collision": COLLISION, "unbounded": UNBOUNDED}
