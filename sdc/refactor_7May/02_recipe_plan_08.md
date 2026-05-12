# SDC Data Collection — Recipe Plan (v1, Stage 8 reminders)

## Status

Continuation through the full recipe plan series. This is the final substantive stage.

Stage 8 implements the **automated reminder** workflow. Two recipes:

- **REM-02 (Reminder Eligibility Evaluation)** — runs on a schedule, queries the active supplier-request population, identifies which requests are due for a reminder at which threshold.
- **REM-01 (Reminder Firing)** — per-request reminder send. Same shape as INV-02 (refresh outreach) but invoked automatically rather than by an analyst.

The split mirrors the system's general pattern of "query/decide" separate from "do." REM-02 evaluates and dispatches; REM-01 executes a single fire. Either can be tested in isolation: REM-02 by inspecting which requests it would call REM-01 for (without actually firing), REM-01 by invoking it for a specific request (without waiting for the schedule).

This is also the natural Stage 9/10 framing moment. After Stage 8, the recipe planning is complete; what remains are addenda for engagement closure (Stage 9, largely covered by REV-01 already) and monitoring (Stage 10, mostly a question of EventLog query and alert configuration rather than new recipes). The Stage 8 plan ends with notes on these.

---

## REM-02 — Reminder Eligibility Evaluation

### Identity
- **Code:** REM-02
- **Name:** Reminder Eligibility Evaluation
- **Domain:** REM
- **Role:** Trigger (scheduled — likely daily)

### Build queue stage
Stage 8.

### Capability
The scheduled job that decides which suppliers need reminders today. Reads the population of active supplier requests, applies the reminder threshold logic per `Project`, and calls REM-01 once per eligible (supplier_request, threshold) pair.

REM-02 fires on a schedule independent of any single supplier's actions. It's the only recipe in Stage 8 that's a trigger; REM-01 is callable.

### Contract

**Input (trigger schema):**
- Scheduled — no caller input. The recipe runs against the full active population.

**Output (return schema):**
- No return value (it's a scheduled trigger, not a callable). State communicated via EventLog and the REM-01 invocations.

### Substage outline

1. **Query the active request population.** Filter `SUP_SupplierRequest` to rows where `status` is `sent` or `supplier_action_required`. Other states (`pending`, `pending_review`, `approved`, `cancelled`) are not reminder-eligible.
2. **Join `Project` for thresholds.** For each active request, resolve `Project.reminder_days_1`, `_2`, `_3`. (Project is workspace-singleton, so this is effectively a single row read.)
3. **Query recent reminder events from EventLog.** One batched query: `severity=info AND phase=reminder_sent AND supplier_request_id IN (active_list) AND timestamp >= (today - max_threshold_days)`. Returns the recent reminder history per request. The query is bounded — no need to look beyond the longest threshold.
4. **Per-request eligibility computation.** For each active request, in a Python step (or equivalent Workato logic):
   - Compute `days_since_state_entry = today - current_state_entered_at`.
   - For each threshold (1, 2, 3) in order:
     - If `days_since_state_entry >= threshold_N_days` AND no `reminder_sent` event with `threshold=N` exists for this request: this request is eligible at threshold N.
   - A request can be eligible at multiple thresholds in theory (e.g., if REM-02 hadn't run for a week and the supplier crossed two thresholds since the last run). In practice, fire only the highest unfired threshold — the supplier doesn't need two emails in one day.
5. **Build the eligibility list.** Array of `{supplier_request_id, threshold_n, days_since_state_entry}` objects.
6. **Emit `eligibility_evaluated`.** Once, with the count of eligible requests in `details_json`. Useful for monitoring whether REM-02 is finding work. New phase — needs taxonomy addition.
7. **Per-eligible-request, call REM-01.** Asynchronously. Pass `supplier_request_id` and `threshold_n`. REM-02 does not wait for REM-01 results; each REM-01 invocation is independent.
8. **Emit `reminder_dispatch_complete`.** Once, at the end. Carries the dispatched count. New phase — needs taxonomy addition.

### Cross-cutting calls
- **REM-01** — once per eligible request, asynchronously
- **OBS-01** — for the summary events and any failure event

### Phases emitted
- `eligibility_evaluated` (new phase, one per REM-02 run)
- `reminder_dispatch_complete` (new phase, one per REM-02 run)
- `recipe_failed` (on infrastructure failure)

### Error types possible
- `recipe_invariant` — `Project` row missing (degenerate case in a workspace that's never been provisioned), thresholds null
- `external_action_failed` — Data Tables query failed, EventLog query failed
- `unexpected_error` — Python eligibility step crashed on edge-case data

### State transitions triggered
None. REM-02 reads state but doesn't write it.

### Invariants honored
- **Idempotent at the threshold level.** REM-02 checks EventLog for prior `reminder_sent` events at each threshold. If REM-02 runs twice in one day (manual rerun + scheduled run), the second run finds the prior events and fires nothing. Safe to re-run.
- **No cadence reset on retry.** If REM-01 fails for a request, REM-02's next run will re-evaluate that request and re-fire (because no `reminder_sent` event was logged for the failed attempt). Built-in retry without requiring explicit retry logic.

### Open questions
- **Schedule cadence.** Daily is the obvious default. Hourly is finer-grained but probably over-eager — supplier reminders shouldn't fire more often than once per day per supplier. Lean: daily, at a fixed hour (e.g., 9 AM in the workspace's timezone). Build-time configuration on the Workato schedule trigger.
- **Timezone handling.** Reminder thresholds are in days. "Days since state entry" depends on timezone arithmetic. If the engagement spans timezones (analyst in NY, supplier in Tokyo), whose "day" counts? Lean: workspace timezone, set on `Project`. Build-time decision; the plan reserves the input.
- **Multiple eligible thresholds — fire just the highest, or all?** Plan says fire just the highest. Alternative: skip the lower ones silently but log them as "would have fired." Lean: silent skip is fine — the supplier gets the most-urgent reminder, the lower ones are essentially moot once a higher threshold has been crossed.
- **EventLog query performance.** Worth measuring at scale. The batched query (Substage 3) is the hot spot. If it's slow at 1000+ active requests, options include indexing on `supplier_request_id` in EventLog (if Workato supports it) or maintaining a denormalized "last reminder fired" timestamp on `SUP_SupplierRequest` (would require a small schema change).
- **Cadence anchor: state-entry vs. most-recent-attempt.** The plan anchors reminders to `current_state_entered_at`. For a supplier stuck in `supplier_action_required` who's been actively trying (failing repeatedly), `current_state_entered_at` is when they *first* entered that state, not their most recent attempt. So reminders are based on "time since first failed," not "time since last failure." This is a real design choice — see cross-cutting notes for the discussion.

---

## REM-01 — Reminder Firing

### Identity
- **Code:** REM-01
- **Name:** Reminder Firing
- **Domain:** REM
- **Role:** Callable

### Build queue stage
Stage 8.

### Capability
Sends a single automated reminder email for a specific supplier request at a specific threshold. Same outward-facing shape as INV-02 (refresh outreach) — fresh link, email to active users, no state change — but invoked by REM-02 (scheduled) rather than by an analyst.

REM-01 doesn't do eligibility checking; it trusts REM-02 to have done that. If REM-01 is invoked for a request that's no longer eligible (state changed between REM-02's evaluation and REM-01's execution), it refuses gracefully.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `threshold_n` (integer, required) — 1, 2, or 3, indicating which threshold this reminder is for

**Output (return schema):**
- `users_emailed` (integer)
- `dispositions` (array of objects) — per-user `{user_email, disposition}`
- `link` (string)

### Substage outline

1. **Validate request state.** Read the request. REM-01 is valid only when the request is in `sent` or `supplier_action_required`. If the state changed between REM-02's evaluation and now (supplier resubmitted and is now in `pending_review`, analyst approved, analyst cancelled), refuse with `state_inconsistent` and emit `recipe_failed`. **Do not log a `reminder_sent` event in this case** — the reminder didn't actually go out, so REM-02 should reconsider eligibility next run.
2. **Resolve users.** Pull all `SUP_SupplierUser` rows where `status=active` for this supplier.
3. **Generate fresh link.** Call UTL-01 against `assigned_variant_template_path` (or `seeded_template_path` if set, matching INV-01/INV-02 preference).
4. **Per-user email.** Loop over users. Each gets a reminder email with the fresh link and threshold-specific text. The email's tone escalates with threshold — threshold 1 is gentle, threshold 3 is more urgent. Three templates, or one template with threshold-parameterized text; build-time detail.
5. **Emit `reminder_sent`.** One emit per user, severity `info`. `details_json` includes `threshold_n` (critical — REM-02's eligibility check relies on this).
6. **Return** the summary.

REM-01 is deliberately simple. Almost all the complexity is in REM-02; REM-01 is the executor.

### Cross-cutting calls
- **UTL-01** — for the fresh link
- **OBS-01** — for `reminder_sent` (one per user) and `recipe_failed` on failure

### Phases emitted
- `reminder_sent` (one per user; `threshold_n` in `details_json`)
- `recipe_failed` (on infrastructure or invariant failure)

### Error types possible
- `recipe_invariant` — request not found, zero active users
- `state_inconsistent` — request transitioned between REM-02's evaluation and REM-01's execution
- `external_action_failed` — UTL-01 failed, email send failed

### State transitions triggered
None. Reminders are pure outreach — they nudge, they don't move state.

### Invariants honored
- **Re-invite is a sibling, not a mode.** REM-01 is yet another sibling alongside INV-02, INV-03, INV-04. The cluster has four operational re-engagement recipes: INV-02 (analyst refresh), INV-03 (analyst adds user), INV-04 (analyst reassigns), REM-01 (automated reminder).
- **Frozen link lifecycle.** Like INV-02, REM-01 generates a fresh 10-day link. Multiple links may be live for the same request at any given time (initial INV-01, prior reminders, refresh outreaches). They all work until their TTL elapses.
- **EventLog-based reminder tracking.** REM-01's emit is what REM-02 reads to decide whether to fire again. This couples the two recipes through EventLog as the audit substrate — a deliberate choice over a denormalized field on `SUP_SupplierRequest`.

### Open questions
- **Email template per threshold.** Three templates (gentle / firm / urgent) or one template with threshold-parameterized language? Lean: three distinct templates, since tone differs meaningfully. Worth storing in `Project` as `reminder_template_1`, `_2`, `_3` paths, with system defaults.
- **What if user has `do not contact` preference?** Currently not modeled — `SUP_SupplierUser` has no opt-out field. If suppliers report "stop emailing me" as a real problem in production, add a `notification_preferences` field to `SUP_SupplierUser` and have REM-01 honor it. Defer until it's a measured need.
- **Idempotency within REM-01.** REM-01 itself has no idempotency guard — it trusts REM-02's eligibility check. If REM-01 is invoked twice in quick succession for the same request and threshold (REM-02 bug, manual re-trigger, retry storm), it would fire twice. Should REM-01 add its own guard?
  - Lean: no. The 60-second guard pattern is for analyst-initiated double-clicks; REM-02 is the system and shouldn't double-fire. If it does, that's a REM-02 bug to fix, not a REM-01 guard to add. Keep REM-01 simple.
  - Alternative: REM-01 reads recent `reminder_sent` events for this request + threshold before firing, refuses if one exists in the last hour. Cheap insurance against REM-02 bugs.
  - This is a build-time call; both are defensible.
- **Failure recovery.** If REM-01's email send fails for some users but not others, the recipe currently returns with mixed dispositions and emits `reminder_sent` only for those who actually received it. REM-02's next run will see the threshold as "fired" (because of the successful emits) and not retry. This means partial-success cases leave some users un-reminded. Worth flagging — the alternative is "no `reminder_sent` event unless all users got the email," which is stricter but means transient failures cause retries. Lean: per-user emit, accepting partial-success — same partial-success policy as INV-01.

---

## Stage 8 cross-cutting notes

**Cadence anchor — state-entry vs. most-recent-attempt.** The plan anchors reminders to `current_state_entered_at`. For a supplier in `supplier_action_required` who has failed validation three times, the reminder cadence counts from the *first* failure, not the most recent attempt. Two views:

- **Pro state-entry anchoring (the chosen approach):** The supplier is "stuck" regardless of how many times they've tried. Reminders nudge based on time-since-stuck, helping them. Repeated failed attempts shouldn't reset the cadence and let them stay stuck indefinitely without nudges.
- **Pro attempt-anchoring (the alternative):** Suppliers who try and fail are *engaged*; sending reminders to engaged suppliers is annoying. Cadence should reset on each attempt to acknowledge their activity.

The plan picks the first view but it's a real design choice worth surfacing. Worth verifying with the analyst stakeholders during build. Easy to switch later if needed — REM-02's eligibility logic changes; nothing structural moves.

**EventLog as the reminder tracking substrate.** Same pattern as INV-04's audit decision in Stage 7. Tracking reminders via EventLog events rather than a denormalized field on `SUP_SupplierRequest` avoids a schema change and keeps the audit history queryable in one place. The cost is that REM-02's eligibility query reads EventLog, which is more expensive than reading a single field. If this becomes a measured performance problem, the optimization is to denormalize — but the plan doesn't do that speculatively.

**Two new phases.** `eligibility_evaluated` and `reminder_dispatch_complete` (REM-02). Plus `reminder_sent` already existed conceptually but needs to be confirmed in the phase taxonomy. Stage 8 phase taxonomy amendment includes these three phases.

**The full INV+REM cluster after Stage 8.** Across Stages 4, 7, and 8, the system has five recipes for the supplier-engagement-management surface:

| Recipe | Trigger | Purpose |
|---|---|---|
| INV-01 | Analyst (batch action) | Initial invitation |
| INV-02 | Analyst | Refresh outreach (re-send to existing users) |
| INV-03 | Analyst | Add new user to request |
| INV-04 | Analyst | Reassign primary user |
| REM-01 | REM-02 (scheduled) | Automated reminder |

All five generate fresh links via UTL-01; none transitions state (INV-01 is the exception — it transitions `pending → sent`). The shape is consistent.

### Pre-positioned test cases for Stage 8

- **REM-02 happy path.** Three supplier requests in `sent`, each crossing a different threshold today. REM-02 fires three REM-01 calls (one per threshold). Each sends emails. EventLog records three `reminder_sent` events with appropriate `threshold_n` values.
- **REM-02 deduplication.** Run REM-02 twice on the same day. Second run sees the existing `reminder_sent` events and fires nothing.
- **REM-02 multi-threshold-crossing.** A supplier whose `current_state_entered_at` is 30 days ago (past all three thresholds) but has no prior `reminder_sent` events (e.g., REM-02 was disabled during a holiday). REM-02 should fire only the threshold-3 reminder, not all three.
- **REM-01 state-change race.** Invoke REM-01 for a request that transitioned to `pending_review` between REM-02's evaluation and REM-01's execution. REM-01 should refuse with `state_inconsistent`, no email sent, no `reminder_sent` event logged.
- **REM-01 partial-success.** Request has three active users; force email send to fail for one. Two `reminder_sent` events log, one doesn't. REM-02's next run sees the threshold as "fired" and doesn't retry. Verify this is acceptable behavior (per the open question above).
- **Cadence anchor.** Supplier enters `supplier_action_required` on day 0, resubmits and fails on day 5 (no state transition), resubmits and fails on day 10 (no state transition). On day 7 (threshold 1 if `reminder_days_1=7`), REM-02 fires a reminder. Verify that the threshold anchors on day 0, not day 5.

---

## Stage 9 and Stage 10 — addenda, not new recipes

The build queue named two stages after Stage 8:

**Stage 9 — Engagement closure.** Per the build queue, this stage covers what happens when a supplier reaches `approved` and the engagement record is finalized. Most of this is already in REV-01 (Stage 5): the approve path copies the file to `approved_path`, stamps `approved_at`, transitions state, emits events. The only remaining piece is a "did the engagement reach 100% supplier completion?" notion — Project-level rollup. Two options:

- (a) A small REM-style scheduled recipe (call it `PRJ-01` or similar) that checks "are all supplier requests in `approved` or `cancelled`? if so, mark the engagement complete." Runs daily.
- (b) A reactive recipe triggered on each REV-01 approval that queries the remaining open supplier requests for the project and, if zero, emits an `engagement_complete` event.

Lean (b). Reactive is simpler than scheduled here — the check is cheap and only matters at the moment of state change. Not worth a separate stage of recipe planning; can be added as a small substage of REV-01 or as a tiny REV-02. The plan reserves this as a Stage 9 build-time decision rather than a new recipe entry.

**Stage 10 — Monitoring.** Per the build queue, this stage covers alerting and operational dashboards. Most of this is *not* recipe work — it's EventLog query configuration, dashboard setup, alert routing. The one recipe-shaped piece might be an `alert dispatcher` that reads unresolved error rows from EventLog and routes them somewhere (email to ops, Slack, paging system). This was flagged in OBS-01's open questions as a sibling capability to OBS-01 itself.

Lean: a small `OBS-02` recipe (Alert Dispatcher) added in Stage 10 if needed, scheduled to run hourly, queries EventLog for unresolved `severity=error` rows older than N minutes, dispatches notifications, marks as `alert_sent=true`. Same structural shape as REM-02 (scheduled, reads EventLog, fires per-row work). Doesn't warrant full Stage 8-style planning treatment — it's straightforward enough to design and build in one pass.

Both addenda are intentionally light. The substantive recipe planning ends at Stage 8.

---

## Recipe plan series — closing summary

Across all eight stages, the system has planned recipes for every capability in the build queue:

| Stage | Recipes | Capability |
|---|---|---|
| 1 | UTL-01, OBS-01, STS-01 | Foundation utilities |
| 2 | CFG-01, TPL-01, VAL-01 | Pure-compute capabilities |
| 3 | PRV-01, PRV-02, PRV-03, PRV-04 | Provisioning workflows |
| 4 | INV-01 | Invitation |
| 5 | UPL-01, REV-01 | Submission + review |
| 6 | UPL-02, INC-01 | Smart-UX paths |
| 7 | INV-02, INV-03, INV-04 | Invite cluster siblings |
| 8 | REM-02, REM-01 | Reminders |

That's 18 recipes plus two routing decisions (R3 via WFA+VAL-01 directly, R6 via WFA+STS-01 directly) and two anticipated addenda (Stage 9 engagement closure, Stage 10 alert dispatcher).

The planning artifact achieves what it set out to: every recipe has a contract, a substage outline, a list of cross-cutting calls, a list of phases and error types it can emit, the state transitions it triggers (if any), the invariants it honors, and the open questions to settle before or during build. The work is concretely defined.

What this enables: status updates can name specific recipes ("planned 18 recipes across 8 stages with consistent contract format"), build sequencing is unambiguous (the build queue maps to specific recipe codes), reviews can be done per-recipe rather than against a vague "the system" target, and the canonical model shape spec gives consumers a stable reference.

What this does *not* do: it doesn't implement anything. The substage outlines name *what* each recipe does, not *how*. Per-recipe build work — Workato recipe construction, Python step authoring, connector action wiring, Data Tables operation specifics — happens when each recipe is built. The plan tells you what to build; the building is still ahead.
