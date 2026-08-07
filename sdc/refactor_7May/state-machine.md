# SDC Data Collection — State Machines (v3.2)

## Status

Point release on v3.1 (2026-08-06). **v3.2 closes Q0**: the v1 source file was recovered
and every `[TEXT NOT RECOVERED]` gap is restored below — verbatim where still true,
amended where superseded, with every amendment itemized in the F-changelog. The v1
backports queue is retired (F7). A C-series glossary is added so this document stands
alone without v2 (F8).

Code sync status (unchanged from v3.1): STS-01 v3 tables and SUB-01 v3 orchestration
applied, cutover test pending; STS-01 task-less stage writes (E1) not yet built, gated on
the Q6 builder check.

Field-name normalization (F9): v1 wrote `template_file_id` / `approved_file_id`; the build
landed on **`template_path`** / **`approved_path`**. Restored text uses the shipped names.

> **Restoration note (2026-08-06, F1).** Restorations are sourced from the recovered v1
> (2026-05-07 body). The v2 provenance note is retired; v1 remains the archive of record
> for the original wording and the retired backports queue.

---

## CHANGELOG (v3.1 → v3.2, 2026-08-06)

**F1 — Q0 closed; v1 gaps restored.** Restored: `pending_review` / `approved` /
`cancelled` state prose; Invariants 2–5; the Cancellation-reason-routing section; the
Deliberately Omitted list; the full trivial-machine semantics (v2 had compressed these to
one line, losing the deactivation behavior). Amendments individually flagged F2–F5.

**F2 — Invariant 3 amended on restore.** v1's closing clause — "…the supplier-facing
display reads from Upload during the active window *without requiring a SupplierRequest
state to express it*" — is struck: `pending_validation` (D1) **is** the state expressing
the active window, and the supplier display comes from the derivation row, not from
Upload. The invariant's core (Upload owns the per-step pipeline arc) stands.

**F3 — Invariant 4 amended on restore.** The reminder-ineligible set gains
`pending_validation`. Eligible: `{sent, supplier_action_required}` — unchanged.

**F4 — Deliberately Omitted list reconciled.** The `submitted` entry gains the distinction
that keeps it honest next to D1: `submitted` failed the behavior test (nothing
distinguished it); `pending_validation` passes it (closes the concurrent-submission
window, owns a derivation row and a page, reminder-excluded, exit-guaranteed — IV-8). The
"WFA stage as independent machine" entry is updated: now implemented as the projection
(E1/IV-9). All other entries restore verbatim.

**F5 — Deactivation semantics restored; REM filter flagged.** Supplier/SupplierUser
deactivation behavior (no invitations or reminders on new requests; in-flight assignments
stay put) is restored from v1. Since Workflow 7 is mid-build: **verify REM-02's
eligibility filters deactivated SupplierUsers** — defect V3.2-2. If it doesn't, the first
personnel change at a supplier produces reminders to a departed contact.

**F6 — `cancellation_reason` persistence verification.** Restored Invariant 5 requires
all cancellation reasons to route to EventLog. C11 added the STS-01 precondition (the
parameter is required and checked non-blank), but the row write does not persist it and no
derivation row uses it. **Verify the OBS `state_transition` event carries it**; if not,
the precondition is theater — add `cancellation_reason` to the event's details_json
(fits alongside the `wfa_stage` addition already planned there). Defect V3.2-1.

**F7 — v1 backports list retired.** All items shipped (`current_state_entered_at`,
`reminders_enabled`, `due_date`/`Project.default_due_days`, Upload `failed → error`) or
were superseded (`pipeline_error_alert` — rejected; its legitimate need became
`system_validation_error`, lineage recorded in the trigger-tokens section). Convention set
here: **decisions persist in this doc (struck, tombstoned); completed work queues do
not.** The original queue lives in v1.

**F8 — C-series glossary added** (one line each) so v3.2 stands alone without v2.

**F9 — Field-name normalization** in restored text: `template_file_id → template_path`,
`approved_file_id → approved_path`.

---

## CHANGELOG (v3 → v3.1, 2026-08-06) — carried

**E1** Stage = pure projection of status; writers split by stage class (task-bearing:
INV-01a with task issuance; task-less: STS-01 new build; birth: REQ-01/SUP-02). Stage is
the WFA system field `CURRENT_STAGE`, not a table column; `human_review_on_existing_record`
sets stage+task+page atomically. **E2** Projection locked to the existing stage names;
`sent` and `supplier_action_required` share "Assigned to supplier" (deliberate
many-to-one). **E3** `pending_validation` gets stage "Validation in progress" (details
page; D11 reversed in decision, upheld in reasoning). **E4** No INV-01a changes; the only
build is STS-01's three task-less writes. INV-01a's snake_case params are its own API;
names are the identity. **E5** "Active" = canary (never legal at rest; a row there =
missed birth write). **E6** "Validation in progress" dwell > ~1 h = stuck-state monitor;
Q5 provisionally closed. **E7** SUB-01 is the single verdict-routing point (pilot literal
`="pending_review"`); exported fallback had silently disabled the pilot — fixed. UPL-01's
inline tail is retired legacy. **E8** The stage rule: a stage never carries information
not in `status`; new pages need new states or sub-views, never rogue stages. **E9**
Task-pairing convention: SAR entries pair with a supplier assignment (including the error
exit — gap fixed in SUB-01); pending_review with an analyst assignment;
pending_validation with no task; terminals with none.

## CHANGELOG (v2 → v3, 2026-08-06) — carried

**D1** New state `pending_validation`. **D2** New trigger `submission_received` (SUB-01,
both channels). **D3** New trigger `system_validation_error`; error verdicts exit through
the state machine. **D4** `display_refresh` retired; repeat failures are the pair
SAR → PV → SAR; kills the Q1(b) trap. **D5** Five direct sent/SAR → verdict rows retire at
cutover. **D6** Derivation rows added: `(pending_validation, submission_received)`
(placeholder-free) and `(supplier_action_required, system_validation_error)`
({analyst_email}; Project gather branch widened); display_refresh row retired. **D7**
Submissions bump `current_state_entered_at` twice via real transitions (REM anchor re-arms
on resubmission — intended). **D8** Reminder model: recurring interval
(`Project.reminder_cadence`, `Project.max_reminders`; row `reminder_count`,
`last_reminder_sent_at`; anchor `max(current_state_entered_at, last_reminder_sent_at)`);
tier model retired. **D9** `finalize_verdict`: passed → system_validation_passed;
failed/structural/empty → system_validation_failed; error → system_validation_error; no
prior_state, no display_refresh. **D10** Pilot re-homed to the PV exit (single point per
E7). **D11** WFA surface — amended by E3.

## C-series glossary (v2 reconciliation, 2026-07-02) — for self-containment

**C1** Pilot confirmed live (orchestrator literal). **C2** Option A: structural/empty
collapse to `failed` on the ValidationResult write; no structural token exists. **C3a**
STS-01 param hint omitted `initial_creation` (folded into the v3 hint rewrite). **C3b**
`pending_reivew` typo in REV-01 hints (19×) + WFA-006 (1×); live logic clean. **C4** Link
TTL is a recipe-set 7 days (604800 s); UTL-01's `expires_at` output declared but never
populated. **C5** WFA-013 exposes raw verdict + row counts to the supplier (open, high
during pilot). **C6** Reminder layer was accepted-but-unacted-on (superseded by D8). **C7**
Birth carve-out: REQ-01/SUP-02 stamp the protected fields at `add_request`; SUP-02 omits
`supplier_message` (open, low). **C8** Stage projection unimplemented (closed by E1). **C9**
Pilot derivation wording re-synced to code. **C10** Date rendering: DATE_KEYS →
"Month D, YYYY", locale-independent, graceful degradation. **C11** `cancellation_reason`
precondition on `cancelled`. **C12** VAL-01 step 41 dead `force_manual_review` shim
(delete at prune). **C13** UPL-01 dead elsif under pilot (moot — the whole tail retires,
E7).

---

## OPEN QUESTIONS (for the maintainer)

**Q0 — RESOLVED (F1).** v1 recovered; all gaps restored/amended above.

**Q1 — finalize_verdict emitted set.** (a) v3 mapping emitted and applied in SUB-01;
⚠ verify the deployed connector source matches D9. (b) Resolved by construction (D4/D9).

**Q2 — RESOLVED (E1).** **Q5 — PROVISIONALLY CLOSED (E6).**

**Q3 — Initial literals at creation.** Confirm REQ-01/SUP-02 stamp `status = pending` and
stage = "Pending assignment to supplier" (and add the SUP-02 `supplier_message` fix, C7).

**Q4 — Physical pruning.** One pass after the cutover test: retired structural rows (v2),
retired display_refresh rows (D4), five legacy direct-verdict rows (D5), UPL-01's skipped
inline tail (E7), VAL-01 step 41 (C12). Convention per F7: pruned **decision** rows stay
struck-through in the tables; deleted code just goes.

**Q6 — Stage-only write mechanics. ⚠ Gates the E1 build.** (1) Which WFA action sets
`workflow_stage_id` without creating a task — check `update_request`'s input schema
(`add_request` proves stage-without-task exists at create). (2) Pill vs picklist-only on
that input → one parametric write vs three static branches. If no action can set stage
without a task: stop and redesign, don't improvise.

---
---

# The document

## Foundational decisions

1. **The audit chain carries the "why," the state machine carries the "what."**
   System-driven rework and analyst-driven rework land in the same state; the reason lives
   in ValidationResult/FieldError or ReviewNote, not the state name. *(Temporarily widened
   by the pilot.)*
2. **Upload owns the in-flight pipeline; SupplierRequest tracks resting states only.**
   > **Amended (D1).** `pending_validation` names a *resting situation* — the ball is with
   > the system — spanning the entire Upload arc. The request never mirrors Upload's
   > per-step states.
3. **State knows nothing about reminders.** Eligibility is state-machine; firing is
   policy-layer (Workflow 7 = REM-01 executor + REM-02 eligibility; D8 model).
4. **Stage knows nothing that status doesn't.** (E8/IV-9.) The WFA stage is a derived,
   many-to-one projection of `status`. Pages route on stage; behavior routes on status;
   the supplier reads the display columns. Three layers, one source of truth.

## SupplierRequest — seven states

### pending — stage: Pending assignment to supplier

*Entered when:* an analyst creates a SupplierRequest before commitment to invite —
supplier known but contact details missing, or campaign being staged for batch send.

*Can:* edit metadata, assign contacts, attach a variant, transition to `sent` or
`cancelled`. *Cannot:* accept submissions, run validation, surface to the supplier portal.
`template_path` not required. The stage description says "transitory, brief" and usually
is — but the state permits long dwells (batch staging, missing contacts); don't alert on
dwell here.

> **Creation note (C7).** Born in this state by REQ-01/SUP-02 via `add_request`, which
> also stamps `current_state_entered_at`, the (empty) display fields, and the stage.
> Birth-state correctness is creator convention; STS-01 cannot execute `initial_creation`
> itself. SUP-02 omits `supplier_message` (defect C7).

### sent — stage: Assigned to supplier

*Entered when:* the invitation has been issued and `template_path` is populated.

*Can:* accept an Upload or form submission — **acceptance immediately transitions to
`pending_validation`**; regenerate the template link (7-day recipe-set TTL, C4); be
reminded (per policy layer). *Cannot:* show analyst review pages — nothing to review yet.

### supplier_action_required — stage: Assigned to supplier *(shared — E2)*

*Entered when:* a previous submission needs supplier remediation, regardless of cause —
system-driven via failed ValidationResult *(dormant during the pilot)*, system-driven via
pipeline error (`system_validation_error`, active in both modes), or analyst-driven via a
ReviewNote with `review_action: rework`.

*Can:* accept resubmission (creates a new Upload; **transitions to `pending_validation`**),
regenerate template link, be reminded. Identical to `sent` from the supplier's side; same
page, differentiated by the display columns and the status-scoped corrections panel.
*Cannot:* display the same `supplier_message` as `sent` — see derivation rule.

The state is unitary; the entry paths differ only in the audit chain that produced them,
not in subsequent behavior. Every entry pairs with an INV-01a supplier assignment (E9).

### pending_validation — stage: Validation in progress *(new, D1)*

*Entered when:* a submission (file or form) has been received and the RUN_Upload row
created — via `submission_received`, fired by SUB-01 for both channels.

*Meaning:* the ball is with the system. The supplier owes nothing; the analyst owes
nothing; the pipeline owes a verdict.

*Can:* run extraction and validation; exit on the verdict, on `system_validation_error`,
or via `analyst_cancel`. *Cannot:* accept another submission (accepting-states guards
reject — the concurrent-submission closure is a design goal); send reminders; show review
pages; hold a task (the intake `complete_task` consumed it — E9).

*Exit guarantee:* IV-8. Dwell beyond ~1 hour is the stuck-state signal (E6).

### pending_review — stage: Under human review *(restored from v1, F1)*

*Entered when:* validation has completed and the analyst owes a decision. *(Phase 0:
`current_validation_result_id` points at a ValidationResult with `status = passed`. Pilot:
`status ∈ {passed, failed}` — the analyst decision point. Entry is always from
`pending_validation` as of v3.)*

*Can:* accept Approve (→ `approved`, writes ReviewNote `review_action=approved`), accept
Rework (→ `supplier_action_required`, writes ReviewNote `review_action=rework`), accept
Cancel (→ `cancelled`). *Cannot:* accept new supplier submissions — the supplier sees the
"under review" message until the analyst acts. Pairs with an analyst assignment (E9). The
stage label is cosmetically renameable; pages and recipes bind the name at configuration,
not the wording's meaning.

### approved — stage: Resolved *(restored from v1, F1)*

**Terminal.** *Entered when:* the analyst approves; `approved_at` and `approved_path` are
written **write-once** by REV-01 (via WFA `update_request`) *before* it calls STS-01 —
the field-level precondition verifies, never writes.

*Can:* serve the approved snapshot to downstream consumers; be referenced for reporting.
*Cannot:* transition further, accept submissions, send reminders.

### cancelled — stage: Canceled *(restored from v1, F1)*

**Terminal.** *Entered when:* the analyst closes the engagement without approval —
pre-submission cancellation (wrong supplier, scope change) or post-engagement give-up
(supplier can't deliver, declined to engage). Reachable from every non-terminal state.

*Can:* be referenced for reporting; the cancellation reason routes to the audit trail
(see Cancellation reason routing — persistence verification V3.2-1). *Cannot:* transition
further, accept submissions, send reminders.

> **C11.** `cancellation_reason` is a required, non-blank parameter when
> `target_state = cancelled` (STS-01 precondition).

---

## Transition graph

Source of truth for STS-01's `LEGAL_TRANSITIONS`. `approved` and `cancelled` terminal.

```
pending ──► sent ─────► pending_validation ─────► pending_review ─────► approved
                          ▲            │                  │
                          │   (failed*/error)         (rework)
                          │            ▼                  ▼
                          └──── supplier_action_required ─┘
                        (resubmit = submission_received)

cancelled ◄── analyst_cancel from every non-terminal state (terminal)
```
*\* Under the pilot, `failed` exits to `pending_review` (analyst decision point); the
`failed → supplier_action_required` edge is the dormant Phase 0 canonical. `error` exits
to `supplier_action_required` in both modes.*

| From | To | Trigger context | Status |
|---|---|---|---|
| *(no row)* | pending | initial_creation | active — creator convention (C7) |
| pending | sent | invitation_issued | active |
| pending | cancelled | analyst_cancel | active |
| sent | pending_validation | submission_received | **active (v3) — cutover test pending** |
| sent | cancelled | analyst_cancel | active |
| supplier_action_required | pending_validation | submission_received | **active (v3) — cutover test pending** |
| supplier_action_required | cancelled | analyst_cancel | active |
| pending_validation | pending_review | system_validation_passed | **active (v3)** |
| pending_validation | pending_review | system_validation_failed | **active (v3) — pilot row** |
| pending_validation | supplier_action_required | system_validation_failed | **dormant** (Phase 0 canonical; re-activates on revert) |
| pending_validation | supplier_action_required | system_validation_error | **active (v3)** |
| pending_validation | cancelled | analyst_cancel | **active (v3)** |
| pending_review | approved | analyst_approve | active |
| pending_review | supplier_action_required | analyst_rework | active |
| pending_review | cancelled | analyst_cancel | active |
| sent / SAR → verdict targets (five rows) | | | **retire on cutover (D5)** — legacy block in code |
| ~~SAR~~ | ~~SAR~~ | ~~display_refresh~~ | retired (D4) |

**Field-level preconditions** (verified before the write): `template_path` → `sent`;
`current_validation_result_id` pointing at a ValidationResult with `status ∈ {passed,
failed}` → `pending_review` *(pilot-widened; Phase 0: `passed` only)*; `approved_at` +
`approved_path` → `approved`; `cancellation_reason` → `cancelled` (C11). None for
`pending`, `supplier_action_required`, `pending_validation` — at intake time
`current_validation_result_id` still points at the previous attempt; the exit checks the
new one.

### Cancellation reason routing *(restored from v1, F1; amended)*

Cancellations fire from all five non-terminal states — `pending`, `sent`,
`supplier_action_required`, `pending_validation`, `pending_review`. Only one of those has
a ReviewNote moment. To keep the audit trail consistent, **all cancellation reasons route
to the event log**, regardless of source state. ReviewNote stays semantically tight —
"what the analyst said during formal review" — and its `review_action` enum stays
`approved | rework`.

> ⚠ **V3.2-1 (F6):** the precondition validates the reason, but persistence is
> unverified — confirm the OBS `state_transition` event carries `cancellation_reason`;
> if not, add it to details_json (alongside the planned `wfa_stage` addition).

## Trigger-context tokens

Canonical set (v3): `initial_creation · invitation_issued · submission_received ·
system_validation_passed · system_validation_failed · system_validation_error ·
analyst_rework · analyst_approve · analyst_cancel`.

Emitters: creator convention (initial_creation, nominal — birth bypasses STS-01); INV-01
(invitation_issued); SUB-01 (submission_received at intake; system_validation_error on the
is_error branch and catch path — both channels); `finalize_verdict` (the three system_*
tokens; ⚠ Q1(a) source verification); REV-01 `DECISION_MAP` (analyst_approve,
analyst_rework); cancellation caller (analyst_cancel).

Retired: ~~display_refresh~~ (D4). Never implemented: ~~pipeline_error_alert~~,
~~system_structural_failure~~ — and `system_validation_error` is not a revival of
`pipeline_error_alert`: the old token was a display-refresh concept with no transition;
the new one is a real exit edge required by D1's parked state.

---

## Display derivation (`supplier_display_status` / `supplier_message`)

Computed from `(target_state, trigger_context)` plus context fields; stored as **literal
strings** (snapshot semantics, IV-6; date rendering per C10; wording changes are recipe
changes, not migrations).

| Target state | Trigger context | supplier_display_status | supplier_message | Status |
|---|---|---|---|---|
| pending | initial_creation | *(empty)* | *(empty)* | active |
| sent | invitation_issued | Action needed: complete and submit template | Please complete the attached template and submit by {due_date}. | active |
| pending_validation | submission_received | Submitted: processing | We've received your submission and are checking it now. No action is needed at this time. | **active (v3) — placeholder-free by design** |
| supplier_action_required | system_validation_failed | Action needed: corrections required | Validation found {invalid_row_count} issue(s) in your submission on {validated_at}. Please review the validation notes and resubmit. | **dormant** (pilot) |
| supplier_action_required | system_validation_error | Action needed: resubmission required | We ran into a technical problem while processing your submission. Please submit again, or contact {analyst_email} if the problem continues. | **active (v3)** |
| supplier_action_required | analyst_rework | Action needed: changes requested by reviewer | The reviewer requested changes on {reviewed_at}. Please review and resubmit. | active |
| pending_review | system_validation_passed | Submitted: under review | Your submission was received on {submitted_at} and is being reviewed. No further action is needed at this time. | active |
| pending_review | system_validation_failed | Submitted: under review | Your submission was received and validated on {validated_at}, and is under review. No further action is needed at this time. | **active — pilot row** (C9) |
| approved | analyst_approve | Approved | Your submission was approved on {approved_at}. Thank you. | active |
| cancelled | analyst_cancel | Request closed | This request has been closed. Please contact {analyst_email} with questions. | active |
| ~~supplier_action_required~~ | ~~display_refresh~~ | | | retired (D4) |
| ~~supplier_action_required~~ | ~~system_structural_failure~~ | | | retired (C2/Q4) |
| ~~(any)~~ | ~~pipeline_error_alert~~ | | | retired — never implemented (C3) |

Gather branches: ValidationResult/report-link on `system_validation_failed` only; Project
fetch on `{analyst_cancel, system_validation_error}`; `submission_received` matches no
branch by design (its row must stay placeholder-free). Context keys: `due_date`,
`invalid_row_count`, `validated_at`, `validation_report_link`, `review_note_text`,
`reviewed_at`, `submitted_at`, `approved_at`, `analyst_email` (the two unused keys are
retained for revert/wording headroom).

---

## WFA stage projection *(v3.1 — E1/E2)*

**`STATUS_TO_WFA_STAGE` — stage identity = the name, verbatim** (recipes bind
`workflow_stage_id` by name object; names survive workspace import — the portability
requirement, confirmed against the lcap_app export and INV-01a):

| status | stage name (identity) | written by | page binding (per app export) |
|---|---|---|---|
| pending | Pending assignment to supplier | REQ-01/SUP-02 at birth (C7) | details_page "Pending assignment" |
| sent | Assigned to supplier | INV-01a (task issuance) | task_page "Copy of Submit data for validation" |
| supplier_action_required | Assigned to supplier *(shared — E2)* | INV-01a (task issuance) | same task_page + corrections panel on `status = supplier_action_required` |
| pending_validation | Validation in progress | **STS-01 (new build, E1)** | details_page "Validation in progresss" *(page-name typo, hygiene)* |
| pending_review | Under human review | INV-01a (task issuance) | task_page "Human review" |
| approved | Resolved | **STS-01 (new build, E1)** | none bound — add a details_page for the literal per-stage-page ask |
| cancelled | Canceled | **STS-01 (new build, E1)** | none bound — add a details_page for the literal per-stage-page ask |
| *(never)* | Active — **deliberately absent** | nobody | none — canary only (E5) |

**Write mechanics:** stage is the WFA system field `CURRENT_STAGE`, not a table column.
Task-bearing stages ride `human_review_on_existing_record` (stage + task + page in one
call — platform atomicity, kept). Task-less stages get an STS-01 write directly after the
row update, before OBS, via the stage-only update action (Q6 gate; pill vs picklist
decides one parametric write vs three static branches). The legality step returns
`wfa_stage` (the name): drives the parametric write if supported, and is emitted in the
OBS `state_transition` details either way — expected-vs-actual stage drift becomes
detectable from the event log.

**Task pairing (E9):** SAR ⇒ INV-01a supplier assignment (rework, system-failed when
live, **and the error exit**); pending_review ⇒ analyst assignment; pending_validation ⇒
no task; terminals ⇒ none. The app config already encodes this: task-bearing stages bind
task_pages, task-less stages bind details_pages.

**Monitoring (E6):** "Validation in progress" resting > ~1 h = stuck-state signal.
**Canary (E5):** any row resting on "Active" = missed birth write.
**App hygiene:** "Validation in progresss" page-name typo; supplier task_page named
"Copy of Submit data for validation"; terminals need details_pages bound.

---

## Subsidiary machines

### Upload — five states

`received` → `extracting` → `validating` → `validated`, with `error` as an off-ramp from
`extracting` or `validating`.

- `received`. Entered on submission intake. Can: transition to `extracting`.
- `extracting`. Can: → `validating` or `error`. Cannot: accept further submissions against
  this row; resubmission creates a new Upload. *(Form-channel Uploads arrive with
  `extracted_path` pre-populated by FRM-01 and may legitimately skip `extracting` —
  verify at implementation.)*
- `validating`. Can: → `validated` regardless of pass/fail, or `error` on a pipeline
  error. Cannot: produce a verdict — ValidationResult's job.
- `validated`. **Terminal-success.** A ValidationResult exists; does **not** mean the data
  was good — bad-data outcomes are `validated` Uploads with `failed` ValidationResults.
- `error`. **Terminal-pipeline-error.** New Upload required for retry. *(v3: an `error`
  outcome now also fires `pending_validation → supplier_action_required` via
  `system_validation_error` at the request level.)*

### ValidationResult — four states

`running` · `passed` · `failed` · `error`, as v2 — including the C2 write collapse
(`passed → passed`, `error → error`, everything else including `structural_failure` and
`empty` → `failed`). `error` means "the pipeline crashed" in both tables; bad data is
`failed` on ValidationResult only.

### TemplateVersion — three states

`draft` → `published` (forward-only; snapshot semantics — typo fixes flow through new
draft versions) → `deprecated` (terminal; in-flight requests run to terminal on their
version; new work goes on the new version).

### Three binary machines *(restored from v1, F1/F5)*

**`Supplier.status` — `active | deactivated`.** Active is default. Deactivated stops the
supplier appearing in lookups for new SupplierRequest creation; existing in-flight
requests are unaffected. The supplier-wide statement, distinct from per-request
`cancelled`.

**`SupplierUser.status` — `active | deactivated`.** Mirror at the contact level.
Deactivated contacts receive no invitations or **reminders** on new requests; in-flight
requests assigned to that contact at invitation time stay assigned (no mid-cycle
reroute). Survives across versions (SupplierUser belongs to Supplier, not to any one
request).
> ⚠ **V3.2-2 (F5):** verify REM-02's eligibility filters deactivated SupplierUsers
> before Workflow 7 ships.

**`Project.project_completion_status` — `active | inactive`.** Workspace-level kill
switch. No recipe branches on it; a flag for human operators and tooling.

---

## Invariants

**Invariant 1 — Single-writer rule (E4 as amended).** STS-01 is the only post-creation
writer of the four table fields (`status`, `supplier_display_status`, `supplier_message`,
`current_state_entered_at`). The WFA stage joins the protected set under a
**deterministic-writer-per-target** rule: task-less stages only by STS-01; task-bearing
stages only by INV-01a as part of the paired assignment (E9); birth stamps only by
REQ-01/SUP-02 (C7). Every writer reads the one projection table; no other recipe touches
stage.

**Invariant 2 — Audit chain carries the "why."** *(restored, F1)* The state name carries
no causal information. System-driven rework is captured by ValidationResult + FieldError;
analyst-driven rework by ReviewNote with `review_action: rework`. The state machine treats
both identically.

**Invariant 3 — Upload owns the in-flight pipeline.** *(restored + amended, F2)*
SupplierRequest tracks only resting states. The `received → extracting → validating →
validated|error` arc lives on Upload. ~~The supplier-facing display reads from Upload
during the active window without requiring a SupplierRequest state to express it.~~
*Struck (D1): `pending_validation` is the resting state for the active window, and the
supplier display comes from its derivation row, not from Upload.*

**Invariant 4 — State knows nothing about reminders.** *(restored + amended, F3)*
Eligible: `sent`, `supplier_action_required`. Ineligible: `pending`,
**`pending_validation`**, `pending_review`, `approved`, `cancelled`. Firing (cadence, cap,
opt-out) is the policy layer's concern (D8).

**Invariant 5 — Cancellation reasons route to EventLog.** *(restored, F1)* ReviewNote
captures only formal review actions (`approved | rework`). All cancellations — regardless
of source state — write their reason to the event log. One consistent place to answer
"why was this cancelled." *(Persistence verification: V3.2-1.)*

**Invariant 6 — Snapshot semantics for display fields.** Literal strings stamped at
handler write time; the WFA does not template at render (C10 date mechanism).

**Invariant 7 (v3) — Submissions are transition pairs.** Every accepted submission moves
the request into `pending_validation` and out on the verdict — including repeat failures
(SAR → PV → SAR). Display freshness is a by-product of real transitions; no refresh
no-ops. "State moves only when the resting situation changes" is preserved: a submission
changes the resting situation twice.

**Invariant 8 — Guaranteed exit from `pending_validation`.** Every entry is exited in the
same pipeline run via verdict, error, or cancel — enforced in SUB-01 (intake-refused
guard, exit-refused guards on both exits, catch's best-effort error exit). Residual
hard-kill risk monitored per E6.

**Invariant 9 — Stage purity (E8).** The WFA stage carries no information absent from
`status`; the projection map is total over the seven states and nothing else. New pages
require new states (doc → table → projection) or sub-views — never a new stage.

---

## Deliberately omitted *(restored from v1, F1; amendments per F4)*

- **`in_progress` as a state** — no recipe behavior distinguished it from `sent`. UI
  flavor masquerading as state.
- **`submitted` as a state** — Upload owns the in-flight pipeline; a bare waiting state
  added no behavior. *(F4 amendment: `pending_validation` is not `submitted` revived — it
  passes the behavior test that `submitted` failed: it closes the concurrent-submission
  window via the accepting-states guards, owns a derivation row and a page, is
  reminder-excluded, and carries the exit guarantee, IV-8.)*
- **`validated` as a state distinct from `pending_review`** — validation completion and
  analyst notification co-occur in the same recipe; the split was bookkeeping.
  *(Pilot-widened premise noted in the pilot section.)*
- **`rejected` as a state** — demoted to a transition (`analyst_rework`); the reason
  lives in ReviewNote. No behavior in the state, immediate transition out.
- **Splitting `supplier_action_required`** into system-failed and analyst-rework states —
  supplier behavior is identical; the audit chain carries the "why," the derivation rule
  produces the different messages.
- **A separate cancellation state distinct from `cancelled`** — one terminal-not-approved
  state covers all closure reasons; the event log carries the reason.
- **WFA stage as an independent state machine** — *(F4 amendment: now implemented as the
  derived projection, E1/IV-9. The two-system drift problem from the pre-v1 model stays
  gone — by construction then, by convention and canary now.)*
- **A `ReminderPolicy` table** — still omitted. The D8 model expresses policy in columns
  (`Project.reminder_cadence`, `Project.max_reminders`, per-request `reminders_enabled`);
  a policy table remains speculative complexity until a use case forces it.

---

## Pilot deviation — analyst decision point after validation

**Status: LIVE** (C1; routing point re-homed per E7). Intent unchanged: during the pilot
the system does not decide pass/fail routing — every completed validation routes to
`pending_review`, the analyst reviews verdict + input and actions approve or rework, and
the supplier sees the neutral message, never the verdict. The single redefinition:
`pending_review` = "validation completed (passed **or** failed), analyst owes the
decision."

- **Single routing point:** SUB-01's `sts.target_state` variable, literal
  `="pending_review"`. (The exported fallback formula had silently disabled the pilot —
  found and fixed, E7.)
- **Entry condition + precondition:** `status ∈ {passed, failed}` admitted; `error` /
  `running` / absent rejected. Phase 0 (`passed` only) resumes on revert.
- **Tables:** pilot row `(pending_validation, pending_review, system_validation_failed)`
  active; Phase 0 canonical row dormant; the `system_validation_error` exit is **not**
  pilot-scoped. One pilot derivation row (C9 wording); the SAR/system-failed row dormant;
  `analyst_rework` and `system_validation_error` are the live SAR entries during the
  pilot.
- **Stage note:** the projection is pilot-agnostic — no projection change on revert.
- **Invariant 7:** active in both modes as of v3 (the transition-pair semantics replaced
  the no-op entirely; the old "dormant, not violated" note is obsolete).
- **Structural failures:** Option A (C2) — collapse lives in the connector and VAL-01;
  survives revert.
- **Known violation:** C5 / WFA-013 still exposes raw verdict + row counts. Remediation:
  surface `supplier_display_status`, suppress counts. One recipe edit; natural companion
  to this pass.
- **Revert:** restore connector-target passthrough in SUB-01 (re-activates the dormant
  row); remove the pilot derivation row and the precondition widening. No data migration.
  Independent of revert: Option A, the WFA-013 fix, all v3/v3.1/v3.2 structure.

---

## Defect list

| # | Where | Defect | Severity |
|---|---|---|---|
| C3b | REV-01 (19×), WFA-006 (1×) | `pending_reivew` typo in schema hints; live logic clean | cosmetic |
| C4 | UTL-01 | `expires_at` declared, never populated — populate or delete | low |
| C5 | WFA-013 | Raw verdict + row counts exposed to supplier — remediate with this pass | **high (pilot)** |
| C7 | SUP-02 | Creation set omits `supplier_message`; extend the Q3 check to the stage stamp | low |
| C12 | VAL-01 step 41 | Dead `force_manual_review` shim — delete at prune | hygiene |
| V3-1 | STS-01 | OBS-after-write → async (folded into v3 STS-01 edit) | low |
| V3-2 | STS-01 | Message nits (folded into v3 STS-01 edit) | cosmetic |
| **V3.2-1** | STS-01 / OBS | `cancellation_reason` validated but persistence unverified — confirm the state_transition event carries it; else IV-5 is theater. Add to details_json with `wfa_stage` | **verify first** |
| **V3.2-2** | REM-02 | Deactivated SupplierUser filter unverified — confirm eligibility excludes them before Workflow 7 ships | **verify first** |
