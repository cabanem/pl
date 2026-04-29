# SDC State Machine & Phase Implementation Guide

A recipe-by-recipe guide to wiring canonical state vocabulary and
phase emission across the SDC platform. Synthesizes the working
session of 28 April 2026.

## How to use this guide

This is intended as a working document — read the relevant section
before touching a recipe, use it as a checklist during the edit, and
mark items done as you go. Each recipe section follows the same shape:

- **Purpose** — what the recipe does, briefly.
- **State touches (current)** — what the recipe writes today, from
  the catalog evidence.
- **State touches (target)** — what the recipe should write under
  the canonical model.
- **Edit list** — concrete recipe changes, ordered for implementation.
- **Reasoning** — why the change matters, when relevant.
- **Verification** — what to check after the edit.

Edits marked **VERIFY** require source inspection before changing
anything — the catalog comment was too vague to determine the
current behavior with confidence.

---

## Canonical reference

### State machines

```
HOME_Requests:        received | succeeded | failed | rejected
WFA_SupplierRequest:  assigned | working | submitted | awaiting_review | rework_needed | done
RUN_ValidationResult: running | passed | failed | error          (running reserved, not currently written)
VER_TemplateVersion:  draft | published | deprecated
```

### Phase taxonomy

| Layer | Phase | Severity | Notes |
|---|---|---|---|
| Intake | `webhook_validated` | info | Replaces `webhook_received` (collapsed) |
| Intake | `webhook_rejected` | error | Terminal |
| Intake | `request_routed` | info | Republish path |
| Provisioning | `provisioning_started` | info | Top of P-01 |
| Provisioning | `workspace_provisioned` | info | B-02 milestone, no state change |
| Provisioning | `config_validated` | info | C-01 returned valid |
| Provisioning | `config_invalid` | error | C-01 found rule violations |
| Provisioning | `config_failed_to_parse` | error | C-01 couldn't read the file |
| Provisioning | `schema_persisted` | info | CFG_* batch inserts done |
| Provisioning | `templates_generated` | info | All variant XLSX built |
| Provisioning | `incumbent_data_seeded` | info | P-02b returned |
| Provisioning | `version_published` | info | VER_TemplateVersion → published |
| Provisioning | `version_deprecated` | info | Republish path |
| Provisioning | `suppliers_bootstrapped` | info | Aggregate, with count |
| Provisioning | `suppliers_migrated` | info | Aggregate, with count |
| Provisioning | `supplier_invited` | info | Aggregate, with count |
| Provisioning | `recipe_completed` | info | P-01 happy-path terminal |
| Provisioning | `recipe_failed` | error | P-01 catch terminal |
| Submission | `submission_received` | info | WFA_SupplierRequest milestone |
| Submission | `upload_received` | info | RUN_Upload milestone |
| Submission | `upload_failed` | error | Ingestion failure |
| Submission | `submission_validated` | info | Validation passed |
| Submission | `submission_invalid` | error | Validation failed |
| Submission | `submission_accepted` | info | Analyst approved |
| Submission | `rework_dispatched` | info | Rework path entered |
| Cross-cutting | `error` | error | Generic error, written by U-01 |

### SYS_EventLogs — the chronicle

SYS_EventLogs is the platform's event chronicle. Every phase emission
in this guide writes a row there. Three things to know about how it
relates to the rest of the model:

**It's not a state machine.** It records *events* — what happened —
not state. The `severity` field is a tag on the event (info/warn/error
filter level), not a state someone moves through. The `phase` field
names the event type.

**Each row is one phase.** A row is the conjunction of "this thing
just happened" + "here's the context" (correlation_id, source_recipe,
project_id, details_json). Some phases correspond to a single state
transition (`webhook_validated` → HOME_Requests received). Some
phases conjoin multiple transitions (`submission_invalid` →
RUN_ValidationResult.failed + WFA_SupplierRequest.rework_needed). The
log row is the unified event-record.

**Emit at recipe-orchestration boundaries, not inside individual table
writes.** If a phase represents a coordinated transition across
multiple state-machine writes, the emit should happen *after* both
writes succeed. Emitting from inside a single table-write step
risks logging "this happened" when it only half-happened.

**Schema implications.** The data model already has the right shape;
two changes needed:

1. **Update the `phase` enum** to match the final taxonomy above. See
   the "SYS_EventLogs phase enum reconciliation" subsection in the
   data model changes section for the full list and what's added /
   removed / renamed.
2. **No new fields needed.** The current schema (`event_id`,
   `timestamp`, `correlation_id`, `project_id`, `analyst_email`,
   `source_recipe`, `phase`, `severity`, `human_message`,
   `details_json`) is sufficient for everything in this guide.

**RUN_PipelineError is being dropped.** See the data model changes
section. SYS_EventLogs absorbs the error-chronicle role; structured
error context goes in `details_json`.

### Default emission heuristic

For phases inside loops (foreach over suppliers, validations, etc.):

1. **Aggregate phase per recipe loop**, with `count=N` in details.
2. **Per-row data carried by table timestamps** (e.g. `invited_at`),
   not by per-row phase rows.
3. **Per-row error logging** via U-01 is essentially free and worth having.

Override the default only when a phase has no corresponding data-table
row to fall back on (`request_routed`, `webhook_validated`).

---

## B-01 — Receive request via webhook

### Purpose
Webhook entry point. Validates payload structure, writes a
`HOME_Requests` row, dispatches downstream (B-02 async, sometimes
P-01 async, U-01 async on errors).

### State touches (current)
- Step 6: SELECT HOME_Requests — routing decision (new vs republish)
- Step 8: INSERT HOME_Requests with `status='rejected'`
- Step 13: INSERT HOME_Requests (happy path, new request)
- Step 17: INSERT HOME_Requests (republish path)

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 6 | SELECT | (read only) | — | — |
| 8 | INSERT | → `rejected` | `webhook_rejected` | error |
| 13 | INSERT | → `received` | `webhook_validated` | info |
| 17 | INSERT | → `received` | `request_routed` | info |

### Edit list

1. **Step 8** — verify status value is lowercase `rejected`. If currently uppercase or different, update.
2. **Step 13** — verify status value is `received`. Currently appears to write `pending` based on inference; needs change to `received`.
3. **Step 17** — same verification as step 13. Republish path also writes `received`.
4. **Phase emission** — add U-01 calls (or whichever emit mechanism) at steps 8, 13, 17 with the phases above.

### Reasoning

- **Why drop `webhook_received`?** It's redundant with `webhook_validated`. The act of validation succeeding *is* the meaningful event; "we got a webhook" is implicit in reaching step 13 at all. Two phases for one moment is noise.
- **Why same state for new and republish?** Both paths produce a HOME_Requests row representing an in-flight intake. The new-vs-republish distinction is *what kind of work follows*, which is captured in the `request_routed` phase. The state machine only cares about lifecycle position.

### Verification
- Confirm `webhook_received` is removed from any other emit points (it was in the seed sheet's Tab 3).
- Confirm steps 13 and 17 write the same status (`received`).

---

## B-02 — Route data collection request

### Purpose
Picks an available workspace, creates `WFA_TemplateProject`,
dispatches to P-01 async. Async dispatch means B-02 doesn't own the
final HOME_Requests state.

### State touches (current)
- Step 2: SELECT HOME_Requests (read for record ID)
- Step 12: INSERT WFA_TemplateProject
- Step 13: UPDATE HOME_Requests with `status='active'` and other fields
- Step 19: UPDATE HOME_Requests (error branch, status value unverified)

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 2 | SELECT | (read only) | — | — |
| 12 | INSERT | (no state machine — milestone only) | `workspace_provisioned` | info |
| 13 | UPDATE | (no transition — drop status write) | — | — |
| 19 | UPDATE | (TBD — see Verification) | (TBD) | (TBD) |

### Edit list

1. **Step 13** — drop the `status='active'` field from the update. Keep the other field updates (`workato_file_storage_path`, etc.). Under async dispatch, B-02 doesn't know if anything succeeded yet.
2. **Step 12** — add phase emission `workspace_provisioned`.
3. **Step 19** — **VERIFY** what failure case this catches.

### Reasoning

- **Why drop status='active' at step 13?** B-02 calls P-01 async and exits. At the moment step 13 runs, P-01 hasn't even started. Writing "active" here is reporting success before the work happens. Under the new model, P-01 owns the `received → succeeded | failed` transition because P-01 is the recipe that knows the answer.
- **Why is workspace_provisioned still a phase?** WFA_TemplateProject row creation is a real milestone — operators want to see "Acme-Q4 has a workspace" in the log even if it doesn't change a state machine. The phase carries the operational fact; no transition row required.

### Verification
- **Step 19** — inspect the recipe JSON. Three possibilities:
  - (a) Catches B-02-internal failures (no available workspace, `WFA_TemplateProject` insert error). In that case, write `received → failed` + `recipe_failed`.
  - (b) Catches errors bubbled up from a sync call to P-01. Under async dispatch, this branch becomes unreachable and should be removed.
  - (c) Catches both, indistinguishably. Decide whether to split or remove based on (b) being unreachable.

---

## P-01 — Provision project

### Purpose
The orchestrator. 69 steps. Owns the `received → succeeded | failed`
transition for HOME_Requests. Creates VER_TemplateVersion rows,
deprecates old versions on republish, batch-creates
WFA_SupplierRequest rows, calls C-01 (config validation), P-02a
(template build), P-02b (incumbent seed), P-03a (invitation dispatch).

### State touches (current)
- Step 10: UPDATE HOME_Requests (fields TBD)
- Step 22: UPDATE VER_TemplateVersion (deprecate old version)
- Step 23: INSERT VER_TemplateVersion (`status='draft'`)
- Step 51: UPDATE VER_TemplateVersion (`status='published'`)
- Step 55: INSERT WFA_SupplierRequest (batch — new project path)
- Step 61: UPDATE WFA_SupplierRequest (republish migration — non-status fields)
- Step 63: INSERT WFA_SupplierRequest (batch — republish path, new suppliers)

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| (top) | — | (recipe entered) | `provisioning_started` | info |
| 10 | UPDATE | (TBD — see Verification) | — | — |
| (after C-01 returns) | — | (config OK) | `config_validated` | info |
| (after C-01 returns invalid) | — | (rule violations) | `config_invalid` | error |
| (after C-01 parse fail) | — | (file unreadable) | `config_failed_to_parse` | error |
| 22 | UPDATE | VER_TemplateVersion: `published → deprecated` | `version_deprecated` | info |
| 23 | INSERT | VER_TemplateVersion: → `draft` | (none — implementation detail) | — |
| (after CFG_* batch inserts) | — | (schema persisted) | `schema_persisted` | info |
| (after P-02a foreach completes) | — | (templates built) | `templates_generated` | info |
| (after P-02b returns) | — | (incumbent processed) | `incumbent_data_seeded` | info |
| 51 | UPDATE | VER_TemplateVersion: `draft → published` | `version_published` | info |
| 55 | INSERT (batch) | WFA_SupplierRequest: → `assigned` | `suppliers_bootstrapped` (count) | info |
| 61 | UPDATE | (no transition — config sync only) | `suppliers_migrated` (count) | info |
| 63 | INSERT (batch) | WFA_SupplierRequest: → `assigned` | `suppliers_bootstrapped` (count) | info |
| **NEW (end)** | UPDATE | HOME_Requests: `received → succeeded` | `recipe_completed` | info |
| **NEW (catch)** | UPDATE | HOME_Requests: `received → failed` | `recipe_failed` | error |

### Edit list

This is the most invasive recipe edit on the list. Recommended order:

1. **Wrap the recipe body in a try/catch.** This is the structural change. The catch block becomes the single point where failure-state writes happen.
2. **In the catch block:**
   - UPDATE HOME_Requests: `received → failed`
   - Emit `recipe_failed` phase (severity: error)
   - Set `error_message` field on HOME_Requests with the caught error
   - Include the last-completed milestone phase in `details_json` so the log answers "where did P-01 die?" without recipe-execution log archaeology
3. **At the very top of the recipe body** (inside the try, before any other work):
   - Emit `provisioning_started` phase
4. **At the very end of the happy path** (after step 63 or wherever the final supplier write completes):
   - UPDATE HOME_Requests: `received → succeeded`
   - Emit `recipe_completed` phase
5. **Step 22** — confirm it writes `'deprecated'`. Add `version_deprecated` phase emission.
6. **Step 23** — confirm it writes `'draft'`. No phase needed — this is an implementation detail; the user-facing milestone is publish.
7. **After the C-01 sync call** — emit one of: `config_validated` (info), `config_invalid` (error, terminal — let the catch handle the failure write), or `config_failed_to_parse` (error, same).
8. **After the CFG_* batch inserts complete** (around step ~30) — emit `schema_persisted` phase. The phase carries field/rule/lookup/variant counts in `details_json`.
9. **After the P-02a foreach completes** (template build loop) — emit `templates_generated` phase with `variant_count` and any other useful aggregate.
10. **After the P-02b sync call** (if it ran for this provisioning) — emit `incumbent_data_seeded` phase.
11. **Step 51** — confirm it writes `'published'`. Add `version_published` phase emission.
12. **Steps 55 and 63** — change inserted status value to `'assigned'`. Both insertions emit `suppliers_bootstrapped` aggregate phase with `count=N` from the batch result.
13. **Step 61** — drop any status writes (existing suppliers stay in `assigned`). Emit `suppliers_migrated` aggregate phase with `count=N`.
14. **Step 10** — **VERIFY**. The catalog comment was vague.

### Reasoning

- **Why try/catch around the body?** P-01's failure surface is enormous (69 steps, multiple sub-recipe calls, file generation, config validation, supplier creation). Adding error handling at each branch would multiply the writes and create drift opportunities. One catch block, one failure write, one phase. Done.
- **Why does P-01 own the succeeded transition?** Because P-01 is the only recipe that knows whether all the provisioning work completed. B-02 dispatched and exited; nothing else runs after P-01 finishes the happy path. If it doesn't write succeeded, no one will.
- **Why granular milestone phases?** P-01 is the longest-running recipe with the most failure surface. If it fails at step 35 (template generation), the only entry from the terminal phases would be `recipe_failed` — telling you nothing about where in the lifecycle the failure happened. Granular milestones (`config_validated`, `schema_persisted`, `templates_generated`, etc.) give an analyst a chronological breadcrumb trail. The catch block can include the last-emitted milestone in `details_json` for explicit "got past X, failed at Y" diagnostics.
- **Why `assigned` and not `pending`?** The state captures "this supplier has work assigned to them." `pending` was vague — pending what? `assigned` says exactly what's true.
- **Why aggregate phases for batch inserts?** Per the heuristic. WFA_SupplierRequest already has `supplier_request_id` to look up individual rows; the per-row when-was-this-created question is answerable from `Created time` (Workato's system field) directly.

### Verification

- **Step 10** — check what fields it writes. Three possibilities:
  - (a) Writes `status='active'` (or similar stale value). Drop the status field; keep other field updates.
  - (b) Writes only non-status fields. No edit needed.
  - (c) Writes a status value that legitimately matters at this point. Reconsider — but I can't think of what that would be under the new model.
- **Steps 55 and 63** — confirm they write the same value. They should be the same INSERT pattern in two different code paths.
- **The new try/catch wrapper** — make sure the `error_message` field on HOME_Requests gets populated meaningfully. Empty error messages on failed requests are useless.

---

## P-03a — Onboard suppliers

### Purpose
Iterates supplier records, sends invitations via WFA, updates the
WFA_SupplierRequest row.

### State touches (current)
- Step 6: SELECT WFA_SupplierRequest
- Step 11: workflow_task (invitation dispatch — not a state op)
- Step 14: UPDATE WFA_SupplierRequest with `status='sent'`
- Step 17: SELECT WFA_SupplierUser

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 6 | SELECT | (read only) | — | — |
| 11 | workflow_task | (no state) | — | — |
| 14 | UPDATE | (no transition) | `supplier_invited` (count) | info |
| 17 | SELECT | (read only) | — | — |

### Edit list

1. **Step 14** — drop the `status='sent'` write. Add an `invited_at` timestamp field instead. The supplier row stays in `assigned`.
2. **After the foreach completes** — emit aggregate `supplier_invited` phase with `count=N`.

### Reasoning

- **Why does the row stay in `assigned`?** Under our state semantics, `working` means "the assignee is actively doing the task." Sending an invitation is the *system* doing something *to* the supplier; it doesn't change what the supplier is doing. The supplier moves to `working` when they actually engage (open the portal, save data, etc.).
- **Why a timestamp instead of a state?** Two reasons. One: the act of invitation is a *fact about the row at a moment*, not a *new state of the entity*. Timestamps capture facts; states capture lifecycle position. Two: this becomes the canonical pattern — push detail into table fields, keep the state machine lean.

### Verification

- **`invited_at` field doesn't exist on WFA_SupplierRequest yet.** Add it to the source schema first, then update the recipe.
- Confirm step 11's workflow_task dispatch is the *act of inviting*. The phase emits *after* the foreach (post-step-14) so it represents the completed batch.

---

## WFA-03b — Submit supplier input from file upload

### Purpose
Receives a file upload event, creates a RUN_Upload row, dispatches to
V-01a for validation. The file path's `working → submitted` transition lives here.

### State touches (current)
- Step 11: INSERT RUN_Upload
- Step 20: UPDATE RUN_Upload with `status='validating'` (success) or `status='failed'` (error)

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 11 | INSERT + UPDATE | RUN_Upload: → `received`<br>WFA_SupplierRequest: `working → submitted` | `upload_received`<br>`submission_received` | info |
| 20 (success) | UPDATE | (no transition — drop the `validating` write) | (none) | — |
| 20 (error) | UPDATE | RUN_Upload: `received → failed`<br>WFA_SupplierRequest: `submitted → working` (rollback) | `upload_failed` | error |

### Edit list

1. **Step 11** — keep the existing RUN_Upload INSERT. Add a new UPDATE step (or extend step 11 if practical) that transitions WFA_SupplierRequest from `working` to `submitted`. Confirm the inserted RUN_Upload status is `received`.
2. **Step 20 success branch** — drop the `status='validating'` write entirely. Under the simplified RUN_Upload enum (`received | failed`), there's no `validating` state. Keep any other field updates.
3. **Step 20 error branch** — keep the RUN_Upload `status='failed'` write. Add a new UPDATE that rolls back WFA_SupplierRequest from `submitted` to `working`.
4. **Phase emissions:**
   - Step 11 emits two phases: `upload_received` and `submission_received`. These are distinct events worth distinguishing in the log — one is about the technical artifact (RUN_Upload row), the other is about the supplier's lifecycle (WFA_SupplierRequest transition).
   - Step 20 error branch emits `upload_failed`.

### Reasoning

- **Why does WFA-03b own the `working → submitted` transition?** Because submission is an act the supplier performs. The state captures "the supplier has submitted" regardless of whether the file is good. Validation success or failure is a separate concern handled by V-02 later, with `submitted → awaiting_review | rework_needed`.
- **Why the symmetric rollback on error?** If a supplier submits a malformed file and we transitioned them to `submitted`, leaving them there is a trap — they look submitted but have nothing to validate against. The rollback to `working` signals "you need to try again" without losing their progress.
- **Why drop `validating` from RUN_Upload?** Because the V-layer never writes back to RUN_Upload to clear it. Under the original enum, RUN_Upload would stay in `validating` forever after V-01a finished. The cleaner semantics: RUN_Upload tracks ingestion, RUN_ValidationResult tracks validation. Don't duplicate the lifecycle.

### Verification

- After the edit, no recipe should write `validating` to RUN_Upload anywhere.
- After the edit, the success branch of step 20 may have nothing to do at all. If so, the step can be removed entirely.

---

## WFA-04c — Submit supplier input from form

### Purpose
The form path's analog to WFA-03b. Receives form submission, creates
a RUN_Upload row, dispatches to V-01a.

### State touches (current)
- Step 14: INSERT RUN_Upload

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 14 | INSERT + UPDATE | RUN_Upload: → `received`<br>WFA_SupplierRequest: `working → submitted` | `upload_received`<br>`submission_received` | info |
| **NEW (catch)** | UPDATE | RUN_Upload: `received → failed`<br>WFA_SupplierRequest: `submitted → working` | `upload_failed` | error |

### Edit list

1. **Step 14** — keep the existing RUN_Upload INSERT. Add a new UPDATE that transitions WFA_SupplierRequest from `working` to `submitted`.
2. **Wrap step 14 (or the recipe body) in try/catch** — symmetric to WFA-03b's error branch. Catch handles:
   - RUN_Upload UPDATE: `received → failed`
   - WFA_SupplierRequest UPDATE: `submitted → working` (rollback)
   - Phase: `upload_failed` (severity: error)
3. **Phase emissions at step 14** — `upload_received` and `submission_received`.

### Reasoning

- **Why does WFA-04c need a catch block?** Symmetry with WFA-03b. Even though form submission is unlikely to fail at ingestion (the WFA form layer enforces structure upfront), unlikely is not impossible. Transient Workato errors, slot data that didn't match expectations, downstream connector failures — any of these could leave the supplier stuck.
- **Why is this called out explicitly?** Because it's adding error handling to a recipe that doesn't currently have it. That's a real gap, not just a vocabulary fix.

### Verification

- The catch block is *new* to WFA-04c. Make sure it's positioned to catch failures from any step that could plausibly fail.
- Test the rollback path explicitly — induce a failure (e.g., make the RUN_Upload INSERT fail with a malformed input) and confirm WFA_SupplierRequest reverts to `working`.

---

## V-01a — Validate supplier input

### Purpose
Validation orchestrator. Calls V-01b for context prep, runs validation
via the `sdc_platform_connector`, calls V-02 for result routing.

### State touches (current)
- Step 44: INSERT RUN_ValidationResult (file branch — confirmed mutually exclusive with step 51)
- Step 51: INSERT RUN_ValidationResult (form branch — confirmed mutually exclusive with step 44)

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 44 | INSERT | RUN_ValidationResult: → `passed | failed | error` (final on insert) | (none — V-02 emits the outcome) | — |
| 51 | INSERT | RUN_ValidationResult: → `passed | failed | error` | (none) | — |

### Edit list

V-01a needs no recipe edits. The current behavior — insert with the
final status directly — is correct under the simplified model.

### Reasoning

- **Why no `running` write?** The decision was: keep `running` reserved in the enum for future async pipelines, but don't emit it in current code where validation completes synchronously within V-01a's execution. Inserting the row only at completion (with the final status) means RUN_ValidationResult rows never exist in `running` state today.
- **Why no `validation_started` phase?** Validation is fast enough that a "started" marker adds noise without information. The phases that matter are the outcomes — `submission_validated` or `submission_invalid` — emitted from V-02.

### Verification

- Confirm steps 44 and 51 are in mutually exclusive `if` branches. If both ever fire for one validation run, that's a bug — multiple RUN_ValidationResult rows for one upload makes the "current result" query ambiguous.

---

## V-02 — Route validation results

### Purpose
Receives the validation outcome from V-01a, transitions
WFA_SupplierRequest based on the result. Calls RW-01 (sync) on rework
paths, U-01 (async) on errors.

### State touches (current)
- Step 17: UPDATE WFA_SupplierRequest with `status='supplier_action_required'`
- Step 21: UPDATE WFA_SupplierRequest with `status='validation_success'`

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 17 | UPDATE | WFA_SupplierRequest: `submitted → rework_needed` | `submission_invalid` | error |
| 21 | UPDATE | WFA_SupplierRequest: `submitted → awaiting_review` | `submission_validated` | info |

### Edit list

1. **Step 17** — change status write from `'supplier_action_required'` to `'rework_needed'`. Emit `submission_invalid` phase.
2. **Step 21** — change status write from `'validation_success'` to `'awaiting_review'`. Emit `submission_validated` phase.

### Reasoning

- **Why these names?** The new vocabulary maps cleanly to what each state means in supplier-obligation terms:
  - `rework_needed` = "the supplier has work to do" (clearer than `supplier_action_required`, which was both verbose and ambiguous about what action)
  - `awaiting_review` = "the supplier is waiting on the analyst" (clearer than `validation_success`, which described the validation outcome rather than the supplier's situation)
- **Why is the phase severity different from before?** `submission_invalid` is an error-severity phase because it represents a failure state from the supplier's perspective. `submission_validated` is info-severity — nothing failed, the supplier just needs to wait. Severity is for log filtering, not for criticism of the supplier.

### Verification

- Search the recipe JSON for any other status writes that might have been missed. The catalog showed only steps 17 and 21, but step inputs sometimes contain dynamic status values that don't surface in the catalog summary.

---

## WFA-06a — Analyst review: approve submission

### Purpose
Analyst-facing recipe. Records the review approval, transitions the
supplier request to terminal completion, writes a RUN_ReviewNote.

### State touches (current)
- Step 6: UPDATE WFA_SupplierRequest (status value unverified — catalog comment too vague)
- (also writes RUN_ReviewNote with `review_action='approved'` — type tag, not a state)

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 6 | UPDATE | WFA_SupplierRequest: `awaiting_review → done` | `submission_accepted` | info |

### Edit list

1. **Step 6** — **VERIFY** the current status value. Most likely `'accepted'` or `'approved'`. Change to `'done'`.
2. Emit `submission_accepted` phase.

### Reasoning

- **Why `done` and not `accepted`?** `done` is the unified terminal state for WFA_SupplierRequest under the new vocabulary. The supplier's task is complete, regardless of whether it ended via approval or some other terminal path. `accepted` would be a redundant nuance — RUN_ReviewNote already carries `review_action='approved'` if you need to query "approved vs other-completion."

### Verification

- **Step 6** — confirm the value being written. Inspect the recipe JSON's step input directly; the catalog summary was insufficient.
- After the edit, search for any other recipe that might write to WFA_SupplierRequest with an `accepted` or `approved` status — those would also need to migrate.

---

## WFA-06b — Analyst review: request supplier rework

### Purpose
Analyst-facing recipe. Records a rework request, calls RW-01 (sync)
to handle the actual rework dispatch. Writes a RUN_ReviewNote with
`review_action='rework'`.

### State touches (current)
- (Calls RW-01 — RW-01 handles the WFA_SupplierRequest transition)
- (Writes RUN_ReviewNote — type tag, not state)

### State touches (target)

WFA-06b doesn't touch state machines directly. State responsibility
flows down to RW-01.

### Edit list

No recipe edits needed for WFA-06b. The state writes happen in RW-01.

### Reasoning

- **Why does RW-01 own the transition, not WFA-06b?** Because both V-02 (validation rejection) and WFA-06b (analyst rejection) call into RW-01, and the rework workflow is fundamentally the same regardless of how it was triggered. Centralizing the state write in RW-01 means one place to maintain.

### Verification

- Confirm WFA-06b's RUN_ReviewNote write uses `review_action='rework'` (the existing data model enum value).

---

## RW-01 — Request supplier rework (incomplete)

### Purpose
Handles rework dispatch. Called from V-02 (after validation failure)
and WFA-06b (after analyst rejection). Per Emily's manifest, this
workflow is **incomplete** — wiring exists but business logic is
unfinished. State edits below are vocabulary-only; structural changes
are deferred to a separate rework refactor.

### State touches (current)
- Step 12: UPDATE RUN_ValidationResult with `status='superseded'`
- Step 20: UPDATE WFA_SupplierRequest (link regeneration, no status)
- Step 21: UPDATE WFA_SupplierRequest with `status='data_entry'`

### State touches (target)

| Step | Op | Transition | Phase | Severity |
|---|---|---|---|---|
| 12 | UPDATE | (drop entirely) | — | — |
| 20 | UPDATE | (no transition — link fields only) | — | — |
| 21 | UPDATE | WFA_SupplierRequest: `rework_needed | awaiting_review → working` | `rework_dispatched` | info |

### Edit list

1. **Step 12** — remove this step entirely. Prior RUN_ValidationResult rows are immutable history; we don't mark them `superseded` or anything else.
2. **Step 20** — keep as-is. Non-status field updates (regenerated links).
3. **Step 21** — change status write from `'data_entry'` to `'working'`. Emit `rework_dispatched` phase.

### Reasoning

- **Why remove step 12?** We decided RUN_ValidationResult rows stay untouched as history. The question "which validation result is current?" is answered by `ORDER BY created_at DESC LIMIT 1` (or equivalent), not by a `superseded` marker. A row that ran and failed three weeks ago is still factually `failed` — overwriting that with `superseded` loses information.
- **Why `working` and not `assigned`?** The supplier is being asked to rework an existing submission. They've already engaged with the task; the rework is a continuation of work, not a fresh assignment. `working` captures that.
- **Why does the transition accept multiple "from" states?** RW-01 is called from two paths: V-02 (where the supplier was in `rework_needed` after validation failure) and WFA-06b (where the supplier was in `awaiting_review` after submission, then the analyst rejected). Both target `working`.

### Parking lot — deferred decisions

These are not part of the vocabulary fix and should be revisited
during the rework refactor:

- **Does RW-01 handle the two source states uniformly, or does it need
  different handling per caller?** If WFA-06b's analyst rejection
  needs different supplier communication than V-02's automated
  validation rejection, the recipe might need branching.
- **Does the act of rework reset any other state?** Currently RUN_Upload
  rows from prior submissions stay in `received`. Should they be
  cleaned up, or do they accumulate as upload history?
- **What happens to old RUN_ReviewNote rows?** The new review note
  records the analyst's rework request; old approval notes from prior
  cycles aren't superseded but might be confusing in a chronological
  view.

### Verification

- Confirm step 12 removal doesn't break anything downstream. Search
  for any recipe that *reads* RUN_ValidationResult and filters on
  `status != 'superseded'` — those would need updating to use
  timestamp-based "current result" logic instead.
- Confirm step 21 accepts the row regardless of its current status
  (Workato won't block an UPDATE based on a current value, but the
  logical model needs to permit both source states).

---

## U-01 — Handle errors

### Purpose
Error handler. Called async from many recipes when something fails.
Currently writes structured error context to RUN_PipelineError. Under
this rationalization, U-01 redirects those writes to SYS_EventLogs
and RUN_PipelineError is dropped.

### State touches (current)
- Writes RUN_PipelineError with structured fields (recipe_name, step_number, error_type, error_message, supplier_request_id, template_project_id, correlation_id, occurred_at, alert_sent, resolved, resolved_at)

### State touches (target)

| Op | Target | Notes |
|---|---|---|
| INSERT | SYS_EventLogs | One row per error call. `phase='error'`, `severity='error'`, structured context goes in `details_json`. |

### Edit list

1. **Replace the RUN_PipelineError INSERT step with a SYS_EventLogs INSERT step.** Field mapping:
   - `recipe_name` → fold into `source_recipe`
   - `step_number`, `error_type`, `error_message`, `alert_sent` → fold into `details_json` as a structured payload
   - `supplier_request_id`, `template_project_id` → fold into `details_json` (no top-level fields on SYS_EventLogs for these, but they're queryable from the JSON if needed)
   - `correlation_id` → maps to SYS_EventLogs.correlation_id directly
   - `occurred_at` → fold into `timestamp` (or rely on `Created time` system field)
   - **Drop:** `resolved`, `resolved_at` — there's no error-triage workflow today; if one is built later, add fields to SYS_EventLogs at that point.
2. Confirm the `phase` value written is `'error'` (already in the SYS_EventLogs enum).
3. Confirm `severity='error'`.

### Reasoning

- **Why drop RUN_PipelineError entirely?** Single chronicle is simpler than two. RUN_PipelineError carried operational fields (`resolved`, `alert_sent`) that imply a triage workflow that doesn't exist as a real process today. Storing fields for hypothetical workflows creates drift; better to drop them and re-add when the workflow materializes.
- **Why `details_json` for the structured context?** SYS_EventLogs is a single-shape event-log table; per-event-type structure goes in JSON. This is the same pattern as application logs everywhere — a thin uniform envelope, structured payload inside. Queries that need step_number or error_type can extract from the JSON; the common case (filtering by severity, phase, correlation_id, timestamp) hits indexed top-level fields.
- **Why does U-01 stay async-callable?** No change to U-01's contract from the recipes that call it. The 9 callers (B-01, B-02, P-01, RW-01, V-01a, V-01b, V-02, WFA-03a, WFA-04a) keep calling it the same way. Only the table U-01 writes to changes.

### Verification

- Confirm no recipe in the platform reads from RUN_PipelineError. Do a search across recipes — if any read it, those need to migrate to read from SYS_EventLogs (filtering by `severity='error'` or `phase='error'`).
- Confirm `details_json` payload structure is documented somewhere central — without that, every reader has to reinvent the schema for the error-context JSON. Consider an ADR or a comment in the U-01 recipe describing the expected shape.

---

## Recipes with no state-machine work needed

Verified against the catalog: these recipes either don't touch state
machines, or only read them. No vocabulary edits required.

| Recipe | Why no edits |
|---|---|
| **B-05** | Analyst portal access webhook. No state-machine writes. |
| **C-01** | Config validation. Returns to caller; no state-machine writes. |
| **P-02a** | XLSX template generation. File operations only. |
| **P-02b** | Incumbent data seed. WFA_SupplierRequest field update at step 22 is non-status. |
| **P-03b** | Invitation dispatch detail. Called by P-03a; no state-machine writes. |
| **WFA-03a** | Table listener. Dispatches WFA-03b on table updates; no state machine writes itself. |
| **WFA-04a** | Form staging. Writes to WFA_Cache (not a state-machine table). |
| **WFA-04b** | Single worker entry save. Writes to WFA_Cache. |
| **WFA-05a** | Analyst dropdown. Read-only. |
| **WFA-05b** | Analyst dropdown. Read-only. |
| **WFA-05c** | Late incumbent data. Calls P-02b; no direct state-machine writes. |

(U-01 was previously in this list but now requires an edit — see the
U-01 section above.)

---

## Data model changes required

Beyond recipe edits, these source schemas need updates so the data
model and recipes agree.

### Enum changes

| Table | Field | From | To |
|---|---|---|---|
| HOME_Requests | status | `PENDING | PROVISIONING | ACTIVE | FAILED | CLOSED` | `received | succeeded | failed | rejected` |
| WFA_SupplierRequest | status | `pending | sent | in_progress | submitted | validated | accepted | rejected` | `assigned | working | submitted | awaiting_review | rework_needed | done` |
| RUN_Upload | status | `received | extracting | validating | validated | failed` | `received | failed` |
| RUN_ValidationResult | status | `running | passed | failed | error` | `running | passed | failed | error` (no change; running reserved) |
| VER_TemplateVersion | status | `draft | published | deprecated` | `draft | published | deprecated` (no change) |
| SYS_EventLogs | phase | (current 19-value enum) | (see "SYS_EventLogs phase enum reconciliation" below) |

Update the source table hint in Workato so the JSON Schema generator
emits the new enum on next regen. The `ENUM_OVERLAY` in
`generate_schemas.py` is the secondary source if hint editing is
inconvenient.

### SYS_EventLogs phase enum reconciliation

The full target enum, ordered to match the phase taxonomy in the
canonical reference:

```
webhook_validated, webhook_rejected, request_routed,
provisioning_started, workspace_provisioned,
config_validated, config_invalid, config_failed_to_parse,
schema_persisted, templates_generated, incumbent_data_seeded,
version_published, version_deprecated,
suppliers_bootstrapped, suppliers_migrated, supplier_invited,
recipe_completed, recipe_failed,
submission_received, upload_received, upload_failed,
submission_validated, submission_invalid,
submission_accepted, rework_dispatched,
error
```

**Removed from the previous enum:** `webhook_received` (collapsed into
`webhook_validated`), `request_marked_active` (renamed to
`recipe_completed`).

**Added:** `version_deprecated`, `supplier_invited`,
`submission_received`, `upload_received`, `upload_failed`,
`submission_validated`, `submission_invalid`, `submission_accepted`,
`rework_dispatched`.

### Tables to drop

- **RUN_PipelineError** — absorbed by SYS_EventLogs (see U-01 section).
  Drop after U-01's recipe edit lands and any readers have migrated
  to SYS_EventLogs.

### New fields

- **WFA_SupplierRequest.invited_at** — date-time. Set by P-03a step 14.
  Captures when an invitation was dispatched, replacing the previous
  `status='sent'` semantic.

### Tables outside this analysis

- **HOME_WorkspaceRegistry** — no recipes in the upload set touch this
  table. Its `AVAILABLE | UNAVAILABLE` enum may be managed manually,
  by recipes outside the upload set, or vestigially. Not part of this
  vocabulary rationalization. Decide separately.
- **WFA_SupplierUser** — under our refined framing, this is an
  identity/access flag, not a workflow state machine. The
  `active | deactivated` enum stays as-is. No recipe edits.

---

## Implementation sequencing

A suggested order if you tackle these as a single coordinated change:

1. **Update source schema hints** for the enum changes (HOME_Requests,
   WFA_SupplierRequest, RUN_Upload, SYS_EventLogs.phase). Re-run
   `generate_schemas.py` to confirm the data model artifact reflects
   the new vocabulary. This sets the contract; recipes match it next.
2. **Add the `invited_at` field** to WFA_SupplierRequest. Re-run the
   schema generator.
3. **Migrate U-01 first.** Edit U-01 to write SYS_EventLogs instead
   of RUN_PipelineError. Other recipes' phase emissions in later
   steps will go through this same path, so getting U-01 right first
   means the rest of the wiring already works on day one.
4. **Edit recipes that change status values** but don't add new
   transitions: V-02 (steps 17, 21), WFA-06a (step 6), RW-01
   (steps 12, 21), P-03a (step 14, plus invited_at write), P-01
   (steps 22, 23, 51, 55, 61, 63 — vocabulary only). These are
   surgical edits.
5. **Edit recipes that drop status writes:** B-02 (step 13),
   WFA-03b (step 20 success branch). The recipes still execute their
   non-status field updates.
6. **Add new state-machine writes:**
   - WFA-03b step 11 (working → submitted)
   - WFA-03b step 20 error branch (submitted → working rollback)
   - WFA-04c step 14 (working → submitted)
   - WFA-04c new try/catch with rollback
7. **Add the P-01 try/catch wrapper** with succeeded/failed terminal
   writes, plus the granular milestone phase emissions
   (`provisioning_started`, `config_validated`, `schema_persisted`,
   `templates_generated`, `incumbent_data_seeded`).
8. **Wire phase emission** for every transition across the rest of
   the recipes. By this point, U-01 (or the SYS_EventLogs writer)
   is reusable from anywhere.
9. **Drop RUN_PipelineError** from the data model. Only do this after
   U-01 is migrated and verified, and after confirming no recipe
   reads from RUN_PipelineError. Re-run `generate_schemas.py`.
10. **Run the parking lot verifications:** B-02 step 19, P-01
    step 10, WFA-06a step 6.

Steps 1–2 should happen in one batch (data model contract).
Step 3 (U-01) is a critical-path single-recipe migration.
Steps 4–7 can happen one recipe at a time (each recipe is
independently testable). Step 8 can happen incrementally per recipe
or as a final pass. Step 9 is destructive — only run after the
upstream migration is confirmed working. Step 10 is investigative
and may produce additional small edits.

## After implementation

The seed-sheet workbook becomes the long-term operational reference,
not this guide. Expected updates to the workbook after this work
lands:

- **Tab 1 (States)** — replace the speculative entries with the
  canonical vocabularies above. Add the WFA_TemplateProject row from
  the prior analysis if the project_completion_status work proceeds
  separately.
- **Tab 2 (Transitions)** — every row's "Currently implemented?"
  column should flip from `NO`/`Partial` to `Yes`. The recipe step
  numbers in this guide replace any stale step numbers in the seed.
- **Tab 4 (Recipe → state changes)** — replace the seed's `NO`-flagged
  rows with the table from this guide. The "Currently emitted?"
  column moves to `Yes` as phase emission lands per recipe.
- **Tab 5 (Open questions)** — most of the seed's open questions
  resolve through this work. Surviving open questions move to the
  parking lot section here.

---

*This guide reflects decisions made during the working session of
2026-04-28. Re-validate against the catalog before implementation if
recipes have changed since.*
