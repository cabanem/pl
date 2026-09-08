"""UTL-06 -- Fetch requests by task condition (v4).

One pass over every WFA request, joined to SUP_Supplier and to the supplier's
primary active contact, classified by the state of its task:

    expired   task present, task_status == "expired"
    active    task present, any other status
    stranded  no task, but request status is task-bearing
              (sent | supplier_action_required | pending_review)
    (skipped) no task and status is task-less by design
              (pending | pending_validation | approved | cancelled)

Input `condition` selects which rows come back: expired (default, so the
existing WFA-002 / WFA-002a callers are unchanged), stranded, active, or all.

Joins are pinned: the WFA request's supplier_id references SUP_Supplier's
business supplier_id, and SUP_SupplierUser's user_supplier_id holds the same
key (INV-01 and INV-02 filter on exactly these in production). The v3
dual-index discovery build and its census logging are gone; a miss is now a
plain log line, not a research question.

Output keys `expired_tasks_count` / `expired_task_detail` are kept for pill
stability in step 15 and the two callers; the rows inside are wider.
Removed from the output: tasks_renewed, renewal_calls, expired_task_renewal
(dead -- both callers passed renew_expired_tasks=false; renewal lives in INV-02).
"""

TASK_BEARING = ("sent", "supplier_action_required", "pending_review")
CONDITIONS = ("expired", "stranded", "active", "all")


def _clean(value):
    return (value or "").strip()


def _as_bool(value):
    if isinstance(value, bool):
        return value
    return _clean(str(value)).lower() == "true"


def _classify(task_id, task_status, request_status):
    if task_status == "expired":
        return "expired"
    if task_id:
        return "active"
    if request_status in TASK_BEARING:
        return "stranded"
    return ""


def main(input):
    requests = input.get("requests") or []
    suppliers = input.get("suppliers") or []
    supplier_users = input.get("supplier_users") or []
    condition = _clean(input.get("condition")).lower() or "expired"

    log = []
    if condition not in CONDITIONS:
        log.append("condition '%s' not recognised; using 'expired'." % condition)
        condition = "expired"
    log.append("arrivals: requests=%d suppliers=%d supplier_users=%d condition=%s"
               % (len(requests), len(suppliers), len(supplier_users), condition))

    # ---- Boundary assertions: schema-name drift is loud, never silent ----
    if suppliers and not any(_clean(s.get("sup_supplier_id")) for s in suppliers):
        log.append("BOUNDARY| suppliers arrived (%d rows) but 'sup_supplier_id' is blank on "
                   "all rows -- first row keys: %s" % (len(suppliers), sorted(suppliers[0].keys())))
    if supplier_users and not any(_clean(u.get("user_supplier_id")) for u in supplier_users):
        log.append("BOUNDARY| supplier_users arrived (%d rows) but 'user_supplier_id' is blank "
                   "on all rows -- first row keys: %s" % (len(supplier_users), sorted(supplier_users[0].keys())))

    # ---- Suppliers by business supplier_id ----
    supplier_by_id = {}
    for s in suppliers:
        sid = _clean(s.get("sup_supplier_id"))
        if sid:
            supplier_by_id[sid] = s

    # ---- Primary active contact per supplier ----
    primary_by_supplier = {}
    for u in supplier_users:
        sid = _clean(u.get("user_supplier_id"))
        if not sid or not _as_bool(u.get("primary")):
            continue
        status = _clean(u.get("user_status")).lower()
        if status not in ("", "active"):
            continue
        if sid in primary_by_supplier:
            log.append("Supplier %s has multiple primary active users; keeping %s."
                       % (sid, primary_by_supplier[sid].get("user_email")))
            continue
        primary_by_supplier[sid] = u

    # ---- Main pass ----
    counts = {"expired": 0, "stranded": 0, "active": 0}
    detail = []
    supplier_misses = 0

    for r in requests:
        task_id = _clean(r.get("task_id"))
        task_status = _clean(r.get("task_status")).lower()
        request_status = _clean(r.get("status")).lower()

        cond = _classify(task_id, task_status, request_status)
        if not cond:
            continue
        counts[cond] += 1
        if condition != "all" and cond != condition:
            continue

        req_id = _clean(r.get("supplier_request_id"))
        sid = _clean(r.get("supplier_id"))
        supplier = supplier_by_id.get(sid)
        contact = primary_by_supplier.get(sid)

        if supplier is None:
            supplier_misses += 1
            log.append("Request %s: supplier_id '%s' not found in SUP_Supplier." % (req_id, sid))

        holder_status = _clean(r.get("assigned_user_status")).lower()
        never_registered = holder_status == "invited"

        detail.append({
            "supplier_request_id": r.get("supplier_request_id"),
            "supplier_id": r.get("supplier_id"),
            "supplier_name": (supplier or {}).get("supplier_name"),
            "assignee_email": r.get("assignee_email"),
            "primary_contact_name": (contact or {}).get("contact_name"),
            "primary_contact_email": (contact or {}).get("user_email"),
            "status": r.get("status"),
            "request_status": request_status,
            "condition": cond,
            "task_status": task_status,
            "task_holder_email": r.get("assigned_user_email"),
            "task_holder_status": holder_status,
            "current_state_entered_at": r.get("current_state_entered_at"),
            "stage_id": r.get("stage_id"),
            "stage_name": r.get("stage_name"),
            "note": ("User never completed portal registration." if never_registered
                     else "No task on a task-bearing request." if cond == "stranded"
                     else "Active user"),
            "active_task": {
                "active_task_id": r.get("task_id"),
                "active_task_name": r.get("task_name"),
                "active_task_due_date": r.get("task_expires_at"),
                "active_task_url": r.get("task_link"),
                "active_task_status": r.get("task_status"),
                "assigned_user": {
                    "assigned_user_id": r.get("assigned_user_id"),
                    "assigned_user_name": r.get("assigned_user_name"),
                    "assigned_user_email": r.get("assigned_user_email"),
                },
            },
        })

    log.append("classified: expired=%d stranded=%d active=%d | returned=%d (%s) | supplier misses=%d"
               % (counts["expired"], counts["stranded"], counts["active"], len(detail), condition,
                  supplier_misses))

    return {
        "expired_tasks_count": len(detail),
        "counts": counts,
        "expired_task_detail": detail,
        "log": "\n".join(log),
    }
