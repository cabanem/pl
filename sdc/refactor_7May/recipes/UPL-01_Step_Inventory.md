# UPL-01 — File submission intake (step-level outline, draft v1)

A trigger recipe that fires on supplier file uploads. Listens to SUP_SupplierRequest via a Data Tables column-change trigger, filtered to events where the `pending_upload_file` field (a Data Tables file column on SUP_SupplierRequest) is non-empty. Bridges the supplier's submission from the Data Tables file column into FileStorage, persists a RUN_Upload row, invokes VAL-01 synchronously, and routes the resulting verdict to STS-01.

This outline is the spec one level deeper than the recipes-sheet substage outline: substage numbers, action types, input/output pill shapes, comments. Workato pill paths, column UUIDs, and exact field-name strings get filled at builder time.

---

## Recipe meta

- **Name:** UPL-01 File submission intake
- **Version:** 1 (initial)
- **Private:** true
- **Concurrency:** 1
- **Tags:** `["upload", "review_and_submit"]`

**Trigger** — not a callable. Workato `workato_db_table.new_records_realtime` on SUP_SupplierRequest, filtered to fire only when the `pending_upload_file` file column is non-empty.

The trigger event delivers a record pill containing the full SUP_SupplierRequest row, including the file column (which surfaces as an object with `filename` and `file_content` properties — ALT-01's pattern verbatim).

**Return** — UPL-01 is a trigger, so the recipe ends with `return_result` taking no parameters. There is no caller consuming a return value.

---

## Connectors used

- `workato_db_table` — `new_records_realtime` (trigger), `get_records` on SUP_SupplierRequest, `create_record` on RUN_Upload, `update_record` on SUP_SupplierRequest
- `workato_files` — `upload_file` (or workspace equivalent) to write supplier bytes to FileStorage
- `workato_recipe_function` — `call_recipe` (VAL-01, synchronous), `call_recipe_async` (STS-01, OBS-01)
- `workato_variable` — recipe-level state across substages
- `py_eval` — verdict-to-target_state mapping after VAL-01

---

## Recipe-level constants

| constant | value | notes |
|---|---|---|
| `SOURCE_RECIPE` | `"UPL-01"` | Passed as `source_recipe` on every OBS-01 call. |
| `UPLOAD_PATH_PREFIX` | `"/uploads"` | FileStorage root for supplier submissions. Per-request paths land under `<prefix>/<supplier_request_id>/<upload_id>.xlsx`. |
| `SUBMISSION_SOURCE_FILE` | `"file"` | The submission_source value VAL-01 expects for XLSX uploads (distinct from `"manual_entry"`). |

---

## Recipe-level variables

Declared at the top via `workato_variable.declare_variable` (matching ALT-01's pattern). Updated through the recipe via `update_variables`. Reset on every invocation.

| variable | type | initial | purpose |
|---|---|---|---|
| `upload_id` | string | `=workato.uuid` | Freshly minted UUID for this upload attempt. Used as the RUN_Upload PK, the FileStorage path discriminator, and the `upload_id` passed to VAL-01. |
| `supplier_request_id` | string | `""` | PK of the SUP_SupplierRequest row. Captured from the trigger pill in substage 1. |
| `prior_status` | string | `""` | The `status` value at trigger time. Used for state-eligibility check and (on `error` verdict) as the target_state for the refresh-only STS-01 call. |
| `assigned_version_id` | string | `""` | From the request row. Frozen onto RUN_Upload at creation per the "frozen at issuance" invariant. |
| `prior_submission_attempt` | integer | 0 | Current `submission_attempt` value on the request row. Incremented in substage 5. |
| `submitted_file_path` | string | `""` | FileStorage path where bytes were written. Stored on RUN_Upload as `submitted_path`. |
| `submitted_filename` | string | `""` | Original filename from the Data Tables file column, preserved for audit (and possibly carried onto RUN_Upload if that table grows a `submitted_filename` column later). |
| `verdict` | string | `""` | VAL-01's verdict (`passed | failed | empty | structural_failure | error`). |
| `validation_result_id` | string | `""` | From VAL-01. Written to SUP_SupplierRequest as `current_validation_result_id` in substage 7. |
| `valid_row_count` | integer | 0 | From VAL-01. Denormalized onto SUP_SupplierRequest. |
| `invalid_row_count` | integer | 0 | From VAL-01. Denormalized onto SUP_SupplierRequest. |
| `val01_trigger_context` | string | `""` | From VAL-01's pre-computed mapping. Passed through verbatim to STS-01. |
| `target_state` | string | `""` | Resolved from `verdict` in substage 8: `passed → pending_review`; `failed | empty | structural_failure → supplier_action_required`; `error → prior_status` (refresh-only). |

---

## Substage 1 — Trigger and context capture

The trigger delivers a record pill containing all of SUP_SupplierRequest's fields, including the file column. No separate get_records is strictly required, but the recipes-sheet's "read request, verify state" step is cleaner expressed as an explicit capture for downstream pill clarity.

**Step 1.1 — Trigger declaration.**
Action: `workato_db_table.new_records_realtime`
Table: SUP_SupplierRequest
Filter: `pending_upload_file.file_content present`

The filter pattern follows ALT-01 verbatim — Workato's filter operand `present` against the `file_content` property of the file-column object. Spurious row updates that don't touch the file column won't fire UPL-01 because the filter evaluates the file column's content directly, not just "any change."

**Step 1.2 — Declare recipe variables.**
Action: `workato_variable.declare_variable`
Sets `upload_id = workato.uuid`, plus the empty/default initial values from the table above.

**Step 1.3 — Capture trigger fields into variables.**
Action: `workato_variable.update_variables`
Sets:
- `supplier_request_id` from the trigger pill's PK column
- `prior_status` from `record.status`
- `assigned_version_id` from `record.assigned_version_id`
- `prior_submission_attempt` from `record.submission_attempt` (defaulting to 0 if null)
- `submitted_filename` from `record.pending_upload_file.filename`

---

## Substage 2 — State-eligibility check

Per the recipes-sheet: only `sent` and `supplier_action_required` are valid states for accepting an upload. Anything else means a stale link or a race condition — refuse and clear the file column to prevent refire loops.

**Step 2.1 — IF: prior_status NOT IN {sent, supplier_action_required}.**
Action: native IF
Condition: `[var: prior_status] != "sent" AND [var: prior_status] != "supplier_action_required"`

  **Step 2.1.a (inside IF) — Clear the trigger column on the request row.**
  Action: `workato_db_table.update_record`
  Table: SUP_SupplierRequest
  Record ID: `[var: supplier_request_id]`
  Field: `pending_upload_file = null`
  
  *Comment: clearing prevents an infinite re-trigger loop. If we exit without clearing, the next row update on this record refires UPL-01 because the filter still matches.*

  **Step 2.1.b — Emit recipe_failed (state_inconsistent).**
  Action: `call_recipe_async` to OBS-01
  Inputs:
  - `phase = "recipe_failed"`, `error_type = "state_inconsistent"`, `severity = "error"`
  - `source_recipe = SOURCE_RECIPE`, `step_number = 2`
  - `human_message = "Upload received on request not in upload-accepting state."`
  - `details_json = '{"prior_status":"' + [var: prior_status] + '","filename":"' + [var: submitted_filename] + '"}'`
  - `supplier_request_id = [var: supplier_request_id]`
  - (no `analyst_email` — trigger has no analyst context)

  **Step 2.1.c — Return early.**
  Action: `return_result` with no parameters.

*Comment: this branch catches `pending` (uploaded before invitation, shouldn't be possible but defensive), `pending_review` (already submitted, awaiting analyst), `approved` (done), and `cancelled` (closed). The upload bytes are effectively discarded — the file column gets cleared. If we ever want to preserve discarded uploads for forensic purposes, that's a separate concern that doesn't belong in UPL-01.*

---

## Substage 3 — Bridge bytes from Data Tables file column to FileStorage

The Data Tables file column carries the supplier's submission as a binary payload accessible via `record.pending_upload_file.file_content`. VAL-01 expects to read from a FileStorage path. UPL-01 copies the bytes across.

**Step 3.1 — Write bytes to FileStorage.**
Action: `workato_files.upload_file` (or workspace equivalent — `create_file_from_content`, depending on Workato version)
Inputs:
- `file_path` = formula: `[const: UPLOAD_PATH_PREFIX] + "/" + [var: supplier_request_id] + "/" + [var: upload_id] + ".xlsx"`
- `content` = `[trigger → record.pending_upload_file.file_content]`

Captures: the file_path on success (also derivable from the formula above; capturing the action's return is belt-and-suspenders).

**Step 3.2 — Update variable.**
Action: `workato_variable.update_variables`
Sets: `submitted_file_path = [Step 3.1 → file_path]` (or the formula-constructed path)

*Comment: per the earlier conversation, no transformation is required — the Data Tables `file_content` value passes directly into the FileStorage write action. If a future workspace upgrade changes that, the bridge becomes a base64 decode or stream pipe; the substage structure stays the same.*

*Open question: error handling. If `upload_file` raises (FileStorage full, transient network issue, etc.), what does UPL-01 do? My lean: wrap Step 3.1 in a `monitor` block, and on error emit `recipe_failed` with `error_type = external_action_failed` and return early. The supplier's file column doesn't get cleared, which means a retry could fire UPL-01 again — that's intentional, transient-failure recovery. If you want belt-and-suspenders on retry storms, add a second guard: check FileStorage for an existing path at the destination before writing, and skip if present. Probably overkill for v1.*

---

## Substage 4 — Create RUN_Upload row

**Step 4.1 — Create RUN_Upload record.**
Action: `workato_db_table.create_record`
Table: RUN_Upload
Fields:
- `upload_id` = `[var: upload_id]`
- `supplier_request_id` = `[var: supplier_request_id]`
- `template_version_id` = `[var: assigned_version_id]` *(frozen at issuance per IV — survives any future reassignment of the request to a different version)*
- `submitted_path` = `[var: submitted_file_path]`
- `status` = `"received"`
- `submitted_at` = `now`
- `valid_payload_json` = null *(populated later by VAL-01)*

*Comment: the recipes-sheet substage outline mentioned `submission_attempt` and `submission_source` as fields on RUN_Upload. Looking at the v5.3.0 manifest: RUN_Upload doesn't actually have either column — `submission_attempt` lives on SUP_SupplierRequest only, and `submission_source` isn't in the table schema. The recipes-sheet outline was either aspirational or stale. If you want either field on RUN_Upload, the manifest needs an update first. For now, neither gets written here.*

*The `extracted_path` field is also intentionally null — VAL-01 will populate it during the extraction step of its pipeline. UPL-01 doesn't pre-populate fields VAL-01 owns.*

---

## Substage 5 — Clear trigger column and increment submission_attempt

Two related writes on SUP_SupplierRequest, both non-state-related (IV-1 permits). The clear closes the trigger-refire window before the long synchronous VAL-01 call.

**Step 5.1 — Update SUP_SupplierRequest.**
Action: `workato_db_table.update_record`
Table: SUP_SupplierRequest
Record ID: `[var: supplier_request_id]`
Fields:
- `pending_upload_file` = null
- `submission_attempt` = `[var: prior_submission_attempt] + 1`

*Comment: receipt-time increment, per the design conversation. The supplier submitting is an attempt, regardless of whether validation succeeds. If validation fails, the next supplier submission increments to attempt+2, not attempt+1.*

*Note that this update fires the row's column-change trigger again, but the filter (`pending_upload_file.file_content present`) no longer matches because we just cleared the column. No refire.*

---

## Substage 6 — Call VAL-01 synchronously

UPL-01 needs VAL-01's return values (verdict, validation_result_id, count fields, trigger_context) to drive substages 7 and 8. Synchronous call, not async.

**Step 6.1 — Call VAL-01.**
Action: `workato_recipe_function.call_recipe` (synchronous)
Target: VAL-01 (`val_01_validate_supplier_input.recipe.json`)
Inputs:
- `upload_id` = `[var: upload_id]`
- `submission_source` = `SUBMISSION_SOURCE_FILE`

Captures (the return pill):
- `verdict` (string)
- `validation_result_id` (string, optional)
- `valid_row_count` (integer)
- `invalid_row_count` (integer)
- `trigger_context` (string, optional)

**Step 6.2 — Update variables from VAL-01 return.**
Action: `workato_variable.update_variables`
Sets:
- `verdict = [Step 6.1 → verdict]`
- `validation_result_id = [Step 6.1 → validation_result_id]`
- `valid_row_count = [Step 6.1 → valid_row_count]`
- `invalid_row_count = [Step 6.1 → invalid_row_count]`
- `val01_trigger_context = [Step 6.1 → trigger_context]`

*Comment: VAL-01 has at least one known inconsistency in its return values — `pipeline_alert_error` vs `pipeline_error_alert` across its return blocks. UPL-01 passes whatever VAL-01 returns through verbatim; if STS-01's derivation table doesn't recognize the value, STS-01 will return `error_code = derivation_lookup_failed`, which is what triggers our substage 8 error path. So the bug surfaces operationally rather than silently — fine for now. The VAL-01 fix is separate work.*

---

## Substage 7 — Write denormalized fields to SUP_SupplierRequest

The `current_validation_result_id`, `last_valid_row_count`, and `last_invalid_row_count` fields are denormalized helpers on SUP_SupplierRequest, populated from the most recent ValidationResult. All non-state per IV-1.

**Step 7.1 — Update SUP_SupplierRequest with VAL-01 results.**
Action: `workato_db_table.update_record`
Table: SUP_SupplierRequest
Record ID: `[var: supplier_request_id]`
Fields:
- `current_validation_result_id` = `[var: validation_result_id]`
- `last_valid_row_count` = `[var: valid_row_count]`
- `last_invalid_row_count` = `[var: invalid_row_count]`

*Comment: this write fires the column-change trigger again, but the filter still doesn't match (file column was cleared in Step 5.1). Still no refire.*

---

## Substage 8 — Resolve target_state and route to STS-01

Map verdict to target_state, then call STS-01. On `error` verdict, the call is refresh-only — `target_state` is the *current* status (no transition), `trigger_context` flows through to drive a supplier_message refresh without moving the state machine.

**Step 8.1 — Map verdict to target_state.**
Action: `py_eval` (or inline ternary in the STS-01 call — see design note below)
Inputs: `verdict`, `prior_status`
Outputs: `target_state` (string)
Logic:
```python
def main(data):
    verdict = data.get("verdict", "")
    prior_status = data.get("prior_status", "")
    if verdict == "passed":
        return {"target_state": "pending_review"}
    if verdict in ("failed", "empty", "structural_failure"):
        return {"target_state": "supplier_action_required"}
    if verdict == "error":
        return {"target_state": prior_status}  # refresh-only
    # Unknown verdict — defensive default
    return {"target_state": prior_status}
```

**Step 8.2 — Update variable.**
Action: `update_variables`
Sets: `target_state = [Step 8.1 → target_state]`

**Step 8.3 — Call STS-01.**
Action: `call_recipe_async` to STS-01
Inputs:
- `supplier_request_id = [var: supplier_request_id]`
- `target_state = [var: target_state]`
- `trigger_context = [var: val01_trigger_context]`
- (cancellation_reason, due_date_override omitted)

*Note: this is `call_recipe_async`, unlike INV-01's synchronous STS-01 call. UPL-01 doesn't need to react to STS-01's return — STS-01 owns the supplier_message refresh and any downstream consequences. If STS-01 refuses the transition, STS-01 itself emits a recipe_failed via OBS-01; UPL-01 won't see it but the operations record will.*

*The unknown-verdict defensive default (Step 8.1's fallthrough) routes to a refresh-only STS-01 call. That's lenient — alternative is to emit recipe_failed and skip STS-01. Given that VAL-01's verdict enum is well-defined and any unknown verdict means VAL-01 itself has changed without UPL-01 being updated, the lenient default keeps the supplier-facing pipeline moving while logging the issue via STS-01's eventual refusal. Strict alternative available if preferred.*

---

## Substage 9 — Return

**Step 9.1 — Return.**
Action: `return_result` with no parameters.

*Comment: per the recipes-sheet, UPL-01 emits no terminal success phase. VAL-01 emits validation_passed/validation_failed; STS-01 emits state_transition. UPL-01 emitting its own happy-path event would be redundant. Only the substage 2 early-exit path emits anything (recipe_failed); all other paths terminate silently.*

---

## Step count summary

9 substages. Top-level builder steps (Step 0 = trigger, Step 1.1 through Step 9.1 = body) total ~12 top-level rows, plus nested sub-steps inside the substage 2 IF block (3 children) and any optional monitor wrap on substage 3 (4 children). Total clickable units in the builder: ~18.

Less than half INV-01's step count, mostly because there's no per-user loop. The structural complexity instead lives in the file-column-to-FileStorage bridge (substage 3) and the verdict-to-target_state mapping with its three-branch outcome (substage 8).

---

## Open TBDs (resolve before or during builder pass)

1. **FileStorage write action name and parameter shape.** I've used `workato_files.upload_file` as a placeholder. Workato connectors have evolved across versions; the actual action might be `create_file_from_content`, `put_file`, or similar. Verify against your workspace.

2. **Monitor wrap on substage 3.** Recommended for production resilience but not strictly required. Without it, a FileStorage write failure becomes an unhandled recipe error; with it, UPL-01 emits a graceful `recipe_failed` with `external_action_failed`. My lean: add it.

3. **`error_type` for the substage 3 bridge failure.** External_action_failed is the obvious match. If the platform considers FileStorage internal infrastructure rather than external, `recipe_invariant` might be argued. I'd stick with external_action_failed — the failure mode is operational, not logical.

4. **The unknown-verdict default in Step 8.1.** Lenient (refresh-only) vs strict (recipe_failed). My draft is lenient.

5. **submission_source field on RUN_Upload.** Recipes-sheet substage outline references it; v5.3.0 manifest doesn't carry it. If you want the field, add it to the manifest before drafting the recipe JSON; if not, drop the recipes-sheet reference.

6. **The pending_upload_file column itself.** Doesn't exist in the v5.3.0 manifest yet (deferred during INV-01 discussion). Needs to be added to SUP_SupplierRequest as a Data Tables file column type before UPL-01 can be built. Probably warrants a manifest bump to v5.4.0 with this column and any other related changes (e.g., the column name itself, lifecycle hints).

---

## Appendix — Taxonomy values used

**Phases emitted:**
- `recipe_failed` (substage 2.1.b, and substage 3 if monitor-wrapped) — error severity, error_type required

**Error types used:**
- `state_inconsistent` (ET-10) — upload arrived on a request not in `sent` or `supplier_action_required`
- `external_action_failed` (ET-02) — FileStorage write failure (if monitor-wrapped)

**State transitions triggered (indirectly, via STS-01):**
- `sent → pending_review` (verdict=passed)
- `sent → supplier_action_required` (verdict=failed/empty/structural_failure, first submission)
- `supplier_action_required → pending_review` (verdict=passed on resubmission)
- `supplier_action_required → supplier_action_required` (verdict=failed/empty/structural_failure on resubmission — STS-01 may special-case this)
- `<current_state> → <current_state>` refresh-only (verdict=error)

**VAL-01 trigger_contexts passed through:**
- `system_validation_passed`
- `system_validation_failed`
- `system_structural_failure`
- `pipeline_alert_error` *(or `pipeline_error_alert` — VAL-01 v80 is inconsistent)*

**Invariants honored:**
- IV-1 (single-writer rule): no writes to status/current_state_entered_at/supplier_display_status/supplier_message
- Frozen at issuance: `template_version_id` on RUN_Upload copied from `assigned_version_id` at creation
- Submission attempt counter: incremented at receipt time on SUP_SupplierRequest
