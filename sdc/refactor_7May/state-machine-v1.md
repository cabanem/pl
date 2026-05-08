# SDC Data Collection — State Machines (v1, Phase 0)

## Status

Workstream 2 of Phase 0. Locked decisions on status values, transitions, and the `supplier_display_status` / `supplier_message` derivation rule are recorded here. Companion document to `sdc-data-model-v1.md`. Naming and prefix conventions, ADR triage, and callable reuse-vs-rebuild are still pending in subsequent sessions.

## Foundational decisions

Three answers shaped the state machine design:

1. **The audit chain carries the "why," the state machine carries the "what."** System-driven rework (failed validation) and analyst-driven rework (rejected submission) both land in the same state. The reason lives in ValidationResult/FieldError or ReviewNote, not in the state name.
2. **Upload owns the in-flight pipeline; SupplierRequest tracks resting states only.** The `received → extracting → validating → validated|error` arc lives on Upload. SupplierRequest never transitions through `submitted` — it waits in `sent` or `supplier_action_required` until Upload completes and the resting situation changes.
3. **State knows nothing about reminders.** The state machine defines reminder *eligibility*. *Firing* — cadence, opt-out, per-supplier overrides, batched analyst-driven nudges — is a policy-layer decision inside the reminder workflow.

## Summary of changes from the prior model

**Removed:**
- `in_progress` (no behavior distinguished it from `sent`)
- `submitted` (Upload owns the in-flight pipeline)
- The two parallel tracking systems (`status_StateMachine` and WFA stages); WFA stage is now a derived view of `status`
- `rejected` as a state (demoted to a transition, captured in ReviewNote)
- The `validated` / `pending_review` split (collapsed; validation passing and analyst notification co-occur)

**Added:**
- `cancelled` as a single terminal-not-approved state covering pre-submission cancellation and post-engagement give-up
- Explicit derivation rule for `supplier_display_status` / `supplier_message`
- Reminder eligibility as a state-machine concern; reminder *firing* as a policy-layer concern

**Renamed:**
- `accepted` → `approved` (canonical)
- `data_entry` → `supplier_action_required` (canonical)
- `validation_success` → folded into `pending_review`
- `Upload.status: failed` → `error` (symmetry with ValidationResult; disambiguates from "validation found bad data")

**Net:** twelve candidate names (documented enum plus recipe-side drift) → six SupplierRequest states.

---

## SupplierRequest — six states

For each state: when it's entered, what the system can do, what it cannot do.

### pending

*Entered when:* an analyst creates a SupplierRequest before commitment to invite — supplier known but contact details missing, or campaign being staged for batch send.

*Can:* edit metadata, assign contacts, attach a variant, transition to `sent` or `cancelled`.
*Cannot:* accept submissions, run validation, surface to the supplier portal. `template_file_id` not required.

### sent

*Entered when:* the invitation has been issued and `template_file_id` is populated.

*Can:* accept an Upload, accept a ManualEntry, regenerate `template_file_id` on the 10-day FileStorage TTL, send reminders (per policy layer).
*Cannot:* show analyst review pages — nothing to review yet.

### supplier_action_required

*Entered when:* a previous submission needs supplier remediation, regardless of cause — system-driven via failed ValidationResult, or analyst-driven via a ReviewNote with `review_action: rework`.

*Can:* accept resubmission (creates a new Upload), regenerate template link, send reminders (per policy layer). Identical to `sent` from the supplier's side.
*Cannot:* display the same `supplier_message` as `sent` — see derivation rule.

The state is unitary; the two entry paths differ only in the audit chain that produced them, not in subsequent behavior.

### pending_review

*Entered when:* validation has passed and the analyst owes a decision (`current_validation_result_id` points at a ValidationResult with `status=passed`).

*Can:* accept Approve (→ `approved`, writes ReviewNote), accept Reject (→ `supplier_action_required`, writes ReviewNote), accept Cancel (→ `cancelled`).
*Cannot:* accept new supplier submissions — supplier sees a "submission under review" message until the analyst acts.

### approved

Terminal.

*Entered when:* the analyst approves; `approved_at` and `approved_file_id` are written write-once.

*Can:* serve the approved snapshot to downstream consumers, be referenced for reporting.
*Cannot:* transition further, accept submissions, send reminders.

### cancelled

Terminal.

*Entered when:* the analyst closes the engagement without approval — pre-submission cancellation (wrong supplier, scope change) or post-engagement give-up (supplier can't deliver, declined to engage).

*Can:* be referenced for reporting; the cancellation reason lives in EventLog.
*Cannot:* transition further, accept submissions, send reminders.

### Transition graph

```
   pending ──────► sent ─────────► pending_review ─────► approved
      │             │  ▲                  │
      │             │  │                  │
      │             ▼  │                  ▼
      │     supplier_action_required ◄────┘
      │             │
      ▼             ▼
            cancelled (terminal)
```

| From | To | Trigger | Side effects |
|---|---|---|---|
| pending | sent | Analyst issues invitation | Write `template_file_id`, `last_reminder_tier=0`, `current_state_entered_at`; send invite email |
| pending | cancelled | Analyst cancels staged request | EventLog with cancellation reason |
| sent | pending_review | Validation passes (Upload terminal, ValidationResult `status=passed`) | Write `current_validation_result_id`, `last_valid_row_count`, `last_invalid_row_count=0`; notify analyst |
| sent | supplier_action_required | Validation fails (Upload terminal, ValidationResult `status=failed`) | Write `current_validation_result_id`, row counts, FieldError rows; notify supplier |
| sent | supplier_action_required | system_structural_failure | Write current_validation_result_id (pointing at a RUN_ValidationResult with status=error), write the structural error summary into the trigger context bag for derivation; notify supplier |
| sent | cancelled | Analyst cancels post-invite | EventLog with cancellation reason |
| supplier_action_required | pending_review | Validation passes on resubmission | Same as `sent → pending_review` |
| supplier_action_required | supplier_action_required | system_structural_failureSame as above. No-op transition under invariant 7; new RUN_Upload, new RUN_ValidationResult, refreshed display fields, same state. |
| supplier_action_required | cancelled | Analyst gives up on supplier | EventLog with cancellation reason |
| pending_review | approved | Analyst clicks Approve | Write ReviewNote (`review_action=approved`), `approved_at`, `approved_file_id` |
| pending_review | supplier_action_required | Analyst clicks Reject | Write ReviewNote (`review_action=rework`); notify supplier |
| pending_review | cancelled | Analyst cancels after review | EventLog with cancellation reason |

Every transition also writes `status` and `current_state_entered_at`. These are implicit on every row, not repeated above.

### The no-op transition

When a supplier resubmits from `supplier_action_required` and validation fails again, **the request does not transition**. A new Upload is created, a new ValidationResult with `status=failed` is written, new FieldError rows are written, and `current_validation_result_id` plus the row-count fields are updated. The state stays `supplier_action_required`. The supplier sees fresh error counts via the derivation rule, but the state has not moved.

This is the elegant consequence of folding `validated` into `pending_review` and treating `submitted` as Upload's concern: repeated validation failures are pure audit-chain churn, not state churn. The state moves only when the *resting* situation changes.

When a supplier resubmits from supplier_action_required and either validation fails again or the new submission is structurally unparseable, the request does not transition. A new Upload is created, a new ValidationResult is written (with status=failed for content failure or status=error for structural failure), new FieldError rows are written (per-cell for content failure; one summary row for structural failure), and current_validation_result_id plus the row-count fields are updated. The state stays supplier_action_required. The supplier sees fresh error details via the derivation rule, but the state has not moved.

### Field-level preconditions

The status-change handler enforces these on transition:

- `sent`: non-null `template_file_id`.
- `pending_review`: non-null `current_validation_result_id` pointing at a `ValidationResult` with `status=passed`.
- `approved`: non-null `approved_at` and `approved_file_id`, both write-once.
- `cancelled`: no positive precondition — explicit absence of approval.

### Cancellation reason routing

Cancellations can fire from `pending`, `sent`, `supplier_action_required`, and `pending_review`. Only one of those four has a ReviewNote moment. To keep the audit trail consistent, **all cancellation reasons route to EventLog**, regardless of source state. ReviewNote stays semantically tight — "what the analyst said during formal review." `ReviewNote.review_action` enum stays `approved | rework`.

---

## Display derivation: `supplier_display_status` and `supplier_message`

The status-change handler is the single writer of `status`, `supplier_display_status`, and `supplier_message`. The handler runs on:

1. **Real transitions** (rows in the transition table).
2. **Display-refresh events** — cases where status stays the same but the display fields need to update.
   a. The canonical case is repeated validation failure in `supplier_action_required`: state doesn't change, but `supplier_message` should reflect the *new* error counts and link to the *new* validation report.R
   b. Pipeline error during validation (no state transition; pipeline_error_alert trigger context refreshes the display to a "we're reviewing it" message while the analyst investigates).
   c. Repeated structural failure within supplier_action_required (treated like case 1 — same no-op mechanics, the structural-failure derivation row renders).

Both cases write all three fields atomically.

### Derivation table

| Target state | Trigger context | supplier_display_status | supplier_message |
|---|---|---|---|
| pending | — | (not displayed; no portal access) | — |
| sent | invitation issued | "Action needed: data template" | "Please complete the attached template and submit by {due_date}." |
| sent (no transition) | pipeline_error_alert | "Submitted — under review""Your submission on {submitted_at} is being reviewed. No action is needed from you at this time." |
| supplier_action_required | system validation failed | "Action needed: corrections required" | "Validation found {invalid_row_count} issue(s) in your submission on {validated_at}. Please review the error report and resubmit. {validation_report_link}" |
| supplier_action_required | system_structural_failure | "Action needed: submission could not be processed""Your submission on {submitted_at} could not be processed: {structural_error_summary}. Please review the requirements and submit a corrected file." | 
| supplier_action_required | analyst rework | "Action needed: changes requested by reviewer" | "The reviewer requested changes on {reviewed_at}: {review_note_text}. Please review and resubmit." |
| pending_review | submission validated | "Submitted — under review" | "Your submission was received on {submitted_at} and is being reviewed. No further action is needed." |
| approved | analyst approved | "Approved" | "Your submission was approved on {approved_at}. Thank you." |
| cancelled | analyst cancelled | "Request closed" | "This request has been closed. Please contact {analyst_email} with questions." |

### Storage semantics

Both fields are stored as **literal strings, snapshot at write time**. Templating happens inside the handler recipe; the WFA does not interpolate at render. Wording changes are handler-recipe code changes, not data migrations.

### Handler input contract

What the handler must be passed (or able to read) to compute the right pair:

- Target state and trigger context (system path vs analyst path for `supplier_action_required`).
- `last_invalid_row_count`, `last_validation_report_link` (already on SupplierRequest).
- `approved_at` (already on SupplierRequest).
- Most recent ReviewNote text and timestamp (join from ReviewNote, scoped to this request).
- `Project.analyst_email` for the cancellation message.
- A `due_date` value for the `sent` message — see backport list.
- structural_error_summary — one-line description of a structural failure (e.g., "missing required sheet 'WorkerData'", "file appears corrupted"). Required when trigger context is system_structural_failure. Populated by VAL-01.

### Why one state can carry two messages

`supplier_action_required` has two entry paths (system and analyst), and the derivation rule reads trigger context to choose between them. The state stays unitary because subsequent supplier behavior is identical — they need to fix something and resubmit. The audit chain (ValidationResult + FieldError vs ReviewNote) remains the source of truth for *why*; the display fields are a snapshot of that *why* at write time.

---

## Upload — five states

`received`. Entered when the supplier submits a file via the WFA upload page. Can: extract the payload. Cannot: run validation (extraction must produce row data first).

`extracting`. Entered when extraction begins — XLSX parsing, header check, row enumeration. Can: transition to `validating` or `error`. Cannot: accept further submissions against this Upload row; resubmission creates a new Upload.

`validating`. Entered when extraction completed cleanly and validation begins. Can: transition to `validated` regardless of pass/fail outcome, or to `error` on a pipeline error. Cannot: produce a verdict — that's ValidationResult's job.

`validated`. **Terminal-success.** Entered when validation completed and produced a ValidationResult row. Can: be referenced by SupplierRequest and ValidationResult. Cannot: transition further.

> Important: `validated` does **not** mean the data was good. It means the pipeline ran to completion and a ValidationResult exists. Bad-data outcomes are `validated` Uploads with `failed` ValidationResults.

`error`. **Terminal-pipeline-error.** (Renamed from `failed` for symmetry with ValidationResult and to disambiguate from "validation found bad data.") Entered when extraction or validation pipeline crashed. Can: be referenced for diagnostics and EventLog. Cannot: transition further. A new Upload is required for retry.

Transitions are linear: `received → extracting → validating → validated`, with `error` as an off-ramp from `extracting` or `validating`.

---

## ValidationResult — four states

`running`. Entered when validation begins (same recipe step that flips Upload to `validating`). Can: write FieldError rows as validation runs. Cannot: be consumed by SupplierRequest yet — the verdict isn't in.

`passed`. **Terminal-success.** Entered when validation completed with zero FieldError rows. Drives SupplierRequest to `pending_review`.

`failed`. **Terminal-success-with-bad-data.** Entered when validation completed with one or more FieldError rows. Drives SupplierRequest to `supplier_action_required`. *Distinct from Upload's `error`* — this is "validation worked correctly and found problems."

`error`. **Terminal-pipeline-error.** Entered when the validation engine itself failed before producing a verdict. In normal operation, `error` on ValidationResult and `error` on Upload coexist.

The terminology pair is now consistent across both tables: `error` means "the pipeline crashed"; bad-data outcomes are surfaced via `failed` on ValidationResult only, where the distinction matters.

---

## TemplateVersion — three states

`draft`. Entered on creation by the analyst's config submission. Can: edit Field, Lookup, ValidationRule, Variant, VariantField, FormSlotMapping, ErrorMessage rows scoped to this version. Cannot: accept SupplierRequest rows pointing at this version.

`published`. Entered when the analyst publishes; data model invariant #2 (snapshot semantics) locks in. Can: be referenced by SupplierRequest's `assigned_version_id`. Cannot: edit any version-scoped config row, ever.

> Forward-only: there is no `published → draft` path. Typo fixes flow through new draft versions. This is the snapshot semantics invariant restated.

`deprecated`. Terminal. Entered when the analyst retires a version. Can: continue serving existing in-flight SupplierRequest rows. Cannot: accept new SupplierRequest rows pointing at this version.

In-flight requests on a deprecated version run to terminal on that version. New work goes on the new version.

---

## Trivial state machines

Three machines have one boolean field with two states each. They earn mention because they're real states in the data model, but they don't earn the elaborate treatment above.

**`Supplier.status` — `active | deactivated`.** Active is the default. Deactivated stops the supplier appearing in lookups for new SupplierRequest creation, but does not affect existing in-flight requests. Use case: a supplier we no longer engage at all, across any client or version. Distinct from per-request `cancelled` (one engagement); deactivation is the supplier-wide statement.

**`SupplierUser.status` — `active | deactivated`.** Mirror at the contact level. Deactivated contacts don't receive invitations or reminders on new requests; in-flight requests assigned to that contact at invitation time stay assigned (no mid-cycle reroute). The data-model invariant — SupplierUser belongs to Supplier, not to any one Request — means this state survives across versions.

**`Project.project_completion_status` — `active | inactive`.** Workspace-level kill switch. Active is the operating default. Inactive signals the engagement is done and the workspace shouldn't accept new work. No recipe branches on this; it's a flag for human operators and operational tooling.

---

## Invariants

These are the contracts the recipes must honor. Documented here so they're not relitigated.

1. **Single-writer rule.** Only the status-change handler writes `SupplierRequest.status`, `supplier_display_status`, and `supplier_message`. Every other recipe reads. The handler is invoked on real transitions and on display-refresh events; both write all three fields atomically.

2. **Audit chain carries the "why."** The state name carries no causal information. System-driven rework is captured by ValidationResult + FieldError. Analyst-driven rework is captured by ReviewNote with `review_action: rework`. The state machine treats both identically.

3. **Upload owns the in-flight pipeline.** SupplierRequest tracks only resting states. The `received → extracting → validating → validated|error` arc lives on Upload; the supplier-facing display reads from Upload during the active window without requiring a SupplierRequest state to express it.

4. **State knows nothing about reminders.** The state machine defines reminder *eligibility* — `sent` and `supplier_action_required` are eligible; `pending`, `pending_review`, `approved`, and `cancelled` are not. *Firing* (cadence, opt-out, per-supplier overrides, batched analyst-driven nudges) is a policy-layer decision inside the reminder workflow.

5. **Cancellation reasons route to EventLog.** ReviewNote captures only formal review actions (`approved | rework`). All cancellations — regardless of source state — write their reason to EventLog. One consistent place to look up "why was this cancelled."

6. **Snapshot semantics for display fields.** `supplier_display_status` and `supplier_message` are stored as literal strings, snapshotted at handler write time. The WFA does not template at render. Wording changes are handler-recipe code changes.

7. **Repeated failures don't churn state.** When a supplier resubmits from `supplier_action_required` and validation fails again, the request does not transition. New Upload, new ValidationResult, updated `current_validation_result_id`, refreshed display fields — same state.

---

## Backports queued for end-of-Phase-0

Small data model amendments that fall out of this workstream. Each folds into a `sdc-data-model-v1.md` revision once Phase 0 is complete; none requires reopening the data model session.

- `SupplierRequest.current_state_entered_at` (datetime, write-on-transition). Cycle boundary for reminder cadence and "how long has X been waiting" reporting.
- `SupplierRequest.reminders_enabled` (boolean, default true). Per-request opt-out. Per-supplier or per-project policy is an additive change later if a use case forces it.
- `SupplierRequest.due_date` (date, optional) **or** `Project.default_due_days` (int). Drives the `sent` derivation message. Pick the location based on whether due dates are per-request or per-engagement; Project-level is simpler if the project default is the common case.
- `Upload.status` enum: rename `failed` → `error` for symmetry with `ValidationResult.status` and to disambiguate from "validation found bad data."
- Add pipeline_error_alert as a recognized display-refresh trigger context. Document VAL-01's responsibility to invoke STS-01 in display-refresh mode (not transition mode) when the validation engine crashes. STS-01 needs to support a "refresh-only" invocation that takes a target state matching the row's current state — confirms no transition occurs, just a display field rewrite.

---

## Deliberately omitted

- **`in_progress` as a state** — no recipe behavior distinguished it from `sent`. UI flavor masquerading as state.
- **`submitted` as a state** — Upload owns the in-flight pipeline; SupplierRequest doesn't need a parallel waiting state. The supplier-facing display reads from Upload during the active window.
- **`validated` as a state distinct from `pending_review`** — validation passing and analyst notification co-occur in the same recipe. Splitting the state was bookkeeping, not behavior.
- **`rejected` as a state** — demoted to a transition. The analyst rejecting a submission moves the request to `supplier_action_required`; the rejection reason lives in ReviewNote. `rejected` would have failed the two-sentence test (no behavior in the state, immediate transition out).
- **Splitting `supplier_action_required`** into separate system-failed and analyst-rework states — supplier behavior is identical in both. The audit chain carries the "why"; the derivation rule reads trigger context to produce different messages.
- **A separate "cancellation" state distinct from `cancelled`** — one terminal-not-approved state covers all closure reasons. EventLog carries the reason.
- **WFA stage as an independent state machine** — collapsed into a derived view of `SupplierRequest.status`. The two-system drift problem from the prior model is gone by construction.
- **A `ReminderPolicy` table** — speculative complexity. Add when a use case forces it; the current per-request `reminders_enabled` covers the immediately-anticipated need.
