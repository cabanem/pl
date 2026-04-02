import uuid, json

# Inputs from prior steps
suppliers   = params["suppliers"]       # parsed config array
users       = params["users"]           # parsed config array
variants    = params["variants"]        # CFG_Variant records from Step 4
project_id  = params["template_project_id"]
version_id  = params["template_version_id"]
corr_id     = params["correlation_id"]
analyst     = params["analyst_email"]

# Build variant lookup: name → variant_id
variant_map = {v["variant_name"]: v["variant_id"] for v in variants}

# Build first-user lookup: supplier_name → first user's email
first_user = {}
for u in users:
    name = u["supplier_name"]
    if name not in first_user:
        first_user[name] = u["supplier_user_email"]

# Build supplier request rows + supplier_name → request_id map
supplier_map = {}
request_rows = []
for s in suppliers:
    rid = str(uuid.uuid4())
    supplier_map[s["supplier_name"]] = rid
    request_rows.append({
        "supplier_request_id":  rid,
        "template_project_id":  project_id,
        "assigned_version_id":  version_id,
        "assigned_variant_id":  variant_map.get(s.get("template_variation")),
        "correlation_id":       corr_id,
        "supplier_name":        s["supplier_name"],
        "contact_email":        first_user.get(s["supplier_name"]),
        "assignee_email":       analyst,
        "has_seeded_data":      bool(s.get("has_incumbent_data")),
        "seed_data_file_id":    s.get("location_of_incumbent_data"),
        "seed_data_range":      s.get("incumbent_data_range"),
        "status":               "pending"
    })

# Build user rows
user_rows = []
for u in users:
    req_id = supplier_map.get(u["supplier_name"])
    if not req_id:
        continue  # skip — no matching supplier
    user_rows.append({
        "supplier_user_id":     str(uuid.uuid4()),
        "supplier_request_id":  req_id,
        "user_email":           u["supplier_user_email"],
        "contact_name":         u.get("supplier_contact_name"),
        "status":               "active"
    })

return {
    "request_rows":  json.dumps(request_rows),
    "user_rows":     json.dumps(user_rows),
    "supplier_request_count": len(request_rows),
    "supplier_user_count":    len(user_rows)
}
