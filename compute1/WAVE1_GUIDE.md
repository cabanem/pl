# Wave 1 — SDC Compute connector

Six actions that replace six Python steps. Rows in, decision out. No I/O.

| Action | Replaces | Recipe · step |
|---|---|---|
| `plan_primary_user_change` | INV-04 "Evaluate verdict (promote \|\| create)" | 2286522 · #15 |
| `plan_task_ensure` | INV-02 "Ensure task" | 2202944 · #18 |
| `classify_requests_by_task` | UTL-06 "Filter and emit lists" | 2203181 · #14 |
| `compute_reminders` | REM-02 "Compute reminders" | 2148602 · #7 |
| `build_request_rows` | REQ-01 "Resolve variant path and build record" | 2115623 · #19 |
| `plan_user_migration` | MIG-01 "Plan migration" | 2286232 · #7 |

## What is in the package

```
sdc_compute_connector.rb     the connector: object_definitions, methods, six actions (1,246 lines)
test/fixtures.json           43 cases, in the connector's vocabulary, covering every branch of the six steps
test/goldens.py              runs the ORIGINAL Python steps on the fixtures -> goldens.json
test/run_ruby.rb             runs the connector's actions on the fixtures with a stand-in SDK runtime -> ruby_out.json
test/compare.py              field-by-field comparison; masks minted UUIDs and "now" timestamps
test/goldens.json, ruby_out.json   the outputs from the run recorded below
```

Result of the recorded run: **43/43 match**. One case carries two documented divergences (section 6).

## 1. Load it

Two ways. Do the first one first — it proves the runtime — then decide.

**As its own connector (for testing).** Tools → Connector SDK → New → paste the whole file → Save. Create a connection
(no fields). In the debugger, run `build_request_rows` with the `success` fixture input. If it returns an `ok: true`
envelope with two UUIDs and a timestamp, `SecureRandom`, `Time` and `String#to_time` are all reachable in your runtime.

**Into the existing SDC connector (the design record's recommendation).** Copy the three blocks — everything under
`object_definitions:`, `methods:` and `actions:` — into the matching sections of the existing connector. Before you
paste, search the existing connector for these names; none may already exist: object definitions
`result_envelope, supplier, supplier_user, supplier_request, variant, primary_user_plan, task_plan, request_task_view,
supplier_stats_row, pending_reminder, migration_row`; methods `to_bool, clean, norm, to_int, rows, parse_time, iso,
now_iso, new_uuid, ok, fail`. If the existing connector has its own `clean` or `fail`, rename the Wave 1 copy in both
places (definition and every `call(:...)`), or better, reconcile them into one. Keep the three `require` lines at the
top of the file.

## 2. Re-run the goldens (and add real ones)

```
python3 test/goldens.py  <python_steps_dir>  test/fixtures.json  test/goldens.json
ruby    test/run_ruby.rb sdc_compute_connector.rb test/fixtures.json test/ruby_out.json
python3 test/compare.py  test/goldens.json test/ruby_out.json
```

`<python_steps_dir>` is the `python_steps/` folder from the Phase 2 package (one `.py` per step; the goldens script
finds the six by recipe id).

To add a real case: open a recent job of the recipe, copy the Python step's **input** tree, translate the keys with the
table in section 3 (the same renames the recipe mapping will do), and append it to the action's list in
`fixtures.json`. The golden generator runs the original Python on it; the comparison tells you whether the Ruby
agrees. This is how a conversion is proven before the recipe is touched.

## 3. The one-time vocabulary mapping

When you add the connector step, map the query's columns onto the entity fields once. These are the renames, per
action. Anything not listed keeps its name.

**plan_primary_user_change (INV-04)** — scalars unchanged. `users` rows: unchanged (`record_id, supplier_user_id,
user_email, primary`). New: `move_task` is now a real input (default true); the Python read it but never declared it.
Drop `supplier_id` and `stage_name` from the mapping — they were declared and never read.

**plan_task_ensure (INV-02)** — scalars unchanged. `users` rows: `user_status → status`.

**classify_requests_by_task (UTL-06)** — `requests` rows unchanged. `suppliers` rows: `sup_supplier_id → supplier_id`.
`supplier_users` rows: `user_supplier_id → supplier_id`, `user_status → status`.

**compute_reminders (REM-02)** — scalars: `proj_reminder_cadence → reminder_cadence_days`,
`proj_max_reminders → max_reminders`. `requests` rows: `req_id → supplier_request_id`, `req_supplier_id → supplier_id`,
`req_supplier_name → supplier_name`, `req_status → status`, `req_submission_attempt → submission_attempt`,
`req_reminder_count → reminder_count`, `req_state_entered_time → current_state_entered_at`,
`req_last_reminder_sent → last_reminder_sent_at`, `req_reminders_enabled → reminders_enabled`. `supplier_users` rows:
`user_id → supplier_user_id`, `user_supplier_id → supplier_id`, `user_contact_name → contact_name`,
`user_primary → primary`, `user_status → status`, `user_kickoff_sent_at → kick_off_email_sent_time`.

**build_request_rows (REQ-01)** — unchanged.

**plan_user_migration (MIG-01)** — `variants` rows: `version_id → template_version_id`. The `variant_id1` /
`supplier_id2` suffix tolerance is gone; map the real column once and the suffixes never appear.

## 4. Recipe edits, per action

The pattern is the same six times: add the connector action **after** the Python step, map its inputs (section 3),
repoint every downstream pill from the Python step to the action, run one job, delete the Python step. The downstream
pills come from the manifest; they are listed here so nothing is missed. Output names are unchanged unless marked.

**INV-04 · plan_primary_user_change.** Steps 16–41 read: `ok`; `plan.task_action`, `plan.mode`,
`plan.target_record_id`, `plan.supplier_user_id`, `plan.disposition`, `plan.demote_rows[].record_id`,
`plan.drift_detected`, `plan.drift_note`, `plan.reassign`, `plan.old_primary_email`; `noop`. Step 17 (the alert)
reads `error_message`, `phase`, `error_type` → now `error.message`, `error.code` (there is no `phase`; the alert can
say "recipe_failed" literally). Step 18's `error_message` → `error.message`.
*This is the live defect: today every `plan.*` pill above resolves to nothing. Confirm on a recent job before and after.*

**INV-02 · plan_task_ensure.** Steps 19–26 read `mode`, `reason`, `ok`, `drift_detected`, `drift_note`,
`plan.assignee_email`, `plan.currently_assigned_user_email`, `plan.is_reassignment`, `plan.task_name`,
`plan.days_to_complete_task`, `plan.workflow_app_stage`, `plan.send_email` — all unchanged. `error_type` (read
nowhere today) is `error.code`.

**UTL-06 · classify_requests_by_task.** Step 15 (`return_result`) reads `expired_task_detail[]` and `counts.*` —
`expired_task_detail` is now `requests` (same row shape), `expired_tasks_count` is now `matched_count`. The WFA-002 /
WFA-002a callers map through UTL-06's own `return_result`, so only step 15 changes. The `condition` input is a
pick list (expired / stranded / active / all) with a pill toggle.

**REM-02 · compute_reminders.** Step 8 reads `rows[]` (and its `users[]`) and `pending_reminders[]` — unchanged.
`log` is an array of strings, as before. The two loud failures (no clock, zero cadence) raise a job error, as the
Python did on purpose; keep the recipe's catch.

**REQ-01 · build_request_rows.** Steps 20–31 read `ok`, `error` (→ `error.message`), `supplier_request_id`, and
`supplier_request_row.*` — unchanged. `supplier_user_row` now carries `user_email` and `contact_name` (the Python
emitted `assignee_email` / `assignee_contact_name` under a schema that declared `user_email` — the latent drift from
the design record). Nothing reads `supplier_user_row.*` today; when something does, it gets the declared name.

**MIG-01 · plan_user_migration.** Steps 8–22 read `ok`, `error` (→ `error.message`), `held_count`,
`flagged_count`, `migrate_count`, `flagged[]` (`supplier_request_id, supplier_name, reason, old_variant_id`) —
unchanged. `will_reseed` is a checkbox (a pill still works; it goes through `to_bool`).

Order: REQ-01 first (it writes the two entity shapes), INV-02 and INV-04 together, then UTL-06, REM-02, MIG-01.

## 5. What each action fixes on the way through

- INV-04 returns `plan` nested — the shape nine downstream steps already read.
- PRV-01 is Wave 4, but the envelope rule it violated (`error` vs `reason`) cannot recur: every action's failure goes
  through one `fail(code, message, blank_payload)` and the output definition is written in the same file.
- REQ-01's user row carries the field its schema always declared.
- `move_task` (INV-04) is a declared input instead of a permanently-true ghost.

## 6. Documented behaviour changes (decisions, not accidents)

1. **Truthiness.** One set everywhere: `true, 1, yes, y, t`, any case, booleans pass through, blank → the caller's
   default. Effects: UTL-06 read `primary` as true only for the literal string `true` — a `"1"` or `"yes"` primary is
   now recognised. MIG-01 did not accept `"y"`; it does now. INV-04 already used this set.
2. **Blank flag = unset.** REM-02's `_is_true` returned the default only for `None` and read `""` as false; an
   empty `reminders_enabled` pill therefore silently disabled reminders for that request. The connector reads blank as
   unset (default true) and logs the skip reason if the request is then skipped for another cause. *Worth checking
   whether any live SUP_SupplierRequest row has a blank `reminders_enabled` — if so, those suppliers have not been
   reminded.* (Fixture `compute_reminders/no_users_no_emails_default_cap` shows the difference.)
3. **Strings are cleaned.** Every string field of an echoed user row is stripped; the Python echoed raw values in
   REM-02's `users[]`. Comparisons were already stripped in both.
4. **Integers.** `"12"`, `"12.0"` and `12.0` all read as 12; blank or garbage → the default. Python's `int("12.0")`
   raised and fell to the default.
5. **Timestamps.** `now_iso` is `%Y-%m-%dT%H:%M:%SZ` everywhere (REQ-01 used Python's `isoformat()` with
   microseconds and `+00:00`). Parsed times are echoed as `…+00:00`, matching the Python.
6. **Error codes.** Where the Python had only a message (REQ-01, MIG-01), the action assigns a code:
   `recipe_invariant` for a blank required input, `state_inconsistent` for a state the data should not be in.

## 7. Runtime notes to verify once

- `require 'json' / 'securerandom' / 'time'` at the top of the file — allowed since the whitelist removal (full
  Ruby 2.7 standard library). If the editor rejects a `require`, `JSON` and `Time` are normally preloaded and only
  `SecureRandom.uuid` needs an alternative (`workato.uuid` if your runtime has it, or a `rand`-based v4 in `new_uuid`).
- `String#to_time` is the SDK's ActiveSupport method; on Workato's UTC hosts a naive string reads as UTC, which is
  what the Python assumed. Strings with an explicit offset keep it.
- `next call(:fail, …)` is the early-return idiom inside `execute`; it is plain Ruby and the harness exercises it.
