"""INV-02 DECISION KERNEL -- "ensure task on request" (renew | reassign | recover).

Same portability rule as INV-04: no UUID keys cross the Python boundary. Scalars
arrive as datapills; `users` is a schema-defined list (user_email, contact_name,
primary, user_status) mapped from the SUP_SupplierUser read filtered on the
request's supplier_id.

The kernel never trusts the button the analyst pressed. It reads what the WFA
request actually looks like and picks the mode:

    no task, status task-bearing  -> recover   (INV-01a fresh branch)
    task present, target == holder, task expired -> renew  (reassignment branch)
    task present, target != holder -> reassign            (reassignment branch)
    task present, target == holder, task live    -> noop
    status task-less (pending / pending_validation / approved / cancelled) -> refuse

Stage comes from status, mirroring STS-01's STATUS_TO_WFA_STAGE, expressed in
INV-01a's own tokens. Never from a literal, never from the request's current
stage.name (that is what we are repairing).
"""

# status -> INV-01a stage token. Task-less statuses are deliberately absent.
STATUS_TO_STAGE_TOKEN = {
    "sent":                     "awaiting_data_submission",
    "supplier_action_required": "awaiting_data_submission",
    "pending_review":           "under_review",
}

# status -> expected WFA display stage (from STS-01), for drift detection only.
STATUS_TO_WFA_STAGE = {
    "sent":                     "Awaiting data submission",
    "supplier_action_required": "Awaiting data submission",
    "pending_review":           "Under review",
}


def _norm(v):
    return (v or "").strip().lower()


def _truthy(v):
    if isinstance(v, bool):
        return v
    return _norm(str(v)) in ("true", "1", "yes", "y", "t")


def _n(v, default):
    try:
        return int(str(v).strip()) if str(v).strip() else default
    except ValueError:
        return default


def _refuse(error_type, message):
    return {"ok": False, "mode": "refuse", "reason": message,
            "error_type": error_type, "plan": {}}


def main(input):
    status        = _norm(input.get("request_status"))
    stage_name    = (input.get("stage_name") or "").strip()
    task_id       = (input.get("task_id") or "").strip()
    task_status   = _norm(input.get("task_status"))
    task_name     = (input.get("task_name") or "").strip()
    holder        = _norm(input.get("task_holder_email"))
    requested     = _norm(input.get("requested_assignee_email"))
    supplier_name = (input.get("supplier_name") or "").strip()
    client_name   = (input.get("client_name") or "").strip()
    analyst_email = (input.get("analyst_email") or "").strip()
    days          = _n(input.get("days_param"), _n(input.get("project_default_days"), 7))
    users         = input.get("users") or []

    # ---- verdicts ------------------------------------------------------------
    token = STATUS_TO_STAGE_TOKEN.get(status)
    if not token:
        return _refuse("recipe_invariant",
                       "Status '{0}' carries no task; nothing to assign.".format(status or "blank"))

    # ---- who should hold it ----------------------------------------------------
    if token == "under_review":
        # Analyst tasks go to the Implementation team group inside INV-01a;
        # assignee_email is required by its contract but not used for routing.
        target = _norm(analyst_email)
        if not target:
            return _refuse("state_inconsistent", "Project has no analyst_email.")
        contact_name = "Implementation team"
    else:
        by_email = {_norm(u.get("user_email")): u for u in users if _norm(u.get("user_email"))}
        primary  = next((u for u in users
                         if _truthy(u.get("primary")) and _norm(u.get("user_status")) in ("", "active")), None)
        target = requested or holder or _norm((primary or {}).get("user_email"))
        if not target:
            return _refuse("state_inconsistent",
                           "No assignee: none requested, no task holder, no primary active user.")
        if target not in by_email:
            return _refuse("recipe_invariant",
                           "{0} is not a user of {1}; add them first via 'add a user' on this page."
                           .format(target, supplier_name or "this supplier"))
        contact_name = (by_email[target].get("contact_name") or target).strip()

    # ---- mode ------------------------------------------------------------------
    # Analyst tasks are group-held (no individual holder), so only presence and
    # expiry matter for them; supplier tasks also compare holder vs target.
    if not task_id:
        mode = "recover"
    elif token != "under_review" and target != holder:
        mode = "reassign"
    elif task_status == "expired":
        mode = "renew"
    else:
        return {"ok": True, "mode": "noop", "error_type": "",
                "reason": "Task already held by {0} and not expired."
                          .format(holder or "the Implementation team"), "plan": {}}

    if not task_name:
        task_name = ("Review submission for {0}".format(supplier_name)          # TODO: copy UPL-01's string
                     if token == "under_review" else
                     "Supplier data collection request for {0} on behalf of {1}".format(supplier_name, client_name))

    expected_stage = STATUS_TO_WFA_STAGE.get(status, "")
    drift = bool(stage_name) and stage_name != expected_stage

    return {
        "ok": True,
        "mode": mode,
        "error_type": "",
        "reason": {
            "recover":  "No active task on a '{0}' request; creating one for {1}.",
            "reassign": "Moving task from {2} to {1}.",
            "renew":    "Renewing expired task for {1}.",
        }[mode].format(status, target, holder or "(unassigned)"),
        "drift_detected": drift,
        "drift_note": ("WFA stage is '{0}', expected '{1}' for status '{2}'."
                       .format(stage_name, expected_stage, status) if drift else ""),
        "plan": {
            "assignee_email": target,
            "contact_name": contact_name,
            "workflow_app_stage": token,
            "is_reassignment": mode != "recover",
            # INV-01a only checks this is non-blank (unshare was removed); an
            # expired analyst task has no individual holder, so fall back.
            "currently_assigned_user_email": holder or _norm(analyst_email),
            "task_name": task_name,
            "days_to_complete_task": days,
            "send_email": True,
        },
    }
