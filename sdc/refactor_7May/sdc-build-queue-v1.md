# SDC Data Collection — Build Queue (v1, Phase 0 close-out)

## Status

Closes Phase 0. A sketch, not a commitment — the build session will revisit ordering and scoping as code lands and surfaces things the design pass missed. The value here is naming the dependencies, surfacing the blockers, and identifying the natural verification milestones so the build doesn't drift into "what should we work on next" conversations every week.

The companion artifacts settle the substance: the data model v2, state machine, naming conventions, ADR triage, callable triage v2, four capability deep dives, and eight sibling capability scopes. This document orders that body of work into stages.

X1 (Export to target system) is deliberately out of scope. The handoff named it as the least-defined work in the system and queued it for its own design pass before joining the build. Folding it into the queue without that design pass would be a way of pretending the open questions about format, transport, granularity, idempotency, and error handling don't exist.

## Driving principles

Five things shape the order:

1. **Schema before behavior.** Nothing recipes against an unsettled schema. Stage 0 collects every schema change from every Phase 0 workstream into one realization step.
2. **Pure compute before side effects.** Validate config, Build XLSX template, and Validate supplier input are pure-compute capabilities (per their side-effect signatures in the deep dives). They get built and verified before anything that touches the world outside the system — mail, portal access, task queues.
3. **Cross-cutting infrastructure before consumers.** STS-01, OBS-01, UTL-01, and the connector adjustments are foundation. Every capability beyond Stage 1 calls at least one of them. Building consumers before infrastructure means stubbing infrastructure and then revisiting; building infrastructure first means consumers integrate against the real thing.
4. **Workflows alongside their capabilities.** Workflow orchestration recipes (E1, E2, R1, R2, R3, R5, R6, E3) are real build artifacts — they're where end-to-end tests live. Building the capabilities and then leaving the workflows for "later" silently defers the integration work that catches assumptions.
5. **Parallelism within stages, sequential between.** Within a stage, items can be built concurrently. Between stages, the dependencies are real and the next stage shouldn't start until the prior stage's verification milestone clears. That's the point of stages.

The 10-item linear order from the handoff is preserved by intent — its dependencies are the same dependencies. The reorganization is about letting independent items happen in parallel and giving the verification points names.

---

## Stage 0 — Schema realization

**What.** Apply every schema change from Phase 0 to the Workato data tables. This is one stage, not three — the v2 additions, the naming-doc backports, and the state-machine backports all touch the same tables and need to land together.

**Concrete deliverables.**

*From the data model v2:*
- Add `SupplierUser.primary` (boolean).
- Add `ValidationRule.scope` (enum: `submission` | `supplier` | `engagement`, default `submission`).

*From the naming conventions doc (backports section):*
- Apply table prefixes (`CFG_`, `SUP_`, `RUN_`) and bare-naming for `Project`, `EventLog`.
- Apply the file-column renames: `*_file_id` → `*_path` across the file model. Drop the redundant columns (`seeded_template_file_id`, `latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_path`, `last_validation_report_link`).
- Add `Project.seeded_data_path`.
- Rename `RUN_Upload.valid_payload` → `valid_payload_json`.
- Rename `RUN_ValidationResult.valid_rows` / `invalid_rows` → `valid_row_count` / `invalid_row_count`.

*From the state machine doc (backports section):*
- Add `SUP_SupplierRequest.current_state_entered_at`.
- Add `SUP_SupplierRequest.reminders_enabled` (boolean, default true).
- Add `SUP_SupplierRequest.due_date` *or* `Project.default_due_days` — pick the location based on whether due dates are per-request or per-engagement.
- Rename `RUN_Upload.status: failed` → `error`.

**Done when.** All tables exist with the v1 prefix scheme, all columns match the data model v2 + backports, foreign keys resolve, and a smoke query against each table returns the expected shape. No behavior yet.

**Blocker.** *ADR Conflict 1 — WFA relation traversal* (see decision points below). If this resolves toward "WFA can't join," the schema reverts to `*_label` columns on `SUP_SupplierRequest` and `customer_name` reappears. Stage 0 has to wait until this is settled, or be willing to amend.

---

## Stage 1 — Foundation utilities + connector adjustments

**What.** The cross-cutting capabilities that almost everything downstream calls, plus the small connector amendments the v2 additions imply.

**Concrete deliverables.**

- **UTL-01 (Generate Shareable Link).** Pure utility per naming-doc invariant 8. Takes a path, returns a fresh 10-day link. Single owner of FileStorage TTL handling.
- **OBS-01 (Event emitter).** Per the sibling scope. Takes severity, source_recipe, step_number, phase, human_message, optional details_json + supplier_request_id + error_type. Writes one EventLog row.
- **STS-01 (Status-change handler).** Per the state-machine doc + the sibling scope. Single writer of `status`, `supplier_display_status`, `supplier_message`, `current_state_entered_at`. Implements the derivation table.
- **Connector adjustments to `validate_upload`.** Add the optional `prior_values` parameter shape: `{ field_id: [{value, row_number, submission_id}, ...] }`. Add awareness of `ValidationRule.scope` so the action knows which scope-tagged rules expect a `prior_values` set vs. evaluate within-submission.
- **Connector adjustments to `validate_config`.** Add the new check from data-model invariant 6: exactly one `SupplierUser.primary = true` per supplier.

**Parallelism.** UTL-01, OBS-01, and the two connector adjustments can be built concurrently — none depends on the others. STS-01 depends on OBS-01 (it emits an event on every transition).

**Done when.** Each utility has at least one consumer-side stub exercising it end-to-end. STS-01's transition table is exercised against a fixture of synthetic state changes. OBS-01 round-trips a row through EventLog. UTL-01 produces a valid link from a known path.

**Blocker.** *Workato atomicity guarantee on multi-field writes* (see decision points below). Affects STS-01 only. Resolution either lets STS-01 ship as-designed or forces a write-and-reconcile fallback pattern.

---

## Stage 2 — Pure-compute capabilities

**What.** The three primary capabilities that have no outward-facing side effects and no internal persistence beyond what the connector already does. These are the heart of the system's logic.

**Concrete deliverables.**

- **Validate config.** Thin recipe orchestrating the connector's `parse_config_file` + `validate_config`. Per the capability deep dive + the triage v2 callable map, this is mostly already done in the connector — what the recipe adds is the orchestration shell.
- **Build XLSX template.** Full rebuild per the deep dive's substages 1–10. P-02a's Python is reference material for the per-type DataValidation builders, but the recipe is new. The shared sanitization function (one definition called from both the named-range step and the INDIRECT-formula step) is the build-time invariant the test cases below lock in.
- **Validate supplier input.** Recipe-level orchestration around the connector's `validate_upload`. Handles the upstream transformation (XLSX-to-rows for R2, manual-entry-rows for R3) and the downstream persistence (writes ValidationResult and FieldError rows). The connector does the validation.

**Parallelism.** All three are independent of each other; all depend only on Stage 0 + Stage 1. Three parallel build threads.

**Done when.** Each capability passes its identified test cases (see pre-positioned test cases below) and runs end-to-end against synthetic fixtures — no real supplier, no real upload, just the pure-compute path.

**Pre-positioned test cases (write during this stage, not after):**

- *Build XLSX template:* dependent-dropdown parent values containing awkward characters (`R&D`, `IT/Security`, `1st Quarter`, leading punctuation, Unicode). Locks in the shared-sanitization invariant. The triage v2 close-read of P-02a documented this bug class explicitly.
- *Validate supplier input:* resubmit-after-failure with a supplier-scope uniqueness rule. Catches the "filter to validated/approved prior submissions" trap. The pre-fetch query has to filter to successful prior submissions, not "any prior submission" — otherwise the supplier gets uniqueness errors against their own failed prior attempts.

---

## Stage 3 — Provisioning workflows

**What.** E1 (Initial provisioning) and E2 (Config update / re-publish) recipes. These orchestrate Stage 2's capabilities into the engagement-setup workflows the workflow stages doc describes.

**Concrete deliverables.**

- **E1 recipe (PRV-01 + PRV-02 + PRV-03 + PRV-04 chain or similar).** Webhook → parse config → validate config → record project → publish first version → build templates per variant → stage supplier records. Calls Validate config and Build XLSX template from Stage 2.
- **E2 recipe.** Same shape, branched at the "first time vs. update" decision. Publishes a new version, deprecates the old one, leaves in-flight suppliers stamped with their original version per data-model invariant + state-machine derivation.

**Parallelism.** E1 and E2 share most of their substages. Build E1 first; E2 is largely a parameterization of E1's chain.

**Done when.** End-to-end provisioning works for a fixture configuration: webhook fires, project is recorded, templates are built per variant, supplier records are staged in `pending` state. No invitations sent yet — invitation is R1's job, deliberately separate.

**Blocker.** *ADR-039 vs. ADR-046 (re-stamp on config update)* — see decision points. If you want pending suppliers to silently roll forward to the new version on re-publish, the `assigned_version_id` immutability invariant relaxes for the `pending` state. Without that decision, E2's behavior on pending suppliers is ambiguous.

---

## Stage 4 — Outward-facing capability + workflow

**What.** Invite supplier users (the primary capability) + R1 (Issue invitation workflow). The first capability that touches the world outside the system.

**Concrete deliverables.**

- **Invite supplier users capability.** Full build per the deep dive substages 1–7, with the triage-v2 cluster resolutions baked in: designated-assignee task model, partial-success policy with hard floor at the assignee, 60-second idempotency guard, refused on already-sent requests outside the guard window.
- **R1 workflow recipe.** Analyst-initiated batch action over selected supplier requests. Calls Invite supplier users per request, calls STS-01 to transition `pending → sent`.

**Done when.** End-to-end E1 → R1 chain works against a fixture supplier and contact. The supplier user receives an actual email (in dev/test addressing) with a working link to a real template file. The request transitions to `sent`.

This is the first stage where a real outward-facing effect is verifiable, and it's the natural place to pause and confirm the foundation works before building outward.

---

## Stage 5 — Submission and review workflows

**What.** R2 (file submission), R3 (manual entry submission), R5 (analyst review), R6 (cancellation). These complete the supplier-facing and analyst-facing happy paths.

**Concrete deliverables.**

- **R2 recipe.** Upload trigger → run Validate supplier input → STS-01 routes to `pending_review` (pass) or `supplier_action_required` (fail). On failure, the resubmission template *is not yet generated* — that's Stage 6. For Stage 5, the failure path produces a blank template (the "rework defaults to blank" path in the naming doc).
- **R3 recipe.** Manual-entry submission → same Validate supplier input call → same STS-01 routing. Subject to the WFA traversal blocker (see decision points).
- **R5 recipe.** Analyst Approve → STS-01 transitions to `approved`, writes ReviewNote with `review_action=approved`, captures `approved_at` and `approved_path`. Analyst Reject → STS-01 transitions to `supplier_action_required`, writes ReviewNote with `review_action=rework`.
- **R6 recipe.** Cancellation from any non-terminal state → STS-01 transitions to `cancelled`, writes cancellation reason to EventLog (state-machine invariant 5).

**Parallelism.** R2 and R3 share the Validate supplier input call but differ in upstream parsing — can be built in parallel. R5 and R6 are thin orchestrators over STS-01 + ReviewNote/EventLog writes — also parallel.

**Done when.** A supplier can submit (file or manual entry), see pass/fail, resubmit on fail (against a blank template, for now), and an analyst can approve, reject, or cancel. Full happy path through the request lifecycle, minus the smart-UX resubmission and the reminder cycle.

**Blocker.** *WFA traversal (ADR Conflict 1)* — gates R3 specifically. R2 doesn't depend on it (XLSX upload doesn't render WFA forms).

---

## Stage 6 — Smart-UX paths

**What.** The two paths that make the system feel like a humane tool rather than a strict gatekeeper: Resubmission template generation (carry forward valid rows after a failure) and Incumbent data seeding (pre-populate with what we already know).

**Concrete deliverables.**

- **UPL-02 (Resubmission template generation).** Per the sibling scope. Fires on the system-driven `sent → supplier_action_required` transition. Reads the failing upload's extracted content and the FieldError rows; produces a fresh `template_path` with valid rows pre-populated and invalid rows flagged. Replaces the blank-template fallback that R2 was using in Stage 5.
- **Incumbent data seeding.** Per the sibling scope. Runs in the PRV chain when `Project.seeded_data_path` is set. Slices the source dataset by `Project.incumbent_split_config`, writes `seeded_slice_path`, writes the seeded supplier-facing template at `template_path`.

**Parallelism.** Both depend on Build XLSX template (Stage 2) and on the schema (Stage 0). Independent of each other. Two parallel build threads.

**Done when.** A failed submission produces a resubmission template the supplier can correct in place, and an incumbent supplier sees a template with their existing data pre-populated.

**Pre-positioned test cases:**

- *UPL-02:* two consecutive failures within `supplier_action_required` (the no-op transition under invariant 7). Carry-forward should be "rows that were valid in the *most recent* submission" — not "rows that have ever been valid in any prior submission." Easy to confuse, and the wrong reading silently re-introduces previously-invalid data.
- *Incumbent data seeding:* a project with `seeded_data_path` set but a supplier whose name doesn't appear in the source data (zero-row split). The capability assumes the caller decided to invoke it; zero rows is a caller error and should fail loudly.

---

## Stage 7 — Invite cluster siblings

**What.** Refresh outreach, Add user to request, Reassign request. The three siblings the triage v2 carved out from the re-invite cluster.

**Concrete deliverables.**

- **Refresh outreach.** Regenerates link via UTL-01, sends fresh emails. No state change, no task change, no access change.
- **Add user to request.** Grants portal access to a newly-attached user, sends them outreach. Enforces invariant 6 at runtime (exactly one primary per supplier).
- **Reassign request.** Moves the platform task to a new assignee using the platform's native reassign mechanism. Notifies both old and new.

**Parallelism.** All three depend on Invite supplier users (Stage 4) and UTL-01 (Stage 1). Independent of each other. Three parallel build threads.

**Done when.** All three legitimate "I need to invite something differently" paths work without falling back to a manual analyst workaround. Re-engagement flows are clean.

**Pre-positioned test case:**

- *Add user to request + Validate config:* invariant 6 enforced at both boundaries with the same predicate. Add a user with `primary = true` against a supplier that already has a primary — expect the invariant violation surfaced consistently from both call sites. The shared-predicate pattern is what the cross-cutting open question in the sibling scopes was naming.

**Blocker.** *Domain code for the Invite-cluster recipes* — see decision points. Cosmetic, not functional. Doesn't block building, blocks naming.

---

## Stage 8 — Reminder cycle

**What.** R4 (Reminder cycle) workflow + Reminder eligibility evaluation sibling.

**Concrete deliverables.**

- **Reminder eligibility evaluation.** Per the sibling scope. Read-only verdict: `{ eligible, next_tier, reason }`. Pure read.
- **R4 recipe.** Schedule fires → SQL-filter candidate requests → call Reminder eligibility per candidate → for eligible candidates, call Refresh outreach (from Stage 7) → update `last_reminder_tier` and `last_reminder_sent_at`.

**Done when.** Reminders fire on the configured cadence to suppliers in `sent` or `supplier_action_required` who haven't been reminded recently enough. Tier escalation works (1 → 2 → 3); post-tier-3 behavior is honest about being out of tiers.

**Blocker.** *Post-tier-3 escalation behavior* — see decision points. Doesn't block Reminder eligibility itself (it can return "out of tiers" honestly), but blocks closing R4 with a coherent answer for what happens after tier 3 fires.

---

## Stage 9 — Engagement closure

**What.** E3 (Engagement closure). Trivial.

**Concrete deliverable.**

- **E3 recipe.** Flips `Project.project_completion_status` to `inactive`. No other behavior currently encoded — workflow stages doc open question 4 flagged that the flag has no behavioral consequence.

**Done when.** The flag flips. If you want it to disable reminders, prevent new submissions, or lock the project, that's a policy decision worth making before this stage rather than after — but it's not currently in scope.

---

## Verification milestones

A milestone is the natural place to stop, confirm the foundation works, and decide whether to push forward or revisit. In order:

1. **After Stage 0:** Schema queryable. No behavior. The first thing that proves the design isn't just on paper.
2. **After Stage 1:** Utility plumbing done. STS-01 can transition synthetic states; OBS-01 round-trips events; UTL-01 produces working links; the connector handles `prior_values` and the `primary` invariant.
3. **After Stage 2:** Pure-compute path works end-to-end. Provisioning a config and validating a fake supplier upload both work without sending anything outward. **Strong recommend a pause here** — this is where the core logic settles, and finding bugs after this stage is much more expensive.
4. **After Stage 3:** E1 + E2 work. Full provisioning, no supplier interaction.
5. **After Stage 4:** First outward-facing effect. A real supplier user receives a real email with a real link. **Second strong-recommend pause** — confirm the platform-side mechanisms (mail, link, portal access) work as expected before building five more capabilities on top of them.
6. **After Stage 5:** Full submission and review cycle works against blank-on-rework templates.
7. **After Stage 6:** Smart-UX paths work. Resubmission carries forward; incumbent suppliers see seeded data.
8. **After Stage 7:** Re-engagement and recovery paths work.
9. **After Stage 8:** Reminder cycle works.
10. **After Stage 9:** Engagement can be closed. Build queue complete (excluding X1).

---

## Decision points and blockers

Open questions that gate specific stages. Resolve before reaching the gated stage; don't let them slip.

**Gates Stage 0 — *ADR Conflict 1: WFA relation traversal.*** ADR triage flagged this. If WFA can join `FormSlotMapping` and `Project` at render time, v1's stance holds and the schema is what it is. If WFA cannot join, `*_label` columns return to `SUP_SupplierRequest` and `customer_name` reappears. The schema decision is small in code but large in consequence — every downstream stage references the schema. Resolve by experiment: build a minimal WFA page that tries to render a `FormSlotMapping`-joined label, see whether it renders.

**Gates Stage 1 (STS-01 specifically) — *Workato atomicity on multi-field writes.*** STS-01 assumes atomicity across four field updates plus an event row write. If Workato's guarantee is weaker, STS-01 needs a write-and-reconcile fallback. Resolve by experiment or by reading platform docs.

**Gates Stage 3 — *ADR-039 vs. ADR-046 re-stamp on config update.*** ADR triage marked ADR-039 obsolete and ADR-046 still-applies based on `assigned_version_id` immutability. If you want ADR-039's smart-UX behavior (pending suppliers silently roll forward to a new version), the immutability invariant relaxes for the `pending` state specifically. Confirm intent before E2 is built.

**Gates Stage 5 (R3 specifically) — Same as Stage 0 blocker.*** R3's manual entry surface depends on WFA traversal. Resolved together with the Stage 0 blocker.

**Gates Stage 7 (cosmetic) — *Domain code for Invite-cluster recipes.*** None of the nine existing domain codes (PRV, CFG, VAL, UPL, STS, REM, REV, OBS, UTL) cleanly fits. Candidates: introduce a new domain (`INV`, `ACS`, or `NTF`), or absorb into REM. Doesn't block building; blocks naming.

**Gates Stage 8 — *Post-tier-3 escalation behavior.*** Two clean answers: (a) introduce an `escalate` outcome on Reminder eligibility's verdict; (b) leave eligibility honest about being out of tiers and build a separate escalation capability that watches for stuck requests. Sibling scope leaned toward (b); confirm before R4 is closed out.

---

## Pre-positioned test cases (consolidated)

Tests that should be written *during* their stage, not retrofitted after. Each catches a known bug class from the design pass. Listed once here for easy reference.

- **Stage 2 / Build XLSX template:** dependent-dropdown parent values with awkward characters (`R&D`, `IT/Security`, `1st Quarter`, leading punctuation, Unicode). The shared-sanitization invariant.
- **Stage 2 / Validate supplier input:** resubmit-after-failure with a supplier-scope uniqueness rule. The "filter to validated/approved prior submissions" trap.
- **Stage 6 / UPL-02:** two consecutive failures within `supplier_action_required` with overlapping but non-identical valid sets. The "most recent submission" carry-forward semantics.
- **Stage 6 / Incumbent data seeding:** project with `seeded_data_path` set but a supplier whose name produces a zero-row split. Loud failure, not silent no-op.
- **Stage 7 / Add user to request + Validate config:** invariant 6 enforced consistently across both call sites with a shared predicate.

---

## Out of scope (this queue)

- **X1 (Export to target system).** Needs its own design pass before joining the queue. The handoff was explicit; this queue defers to that.
- **Renaming the existing workspace's recipes in place.** Naming-doc decision: this is a clean rebuild, not an incremental rename pass. The old recipes stay where they are; the new recipes are built in the new structure.
- **CI/CD connector and Data Tables API connector.** Triage v2 explicitly deferred them as feature work for after the rebuild is coherent. They join a future queue, not this one.
- **Adding suppliers / users mid-engagement** as a fully designed workflow. The Invite-cluster siblings cover the access-management mechanics; the analyst-side workflow that drives them needs its own scoping pass once the capabilities are built.
- **The "can defer to later in Phase 1" list from the triage doc.** Empty edge cases, cross-version compatibility checks, etc. Surface during build if a specific capability touches them; otherwise leave alone.

---

## Pending in Phase 0

Empty. With this artifact, Phase 0 closes. The next session is Stage 0 of the build queue.
