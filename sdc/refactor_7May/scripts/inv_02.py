"""WFA-002b -- Fetch supplier users to a dropdown component.

Feeds the "assign to" dropdown on the analyst page's manage-tasks section.
One item per supplier user (value = email, label = "Supplier -- Name <email>"),
across ALL suppliers, searchable. No page-side filtering is needed: INV-02's
kernel refuses a target that is not a user of the request's supplier, so a
wrong pick is a clear message, not a silent misassignment.

Inputs (schema-defined; no UUID keys cross the boundary):
    suppliers        list  sup_supplier_id, supplier_name, sup_status
    supplier_users   list  user_supplier_id, user_email, contact_name, primary, user_status
    search           str   optional -- the dropdown's typed search term (search_enabled: true)
    supplier_id      str   optional -- restrict to one supplier (dependent-dropdown variant)

Output:
    items   list of {label, value}   -- what the dropdown component consumes
    count   int
    log     str

Rules:
    - user_status must be blank or "active" (invited-but-unregistered users
      still appear: the task action accepts them, INV-01 assigns to them at kickoff).
    - supplier join is on the business supplier_id (pinned, same as UTL-06).
    - value is the email, lower-cased and de-duplicated; if one email belongs
      to more than one supplier the label lists every supplier.
    - primary users are marked "(primary)" in the label.
    - sorted by supplier name, then contact name.
"""


def _clean(value):
    return (value or "").strip()


def _as_bool(value):
    if isinstance(value, bool):
        return value
    return _clean(str(value)).lower() == "true"


def main(input):
    suppliers = input.get("suppliers") or []
    supplier_users = input.get("supplier_users") or []
    search = _clean(input.get("search")).lower()
    only_supplier = _clean(input.get("supplier_id"))

    log = ["arrivals: suppliers=%d supplier_users=%d search=%r supplier_id=%r"
           % (len(suppliers), len(supplier_users), search, only_supplier)]

    # ---- Boundary assertions: schema-name drift is loud, never silent ----
    if suppliers and not any(_clean(s.get("sup_supplier_id")) for s in suppliers):
        log.append("BOUNDARY| suppliers arrived (%d rows) but 'sup_supplier_id' is blank on all rows -- "
                   "first row keys: %s" % (len(suppliers), sorted(suppliers[0].keys())))
    if supplier_users and not any(_clean(u.get("user_email")) for u in supplier_users):
        log.append("BOUNDARY| supplier_users arrived (%d rows) but 'user_email' is blank on all rows -- "
                   "first row keys: %s" % (len(supplier_users), sorted(supplier_users[0].keys())))

    supplier_name_by_id = {}
    for s in suppliers:
        sid = _clean(s.get("sup_supplier_id"))
        if sid:
            supplier_name_by_id[sid] = _clean(s.get("supplier_name")) or sid

    # ---- Collapse users by email ----
    by_email = {}
    skipped_status = 0
    skipped_no_supplier = 0
    for u in supplier_users:
        email = _clean(u.get("user_email")).lower()
        sid = _clean(u.get("user_supplier_id"))
        if not email:
            continue
        if only_supplier and sid != only_supplier:
            continue
        status = _clean(u.get("user_status")).lower()
        if status not in ("", "active"):
            skipped_status += 1
            continue
        supplier_name = supplier_name_by_id.get(sid)
        if supplier_name is None:
            skipped_no_supplier += 1
            log.append("User %s: supplier_id '%s' not found in SUP_Supplier; listed under the raw id." % (email, sid))
            supplier_name = sid or "(no supplier)"
        entry = by_email.setdefault(email, {"suppliers": set(), "name": "", "primary": False})
        entry["suppliers"].add(supplier_name)
        if not entry["name"]:
            entry["name"] = _clean(u.get("contact_name"))
        entry["primary"] = entry["primary"] or _as_bool(u.get("primary"))

    # ---- Build, filter, sort ----
    items = []
    for email, e in by_email.items():
        supplier_label = ", ".join(sorted(e["suppliers"]))
        name = e["name"] or email
        label = "%s -- %s <%s>%s" % (supplier_label, name, email, " (primary)" if e["primary"] else "")
        if search and search not in label.lower():
            continue
        items.append({"label": label, "value": email, "_sort": (supplier_label.lower(), name.lower())})

    items.sort(key=lambda x: x["_sort"])
    for it in items:
        del it["_sort"]

    log.append("emitted %d items | skipped: status=%d, unknown supplier=%d"
               % (len(items), skipped_status, skipped_no_supplier))

    return {"items": items, "count": len(items), "log": "\n".join(log)}
