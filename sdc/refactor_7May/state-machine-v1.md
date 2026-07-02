# SDC Data Collection — State Machines (v2)

## Status

Workstream 2 of Phase 0, reconciled against the 2026-07-02 workspace export (58-recipe
OpenAPI regeneration + recipe JSON for STS-01 v49, UPL-01 v121, VAL-01 v135, REV-01 v166).
Companion document to `sdc-data-model-v2.md`. **Reconciled and version-bumped 2026-07-02.**

> **Provenance note (2026-07-02).** The v1 source file was not among the reconciliation
> artifacts. The base text below was reconstructed from the original design-session records
> (2026-05-07 body, 2026-06-10 pilot addendum) and from the doc-synced tables mirrored in
> STS-01's live Python ("Source of truth: sdc-state-machines-v1.md" headers). Sections that
> could not be recovered verbatim are marked `[TEXT NOT RECOVERED — restore from v1 copy]`
> and carry **no** reconciliation edits. Every reconciliation edit is confined to recovered
> text and is itemized in the changelog. Diff this file against your local v1 before adopting.

---

## CHANGELOG (v1 + pilot addendum → v2, 2026-07-02)

Each entry: what changed, classification, and the evidence line that forced it.

**C1 — Pilot Status line: confirmed LIVE.** *(resolved OPEN QUESTION)*
Evidence: UPL-01 v121 step 31 writes the literal `target_state = "pending_review"`
(`"variables": {"target_state": "pending_review", ...}`); spec x-note: "PILOT OVERRIDE IS
LIVE ... step 31 hardcodes target_state='pending_review' for ALL non-error verdicts." The
`pending_reivew` typo exists only in the step *comment*; the written literal is spelled
correctly. Pilot section Status updated accordingly.

**C2 — Structural-failure routing: Option A (normalize) won.** *(DOC ROT — decision made
in code, recorded 2026-07-02)*
Evidence: (a) VAL-01 step ~"add_record RUN_ValidationResult" collapses status with the
formula `verdict_status == "passed" ? "passed" : verdict_status == "error" ? "error" :
"failed"` — so `structural_failure` **and** `empty` both persist as `failed`; (b) STS-01
v49's live `LEGAL_TRANSITIONS` and `DERIVATION_TABLE` contain no `system_structural_failure`
token or row; (c) spec x-note: "Neither system_structural_failure nor pipeline_error_alert
appears anywhere in the export (schema or code)." The Phase 0 structural derivation rows are
marked **retired** (kept visible, struck, not deleted — see D-table note; physical pruning is
Open Question Q4). Residual verification on the connector itself is Open Question Q1.

**C3 — Trigger-context token inventory reconciled.** *(mixed)*
The canonical set is now stated in one place (§ Trigger-context tokens). Sub-edits:
- `pipeline_error_alert` removed from the refresh-trigger set. *(DOC ROT)* Evidence: token
  absent from the entire export; UPL-01's `is_error` gate (step 28) aborts **before** STS-01
  with an OBS-01 `recipe_failed` event — pipeline errors never reach the state machine, so
  no refresh trigger exists for them.
- STS-01's declared parameter hint omits `initial_creation` while the live legal table
  accepts it. *(CODE BUG — cosmetic, schema-hint only.)* Evidence: spec x-note
  "DISAGREEMENT: the declared parameter hint enum omits initial_creation"; live table
  contains `("", "pending", "initial_creation")`.
- `pending_reivew` typo: **fixed in all live logic** (0 occurrences in STS-01 v49 JSON;
  legal table spells both pilot rows correctly), but persists in REV-01's declared/extended
  result-schema hints (19 occurrences) and WFA-006 (1). *(CODE BUG — cosmetic, description
  only.)* Evidence: spec x-note on REV-01: "It is DESCRIPTION-ONLY: all live comparison
  logic and the Python decision map spell pending_review correctly."
- `finalize_verdict`'s emitted set is **not verifiable from these artifacts** (custom
  connector source not in export). *(AMBIGUOUS — Open Question Q1; ⚠ marker in the token
  table.)*

**C4 — Link TTL: one number, 7 days, recipe-set.** *(DOC ROT for the number; CODE BUG for
the dead output field)*
Evidence: spec x-note on UTL-01 and LNK-01: "expires_in is hardcoded to 604800 seconds
(7 days) on workato_files.create_shareable_link." The v1 body's "10-day FileStorage TTL"
under `sent` was never how the build landed; the TTL is a **recipe-supplied constant**, not
a platform constant. Doc corrected to 7 days in both mentions (`sent` state, reminder note).
Separately: UTL-01 declares `expires_at` ("Write-time + 7 days") but "the return_result
mapping for expires_at is an empty formula ('=') — the field is declared, never populated.
Callers must not rely on it." → listed as **CODE BUG** (populate or delete the field).

**C5 — Supplier verdict exposure: pilot intent violated by WFA-013.** *(CODE BUG — known
violation recorded in the pilot section; pilot intent NOT softened)*
Evidence: spec x-note on WFA-013--populate-results-table-supplier-facing: "Under the UPL-01
pilot ... this function still surfaces the raw validation verdict and row counts to the
supplier" (returns `RUN_ValidationResult.status`, `valid_row_count`, `invalid_row_count`
per upload). Remediation note added to the pilot section.

**C6 — Reminder layer: stated as accepted-but-unacted-on.** *(DOC ROT — status note on
foundational decision 3 and the `sent` state)*
Evidence: API-00/PRV-01 request schemas accept `reminder_days_1/2/3`; REM-02 computes
`reminders_needed` read-only (reads SUP_SupplierUser + RUN_Emails, writes nothing);
`last_reminder_tier` is stamped at row **creation** by REQ-01/SUP-02 `add_request`
(sets_columns lists include `last_reminder_tier`, `reminders_enabled`) — **not** by STS-01
(v49's single `update_record` writes exactly `status`, `supplier_display_status`,
`supplier_message`, `current_state_entered_at`; `last_reminder_tier` appears in STS-01's
JSON only inside read schemas). No sending workflow exists (Workflow 7 unbuilt).

**C7 — Invariant 1 gains a creation carve-out.** *(DOC ROT for the carve-out; CODE BUG for
one inconsistency)*
Evidence: spec x-request-write-paths — "REQ-01 and SUP-02 create the SUP_SupplierRequest
row (including .status) via add_request"; REQ-01's creation column set includes `status`,
`current_state_entered_at`, `supplier_display_status`, `supplier_message`; SUP-02's includes
the first three **but not `supplier_message`** *(CODE BUG — minor creation-surface
inconsistency)*. Corollary recorded: the `("" → pending, initial_creation)` legal-table row
is **unreachable inside STS-01** (steps 1–3 return `request_not_found` when the row is
absent) — creation is enforced by creator convention, not by the handler.

**C8 — "WFA stage is a derived view of status": partially implemented.** *(CODE BUG —
unimplemented locked design, backlogged)*
Evidence: STS-01 v49 contains **zero** `workato_workflow_task` actions (verified by grep);
stage writes live in REQ-01/SUP-02 (`add_request` sets `workflow_stage_id` at birth) and
INV-01A (`human_review_on_existing_record`); UPL-01's own step comments state the
`workflow_app_stage` tokens "do not correspond to the state machine." The locked 2026-06-10
projection design (assignment-bearing stages owned by INV-01A; terminal stages Approved/
Canceled written by STS-01 via `STATUS_TO_WFA_STAGE`) has its STS-01 half unbuilt.
See Open Question Q2.

**C9 — Pilot derivation-row wording re-synced to code.** *(DOC ROT)*
Evidence: live row `("pending_review", "system_validation_failed")` reads "Your submission
was received and validated on {validated_at}, and is under review." (addendum draft said
"...and is now under review"). Doc-first rule means the doc adopts the shipped wording to
close the drift.

**C10 — Date rendering added to derivation (IV-6 mechanism note).** *(DOC ROT)*
Evidence: STS-01 derivation step now renders `DATE_KEYS` (`due_date`, `validated_at`,
`reviewed_at`, `submitted_at`, `approved_at`) as "Month D, YYYY" via a locale-independent
formatter that degrades gracefully on unparseable input. Snapshot semantics unchanged;
recorded so wording edits keep placeholders date-typed.

**C11 — `cancelled` now has a positive precondition.** *(DOC ROT)*
Evidence: STS-01 v49 steps 20–22 enforce a field-level precondition for
`target_state = "cancelled"`; spec request schema: "cancellation_reason — Required when
target_state=cancelled." v1's "no positive precondition" line replaced.

**C12 — VAL-01 dead pilot shim flagged for deletion.** *(CODE BUG — hygiene)*
Evidence: VAL-01 step 41 ("TESTING: force all to supplier_upload, mark 'success'",
`force_manual_review`) is present with `skip=True`. It was the earlier, incorrect partial
implementation of the pilot (falsified the verdict instead of changing routing) and is now
superseded by the UPL-01 step 31 override. Recommend removal at source.

**C13 — Pilot dead-code note.** *(recorded, not a defect)*
Evidence: spec x-note on UPL-01: "Step 37's elsif branch (target_state ==
'supplier_action_required') is unreachable dead code while the pilot override is in place."
Consistent with the pilot design; revert re-activates it. Left in place deliberately.

---

## OPEN QUESTIONS (for the maintainer)

**Q1 — finalize_verdict's emitted trigger_context set. ⚠**
The connector source is not in the export, so the emitted set cannot be verified from these
artifacts. Two behaviors need source confirmation:
(a) *Structural/empty verdicts:* Option A (C2) assumes the connector normalizes them to
`system_validation_failed`. All recipe-side evidence supports this (no structural token
anywhere; a distinct token would hard-fail every structural submission at STS-01 as
`illegal_transition`, which would have been visible operationally) — but the definitive
proof is one look at the connector's mapping.
(b) *Failed resubmission from `supplier_action_required`:* the connector was designed with a
"display_refresh on repeat failure" branch. Under the pilot override that branch is a trap:
prior=`supplier_action_required` + emitted `display_refresh` + forced target=`pending_review`
yields the tuple `(supplier_action_required, pending_review, display_refresh)`, which is
**not** in the legal table — STS-01 refuses, and the submission stalls *after* the
RUN_Upload/denormalized writes have landed. This path is reachable during the pilot
(analyst rework → supplier resubmits → validation fails). Confirm the connector emits
`system_validation_failed` (not `display_refresh`) when the resting state is
`supplier_action_required`, or guard it in UPL-01.

**Q2 — Terminal-stage projection (STS-01 half of the locked option-B design).**
Was the STS-01 `STATUS_TO_WFA_STAGE` terminal-stage write (Approved/Canceled) dropped
deliberately, or is it unbuilt backlog? v49 shows no trace of it. Until answered, C8 sits in
the defect list as "unimplemented locked design."

**Q3 — Initial status literal at creation.**
REQ-01/SUP-02 stamp `.status` at `add_request`, but the literal value isn't visible in the
four supplied recipe JSONs or the spec's column lists. The doc assumes `pending` per the
`("" → pending, initial_creation)` row. Confirm against REQ-01's mapping (and whether the
PRV-04 → REQ-01 path ever births directly into `sent`).

**Q4 — Physical pruning of retired structural rows.**
Option A retirement survives a pilot revert (the normalization lives in the connector, and
the revert procedure touches only UPL-01 step 31 + STS-01's precondition + the pilot
derivation row). The retired rows below are therefore dead post-revert too. They are kept
struck-through for visibility per the reconciliation rules; say the word and they get
physically pruned in v2.1.

**Q0 — Source-text gaps.** Invariants 2–5, the deliberately-omitted list, and the
`pending_review`/`approved`/`cancelled` state prose could not be recovered verbatim (see
Provenance note). Restore those from your v1 copy; no reconciliation edits apply inside them
except where individually marked.

---
---

# The document

## Foundational decisions

Three answers shaped the state machine design:

1. **The audit chain carries the "why," the state machine carries the "what."** System-driven
   rework (failed validation) and analyst-driven rework (rejected submission) both land in the
   same state. The reason lives in ValidationResult/FieldError or ReviewNote, not in the state
   name. *(Temporarily widened by the pilot — see pilot section.)*
2. **Upload owns the in-flight pipeline; SupplierRequest tracks resting states only.** The
   `received → extracting → validating → validated|error` arc lives on Upload. SupplierRequest
   never transitions through `submitted` — it waits in `sent` or `supplier_action_required`
   until Upload completes and the resting situation changes.
3. **State knows nothing about reminders.** The state machine defines reminder *eligibility*.
   *Firing* — cadence, opt-out, per-supplier overrides, batched analyst-driven nudges — is a
   policy-layer decision inside the reminder workflow.
   > **Implementation status (amended 2026-07-02, C6).** The policy layer does not yet exist.
   > Current truth: provisioning (API-00 → PRV-01) *accepts and stores* `reminder_days_1/2/3`;
   > `reminders_enabled` and `last_reminder_tier` (default 0) are stamped at request creation
   > by REQ-01/SUP-02; REM-02 *computes* reminder eligibility read-only (surfaces
   > `reminders_needed`, sends nothing); no recipe fires reminders (Workflow 7 unbuilt). STS-01
   > touches no reminder field. Until Workflow 7 ships, this decision describes an interface,
   > not a behavior — configuration is accepted but unacted-on.

## Summary of changes from the prior model

**Removed:**
- `in_progress` (no behavior distinguished it from `sent`)
- `submitted` (Upload owns the in-flight pipeline)
- The two parallel tracking systems (`status_StateMachine` and WFA stages); WFA stage is now a
  derived view of `status`
  > **Implementation status (amended 2026-07-02, C8).** The projection is only partially
  > realized. Stage is written at birth by REQ-01/SUP-02 (`add_request`) and on assignment by
  > INV-01A; STS-01 v49 writes no stage, and the stage tokens in UPL-01's task calls are
  > documented in-recipe as "not corresponding to the state machine." The locked option-B
  > design (terminal stages owned by STS-01) is unbuilt — defect C8, Open Question Q2.
- `rejected` as a state (demoted to a transition, captured in ReviewNote)
- The `validated` / `pending_review` split (collapsed; validation passing and analyst
  notification co-occur) *(premise temporarily widened by the pilot)*

**Added:**
- `cancelled` as a single terminal-not-approved state covering pre-submission cancellation and
  post-engagement give-up
- Explicit derivation rule for `supplier_display_status` / `supplier_message`
- Reminder eligibility as a state-machine concern; reminder *firing* as a policy-layer concern

**Renamed:**
- `accepted` → `approved` (canonical)
- `data_entry` → `supplier_action_required` (canonical)
- `validation_success` → folded into `pending_review`
- `Upload.status: failed` → `error` (symmetry with ValidationResult; disambiguates from
  "validation found bad data")

**Net:** twelve candidate names (documented enum plus recipe-side drift) → six SupplierRequest
states.

---

## SupplierRequest — six states

For each state: when it's entered, what the system can do, what it cannot do.

### pending

*Entered when:* an analyst creates a SupplierRequest before commitment to invite — supplier
known but contact details missing, or campaign being staged for batch send.

*Can:* edit metadata, assign contacts, attach a variant, transition to `sent` or `cancelled`.
*Cannot:* accept submissions, run validation, surface to the supplier portal.
`template_file_id` not required.

> **Creation note (amended 2026-07-02, C7).** The row is born directly in this state by
> REQ-01 or SUP-02 via the WFA `add_request` action, which also stamps
> `current_state_entered_at` and the (empty) display fields. STS-01 cannot execute the
> `initial_creation` row itself — it requires an existing row — so birth-state correctness is
> a creator-recipe convention. SUP-02's creation column set omits `supplier_message` (REQ-01
> sets it); defect C7.

### sent

*Entered when:* the invitation has been issued and `template_file_id` is populated.

*Can:* accept an Upload, accept a ManualEntry, regenerate the template download link on the
**7-day link TTL** *(corrected 2026-07-02, C4 — the TTL is a recipe-set constant,
`expires_in = 604800` s, hardcoded identically in UTL-01 and LNK-01; it is not a FileStorage
platform constant; v1's "10-day" figure was never built)*, send reminders (per policy layer —
see foundational decision 3 status note).
*Cannot:* show analyst review pages — nothing to review yet.

### supplier_action_required

*Entered when:* a previous submission needs supplier remediation, regardless of cause —
system-driven via failed ValidationResult *(dormant during the pilot)*, or analyst-driven via
a ReviewNote with `review_action: rework` *(the only live entry during the pilot)*.

*Can:* accept resubmission (creates a new Upload), regenerate template link, send reminders
(per policy layer). Identical to `sent` from the supplier's side.
*Cannot:* display the same `supplier_message` as `sent` — see derivation rule.

### pending_review

`[TEXT NOT RECOVERED — restore from v1 copy]`
*(Definition under the pilot, per the addendum: entered when `current_validation_result_id`
points at a ValidationResult with `status ∈ {passed, failed}` — "validation completed, analyst
owes the decision." Phase 0 definition — `status = passed` only — resumes on revert.)*

### approved

`[TEXT NOT RECOVERED — restore from v1 copy]`
*(Terminal. Field-level precondition in code: `approved_at` and `approved_path` present —
both written by REV-01 via WFA `update_request` before it calls STS-01.)*

### cancelled

`[TEXT NOT RECOVERED — restore from v1 copy]`
> **Amended 2026-07-02 (C11).** `cancelled` now carries a positive field-level precondition:
> `cancellation_reason` is required when `target_state = cancelled` (enforced at STS-01
> steps 20–22; declared required in the request schema). v1's "no positive precondition" line
> is superseded.

---

## Transition graph

Source of truth for STS-01's `LEGAL_TRANSITIONS`; the table below is verbatim-synced to
STS-01 v49 (last synced 2026-07-02). `approved` and `cancelled` are terminal — no outbound
transitions. Pilot status per the pilot section; dormant rows are retained by design.

| From | To | Trigger context | Status |
|---|---|---|---|
| *(no row)* | pending | initial_creation | active — enforced by creator convention (see C7) |
| pending | sent | invitation_issued | active |
| pending | cancelled | analyst_cancel | active |
| sent | pending_review | system_validation_passed | active |
| sent | pending_review | system_validation_failed | **active — pilot row** |
| sent | supplier_action_required | system_validation_failed | **dormant** (pilot; system no longer auto-bounces) |
| sent | cancelled | analyst_cancel | active |
| supplier_action_required | pending_review | system_validation_passed | active |
| supplier_action_required | pending_review | system_validation_failed | **active — pilot row** |
| supplier_action_required | supplier_action_required | display_refresh (no-op, IV-7) | **dormant** (pilot; see Invariant 7 note) |
| supplier_action_required | cancelled | analyst_cancel | active |
| pending_review | approved | analyst_approve | active |
| pending_review | supplier_action_required | analyst_rework | active |
| pending_review | cancelled | analyst_cancel | active |

Field-level preconditions gate each edge before the write: `template_path` before `sent`; a
`current_validation_result_id` pointing at a ValidationResult with `status ∈ {passed, failed}`
before `pending_review` *(pilot-widened; Phase 0: `passed` only)*; `approved_at` +
`approved_path` before `approved`; `cancellation_reason` before `cancelled` (C11).

## Trigger-context tokens *(section consolidated 2026-07-02, C3)*

The canonical closed set, as accepted by STS-01 v49's live legal table:

`initial_creation · invitation_issued · system_validation_passed · system_validation_failed ·
analyst_rework · analyst_approve · analyst_cancel · display_refresh`

Emitter inventory:

| Emitter | Tokens emitted | Agreement |
|---|---|---|
| Creator convention (REQ-01/SUP-02) | initial_creation (nominal — birth write bypasses STS-01) | ✓ (see C7) |
| INV-01 | invitation_issued | ✓ |
| REV-01 `DECISION_MAP` | analyst_approve, analyst_rework | ✓ (verbatim in code) |
| Cancellation caller | analyst_cancel | ✓ |
| `finalize_verdict` (connector) | system_validation_passed, system_validation_failed, display_refresh *(designed set)* | ⚠ **unverifiable from artifacts — Open Question Q1**, including the pilot-era `display_refresh` trap on failed resubmission from `supplier_action_required` |

Known token-surface defects (cosmetic, live logic clean): STS-01's declared parameter hint
omits `initial_creation`; REV-01's result-schema hints carry the `pending_reivew` typo
(19 occurrences) plus one in WFA-006 — fix at source (C3).

Removed from the doc's vocabulary (2026-07-02):
- ~~`pipeline_error_alert`~~ — never implemented. Pipeline-error verdicts abort in UPL-01 at
  the `is_error` gate *before* STS-01, with an OBS-01 `recipe_failed` event; state and display
  fields are untouched. There is no error-driven display refresh (C3, DOC ROT).
- ~~`system_structural_failure`~~ — Option A resolution (C2); see pilot section.

---

## Display derivation (`supplier_display_status` / `supplier_message`)

When the handler fires, it computes both fields from `(target_state, trigger_context)` plus a
small bag of context fields, and stores them as **literal strings** — snapshot semantics, no
runtime templating in the WFA (Invariant 6). Wording changes are handler-recipe code changes,
not data migrations. Verbatim-synced to STS-01 v49 (last synced 2026-07-02).

> **Mechanism note (added 2026-07-02, C10).** Date-typed context keys (`due_date`,
> `validated_at`, `reviewed_at`, `submitted_at`, `approved_at`) are rendered as
> "Month D, YYYY" by a locale-independent formatter before substitution; unparseable values
> pass through unchanged. Keep placeholders in these templates date-typed.

| Target state | Trigger context | supplier_display_status | supplier_message | Status |
|---|---|---|---|---|
| pending | initial_creation | *(empty)* | *(empty)* | active |
| sent | invitation_issued | Action needed: complete and submit template | Please complete the attached template and submit by {due_date}. | active |
| supplier_action_required | system_validation_failed | Action needed: corrections required | Validation found {invalid_row_count} issue(s) in your submission on {validated_at}. Please review the validation notes and resubmit. | **dormant** (pilot) |
| supplier_action_required | display_refresh | *(same wording as row above — same row, different trigger; IV-7 no-op)* | | **dormant** (pilot) |
| supplier_action_required | analyst_rework | Action needed: changes requested by reviewer | The reviewer requested changes on {reviewed_at}. Please review and resubmit. | active — only live entry to this state during the pilot |
| pending_review | system_validation_passed | Submitted: under review | Your submission was received on {submitted_at} and is being reviewed. No further action is needed at this time. | active |
| pending_review | system_validation_failed | Submitted: under review | Your submission was received and validated on {validated_at}, and is under review. No further action is needed at this time. | **active — pilot row** *(wording re-synced to code 2026-07-02, C9)* |
| approved | analyst_approve | Approved | Your submission was approved on {approved_at}. Thank you. | active |
| cancelled | analyst_cancel | Request closed | This request has been closed. Please contact {analyst_email} with questions. | active |
| ~~supplier_action_required~~ | ~~system_structural_failure~~ | ~~(structural-failure wording)~~ | | **retired 2026-07-02** — Option A (C2); token no longer exists in the pipeline and survives pilot revert (Q4) |
| ~~(any)~~ | ~~pipeline_error_alert~~ | ~~(pipeline-error wording)~~ | | **retired 2026-07-02** — never implemented; errors abort pre-STS-01 (C3) |

Context keys carried by the handler: `due_date`, `invalid_row_count`, `validated_at`,
`validation_report_link`, `review_note_text`, `reviewed_at`, `submitted_at`, `approved_at`,
`analyst_email`. (`validation_report_link` and `review_note_text` are gathered but unused by
any live template — retained for revert/wording headroom.)

---

## Subsidiary machines

### Upload — five states

`received` → `extracting` → `validating` → `validated`, with `error` as an off-ramp from
`extracting` or `validating`.

- `received`. Entered on submission intake. Can: transition to `extracting`.
- `extracting`. Can: transition to `validating` or `error`. Cannot: accept further
  submissions against this Upload row; resubmission creates a new Upload.
- `validating`. Entered when extraction completed cleanly and validation begins. Can:
  transition to `validated` regardless of pass/fail outcome, or to `error` on a pipeline
  error. Cannot: produce a verdict — that's ValidationResult's job.
- `validated`. **Terminal-success.** Entered when validation completed and produced a
  ValidationResult row. Cannot transition further.
  > Important: `validated` does **not** mean the data was good. It means the pipeline ran to
  > completion and a ValidationResult exists. Bad-data outcomes are `validated` Uploads with
  > `failed` ValidationResults.
- `error`. **Terminal-pipeline-error.** (Renamed from `failed` for symmetry with
  ValidationResult and to disambiguate from "validation found bad data.") Entered when
  extraction or validation pipeline crashed. A new Upload is required for retry.

### ValidationResult — four states

- `running`. Entered when validation begins (same recipe step that flips Upload to
  `validating`). Can: write FieldError rows as validation runs. Cannot: be consumed by
  SupplierRequest yet — the verdict isn't in.
- `passed`. **Terminal-success.** Zero FieldError rows. Drives SupplierRequest to
  `pending_review`.
- `failed`. **Terminal-success-with-bad-data.** One or more FieldError rows. Phase 0: drives
  SupplierRequest to `supplier_action_required`; pilot: drives it to `pending_review`.
  *Distinct from Upload's `error`* — this is "validation worked correctly and found problems."
  > **Amended 2026-07-02 (C2).** The connector's five-value verdict
  > (`passed | failed | empty | structural_failure | error`) is collapsed **on write** to this
  > three-value column: `passed → passed`, `error → error`, everything else — including
  > `structural_failure` and `empty` — `→ failed`. This is the persistence half of Option A.
- `error`. **Terminal-pipeline-error.** The validation engine itself failed before producing a
  verdict. In normal operation, `error` on ValidationResult and `error` on Upload coexist.

The terminology pair is consistent across both tables: `error` means "the pipeline crashed";
bad-data outcomes are surfaced via `failed` on ValidationResult only, where the distinction
matters.

### TemplateVersion — three states

- `draft`. Entered on creation by the analyst's config submission. Can: edit Field, Lookup,
  ValidationRule, Variant, VariantField, FormSlotMapping, ErrorMessage rows scoped to this
  version. Cannot: accept SupplierRequest rows pointing at this version.
- `published`. Entered when the analyst publishes; snapshot semantics lock in. Can: be
  referenced by `assigned_version_id`. Cannot: edit any version-scoped config row, ever.
  > Forward-only: there is no `published → draft` path. Typo fixes flow through new draft
  > versions. This is the snapshot semantics invariant restated.
- `deprecated`. Terminal.

### Three binary machines

`SupplierUser.status`, `Supplier` active flag, and `Project.project_completion_status`
(`active | inactive`) — one boolean field each, two states, one trigger (an analyst toggling
it). Real states in the data model; no transitions worth diagramming.

---

## Invariants

**Invariant 1 — Single-writer rule.** STS-01 is the only recipe that writes `status`,
`supplier_display_status`, `supplier_message`, and `current_state_entered_at` on
`SUP_SupplierRequest`. Drift between these four fields is impossible by construction *if and
only if* STS-01 is genuinely the single writer. The highest-leverage invariant in the system.
> **Creation carve-out (amended 2026-07-02, C7).** Row **birth** is the sanctioned exception:
> REQ-01 and SUP-02 stamp all four fields (SUP-02 currently omits `supplier_message` — defect
> C7) via the WFA `add_request` action, because STS-01 requires an existing row. The invariant
> is therefore "single writer **post-creation**"; the `initial_creation` legal-table row
> documents the convention rather than a path STS-01 can execute. All other
> SUP_SupplierRequest writers in the current export (UPL-01, VAL-01, INC-02, REV-01's
> `update_request`) touch only non-protected columns — verified 2026-07-02.

**Invariants 2–5.** `[TEXT NOT RECOVERED — restore from v1 copy]`

**Invariant 6 — Snapshot semantics for display fields.** `supplier_display_status` and
`supplier_message` are literal strings stamped at handler write time. The WFA does not
template at render. Wording changes are recipe-code changes, not data migrations. *(Mechanism
addendum: date rendering, C10.)*

**Invariant 7 — Repeated failures don't churn state.** A repeated validation failure in
`supplier_action_required` is a display-refresh no-op, not a transition: the resting situation
(supplier owes corrections) hasn't changed, so the state doesn't move. *(Dormant during the
pilot — see pilot section; not violated, untriggered.)*

---

## Deliberately omitted

`[TEXT NOT RECOVERED — restore from v1 copy]`
*(No reconciliation edits apply to this section.)*

---

## Pilot deviation — analyst decision point after validation

**Status:** **LIVE in production as of the 2026-07-02 export** *(confirmed 2026-07-02, C1;
evidence: UPL-01 v121 step 31 literal override, spec x-note "PILOT OVERRIDE IS LIVE").*
Scoped override of the locked Phase 0 routing for validation outcomes; the Phase 0 body above
is unchanged and remains authoritative for post-pilot. Revert criteria at the end of this
section. *Added 2026-06-10; reconciled 2026-07-02.*

### Intent

During the pilot the system no longer decides pass/fail routing. Every submission that
produces a ValidationResult — `passed` or `failed` — routes to `pending_review`, where the
analyst reviews the validation result *and* the supplier input and actions it as
**(a) approve** or **(b) rework**. The supplier sees the same neutral "under review" message
either way and is not shown the system verdict.

### The single redefinition this rests on

`pending_review` changes from *"validation passed, analyst owes a decision"* to *"validation
completed (passed **or** failed), analyst owes the decision."* Every override below is a
consequence of that one change.

### Overrides

**`pending_review` — entry condition.** Phase 0: entered when `current_validation_result_id`
points at a ValidationResult with `status = passed`. Pilot: `status ∈ {passed, failed}`
(`error` and `running` remain excluded). *Implemented: STS-01 v49 step 15 admits passed or
failed — verified 2026-07-02.*

**Field-level precondition (`pending_review`).** Same widening; rejects only
`error`/`running`/absent. *Implemented.*

**Transition table.** Pilot rows active, Phase 0 system-bounce rows dormant — see the Status
column in the transition graph above. Dormant rows stay in the tables — not deleted. Revert
re-activates them by reverting the orchestrator override (**UPL-01 step 31** — step number
corrected 2026-07-02 from the addendum's "step 23"; numbering drifted between exports).

**Derivation table.** One pilot row, `(pending_review, system_validation_failed)` → the
neutral "under review" message (wording per code, C9). The
`supplier_action_required / system_validation_failed` and `/ display_refresh` rows are
dormant; `supplier_action_required / analyst_rework` is the only live entry to that state
during the pilot.

### Invariant 7 — dormant, not violated

The no-op self-transition existed because a repeated system failure did not change the resting
situation (the supplier still owed corrections). In the pilot the system never bounces
failures back to the supplier, so that scenario does not arise: a completed resubmission
always changes the resting situation (the supplier has acted; the analyst now owes a
decision), so it legitimately transitions to `pending_review`. The "state moves only when the
resting situation changes" principle is upheld — the no-op is simply never triggered. Restore
to active behavior on revert.
> ⚠ **Caveat (2026-07-02):** whether the *connector* also honors this depends on
> `finalize_verdict`'s repeat-failure branch — Open Question Q1(b).

### Structural failures — RESOLVED: Option A (recorded 2026-07-02, C2)

*Phase 0 posed:* (A) normalize structural failures to `system_validation_failed`, or
(B) keep a distinct `system_structural_failure` trigger and derivation row.

*Resolution:* **Option A won, in code.** VAL-01 collapses `structural_failure` (and `empty`)
to `failed` on the RUN_ValidationResult write; no structural token exists anywhere in the
58-recipe export; STS-01's live tables carry no structural row. Structural failures ride into
`pending_review` alongside content failures; the supplier sees the neutral "under review"
message; the analyst gets the structural detail from the audit chain (the ValidationResult /
report — "the audit chain carries the why"). The Option-B derivation rows are retired (kept
struck in the derivation table; physical pruning pending Q4). Residual verification of the
connector's own mapping: Q1(a). Note this resolution lives in the **connector and VAL-01**,
not in the UPL-01 override, so it **survives a pilot revert**.

### Known violation — supplier-facing verdict exposure (recorded 2026-07-02, C5)

The pilot's stated intent — *the supplier is not shown the system verdict* — is currently
violated by **WFA-013 (populate results table, supplier-facing)**: per RUN_Upload row it
returns the raw `RUN_ValidationResult.status` (`passed`/`failed`/`error`), plus
`valid_row_count` and `invalid_row_count`, directly to the supplier portal. The intent stands;
the leak is a defect, not a design change.
**Remediation:** WFA-013 should surface the request's `supplier_display_status` (the derived
snapshot STS-01 already maintains for exactly this purpose) instead of the raw verdict, and
suppress row counts while the pilot's neutral-message policy is in force. One recipe edit; no
schema change.

### Tension with locked Phase 0 decisions (recorded, not resolved)

- Foundational decision #1 (system-driven and analyst-driven rework land in the same state)
  and the collapse of `validated` into `pending_review` (premised on "validation passing and
  analyst notification co-occur") are **temporarily widened**: analyst notification now occurs
  on validation *completion*, pass or fail. The premise resumes on revert.
- During the pilot, `supplier_action_required` has a single live entry path (analyst rework);
  its system-failed entry is dormant. The "one state, two entry paths" justification stays
  intact for when the system path re-activates.

These are scoped, reversible deviations. The Phase 0 body remains authoritative for
post-pilot.

### Revert criteria

Revert when the pilot ends, or promote to permanent if the analyst decision point is adopted.
To revert: restore the orchestrator (**UPL-01 step 31**) to route by verdict — which
re-activates the dormant transition rows and restores Invariant 7 — and remove the new
derivation row and the precondition widening from STS-01. No data migration is required
(display fields are snapshots, not derived at render). **Note (2026-07-02):** the Option A
structural normalization and the WFA-013 fix (C5) are independent of the revert and persist
either way. UPL-01's `supplier_action_required` elsif branch (currently dead, C13)
re-activates on revert.

---

## Defect list (CODE BUGs carried out of this reconciliation)

| # | Where | Defect | Severity |
|---|---|---|---|
| C3a | STS-01 declared param hint | `initial_creation` missing from trigger_context hint enum | cosmetic |
| C3b | REV-01 (19×), WFA-006 (1×) | `pending_reivew` typo in result-schema hints; live logic clean | cosmetic |
| C4 | UTL-01 | `expires_at` declared, never populated (empty formula); callers must not rely on it — populate or delete | low |
| C5 | WFA-013 (supplier-facing) | Raw verdict + row counts exposed to supplier; violates pilot intent — see remediation above | **high (pilot)** |
| C7 | SUP-02 | Creation column set omits `supplier_message` (REQ-01 sets it) | low |
| C8 | STS-01 | Terminal-stage WFA projection (locked option-B design) unimplemented | medium — or reclassify per Q2 |
| C12 | VAL-01 step 41 | Dead `force_manual_review` shim (`skip=True`), superseded by UPL-01 override — delete | hygiene |
| Q1(b) | finalize_verdict | *Potential* pilot-era `display_refresh` trap on failed resubmission from `supplier_action_required` — verify before it bites | **verify first** |
