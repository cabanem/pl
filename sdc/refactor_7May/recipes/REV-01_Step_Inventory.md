# REV-01 Step Inventory

**Recipe:** REV-01 Analyst review handler
**Target version:** v1 (initial build)
**Companion docs:** `rev_01_step_level_outline.md` (substage rationale), `rev_01_python_blocks.md` (full py_eval source)

Flat, click-order step listing for the Workato builder. Numbers are sequential through the recipe tree (top-down, depth-first — matching how Workato numbers the steps panel). Each step block lists the connector + action, inputs (pill sources or formulas), outputs (pill names downstream steps reference), any synchronous calls, OBS-01 emits, and the failure behavior.

**Conventions used in this document.**

- Pills are shown in `{step_N.field_name}` form where step_N is the producing step. Trigger pills are `{trigger.field_name}`. Variable pills are `{var.name}`.
- "Formula" indicates a Workato formula-mode expression; "Pill" indicates direct datapill reference.
- Where the inventory says "concat formula," the choice between `"/approved/" + a + "/" + b + ".xlsx"` and pill-interpolation `/approved/{a}/{b}.xlsx` is build-time preference; both produce the same string.
- IF / ELSE IF / ELSE / MONITOR blocks are their own steps in Workato — they take a sequential number and their children sit beneath them in the tree.

---

## Step 0 — Trigger

**Action:** `workato_recipe_function.execute` (function trigger, callable recipe shape)

**Parameter schema (trigger inputs, per the recipes-sheet):**

| Name | Type | Required | Notes |
|---|---|---|---|
| `supplier_request_id` | string | yes | PK of the SUP_SupplierRequest row to act on |
| `decision` | string | yes | `approve` \| `reject` (analyst-facing values; reject maps to state-machine `rework`) |
| `review_note_text` | string | conditional | Required when `decision=reject`; optional when `decision=approve` |
| `analyst_email` | string | yes | The analyst taking the action; written to RUN_ReviewNote.author_email |

**Result schema (recipe return):**

| Name | Type | Notes |
|---|---|---|
| `transitioned` | boolean | Bound from STS-01's `success` field |
| `from_state` | string | Always `pending_review` (substage 1 guards this) |
| `to_state` | string | `approved` or `supplier_action_required` on success; empty on failure |
| `approved_path` | string | Populated only on approve success; empty otherwise |

---

## Substage 1 — Precondition: fetch request and check state

### Step 1 — Fetch SUP_SupplierRequest

**Action:** `workato_db_table.get_records` on SUP_SupplierRequest
**Filter:** `supplier_request_id` equals `{trigger.supplier_request_id}`
**Limit:** 1
**Outputs:** `{step_1.records}` — the matched row (zero or one), accessed as `records.first`
**On failure (Data Tables crash):** Propagates; recipe terminates unhandled.

### Step 2 — IF zero rows OR status ≠ pending_review

**Action:** `if` block
**Condition:** `{step_1.records.size}` equals `0` OR `{step_1.records.first.status}` not equal to `pending_review`

Children (steps 3–4) execute when condition true.

### Step 3 — Emit recipe_failed (state guard)

**Action:** `workato_recipe_function.call_recipe_async` on OBS-01
**Inputs:**
- `phase` = `recipe_failed`
- `severity` = `error`
- `error_type` = formula: `{step_1.records.size}` equals `0` → `recipe_invariant`; else → `state_inconsistent`
- `source_recipe` = `REV-01`
- `step_number` = `3`
- `human_message` = formula composing: `Request {trigger.supplier_request_id} not found.` OR `Request {trigger.supplier_request_id} not in pending_review (current: {step_1.records.first.status}).`
- `supplier_request_id` = `{trigger.supplier_request_id}`
- `analyst_email` = `{trigger.analyst_email}`
- `details_json` = `{}` (or a minimal JSON with current status)

**Emits:** `recipe_failed`

### Step 4 — Return failure shape

**Action:** `workato_recipe_function.return_result`
**Inputs:** `transitioned` = false, `from_state` = empty, `to_state` = empty, `approved_path` = empty

---

## Substage 2 — Precondition: input validation

### Step 5 — IF decision NOT IN {approve, reject}

**Action:** `if` block
**Condition:** `{trigger.decision}` not equals `approve` AND `{trigger.decision}` not equals `reject`

### Step 6 — Emit recipe_failed (bad decision)

**Action:** `workato_recipe_function.call_recipe_async` on OBS-01
**Inputs:** same shape as step 3, with `error_type` = `recipe_invariant`, `human_message` = `Decision "{trigger.decision}" not in {approve, reject}.`, `step_number` = `6`
**Emits:** `recipe_failed`

### Step 7 — Return failure shape

**Action:** `return_result` with failure shape (same as step 4).

### Step 8 — IF reject and empty note

**Action:** `if` block
**Condition:** `{trigger.decision}` equals `reject` AND `trim({trigger.review_note_text})` is blank

### Step 9 — Emit recipe_failed (missing note)

**Action:** `call_recipe_async` on OBS-01
**Inputs:** `error_type` = `recipe_invariant`, `human_message` = `Reject requires non-empty review_note_text.`, `step_number` = `9`
**Emits:** `recipe_failed`

### Step 10 — Return failure shape

**Action:** `return_result` with failure shape.

---

## Substage 3 — Declare recipe-level variables

### Step 11 — Declare variables

**Action:** `workato_variable.declare_variable`
**Variables declared:**

| Name | Type | Initial |
|---|---|---|
| `target_state` | string | empty |
| `trigger_context` | string | empty |
| `approved_at` | date_time | nil |
| `approved_path` | string | empty |
| `sts_result_success` | boolean | false |
| `sts_result_new_state` | string | empty |
| `sts_result_error_code` | string | empty |
| `rev_error_type` | string | empty |
| `review_note_id` | string | empty |

(`review_note_id` is captured if a RUN_ReviewNote row is written, for inclusion in the analyst_review_complete details_json.)

---

## Substage 4 — Decision mapping (py_eval Block 1)

### Step 12 — py_eval: decision mapping

**Action:** `py_eval.invoke_custom_py_code`
**Name:** `Map decision to STS-01 inputs`
**Code:** See `rev_01_python_blocks.md` — Block 1.
**Code input:**
- `decision` (string) ← `{trigger.decision}`

**Code output schema:** `target_state` (string), `trigger_context` (string)
**Outputs:** `{step_12.target_state}`, `{step_12.trigger_context}`

### Step 13 — Persist target_state and trigger_context

**Action:** `workato_variable.update_variables`
**Inputs:**
- `target_state` ← `{step_12.target_state}`
- `trigger_context` ← `{step_12.trigger_context}`

---

## Substage 5 — Branch on decision

### Step 14 — IF decision == approve

**Action:** `if` block
**Condition:** `{trigger.decision}` equals `approve`

Children (steps 15–37) execute on approve.

#### Step 15 — Fetch RUN_ValidationResult

**Action:** `workato_db_table.get_records` on RUN_ValidationResult
**Filter:** `validation_result_id` equals `{step_1.records.first.current_validation_result_id}`
**Limit:** 1
**Outputs:** `{step_15.records}`

#### Step 16 — IF zero rows (broken FK chain — validation result)

**Action:** `if` block
**Condition:** `{step_15.records.size}` equals `0`

##### Step 17 — Emit recipe_failed (missing validation result)

**Action:** `call_recipe_async` on OBS-01
**Inputs:** `error_type` = `recipe_invariant`, `human_message` = `RUN_ValidationResult {step_1.records.first.current_validation_result_id} not found for request {trigger.supplier_request_id}.`, `step_number` = `17`
**Emits:** `recipe_failed`

##### Step 18 — Return failure shape

**Action:** `return_result` with failure shape.

#### Step 19 — Fetch RUN_Upload

**Action:** `workato_db_table.get_records` on RUN_Upload
**Filter:** `upload_id` equals `{step_15.records.first.upload_id}`
**Limit:** 1
**Outputs:** `{step_19.records}` (carries `submitted_path`, `upload_id`)

#### Step 20 — IF zero rows (broken FK chain — upload)

**Action:** `if` block
**Condition:** `{step_19.records.size}` equals `0`

##### Step 21 — Emit recipe_failed (missing upload)

**Action:** `call_recipe_async` on OBS-01
**Inputs:** `error_type` = `recipe_invariant`, `human_message` = `RUN_Upload {step_15.records.first.upload_id} not found.`, `step_number` = `21`
**Emits:** `recipe_failed`

##### Step 22 — Return failure shape

**Action:** `return_result` with failure shape.

#### Step 23 — Compose approved_path and capture approved_at

**Action:** `workato_variable.update_variables`
**Inputs:**
- `approved_path` ← formula: `/approved/{trigger.supplier_request_id}/{step_19.records.first.upload_id}.xlsx`
- `approved_at` ← formula: `now` (Workato datetime now)

Note: capturing `approved_at` once here and reusing it for both the SUP_SupplierRequest write (step 27) and the optional RUN_ReviewNote write (step 29) keeps the two timestamps identical, which is useful for downstream traceability.

#### Step 24 — Monitor block (FileStorage copy)

**Action:** `monitor` block
**Scope:** the two-action file copy (steps 25–26)
**On error:** branch to steps 27–28 (catch handler).

##### Step 25 — Read submitted file

**Action:** `workato_files.get_file_contents`
**Inputs:** path = `{step_19.records.first.submitted_path}`
**Outputs:** `{step_25.file_content}` (in-memory bytes/content pill)
**On failure:** caught by monitor (step 24).

##### Step 26 — Create approved file

**Action:** `workato_files.store_file` (UI label: "Create file")
**Inputs:** path = `{var.approved_path}`, content = `{step_25.file_content}`, overwrite = `false`
**Outputs:** (none used downstream — fire-and-confirm)
**On failure:** caught by monitor (step 24).

##### Step 27 — Catch: emit recipe_failed (file copy)

**Action:** `call_recipe_async` on OBS-01 (inside monitor's catch branch)
**Inputs:** `error_type` = `external_action_failed`, `human_message` = `FileStorage copy failed for request {trigger.supplier_request_id}: {step_19.records.first.submitted_path} → {var.approved_path}.`, `step_number` = `27`, `details_json` = JSON with `{submitted_path, approved_path}`
**Emits:** `recipe_failed`

##### Step 28 — Catch: return failure shape

**Action:** `return_result` with failure shape (approved_path empty, since the copy didn't commit).

#### Step 29 — Write approved_path and approved_at to SUP_SupplierRequest

**Action:** `workato_db_table.update_record` on SUP_SupplierRequest
**Inputs:**
- `record_id` = `{trigger.supplier_request_id}`
- `parameters`:
  - `approved_path` = `{var.approved_path}`
  - `approved_at` = `{var.approved_at}`
- **Do NOT include:** `status`, `current_state_entered_at`, `supplier_display_status`, `supplier_message`. Those are STS-01's territory (single-writer rule).

**On failure (Data Tables crash):** Propagates; recipe terminates unhandled. The file is in FileStorage at `approved_path`, status remains `pending_review`. Retry of REV-01 is safe — write-once doesn't fire until status reaches `approved`, which only STS-01 can do.

#### Step 30 — IF review_note_text non-empty (approve-with-note)

**Action:** `if` block
**Condition:** `trim({trigger.review_note_text})` is present (non-blank)

##### Step 31 — Write RUN_ReviewNote (approved)

**Action:** `workato_db_table.add_record` on RUN_ReviewNote
**Inputs:**
- `review_note_id` = formula: new UUID
- `supplier_request_id` = `{trigger.supplier_request_id}`
- `author_email` = `{trigger.analyst_email}`
- `note_text` = `{trigger.review_note_text}`
- `review_action` = `approved`
- `created_at` = `{var.approved_at}` (intentional reuse so the note timestamp equals the approval timestamp)

**Outputs:** `{step_31.records.first.review_note_id}` — captured to variable in step 32.

##### Step 32 — Persist review_note_id

**Action:** `update_variables`
**Inputs:** `review_note_id` ← `{step_31.records.first.review_note_id}`

#### Step 33 — Call STS-01 (sync)

**Action:** `workato_recipe_function.call_recipe`
**Recipe:** STS-01 Status change handler
**Parameters:**
- `supplier_request_id` = `{trigger.supplier_request_id}`
- `target_state` = `{var.target_state}` (will be `approved`)
- `trigger_context` = `{var.trigger_context}` (will be `analyst_approve`)
- `cancellation_reason` = empty
- `due_date_override` = empty

**Outputs:** `{step_33.result}` — STS-01's return object (`success`, `prior_state`, `new_state`, `display_status`, `display_message`, `error_code`, `error_message`)

**On failure (STS-01 crash, not logical failure):** Propagates; recipe terminates unhandled. File is in FileStorage; `approved_path`/`approved_at` already written; row state unchanged. Documented orphan case (see outline doc).

#### Step 34 — Persist STS-01 return

**Action:** `update_variables`
**Inputs:**
- `sts_result_success` ← `{step_33.result.success}`
- `sts_result_new_state` ← `{step_33.result.new_state}`
- `sts_result_error_code` ← `{step_33.result.error_code}`

#### Step 35 — IF sts_result_success == false (logical failure)

**Action:** `if` block
**Condition:** `{var.sts_result_success}` equals `false`

##### Step 36 — py_eval: map STS-01 error_code to REV-01 error_type

**Action:** `py_eval.invoke_custom_py_code`
**Name:** `Map STS-01 error_code to REV-01 error_type`
**Code:** See `rev_01_python_blocks.md` — Block 2.
**Code input:**
- `error_code` ← `{var.sts_result_error_code}`

**Code output schema:** `error_type` (string)

##### Step 37 — Persist mapped error_type

**Action:** `update_variables`
**Inputs:** `rev_error_type` ← `{step_36.error_type}`

##### Step 38 — Emit recipe_failed (STS-01 logical failure)

**Action:** `call_recipe_async` on OBS-01
**Inputs:** `error_type` = `{var.rev_error_type}`, `human_message` = `STS-01 refused transition for request {trigger.supplier_request_id}: {step_33.result.error_code} — {step_33.result.error_message}`, `step_number` = `38`, `details_json` = JSON with STS-01's return fields
**Emits:** `recipe_failed`

##### Step 39 — Return failure shape

**Action:** `return_result` with `transitioned` = `false`, `from_state` = `pending_review`, `to_state` = empty, `approved_path` = empty.

(Note: `approved_path` is returned empty even though we wrote it to the row, because from the caller's perspective the approval didn't commit. The orphan write is documented.)

### Step 40 — ELSE IF decision == reject

**Action:** `else if` block
**Condition:** `{trigger.decision}` equals `reject`

Children (steps 41–49) execute on reject.

#### Step 41 — Write RUN_ReviewNote (rework)

**Action:** `workato_db_table.add_record` on RUN_ReviewNote
**Inputs:**
- `review_note_id` = formula: new UUID
- `supplier_request_id` = `{trigger.supplier_request_id}`
- `author_email` = `{trigger.analyst_email}`
- `note_text` = `{trigger.review_note_text}`
- `review_action` = `rework` (NOT `reject` — manifest enum is `approved | rework`)
- `created_at` = `now`

**Outputs:** `{step_41.records.first.review_note_id}` — captured in step 42.

**On failure:** Data Tables crash propagates; nothing else has happened, so no cleanup needed.

#### Step 42 — Persist review_note_id

**Action:** `update_variables`
**Inputs:** `review_note_id` ← `{step_41.records.first.review_note_id}`

#### Step 43 — Call STS-01 (sync)

**Action:** `workato_recipe_function.call_recipe`
**Recipe:** STS-01
**Parameters:**
- `supplier_request_id` = `{trigger.supplier_request_id}`
- `target_state` = `{var.target_state}` (will be `supplier_action_required`)
- `trigger_context` = `{var.trigger_context}` (will be `analyst_rework`)
- `cancellation_reason` = empty
- `due_date_override` = empty

**Outputs:** `{step_43.result}`

**On failure (STS-01 crash):** Propagates. RUN_ReviewNote row already written; row state unchanged.

#### Step 44 — Persist STS-01 return

**Action:** `update_variables` (same shape as step 34, sourced from `{step_43.result}`)

#### Step 45 — IF sts_result_success == false

**Action:** `if` block
**Condition:** `{var.sts_result_success}` equals `false`

##### Step 46 — py_eval: error_code mapping (same as step 36)

**Action:** `py_eval.invoke_custom_py_code` with Block 2.
**Code input:** `error_code` ← `{var.sts_result_error_code}`

##### Step 47 — Persist mapped error_type

**Action:** `update_variables`
**Inputs:** `rev_error_type` ← `{step_46.error_type}`

##### Step 48 — Emit recipe_failed (STS-01 logical failure, reject)

**Action:** `call_recipe_async` on OBS-01
**Inputs:** `error_type` = `{var.rev_error_type}`, `human_message` = (same shape as step 38, reject context), `step_number` = `48`
**Emits:** `recipe_failed`

##### Step 49 — Return failure shape

**Action:** `return_result` with failure shape.

---

## Substage 6 — Emit success event

### Step 50 — Emit analyst_review_complete

**Action:** `workato_recipe_function.call_recipe_async` on OBS-01
**Inputs:**
- `phase` = `analyst_review_complete`
- `severity` = `info`
- `error_type` = empty (the matrix rule for this phase is `forbids`)
- `source_recipe` = `REV-01`
- `step_number` = `50`
- `human_message` = formula composing: `Analyst {trigger.analyst_email} {trigger.decision}d submission for request {trigger.supplier_request_id} → {var.sts_result_new_state}.`
- `supplier_request_id` = `{trigger.supplier_request_id}`
- `analyst_email` = `{trigger.analyst_email}`
- `details_json` = formula composing JSON: `{"decision": "{trigger.decision}", "to_state": "{var.sts_result_new_state}", "approved_path": "{var.approved_path}", "review_note_id": "{var.review_note_id}"}` (approved_path empty on reject; review_note_id empty if no note written on approve)

**Emits:** `analyst_review_complete`

(Async, fire-and-forget. Matches INV-01's emit pattern.)

---

## Substage 7 — Return success

### Step 51 — Return success shape

**Action:** `workato_recipe_function.return_result`
**Inputs:**
- `transitioned` = `{var.sts_result_success}` (will be `true` since we reached this step)
- `from_state` = `pending_review` (constant)
- `to_state` = `{var.sts_result_new_state}`
- `approved_path` = `{var.approved_path}` (populated on approve; empty on reject)

---

## Step count summary

51 sequential steps. Distribution:

| Substage | Steps | Notes |
|---|---|---|
| Trigger | 0 | function shape |
| 1 — state precondition | 1–4 | fetch + IF guard + emit + return |
| 2 — input validation | 5–10 | two early-exit guards |
| 3 — declare variables | 11 | nine variables |
| 4 — decision mapping | 12–13 | py_eval + persist |
| 5 — approve branch | 14–39 | 26 steps including FileStorage monitor and STS-01 sync |
| 5 — reject branch | 40–49 | 10 steps |
| 6 — success emit | 50 | OBS-01 async |
| 7 — return success | 51 | final return |

The largest section by far is the approve branch (steps 14–39, ~26 steps). The bulk of that is the precondition fan-out (two FK chase reads with their own zero-row guards) and the FileStorage monitor with its catch handler. If transcription pressure is high, the two FK-chase reads could be collapsed to a single "fetch upload via validation result join" if you want to introduce a Data Tables search expression — but per your call to keep the two-hop explicit, the inventory shows them separately.

---

## Cross-reference: connector actions used

| Action | Used in steps | Notes |
|---|---|---|
| `workato_db_table.get_records` | 1, 15, 19 | Three reads: request, validation result, upload |
| `workato_db_table.update_record` | 29 | SUP_SupplierRequest write (approved_path, approved_at only) |
| `workato_db_table.add_record` | 31, 41 | RUN_ReviewNote (conditional approve-with-note; mandatory on reject) |
| `workato_files.get_file_contents` | 25 | Read submitted file bytes |
| `workato_files.store_file` | 26 | Create approved file (UI label "Create file") |
| `workato_variable.declare_variable` | 11 | Single declare with nine variables |
| `workato_variable.update_variables` | 13, 23, 32, 34, 37, 42, 44, 47 | Eight persistence points |
| `py_eval.invoke_custom_py_code` | 12, 36, 46 | Two distinct blocks (Block 2 used twice — same code, two call sites) |
| `workato_recipe_function.call_recipe` | 33, 43 | Synchronous STS-01 calls |
| `workato_recipe_function.call_recipe_async` | 3, 6, 9, 17, 21, 27, 38, 48, 50 | All OBS-01 emits |
| `workato_recipe_function.return_result` | 4, 7, 10, 18, 22, 28, 39, 49, 51 | Nine return points (eight failure shapes + one success shape) |

---

## Open prerequisites (repeated from outline doc)

1. **Taxonomy addition** (blocker before build): `analyst_review_complete` to `phases` sheet + OBS-01's `PHASE_TAXONOMY`.
2. **Recipes-sheet sweep** for REV-01 row: `analyst_reject` → `analyst_rework`; remove `context_bag={review_note_text}`; correct the `decision=reject` reference to `review_action=rework` in the RUN_ReviewNote write line.

Once those are in, the inventory above is ready for click-through.
