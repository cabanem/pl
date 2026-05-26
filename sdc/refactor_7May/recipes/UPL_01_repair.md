# UPL-01 Repair — `error` verdict no longer dead-ends (backlog 4b, option a)

**Recipe:** UPL-01 File submission intake
**Problem:** Step 19 maps verdict `error` (and any unexpected verdict) to `trigger_context = "pipeline_error_alert"`, which is **not** in STS-01's legal transition table. STS-01 returns `illegal_transition`, `sts_result_success` is false, and the recipe silently skips both the analyst-share and the INV-01a task assignment. The submission dead-ends with only STS-01's `illegal_transition` event as a trace.
**Fix (option a):** On an `error`/unexpected verdict, emit an OBS-01 alert and exit **without** calling STS-01. State machine and its source-of-truth doc are untouched.

---

## Change 1 — Step 19 Python (alias `da59fe87`, "Map verdict to target state for STS-01")

Replace the whole script with the version below. Difference from current: the `error` and fallback cases no longer fabricate a fake transition; they set `is_error = True` and leave `trigger_context` empty. `passed` / `failed` / `empty` / `structural_failure` behavior is unchanged.

```python
def main(data):
    verdict = data.get("verdict", "")
    prior_status = data.get("prior_status", "")

    if verdict == "passed":
        return {"target_state": "pending_review",
                "trigger_context": "system_validation_passed",
                "is_error": False,
                "verdict": verdict}

    if verdict in {"failed", "empty", "structural_failure"}:
        return {"target_state": "supplier_action_required",
                "trigger_context": "system_validation_failed",
                "is_error": False,
                "verdict": verdict}

    # verdict == "error" OR anything unexpected: do NOT transition state.
    # Signal the recipe to alert and exit instead of calling STS-01.
    # (Routing the catch-all here too means any future verdict drift surfaces
    # loudly in OBS-01 rather than dead-ending on an illegal transition.)
    return {"target_state": prior_status,
            "trigger_context": "",
            "is_error": True,
            "verdict": verdict}
```

**Also update step 19's output schema** — add two fields:

| name | type |
|---|---|
| `is_error` | boolean |
| `verdict` | string |

(`target_state` and `trigger_context` stay as they are. `code_input` is unchanged — it already passes `verdict` and `prior_status`.)

---

## Change 2 — Insert an error branch immediately after step 19

Add one `IF` step between step 19 and step 20. Everything that exists today (steps 20 → 21 → 22 → the `sts_result_success` IF → step 31 RETURN) stays exactly as-is and runs only when `is_error` is false.

```
19. PYTHON  [da59fe87]            (edited above)

[IF]  da59fe87.is_error  is_true                 // NEW — pipeline error: alert, do not transition
    A. OBS-01 Event emitter  (async call)        // NEW
         severity            = "error"
         phase               = "recipe_failed"
         error_type          = "unexpected_error"
         source_recipe       = "UPL-01"
         step_number         = 19
         supplier_request_id = <trigger supplier_request_id pill>   (same pill step 21 uses)
         human_message       = "Validation pipeline returned an error verdict; state not changed."
         details_json        = {"verdict": da59fe87.verdict}        // optional but useful
    B. Stop / Return ok                          // NEW — exit cleanly, no STS-01 call

20. VAR  target_state / val01_trigger_context    (existing — unchanged)
21. SYNC CALL STS-01                             (existing — unchanged)
22. VAR  sts_result_success                      (existing — unchanged)
[IF] sts_result_success is_true … share + INV-01a … (existing — unchanged)
31. RETURN ok                                    (existing — unchanged)
```

**Editor note:** because the new `IF` branch ends in a Stop/return, steps 20–31 simply fall through when `is_error` is false — you do **not** need to wrap 20–31 in an explicit `ELSE`. (Wrap them in an `ELSE` instead if you find that clearer; both behave identically.)

---

## Field values — why these

- `error_type = "unexpected_error"` — in OBS-01's `ERROR_TYPE_TAXONOMY` (verified in the contract sweep). If VAL-01 ever returns a more specific reason for the error, thread that through instead; `unexpected_error` is the safe, taxonomy-valid default.
- `phase = "recipe_failed"` — the convention every other catch-path OBS-01 emit in the batch uses.
- `severity = "error"` — matches the verdict.
- The `supplier_request_id` pill is the same one step 21 (STS-01 call) already references — reuse it.

## What does NOT change

- STS-01 — no table edit, no `pipeline_error_alert` added. (That's option b, deliberately not taken.)
- `sdc-state-machines-v1.md` — untouched (no doc-sync needed, the win of option a).
- The `passed` / `failed` / `empty` / `structural_failure` paths through STS-01 — identical behavior.

## Verify after implementing

1. Force a VAL-01 `error` verdict → confirm one OBS-01 `recipe_failed` / `unexpected_error` event from UPL-01 step 19, STS-01 **not** called, recipe returns ok.
2. Confirm `passed` still reaches `pending_review` + analyst share + INV-01a.
3. Confirm `failed` still reaches `supplier_action_required` + supplier re-assignment.
