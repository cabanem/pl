# SDC Data Collection — State Machines (v3.1)

## Status

Point release on v3 (2026-08-06). v3 added `pending_validation`, retired `display_refresh`,
and moved error verdicts into the state machine. **v3.1 locks the WFA stage projection**:
per the team decision that every stage maps to a page, `workflow_app_stage` becomes a pure
projection of `status`, written by STS-01 as the single post-creation writer. This resolves
Q2, retires defect C8, and amends D11.

Code sync status: STS-01 v3 tables and SUB-01 v3 orchestration are applied (cutover test
pending); the STS-01 task-less stage writes (E1) are **not yet built**. Stage identity is
**resolved** (2026-08-06, lcap_app export + INV-01a actions): recipes bind
`workflow_stage_id` **by name object** — the display names are the stable, portable
identity (they survive workspace import; no IDs exist in exports). Remaining Q6: the
stage-only write mechanics for task-less stages.

Supplier-visible state rides the display columns exclusively (confirmed 2026-08-06); the
raw `status` enum is not supplier-visible except via defect C5 (WFA-013), whose
remediation stands.

> **Provenance note (2026-07-02, carried forward).** Sections marked
> `[TEXT NOT RECOVERED — restore from v1 copy]` were not recovered verbatim and carry no
> later edits.

---

## CHANGELOG (v3 → v3.1, 2026-08-06)

**E1 — Stage is a pure projection of status; writers split by stage class.** *(resolves
Q2, retires C8; team decision; amended 2026-08-06 after lcap_app/INV-01a evidence)* The
team requires each WFA stage to map to a page. Rather than letting stages drift into a
second state machine (the thing v1 removed), the projection is extended to **every
transition** — but the platform shapes the write: stage is **not a table column** (it is
the WFA system field `CURRENT_STAGE`), and the WFA action that sets it for task-bearing
stages (`human_review_on_existing_record`) sets **stage + task + page atomically in one
call**. Fighting that coupling would mean two racing writers, so the design is a
split-writer-by-stage-class, values constrained to one projection table:
- **Task-bearing stages** ("Under human review", "Assigned to supplier"): stamped by
  **INV-01a** as part of task issuance — already built, already correct at every call
  site, and guaranteed to fire on every entering transition by the E9 pairing.
- **Task-less stages** ("Validation in progress", "Resolved", "Canceled"): stamped by
  **STS-01** immediately after its row write — the **new build**. Mechanism: the
  stage-only update action (Q6 check; `add_request` proves stage-without-task exists at
  create, so the update surface very likely mirrors it).
- **Birth**: REQ-01/SUP-02 stamp "Pending assignment to supplier" via `add_request` (C7
  carve-out, unchanged).
Ordering note: INV-01a runs async after STS-01's synchronous row write, so for
task-bearing targets there is a brief window where status has committed and stage hasn't —
self-healing, one enqueued call wide, and the interim page (the prior stage's) is
read-only-safe under the allow-list audit.

**E2 — Projection table locked with the existing token inventory.** No new stages are
invented. `sent` and `supplier_action_required` deliberately **share** "Assigned to
supplier": the projection is many-to-one, matching the doc's own claim that SAR is
"identical to `sent` from the supplier's side" apart from the message. One submission
page, differentiated by the display columns; a corrections-only panel (validation notes,
reviewer feedback) conditions on `status = supplier_action_required` — allow-list shaped,
hides on unknown values.

**E3 — D11 amended.** `pending_validation` now **has** a stage ("Validation in progress").
The decision reverses; the reasoning holds: the stage is still *derived*, never
independent. The supplier gains a real page for the validating interval — calm, read-only,
no actions — replacing the stale-last-page gap.

**E4 — Migration collapses to one build.** *(amended 2026-08-06)* Because the platform
couples stage+task+page in the assignment action, INV-01a **keeps** its stage writes —
they are the projection for task-bearing stages, already correct at every call site, and
no param strip occurs. The only new build is STS-01's task-less stage writes ("Validation
in progress" on `submission_received`; "Resolved" on `analyst_approve`; "Canceled" on
`analyst_cancel`), placed directly after the row update, before OBS. INV-01a's two
vocabularies note: its `workflow_app_stage` *parameter tokens* (`under_human_review`,
`assigned_to_supplier`, `pending_assignment`) are its own API surface and map internally
to stage **names** — the names are the identity; the tokens are call-site convenience.
Cutover test extends per E1's table; no other recipe changes.

**E5 — "Active" is a canary.** The WFA's default base stage maps to **no** state and is
never a legal resting value. Since birth stamps "Pending assignment to supplier," any row
resting on Active means a birth write was missed — a C7-class bug visible for free in the
app's own list view. Do not assign Active a page; do not "clean it up" by making it mean
something.

**E6 — "Validation in progress" doubles as the Q5 stuck-state monitor.** The stage is
fleeting by design (seconds to minutes). A request resting on it beyond ~1 hour *is* the
stuck-`pending_validation` signal, visible to any analyst filtering the list view by
stage — an operational watchdog with zero tooling. Q5 is provisionally closed as
**accept and monitor via stage view**; revisit at volume.

**E7 — D10 corrected: SUB-01 is the single verdict-routing point.** Since the channel
refactor, both channels converge on SUB-01 before validation; UPL-01's inline verdict tail
is retired legacy (delete at prune). The pilot target literal lives in exactly one place:
SUB-01's `sts.target_state` variable (`="pending_review"`). Finding recorded: the exported
SUB-01 carried a connector-passthrough fallback instead of the literal — with the v3
connector always emitting a target, **pilot routing was silently off** (failures routed
Phase-0-style through the dormant rows, rendering the dormant corrections derivation row
to the supplier). Fixed by the literal. Revert = restore connector-target passthrough.

**E8 — The stage rule.** *A stage may never carry information that is not in `status`.*
When a new page is requested that corresponds to no state ("awaiting signature," "on
hold"), the answer is a new canonical state (doc first → `LEGAL_TRANSITIONS` → projection
row) or a sub-view of an existing page — never a rogue stage. This rule is what keeps
"stage maps to page" from becoming a second, unsynchronized state machine.

**E9 — Task-pairing convention recorded.** Every transition into
`supplier_action_required` pairs with an INV-01a supplier assignment — **including the
error exit**, which as first built issued no task (gap fixed in SUB-01: INV-01a call added
inside the is_error branch after the exit-refused guard, mirroring the rework branch with
an error-flavored task name). Every transition into `pending_review` pairs with an analyst
assignment. `pending_validation` pairs with **no task** — the task consumed at intake is
the WFA's representation of "the system has it." Terminals pair with nothing.

---

## CHANGELOG (v2 → v3, 2026-08-06) — carried for self-containment

**D1** New state `pending_validation` (supplier-visible processing phase; accepting-states
guards close the concurrent-submission window; stuck pipelines become visible).
**D2** New trigger `submission_received`, emitted at intake (now: by SUB-01 for both
channels — see E7). **D3** New trigger `system_validation_error`; error verdicts exit
through the state machine instead of aborting pre-STS-01. **D4** `display_refresh`
retired; repeat failures are the honest transition pair SAR → PV → SAR; resolves the
Q1(b) trap by construction. **D5** The five direct sent/SAR → verdict rows retire at
cutover (kept legal during migration; prune after the test). **D6** Derivation rows:
added `(pending_validation, submission_received)` (placeholder-free by design) and
`(supplier_action_required, system_validation_error)` ({analyst_email} via the widened
Project gather branch); retired the display_refresh row. **D7** Submissions bump
`current_state_entered_at` twice via real transitions; re-arming the REM cadence anchor on
resubmission is intended. **D8** Reminder layer re-synced: recurring interval
(`Project.reminder_cadence`, `Project.max_reminders`; row `reminder_count`,
`last_reminder_sent_at`; anchor `max(current_state_entered_at, last_reminder_sent_at)`);
tier model retired from schema; Workflow 7 in build. **D9** `finalize_verdict`
design-locked: passed → system_validation_passed; failed/structural/empty →
system_validation_failed; error → system_validation_error; no prior-state input, no
display_refresh branch. **D10** Pilot re-homed to the `pending_validation` exit —
**corrected by E7**: single routing point is SUB-01. **D11** `pending_validation` and WFA
surface — **amended by E3**.

---

## OPEN QUESTIONS (for the maintainer)

**Q1 — finalize_verdict emitted set.** (a) v3 mapping emitted and applied in SUB-01
(prior_state unmapped, confirmed in export); ⚠ verify the deployed connector source
matches the D9 spec. (b) Resolved by construction (D4/D9).

**Q2 — RESOLVED (E1).** Team decision: per-stage pages; projection extended to all
transitions; STS-01 sole post-creation stage writer.

**Q3 — Initial status literal at creation.** Unchanged. Now also covers the stage: confirm
REQ-01/SUP-02 stamp "Pending assignment to supplier" (or add it with the C7 fix).

**Q4 — Physical pruning.** One pass after the cutover test: the retired structural rows
(v2), the retired display_refresh rows (D4), the five legacy direct-verdict rows (D5),
and UPL-01's skipped inline tail (E7). (The INV-01a param strip is withdrawn — E4 as
amended keeps those writes.)

**Q5 — PROVISIONALLY CLOSED (E6).** Stuck-state risk accepted; monitored via the
"Validation in progress" stage view. Revisit at volume.

**Q6 — Stage-only write mechanics (narrowed 2026-08-06). ⚠** Stage identity is resolved:
names, bound by name object, verbatim from the app export. Two checks remain before
building E1's task-less writes: (1) which WFA action sets `workflow_stage_id` **without
creating a task** — check `update_request`'s input schema in the builder (`add_request`
proves the provider supports stage-without-task at create); (2) whether that stage input
accepts a **pill** (one parametric write driven by the legality step's `wfa_stage`
output) or is **picklist-only** (three static branches on `target_state`, mirroring
INV-01a's precedent — equally acceptable; the doc table remains the source both mirror).

**Q0 — Source-text gaps.** Unchanged; unrecovered sections carry no later edits.

---
---

# The document

## Foundational decisions

1. **The audit chain carries the "why," the state machine carries the "what."**
   *(Temporarily widened by the pilot.)*
2. **Upload owns the in-flight pipeline; SupplierRequest tracks resting states only.**
   > **Amended (D1).** `pending_validation` names a *resting situation* — the ball is with
   > the system — spanning the entire Upload arc. The request never mirrors Upload's
   > per-step states.
3. **State knows nothing about reminders.** Eligibility is state-machine; firing is
   policy-layer (Workflow 7 = REM-01 executor + REM-02 eligibility; D8 model). Eligibility
   states: `{sent, supplier_action_required}` — `pending_validation` never reminds.

**New in v3.1:**

4. **Stage knows nothing that status doesn't.** (E8.) The WFA stage is a derived
   projection of `status` — many-to-one where states share a page — written only by STS-01
   post-creation. Pages route on stage; behavior routes on status; the supplier reads the
   display columns. Three layers, one source of truth.

## SupplierRequest — seven states

Each state block now names its stage projection. `[TEXT NOT RECOVERED]` markers as in v3.

### pending — stage: Pending assignment to supplier
Entered at analyst creation before commitment to invite. Can: edit metadata, assign
contacts, attach a variant, → `sent` or `cancelled`. Cannot: accept submissions, validate,
surface to the supplier portal. Note: the stage description says "transitory, brief" and
usually is — but the canonical state permits long dwells (batch-staged campaigns, missing
contacts); do not alert on dwell time here. Birth: REQ-01/SUP-02 stamp status, display
fields, timestamp, **and stage** (C7 carve-out, extended E4).

### sent — stage: Assigned to supplier
Invitation issued, `template_file_id` populated. Can: accept an Upload or form submission —
**acceptance immediately transitions to `pending_validation`**; regenerate the template
link (7-day recipe-set TTL, C4); be reminded. Cannot: show analyst review pages.

### supplier_action_required — stage: Assigned to supplier *(shared token, E2)*
Entered on analyst rework, on system validation failure *(dormant during pilot)*, or on a
pipeline error (`system_validation_error` — active in both modes). Identical to `sent`
from the supplier's side; same page, differentiated by the display columns and the
status-scoped corrections panel. Every entry pairs with an INV-01a supplier assignment
(E9).

### pending_validation — stage: Validation in progress *(new, D1; stage per E3)*
Entered via `submission_received` at intake (SUB-01, both channels). The ball is with the
system: no open task (consumed at intake — E9), no reminders, no actions on the page.
Exits: verdict, error, or `analyst_cancel`. Exit guaranteed per IV-8; dwell beyond ~1 hour
is the stuck-state signal (E6).

### pending_review — stage: Under human review
`[TEXT NOT RECOVERED — restore from v1 copy]`
*(Pilot definition: validation completed, passed or failed; analyst owes the decision.
Entry always from `pending_validation` as of v3. Pairs with an analyst assignment, E9.
The token is renameable cosmetically; pages and recipes key on the token, not the label.)*

### approved — stage: Resolved
`[TEXT NOT RECOVERED — restore from v1 copy]`
*(Terminal. Precondition: `approved_at` + `approved_path`, written by REV-01 before it
calls STS-01.)*

### cancelled — stage: Canceled
`[TEXT NOT RECOVERED — restore from v1 copy]`
*(Terminal. Precondition: `cancellation_reason` required — C11. Reachable from every
non-terminal state.)*

---

## Transition graph

Unchanged from v3 in content; row statuses updated to reflect applied code. Source of
truth for STS-01's `LEGAL_TRANSITIONS`.

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

Preconditions unchanged (template_path → sent; terminal ValidationResult →
pending_review; approved_at + approved_path → approved; cancellation_reason → cancelled;
none for pending / SAR / pending_validation).

## Trigger-context tokens

Canonical set (v3): `initial_creation · invitation_issued · submission_received ·
system_validation_passed · system_validation_failed · system_validation_error ·
analyst_rework · analyst_approve · analyst_cancel`. Emitters as in v3, with E7's
correction: SUB-01 emits `submission_received` and the catch-path/is_error
`system_validation_error` for both channels.

---

## Display derivation (`supplier_display_status` / `supplier_message`)

Unchanged from v3 (D6 rows included; snapshot semantics IV-6; C10 date rendering; the
`submission_received` row stays placeholder-free). Gather branches:
`system_validation_failed` solo; `{analyst_cancel, system_validation_error}` widened;
`submission_received` matches nothing by design.

---

## WFA stage projection *(new section, v3.1 — E1/E2)*

**`STATUS_TO_WFA_STAGE` — source of truth; stage identity = the name, verbatim
(recipes bind `workflow_stage_id` by name object; names survive workspace import —
the portability requirement, confirmed against the lcap_app export and INV-01a):**

| status | stage name (identity) | written by | page binding (per app export) |
|---|---|---|---|
| pending | Pending assignment to supplier | REQ-01/SUP-02 at birth (C7) | details_page "Pending assignment" |
| sent | Assigned to supplier | INV-01a (task issuance) | task_page "Copy of Submit data for validation" |
| supplier_action_required | Assigned to supplier *(shared — E2)* | INV-01a (task issuance) | same task_page + corrections panel on `status = supplier_action_required` |
| pending_validation | Validation in progress | **STS-01 (new build, E1)** | details_page "Validation in progresss" *(page-name typo, hygiene)* |
| pending_review | Under human review | INV-01a (task issuance) | task_page "Human review" |
| approved | Resolved | **STS-01 (new build, E1)** | none bound — add a details_page for the literal per-stage-page ask |
| cancelled | Canceled | **STS-01 (new build, E1)** | none bound — add a details_page for the literal per-stage-page ask |
| *(never)* | Active — **deliberately absent from the map** | nobody | none — canary only (E5) |

**Write mechanics (E1, amended):** stage is a WFA system field (`CURRENT_STAGE`), not a
table column. Task-bearing stages ride `human_review_on_existing_record` (stage + task +
page in one call — the platform's atomicity, kept). Task-less stages get an STS-01 write
directly after the row update, before OBS, via the stage-only update action (Q6 check;
pill-vs-picklist determines one parametric write vs three static branches). The legality
step still returns `wfa_stage` (the name): it drives the parametric write if supported,
and is emitted in the OBS `state_transition` details either way, so expected-vs-actual
stage drift is detectable from the event log.

**Task pairing (E9):** SAR ⇒ INV-01a supplier assignment (rework, system-failed when
live, **and the error exit**); pending_review ⇒ analyst assignment; pending_validation ⇒
no task (intake consumed it); terminals ⇒ none. The app config already encodes this:
task-bearing stages bind **task_pages**, task-less stages bind **details_pages** — the
pairing convention is visible in the export, which is exactly what a projection should
look like.

**App hygiene (cosmetic):** page internal name "Validation in progresss" (extra s);
supplier task_page still named "Copy of Submit data for validation"; terminals need
details_pages bound to satisfy the team's literal per-stage-page requirement.

**Monitoring (E6):** "Validation in progress" resting > ~1 hour = stuck-state signal.
**Canary (E5):** any row resting on "Active" = missed birth write.

---

## Subsidiary machines

Unchanged from v3: Upload five states (form-channel note stands), ValidationResult four
states with the C2 write collapse, TemplateVersion three states, three binary machines.

---

## Invariants

**Invariant 1 — Single-writer rule (widened, E4 as amended).** STS-01 is the only
post-creation writer of the four table fields (`status`, `supplier_display_status`,
`supplier_message`, `current_state_entered_at`). The WFA stage joins the protected set
with a **deterministic-writer-per-target** rule rather than a single writer: task-less
stages are written only by STS-01; task-bearing stages only by INV-01a as part of the
assignment its entering transition pairs with (E9); birth stamps only by REQ-01/SUP-02
(C7 — SUP-02's missing `supplier_message` remains the known defect). Every writer takes
its value from the one projection table; no other recipe touches stage.

**Invariants 2–5.** `[TEXT NOT RECOVERED — restore from v1 copy]`

**Invariant 6 — Snapshot semantics for display fields.** Unchanged.

**Invariant 7 (v3) — Submissions are transition pairs.** Unchanged.

**Invariant 8 — Guaranteed exit from `pending_validation`.** Unchanged; enforced in
SUB-01 by the intake-refused guard, the exit-refused guards on both verdict and error
exits, and the catch's best-effort error exit. Residual hard-kill risk: E6 monitoring.

**Invariant 9 — Stage purity (new, E8).** The WFA stage carries no information absent
from `status`; the projection map is total over the seven states and nothing else. New
pages require new states (doc → table → projection) or sub-views — never a new stage.

---

## Deliberately omitted

`[TEXT NOT RECOVERED — restore from v1 copy]`

---

## Pilot deviation — analyst decision point after validation

As in v3, with E7's corrections:

- **Single routing point:** SUB-01's `sts.target_state` variable, literal
  `="pending_review"`. (The exported fallback formula silently disabled the pilot; fixed.)
- **Stage note:** the projection is pilot-agnostic — under the pilot, verdict exits land
  on `under_human_review`; on revert, failed exits land on `assigned_to_supplier`. No
  projection change on revert.
- **Revert:** restore connector-target passthrough in SUB-01; dormant row re-activates;
  remove the pilot derivation row and the `pending_review` precondition widening.
  Independent of revert: Option A, the WFA-013 fix, and all v3/v3.1 structure.
- **C5 remediation stands** (WFA-013 surfaces `supplier_display_status`, suppresses
  counts) — natural companion to this pass.

---

## Defect list

| # | Where | Defect | Severity |
|---|---|---|---|
| C3b | REV-01 (19×), WFA-006 (1×) | `pending_reivew` typo in schema hints; live logic clean | cosmetic |
| C4 | UTL-01 | `expires_at` declared, never populated — populate or delete | low |
| C5 | WFA-013 | Raw verdict + row counts exposed to supplier — remediate with this pass | **high (pilot)** |
| C7 | SUP-02 | Creation set omits `supplier_message`; extend check to the stage stamp (Q3) | low |
| ~~C8~~ | ~~STS-01~~ | ~~Stage projection unimplemented~~ — **closed by E1** (build tracked as v3.1 work) | closed |
| C12 | VAL-01 step 41 | Dead `force_manual_review` shim — delete at prune | hygiene |
| V3-1 | STS-01 | OBS-after-write → async (folded into v3 STS-01 edit) | low |
| V3-2 | STS-01 | Message nits (folded into v3 STS-01 edit) | cosmetic |
