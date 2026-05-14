# REV-01 Analyst Review Handler — Step-Level Design

**Recipe:** REV-01 (Stage 5, callable)
**Calls:** STS-01 (sync, both branches), OBS-01 (async, for emits)
**Reads:** SUP_SupplierRequest, RUN_ValidationResult, RUN_Upload
**Writes:** SUP_SupplierRequest (approved_path, approved_at), RUN_ReviewNote
**Phases emitted:** `analyst_review_complete` (new — taxonomy addition required before build), `recipe_failed`
**Error types possible:** `recipe_invariant`, `external_action_failed`, `state_inconsistent`

> **Pre-build prerequisite.** `analyst_review_complete` is not yet in the phases taxonomy. Before REV-01 is wired in, add the row to `recipes_tracker.xlsx::phases` (Request domain, emitting_source=REV-01, typical_severity=info, error_type_rule=forbids) and update OBS-01's `PHASE_TAXONOMY` constant in lockstep per the taxonomy_meta sync rule.

---

## Section 1: Step-level outline

The outline follows the substages from the recipes-sheet, with corrections folded in (`analyst_rework` not `analyst_reject`; RUN_ReviewNote write goes before the STS-01 call per the v29 lookup mechanism; STS-01's `success` maps to REV-01's `transitioned`).

### Substage 1 — Precondition: fetch request and check state

Fetch SUP_SupplierRequest by `supplier_request_id` (from trigger). Branch:

- Zero rows returned → emit `recipe_failed` with `error_type=recipe_invariant`, return `{transitioned: false, from_state: "", to_state: "", approved_path: ""}`. This shouldn't happen — the analyst's WFA action passes the id from a row they're looking at — but the guard is cheap.
- Row found and `status != "pending_review"` → emit `recipe_failed` with `error_type=state_inconsistent`, return failure shape. The row may have been cancelled by another analyst between page load and click. This is also REV-01's idempotency guard: a second analyst clicking "approve" after the first one succeeded will find `status="approved"` and refuse cleanly.
- Row found and `status == "pending_review"` → proceed.

The fetched row is the source of `current_validation_result_id` for the approve branch, so it's kept in a recipe-level variable.

### Substage 2 — Precondition: validate inputs

Two checks against the trigger parameters:

- `decision` must be in `{approve, reject}`. Anything else → emit `recipe_failed` with `error_type=recipe_invariant`, return failure shape.
- If `decision == "reject"`, `review_note_text` must be non-empty (trim whitespace before checking — a string of spaces should fail). Empty rejection note → `recipe_failed` with `recipe_invariant`. The note is mandatory on reject because STS-01's `(supplier_action_required, analyst_rework)` derivation template will render `"The reviewer requested changes on {reviewed_at}: ."` if the note is empty — broken supplier-facing UX.
- If `decision == "approve"`, `review_note_text` is optional (per your decision to support approve-with-note).

### Substage 3 — Declare recipe-level variables

Up-front declare:

- `target_state` (string)
- `trigger_context` (string)
- `approved_at` (date_time, populated only on approve branch)
- `approved_path` (string, populated only on approve branch)
- `sts_result_success` (boolean) — bound from STS-01's return after the call
- `sts_result_new_state` (string) — bound from STS-01's return
- `sts_result_error_code` (string) — bound from STS-01's return
- `rev_error_type` (string) — populated by the STS-01 error-mapping py_eval

Same INV-01 pattern: declare at the top, populate with `update_variables` after the relevant read or call. Keeps the pill graph clean for the OBS-01 emit and the return step at the end.

### Substage 4 — Map decision to STS-01 inputs (py_eval #1)

Small py_eval that takes `decision` in, produces `target_state` and `trigger_context` out. Two-row mapping (see Section 3, Block 1). Persist results to variables via `update_variables`.

This is doable as nested IFs but the py_eval keeps the truth table in one readable place — analogous to VAL-01's verdict pre-computation pattern. The output is also self-documenting if you ever need to trace why a particular trigger_context fired.

### Substage 5 — Branch on decision

#### APPROVE branch

**5a. Resolve the submitted file path (two-hop join).**

- Read RUN_ValidationResult filtered by `validation_result_id == current_validation_result_id` (from the SUP_SupplierRequest row in substage 1). Get `upload_id`.
- Read RUN_Upload filtered by `upload_id`. Get `submitted_path`.

Either read returning zero rows → `recipe_failed` with `recipe_invariant` (broken FK chain — should be impossible if upstream ran cleanly). Persist `submitted_path` to a variable.

**5b. Compose `approved_path` and capture `approved_at`.**

- `approved_path` = `"/approved/" + supplier_request_id + "/" + upload_id + ".xlsx"` (formula mode, string concat)
- `approved_at` = `now()` — captured once here, used for both the SUP_SupplierRequest write and (if approve-with-note) the RUN_ReviewNote write, so the timestamps line up.

Persist both to variables.

**5c. Copy file in FileStorage (one monitor block wrapping two actions).**

Inside a monitor block:

- Get file contents from `submitted_path` → bytes/content variable in memory
- Create file at `approved_path` with that content

On any error inside the monitor: emit `recipe_failed` with `error_type=external_action_failed`, return failure shape. The transition does NOT fire — request stays in `pending_review` for the analyst to retry.

Wrapping both actions in one monitor (rather than two separate monitors) is intentional: semantically this is "the copy operation," atomic for our purposes. If the read succeeds but the write fails, we have no partial state to clean up — the read produced an in-memory pill that goes nowhere, and FileStorage write either committed or didn't.

This is the **commit moment for the approval** per the row's invariant. Everything after this assumes the file is in place.

**5d. Write `approved_path` and `approved_at` to SUP_SupplierRequest.**

`update_record` on SUP_SupplierRequest by `supplier_request_id`. Only `approved_path` and `approved_at` are written — NOT `status`, `current_state_entered_at`, `supplier_display_status`, or `supplier_message`, per the single-writer rule (IV-1). STS-01 owns those.

Worth flagging: this write happens BEFORE the STS-01 call. STS-01's derivation step reads `approved_at` from the SUP_SupplierRequest row to render the supplier_message template `"Your submission was approved on {approved_at}. Thank you."` — so if REV-01 calls STS-01 first, the supplier sees an empty timestamp. This ordering is mechanically required by STS-01 v29's internals.

On Data Tables write failure → `recipe_failed` with `external_action_failed`. The file is already in FileStorage and the row state is still `pending_review`; the next retry of REV-01 will overwrite `approved_path` and `approved_at` (write-once doesn't fire until status reaches `approved`, which only STS-01 can do — so retries are safe).

**5e. Optionally write RUN_ReviewNote (approve-with-note).**

If `review_note_text` is non-empty (trim-check), `add_record` on RUN_ReviewNote with:
- `supplier_request_id` = trigger param
- `author_email` = `analyst_email` from trigger
- `note_text` = `review_note_text`
- `review_action` = `"approved"`
- `created_at` = `approved_at` from variable (so the note timestamp matches the approval timestamp exactly)

Skipped entirely if the analyst didn't supply a note.

**5f. Call STS-01 synchronously.**

`call_recipe` (not async — we need the return) on STS-01 with:
- `supplier_request_id` = trigger param
- `target_state` = `"approved"` (from variable, set in substage 4)
- `trigger_context` = `"analyst_approve"` (from variable)
- `cancellation_reason` = empty (not applicable)
- `due_date_override` = empty (not applicable)

Bind STS-01's return into `sts_result_success`, `sts_result_new_state`, `sts_result_error_code` variables.

**5g. STS-01 unhappy-path mapping (py_eval #2).**

If `sts_result_success == false`: run the error-mapping py_eval (Section 3, Block 2) over `sts_result_error_code`, get `rev_error_type` back, emit `recipe_failed` with that error_type, return failure shape with `to_state` empty and `approved_path` empty (caller treats the approval as not committed).

This is the rare-but-real concurrent case: someone cancelled the request between substage 1 and the STS-01 call. The file is now in FileStorage and `approved_path`/`approved_at` are written, but the row status is `cancelled`. That's an acceptable orphan state — the file exists as evidence the approval was attempted, the row clearly shows cancelled, and the inconsistency is rare enough that manual reconciliation is fine. Documented in the failure semantics; flagged for future hardening if it ever fires in production.

#### REJECT branch

**5a. Write RUN_ReviewNote.**

`add_record` on RUN_ReviewNote with:
- `supplier_request_id` = trigger param
- `author_email` = `analyst_email` from trigger
- `note_text` = `review_note_text`
- `review_action` = `"rework"` (NOT `"reject"` — manifest enum is `approved | rework`)
- `created_at` = `now()`

This must succeed before STS-01 is called. STS-01 v29 step #40 queries RUN_ReviewNote filtered by `supplier_request_id` when `trigger_context=analyst_rework`, pulls `note_text` and `created_at` into its internal variables, and uses them as `{review_note_text}` and `{reviewed_at}` in the supplier_message template. If the note isn't written yet, STS-01 will find zero rows (or worse, a stale note from an earlier cycle — see the STS-01 finding flagged separately) and render a broken message.

On Data Tables write failure → `recipe_failed` with `external_action_failed`. Nothing else has happened yet, so failure here is clean.

**5b. Call STS-01 synchronously.**

`call_recipe` on STS-01 with:
- `supplier_request_id` = trigger param
- `target_state` = `"supplier_action_required"` (from variable)
- `trigger_context` = `"analyst_rework"` (from variable)
- `cancellation_reason` = empty
- `due_date_override` = empty

Bind STS-01's return into the same variables as the approve branch.

**5c. STS-01 unhappy-path mapping.**

Same as approve 5g — run the error-mapping py_eval, emit `recipe_failed` with the mapped error_type, return failure shape. The RUN_ReviewNote row is already written and stays as historical record (review notes are append-only per the invariant) — no rollback needed; it just becomes a note attached to a request that didn't transition.

### Substage 6 — Emit `analyst_review_complete` (success path only)

If both branches reached this point, the transition succeeded. Async `call_recipe` on OBS-01 with:

- `phase` = `"analyst_review_complete"`
- `severity` = `"info"`
- `source_recipe` = `"REV-01"`
- `step_number` = `6` (whatever the actual step number is in the built recipe — fill in at build time)
- `human_message` = composed string, something like `"Analyst {analyst_email} {decision}d submission for request {supplier_request_id}."` (concat formula)
- `supplier_request_id` = trigger param
- `analyst_email` = trigger param
- `details_json` = JSON-encoded object with `{decision, to_state, approved_path (if approve), review_note_id (if a note was written)}`
- `error_type` = empty (the matrix rule for this phase is `forbids`, since it's a success milestone)

Async because REV-01 doesn't need the OBS-01 return value — fire and forget, matching INV-01's emit pattern.

### Substage 7 — Return REV-01 result

Final `return_result` with:

- `transitioned` = `sts_result_success`
- `from_state` = `"pending_review"` (fixed — substage 1 guards this)
- `to_state` = `sts_result_new_state` (= `"approved"` or `"supplier_action_required"` on success; empty on STS-01 failure)
- `approved_path` = the variable on approve success; empty otherwise

---

## Section 2: Step inventory (flat click-order)

Format matches the `steps` sheet columns: `Recipe | Step | Action | Inputs | Outputs | Calls | Emits | On failure`.

Numbers are the substage anchor + a letter where multiple steps belong to one substage. Re-number to flat 1..N when transcribing to the steps sheet.

| Step | Action | Inputs | Outputs | Calls | Emits | On failure |
|---|---|---|---|---|---|---|
| 1 | `workato_db_table.get_records` on SUP_SupplierRequest, filter `supplier_request_id == {trigger.supplier_request_id}` | trigger.supplier_request_id | request_row (records[0]) | Data Tables API | — | If zero rows: emit `recipe_failed` (recipe_invariant); return failure shape. |
| 2 | IF `request_row.status != "pending_review"` (including the zero-rows branch) | request_row.status | — | — | `recipe_failed` (state_inconsistent OR recipe_invariant) | Return failure shape; halt. |
| 3 | IF `trigger.decision NOT IN {"approve","reject"}` | trigger.decision | — | — | `recipe_failed` (recipe_invariant) | Return failure shape; halt. |
| 4 | IF `trigger.decision == "reject"` AND `trim(trigger.review_note_text)` empty | trigger.decision, trigger.review_note_text | — | — | `recipe_failed` (recipe_invariant) | Return failure shape; halt. |
| 5 | `workato_variable.declare_variable`: target_state, trigger_context, approved_at, approved_path, sts_result_success, sts_result_new_state, sts_result_error_code, rev_error_type | — | initialized variables | — | — | — |
| 6 | `py_eval.invoke_custom_py_code` (Block 1: decision-mapping) | trigger.decision | {target_state, trigger_context} | — | — | (py_eval crash unlikely; rely on outer error handler if any.) |
| 7 | `update_variables`: target_state, trigger_context | py_eval output | persisted variables | — | — | — |
| 8 | IF `trigger.decision == "approve"` — begin APPROVE branch | trigger.decision | — | — | — | — |
| 8a | `get_records` on RUN_ValidationResult, filter `validation_result_id == request_row.current_validation_result_id` | request_row.current_validation_result_id | validation_row (records[0]) | Data Tables API | — | Zero rows: `recipe_failed` (recipe_invariant); return failure. |
| 8b | `get_records` on RUN_Upload, filter `upload_id == validation_row.upload_id` | validation_row.upload_id | upload_row (records[0]) | Data Tables API | — | Zero rows: `recipe_failed` (recipe_invariant); return failure. |
| 8c | `update_variables`: approved_path = `"/approved/" + trigger.supplier_request_id + "/" + upload_row.upload_id + ".xlsx"`; approved_at = `now()` | trigger.supplier_request_id, upload_row.upload_id | persisted approved_path, approved_at | — | — | — |
| 8d | MONITOR BLOCK START | — | — | — | — | On any error inside this monitor: emit `recipe_failed` (external_action_failed); return failure. |
| 8e | `workato_files.get_file_contents` on upload_row.submitted_path | upload_row.submitted_path | file_content (in-memory) | FileStorage API | — | (Caught by monitor.) |
| 8f | `workato_files.store_file` (UI label "Create file") at approved_path with file_content | approved_path, file_content | — | FileStorage API | — | (Caught by monitor.) |
| 8g | MONITOR BLOCK END | — | — | — | — | — |
| 8h | `update_record` on SUP_SupplierRequest by `supplier_request_id`, parameters: `approved_path`, `approved_at`. (Do NOT write status, current_state_entered_at, supplier_display_status, supplier_message.) | approved_path, approved_at, trigger.supplier_request_id | — | Data Tables API | — | `recipe_failed` (external_action_failed); return failure. File is in FileStorage; row state unchanged. |
| 8i | IF `trim(trigger.review_note_text)` non-empty: `add_record` on RUN_ReviewNote with supplier_request_id, author_email=trigger.analyst_email, note_text=trigger.review_note_text, review_action=`"approved"`, created_at=approved_at | trigger.review_note_text, trigger.analyst_email, trigger.supplier_request_id, approved_at | review_note_row | Data Tables API | — | `recipe_failed` (external_action_failed); return failure. |
| 8j | `call_recipe` (SYNC) STS-01 with: supplier_request_id, target_state=`"approved"`, trigger_context=`"analyst_approve"` | trigger.supplier_request_id, target_state, trigger_context | sts_return | STS-01 | — | `recipe_failed` (unexpected_error); return failure. |
| 8k | `update_variables`: sts_result_success, sts_result_new_state, sts_result_error_code from sts_return | sts_return | persisted variables | — | — | — |
| 8l | IF `sts_result_success == false`: py_eval Block 2 (STS-01 error-mapping), `update_variables` rev_error_type, emit `recipe_failed` (rev_error_type), return failure (transitioned=false, to_state="", approved_path="") | sts_result_error_code | rev_error_type | OBS-01 (async) | `recipe_failed` (mapped error_type) | — |
| 9 | ELSE IF `trigger.decision == "reject"` — begin REJECT branch | trigger.decision | — | — | — | — |
| 9a | `add_record` on RUN_ReviewNote with supplier_request_id, author_email=trigger.analyst_email, note_text=trigger.review_note_text, review_action=`"rework"`, created_at=`now()` | trigger.review_note_text, trigger.analyst_email, trigger.supplier_request_id | review_note_row | Data Tables API | — | `recipe_failed` (external_action_failed); return failure. |
| 9b | `call_recipe` (SYNC) STS-01 with: supplier_request_id, target_state=`"supplier_action_required"`, trigger_context=`"analyst_rework"` | trigger.supplier_request_id, target_state, trigger_context | sts_return | STS-01 | — | `recipe_failed` (unexpected_error); return failure. |
| 9c | `update_variables`: sts_result_success, sts_result_new_state, sts_result_error_code from sts_return | sts_return | persisted variables | — | — | — |
| 9d | IF `sts_result_success == false`: py_eval Block 2, emit `recipe_failed`, return failure | sts_result_error_code | rev_error_type | OBS-01 (async) | `recipe_failed` (mapped error_type) | — |
| 10 | `call_recipe_async` OBS-01 with phase=`"analyst_review_complete"`, severity=`"info"`, source_recipe=`"REV-01"`, step_number=10, human_message (composed), supplier_request_id, analyst_email, details_json (composed JSON), error_type="" | several | — | OBS-01 (async) | `analyst_review_complete` | (Async; failure not blocking. Outer error handler catches any synchronous crash.) |
| 11 | `return_result` with transitioned=sts_result_success, from_state=`"pending_review"`, to_state=sts_result_new_state, approved_path (variable; empty if reject branch) | several variables | result | — | — | — |

Notes on the inventory:

- Step numbers `8a..8l` and `9a..9d` are placeholder anchors — flatten to 8, 9, 10, 11... at transcription. The substage groupings just help while drafting.
- `update_variables` calls (steps 7, 8c, 8k, 9c) aren't strictly required but keep pill graphs clean for the OBS-01 emit and return step. Same pattern UPL-01 v38 uses.
- Per UPL-01's verified connector idioms: Data Tables row creation is `add_record` (not `create_record`); FileStorage write technical name is `workato_files.store_file` even when the UI labels it "Create file."
- Step 10's `details_json` composition: a small formula expression building the JSON string in-line, or a third small py_eval if you prefer — both work. INV-01's pattern was an inline formula; I'd follow that here unless the field list grows.

---

## Section 3: Python blocks

### Block 1 — Decision mapping (target_state and trigger_context from decision)

Used in step 6. Input pill: `decision`. Output schema: `target_state` (string), `trigger_context` (string).

```python
# REV-01 decision mapping
# decision -> (target_state, trigger_context)
# Source of truth: STS-01 v29 trigger_context enum + REV-01 substage 4.
# Note: "rework" is the state-machine term; "reject" is colloquial analyst-facing.

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
        # Substage 2 should have caught this; defensive fallback.
        return {"target_state": "", "trigger_context": ""}
    return {
        "target_state": mapping["target_state"],
        "trigger_context": mapping["trigger_context"],
    }
```

Output schema JSON:

```json
[
  {"name": "target_state", "type": "string", "optional": false, "label": "target_state", "control_type": "text"},
  {"name": "trigger_context", "type": "string", "optional": false, "label": "trigger_context", "control_type": "text"}
]
```

### Block 2 — STS-01 error_code mapping (rev_error_type from sts_result_error_code)

Used in steps 8l and 9d. Input pill: `error_code`. Output schema: `error_type` (string).

```python
# REV-01 STS-01 unhappy-path mapping
# STS-01 v29 return.error_code -> REV-01 OBS-01 error_type.
# illegal_transition -> state_inconsistent (concurrent state change, e.g., cancellation
#   between REV-01's precondition check and the STS-01 call).
# Everything else -> recipe_invariant (system in a state that "shouldn't be possible"
#   given REV-01's preconditions ran cleanly).

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

Output schema JSON:

```json
[
  {"name": "error_type", "type": "string", "optional": false, "label": "error_type", "control_type": "text"}
]
```

---

## Failure semantics summary

| Where it fails | Phase emitted | error_type | Side effects left behind | Retry safe? |
|---|---|---|---|---|
| Substage 1 (request not found) | recipe_failed | recipe_invariant | none | yes |
| Substage 1 (wrong state) | recipe_failed | state_inconsistent | none | yes — retry won't help unless state changes |
| Substage 2 (bad decision) | recipe_failed | recipe_invariant | none | yes — retry with fixed input |
| Substage 2 (missing reject note) | recipe_failed | recipe_invariant | none | yes — retry with note |
| Approve 5a/5b (FK chain broken) | recipe_failed | recipe_invariant | none | no — upstream data integrity issue |
| Approve 5c (file copy) | recipe_failed | external_action_failed | none | yes |
| Approve 5d (DB write of approved_path/at) | recipe_failed | external_action_failed | file in FileStorage at approved_path | yes — retry overwrites approved_path/at since status still pending_review (write-once doesn't fire) |
| Approve 5e (note write) | recipe_failed | external_action_failed | file in FileStorage; approved_path/at written | yes — retry behavior same as above |
| Approve 5f (STS-01 sync call crashes) | recipe_failed | unexpected_error | file in FileStorage; approved_path/at written | yes — STS-01's own state check guards re-entry |
| Approve 5g (STS-01 returns success=false) | recipe_failed | mapped (state_inconsistent or recipe_invariant) | file in FileStorage; approved_path/at written; row state unchanged | depends on STS-01 error code; documented as known orphan case |
| Reject 5a (note write fails) | recipe_failed | external_action_failed | none | yes |
| Reject 5b (STS-01 sync call crashes) | recipe_failed | unexpected_error | RUN_ReviewNote row written | yes — STS-01 will pick up the same note on retry (review notes are append-only; this would create a duplicate note. See note below.) |
| Reject 5c (STS-01 returns success=false) | recipe_failed | mapped | RUN_ReviewNote row written | same caveat as 5b |

**Note on reject-path retry and duplicate notes.** If REV-01's reject branch writes RUN_ReviewNote successfully but the STS-01 call then fails (either crashes or returns success=false), retrying REV-01 will write a second RUN_ReviewNote row. Since RUN_ReviewNote is append-only (per the invariant), both rows persist. The current STS-01 v29 lookup (step #40) is `order_direction=asc, limit=100` and would not reliably pick the most recent — this compounds the latent issue I flagged in the prior message. Two cleanups would fix it together: REV-01's reject branch could check for an existing RUN_ReviewNote within the last few seconds before writing (cheap idempotency), OR STS-01's RUN_ReviewNote query could be tightened to `order_direction=desc, limit=1`. The STS-01 fix is the right place — REV-01 shouldn't carry compensating logic for another recipe's pickiness. Filing as a STS-01 finding; not in scope for REV-01 v1.

---

## Open items to track separately (not REV-01 design issues)

1. **Taxonomy addition** (blocker before build): add `analyst_review_complete` to `phases` sheet and OBS-01's `PHASE_TAXONOMY`.
2. **Recipes-sheet sweep** for REV-01 row: `analyst_reject` → `analyst_rework`; remove `context_bag={review_note_text}`; clarify `decision=reject` should be `review_action=rework` in the RUN_ReviewNote write line.
3. **STS-01 finding**: step #40 `get_records` on RUN_ReviewNote should be `order_direction=desc, limit=1` (currently `asc, limit=100`). Becomes relevant once any rework-resubmit-rework cycle exists in the wild.
