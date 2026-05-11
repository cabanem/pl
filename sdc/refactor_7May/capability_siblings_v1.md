# SDC Data Collection — Sibling Capability Scopes (v1, Phase 0)

## Status

Closes Phase 0's plain-language scoping work. Eight siblings, each scoped lightly (roughly half a page) — enough to surface assumptions before the build queue pulls from them, but lighter than the four primary deep dives. Companion to the workflow inventory, the data model (v2), the state machine doc, the naming conventions doc, the workflow stages doc, the four primary capability deep dives, the ADR triage, and the callable triage v2.

The four primary deep dives followed a fixed structure: Intent / Where called from / In / Out / Substages / Edge cases / What it deliberately does not do / In-out summary. Sibling scopes here use a compact version: Intent / Called from / In and out / Substages / Side-effect signature / Open questions. Anything genuinely new that doesn't fit those buckets goes in open questions.

Several siblings are partly settled by upstream work — STS-01's derivation table is in the state-machine doc, UPL-02 has a paragraph in the naming doc, OBS-01 inherits ADR-058's phase taxonomy and ADR-059's emitter generalization. The scopes below reference those settlements rather than restating them.

The eight, grouped:

1. **Status-change handler (STS-01).** *Cross-cutting.*
2. **Event emission utility (OBS-01).** *Cross-cutting.*
3. **Refresh outreach.** *Invite cluster.*
4. **Add user to request.** *Invite cluster.*
5. **Reassign request.** *Invite cluster.*
6. **Incumbent data seeding.** *Independent — sibling of Build XLSX template.*
7. **Resubmission template generation (UPL-02).** *Independent — sibling of Build XLSX template + Validate supplier input.*
8. **Reminder eligibility evaluation.** *Independent.*

---

## 1. Status-change handler (STS-01)

**Intent.** Single writer of `status`, `supplier_display_status`, and `supplier_message` on `SUP_SupplierRequest`, plus `current_state_entered_at`. Validates legal transitions, computes display fields per the state-machine doc's derivation table, and emits an event. Runs on real transitions and on display-refresh events (notably the no-op transition under invariant 7 — repeated validation failure within `supplier_action_required`).

**Called from.** PRV chain (`pending → sent`); VAL-01 (`sent / supplier_action_required → pending_review` or back to `supplier_action_required`); REV chain (`pending_review → approved` or `→ supplier_action_required`); cancellation paths from any non-terminal state; the display-refresh callsite inside VAL-01 when validation fails again on a request already in `supplier_action_required`.

**In.** `supplier_request_id`, `target_state`, `trigger_context` (e.g. `system_validation_failed`, `analyst_rework`, `analyst_approve`, `analyst_cancel`, `display_refresh`), and the small bag of context the derivation table consumes (review-note text and timestamp where applicable, cancellation reason, etc.).

**Out.** Atomic write of `status`, `supplier_display_status`, `supplier_message`, `current_state_entered_at`. Event emitted via OBS-01. On a target state that fails its field-level preconditions (e.g. `pending_review` without a passing `current_validation_result_id`), the handler refuses the transition and returns a structured invariant-violation error; no fields are written.

**Substages.** Read current row → validate transition is in the state-machine doc's transition table or is an in-place display refresh → check field-level preconditions for the target state → resolve the derivation row (target state + trigger context) → compose the literal display strings (templating happens here, not at render — invariant 6) → atomic write → emit event.

**Side-effect signature.** Internal persistence. One row updated, one event row written. No outward-facing effects — the handler does not send mail or notify portals. (The recipes that *call* the handler do that; this capability stays focused on the state field.)

**Open questions.** Workato's atomicity guarantee on a multi-field update inside a single recipe step. The state-machine doc treats all four writes as atomic; if the platform doesn't actually guarantee that, drift between the four fields becomes possible during the failure window of a single call. Worth confirming at build, and worth a fallback (e.g., write `status` last, read-after-write reconcile) if the guarantee is weaker than assumed.

---

## 2. Event emission utility (OBS-01)

**Intent.** Single writer of `EventLog` rows. Severity-keyed; covers both routine audit (info) and incident tracking (warn / error with optional follow-up fields). The single-emitter rule eliminates phase-vocabulary drift between recipes — ADR-058's canonical phase taxonomy lives in this capability's input validation.

**Called from.** Effectively every recipe. Most often: STS-01 on transition, VAL-01 on validation outcomes, the PRV chain on provisioning events, error handlers across the system, and the Invite-cluster siblings on outreach dispositions.

**In.** `severity` (`info` | `warn` | `error`), `source_recipe`, `step_number`, `phase` (validated against the canonical taxonomy), `human_message`, `details_json` (optional), `supplier_request_id` (optional — many events aren't request-scoped), `error_type` (optional), and the incident-tracking flags (`alert_sent`, `resolved`, `resolved_at`) when the caller is logging a tracked incident rather than a routine event.

**Out.** One `EventLog` row written, with `timestamp` captured at write time. On `severity=error` with the alert flag set, optionally hands off to an alert-dispatch capability (see open question).

**Substages.** Validate inputs (severity is known, phase is in the canonical taxonomy) → compose row, capturing timestamp at write time → write to `EventLog` → conditionally hand off to alert dispatch.

**Side-effect signature.** Internal persistence. Possibly outward-facing in the alert path — but the alert-dispatch boundary is the cleanest place for the outward effect to live, not OBS-01 itself.

**Open questions.** Whether OBS-01 dispatches alerts directly or only writes the row and leaves dispatch to a separate watcher. Cleaner design: OBS-01 writes; a separate capability (or scheduled recipe) watches `EventLog` for unresolved error rows and dispatches. Keeps OBS-01 a pure-write utility and lets the alert policy live where alert policies belong. Confirm at build.

---

## 3. Refresh outreach

**Intent.** Regenerate the template link and re-send outreach emails to attached supplier users on a request that's already been invited. Used when a link expired (10-day FileStorage TTL), when a user lost the email, or when a reminder cycle warrants a fresh nudge with a working link. Does not change task assignment, does not change state, does not grant access to anyone new.

**Called from.** Reminder firing layer (REM cycle / R4) once eligibility evaluation says a tier should fire; analyst-initiated re-invite path (a UI trigger to be defined). The triage-v2 resolution explicitly carved this out as a sibling rather than a mode of Invite — see "Re-invite semantics" in the resolutions.

**In.** `supplier_request_id`; optional `user_filter` (default: all active `SUP_SupplierUser` rows for the supplier); optional `outreach_text` override (default: standard template).

**Out.** Per-user disposition (`sent` / `failed` / `skipped`). Fresh shareable link captured in the event log's `details_json` as a write-time snapshot per state-machine invariant 6.

**Substages.** Read SupplierRequest, verify state is `sent` or `supplier_action_required` (refusing other states) → generate fresh link via UTL-01 from `template_path` → for each filtered user, send email and record disposition → emit event with the link snapshot.

**Side-effect signature.** Outward-facing (emails sent). No state change, no task reassignment, no access change.

**Open questions.** Whether Refresh outreach updates `last_reminder_sent_at`. Cleaner answer: no. That field is the reminder workflow's bookkeeping; if Refresh is called from analyst action rather than a reminder fire, conflating the field misleads the eligibility evaluator. The reminder firing layer updates the field after Refresh outreach returns. Confirm at build.

---

## 4. Add user to request

**Intent.** Grant portal access to a newly-attached user on an active request, send them outreach, leave existing users / task assignment / state alone. The "adding users mid-engagement" gap from the workflow stages pass lands here.

**Called from.** Analyst UI when adding a user mid-engagement. Possibly downstream automated paths if supplier-driven self-onboarding is added (currently out of scope).

**In.** `supplier_request_id`, `supplier_user_id`. The user must already exist on the supplier (data-model invariant 4: SupplierUsers belong to Suppliers, not to Requests).

**Out.** The new user has portal access scoped to this request and has received outreach. Per-user disposition returned. No effect on existing users.

**Substages.** Read SupplierRequest, verify state is non-terminal and the user is `active` per `SUP_SupplierUser.status` → grant portal access scoped to this request → generate fresh link via UTL-01 → send outreach to one user → emit event.

**Side-effect signature.** Outward-facing (one access grant, one email). No state change, no task change.

**Open questions.** What happens if the new user has `primary = true`. Data-model invariant 6 requires exactly one primary per supplier; if the supplier already has one, the invariant fails. *Validate config* enforces this at config time, but Add user to request runs at runtime, so it has to enforce it too. Two clean answers: (a) refuse the add and report which existing user is the primary, forcing the analyst to demote first; (b) implicitly demote the existing primary as part of the add. Lean toward (a) — implicit demotion is the kind of silent action that produces "wait, who got moved?" support tickets. Worth a deliberate test for both this capability and *Validate config*: same invariant, two enforcement points.

---

## 5. Reassign request

**Intent.** Move the platform task from one assignee to another and notify both. No access changes, no state change. Covers the supplier-deactivation-mid-cycle case when the deactivated user was the assignee, and the general analyst-initiated delegation case.

**Called from.** Analyst UI when the originally-assigned user can't respond, when an analyst delegates review, or when a primary user is deactivated mid-cycle.

**In.** `supplier_request_id`, `new_assignee_supplier_user_id`. The new assignee must already have access (typically an existing attached user; if not, Add user to request is the explicit prerequisite).

**Out.** Task moved on the platform's task queue. New assignee notified ("this is now yours"). Previous assignee notified if still active ("FYI, reassigned"). State unchanged.

**Substages.** Read SupplierRequest, verify state is non-terminal → verify new assignee has portal access for this request (refusing if not — fix is to call Add user to request first) → use the platform's native task reassignment to move the task → notify new and previous assignee → emit event.

**Side-effect signature.** Outward-facing (one task move, two notifications). No state change, no access change.

**Open questions.** Whether Reassign updates `SupplierUser.primary`. The `primary` flag is supplier-wide; reassigning one request's task doesn't necessarily mean the new assignee is the supplier-wide primary. Cleanest answer: Reassign does not touch `primary`. If the analyst wants to also re-elect the supplier-wide primary, that's a separate config-edit action. Confirm at build.

---

## 6. Incumbent data seeding

**Intent.** For a single supplier request, slice the project's source seeded dataset by the project's split config, write the per-request slice, and write the seeded supplier-facing template at `template_path` with the slice merged in. Consumes the three-artifact seeded-data structure from the naming doc — source dataset (`Project.seeded_data_path`), split config (`Project.incumbent_split_config`), per-request slice (`SUP_SupplierRequest.seeded_slice_path`).

**Called from.** PRV chain when a supplier request is being provisioned for the first time and the project has a `seeded_data_path`. The caller is responsible for deciding whether to call this capability (i.e. whether seeding applies to this supplier); the capability itself assumes it has work to do.

**In.** `supplier_request_id`. Reads `Project.seeded_data_path`, `Project.incumbent_split_config`, the request's `assigned_variant_id`, and the variant's `template_path`.

**Out.** `SUP_SupplierRequest.seeded_slice_path` written (canonical layout: `/requests/<request_id>/seeded_slice.xlsx`). `SUP_SupplierRequest.template_path` written with the variant's empty template + the slice rows merged in.

**Substages.** Read the source dataset → apply the split config to extract this supplier's rows → write the slice to FileStorage and record the path → read the variant's empty template → merge the slice rows into the data area → write the merged template to `template_path` and record it → emit event.

**Side-effect signature.** Internal persistence. Two file writes, two path columns updated. No outward-facing effects (no notification, no link generation — links are generated downstream by Invite or Refresh outreach).

**Open questions.** What happens if the split config produces zero rows for a supplier (the supplier has no incumbent data on file). Two answers: silently produce an empty slice and a non-seeded template, or fail and let the caller decide. Cleanest: the caller decides whether to invoke this capability based on whether a supplier has incumbent rows — this capability assumes it has work to do, and zero rows is treated as a caller error. Confirm at build, and worth a deliberate test for the boundary: a project with `seeded_data_path` set but a supplier whose name doesn't appear in the source data.

---

## 7. Resubmission template generation (UPL-02)

**Intent.** After a system-driven validation failure, render a fresh template at the supplier's `template_path` with valid rows pre-populated and invalid rows flagged so the supplier sees what to fix. The "smart-UX resubmission" path from naming-doc foundational decision 4: the data layer stays one-shot; the UX carries forward what was good. The naming doc names this capability and gives it its sequence — the scope below is the unfolding of that paragraph.

**Called from.** VAL-01 on the system-driven path through `sent → supplier_action_required` (and on the no-op transition, where validation fails again from `supplier_action_required` and the template needs another fresh carry-forward). Not called on the analyst-rework path — that path defaults to a blank template per the naming doc's resubmission decision.

**In.** `supplier_request_id`. Reads the most recent `RUN_Upload.extracted_path`, the `RUN_FieldError` rows for the most recent `RUN_ValidationResult`, and the variant's empty `template_path`.

**Out.** `SUP_SupplierRequest.template_path` rewritten (overwrite is sanctioned by invariant 11 — `template_path` is the only mutable file column).

**Substages.** Read the most recent ValidationResult and partition rows from the upload's extracted content into valid and invalid by the FieldError row numbers → read the variant's empty template → pre-populate valid rows in the data area → flag invalid rows distinctly (formatting and/or an inline note) so the supplier sees them at a glance → write the merged template to `template_path` → emit event.

**Side-effect signature.** Internal persistence. One file write, one path column updated.

**Open questions.** On the no-op transition (repeated failure within `supplier_action_required`, invariant 7), this capability runs again. The carry-forward should be "rows that were valid in the *most recent* submission" — not "rows that have ever been valid in any prior submission." Easy to confuse, and the wrong reading silently re-introduces previously-invalid data the supplier had already removed. Worth a deliberate test exercising the second consecutive failure with overlapping but non-identical valid sets. (This is the "filter to validated/approved prior submissions" trap from triage-v2's resubmit-after-failure test case, viewed from the template side rather than the validation side.)

---

## 8. Reminder eligibility evaluation

**Intent.** Given a supplier request, return whether it is eligible for a reminder right now and which tier should fire next. Read-only. Does not fire reminders, does not update bookkeeping. The clean separation the handoff asked for: *eligibility* is a state-machine concern (this capability), *firing* is a policy-layer concern (the reminder workflow).

**Called from.** The reminder firing recipe (REM cycle / R4) once per candidate request. Possibly an analyst-facing "preview" tool for surfacing which requests are due for a nudge.

**In.** `supplier_request_id` (or a `SUP_SupplierRequest` row passed through directly). Reads `status`, `reminders_enabled`, `current_state_entered_at`, `last_reminder_sent_at`, `last_reminder_tier`, and `Project.reminder_days_1` / `_2` / `_3`.

**Out.** Structured verdict: `{ eligible: bool, next_tier: 1 | 2 | 3 | null, reason: string }`. Reason is human-readable for audit and analyst-preview surfacing.

**Substages.** Check state is `sent` or `supplier_action_required` per state-machine invariant 4 (else ineligible: "state not in eligible set") → check `reminders_enabled = true` (else ineligible: "reminders disabled per request") → compute days since the cycle anchor (`current_state_entered_at` if `last_reminder_tier=0`, else `last_reminder_sent_at`) → compare against the next tier's threshold from `Project.reminder_days_*` (else ineligible: "next tier not yet due, X days remaining") → check tier ceiling (`last_reminder_tier=3` → ineligible: "tier 3 reached; post-tier-3 unspecified") → eligible: return `next_tier` and "tier N due."

**Side-effect signature.** Pure read. No writes.

**Contract with the firing layer.** The firing recipe (REM-01 or whatever R4 becomes after callable rebuild) iterates candidates filtered at the SQL layer for efficiency (state in eligible set, reminders enabled), calls this capability per candidate, and for those that come back eligible, calls Refresh outreach and updates `last_reminder_tier` and `last_reminder_sent_at` itself. The bookkeeping update is the firing layer's responsibility — this capability is read-only.

**Open questions.** Post-tier-3 behavior, unresolved in the workflow stages doc (open question 7). Two clean answers: (a) introduce an `escalate` outcome so the firing layer can route to an analyst-notification path; (b) leave eligibility honest about being out of tiers and let a separate escalation capability decide what happens. Lean toward (b) — eligibility is about reminders only; escalation is a different concern with different inputs (probably "how long has the request been stuck") and different consumers (probably the analyst, not the supplier). Confirm before the reminder workflow build starts.

---

## Cross-cutting open questions surfaced

A handful of items came up in more than one sibling, worth surfacing once rather than repeating:

- **Domain code for the Invite-cluster siblings.** Refresh outreach, Add user to request, and Reassign request don't fit any of the nine domain codes in the naming doc (PRV, CFG, VAL, UPL, STS, REM, REV, OBS, UTL). Refresh runs from the reminder cycle, but it's not a reminder; Add and Reassign are user-/access-management, not provisioning. Two options: introduce a new domain code (candidates: `INV` for invitation/outreach, `ACS` for access, or `NTF` for notification — all reasonable), or absorb into one of the existing codes (REM is the closest near-miss). Build session decision; not blocking.
- **Atomicity assumptions across multi-field writes.** STS-01 assumes atomicity across four field updates; OBS-01 + STS-01 together assume atomicity across two row writes (one EventLog row + one SupplierRequest update). Workato's actual guarantee on these patterns is worth confirming once before the cross-cutting siblings are built, since several other capabilities will inherit the assumption.
- **Validation invariants enforced at multiple boundaries.** Invariant 6 (exactly one primary per supplier) is enforced by *Validate config* at config time and by Add user to request at runtime. Both checks must hold; both should reuse the same predicate. Worth surfacing as a build-time pattern: invariant predicates are shared callables, not duplicated logic.

---

## Pending in Phase 0

- **Per-sibling detailed scoping** if any of the eight surfaces enough complexity at build time to warrant the full primary-deep-dive treatment. Most should not — the half-page bound was chosen because the upstream artifacts had already done the heavy lifting. Reminder eligibility's contract with the firing layer is the most likely candidate for upgrade; the two cross-cutting siblings (STS-01, OBS-01) could also need expansion if the atomicity question above turns out to be more involved than expected.
- **Build queue sequencing.** Suggested order from the handoff: data model v2 → STS-01 + OBS-01 → Validate config → Build XLSX template → Validate supplier input → Invite supplier users → the three Invite cluster siblings → Incumbent data seeding → Resubmission template generation → Reminder eligibility evaluation. X1 (Export to target system) sits outside this ordering and probably needs its own design pass before it joins the queue.
- **Domain-code decision for the Invite cluster** (cross-cutting open question above). Worth resolving before the build pulls those three siblings off the queue, but not blocking earlier work.
