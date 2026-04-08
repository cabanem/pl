import json
import uuid


def main(input):
    pending = json.loads(input.get("pending_records_json", "[]"))
    form_slots = json.loads(input.get("form_slots_json", "[]"))
    new_version_id = input.get("new_version_id", "")
    parsed_config = json.loads(input.get("parsed_config_json", "{}"))

    # ── Build slot columns (same logic as Step 49) ────────
    slot_columns = {}

    for i in range(1, 9):
        slot_columns[f"slot_text_{i:02d}"] = None
        slot_columns[f"slot_text_{i:02d}_label"] = None
    for i in range(1, 5):
        slot_columns[f"slot_date_{i:02d}"] = None
        slot_columns[f"slot_date_{i:02d}_label"] = None
        slot_columns[f"slot_sel_{i:02d}"] = None
        slot_columns[f"slot_sel_{i:02d}_label"] = None
    for i in range(1, 3):
        slot_columns[f"slot_num_{i:02d}"] = None
        slot_columns[f"slot_num_{i:02d}_label"] = None
        slot_columns[f"slot_bool_{i:02d}"] = None
        slot_columns[f"slot_bool_{i:02d}_label"] = None

    for s in form_slots:
        slot = s.get("slot_name")
        if slot:
            slot_columns[f"{slot}_label"] = s.get("field_name")

    # ── Re-stamp pending records ──────────────────────────
    update_rows = []

    for rec in pending:
        update_rows.append({
            "Record ID": rec.get("Record ID"),
            "assigned_version_id": new_version_id,
            **slot_columns,
        })

    # ── Detect new suppliers ──────────────────────────────
    config_suppliers = parsed_config.get("suppliers", [])
    existing_names = {r.get("supplier_name", "") for r in pending}

    # Also need to account for non-pending records (in_progress, etc.)
    # that already have request records. Those won't be in the pending
    # list but they DO exist. To be safe, the caller should pass ALL
    # request records — but Step 54 only queries pending ones.
    #
    # For now, flag new suppliers as those not in the pending set.
    # A more robust version would query all statuses in Step 54
    # or add a second query. This is noted as a known limitation.

    new_supplier_rows = []
    for s in config_suppliers:
        name = s.get("supplier_name", "")
        if name and name not in existing_names:
            new_supplier_rows.append({
                "supplier_request_id": str(uuid.uuid4()),
                "template_project_id": rec.get("template_project_id", "") if pending else "",
                "assigned_version_id": new_version_id,
                "correlation_id": rec.get("correlation_id", "") if pending else "",
                "supplier_name": name,
                "assignee_email": rec.get("assignee_email", "") if pending else "",
                "has_seeded_data": bool(s.get("has_incumbent_data")),
                "status": "pending",
                **slot_columns,
            })

    return {
        "update_rows": update_rows,
        "new_supplier_rows": new_supplier_rows,
        "update_count": len(update_rows),
        "new_supplier_count": len(new_supplier_rows),
    }




[
  {
    "name": "update_rows",
    "type": "array",
    "of": "object",
    "label": "Records to update",
    "properties": [
      { "name": "Record ID", "type": "string" },
      { "name": "assigned_version_id", "type": "string" },
      { "name": "slot_text_01_label", "type": "string", "optional": true },
      { "name": "slot_text_02_label", "type": "string", "optional": true },
      { "name": "slot_text_03_label", "type": "string", "optional": true },
      { "name": "slot_text_04_label", "type": "string", "optional": true },
      { "name": "slot_text_05_label", "type": "string", "optional": true },
      { "name": "slot_text_06_label", "type": "string", "optional": true },
      { "name": "slot_text_07_label", "type": "string", "optional": true },
      { "name": "slot_text_08_label", "type": "string", "optional": true },
      { "name": "slot_num_01_label", "type": "string", "optional": true },
      { "name": "slot_num_02_label", "type": "string", "optional": true },
      { "name": "slot_date_01_label", "type": "string", "optional": true },
      { "name": "slot_date_02_label", "type": "string", "optional": true },
      { "name": "slot_date_03_label", "type": "string", "optional": true },
      { "name": "slot_date_04_label", "type": "string", "optional": true },
      { "name": "slot_sel_01_label", "type": "string", "optional": true },
      { "name": "slot_sel_02_label", "type": "string", "optional": true },
      { "name": "slot_sel_03_label", "type": "string", "optional": true },
      { "name": "slot_sel_04_label", "type": "string", "optional": true },
      { "name": "slot_bool_01_label", "type": "string", "optional": true },
      { "name": "slot_bool_02_label", "type": "string", "optional": true },
      { "name": "slot_text_01", "type": "string", "optional": true },
      { "name": "slot_text_02", "type": "string", "optional": true },
      { "name": "slot_text_03", "type": "string", "optional": true },
      { "name": "slot_text_04", "type": "string", "optional": true },
      { "name": "slot_text_05", "type": "string", "optional": true },
      { "name": "slot_text_06", "type": "string", "optional": true },
      { "name": "slot_text_07", "type": "string", "optional": true },
      { "name": "slot_text_08", "type": "string", "optional": true },
      { "name": "slot_num_01", "type": "string", "optional": true },
      { "name": "slot_num_02", "type": "string", "optional": true },
      { "name": "slot_date_01", "type": "string", "optional": true },
      { "name": "slot_date_02", "type": "string", "optional": true },
      { "name": "slot_date_03", "type": "string", "optional": true },
      { "name": "slot_date_04", "type": "string", "optional": true },
      { "name": "slot_sel_01", "type": "string", "optional": true },
      { "name": "slot_sel_02", "type": "string", "optional": true },
      { "name": "slot_sel_03", "type": "string", "optional": true },
      { "name": "slot_sel_04", "type": "string", "optional": true },
      { "name": "slot_bool_01", "type": "string", "optional": true },
      { "name": "slot_bool_02", "type": "string", "optional": true }
    ]
  },
  {
    "name": "new_supplier_rows",
    "type": "array",
    "of": "object",
    "label": "New suppliers needing request records",
    "properties": [
      { "name": "supplier_request_id", "type": "string" },
      { "name": "template_project_id", "type": "string" },
      { "name": "assigned_version_id", "type": "string" },
      { "name": "assigned_variant_id", "type": "string", "optional": true },
      { "name": "correlation_id", "type": "string" },
      { "name": "supplier_name", "type": "string" },
      { "name": "contact_email", "type": "string", "optional": true },
      { "name": "assignee_email", "type": "string" },
      { "name": "has_seeded_data", "type": "boolean" },
      { "name": "status", "type": "string" }
    ]
  },
  { "name": "update_count", "type": "integer" },
  { "name": "new_supplier_count", "type": "integer" }
]
