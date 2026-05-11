# SDC Data Collection — Recipe Plan (v1, Stage 5 submission + review)

## Status

Continuation of `sdc-recipe-plan-v1.md` (Stage 1), `sdc-recipe-plan-stage2.md` (Stage 2), `sdc-recipe-plan-stage3.md` (Stage 3), and `sdc-recipe-plan-stage4.md` (Stage 4). Same template.

Stage 5 implements **R2 (File submission intake)** and **R5 (Analyst review handler)**. R3 (manual form submission) and R6 (cancellation) are handled without dedicated recipes — see the cross-cutting notes below for those routing decisions.

This is the stage where VAL-01 finally runs end-to-end. Stages 2–4 built the foundation, the validation engine, the provisioning chain, and the invitation; Stage 5 closes the loop by giving the supplier a way to submit and the analyst a way to review.

---

## R3 and R6 routing — decisions before recipes

### R3 (manual form submission): no dedicated recipe

The WFA form for manual entry has the row data in memory when the supplier clicks submit. Rather than round-trip through a recipe to serialize the data, the WFA writes the serialized rows directly to FileStorage at `extracted_path` and then calls VAL-01 with `submission_source=manual_entry`.

VAL-01's Phase 2 (Extract rows) already branches on `submission_source` and reads from `extracted_path` for the manual case — this is settled in VAL-01's plan. No new recipe needed; R3 is WFA logic plus a VAL-01 call.

The decision has one consequence: **UPL-01 is specifically the file-upload recipe**, not a general "submission intake" recipe. Its naming reflects this.

### R6 (cancellation): routed through STS-01 directly

Analyst cancellation has no file operations, no validation, no other recipes to orchestrate. It's a single state transition with a cancellation reason. STS-01 already supports this: the WFA calls `STS-01(supplier_request_id, target_state=cancelled, trigger_context=analyst_cancel, context_bag={cancellation_reason})` and the work is done.

The state-machine transition table allows `pending | sent | supplier_action_required | pending_review → cancelled`. STS-01's derivation table has a row for `(target_state=cancelled, trigger_context=analyst_cancel)` that renders the supplier-facing message and emits the cancellation event. No new recipe is needed.

This is the cleanest application of the "STS-01 is the single writer" pattern in the system — when a workflow reduces to "transition the state, derive the display, emit the event," it doesn't need a wrapper recipe.

---

## UPL-01 — File Submission Intake

### Identity
- **Code:** UPL-01
- **Name:** File Submission Intake
- **Domain:** UPL (upload handling)
- **Role:** Trigger (FileStorage)

### Build queue stage
Stage 5. R2 trigger.

### Capability
R2 — the recipe that runs when a supplier uploads a file. Receives the FileStorage upload event, resolves the request and version, persists a `RUN_Upload` row, invokes VAL-01, and routes the verdict to STS-01.

UPL-01 is one of the few recipes triggered by an external event rather than a callable invocation. The FileStorage path convention is what binds the upload to a specific supplier request.

### Contract

**Input (trigger schema):**
- FileStorage event payload — file path, file size, upload timestamp, uploader identity (from the WFA's signed upload context)

**Output (return schema):**
- Triggers don't have callers, so no return value. State is communicated via Data Tables writes and OBS-01 emits.

### Substage outline

1. **Parse the upload path.** The path convention encodes `supplier_request_id` (e.g., `/uploads/<request_id>/<timestamp>.xlsx`). Extract the request ID. On unparseable path, emit `recipe_failed` with `recipe_invariant` and stop — the upload is orphaned.
2. **Resolve the supplier request.** Read `SUP_SupplierRequest` by ID. Verify the request is in a state that accepts uploads: `sent` or `supplier_action_required`. If not (e.g., already `pending_review`, `approved`, `cancelled`), emit `recipe_failed` with `state_inconsistent` and stop. The upload is leftover from a stale link or analyst action; don't let it interfere with the actual state.
3. **Create the `RUN_Upload` row.** Stamp `supplier_request_id`, `template_version_id` (from the request's `assigned_version_id`), `submission_attempt` (computed as `request.submission_attempt + 1`), `submitted_path` (the upload's path), `submission_source=file`, `status=pending`, `uploaded_at`.
4. **Call VAL-01.** Pass `upload_id` and `submission_source=file`. VAL-01 reads the upload row, parses the XLSX, validates, persists `RUN_ValidationResult` and `RUN_FieldError` rows, returns the verdict.
5. **Route the verdict to STS-01.** Use the verdict-to-target_state mapping from VAL-01's plan:

| VAL-01 verdict | STS-01 target_state | STS-01 trigger_context |
|---|---|---|
| `passed` | `pending_review` | `system_validation_passed` |
| `failed` | `supplier_action_required` | `system_validation_failed` |
| `empty` | `supplier_action_required` | `system_validation_failed` |
| `structural_failure` | `supplier_action_required` | `system_structural_failure` |
| `error` | (current state, refresh-only) | `pipeline_error_alert` |

Call STS-01 with the appropriate parameters, passing context_bag fields VAL-01 reported (e.g., `valid_row_count`, `invalid_row_count`).

6. **No terminal emit.** UPL-01 does not emit its own success phase — the meaningful milestones are `validation_passed`/`validation_failed` (emitted by VAL-01) and `state_transition` (emitted by STS-01). UPL-01 is orchestration; its own emit would be redundant. The recipe only emits `recipe_failed` if Substages 1–2 fail before VAL-01 is called.

### Cross-cutting calls
- **VAL-01** — to run the validation pipeline
- **STS-01** — to transition based on the verdict
- **OBS-01** — for `recipe_failed` on infrastructure or invariant failure

### Phases emitted
- `recipe_failed` (only — success milestones are emitted by the downstream recipes)

### Error types possible
- `recipe_invariant` — upload path unparseable, request not in an upload-accepting state, `RUN_Upload` create failed in an unexpected way
- `state_inconsistent` — request is in `pending_review`, `approved`, or `cancelled`; the upload arrived from a stale link
- `external_action_failed` — FileStorage event payload malformed, Data Tables write failed

### State transitions triggered
**None directly.** The transition is triggered by STS-01 based on the VAL-01 verdict UPL-01 passes through. UPL-01's role is verdict-routing, not state writing.

### Invariants honored
- **Single-writer rule.** UPL-01 does not write supplier-request state fields. It writes only `RUN_Upload`.
- **Submission attempt counter.** UPL-01 stamps `submission_attempt` on the `RUN_Upload` row, computed from the request's current counter. VAL-01 increments the counter on the request during Phase 4. The order matters: UPL-01 stamps the *new* attempt's number (current + 1), VAL-01 updates the request's counter to match.
- **Frozen at issuance.** UPL-01 reads `assigned_version_id` from the request, not from "the latest version." The supplier validates against the version they were invited on, regardless of newer versions.

### Open questions
- **Stale links.** A supplier could submit via a link from a `sent` request that the analyst has since cancelled. UPL-01 catches this in Substage 2 and refuses, but the supplier sees no visible error — the upload silently disappears. Worth deciding whether to: (a) emit a separate phase for "stale link upload" with severity `warn`, (b) leave a sentinel file in FileStorage indicating the upload was received but rejected, or (c) accept the silent disappearance as the cost of the path convention. Lean (a) — observability matters, even for the no-op cases.
- **Concurrent uploads.** A supplier could upload two files in quick succession before VAL-01 has finished processing the first. UPL-01 has no guard against this — both fire, both create `RUN_Upload` rows, both run VAL-01, both call STS-01. The second VAL-01 may complete before the first. Worth a build-time decision: serialize via a job queue, accept eventual ordering, or refuse a second upload while the first is `validating`. Lean: refuse — emit `recipe_failed` with `state_inconsistent` when there's a `RUN_Upload` in `validating` status for the same request. Suppliers see "upload in progress, please wait." Edge case rare enough that simple refusal is fine.
- **Upload validation before processing.** Should UPL-01 do any pre-validation on the file before calling VAL-01? File size limit, MIME type check, virus scan? Lean: no, VAL-01's Phase 2 already handles "file unparseable as XLSX" via the structural-failure path. The only pre-check that matters is "file exists and is non-zero bytes," and the FileStorage event implies that. Defer richer pre-validation until it's a measured problem.
- **What about the WFA-08 upload-button observability gap from prior work?** The reminder/context indicates the prior implementation had a bug where 0-byte file uploads happened because the submit button fired before file binary committed. The fix was the WFA's direct-to-FileStorage upload option. The current plan assumes that fix is in place — UPL-01 receives an event only after the file is committed. Worth a build-time verification that the WFA's submit path triggers the FileStorage event correctly. Not a recipe-design issue but a system-integration issue.

---

## REV-01 — Analyst Review Handler

### Identity
- **Code:** REV-01
- **Name:** Analyst Review Handler
- **Domain:** REV (review)
- **Role:** Callable

### Build queue stage
Stage 5. R5 trigger.

### Capability
The recipe analysts invoke (via WFA action) to approve or reject a supplier submission in `pending_review`. Handles file copy on approval, review-note persistence on rejection, and the state transition either way.

The reject path **does not** include smart-UX corrections in Stage 5. Plain rejection only — analyst rejects with a note, the request returns to `supplier_action_required`, the supplier resubmits using the original template. "Rejection with corrections" (template regeneration with cleaned cells) is a Stage 6 enhancement that adds a UPL-02 call to REV-01's reject path. The Stage 5 plan reserves the seam without building the feature.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `decision` (string, required) — `approve` | `reject`
- `review_note_text` (string, optional) — required when `decision=reject`, optional when `decision=approve`
- `analyst_email` (string, required) — for audit and the review-note row

**Output (return schema):**
- `transitioned` (boolean)
- `from_state` (string) — should always be `pending_review`
- `to_state` (string) — `approved` or `supplier_action_required`
- `approved_path` (string, optional) — present only on approve, for the analyst's reference

### Substage outline

1. **Validate the request state.** Read the request; verify it's in `pending_review`. If not, emit `recipe_failed` with `state_inconsistent` and stop — the analyst clicked review on a stale request.
2. **Validate inputs.** `decision` is one of `approve | reject`. If `reject`, `review_note_text` must be non-empty (analysts must give a reason; the WFA should also enforce this client-side). On invalid input, emit `recipe_failed` with `recipe_invariant`.
3. **Branch on decision.**
   - **Approve path:**
     1. Read `RUN_Upload` for the request's `current_validation_result_id` — get the `submitted_path`.
     2. Copy the file from `submitted_path` to `approved_path` (e.g., `Project.approved_data_path/<supplier_id>.xlsx` per the path convention). FileStorage copy operation.
     3. On copy failure, emit `recipe_failed` with `external_action_failed` and stop. **The transition does not fire if the copy fails.** The request stays in `pending_review` and the analyst can retry.
     4. Update `SUP_SupplierRequest` with `approved_path` and `approved_at`. (These are not status fields, so UPL-01's single-writer-rule guard doesn't apply to them. Worth confirming this matches the data model — `approved_path` and `approved_at` are on the request row but not in the single-writer-protected set.)
     5. Optionally persist a `RUN_ReviewNote` if `review_note_text` is provided (analysts may want to record context on approval too).
     6. Call STS-01 with `target_state=approved`, `trigger_context=analyst_approve`.
   - **Reject path:**
     1. Persist a `RUN_ReviewNote`: `supplier_request_id`, `analyst_email`, `note_text`, `decision=reject`, `created_at`.
     2. Call STS-01 with `target_state=supplier_action_required`, `trigger_context=analyst_reject`, `context_bag={review_note_text}`.
4. **Emit `analyst_review_complete`.** OBS-01 with the decision and the transition outcome in `details_json`. One emit per invocation.
5. **Return** the transition summary.

### Cross-cutting calls
- **STS-01** — for the transition
- **OBS-01** — for the review-complete event and any failure events
- **No UTL-01 call** — REV-01 doesn't need links; STS-01 generates the supplier-facing message via its derivation table.

### Phases emitted
- `analyst_review_complete` (one per invocation, severity `info`)
- `recipe_failed` (on validation or infrastructure failure)

### Error types possible
- `recipe_invariant` — request not in `pending_review`, decision invalid, reject without note
- `external_action_failed` — file copy failed (approve path), Data Tables write failed
- `state_inconsistent` — request was cancelled between when the analyst loaded the WFA and clicked submit (concurrent R6)

### State transitions triggered
- `pending_review → approved` (approve path)
- `pending_review → supplier_action_required` (reject path)

Both via STS-01. REV-01 does not write state fields directly.

### Invariants honored
- **Single-writer rule.** REV-01 does not write status, current_state_entered_at, supplier_display_status, or supplier_message. All state writes route through STS-01.
- **Snapshot of approval.** `approved_path` and `approved_at` are write-once. Once approval succeeds, these fields never change. If the approval is later cancelled (a future workflow), a new transition handles the unwind; the original approval timestamps stay as historical record.
- **File copy as commit moment.** The approve path's transition is gated on the file copy succeeding. If copy fails, the transition doesn't fire. This is the same pattern as PRV-04 — the substantive write must complete before the state moves.
- **Review notes are append-only.** Each reject creates a new `RUN_ReviewNote` row; prior notes are never edited or removed. The full history is queryable.

### Open questions
- **Approve without an explicit click on review-note text — what's the default behavior?** The cluster resolution previously discussed `pending_review` as a state with an analyst-history concept (`RUN_ReviewNote` was added to the data model for this). The simplest interpretation: review notes are required only on reject; on approve, the analyst can optionally add one but it's not required. Locking this in unless there's a reason to change it.
- **Copy vs. move on approve.** Should `submitted_path` retain a copy of the original file after approval, or move-only? Lean: copy. The original at `RUN_Upload.submitted_path` is the historical artifact; the `approved_path` is the authoritative current artifact. Two paths, one for audit, one for use. The cost is FileStorage space; in practice, negligible at the volumes the system handles.
- **Concurrent review actions.** Two analysts could click approve/reject on the same request in quick succession. The second one's state check (Substage 1) fails because the first one's STS-01 call has already moved the request out of `pending_review`. The second analyst sees a `state_inconsistent` error. Lean: this is correct behavior — first writer wins, second gets a clear error. The WFA should reload the request after the error so the analyst sees the new state.
- **`approved_path` field name on the request.** The data model has this field; worth confirming it's not in the single-writer-protected set (`status`, `current_state_entered_at`, `supplier_display_status`, `supplier_message`). If it is in that set, REV-01 has to write it via STS-01 (passing it in `context_bag` or expanding STS-01's contract). If not, REV-01 writes it directly in Substage 3a.4 above. The plan assumes "not in the set." Worth confirming during STS-01 review.
- **Smart-UX seam.** Stage 6 will extend the reject path with a call to UPL-02 (resubmission template generation) when the analyst marks specific cells as bad. The current plan stops short of that. The seam: between Substage 3b.1 (persist review note) and Substage 3b.2 (call STS-01), Stage 6 will insert a "call UPL-02 to generate a corrections template" step that writes the new template path to `RUN_ReviewNote.regenerated_template_path` or similar. The state machine doesn't change — still `pending_review → supplier_action_required` — but the supplier-facing message can reference the corrections template.

---

## Stage 5 cross-cutting notes

**End-to-end happy path becomes verifiable at this milestone.** Provisioning (Stage 3) → invitation (Stage 4) → supplier upload (UPL-01) → validation (VAL-01) → analyst review (REV-01) → approval. The full happy path runs through eight recipes (PRV-01–04, INV-01, UPL-01, VAL-01, REV-01) plus STS-01 transitions. Stage 5's verification milestone per the build queue is exactly this: "supplier submits, system validates, analyst approves."

**The R3 and R6 decisions are worth flagging.** This plan made two routing choices that don't have dedicated recipes (R3 → WFA + VAL-01 direct, R6 → WFA + STS-01 direct). Worth a brief mention in the architectural decisions register so future contributors don't look for "where's the R3 recipe" and assume something's missing.

**REV-01's smart-UX seam is reserved but not built.** The plan explicitly defers "rejection with corrections" to Stage 6 (UPL-02) and names the seam — between review-note persistence and STS-01 call. This is a soft commitment, not a hard one. Stage 6's plan will decide whether the seam goes there or whether UPL-02 is called from a different point.

**Pipeline error alerts get exercised here.** VAL-01 returning `verdict=error` triggers the `pipeline_error_alert` path — STS-01 invoked with `trigger_context=pipeline_error_alert` does a refresh-only invocation (no state transition, derivation runs anyway). This is the production scenario the path was designed for; Stage 5's testing should exercise it deliberately.

### Pre-positioned test cases for Stage 5

From the build queue and deep dives:

- **End-to-end happy path.** Provisioning → invite → file upload → valid → review approve → file at approved_path.
- **Upload validation failure → resubmit → approve.** Verifies the resubmission counter increments, state moves back to `supplier_action_required`, second upload runs through cleanly, eventual approval succeeds.
- **Empty submission via R2.** Supplier uploads an empty XLSX (header row only). VAL-01 returns `verdict=empty`. STS-01 transitions to `supplier_action_required`. Verifies the `submission_empty` error type fires correctly.
- **Structural failure via R2.** Supplier uploads a corrupted XLSX or one with renamed sheet. VAL-01's Phase 2 hits the structural-failure path. Verifies the persistence of a minimal validation result and the `submission_structurally_invalid` error type.
- **Analyst reject.** Manual entry submission → valid → review reject with note → supplier sees note in their portal → supplier resubmits via the same form.
- **Pipeline error alert.** Force VAL-01 to crash (test fixture). Verify `verdict=error`, STS-01 refresh-only invocation, EventLog row with `severity=error`, `error_type=external_action_failed` or `unexpected_error`, alert pathway fires.
- **R6 cancellation from each state.** Analyst cancels a request in `pending`, in `sent`, in `supplier_action_required`, in `pending_review`. Verifies STS-01 handles each source state correctly and the supplier-facing message renders.
- **Stale link upload.** Supplier uploads via a link to a request that's been cancelled or already approved. Verifies UPL-01's state check refuses and emits appropriately.

---

## What's next

**Stage 6 — Smart-UX paths:**
- UPL-02 (Resubmission template generation) — extends REV-01's reject path
- INC-01 (Incumbent data seeding) — likely a new domain code

**Stage 7 — Invite cluster siblings:**
- INV-02 (Refresh outreach)
- INV-03 (Add user to request)
- INV-04 (Reassign request)

**Stage 8 — Reminders:**
- REM-01 (Reminder firing)
- (Reminder eligibility — possibly its own callable, possibly a method on REM-01)

After Stage 8, the recipe planning is complete. The remaining work in the build queue (Stage 9 engagement closure, Stage 10 monitoring) is small enough that it can either be folded into existing recipes or specified as one or two more small entries.
