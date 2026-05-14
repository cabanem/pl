# Recipes-sheet sweep — diff document

Cells in `recipes_tracker.xlsx` (sheet: `recipes`) that need updating based on findings from the INV-01 and UPL-01 build conversations. Organized by row.

Each entry names the row, the column, the current text (or the stale fragment within it), and the recommended replacement. Where a whole substage outline needs restructuring, the full revised text is provided.

---

## Row 6 — OBS-01

### Cell: Trigger schema

**Stale fragment:** `step_number (optional)`

**Issue:** OBS-01 v5's actual trigger schema has `step_number` as required (`optional: false`). The recipes-sheet contract is wrong here.

**Replacement:** Change `step_number (optional)` to `step_number`. The other parameters keep their `(optional)` markers where they apply.

---

## Row 7 — STS-01

### Cell: Trigger schema

**Stale fragment:** `(-) context_bag (optional — review_note_text, cancellation_reason, structural_error_summary, etc.)`

**Issue:** STS-01 v29 doesn't take a `context_bag`. Its actual trigger schema has specific named parameters: `cancellation_reason` (string, optional) and `due_date_override` (date_time, optional). The `context_bag` was the v0 design; the rebuild uses named params.

**Replacement:** Remove the `context_bag` line. Add two lines in its place:
- `(-) cancellation_reason (optional, string — only used on cancel transitions)`
- `(-) due_date_override (optional, date_time — only used on transitions that update the due date)`

### Cell: Substage outline

**Stale fragment:** `interpolating from context_bag`

**Issue:** Same as above. The substage describes interpolation from a parameter that doesn't exist in v29.

**Replacement:** Reword the substage to describe interpolation from the named params and from data read off the request row. The exact wording depends on the substage context — recommend Emily review the full substage 4/5 text and rewrite to reflect that STS-01 reads what it needs (the request row, the validation result, etc.) rather than receiving an opaque bag from the caller.

---

## Row 15 — INV-01

### Cell: Substage outline

**Stale fragment 1:** `Returns a 10-day link`

**Issue:** Workato's `create_shareable_link` action caps `expires_in` at 604800 seconds (7 days). UTL-01 v2 sets exactly this value. References to a 10-day link are aspirational and don't match what UTL-01 actually produces.

**Replacement:** Change `10-day link` to `7-day link` (Workato limit).

**Stale fragment 2:** `call STS-01 with target_state=sent, trigger_context=invitation_sent`

**Issue:** STS-01 v29's `trigger_context` enum does not contain `invitation_sent`. The valid value for the pending → sent transition is `invitation_issued`. The `invitation_sent` form is the OBS-01 `phase` value (past-tense, snake_case, marking the *event* of having sent). Two different semantic slots; the recipes-sheet conflates them.

**Replacement:** Change `trigger_context=invitation_sent` to `trigger_context=invitation_issued`. Optionally add a clarifying note: *(Note: this is distinct from the OBS-01 phase `invitation_sent` emitted in substage 7. STS-01's trigger_context marks the cause; OBS-01's phase marks the event.)*

---

## Row 16 — UPL-01

### Cell: Trigger schema

**Stale text:** `(-) FileStorage event payload`

**Issue:** The WFA file widget writes to a Data Tables file column (`pending_upload_file` on SUP_SupplierRequest), not to FileStorage. UPL-01's trigger is therefore a Data Tables column-change trigger on SUP_SupplierRequest, not a FileStorage event. The trigger payload is the SUP_SupplierRequest row, including the file column.

**Replacement:**
```
(-) Data Tables new_records_realtime trigger on SUP_SupplierRequest
(-) Filter: pending_upload_file.file_content present
(-) Trigger payload: SUP_SupplierRequest row (PK, status, assigned_version_id, submission_attempt, and pending_upload_file with filename + file_content)
```

### Cell: Substage outline

**Issue:** The entire substage outline is keyed off the wrong trigger model. Substage 1 describes path-parsing to recover supplier_request_id, but the request_id arrives free as the row PK in the new model. Path discriminator should be upload_id, not timestamp. Substage 3 references `submission_source=file` as a column on RUN_Upload, but the v5.3.0 manifest doesn't carry that column — it's a VAL-01 parameter only. Substage 3 also references `submission_attempt` *on RUN_Upload*, but the v5.3.0 manifest only has it on SUP_SupplierRequest. Substage 5 references `context_bag`, which doesn't exist.

**Replacement (full rewrite):**

```
(1) Capture trigger context. The trigger delivers the full SUP_SupplierRequest row including the file column's filename and file_content. Capture supplier_request_id (the row PK), status, assigned_version_id, submission_attempt, and submitted_filename into recipe variables. Mint upload_id as a fresh UUID.

(2) State-eligibility check. Verify status is sent or supplier_action_required. If not (already pending_review, approved, cancelled, etc.), emit recipe_failed with state_inconsistent, clear pending_upload_file on the request row (to prevent trigger refire loops), and stop.

(3) Bridge bytes to FileStorage. Read pending_upload_file.file_content from the trigger pill, write to FileStorage at /uploads/<supplier_request_id>/<upload_id>.xlsx. Wrap in a monitor block; on FileStorage failure, emit recipe_failed with external_action_failed and return early. Do NOT clear pending_upload_file on this failure path — the bytes need to remain available for retry.

(4) Create the RUN_Upload row. Stamp upload_id, supplier_request_id, template_version_id (from the request's assigned_version_id — frozen at issuance), submitted_path (the FileStorage path from substage 3), status=received, submitted_at=now.

(5) Clear trigger column and increment submission_attempt. Update SUP_SupplierRequest with pending_upload_file=null and submission_attempt=prior+1 in one update_record call. Both fields are non-state-protected per IV-1. The clear closes the trigger refire window before the synchronous VAL-01 call.

(6) Call VAL-01 synchronously. Pass upload_id and submission_source=file. VAL-01 reads the RUN_Upload row, parses the XLSX, validates, persists RUN_ValidationResult and RUN_FieldError rows, returns verdict + validation_result_id + count fields + trigger_context.

(7) Write denormalized fields to SUP_SupplierRequest. Update current_validation_result_id, last_valid_row_count, last_invalid_row_count from VAL-01's return. Non-state fields, IV-1 permitted.

(8) Resolve target_state and route to STS-01. Map verdict to target_state:
  | VAL-01 verdict      | target_state                | trigger_context (from VAL-01)
  | passed              | pending_review              | system_validation_passed
  | failed              | supplier_action_required    | system_validation_failed
  | empty               | supplier_action_required    | system_validation_failed
  | structural_failure  | supplier_action_required    | system_structural_failure
  | error               | <prior_status> (refresh)    | pipeline_error_alert
Call STS-01 (async — UPL-01 doesn't need the return). VAL-01 pre-computes trigger_context; UPL-01 passes it through verbatim.

(9) No terminal emit. UPL-01 does not emit its own success phase — VAL-01 emits validation_passed/validation_failed/etc., STS-01 emits state_transition, so a UPL-01 emit would be redundant. The recipe only emits recipe_failed if substage 2 or substage 3 fail.
```

---

## Row 20 — INV-02 (Refresh outreach)

### Cell: Invariants honored

**Stale fragment:** `fresh 10-day link each call; prior links don't expire early; multiple links may be live concurrently`

**Issue:** Same as INV-01 — 7-day Workato limit, not 10-day.

**Replacement:** Change `10-day` to `7-day`.

---

## Row 24 — REM-01 (Reminder firing)

### Cell: Invariants honored

**Stale fragment:** `fresh 10-day link each call; multiple links may be live concurrently`

**Issue:** Same as INV-01 and INV-02.

**Replacement:** Change `10-day` to `7-day`.

---

## False positives (verified, no change needed)

The following matches were flagged by the sweep but are correct usage:

- **Rows 8, 12 (CFG-01, PRV-02):** mentions of `parsed_config_path` as a FileStorage column reference are legitimate — this is the v5.3.0 manifest's actual column name for the per-version parsed config artifact. The pattern matched on "parse" + "path" but the usage is correct.

- **Row 17 (REV-01):** `context_bag={review_note_text}` — this is the only `context_bag` reference outside STS-01's own contract. Worth a separate verification: if REV-01 is intended to pass a context_bag to STS-01, that's also stale; if it's documenting an internal data structure unrelated to STS-01's contract, it's fine. Recommend reviewing REV-01 before its build pass; not blocking for INV-01 / UPL-01.

---

## Summary of cells to edit

| Row | Code | Column | Edit type |
|---|---|---|---|
| 6 | OBS-01 | Trigger schema | Remove `(optional)` from step_number |
| 7 | STS-01 | Trigger schema | Remove context_bag, add cancellation_reason + due_date_override |
| 7 | STS-01 | Substage outline | Reword context_bag references |
| 15 | INV-01 | Substage outline | 10-day → 7-day, invitation_sent → invitation_issued |
| 16 | UPL-01 | Trigger schema | Replace FileStorage event with Data Tables column trigger |
| 16 | UPL-01 | Substage outline | Full rewrite |
| 20 | INV-02 | Invariants honored | 10-day → 7-day |
| 24 | REM-01 | Invariants honored | 10-day → 7-day |

Eight cells across six rows. Most are surgical; UPL-01's substage outline is the only full rewrite.

---

## Recommended action

Edit in place in the existing `recipes_tracker.xlsx`. No version bump required — the sheet is canonical, this is correction not extension. If you keep a changelog elsewhere (separate file, sheet metadata), note these as a "stale-reference cleanup" pass following the INV-01 and UPL-01 build conversations.
