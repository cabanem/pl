# REV-01 Python Blocks

**Recipe:** REV-01 Analyst review handler
**Target version:** v1 (initial build)
**Companion docs:** `rev_01_step_level_outline.md` (substage rationale), `rev_01_step_inventory.md` (click-order, v2)

Standalone source for the two py_eval blocks REV-01 uses. Both are pure functions over their declared inputs — no recipe-context reads, no Data Tables calls, no FileStorage. The `py_eval` provider runs inside Workato's Python sandbox; the entry point is `main(input)` returning a dict that matches the declared output schema.

The two blocks:

| Block | Used in | Purpose |
|---|---|---|
| 1 | Step 13 | Map `decision` (`approve` \| `reject`) to STS-01's `target_state` and `trigger_context` |
| 2 | Steps 39, 49 | Map STS-01 return `error_code` to REV-01's OBS-01 `error_type` |

Block 2 has two call sites (one per branch — approve at step 39, reject at step 49). Workato doesn't support shared py_eval helpers, so each call site is a separate py_eval action instance pointing at the same source. Keep them in sync if either gets edited.

---

## Block 1 — Decision mapping

**Used in:** Step 13 (Substage 4)
**Purpose:** Translate the analyst-facing `decision` value (`approve` or `reject`) into the two parameters STS-01 needs (`target_state` and `trigger_context`). The substage-2 input validation guarantees `decision` is one of `{approve, reject}` by the time this runs, so the unknown-key branch is defensive only.

**Why a py_eval and not nested IFs.** The mapping is a two-row truth table. Nested IFs work but split the table across two output bindings (one set of IFs for `target_state`, another for `trigger_context`), which means the relationship between `reject` and `analyst_rework` lives in two different places in the recipe. A small py_eval keeps the table in one readable place. This is also the seam where the "reject" → "rework" terminology shift happens — concentrating that in one block makes it easy to find later.

### Code input

| Name | Type | Source pill |
|---|---|---|
| `decision` | string | `{trigger.decision}` |

### Code output schema

```json
[
  {"name": "target_state", "type": "string", "optional": false, "label": "target_state", "control_type": "text"},
  {"name": "trigger_context", "type": "string", "optional": false, "label": "trigger_context", "control_type": "text"}
]
```

### Source

```python
# REV-01 / Block 1 — decision mapping
#
# Maps the analyst-facing decision value to STS-01 v29 trigger parameters.
#
# Source of truth for the trigger_context enum: STS-01 recipe export v29
# (trigger parameters_schema_json), confirmed against analyst_rework /
# analyst_approve usage in STS-01's derivation lookup branches.
#
# Note the terminology shift: "reject" is the analyst-facing decision value;
# "rework" is the state-machine trigger_context. They mean the same thing.
# RUN_ReviewNote.review_action also uses "rework" (manifest enum is
# approved | rework), not "reject".

DECISION_MAP = {
    "approve": {
        "target_state": "approved",
        "trigger_context": "analyst_approve",
    },
    "reject": {
        "target_state": "supplier_action_required",
        "trigger_context": "analyst_rework",
    },
}


def main(input):
    decision = (input.get("decision") or "").strip().lower()
    mapping = DECISION_MAP.get(decision)
    if mapping is None:
        # Substage 2 (steps 7–9) guards against this; defensive fallback only.
        # Empty strings flow through to the STS-01 call and STS-01 will refuse
        # with illegal_transition, which REV-01 maps to state_inconsistent.
        return {"target_state": "", "trigger_context": ""}
    return {
        "target_state": mapping["target_state"],
        "trigger_context": mapping["trigger_context"],
    }
```

### Downstream consumption

The output pills are persisted into `{var.target_state}` and `{var.trigger_context}` at step 14 (`update_variables`). Both branches of substage 5 read from those variables when calling STS-01:

- Approve branch (step 36): `target_state` = `approved`, `trigger_context` = `analyst_approve`
- Reject branch (step 46): `target_state` = `supplier_action_required`, `trigger_context` = `analyst_rework`

---

## Block 2 — STS-01 error_code mapping

**Used in:** Steps 39 and 49 (Substage 5, inside both branches' STS-01-failed sub-IFs)
**Purpose:** Translate STS-01's return `error_code` (`request_not_found` | `illegal_transition` | `precondition_failed` | `derivation_lookup_failed`) into REV-01's OBS-01 `error_type` for the failure emit.

**Why a py_eval and not formula expressions.** Same reasoning as Block 1: a four-row mapping kept in one readable place beats four nested IFs spread across the recipe tree. The mapping is also non-obvious — three of the four STS-01 codes collapse to `recipe_invariant`, while `illegal_transition` is the one with operational meaning (concurrent state change, e.g., the request was cancelled between REV-01's precondition check and the STS-01 call). Documenting the "why" inline keeps that reasoning attached to the mapping.

### Code input

| Name | Type | Source pill |
|---|---|---|
| `error_code` | string | `{var.sts_result_error_code}` (set at step 37 or step 47 from STS-01's return) |

### Code output schema

```json
[
  {"name": "error_type", "type": "string", "optional": false, "label": "error_type", "control_type": "text"}
]
```

### Source

```python
# REV-01 / Block 2 — STS-01 error_code -> REV-01 OBS-01 error_type
#
# STS-01 v29 returns one of four error_code values when success=false. REV-01
# emits the corresponding OBS-01 error_type when surfacing the failure.
#
# Mapping rationale:
#
# illegal_transition -> state_inconsistent
#   The transition REV-01 requested is not legal from the current state. By
#   the time REV-01 reaches the STS-01 call, substage 1 has already verified
#   status=pending_review, so illegal_transition can only fire if the row's
#   status changed between substage 1 and the STS-01 call (concurrent
#   cancellation, retry of a stale REV-01 invocation, etc.). This is the
#   "concurrent state change" signal -- a real-world condition, not a bug.
#
# request_not_found -> recipe_invariant
#   STS-01 couldn't find the SUP_SupplierRequest row REV-01 just successfully
#   fetched at substage 1. Implies the row was deleted between the two reads,
#   which would violate data-model assumptions (SUP_SupplierRequest rows are
#   not deleted; they're cancelled in place). Bug or platform failure.
#
# precondition_failed -> recipe_invariant
#   STS-01's own preconditions (separate from REV-01's) didn't hold. By
#   contract these shouldn't fire for the analyst_approve / analyst_rework
#   trigger_contexts REV-01 uses. If one does, it indicates STS-01 and REV-01
#   are out of sync on contract expectations.
#
# derivation_lookup_failed -> recipe_invariant
#   STS-01's supplier_message derivation step couldn't resolve a placeholder.
#   For analyst_rework, this would mean RUN_ReviewNote lookup failed (REV-01
#   didn't write the note before calling, or wrote it with the wrong
#   supplier_request_id). For analyst_approve, this would mean approved_at
#   wasn't populated on SUP_SupplierRequest before the STS-01 call. Both
#   conditions are REV-01 ordering bugs and should be impossible if the
#   step sequence in the inventory is followed.
#
# Unknown codes (defensive default) -> recipe_invariant.

ERROR_MAP = {
    "illegal_transition": "state_inconsistent",
    "request_not_found": "recipe_invariant",
    "precondition_failed": "recipe_invariant",
    "derivation_lookup_failed": "recipe_invariant",
}


def main(input):
    code = (input.get("error_code") or "").strip()
    return {"error_type": ERROR_MAP.get(code, "recipe_invariant")}
```

### Downstream consumption

The output pill is persisted into `{var.rev_error_type}` at step 40 (approve branch) or step 50 (reject branch) via `update_variables`. The OBS-01 emit at step 41 (or 51) passes `{var.rev_error_type}` as its `error_type` field.

The matrix rule for `recipe_failed`: error_type is `requires` — the emit must carry a non-empty error_type. Block 2's defensive default (returning `recipe_invariant` for unknown codes) guarantees that requirement holds even if STS-01 ever ships a new error_code REV-01 doesn't know about.

---

## Both blocks: shared notes

**Input normalization.** Both blocks do `(input.get("X") or "").strip()` on their string inputs. The `or ""` guards against Workato passing `None` for an unset pill (unlikely on these specific inputs but free to handle). The `.strip()` guards against trailing whitespace from upstream formula concatenations. These are belt-and-suspenders against Workato's loose typing — neither has triggered in the prior recipes' py_evals but the defensive cost is one line.

**Lowercase on Block 1 only.** Block 1 calls `.lower()` because `decision` is an analyst-facing free-text-ish value where case insensitivity is appropriate (the WFA might surface "Approve" with a capital A). Block 2 does NOT lowercase because STS-01's error codes are emitted programmatically and are guaranteed lowercase — case-folding would just hide a contract drift if STS-01 ever emitted an unexpected casing.

**No imports.** Both blocks are stdlib-free (no `json`, no `re`, no `datetime`). This matches the py_eval pattern used in UPL-01 v38 and keeps the sandbox surface area small.

**Both blocks are idempotent and side-effect-free.** Calling either block twice with the same input produces the same output, and neither block touches any external system. This means a py_eval retry (which Workato performs on transient sandbox errors) is always safe.

---

## Pre-build verification checklist

When transcribing into the Workato builder:

1. **Block 1 output schema.** Two fields: `target_state` (string, required) and `trigger_context` (string, required). The recipe's step 14 `update_variables` reads both — if the output schema is wrong, the pill picker won't surface the fields.

2. **Block 2 output schema.** One field: `error_type` (string, required). Steps 40 and 50 each read this. Make sure both py_eval instances declare the same schema (they should, since they share the same source — but the schema is declared per-action-instance in Workato, not shared).

3. **Code input declarations.** Block 1 expects one input pill `decision`. Block 2 expects one input pill `error_code`. Names must match the `input.get(...)` keys exactly — Workato's pill picker generates the input dict from these declarations.

4. **Sandbox version.** UPL-01 v38 and INV-01 ran on the same py_eval sandbox; both blocks here use only language features that work on it (dict literals, `.get`, `.strip`, `.lower`, string truthiness, `is None` check). No f-strings (Workato's py_eval supports them but the prior recipes avoid them for consistency).

5. **Logging.** Neither block writes to stdout or otherwise emits debug output. If you want runtime visibility during build, add `print()` statements temporarily and remove before shipping — Workato captures py_eval stdout in the job logs but it's noise in production.
