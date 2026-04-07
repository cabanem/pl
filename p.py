import uuid
import json


def main(input):
    raw_config = input.get("parsed_config", "{}")
    try:
        config = json.loads(raw_config)
    except json.JSONDecodeError:
        config = {}

    suppliers = config.get("suppliers", [])
    users     = config.get("users", [])
    variants  = input.get("variants", [])

    project_id = input.get("template_project_id")
    version_id = input.get("template_version_id")
    corr_id    = input.get("correlation_id")
    analyst    = input.get("analyst_email")

    # Form slot metadata
    form_slots = json.loads(input.get("form_slots_json", "[]"))

    # Build variant lookup: name -> variant_id
    variant_map = {
        v.get("variant_name"): v.get("variant_id")
        for v in variants
    }

    # Build first-user lookup: supplier_name -> first user's email
    first_user = {}
    for u in users:
        name = u.get("supplier_name")
        if name and name not in first_user:
            first_user[name] = u.get("supplier_user_email")

    # ── Build slot label columns (same for all suppliers) ────
    slot_columns = {}

    # Initialize all 40 columns to None
    for i in range(1, 9):
        slot_columns[f"text_{i:02d}"] = None
        slot_columns[f"text_{i:02d}_label"] = None
    for i in range(1, 4):
        slot_columns[f"num_{i:02d}"] = None
        slot_columns[f"num_{i:02d}_label"] = None
        slot_columns[f"date_{i:02d}"] = None
        slot_columns[f"date_{i:02d}_label"] = None
    for i in range(1, 5):
        slot_columns[f"sel_{i:02d}"] = None
        slot_columns[f"sel_{i:02d}_label"] = None
    for i in range(1, 3):
        slot_columns[f"chk_{i:02d}"] = None
        slot_columns[f"chk_{i:02d}_label"] = None

    # Stamp labels from slot assignments
    for s in form_slots:
        slot = s.get("slot_name")
        if slot:
            slot_columns[f"{slot}_label"] = s.get("field_name")

    # ── Build supplier request rows ──────────────────────────
    supplier_map = {}
    request_rows = []

    for s in suppliers:
        rid = str(uuid.uuid4())
        supplier_name = s.get("supplier_name")
        supplier_map[supplier_name] = rid

        request_rows.append({
            "supplier_request_id":  rid,
            "template_project_id":  project_id,
            "assigned_version_id":  version_id,
            "assigned_variant_id":  variant_map.get(s.get("template_variation")),
            "correlation_id":       corr_id,
            "supplier_name":        supplier_name,
            "contact_email":        first_user.get(supplier_name),
            "assignee_email":       analyst,
            "has_seeded_data":      bool(s.get("has_incumbent_data")),
            "seed_data_file_id":    s.get("location_of_incumbent_data"),
            "seed_data_range":      s.get("incumbent_data_range"),
            "status":               "pending",
            **slot_columns,
        })

    # ── Build user rows ──────────────────────────────────────
    user_rows = []

    for u in users:
        req_id = supplier_map.get(u.get("supplier_name"))
        if not req_id:
            continue

        user_rows.append({
            "supplier_user_id":     str(uuid.uuid4()),
            "supplier_request_id":  req_id,
            "user_email":           u.get("supplier_user_email"),
            "contact_name":         u.get("supplier_contact_name"),
            "status":               "active",
        })

    return {
        "request_rows":           request_rows,
        "user_rows":              user_rows,
        "supplier_request_count": len(request_rows),
        "supplier_user_count":    len(user_rows),
    }
