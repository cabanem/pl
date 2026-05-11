# SDC Data Collection — Event Log Phase Taxonomy (v1, Stage 1)

## Status

Stage 1 sub-artifact. Companion to `sdc-workflow-stages-v1.md`. Settles ADR-058 ("phase taxonomy is canonical and shared") with an actual list. Required before OBS-01 ships, since OBS-01 validates `phase` against this list.

This is an extraction, not a design pass. Each phase identifier corresponds to a specific stage in the workflow stages doc that warrants an event. Where the workflow stages doc is the prose, this doc is the short-token form.

## Principle

**One phase per system-side workflow stage that warrants an event.** Not every workflow stage is system-side (some are analyst actions outside the system) and not every system-side stage warrants an event (purely internal computation with no business meaning to log). The phases below are the intersection.

**Severity disambiguates outcome.** A stage with two outcomes (pass/fail validation, success/error export) gets one phase per outcome where the routing differs, but reuses the same phase across recipes when the lifecycle moment is shared. Example: R2 and R3 both emit `submission_received` — same moment, different upstream mechanics, distinguished by `source_recipe`.

**State transitions are cross-cutting, not workflow-specific.** STS-01 emits `state_transition` on every state change, with `details_json` carrying `from_state`, `to_state`, `trigger_context`. Workflows don't emit per-transition phases (no `pending_to_sent`, no `sent_to_pending_review`); the transition itself is the cross-cutting event.

## Format conventions

- **Past-tense, snake_case.** `version_published`, not `version_publication` or `publishing_version`.
- **Stable across recipe edits.** Names describe business outcomes, not recipe steps. `config_validated` is durable; `step_22_complete` is fragile.
- **Reads naturally in three contexts.** As a column value (`WHERE phase = 'config_validated'`), as a UI label ("Config validated"), as a sentence fragment ("project Acme reached `config_validated` at 9:03").

---

## Engagement-scope phases

### E1 — Initial provisioning

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `provisioning_triggered` | E1 stage 2 | info | First system-side event in the workflow |
| `config_parsed` | E1 stage 3 | info | |
| `config_validated` | E1 stage 4 (pass) | info | |
| `config_rejected` | E1 stage 4 (fail) | warn | Workflow stops; analyst sees errors |
| `project_recorded` | E1 stage 5 | info | |
| `version_published` | E1 stage 6 | info | |
| `template_built` | E1 stage 7 | info | One emit per variant template built |
| `incumbent_data_seeded` | E1 stage 7/8 (conditional) | info | Only when `Project.seeded_data_path` is set |
| `suppliers_staged` | E1 stage 8 | info | |
| `provisioning_complete` | E1 stage 9 | info | Terminal milestone for the workflow |

### E2 — Config update / re-publish

Reuses E1's phases for the shared portion. Adds:

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `version_deprecated` | E2 stage 5 | info | Emitted when the prior version is marked deprecated |

`provisioning_triggered`, `config_parsed`, `config_validated` / `config_rejected`, `version_published`, and `provisioning_complete` are shared with E1. `source_recipe` distinguishes E2 from E1 in queries.

### E3 — Engagement closure

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `engagement_closed` | E3 stage 2 | info | Project flag flipped to inactive |

---

## Request-scope phases

### R1 — Issue invitation

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `invitation_triggered` | R1 stage 2 | info | One per analyst batch action |
| `invitation_sent` | R1 stage 5 | info | One per supplier user emailed; `details_json` carries the recipient |

R1 stage 4 (state move from `pending` → `sent`) emits `state_transition` from STS-01, not a workflow-specific phase.

### R2 — File submission

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `submission_received` | R2 stage 1 | info | Shared with R3; `source_recipe` distinguishes |
| `upload_extracted` | R2 stage 3 | info | R2-only; no analog in R3 |
| `validation_passed` | R2 stage 4 (pass) | info | |
| `validation_failed` | R2 stage 4 (fail) | info | "Validation worked, found problems" — not an incident |
| `validation_errored` | R2 stage 4 (pipeline error) | error | "Validation engine itself crashed" — distinct from `validation_failed` |
| `resubmission_template_generated` | R2 stage 5 (fail branch) | info | When UPL-02 produces a pre-populated template after failure |

R2 stage 5 routing is `state_transition` from STS-01.

### R3 — Manual-entry submission

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `submission_received` | R3 stage 3 | info | Shared with R2 |
| `validation_passed` / `validation_failed` / `validation_errored` | R3 stage 4 | (as R2) | Shared with R2 |

No `upload_extracted` (no XLSX parsing). Per-row save events during stages 1–2 are not emitted — too granular for the workflow-stage principle.

### R4 — Reminder cycle

| Phase | Workflow stage | Severity | Notes |
|---|---|---|---|
| `reminder_cycle_triggered` | R4 stage 1 | info | One per schedule fire |
| `reminder_sent` | R4 stage 4 | info | One per supplier user reminded; `details_json` carries the tier |
| `reminder_tier_exhausted` | (post-tier-3, deferred) | warn | Pending decision on post-tier-3 behavior |

### R5 — Analyst review

No workflow-specific phases. The analyst's decision IS a state transition: Approve → `state_transition` with `trigger_context=analyst_approve`; Reject → `state_transition` with `trigger_context=analyst_rework`. The ReviewNote write is captured in `details_json` of the `state_transition` event.

### R6 — Cancellation

No workflow-specific phases. Cancellation is a state transition: `state_transition` with `trigger_context=analyst_cancel`. Per invariant 5 of the state-machine doc, the cancellation reason is captured in `details_json` of the `state_transition` event — that satisfies "all cancellation reasons route to EventLog."

---

## Invite-cluster sibling phases

These three siblings of R1 (per the build queue's Stage 7) aren't workflows in the workflow-stages doc, but they're real recipes that will emit events.

| Phase | Recipe | Severity | Notes |
|---|---|---|---|
| `outreach_refreshed` | Refresh outreach | info | Re-sends invitation email with fresh link; no state change |
| `user_added_to_request` | Add user to request | info | New supplier user attached to an existing request |
| `request_reassigned` | Reassign request | info | Platform task reassigned to a new analyst |

---

## Output-scope phases

### X1 — Export to target system

**Deferred.** X1 is out of scope for the current build queue and needs its own design pass. The phases below are proposed placeholders to keep them in mind, not committed.

| Phase (proposed) | Workflow stage | Severity | Notes |
|---|---|---|---|
| `export_triggered` | X1 stage 1 | info | Pending X1 design |
| `export_assembled` | X1 stage 3 | info | Pending X1 design |
| `export_completed` | X1 stage 4 (success) | info | Pending X1 design |
| `export_failed` | X1 stage 4 (failure) | error | Pending X1 design |

These should be revisited and locked when X1 is designed; treat them as a sketch, not a contract.

---

## Cross-cutting phases

These are emitted from many recipes, not tied to a single workflow.

| Phase | Source | Severity | Notes |
|---|---|---|---|
| `state_transition` | STS-01 | info | Every state change. `details_json` carries `from_state`, `to_state`, `trigger_context`, and (for cancellations) `cancellation_reason` |
| `recipe_failed` | Any recipe's error handler | error | Recipe crashed before reaching a more specific phase. The catch-all for unanticipated failures |

`recipe_failed` is deliberately the only generic error phase. Specific known failure modes (`config_rejected`, `validation_errored`, `export_failed`) have their own phases. The principle: known failures get specific phases; unknown failures land in `recipe_failed`. Emit `recipe_failed` only when no more specific phase fits.

---

## The full canonical list

For OBS-01's input validation. Alphabetical, with X1 phases marked as deferred.

```
config_parsed
config_rejected
config_validated
engagement_closed
incumbent_data_seeded
invitation_sent
invitation_triggered
outreach_refreshed
project_recorded
provisioning_complete
provisioning_triggered
recipe_failed
reminder_cycle_triggered
reminder_sent
reminder_tier_exhausted
request_reassigned
resubmission_template_generated
state_transition
submission_received
suppliers_staged
template_built
upload_extracted
user_added_to_request
validation_errored
validation_failed
validation_passed
version_deprecated
version_published

# Deferred — X1 export workflow
# export_assembled
# export_completed
# export_failed
# export_triggered
```

Twenty-eight committed phases plus four deferred. OBS-01's validation enum loads the committed list; X1 phases get added when X1 is designed.

---

## Open questions

1. **Build-queue "Stage" overload.** The build queue uses "Stage 0" through "Stage 9" for the construction sequence. That's a third use of "stage" beyond workflow stages and the (now-resolved) phase/stage collapse. Worth renaming the build queue's stages to "milestones" or "rounds" to free up "stage" for the workflow-stages meaning. Cosmetic; doesn't block this taxonomy.

2. **EventLog column rename.** If "stage" is the canonical word for "lifecycle moment within a workflow," then `EventLog.phase` is misnamed and should be `EventLog.stage`. Stage 0 just closed, so this would be a Stage 0 amendment. Either commit the rename now (one column rename, recipes haven't started reading it yet) or leave it as `phase` and accept the terminology friction. Worth deciding before OBS-01 ships, since OBS-01's input parameter name follows the column name.

3. **Adding-a-new-phase discipline.** Consistent with ADR-058, new phases should be added deliberately, not ad-hoc. Recommend: a new phase requires a one-sentence rationale appended to this doc (which workflow stage it represents, why it's emit-worthy) and a corresponding ADR amendment if the rationale is non-obvious. Belt-and-suspenders for keeping the vocabulary tight.

4. **Per-workflow phase vs. per-recipe phase.** Some workflows are implemented by multiple recipes (E1 spans PRV-01 through PRV-04 or similar). The phase identifier marks the workflow stage, not the recipe boundary. `source_recipe` carries the recipe identity; the phase carries the lifecycle meaning. This is a feature of the design — query-by-phase aggregates across recipes naturally — but it means recipe boundaries are invisible in the phase list. Worth flagging if dashboards ever need recipe-level granularity.

---

## Pending in Stage 1

- OBS-01 input validation reads from "the full canonical list" above. Implementation note: load as a hardcoded array in OBS-01's input-validation step. New phases require an OBS-01 edit, which is the discipline ADR-058 calls for.
- The decision on EventLog column rename (open question 2) before OBS-01's parameter name is locked.
