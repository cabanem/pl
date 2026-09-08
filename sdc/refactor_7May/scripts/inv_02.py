import json
import uuid
from datetime import datetime, timezone

# -----------------------------------------------------------------------------
# INV-04 DECISION KERNEL  (v2 — task handling delegated to INV-02 v2)
#
# Portability rule: no UUID keys cross the Python boundary. Scalars arrive as
# datapills; the users list arrives via a schema-defined list input whose
# property names are declared in the action config (record_id,
# supplier_user_id, user_email, primary) and whose values are pill-mapped —
# both remapped by the platform on package import. Output names are defined
# here, so downstream pills are stable across workspaces by construction.
#
# What this kernel decides: who becomes primary, who gets demoted, and whether
# a user row must be created and invited. What it no longer decides: anything
# about the WFA task. If the task should follow the new primary, the recipe
# calls INV-02 v2 (ensure task on request) with assignee_email = new primary,
# and INV-02 works out renew / reassign / recover / noop / refuse from the
# request's actual state. Consequently:
#   - stage_name and current_assignee_email are accepted but optional; the
#     old "no currently assigned user" guard is gone (it read the request-level
#     assignee_email column, which is never blank, so it never fired).
#   - wfa_count is optional; enforce it only if the recipe still does the read.
#   - old_primary_email comes from the users list (the rows being demoted),
#     falling back to current_assignee_email only when no primary row exists.
#
# Output keys are unchanged so existing downstream pills keep resolving.
# `reassign` now means "call INV-02 v2"; `task_action` / `skip_reason` describe
# that decision, and the recipe should overwrite task_action with INV-02's
# returned `mode` for the OBS event.
# -----------------------------------------------------------------------------

TERMINAL = {"approved", "cancelled"}


def _norm(s):
    return (s or "").strip().lower()


def _n(v):
    try:
        return int(str(v).strip() or "0")
    except ValueError:
        return 0


def _present(v):
    return str(v if v is not None else "").strip() != ""


def _truthy(v, default=False):
    s = str(v if v is not None else "").strip().lower()
    if s == "":
        return default
    return s in ("true", "1", "yes", "y", "t")


def _fail(error_type, message):
    return {"ok": False, "noop": False, "phase": "recipe_failed",
            "error_type": error_type, "error_message": message}


def main(input):
    # ---- users list: tolerate list-of-dicts or a JSON string ------------------
    users = input.get("users") or []
    if isinstance(users, str):
        try:
            users = json.loads(users or "[]")
        except (ValueError, TypeError) as e:
            return _fail("unexpected_error", "users parse error: {}".format(str(e)))

    new_email_raw = (input.get("new_primary_email") or "").strip()
    new_email     = _norm(new_email_raw)
    contact_name  = (input.get("contact_name") or "").strip()
    status        = _norm(input.get("request_status"))
    move_task     = _truthy(input.get("move_task"), default=True)

    # Optional context (kept for compatibility; not used for decisions)
    request_assignee = _norm(input.get("current_assignee_email"))
    wfa_count_in     = input.get("wfa_count")
    project_count    = _n(input.get("project_count"))
    supplier_count   = _n(input.get("supplier_count"))

    # ---- verdicts (request existence is guarded upstream at step 3) ----------
    if not new_email or "@" not in new_email:
        return _fail("recipe_invariant", "A valid new_primary_email is required.")
    if status in TERMINAL:
        return _fail("recipe_invariant",
                     "Request has invariant status ({}). Cannot change primary.".format(status))
    if _present(wfa_count_in) and _n(wfa_count_in) == 0:
        return _fail("state_inconsistent", "Request not found in the Workflow App.")
    if project_count == 0:
        return _fail("state_inconsistent", "Project context is absent from the 'Project' table.")
    if supplier_count == 0:
        return _fail("state_inconsistent", "Supplier not found in SUP_Supplier.")
    # NOTE: an empty users list is NOT an error — it resolves to create-mode
    # with nothing to demote, which is the correct outcome.

    # ---- locate target and primaries (case-insensitive) ------------------------
    target    = next((u for u in users if _norm(u.get("user_email")) == new_email), None)
    primaries = [u for u in users if _truthy(u.get("primary"))]
    others    = [u for u in primaries if _norm(u.get("user_email")) != new_email]
    demote    = [{"record_id": (u.get("record_id") or "")} for u in others]

    # ---- idempotency: already the one and only primary -------------------------
    target_is_primary = target is not None and _truthy(target.get("primary"))
    if target_is_primary and not others:
        return {"ok": True, "noop": True, "disposition": "already_primary"}

    mode = "promote" if target else "create"

    old_primary = ", ".join((u.get("user_email") or "").strip() for u in others if u.get("user_email"))
    if not old_primary:
        old_primary = request_assignee  # fallback: request-level column, if the recipe still maps it

    plan = {
        "ok": True, "noop": False,
        "mode": mode,
        "disposition": "promoted_existing" if mode == "promote" else "invited_new",
        # Task handling is delegated: True => recipe calls INV-02 v2 with
        # assignee_email = new_primary_email and lets it decide the mode.
        "reassign": move_task,
        "task_action": "delegated_to_inv02" if move_task else "left_in_place",
        "skip_reason": ("" if move_task else "move_task is false; primary flag changed only."),
        "target_record_id": (target or {}).get("record_id") or "",
        "supplier_user_id": (target or {}).get("supplier_user_id") or "",
        "demote_rows": demote,
        "demote_count": len(demote),
        "drift_detected": len(primaries) > 1,
        "drift_note": ("Found {} primary rows for this supplier; repaired by demotion."
                       .format(len(primaries)) if len(primaries) > 1 else ""),
        "old_primary_email": old_primary,
        "new_primary_email": new_email_raw,
        "contact_name": contact_name or new_email_raw,
        "new_user_supplier_user_id": "",
        "new_user_created_at": "",
    }

    if mode == "create":
        plan["new_user_supplier_user_id"] = str(uuid.uuid4())
        plan["supplier_user_id"] = plan["new_user_supplier_user_id"]
        plan["new_user_created_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return plan
