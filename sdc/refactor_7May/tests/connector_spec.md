# SDC Data Collection — Test Harness Connector (v1)

## Status

Stage 1 verification infrastructure. Custom Workato connector providing
assertion, fixture-management, and result-recording methods used by the
five tier-1 test recipes. Built once at the start of Stage 1 verification
work; expected to grow additively as later stages add tests with new
assertion shapes.

## Design principles

Six commitments shaped the scope:

1. **Minimal surface, expansion-friendly shape.** Four actions + one shared
   method at v1. Add actions as new test patterns surface; resist adding
   actions speculatively.

2. **Assertions are pure compute.** Assertion actions take fully-resolved
   values as input — they don't fetch rows, they don't read tables. The
   recipe is responsible for materializing the values to compare. This
   keeps the connector debuggable: an assertion failure is "these two
   values didn't match," never "I couldn't find the row to compare."

3. **Fixtures are inserts, not state machines.** The fixture-creation
   action knows about column shapes, ID conventions, and timestamp
   suffixes — but not about state semantics. Creating a row in
   `pending_review` state with inconsistent FKs is the recipe's
   responsibility (it asked for that combination); the connector just
   inserts what it's told.

4. **No external HTTP.** Connectionless / pure-compute, like the SDC
   Platform Connector. The `connection` block exists only to satisfy the
   SDK; `test:` always returns success. No auth, no base URI, no calls
   leaving the workspace.

5. **One result-recording shape.** A single `record_test_result` action
   covers passed, failed, and error outcomes. Recipes don't construct
   TestRun rows directly — they call the action with a verdict and
   optional detail.

6. **No assertion DSL.** Rejected the temptation to build an
   `assert_many(assertions: [...])` action that takes a list of
   parameterized assertions and short-circuits on first failure. Cleaner
   in some ways, but it pushes test logic into the action's input shape
   rather than into the recipe's flow. With four assertion actions called
   sequentially, the recipe reads top-to-bottom; with `assert_many`, the
   reader has to mentally evaluate the array. Defer this until v2 if test
   counts make the verbosity painful.

## Actions

### 1. `create_pending_fixture`

Creates a SUP_SupplierRequest fixture row in `pending` state with a
unique, traceable id. Used by STS-01 happy-path, illegal-transition, and
precondition-failure tests as setup.

**Inputs:**

- `test_name` (string, required) — used to construct the fixture id.
  Convention: short hyphenated handle like `STS-01-happy`.
- `template_path` (string, optional, default `/test/dummy.xlsx`) — pass
  null to test the `sent` precondition failure path.
- `fixture_supplier_id` (string, required) — known TEST-supplier fixture
  id from the static fixture set.
- `fixture_version_id` (string, required) — known TEST-template-version
  fixture id.

**Outputs:**

- `supplier_request_id` (string)
- `created_at` (datetime)

**Behavior:**

1. Construct id: `"TEST-{test_name}-{compact_timestamp}"`. Compact
   timestamp format: `YYYYMMDDHHMMSS` (Workato `now()` formatted).
2. Insert one row into SUP_SupplierRequest with:
   - `id` = constructed id
   - `status` = `"pending"`
   - `supplier_display_status` = `""`
   - `supplier_message` = `""`
   - `current_state_entered_at` = current time
   - `template_path` = input value (may be null)
   - `supplier_id` = `fixture_supplier_id`
   - `assigned_version_id` = `fixture_version_id`
   - All other required fields default-populated from the static fixture set.
3. Return the id and the created_at timestamp.

**Notes:**

The action only creates `pending`-state fixtures. Other states
(`pending_review`, `sent`, etc.) are needed for some tests; those
fixtures get created inline in the recipe rather than in the connector.
Resisting the urge to add `create_*_fixture` per state — too many shapes,
not enough payoff. If a single state ends up needed for many tests,
revisit.

### 2. `assert_equals`

Compare two values. Returns a structured pass/fail verdict with a
formatted failure message when they don't match.

**Inputs:**

- `actual` (string, required) — the value observed
- `expected` (string, required) — the value expected
- `field_label` (string, required) — what's being compared, used in the
  failure message (e.g., `"sts_response.error_code"`)
- `comparison_mode` (string, optional, default `string`) — one of
  `string | numeric | boolean | json`

**Outputs:**

- `passed` (boolean)
- `failure_detail` (string) — empty when passed, formatted message when failed

**Behavior:**

The four comparison modes handle Workato's loose typing across step
boundaries. By default, comparisons are string-based after normalization
(both values converted to strings, whitespace-stripped). Other modes:

- `numeric` — both values coerced to floats, compared with epsilon
  tolerance for float safety.
- `boolean` — both values coerced through the same boolean-coercion logic
  used elsewhere in the platform connector (`coerce_boolean`).
- `json` — both values parsed as JSON, compared as deep-equal data
  structures.

The default `string` mode covers ~80% of test assertions; the others
exist for specific test shapes (numeric assertions on `invalid_row_count`,
boolean on `success`, etc.).

Failure message format:
`"{field_label}: expected '{expected}', got '{actual}'"`

**Notes:**

Used for any assertion where the test recipe has both values in hand and
just needs to compare them. The recipe is responsible for fetching rows
and extracting the relevant fields *before* calling this action.

### 3. `assert_event_logged`

Search EventLog for a row matching given criteria. Returns pass when at
least one row matches; fails with a search-criteria-based message
otherwise.

**Inputs:**

- `supplier_request_id` (string, required)
- `phase` (string, required) — must be a value from the canonical phase
  taxonomy
- `since` (datetime, optional) — only match events with timestamp >=
  this value. Useful for distinguishing "an event was emitted by *this*
  test" from "an event already existed for this fixture."

**Outputs:**

- `passed` (boolean)
- `event_id` (string, optional) — the matching event's id if found
- `failure_detail` (string)

**Behavior:**

1. Search EventLog where `supplier_request_id` matches AND `phase`
   matches AND (if provided) `timestamp >= since`.
2. If `size >= 1`, return passed with the most recent matching row's id.
3. Else return failed with detail:
   `"No EventLog row found for supplier_request_id={...}, phase={...}{since clause}"`.

**Notes:**

This is a fetch-and-assert action — it does what principle 2 above says
not to do. The justification: EventLog assertions are common across many
test recipes, and the fetch logic (filter by `supplier_request_id` AND
`phase`, optional `since`, ordering) has enough structure that
duplicating it inline in five recipes is worse than centralizing in one
action.

The principle holds for *value-comparison* assertions (which is what
`assert_equals` is) — those should remain pure compute. Existence
assertions against a known table (EventLog) are a different shape and
get their own action.

### 4. `record_test_result`

Write one row to TestRun with the test's outcome and any failure detail.

**Inputs:**

- `test_name` (string, required)
- `stage` (string, required) — e.g., `"Stage 1"`
- `status` (string, required) — one of `passed | failed | error`
- `failure_detail` (string, optional) — empty when passed, populated otherwise
- `started_at` (datetime, required)
- `recipe_handle` (string, required) — the test recipe's identifier
- `fixture_id` (string, optional)

**Outputs:**

- `test_run_id` (string)
- `recorded_at` (datetime)

**Behavior:**

1. Generate a UUID for `test_run_id`.
2. Capture `recorded_at` = current time.
3. Insert one row into TestRun with all input fields plus
   `ended_at = recorded_at` and the generated id.
4. Return the id and the timestamp.

**Notes:**

The recipe constructs `failure_detail` (typically by capturing the output
of an `assert_*` action). This action just persists the verdict — it
doesn't compute anything about whether the test passed or failed.

The single-action design (rather than separate `record_pass` /
`record_fail` actions) is intentional. Recipes already have to compute
status from assertion results; making them call different actions for
each outcome adds branching without simplifying anything.

## Methods (shared)

### `coerce_boolean`

Same shape as the SDC Platform Connector's existing helper. Pulled in
here because `assert_equals` with `comparison_mode=boolean` needs it.

```ruby
coerce_boolean: lambda do |value|
  return false if value.blank?
  normalized = value.to_s.strip.downcase
  %w[1 true].include?(normalized)
end
```

### `compact_timestamp`

Format `now()` as `YYYYMMDDHHMMSS` for use in fixture ids.

```ruby
compact_timestamp: lambda do
  Time.now.utc.strftime("%Y%m%d%H%M%S")
end
```

### `format_assertion_failure`

Used by all assertion actions to compose the failure message. Centralizes
the format so changes are one-place.

```ruby
format_assertion_failure: lambda do |field_label, expected, actual|
  "#{field_label}: expected '#{expected}', got '#{actual}'"
end
```

## Pick lists

### `comparison_mode`

```ruby
[
  ["String (default)", "string"],
  ["Numeric",          "numeric"],
  ["Boolean",          "boolean"],
  ["JSON deep-equal",  "json"]
]
```

### `test_status`

```ruby
[
  %w[Passed passed],
  %w[Failed failed],
  %w[Error  error]
]
```

## Object definitions

### `assertion_result`

Shared output shape for `assert_equals` and `assert_event_logged`.

```ruby
assertion_result: {
  fields: lambda do |_connection, _config|
    [
      { name: "passed",         type: "boolean" },
      { name: "failure_detail", type: "string", optional: true }
    ]
  end
}
```

The `assert_event_logged` output extends this with an additional
`event_id` field.

## Connection

```ruby
connection: {
  type: "custom_auth",
  authorization: { type: "custom_auth" },
  base_uri: lambda do |_connection|
    ""
  end
},

test: lambda do |_connection|
  { success: true }
end
```

Same connectionless pattern as the SDC Platform Connector. The connector
test always passes because there's nothing external to verify.

## What the test recipes look like with this connector

The five tier-1 tests get materially shorter. Sketch of
TEST-STS-01-happy-path with the test connector:

1. Variable assignment: `test_name`, `started_at`.
2. Call `create_pending_fixture` with `test_name = "STS-01-happy"`.
   Capture `fixture_id`.
3. Call STS-01 with the happy-path inputs. Capture `sts_response`.
4. Search SUP_SupplierRequest by `fixture_id`. Capture `post_row`.
5. Call `assert_equals` with `actual = sts_response.success`,
   `expected = true`, `field_label = "sts_response.success"`,
   `comparison_mode = boolean`. Capture `assertion_1`.
6. Call `assert_equals` with `actual = post_row.status`,
   `expected = "sent"`, `field_label = "post_row.status"`. Capture
   `assertion_2`.
7. Call `assert_event_logged` with `supplier_request_id = fixture_id`,
   `phase = "state_transition"`, `since = started_at`. Capture
   `assertion_3`.
8. Compute overall verdict: `if any of (assertion_1, assertion_2,
   assertion_3) failed → status = "failed", failure_detail = first
   failed assertion's detail. Else → status = "passed"`.
9. Call `record_test_result` with the computed verdict.
10. Teardown: delete fixture row, delete EventLog rows for
    `supplier_request_id = fixture_id`.

Ten steps, but the steps are flat and uniform. No conditional blocks
embedded in conditional blocks. Every assertion is a single action call
that returns a structured verdict; the recipe collects them and decides.

## What's deferred

Items consciously not built into v1:

- **`assert_field_unchanged`** — fetches a row, extracts a field,
  compares. Useful for "row was not mutated" checks. Deferred because
  the existing pattern (recipe captures pre-state, fetches post-state,
  calls `assert_equals` once per field) is more transparent. Add when
  the boilerplate becomes painful — likely Stage 4 or 5.

- **`teardown_fixture`** — deletes a SUP_SupplierRequest row plus its
  associated EventLog rows in one call. Deferred because the recipe-side
  teardown is two action calls and adding a method just to wrap them is
  speculative. Add if test counts grow and teardown patterns proliferate.

- **`assert_many`** — list-of-assertions DSL. Rejected per design
  principle 6.

- **Snapshot capture / diff actions** — "capture all four state fields,
  later compare against current values." Useful for the row-not-mutated
  assertion in illegal-transition and precondition-failure tests, but
  the value-by-value pattern is fine for now.

## Open questions

1. **Connector name.** Suggested: `SDC Test Harness`. Confirm before build.

2. **Fixture FK chain.** `create_pending_fixture` requires
   `fixture_supplier_id` and `fixture_version_id` as inputs. The static
   fixture set (TEST-supplier, TEST-template-version, etc.) needs to be
   created and its ids documented as known constants. Who creates them
   and where the ids are recorded — workspace property, hardcoded in
   the connector as defaults, documented in the test recipe spec — is
   undecided.

3. **Numeric epsilon for `assert_equals` numeric mode.** Default
   tolerance for float comparison is uncertain. Suggested: `1e-9`,
   tightened or loosened if real test data shows it matters.

4. **Connector versioning discipline.** The SDC Platform Connector is on
   its own version cadence; the test connector starts at v1.0.0. Any
   discipline about coordinated releases? Probably not needed for now,
   but worth a passing thought before scaling test-connector usage.

## Build estimate

Roughly 4–6 hours given Ruby SDK fluency:

- Skeleton + connection + test action: 30 min
- `record_test_result` action: 30 min (smallest; good first build)
- `assert_equals` action with all four comparison modes: 90 min
- `assert_event_logged` action: 60 min
- `create_pending_fixture` action: 60 min (Workato data-table writes
  via Ruby SDK have some shape-quirks worth budgeting for)
- Pick lists, object definitions, picklist hookup: 30 min
- Iteration on the five test recipes against the connector: 60 min

Realistic: a focused day. The five test recipes then take ~2 hours total
(having the connector means each is ~25 min).

Total Stage 1 verification: ~6–8 hours of work, producing both reusable
infrastructure and five passing tier-1 tests. Compared to the
recipes-only path (~5 hours, no reusable infrastructure), the marginal
investment is small relative to the durable benefit.
