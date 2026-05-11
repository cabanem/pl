Good call. Let me work through change #1 first — fixing the `rows` bug and extending `validate_upload` to return the five-valued verdict (`passed | failed | structural_failure | empty | error`).

A quick note on scope before I dive in. The v2 build guide's verdict shape has five statuses, but two of them are conceptually different from the others:

- `passed`, `failed`, `empty` — verdicts the connector can produce by looking at its inputs (rows + canonical model)
- `structural_failure` — requires parsing XLSX bytes. The connector currently takes pre-extracted `upload_data`, so unless we add XLSX parsing to the connector, `structural_failure` is detected upstream (in the recipe or in a separate `extract_xlsx_to_rows` action) and passed in
- `error` — this is the "validation engine crashed" case, surfaced by Workato's error monitor in the recipe, not a value the connector returns

So `validate_upload` itself should return three statuses: `passed | failed | empty`. The `structural_failure` and `error` paths are handled outside this action. Let me confirm that's the right scoping before writing code — it changes what we're building.

The alternative would be to also pull XLSX parsing into the connector (so it accepts `submitted_xlsx_bytes` and can detect structural problems internally). That's a bigger change, ~150 lines of Ruby, and a separate decision. For change #1, I'd recommend keeping it scoped to the three statuses `validate_upload` can produce from its current input shape, and treating the XLSX parsing as a separate connector adjustment if you decide to do it.

Sound right? I'll proceed on that scoping. Here are the changes.

---

## Change #1a: Fix the `rows` bug

**Where:** `/mnt/user-data/uploads/functional_core_for_sdc_multi_workspace_custom_adapter.rb`, inside `validate_upload`'s `execute:` lambda. Specifically, after the existing input bindings at line 1741 and before the variant filter at line 1748.

**What to insert** (one new line):

```ruby
        rows           = input["upload_data"] || []
```

**Resulting context** (lines 1740–1750 after the edit — the new line is the third-from-last):

```ruby
        prior_values = input["prior_values"] || {}
        opts         = input["options"] || {}

        apply_cleaning = opts["apply_cleaning"].nil? ? true : opts["apply_cleaning"]
        max_per_row    = opts["max_errors_per_row"]
        max_total      = opts["max_total_errors"]
        stop_first     = opts["stop_on_first_row_failure"] || false

        rows           = input["upload_data"] || []

        # Filter fields by variant if applicable
```

This makes the three downstream references (lines 1777, 2152, 2157) resolve. No other changes needed for the bug fix — the rest of the loop body uses `rows` consistently.

---

## Change #1b: Add `empty` as a distinct verdict status

The current verdict logic (line 2155) is:

```ruby
"status" => all_errors.any? { |e| e["strict"] } ? "failed" : "passed",
```

This treats a zero-row submission with no errors as `passed`, which is wrong — empty submissions are a hard-fail by default per the deep dive. The connector should detect this and return `empty` with a summary error so the recipe persists it like any other failure.

**Where:** Two changes, both near the end of `validate_upload`'s `execute:` lambda.

**First**, an early-return block right after `rows` is bound (after the line you just added in 1a). Insert this block:

```ruby
        # ── Empty-submission gate ─────────────────
        # Zero rows is hard-fail by default per the capability deep dive.
        # Return early with status='empty' and a single summary error so the
        # recipe persists it through the same path as other failures.
        if rows.empty?
          return {
            "status" => "empty",
            "summary" => {
              "total_rows"       => 0,
              "valid_rows"       => 0,
              "invalid_rows"     => 0,
              "total_errors"     => 1,
              "truncated"        => false,
              "cleaning_applied" => false
            },
            "errors" => [{
              "row_number"      => 0,
              "field_id"        => nil,
              "field_name"      => nil,
              "submitted_value" => nil,
              "error_code"      => "err_empty_submission",
              "error_message"   => "Submission contains no rows",
              "strict"          => true,
              "source"          => "structural"
            }],
            "valid_payload" => []
          }
        end

        # Filter fields by variant if applicable
```

**Resulting context** (the block sits between the `rows` bind and the `# Filter fields by variant` comment that's already there at line 1748):

```ruby
        rows           = input["upload_data"] || []

        # ── Empty-submission gate ─────────────────
        # Zero rows is hard-fail by default per the capability deep dive.
        # Return early with status='empty' and a single summary error so the
        # recipe persists it through the same path as other failures.
        if rows.empty?
          return {
            "status" => "empty",
            ...
          }
        end

        # Filter fields by variant if applicable
        active_fields = if variant_ids.present?
```

**Second**, update the `output_fields` declaration (line 1703) so Workato's schema validator accepts the new `empty` status. Change:

```ruby
          { name: "status",  type: "string" },  # passed | failed
```

to:

```ruby
          { name: "status",  type: "string" },  # passed | failed | empty
```

And similarly update the `help:` block (line 1670) so the docs match what the action actually does. Change:

```ruby
          body: "Called after extracting uploaded file content. Core validation engine. Takes frozen field/rule/lookup config and parsed upload rows. Returns per-row, per-field errors with error codes and human-readable messages."
```

to:

```ruby
          body: "Called after extracting uploaded file content. Core validation engine. Takes frozen field/rule/lookup config and parsed upload rows. Returns one of three verdicts: 'passed' (no strict errors), 'failed' (one or more strict errors), or 'empty' (zero rows submitted — hard-fail with a summary error)."
```

---

## Why an early return vs. letting the existing logic produce `passed`

Three reasons the early return is the right shape:

1. **Caller experience.** The recipe gets to read `verdict.status == "empty"` directly and route to a different `trigger_context` (`system_validation_failed` with an empty-specific message) without inspecting `summary.total_rows`. The verdict is what it claims to be.

2. **No false denominators downstream.** The existing `valid_payload` array would be empty either way, but the `summary.valid_rows = 0, invalid_rows = 0, total_errors = 0` combination on a `passed` status is genuinely confusing — it reads as "0 of 0 rows passed," which sounds correct until you remember zero submissions shouldn't be a passing state.

3. **Consistency with the structural-failure path you may add later.** If you do extend the connector to take XLSX bytes and detect structural problems, that path will also be an early return with a summary error and a non-`passed/failed` status. Empty handled this way is the prototype for that shape.

---

## What this enables in VAL-01

With this change in, the v2 build guide's step 12 trigger_context mapping reads from `verdict.status` directly:

```
passed              → system_validation_passed
failed              → system_validation_failed
empty               → system_validation_failed (with empty-specific supplier_message)
structural_failure  → system_structural_failure   (still recipe-detected for now)
error               → pipeline_error_alert        (from Workato monitor, not connector)
```

Step 7's `RUN_ValidationResult.status` mapping needs one small adjustment: map `empty` to `failed` at the table level (the table enum is still `passed | failed | error` per the schema). The distinction lives in the verdict and in the error row.

Step 8's batch FieldError create handles the empty case naturally — `verdict.errors` has one summary row when `status == empty`, and the batch persists it the same as any other error.

---

## How to verify

After applying both 1a and 1b, three quick tests:

1. **Happy path regression.** Call `validate_upload` with the same fixture you currently use to verify a `passed` result. Should still return `passed`. If it doesn't, the `rows` bind is misplaced or the early-return condition is wrong.

2. **Empty input.** Call with `upload_data: []` and a valid canonical model. Should return `status: "empty"` with one error row carrying `error_code: "err_empty_submission"`.

3. **Failed regression.** Call with a fixture that has known strict errors. Should still return `failed`. Confirms the early return doesn't shadow the normal path.

If all three pass, change #1 is done. Want me to walk through change #2 — adding the primary-user invariant check to `validate_config` — next?
