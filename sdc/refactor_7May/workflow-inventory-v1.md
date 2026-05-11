# SDC Data Collection — Workflow Inventory (v1, Phase 0)

## Status

Bridging document between Phase 0 (data model, state machine, naming, ADR triage) and Phase 1 (callable specs and implementation). Enumerates the primary workflows in a client implementation, organized by lifecycle scope. Companion document to the four workstream docs; precedes the per-workflow plain-language scoping that feeds callable specification.

This document is deliberately thin. Each workflow gets a one-line trigger, a one-line state surface, and a brief sentence on what happens. The detailed scoping happens per-workflow in subsequent sessions.

## Foundational decisions

Three answers shaped the inventory:

1. **Lifecycle scope organizes the list.** Engagement-scope workflows fire rarely (project setup, config update, closure). Request-scope workflows fire many times per engagement (one cycle per supplier). Output-scope workflows fire on the back end (export to downstream systems). The split makes it obvious where each workflow sits in the system's tempo.

2. **A workflow is a unit of analyst or supplier intent, not a recipe.** "Issue invitation" is one workflow even if it decomposes into multiple recipes; "validation" is one workflow even though it spans intake, pipeline, and result-routing recipes. Recipe decomposition is callable triage's job, not the inventory's.

3. **Sub-workflows and entry paths are noted, not promoted.** The display-refresh handler isn't a workflow on its own — it's an entry path into the status handler. Resubmission template generation isn't a workflow on its own — it's a sub-step of submission. Both are flagged so callable triage doesn't lose them, but neither is enumerated as a top-level entry.

## Summary

| Scope | Count | Workflows |
|---|---|---|
| Engagement | 3 | E1 Initial provisioning, E2 Config update, E3 Engagement closure |
| Request | 6 | R1 Issue invitation, R2 File submission, R3 Manual-entry submission, R4 Reminder cycle, R5 Analyst review, R6 Cancellation |
| Output | 1 | X1 Export to target system |
| **Total** | **10** | |

---

## Engagement-scope workflows

Fire rarely. Project-level. Each touches the `Project` singleton, `CFG_*` tables, and (for E1) the initial `SUP_*` rows.

### E1 — Initial provisioning

**Trigger.** Analyst fires GAS webhook on first config submission for a new project.
**State surface.** Creates `Project`, creates `CFG_TemplateVersion` (v1, `published`), hydrates `CFG_*` rows, creates `SUP_Supplier` / `SUP_SupplierUser` / `SUP_SupplierRequest` (`pending`).
**One-liner.** Stand up a project from the analyst's config workbook: parse, validate, hydrate, create supplier records, leave them in `pending` for explicit invitation.

### E2 — Config update / re-publish

**Trigger.** Same webhook as E1, project already exists.
**State surface.** Creates new `CFG_TemplateVersion` (vN+1, `published`), hydrates new `CFG_*` rows, transitions previous `CFG_TemplateVersion` to `deprecated`. Existing `SUP_SupplierRequest` rows are untouched (immutable `assigned_version_id`).
**One-liner.** Publish a new template version against an existing project; new suppliers go on the new version, in-flight suppliers stay on the version they were stamped with.

### E3 — Engagement closure

**Trigger.** Manual analyst action.
**State surface.** `Project.project_completion_status` → `inactive`.
**One-liner.** Flag the engagement as done. No recipe branches on this; it's a flag for operators and reporting tooling.

---

## Request-scope workflows

Fire many times per engagement, one cycle per supplier. The state surface for each is `SUP_SupplierRequest` plus its associated `RUN_*` rows. All status transitions go through the single status-change handler (workstream 2 invariant 1).

### R1 — Issue invitation

**Trigger.** Analyst action (likely batch via WFA).
**State surface.** `pending → sent`. Writes `template_path`, sends invitation email per `SUP_SupplierUser`, calls the link-generation utility for shareable links.
**One-liner.** Move staged supplier requests into the active queue and notify their users.

### R2 — File submission

**Trigger.** Supplier uploads completed XLSX template via WFA.
**State surface.** Creates `RUN_Upload` (transitions `received → extracting → validating → validated|error`), creates `RUN_ValidationResult` and `RUN_FieldError` rows, drives `SUP_SupplierRequest` to `pending_review` (validation passed) or `supplier_action_required` (validation failed). On failure, regenerates `template_path` with valid prior rows pre-populated.
**One-liner.** Accept a supplier file, validate it end to end, route the outcome.
**Sub-workflows.** Resubmission template generation (UPL-02) fires on system-driven `sent → supplier_action_required`; the analyst-driven rework path (R5 reject) intentionally produces a *blank* template rather than a carry-forward one.

### R3 — Manual-entry submission

**Trigger.** Supplier fills slots in WFA, "Save worker" per row, "Submit all" when done.
**State surface.** Per-row writes to `RUN_ManualEntry` via slot-pool staging. On submit, validation runs against `RUN_ManualEntry` rows and produces the same `RUN_ValidationResult` outcome shape as R2.
**One-liner.** Accept a multi-row supplier submission entered through the WFA form, then run the same validation pipeline as a file upload.

### R4 — Reminder cycle

**Trigger.** Scheduled, against `Project.reminder_days_1/2/3` and `last_reminder_sent_at`.
**State surface.** Eligible if state is `sent` or `supplier_action_required`, the next tier is due, and `reminders_enabled = true`. Re-hydrates `template_path` (10-day TTL), sends reminder email, advances `last_reminder_tier`, writes `last_reminder_sent_at`.
**One-liner.** Nudge non-responsive suppliers on the configured cadence; eligibility is a state-machine concern, firing is a policy-layer concern (workstream 2 invariant 4).

### R5 — Analyst review

**Trigger.** Analyst opens a `pending_review` request in the WFA.
**State surface.** `pending_review → approved` (writes `RUN_ReviewNote` with `review_action: approved`, `approved_at`, `approved_path`) or `pending_review → supplier_action_required` (writes `RUN_ReviewNote` with `review_action: rework`, supplier sees rework message).
**One-liner.** The analyst makes the formal accept/reject decision on a validated submission.

### R6 — Cancellation

**Trigger.** Analyst cancels from any non-terminal state (`pending`, `sent`, `supplier_action_required`, `pending_review`).
**State surface.** `→ cancelled`. Reason routes to `EventLog` (workstream 2 invariant 5), not to `RUN_ReviewNote`.
**One-liner.** Close out a request without approval; one terminal state covers all closure reasons, with the reason captured in the event log.

---

## Output-scope workflows

Fire on the back end of the pipeline. Read `approved_path` artifacts and hand them off to downstream systems.

### X1 — Export to target system

**Trigger.** Analyst initiates, or scheduled batch over `approved` requests.
**State surface.** Reads `approved_path` for in-scope requests, packages, hands off to the target system named in `Project.target_vms`.
**One-liner.** Move approved supplier data out of SDC into the destination VMS.
**Note.** Least-specified workflow today. The shape of the handoff (file format, transport, batch vs per-request) is a Phase 1 design question.

---

## Cross-cutting workflow elements

These aren't workflows; they're recurring pieces that workflows compose. Listed here so callable triage tracks them as candidates for shared callables.

**Status-change handler invocation.** Every transition in the state machine and every display-refresh event calls the single status-change handler (workstream 2 invariant 1, single-writer rule). The handler writes `status`, `supplier_display_status`, `supplier_message` atomically. Called from R1, R2, R3, R5, R6, and from R2 again on display-refresh (repeated validation failure on resubmission).

**Shareable link generation.** Any workflow that exposes a file path to a user calls the link-generation utility (`UTL-01` in workstream 3). Called by R1 (template), R2 (validation report on rework), R4 (re-hydrated template), R5 (validation report on review), and at any handler-write moment that interpolates a link into `supplier_message`.

**Event emission.** Every workflow writes one or more `EventLog` rows at meaningful lifecycle moments. Centralized through a single emit utility (`OBS-01` in workstream 3 naming, was `U-01`). Severity disambiguates info / warn / error.

**Validation pipeline invocation.** R2 and R3 both invoke the validation pipeline. R2 starts from a parsed XLSX; R3 starts from `RUN_ManualEntry` rows. The pipeline itself (Python pre-processing + 16-CTE SQL per ADR-049) is the same in both cases — the difference is upstream payload normalization.

---

## Gaps and ambiguities

Items the inventory surfaces. Each is a known non-decision flagged for resolution as the relevant workflow gets scoped.

1. **Supplier deactivation mid-engagement.** Workstream 2 says `Supplier.status: deactivated` does not affect in-flight requests. Whether there's an analyst workflow for "this supplier is out — close their open requests" is open. Probably folds into R6 (cancellation), but worth confirming the trigger is the same.

2. **Adding users to an existing supplier mid-engagement.** ADR-047 defers incremental supplier bootstrapping on config update. Adding *users* to an existing supplier is a different scope than adding new suppliers. Currently appears to be a manual data-table action with no defined workflow.

3. **Re-engaging old-version suppliers on a new version.** With `assigned_version_id` immutable, a supplier stays on its stamped version until terminal. If the analyst wants v1 suppliers to redo work on v2, the workflow is unspecified — likely either re-provisioning the project or a future "create new SupplierRequest on version N" action.

4. **Resubmission template behavior on the analyst-driven path.** Workstream 3 says system-driven rework gets a carry-forward template; analyst-driven rework defaults to a blank template. The justification (content-level rework reasons may invalidate prior data) is reasonable but unconfirmed. Worth scoping in R5.

5. **Display-refresh trigger surface.** The status-change handler runs on real transitions and on display-refresh events. The canonical display-refresh case is repeated validation failure in `supplier_action_required`. Whether other display-refresh paths exist (analyst edits `supplier_message` text, configuration changes affecting message templates, etc.) is unspecified.

6. **X1 specification depth.** Export to target system is the least-defined workflow. File format, transport, batch cadence, error handling, idempotency on retry — all open. Likely a Phase 1 design exercise of its own.

---

## Backports queued for end-of-Phase-0

Items the inventory exposes that fold into existing workstream documents.

- **Sub-workflow tracking.** Workstream 5 (callable triage) needs to track sub-workflows that aren't first-class entries here — resubmission template generation, display-refresh invocations, link re-hydration on reminder. Adding a `Sub-workflows` column to the callable triage matrix is the simplest mechanism.
- **R4 reminder eligibility.** Workstream 2 names the eligible states (`sent`, `supplier_action_required`) and defers firing to a policy layer. The plain-language scoping of R4 should make the policy layer's contract explicit (what does it read, what does it return, where does cadence live).
- **X1 placeholder.** This document treats X1 as a single workflow even though it's underspecified. If the Phase 1 design discovers it's actually two or three workflows (e.g., per-supplier export vs batch export), this inventory amends to reflect the real shape.

---

## Deliberately omitted

- **Recipe-level decomposition.** Whether R2 is one recipe or three, whether STS-01 is its own callable or inlined in transition recipes — all callable triage's job. The inventory describes intent, not implementation.

- **Supplier-side authentication and session management.** The WFA handles authentication natively (ADR-016, still-applies). Login is not a workflow in the SDC sense; it's a platform capability that workflows depend on.

- **WFA page rendering.** The portal pages a supplier sees (upload form, manual-entry form, status display) are part of the WFA app definition, not workflows. Their content is driven by `SUP_SupplierRequest` state and `CFG_FormSlot` mappings, but rendering itself is platform behavior.

- **Analyst-side WFA pages.** Same reasoning — the review page that drives R5 is a WFA artifact, not a workflow on its own.

- **Internal background workflows.** The status-change handler, link generation, and event emission are cross-cutting elements, not workflows. They're listed in their own section above to keep the workflow list focused on user-facing intent.

- **Health checks, monitoring, alerting.** Operational concerns, not workflows. Live alongside the system, not inside it.

---

## Pending in Phase 0

- **Plain-language workflow scoping** for the four selected workflows (Invite supplier users, Validate config, Build XLSX template, Validate supplier input). Per the working principle, scoping a workflow in plain English is the forcing function that surfaces unstated assumptions before callable specification begins.
- **Callable triage (workstream 5).** Inputs to this workstream: (1) the four workstream docs, (2) this inventory, (3) the per-workflow scoping documents. Output: per-callable disposition (port-as-is, port-with-changes, rebuild) plus a callable-to-workflow map.
