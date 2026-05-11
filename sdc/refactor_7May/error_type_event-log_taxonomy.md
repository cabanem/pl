# SDC Data Collection — Event Log Error Type Taxonomy (v1, Stage 1)

## Status

Stage 1 sub-artifact. Companion to `sdc-event-phase-taxonomy.md`. Settles the gap flagged in the repository catalog: `EventLog.error_type` is documented as a "categorical error classifier" but has no controlled vocabulary, and without one recipes will write `"network"` / `"network_error"` / `"NETWORK"` / `"transient_network"` and fragment the column.

This document settles the vocabulary. It is **derived from principles and the design system as it stands today** rather than from a complete survey of every recipe's failure modes — many of those recipes aren't built yet. The structure is intended to absorb new entries gracefully as recipes are built; the discipline for adding them is named in Section 7.

Required before any recipe that emits an `error_type` ships. VAL-01 is the first such recipe; STS-01 is the second.

## Principle

**One `error_type` per category of failure that warrants distinct downstream handling.** "Distinct downstream handling" means: a debugger filtering EventLog by `error_type` to investigate a class of problem, or a future alert-routing capability deciding what to do based on the category.

The vocabulary is deliberately tight. Too many values fragments the column; too few makes it useless because everything lands in `other`. The working bound is roughly 10–15. Adding a value requires the rationale named in Section 7.

**`error_type` categorizes unintended outcomes.** It is not used to capture reasons for *intended* actions. A cancellation is an intentional analyst decision and emits at severity `info` with the reason in `details_json`, not in `error_type`. A failed validation is an unintended outcome (the supplier intended their submission to pass) and emits with `error_type` describing the category.

**`error_type` is scoped by phase.** Not every value is valid in every phase. Section 5 lists the matrix; OBS-01 enforces it.

## Format conventions

- **Noun phrases, snake_case.** `recipe_invariant`, not `recipe_invariant_violation` and not `RecipeInvariant`. The value names a *kind of thing*, not the act of it failing.
- **Stable across recipe edits.** Names describe categories of failure, not specific failure modes. `external_action_failed` is durable; `connector_action_500_status_code` is fragile.
- **Reads naturally in three contexts.** As a column value (`WHERE error_type = 'submission_content_invalid'`), as an alert rule predicate, as a sentence fragment ("the run failed with `recipe_invariant` because the upload row was missing").

## Severity scope

`error_type` is populated whenever the emit represents a non-success outcome, regardless of severity. That includes:

- **severity `error`** — pipeline failures (the recipe couldn't complete its work).
- **severity `warn`** — non-success outcomes that are recoverable or expected (the supplier sent a bad file; a soft validation rule failed).
- **severity `info`** — non-success outcomes that are routine (`validation_failed` at info severity is the canonical example — the validation engine ran correctly and found problems).

`error_type` is **not** populated on success emits or intentional-action emits:

- Success emits (`validation_passed`, `invitation_sent`, `version_published`, `state_transition` on successful transitions) carry no `error_type`.
- Intentional analyst actions logged at severity `info` (cancellations via `state_transition`, approvals via `state_transition`) carry no `error_type`. The reason for the action lives in `details_json`.

---

## The taxonomy

Eleven values, grouped by category.

### Pipeline failures

The recipe itself couldn't complete its work. Severity is almost always `error`.

| Value | Use when |
|---|---|
| `recipe_invariant` | A precondition that should always hold was violated. Examples: an upload row referenced in the trigger doesn't exist; a canonical model file is missing from FileStorage; STS-01 receives a target_state that isn't reachable from the current state; the single-writer rule was violated. The defining feature: *if the system were in a correct state, this couldn't happen*. The fix is upstream, not retry. |
| `external_action_failed` | A connector action or external service call returned an error or timed out. Examples: a Workato connector action raised; FileStorage read/write failed; a Data Tables search timed out; an email send was rejected. The defining feature: the failure is at the boundary with another system, not in our logic. |
| `unexpected_error` | A Python step crashed, a pill was malformed, a type coercion failed, or any other case where the recipe encountered an exception it didn't anticipate. The catch-all for "code threw and we didn't expect it." Useful when emitting from a recipe's outermost error handler. |

### Submission failures

The supplier's submission caused a non-success outcome. Severity is typically `warn` (for structural problems that block validation) or `info` (for content problems the engine found).

| Value | Use when |
|---|---|
| `submission_unparseable` | The submitted file couldn't be opened at all. Bad XLSX, corrupt zip, wrong file format. The supplier's submission didn't reach the validation engine. |
| `submission_structurally_invalid` | The submitted file was parseable but didn't match the expected structure. Missing required sheet, header row doesn't match canonical model, expected columns absent. The validation engine could open the file but couldn't reason about its contents. |
| `submission_empty` | The submitted file was well-structured but contained zero data rows. The validation engine ran on an empty input and the empty-submission gate fired. |
| `submission_content_invalid` | The validation engine ran successfully and found content errors. Per-field validation failures, cross-field rule failures, lookup mismatches. The supplier's data didn't conform to the configuration. |

### Config failures

The analyst's configuration caused a non-success outcome at provisioning time. Severity is typically `warn`.

| Value | Use when |
|---|---|
| `config_unparseable` | The configuration workbook couldn't be parsed. Required sheets missing, malformed sheet data, the GAS export was incomplete. Configuration didn't reach the validator. |
| `config_invalid` | Configuration parsed but failed validation. Referential integrity issues, constraint violations, missing required entities. Analogous to `submission_content_invalid` but for the analyst's configuration rather than supplier's data. |

### Workflow failures

The orchestration tried to do something inconsistent with the system's current state. Severity is typically `error`.

| Value | Use when |
|---|---|
| `state_inconsistent` | The system attempted an action that doesn't fit the current state. Examples: trying to validate against a deprecated version; trying to invite a supplier whose user list is empty; trying to generate a resubmission template for a request that's never been submitted to. Related to but distinct from `recipe_invariant` — `state_inconsistent` means *the state is fine, the requested action doesn't match it*, where `recipe_invariant` means *the state itself is broken*. |

### External dependency failures

A system we depend on is unavailable in a way that's not a single-action failure. Severity is `error`.

| Value | Use when |
|---|---|
| `external_dependency_unavailable` | A whole external system is down or unreachable, not a single call that failed. Examples: Workato Data Tables returning sustained errors across multiple attempts; FileStorage rejecting all requests; the mail service unavailable for a recipe run. Distinct from `external_action_failed`: that's a single-call failure (which may be transient and retryable), this is a system-wide outage. |

---

## Phase × error_type matrix

`error_type` validity depends on the emitting phase. OBS-01 enforces this — an emit with an incompatible phase + error_type combination is rejected.

The matrix below names the rule for each phase. The default rule: failure-shaped phases require `error_type`; success-shaped phases forbid it.

### Phases that **forbid** `error_type`

These emit at severity `info` and represent a successful outcome or an intentional action. `error_type` must be absent.

```
config_parsed
config_validated
engagement_closed
incumbent_data_seeded
invitation_sent
invitation_triggered
outreach_refreshed
project_recorded
provisioning_complete
provisioning_triggered
reminder_cycle_triggered
reminder_sent
request_reassigned
resubmission_template_generated
state_transition
submission_received
suppliers_staged
template_built
upload_extracted
user_added_to_request
validation_passed
version_deprecated
version_published
```

### Phases that **require** `error_type`

These represent non-success outcomes. `error_type` must be present and valid.

| Phase | Allowed `error_type` values |
|---|---|
| `config_rejected` | `config_unparseable`, `config_invalid` |
| `validation_failed` | `submission_unparseable`, `submission_structurally_invalid`, `submission_empty`, `submission_content_invalid` |
| `validation_errored` | `recipe_invariant`, `external_action_failed`, `unexpected_error`, `external_dependency_unavailable` |
| `reminder_tier_exhausted` | (deferred — pending post-tier-3 design) |
| `recipe_failed` | Any value. `recipe_failed` is the catch-all; it pairs with whichever `error_type` fits. Most commonly `recipe_invariant`, `external_action_failed`, or `unexpected_error`. |

### A worked example: STS-01

STS-01 emits exactly two phases:

- **`state_transition`** — emitted on every successful state transition and on display-refresh events that complete successfully. Carries no `error_type`. The "what changed" lives in `details_json` (`from_state`, `to_state`, `trigger_context`, optional `cancellation_reason`).

- **`recipe_failed`** — emitted when STS-01 rejects a transition or display-refresh attempt. The most common cause is a state-machine precondition violation (target_state not reachable from current_state; field-level precondition not met; single-writer rule violated). These emit with `error_type=recipe_invariant`. Less commonly, STS-01 itself could hit `external_action_failed` if a Data Tables write fails or `unexpected_error` if a derivation Python step crashes.

STS-01 does **not** emit `state_transition` with severity `warn` for rejected transitions, even though that would be a tempting shorthand. `state_transition` means "a transition happened"; rejection means "a transition was attempted and refused." The two are different events and belong in different phases.

---

## The full canonical list

For OBS-01's input validation. Alphabetical.

```
config_invalid
config_unparseable
external_action_failed
external_dependency_unavailable
recipe_invariant
state_inconsistent
submission_content_invalid
submission_empty
submission_structurally_invalid
submission_unparseable
unexpected_error
```

Eleven values. OBS-01's validation enum loads this list. The phase × error_type matrix from Section 5 is enforced as a second-layer rule.

---

## Discipline for adding new values

New `error_type` values land deliberately, not ad-hoc. Consistent with the catalog's warning about fragmentation, and consistent with how the phase taxonomy is maintained:

1. **Identify which existing value the new failure mode falls under first.** Most failure modes will fit an existing category. If `recipe_invariant` covers it, use `recipe_invariant`. Sub-classifiers go in `details_json`, not in `error_type`.
2. **If no existing value fits, draft a one-sentence rationale** naming what category of failure this is and why it warrants its own value.
3. **Add to this doc** with: the value, the rationale, and a "use when" entry mirroring the existing taxonomy entries.
4. **Add to the phase × error_type matrix** naming which phases accept this value.
5. **Update OBS-01's validation enum** to include the new value.
6. **For non-obvious additions**, write an ADR amendment.

The bar to clear: *the new value would be queried by a debugger filtering EventLog, and no existing value supports that query.* If the query would still work with the existing taxonomy plus `details_json` filtering, don't add the value.

---

## Open questions

1. **STS-01 sub-classification.** A state-machine precondition violation could be sub-categorized — "transition not in table" vs. "field-level precondition not met" vs. "single-writer rule violated." Currently all three emit as `recipe_invariant` with the specifics in `details_json`. Worth revisiting if operations finds it cumbersome to filter on the sub-category. The fix would be sub-values like `recipe_invariant_transition_illegal`, but that's the kind of fragmentation the catalog warned about; `details_json` filtering is the recommended alternative.

2. **`external_action_failed` granularity.** All boundary failures land in one bucket today (connector raised, FileStorage failed, Data Tables timed out, email rejected, etc.). If alert routing eventually needs to distinguish "the email service is down" from "a single Data Tables call failed," that's `external_dependency_unavailable` vs. `external_action_failed`, and the line between them is operational, not bright. Worth confirming the line as recipes start emitting both.

3. **`config_invalid` is broad.** It covers everything from "lookup reference not found" to "supplier has no primary user." Analogous to `submission_content_invalid`'s breadth. The reasoning is symmetric — content errors are too varied to enumerate, and `details_json` carries the specifics. Worth re-examining once CFG-01 is built and emitting against this.

4. **Discipline for retiring values.** New-value discipline is in Section 7. There's no analogous discipline for *removing* a value. If a category turns out to have been a mistake or to have been subsumed by another, what's the process? Likely: deprecate it (mark in doc, retain in OBS-01 validator for historical data), don't remove. Defer the policy until it's needed.

---

## Pending

- OBS-01 input validation reads from "The full canonical list" above plus the phase × error_type matrix from Section 5. Implementation note: load both as hardcoded structures in OBS-01's input-validation step. Same discipline as the phase taxonomy — new values require an OBS-01 edit.
- Decision on whether the matrix in Section 5 enforces *forbidden* combinations (the current proposal) or merely warns. The stricter rule is consistent with the phase taxonomy's enforcement model and is recommended.
- Confirmation that R5's analyst review path emits via STS-01 (`state_transition` with `trigger_context=analyst_approve` or `analyst_rework`) rather than as its own phase. If so, no new error_type considerations from R5; if instead R5 emits its own phases, this taxonomy may need a `review_action_rejected` entry.
