# SDC Data Collection — Stage 1 Specifications (v2)

## Status

Stage 1 of the build queue. Foundation utilities and connector adjustments —
the cross-cutting infrastructure that almost everything downstream calls.

Five recipe deliverables (UTL-01, OBS-01, STS-01, plus two connector
amendments) and one supporting sub-recipe (STS-01-build-error).

UTL-01, OBS-01, and the connector amendments can be built in parallel. STS-01
depends on OBS-01 (it emits a `state_transition` event on every transition).
STS-01-build-error is built alongside STS-01.

Companion artifacts:
- `sdc-event-phase-taxonomy-v1.md` — canonical phase list for OBS-01
- `sdc-stage1-python-steps-v1.py` — Python step source for OBS-01 and STS-01

---

## Cross-cutting decisions

These apply to multiple specs below; documenting once.

### Single-writer invariant clarification

State-machine invariant 1 says "only the status-change handler writes
`SupplierRequest.status`, `supplier_display_status`, and `supplier_message`."
For the build, we read this as:

**STS-01 is the only writer of the four state fields (`status`,
`supplier_display_status`, `supplier_message`, `current_state_entered_at`)
for transitions on existing rows. Initial-creation values are written once
at insert time by the PRV chain and never modified except via STS-01
thereafter.**

This lets initial creation be a normal row insert (in the PRV-* recipe that
stages supplier records) without forcing STS-01 to also be a row-creator.
STS-01 stays tightly scoped to transitions.

### Where canonical lists live

Both the phase taxonomy (OBS-01) and the derivation table (STS-01) live as
hardcoded constants in their respective Python steps, not in data tables or
FileStorage JSON.

- Discoverability is preserved — these are high-traffic recipes; anyone
  needing to know "what does OBS-01 accept?" opens OBS-01 and sees the
  constant.
- Data-table storage would dissolve the ADR-058 gate ("adding a phase is a
  deliberate act"); a row insert is too easy.
- State-machine invariant 6 explicitly says wording changes are recipe-code
  changes, not data migrations — argues against table storage for the
  derivation table.
- Each constant has a "Source of truth" comment naming the markdown doc,
  plus a "Last synced" date for drift detection.

### OBS-01 invalid-input policy

When OBS-01 receives a `severity` or `phase` outside the canonical sets, it
**writes the row anyway** with `severity=error`, `phase=invalid_phase`, and
`details_json` annotated with `_validation_error`, `_original_severity`,
`_original_phase`. Returns success to the caller.

OBS-01 raising an exception would make the audit logger break the caller's
workflow (a successful provisioning failing because someone typoed a phase
name), which is backwards. Annotated-write preserves the audit chain and
surfaces drift via a periodic auditor query against `_validation_error` rows.
`invalid_phase` is a reserved phase added to the taxonomy specifically for
this purpose.

### Project is a singleton

Per the v1 data model decisions: there is exactly one Project row per
workspace (one project per workspace, isolation via separate workspaces).
Project has no incoming foreign keys. SUP_SupplierRequest does NOT have a
`template_project_id` column — it was explicitly removed when the data
model collapsed to a singleton-Project shape.

Recipes that need project-level information (analyst_email,
default_due_days, customer_name, etc.) read the singleton directly:

```
Action — Data Tables → Search Project, no filter, limit=1.
```

This pattern appears in STS-01 step 4b (twice — `invitation_issued`
fallback for due_date, and `analyst_cancel` for analyst_email) and will
appear in many recipes downstream. Worth introducing a `UTL-02 / Get
project context` callable in a future stage if the read becomes too
ubiquitous; not Stage 1 work.

### EventLog `phase` column rename — open

The workflow-stages doc and the EventLog `phase` column refer to the same
concept (a lifecycle moment within a workflow). If "stage" is the canonical
word for this concept, then `EventLog.phase` is misnamed and should be
`EventLog.stage`. This is a Stage 0 amendment and is currently undecided.

These specs use `phase` throughout; if the rename happens, all references
shift. Decision should be made before OBS-01 ships.

---

## UTL-01 — Generate shareable link

### Intent

Take a FileStorage path, return a fresh 10-day shareable link. Single owner
of TTL knowledge. The day someone says "make these last 30 days" or the
platform changes its TTL ceiling, this is the only edit.

### Type

Callable recipe.

### Inputs

- `path` (string, required) — FileStorage path

### Outputs

- `link` (string) — shareable URL
- `expires_at` (datetime) — write-time + 10 days, computed for caller convenience

### Steps

1. *Action — FileStorage → Create shareable link.* `file_path` = input `path`.
   `expires_in_days` = 10.
2. *Action — Variable assignment.* `expires_at = now() + 10.days`.
3. *Return.* `link` from step 1, `expires_at` from step 2.

### Notes

Genuinely one substantive step. The single-owner principle is the whole
value; every recipe that needs a link calls UTL-01.

No "does the path exist" guard step. FileStorage's own error on a bad path
is informative enough.

---

## OBS-01 — Event emitter

### Intent

Single writer of EventLog rows. Severity-keyed; covers routine audit and
incident tracking. Validates `severity` and `phase` against canonical sets;
on invalid input, writes the row with override fields rather than raising.

### Type

Callable recipe.

### Inputs

Mapped to the EventLog schema:

- `severity` (string, required) — validated against `{info, warn, error}`
- `source_recipe` (string, required)
- `step_number` (integer, required)
- `phase` (string, required) — validated against the canonical taxonomy
- `human_message` (string, required)
- `details_json` (string, optional)
- `analyst_email` (string, optional)
- `supplier_request_id` (string, optional)
- `error_type` (string, optional)
- `alert_sent` (boolean, optional, default `false`)
- `resolved` (boolean, optional, default `false`)
- `resolved_at` (datetime, optional)

### Outputs

- `event_id` (string) — UUID generated by the handler
- `timestamp` (datetime) — write time, ISO 8601 UTC

### Steps

1. *Python step — Validate and compose row.* See
   `sdc-stage1-python-steps-v1.py`, Section 1. Validates `severity` and
   `phase`; on failure, overrides outputs to `severity=error`,
   `phase=invalid_phase`, with annotated `details_json`. Generates `event_id`
   and `timestamp`. Returns the full row payload.
2. *Action — Data Tables → Create row in EventLog.* Map all fourteen fields
   from step 1's outputs.
3. *Return.* `event_id` and `timestamp`.

### Notes

The Python step does all the work; the Data Tables step is a pure write. The
canonical phase taxonomy lives in the Python step's `PHASE_TAXONOMY`
constant. To add a phase: update `sdc-event-phase-taxonomy-v1.md` first,
then mirror the constant.

Alert dispatch is **not** in scope. If you want alerts, build a watcher
recipe that triggers on EventLog row creation and dispatches based on
`severity` and `alert_sent`. That keeps OBS-01's side-effect signature clean.

---

## STS-01-build-error — Error response sub-recipe

### Intent

Assemble the standard STS-01 error response shape. Called by every STS-01
early-return path so the response shape is defined in exactly one place.

### Type

Callable recipe.

### Inputs

- `prior_state` (string, optional — empty when row didn't exist)
- `error_code` (string, required)
- `error_message` (string, required)

### Outputs

- `success` = `false`
- `prior_state` = input
- `new_state` = `""`
- `display_status` = `""`
- `display_message` = `""`
- `error_code` = input
- `error_message` = input

### Steps

1. *Return.* Map the seven output fields from inputs and constants.

### Notes

No logic, no branches. Pure response-shape assembly. The reason it exists is
purely about not duplicating the seven-field response shape across STS-01's
four-to-five early-return paths — if the response shape ever changes, it
changes in one place.

---

## STS-01 — Status-change handler

### Intent

Single writer of `status`, `supplier_display_status`, `supplier_message`,
and `current_state_entered_at` for transitions on existing
SUP_SupplierRequest rows. Validates the transition is legal, checks
field-level preconditions, composes literal display strings per the
derivation table, writes atomically, emits an event.

### Type

Callable recipe.

### Inputs

- `supplier_request_id` (string, required)
- `target_state` (string, required) — one of `sent | supplier_action_required |
  pending_review | approved | cancelled`
- `trigger_context` (string, required) — one of `invitation_issued |
  system_validation_passed | system_validation_failed | analyst_rework |
  analyst_approve | analyst_cancel | display_refresh`
- `cancellation_reason` (string, optional — required when `target_state=cancelled`)
- `due_date_override` (date, optional — falls back to project default)

### Outputs

- `success` (boolean) — `True` on completed transition; `False` on any failure
- `prior_state` (string) — the state read from the row before transition
  (empty if `request_not_found`)
- `new_state` (string) — the state written; empty on failure
- `display_status` (string) — what was written; empty on failure
- `display_message` (string) — what was written; empty on failure
- `error_code` (string) — empty on success; one of `request_not_found |
  illegal_transition | precondition_failed | derivation_lookup_failed`
- `error_message` (string) — empty on success; descriptive otherwise

### Atomicity contract

STS-01 must not partially-write. Either all four state fields update
atomically in step 6, or none do. Steps 1–5 are read-only; the first and
only write is step 6. If any step before 6 returns an error, the row is
untouched and the handler returns via STS-01-build-error.

### Step 1. Search SUP_SupplierRequest

*Action — Data Tables → Search rows* on SUP_SupplierRequest filtered by
`supplier_request_id = input.supplier_request_id`.

*If* `search.size == 0`:
- *Action — Call STS-01-build-error* with `prior_state=""`,
  `error_code="request_not_found"`,
  `error_message="No SUP_SupplierRequest with id {input.supplier_request_id}"`.
- *Action — Return* mapping STS-01's outputs from the sub-recipe response.
- End.

*Else:* capture the row for downstream steps. Continue.

### Step 2. Validate transition legality

*Python step — Section 2 of `sdc-stage1-python-steps-v1.py`.* Inputs:
`prior_state=row.status`, `target_state=input.target_state`,
`trigger_context=input.trigger_context`.

*If* `python.legal == false`:
- *Call STS-01-build-error* with `prior_state=row.status`,
  `error_code=python.error_code`, `error_message=python.error_message`.
- *Return.* End.

*Else:* continue.

### Step 3. Field-level preconditions

Four sequential conditional blocks, one per `target_state` that has a
precondition. `pending` is omitted because STS-01 never transitions to
`pending` (initial creation is the PRV chain's job).

#### Step 3a — `target_state == "sent"`

*If* `input.target_state == "sent"`:
- *Inner if* `row.template_path is null OR row.template_path is empty`:
  - *Call STS-01-build-error* with `prior_state=row.status`,
    `error_code="precondition_failed"`,
    `error_message="template_path is required for transition to sent"`.
  - *Return.* End.

#### Step 3b — `target_state == "pending_review"`

*If* `input.target_state == "pending_review"`:
- *Inner if* `row.current_validation_result_id is null OR is empty`:
  - *Call STS-01-build-error* with `prior_state=row.status`,
    `error_code="precondition_failed"`,
    `error_message="current_validation_result_id is required for transition to pending_review"`.
  - *Return.* End.
- *Else:*
  - *Action — Data Tables → Search RUN_ValidationResult* by
    `id = row.current_validation_result_id`. Capture as
    `validation_result_for_precondition`.
  - *Inner if* `validation_result_for_precondition.status != "passed"`:
    - *Call STS-01-build-error* with `prior_state=row.status`,
      `error_code="precondition_failed"`,
      `error_message="ValidationResult {id} is not in passed status (found: {status})"`.
    - *Return.* End.

#### Step 3c — `target_state == "approved"`

*If* `input.target_state == "approved"`:
- *Inner if* `row.approved_at is null OR row.approved_path is null`:
  - *Call STS-01-build-error* with `prior_state=row.status`,
    `error_code="precondition_failed"`,
    `error_message="approved_at and approved_path must be set before transition to approved"`.
  - *Return.* End.

#### Step 3d — `target_state == "cancelled"`

*If* `input.target_state == "cancelled"`:
- *Inner if* `input.cancellation_reason is null OR is empty`:
  - *Call STS-01-build-error* with `prior_state=row.status`,
    `error_code="precondition_failed"`,
    `error_message="cancellation_reason is required for transition to cancelled"`.
  - *Return.* End.

### Step 4. Resolve derivation context

The Python derivation step (Step 5) requires nine context variables. Most
templates use only one or two; the rest stay empty. Each `trigger_context`
branch fetches what its template needs and assigns to the corresponding
recipe variables.

#### Step 4a. Initialize derivation variables

*Action — Variable assignment.* Create nine recipe variables, all set to
empty string:

```
due_date = ""
invalid_row_count = ""
validated_at = ""
validation_report_link = ""
review_note_text = ""
reviewed_at = ""
submitted_at = ""
approved_at = ""
analyst_email = ""
```

This guarantees Step 5 always has all nine inputs available.

#### Step 4b. Trigger-context branches

A single conditional block with branches keyed on `input.trigger_context`.

*Branch — `invitation_issued`:*
- *If* `input.due_date_override is not null`:
  - Assign `due_date = input.due_date_override`.
- *Else if* `row.due_date is not null`:
  - Assign `due_date = row.due_date`.
- *Else:*
  - *Action — Data Tables → Search Project* with no filter, `limit=1`
    (singleton — see "Project is a singleton" cross-cutting note).
    Capture as `project`.
  - Assign `due_date = formatted(now() + project.default_due_days days)`.

*Branch — `system_validation_failed` OR `display_refresh`:*
- *Action — Data Tables → Search RUN_ValidationResult* by
  `id = row.current_validation_result_id`. Capture as `validation_result`.
- Assign:
  - `invalid_row_count = string(validation_result.invalid_row_count)`
  - `validated_at = validation_result.validated_at`
- *Action — Call UTL-01* with `path = validation_result.validation_report_path`.
- Assign `validation_report_link = utl_01_result.link`.

*Branch — `analyst_rework`:*
- *Action — Data Tables → Search RUN_ReviewNote* where
  `supplier_request_id = input.supplier_request_id` AND
  `review_action = "rework"`, ordered by `created_at desc`, limit 1.
  Capture as `review_note`.
- Assign:
  - `review_note_text = review_note.note_text`
  - `reviewed_at = review_note.created_at`

*Branch — `system_validation_passed`:*
- *Action — Data Tables → Search RUN_ValidationResult* by
  `id = row.current_validation_result_id`. Capture as `validation_result`.
- Assign `submitted_at = validation_result.validated_at`.
  - Using `validated_at` as the supplier-facing "submitted_at" timestamp;
    seconds-level imprecision is acceptable for display.

*Branch — `analyst_approve`:*
- Assign `approved_at = row.approved_at`.

*Branch — `analyst_cancel`:*
- *Action — Data Tables → Search Project* with no filter, `limit=1`
  (singleton — see "Project is a singleton" cross-cutting note).
  Capture as `project`.
- Assign `analyst_email = project.analyst_email`.

### Step 5. Derive display fields

*Python step — Section 3 of `sdc-stage1-python-steps-v1.py`.* Inputs:
`target_state=input.target_state`, `trigger_context=input.trigger_context`,
plus all nine context variables from Step 4.

*If* `python.lookup_failed == true` (defensive — Step 2 should have caught
all illegal `(target, trigger)` pairs):
- *Call STS-01-build-error* with `prior_state=row.status`,
  `error_code="derivation_lookup_failed"`,
  `error_message=python.error_message`.
- *Return.* End.

*Else:* capture `python.supplier_display_status` and
`python.supplier_message` for Step 6.

### Step 6. Update SUP_SupplierRequest — first and only write

*Action — Data Tables → Update row* on SUP_SupplierRequest where
`id = input.supplier_request_id`. One step, four field updates:

- `status = input.target_state`
- `supplier_display_status = python.supplier_display_status`
- `supplier_message = python.supplier_message`
- `current_state_entered_at = now()`

Workato writes all four atomically.

### Step 7. Emit state_transition event

*Action — Call OBS-01.*

- `severity = "info"`
- `source_recipe = "STS-01"`
- `step_number = 7`
- `phase = "state_transition"`
- `human_message = "Transitioned {row.status} → {input.target_state} via {input.trigger_context}"`
- `details_json = JSON.serialize({from_state: row.status, to_state: input.target_state, trigger_context: input.trigger_context, cancellation_reason: input.cancellation_reason or null})`
  - Cancellation reason routes here per state-machine invariant 5.
- `supplier_request_id = input.supplier_request_id`

### Step 8. Return success

*Action — Return:*

- `success = true`
- `prior_state = row.status`
- `new_state = input.target_state`
- `display_status = python.supplier_display_status`
- `display_message = python.supplier_message`
- `error_code = ""`
- `error_message = ""`

### Notes on initial creation

STS-01 does not handle initial creation. A SUP_SupplierRequest row enters
existence via the PRV chain (specifically whichever PRV recipe owns supplier
record staging) with:

- `status = "pending"`
- `supplier_display_status = ""` (no portal access yet)
- `supplier_message = ""` (no portal access yet)
- `current_state_entered_at = now()`

These are part of the row insert; no derivation lookup needed. STS-01 takes
over from the next transition onward (`pending → sent` via
`invitation_issued`).

### Notes on atomicity (the documented Stage 1 blocker)

Workato gives single-row atomicity within a data table update — all four
field changes in Step 6 land or none do. What it doesn't give is
transactional atomicity across Step 6 (row update) and Step 7 (event emit).
If Step 7 fails after Step 6 succeeds, the state has changed but no
EventLog row records the transition.

Pragmatic response: order matters. Write the row first (Step 6), emit the
event second (Step 7). If Step 7 fails, the state is correct and the audit
chain is incomplete — better than the inverse. The cost of failure is
bounded: a missing audit row for a transition that did happen, recoverable
from the next state change. Surface as a comment in the recipe; revisit only
if it ever fires in production.

If audit strictness becomes a hard requirement, the upgrade is a "missed
events" data table written by an error handler on Step 7, plus a periodic
reconcile recipe. Not building this now.

### Notes on redundant fetches

`pending_review` precondition (Step 3b) and `system_validation_passed`
derivation (Step 4b) both fetch RUN_ValidationResult by the same id. Same
for `system_validation_failed` and `display_refresh` derivation. The
redundancy is accepted; deduplicating across step boundaries via recipe
variables adds coupling between steps that should otherwise be independent.
The fetch is cheap.

### Open questions

- **`due_date` location.** State-machine doc backports flagged per-request
  (`SUP_SupplierRequest.due_date`) vs. per-engagement
  (`Project.default_due_days`). Did Stage 0 land one or both? Step 4b's
  `invitation_issued` branch reads request first, falls back to
  project-default arithmetic. If only one landed, the fallback simplifies.
- **`submitted_at` semantics.** Step 4b's `system_validation_passed` branch
  uses `validation_result.validated_at` as the supplier-facing
  "submitted_at" timestamp. The literal Upload `created_at` would be more
  accurate but requires an extra fetch. The seconds-level discrepancy is
  acceptable for display, but worth confirming this is the intended reading.

---

## Connector amendment 1 — `validate_config`

### Goal

Enforce data-model invariant 6: exactly one `SupplierUser.primary = true`
per supplier. The current connector doesn't know about the `primary`
attribute — three additions.

### Change 1. `parse_users_sheet` extracts the new column

Pre-condition: the master config spreadsheet's `3_users` sheet needs a
`Primary contact` column header at the existing `header_row=7`.

```ruby
parse_users_sheet: lambda do |sheets, cfg|
  extracted = call(:extract_sheet_rows, sheets, cfg)
  return { "rows" => [], "skipped" => 0, "error" => extracted["error"] } if extracted["error"].present?

  rows = extracted["rows"].map do |raw|
    {
      "user_email"    => raw["Supplier user email"].to_s.strip,
      "supplier_name" => raw["Supplier name"].to_s.strip,
      "contact_name"  => raw["Supplier contact name"].to_s.strip.presence,
      "primary"       => call(:coerce_boolean, raw["Primary contact"])  # NEW
    }
  end

  { "rows" => rows, "skipped" => extracted["skipped"] }
end,
```

### Change 2. `user_definition` object def gets the new field

```ruby
user_definition: {
  fields: lambda do |_connection, _config|
    [
      { name: "user_email",     type: "string" },
      { name: "supplier_name",  type: "string" },
      { name: "contact_name",   type: "string", optional: true },
      { name: "primary",        type: "boolean" }                       # NEW
    ]
  end
},
```

### Change 3. `validate_config` adds an `exactly_one_primary_per_supplier` check

In the `execute` block of `validate_config`, alongside
`no_duplicate_user_per_supplier`:

```ruby
# exactly_one_primary_per_supplier
primary_issues = users
  .group_by { |u| u["supplier_name"] }
  .flat_map { |sup, group|
    primary_count = group.count { |u| u["primary"] == true }
    if primary_count == 0
      [{ "entity" => "supplier", "name" => sup,
         "issue" => "no primary contact designated" }]
    elsif primary_count > 1
      [{ "entity" => "supplier", "name" => sup,
         "issue" => "multiple primary contacts designated (#{primary_count})" }]
    else
      []
    end
  }
checks << {
  "check_name" => "exactly_one_primary_per_supplier",
  "status" => primary_issues.empty? ? "pass" : "fail",
  "message" => primary_issues.empty? ?
    "Each supplier has exactly one primary contact" :
    "#{primary_issues.size} supplier(s) with primary contact issue(s)",
  "details" => primary_issues
}
```

### Notes

`fail` (not `warn`) — invariant 6 is structural. Suppliers with zero and
suppliers with multiple primaries both produce the same fail-severity
result; the `details` text distinguishes them.

The amendment is additive — existing config files without a `Primary
contact` column have all users coerce to `primary=false`, which produces
the "no primary contact" error and surfaces the missing column to the
analyst as a config error rather than silent drift.

---

## Connector amendment 2 — `validate_upload`

### Goal

Add support for `ValidationRule.scope` (submission | supplier | engagement)
and the corresponding `prior_values` input. Submission-scope rules evaluate
within a single submission (current behavior); supplier-scope and
engagement-scope rules evaluate against prior submissions.

### Change 1. Rule input definition gets a `scope` field

In `validate_upload`'s `input_fields`:

```ruby
{ name: "rules", type: "array", of: "object",
  label: "CFG_Rule rows",
  properties: [
    *object_definitions["rule_definition"],
    { name: "rule_id",            type: "string" },
    { name: "field_id",           type: "string" },
    { name: "target_field",       type: "string" },
    { name: "condition_field",    type: "string", optional: true },
    { name: "condition_field_id", type: "string", optional: true },
    { name: "scope",              type: "string", optional: true,
      hint: "submission | supplier | engagement. Defaults to submission." }  # NEW
  ] }
```

### Change 2. New `prior_values` input

```ruby
{ name: "prior_values", type: "object", optional: true,
  label: "Prior values for cross-submission rules",
  hint: "Map of { field_id => [{ value, row_number, submission_id }, ...] }. " \
        "Required when any rule has scope=supplier or scope=engagement. " \
        "Caller pre-fetches from prior submissions filtered to validated/approved status." }
```

### Change 3. Rule dispatch reads `scope`

In `execute`, before the existing within-submission rule dispatch:

```ruby
# Inside the rule loop, after determining target_field and t_val:

if rule["scope"].present? && %w[supplier engagement].include?(rule["scope"])
  prior = (input["prior_values"] || {})[rule["field_id"]] || []

  case rule["rule"]
  when "Combined fields must be unique"
    c_field = active_fields.find { |f|
      f["field_id"] == rule["condition_field_id"] ||
        f["field_name"] == rule["condition_field_name"]
    }
    c_val = c_field ? row[c_field["field_name"]] : nil
    composite = [t_val.to_s.strip, c_val.to_s.strip].join("\x1F")

    prior_composite = prior.any? { |p|
      p["composite_key"] == composite
    }

    if prior_composite
      row_errors << {
        "row_number" => row_num, "field_id" => target_field["field_id"],
        "field_name" => target_field["field_name"],
        "submitted_value" => raw_row[target_field["field_name"]],
        "error_code" => "err_composite_unique",
        "error_message" => "#{target_field['field_name']}: composite value already submitted in a prior submission",
        "strict" => rule["strict_enforcement"].nil? ? true : rule["strict_enforcement"],
        "source" => "cross_field"
      }
    end

  when "Must not match"
    if prior.any? { |p| p["value"].to_s == t_val.to_s }
      row_errors << {
        "row_number" => row_num, "field_id" => target_field["field_id"],
        "field_name" => target_field["field_name"],
        "submitted_value" => raw_row[target_field["field_name"]],
        "error_code" => "err_must_not_match",
        "error_message" => "#{target_field['field_name']}: value matches a prior submission",
        "strict" => rule["strict_enforcement"].nil? ? true : rule["strict_enforcement"],
        "source" => "cross_field"
      }
    end
  end

  next  # cross-submission rule handled, skip within-submission dispatch
end

# Existing within-submission dispatch follows unchanged.
```

### Notes

The verbs that gain cross-submission semantics in v1 are
`Combined fields must be unique` and `Must not match`. Other verbs may grow
cross-submission semantics later; the dispatch pattern accommodates them
additively.

**Caller responsibility — the resubmit-after-failure trap.** The pre-fetch
that produces `prior_values` must filter to **validated/approved prior
submissions**, not "any prior submission." Otherwise a supplier resubmitting
after their own failed submission will see uniqueness errors against their
own failed prior data. Caller (Validate supplier input recipe in Stage 2)
is responsible; the connector trusts what it's given.

The amendment is fully backward-compatible: existing rules without `scope`
default to submission-scope; existing callers without `prior_values`
continue to work unchanged.

---

## Verification milestone — end of Stage 1

Concrete acceptance criteria. After these pass, Stage 1 closes and Stage 2
opens.

### UTL-01

1. Call with a known FileStorage path. Receive a link that opens the file
   in a browser. Verify `expires_at` is approximately 10 days out.

### OBS-01

2. **Happy path.** Call with valid `severity` and `phase`. Verify EventLog
   row created with expected fields. Verify `event_id` and `timestamp`
   returned.
3. **Invalid-input path.** Call with `phase="not_a_real_phase"`. Verify
   EventLog row created with `severity=error`, `phase=invalid_phase`, and
   `details_json` containing the `_validation_error` annotation.

### STS-01

4. **Happy path.** Create a synthetic SUP_SupplierRequest in `pending`
   state with `template_path` populated. Call STS-01 with `target_state=sent`,
   `trigger_context=invitation_issued`. Verify all four state fields update;
   verify a `state_transition` EventLog row appears.
5. **Illegal transition.** Same fixture, call with `target_state=approved`
   (illegal from `pending`). Verify the row is untouched; verify
   `success=false` and `error_code="illegal_transition"`.
6. **Precondition failure.** Fixture in `pending_review` state with
   `approved_at=null`. Call with `target_state=approved`. Verify row
   untouched; verify `error_code="precondition_failed"`.
7. **No-op transition.** Fixture in `supplier_action_required` state. Call
   with `target_state=supplier_action_required`,
   `trigger_context=display_refresh`. Verify state unchanged but
   `current_state_entered_at` updated and `supplier_message` refreshed
   with new error counts.
8. **Cross-recipe integration.** STS-01's `system_validation_failed` branch
   calls UTL-01 (Step 4b). Verify the chain works end-to-end: call STS-01
   with that trigger, confirm the `validation_report_link` written to
   `supplier_message` is a real working FileStorage link.

### Connector amendments

9. **`validate_config` invariant 6.** Run a config with a supplier having
   two primary contacts. Verify `exactly_one_primary_per_supplier` check
   fails with detail naming the supplier. Run again with a supplier having
   zero primaries; verify same check fails.
10. **`validate_upload` cross-submission rule.** Call with a supplier-scope
    `Must not match` rule and `prior_values` containing a value the current
    upload also contains. Verify `err_must_not_match` fires.

### Resubmit-after-failure (verifies caller-responsibility note)

11. **Negative test for resubmit-after-failure.** Pass `prior_values`
    containing values from a *failed* prior submission (simulating the
    caller forgetting to filter). Verify the spurious uniqueness error
    fires. This test isn't a pass/fail for the connector — it's a
    pass/fail for whoever builds the Stage 2 `Validate supplier input`
    recipe, who must filter `prior_values` correctly.
