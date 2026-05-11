# SDC Data Collection — Workflow Stages (v1, Phase 0)

## Status

Plain-language, stage-by-stage walkthrough of the 10 workflows enumerated in the inventory. Companion to the workflow inventory and data model. Each workflow is described in terms of intent, stages, and notes (assumptions, branches, edge cases).

The forcing function: when system jargon is stripped out, hidden assumptions tend to surface in places where the stage description goes vague. Those vague spots are the flags for callable specification later.

## Format

Each workflow has three parts:

- **Intent** — one sentence on what the workflow exists to do.
- **Stages** — ordered. Each stage names its actor and what changes.
- **Notes** — assumptions surfaced, branches, edge cases.

Actors used throughout:

- **Analyst** — the engagement-management-side person who configures and runs the project.
- **Supplier** — the organization being asked for data.
- **Supplier user** — the specific person at the supplier who fills in the form or uploads the file.
- **System** — the SDC platform itself, regardless of which component is doing the work.

---

## Engagement-scope workflows

These fire rarely. Once at the project's start, occasionally in the middle, once at the end.

### E1 — Initial provisioning

**Intent.** Set up a new client engagement so suppliers are ready to be invited.

**Stages.**

1. **Analyst prepares the configuration workbook.** Outside the system. The analyst fills in the fields to collect, the dropdowns suppliers will pick from, the validation rules, the supplier list, and engagement settings (reminder cadence, target downstream system, output folder).
2. **Analyst fires the provisioning trigger.** From the configuration workbook, the analyst hits a button that hands the workbook to the system.
3. **System reads the workbook.** Parses the analyst's configuration into structured form.
4. **System checks the configuration.** Verifies the workbook is internally consistent: required sections present, references between sections resolve (e.g., every dropdown points at a defined lookup), no forbidden combinations. If checks fail, the analyst gets specific errors and the workflow stops.
5. **System records the project.** Creates the singleton project record holding engagement-level information.
6. **System publishes the first template version.** Snapshots the configuration into per-version records and marks them published — those records won't change after this point.
7. **System builds the supplier template file.** Produces the XLSX file suppliers will download and fill in.
8. **System stages supplier records.** Creates one record per supplier listed in the configuration, one record per supplier user, and one request per supplier in a "not yet sent" state.
9. **Project ready.** The analyst sees a populated project in the workspace app. No supplier has been contacted.

**Notes.**

- Stage 4 (configuration check) is the same logic as the standalone *Validate config* capability — here it's inline.
- Stage 7 (template build) is the standalone *Build template* capability. Same observation.
- Stage 8 stages records but invites no one. Invitation is R1, deliberately separate.
- Adding suppliers later, mid-engagement, is not part of E1 and is a known gap.

### E2 — Config update / re-publish

**Intent.** Publish a new version of the template against an existing project, without disturbing suppliers already in flight.

**Stages.**

1. **Analyst updates the configuration workbook.** Same workbook shape as E1; this time the project already exists.
2. **Analyst fires the same trigger as E1.**
3. **System reads and checks the workbook.** Same as E1 stages 3 and 4.
4. **System publishes a new version.** Creates a new version record (one number higher), snapshots the new configuration into per-version records under that version.
5. **System deprecates the previous version.** Marks the old version as deprecated. Suppliers already on it are not touched.
6. **In-flight suppliers stay on their version.** Existing supplier requests keep the version number they were stamped with at provisioning. They neither know nor care that a new version was published.
7. **New version ready.** Suppliers added or invited later use the new version.

**Notes.**

- Re-engaging an old-version supplier on the new version is unspecified — known gap.
- The configuration workbook surface is the same as E1, but several scenarios change behavior (typo fix vs. structural change vs. supplier list change). Today the system treats them all the same; differentiating is not in scope.

### E3 — Engagement closure

**Intent.** Mark the engagement as complete.

**Stages.**

1. **Analyst decides the engagement is done.** Outside the system.
2. **Analyst flips the project to inactive.** A flag change on the singleton project record.
3. **Reporting reflects closure.** Operators and dashboards see the engagement is done. No automation branches on this flag today.

**Notes.**

- The flag has no behavioral consequence in the system itself. If it should — disable reminders, prevent new submissions, lock the project — that's a policy decision, not currently encoded.

---

## Request-scope workflows

These fire many times per engagement, one cycle per supplier. The thing that progresses is the supplier request — a record per supplier per engagement that holds lifecycle state, file pointers, and reminder tracking.

### R1 — Issue invitation

**Intent.** Send the invitation that turns a staged supplier request into an active one.

**Stages.**

1. **Analyst selects supplier requests to invite.** Likely a batch action in the workspace app.
2. **Analyst fires the invite action.**
3. **System generates a shareable link** to each supplier's template file. Links are short-lived (10 days), so they're produced fresh at invitation time.
4. **System moves each request from "not yet sent" to "sent".**
5. **System sends an invitation email** to each supplier user, containing the link and submission instructions.
6. **System logs the invitations.**
7. **Suppliers can begin work.** Each supplier user sees the request in the workspace app and can download the template.

**Notes.**

- Whether all supplier users on a supplier get the same email or separate ones is a delivery detail — currently per-user, but worth confirming.
- A supplier with no active supplier users is a degenerate case (no one to email). Handling is unspecified.

### R2 — File submission

**Intent.** Accept a supplier's completed XLSX template, validate it, and route to the next state.

**Stages.**

1. **Supplier user uploads the completed template** through the workspace app.
2. **System receives the file.** Records the upload, captures the file, sets the upload to a "received" state.
3. **System extracts the data** from the XLSX into a structured form the validation can consume.
4. **System runs validation.** Per-cell checks (required, type, length, format, lookup membership) and cross-field rules (conditional requirements, dependencies, uniqueness).
5. **System routes the outcome.**
   - **Pass:** the request moves to "awaiting analyst review". The validation report is recorded for the analyst.
   - **Fail:** the request moves to "supplier needs to fix". The system regenerates the template pre-populated with the rows that did pass, so the supplier corrects only what's wrong.
6. **System notifies the supplier user.** New status appears in the workspace app, with the validation report (on fail) or a "thanks, in review" message (on pass).

**Notes.**

- Stage 5's resubmission template (the system-driven rework path) is a sub-workflow worth tracking explicitly during callable triage.
- Repeated failed resubmissions don't change the state (the request stays "supplier needs to fix") but do change the supplier-facing message and the validation report. That's a display refresh, not a state move.
- Stage 4 is the *Validate supplier input* capability and is shared with R3.

### R3 — Manual-entry submission

**Intent.** Accept a supplier's row-by-row form entry as an alternative to file upload, then run the same validation as R2.

**Stages.**

1. **Supplier user enters one row at a time** in the workspace app form. Each row is one worker, one record, etc.
2. **System saves each row** as the supplier saves it. Partial entries persist between sessions.
3. **Supplier user submits all rows** when done.
4. **System runs the same validation as R2.** The input shape is different (form rows rather than XLSX cells), but the rules are identical.
5. **System routes the outcome.** Same as R2 stage 5: pass → awaiting review; fail → supplier needs to fix.
6. **System notifies the supplier user.** Same as R2 stage 6.

**Notes.**

- The "fix" path for manual entry doesn't have a regenerated template (there's no template); the supplier returns to the form with the rows they entered, sees per-row errors, and corrects.
- Whether a supplier can switch between R2 and R3 mid-cycle (entered some rows manually, then uploads a file) is unclear.
- The form's slot pool is fixed-width; how the form behaves with a configuration that has more fields than slots is a question for *Build template* / form rendering scoping.

### R4 — Reminder cycle

**Intent.** Nudge non-responsive suppliers on a configured cadence.

**Stages.**

1. **Schedule fires.** A clock-driven mechanism checks reminder eligibility periodically.
2. **System finds eligible requests.** A request is eligible if its state is "sent" or "supplier needs to fix", reminders are enabled, and the next reminder tier (1, 2, or 3) is due based on the project's cadence and the request's last-reminder timestamp.
3. **System refreshes the file link.** The shareable link to the template expires after 10 days, so the system regenerates it before sending.
4. **System sends a reminder email** to the supplier users.
5. **System advances reminder tracking.** Records that the next-tier reminder went out and stamps the time.
6. **State doesn't move.** The request stays where it was; only reminder tracking changed.

**Notes.**

- Eligibility (which states qualify, what "due" means) is a state-machine question. Firing (when the schedule actually runs, batch size, throttling) is a policy question. They sit at different levels and the contract between them needs to be explicit.
- After tier 3, behavior is unspecified — does the request escalate, go silent, or get flagged for the analyst?

### R5 — Analyst review

**Intent.** The formal accept/reject decision on a submission that already passed validation.

**Stages.**

1. **Analyst opens a request in "awaiting review"** in the workspace app.
2. **Analyst reviews the submission.** Reads the validated data and the validation report. Validation only checked structural correctness; the analyst applies judgment about content correctness.
3. **Analyst decides.**
   - **Approve:** the request moves to "approved". The system records the approval timestamp, the approver, and a pointer to the approved file.
   - **Reject (rework):** the request moves back to "supplier needs to fix" with a rework reason. The supplier sees a blank template (deliberately not pre-populated, since rework reasons may invalidate prior data).
4. **System notifies the supplier.** Either a closure-style "your data was accepted" message, or a "we need you to revise — see message" with the analyst's rework reason.
5. **Decision recorded.** A review note is logged.

**Notes.**

- Stage 3's blank-template-on-rework choice is justified (rework reasons may invalidate prior data) but hasn't been stress-tested with real rework scenarios. Worth confirming when scoping R5.
- Whether an analyst can edit the submission directly during review (vs. only approve or reject) is unspecified. Currently: not allowed.

### R6 — Cancellation

**Intent.** Close a request without approval, capturing why.

**Stages.**

1. **Analyst decides this request shouldn't continue.** Reasons vary: supplier dropped out, engagement scope changed, duplicate request, etc.
2. **Analyst cancels the request** from any non-terminal state in the workspace app, providing a reason.
3. **System records the cancellation event** with the reason in the event log (not in the review notes — cancellation isn't a review decision).
4. **System moves the request to "cancelled".** Terminal.
5. **System notifies the supplier** if appropriate. (A cancelled "not yet sent" request was never visible to anyone, so there's nothing to notify about.)

**Notes.**

- One cancelled state covers all closure reasons. Distinguishing reasons happens through the event log, not through state.
- Mid-engagement supplier deactivation likely folds in here; the trigger surface differs but the destination state is the same.

---

## Output-scope workflows

### X1 — Export to target system

**Intent.** Move approved supplier data out of the SDC platform into the destination system named on the project.

**Stages.**

1. **Trigger.** Analyst-initiated, or scheduled batch over approved requests.
2. **System selects the requests in scope.** Approved requests for the project, possibly filtered (only those not yet exported, or those approved within a window).
3. **System assembles the export package.** Reads each approved file, formats it as the target system expects.
4. **System hands off the package** to the target system named on the project.
5. **System logs the export event.**

**Notes.**

- This is the least specified workflow. Format, transport (push, pull, file drop, API call), batch granularity, idempotency on retry, error handling — all open Phase 1 questions.
- "Hands off" hides a lot. Whether the target system acknowledges receipt, whether failures roll back, whether partial successes are handled per-request — unspecified.

---

## Cross-cutting elements (in plain language)

These aren't workflows, but they show up inside many of them. Naming them in plain language so the workflow narratives can lean on them.

**Status changes go through one component.** Whenever a request's state changes — "not yet sent" to "sent", "sent" to "awaiting review", and so on — the change goes through a single status-change handler. That handler also writes the supplier-facing display status and message at the same moment, so the three stay consistent. No other part of the system writes those fields.

**Shareable links are short-lived.** Any time a supplier needs to access a file (template, validation report, approved file), the system produces the shareable link fresh. Links expire after 10 days, so any workflow that surfaces a link to a supplier must regenerate it at the moment of surfacing.

**Every meaningful moment is logged.** State changes, file uploads, validation results, reminders sent, exports completed — each writes a row to the event log with severity (info, warn, error), timestamp, and context. Routine activity and incidents share the same log; severity and the optional resolution fields distinguish them.

**Validation is one pipeline, called from two places.** R2 (file submission) and R3 (manual entry) both run the same validation logic. The difference is upstream: one starts from an XLSX, the other from form rows. The validation itself doesn't know or care which.

---

## Open questions surfaced by the plain-language pass

Items where writing a stage in plain English exposed something undecided or vague. These complement the gaps already named in the inventory.

1. **E1 / supplier list mid-engagement.** Adding suppliers after initial provisioning isn't a workflow today.
2. **E2 / re-engagement on a new version.** Pulling old-version suppliers onto a new version isn't a workflow today.
3. **E2 / change classification.** Typo fix vs. structural change vs. supplier-list change all run through the same trigger and the same logic. Whether they should is open.
4. **E3 / closure has no behavior.** A flag that nothing reads is a flag worth questioning.
5. **R1 / supplier with no active users.** Degenerate case, unhandled.
6. **R3 / mode switching mid-cycle.** Whether a supplier can switch between file upload and manual entry mid-cycle is unspecified.
7. **R4 / post-tier-3 behavior.** What happens after the third reminder is unspecified.
8. **R4 / firing policy contract.** Eligibility is state-machine work; firing cadence is policy. The contract between them needs to be made explicit.
9. **R5 / analyst editing during review.** Currently not allowed; worth confirming that's intentional.
10. **R5 / blank-template-on-rework choice.** Justified but not stress-tested against real rework scenarios.
11. **R6 / supplier deactivation handling.** Likely folds into R6 but the trigger surface differs.
12. **X1 / nearly everything.** Format, transport, granularity, idempotency, error handling.
13. **Display refresh trigger surface.** Which events beyond repeated validation failure should trigger a supplier-facing message refresh.

---

## Pending in Phase 0

- **Per-workflow detailed scoping** for the four selected capabilities (Invite supplier users, Validate config, Build template, Validate supplier input). This document gives the lifecycle context; the per-workflow scoping goes deeper into edge cases, error modes, and inputs/outputs for each.
- **Callable triage.** With this stage-by-stage view in hand alongside the inventory and the four workstream documents, callable triage can begin. Output: per-callable disposition (port-as-is, port-with-changes, rebuild) plus a callable-to-workflow map.
