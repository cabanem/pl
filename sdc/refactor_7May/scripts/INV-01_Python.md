# INV-01 — Python (py_eval steps)

Four blocks. Two are core to the recipe (Steps 10 and 17.3.1). Two are conditional fallbacks (Step 5 and Step 18.5) — render them only if the inline formula or foreach-source-filter approaches don't work in your workspace.

All blocks use `def main(data):` as the entry point, mirroring the modern Workato py_eval idiom. If your workspace's py_eval contract is "script-style with a final expression" or "named output variable," unwrap the `def main` and adapt — the logic is the same.

Defensive boolean coercion uses an `_is_true` helper that mirrors the Ruby SDK's `.is_true?` pattern: Workato pills can surface booleans as actual `bool`, the strings `"true"`/`"false"`, or `None` depending on the connector path. Python's bare `bool("false")` returns `True` (non-empty string is truthy), so the helper is necessary, not stylistic.

---

## Block A — Step 10: Partition users into assignee and secondaries

The substantive py_eval. Reads the user array from Step 8's `get_records` on SUP_SupplierUser (already pre-filtered to `status = "active"` and the right `supplier_id`), and splits it by `primary`. Emits four outputs that the downstream IF block (Step 11) and update_variables (Step 12) consume.

**Inputs (mapped on the step):**
- `users` — list of SUP_SupplierUser record objects from `[Step 8 → records]`. Each entry carries at minimum `user_email`, `contact_name`, and `primary`. The builder may need a small input mapping to alias the column UUIDs to these friendly names; if so, use `update_variables` to surface a clean array first or do the alias inside the py_eval.

**Outputs (exposed as step pills):**
- `primary_count` (int) — count of `primary == True` rows. Substage 3's IF block (Step 11) refuses the invitation if this isn't exactly 1.
- `assignee_email` (str) — the single primary user's email, or `""` when `primary_count != 1`.
- `assignee_contact_name` (str) — the single primary user's contact name, or `""`.
- `secondaries` (list of dict) — `[{user_email, contact_name}, ...]` for all `primary != True` users. Always populated, even on primary-count violations, so the details_json on the recipe_failed emit can carry forensic context about who *was* on the request.

```python
def _is_true(v):
    """Defensive boolean coercion. Mirrors Ruby SDK's .is_true? — Workato
    pills surface booleans as bool, string 'true'/'false', or None depending
    on the connector path."""
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    return str(v).strip().lower() in ("true", "1", "yes", "y", "t")


def main(data):
    users = data.get("users") or []

    primaries = [u for u in users if _is_true(u.get("primary"))]
    non_primaries = [u for u in users if not _is_true(u.get("primary"))]

    primary_count = len(primaries)

    if primary_count == 1:
        assignee_email = str(primaries[0].get("user_email") or "")
        assignee_contact_name = str(primaries[0].get("contact_name") or "")
    else:
        # Zero or multiple primaries — substage 3's IF catches this and emits
        # recipe_failed (recipe_invariant). Return well-typed defaults so
        # update_variables doesn't choke on None; the WFA calls in substage 5
        # never fire on this path.
        assignee_email = ""
        assignee_contact_name = ""

    secondaries = [
        {
            "user_email": str(u.get("user_email") or ""),
            "contact_name": str(u.get("contact_name") or ""),
        }
        for u in non_primaries
    ]

    return {
        "primary_count": primary_count,
        "assignee_email": assignee_email,
        "assignee_contact_name": assignee_contact_name,
        "secondaries": secondaries,
    }
```

**Why this shape:** the split-and-validate pattern is a single py_eval rather than a chain of formula expressions because the invariant ("exactly one primary") is the kind of thing that's easier to read in seven lines of Python than in three nested ternaries. The `secondaries` array gets built even on the failure path because failure-mode debugging is the use case that benefits most from having "who else was here" visible.

---

## Block B — Step 17.3.1: Map STS-01 error_code to OBS-01 error_type

Trivial mapping. As flagged in the inventory delivery, this could also be an inline ternary in the OBS-01 call. The case for keeping it as a py_eval: discoverability — if STS-01's error_code enum grows in the future, the mapping lives in one named step rather than buried in an emit's formula field.

**Inputs:**
- `sts01_error_code` (str) — one of: `"illegal_transition"`, `"request_not_found"`, `"precondition_failed"`, `"derivation_lookup_failed"`. Sourced from `[Step 17.1 → error_code]`.

**Outputs:**
- `error_type` (str) — `"state_inconsistent"` or `"recipe_invariant"`, per the alignment from the design conversation.

```python
def main(data):
    """Map STS-01 transition-refusal codes to OBS-01 error_type taxonomy.

    illegal_transition         -> state_inconsistent (ET-10)
        The target_state doesn't fit the row's current state. Most likely
        cause: a concurrent transition fired between INV-01's eligibility
        read (substage 2) and the STS-01 call (substage 6). The state
        itself is fine; the requested action doesn't match it.

    request_not_found          -> recipe_invariant (ET-01)
    precondition_failed        -> recipe_invariant (ET-01)
    derivation_lookup_failed   -> recipe_invariant (ET-01)
        All three mean a precondition INV-01 thought was true isn't.
        Retry won't help; the fix is upstream.
    """
    code = data.get("sts01_error_code", "")
    if code == "illegal_transition":
        return {"error_type": "state_inconsistent"}
    return {"error_type": "recipe_invariant"}
```

---

## Block C — Step 5 (conditional): Resolve `due_in_days`

Render this only if the inline formula approach for due_in_days doesn't work in your workspace. The formula version is `[var: request_due_date].present? ? ([var: request_due_date] - now).in_days.to_i : [Step 4 → records[0].default_due_days]` — but Workato date arithmetic in update_variables formula syntax has gotchas (timezone handling, integer coercion).

**Inputs:**
- `request_due_date` (str, ISO 8601 date_time, may be empty) — from `[Step 1 → records[0].due_date]`.
- `default_due_days` (int) — from `[Step 4 → records[0].default_due_days]`.
- `now` (str, ISO 8601 date_time) — current time, supplied via the standard Workato `now` pill or a step input that captures it.

**Outputs:**
- `due_in_days` (int) — days from `now` until `request_due_date` if both are present; otherwise `default_due_days`. Clamped at 0 — never pass a negative `due_in_days` to the WFA platform action.

```python
from datetime import datetime


def _parse_iso(s):
    """Tolerant ISO-8601 parser. Workato date_time pills are typically
    'YYYY-MM-DDTHH:MM:SS+ZZ:ZZ' but may end in 'Z' which datetime.fromisoformat
    rejects in older Python runtimes."""
    if not s:
        return None
    s = str(s).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def main(data):
    request_due_date = _parse_iso(data.get("request_due_date"))
    now = _parse_iso(data.get("now"))
    default_due_days = int(data.get("default_due_days") or 0)

    if request_due_date and now:
        delta = (request_due_date - now).days
        # Clamp at 0 — a past due_date shouldn't propagate as a negative
        # TTL to the WFA task. Treat past-due as "due today."
        return {"due_in_days": max(delta, 0)}

    return {"due_in_days": default_due_days}
```

**Design note:** the clamp at 0 is opinionated. The alternative is to refuse invitations on past-due requests by emitting `recipe_failed` with `state_inconsistent`. My read: the request's `due_date` was set at issuance time; if the analyst is invitating today and the date is in the past, that's a configuration error worth surfacing — but it's also routine recoverable state (analyst notices, edits the date, retries). Treating past-due as "due today" lets the invitation go out and lets the analyst correct in flight rather than blocking. If you want stricter behavior, replace the `max(delta, 0)` with an explicit fail-and-emit.

---

## Block D — Step 18.5 (conditional): Filter `secondary_dispositions` to "sent"

Render this only if Workato's foreach source expression can't accept inline filtering like `[var: secondary_dispositions].filter(d => d.disposition == "sent")`. Run this step before Step 19 and point the foreach at `sent_secondaries`.

**Inputs:**
- `secondary_dispositions` (list of dict) — the accumulated dispositions from substage 5.2. Each entry is `{user_email, disposition}`.

**Outputs:**
- `sent_secondaries` (list of dict) — same shape, restricted to entries where `disposition == "sent"`. Empty list if all secondaries failed.

```python
def main(data):
    dispositions = data.get("secondary_dispositions") or []
    return {
        "sent_secondaries": [
            d for d in dispositions
            if d.get("disposition") == "sent"
        ]
    }
```

---

## Notes on Workato py_eval contracts

The `def main(data):` entry point assumes a workspace where py_eval steps take a `data` dict as input and return a dict whose keys become output pills. If your workspace uses a different convention:

- **Script-style with named result variable:** unwrap `def main(data):`, dedent the body, and replace the `return {...}` with explicit assignments like `result = {...}` or whatever your contract expects.
- **Bare-expression style:** less likely for these blocks, since each produces multiple outputs.
- **OBS-01's actual py_eval:** if you want to mirror the exact style there (which I haven't fully seen, only the recipe-JSON wrapping), copy the OBS-01 wrapping shell and paste the body into it.

The four blocks are independent. No shared state across them.
