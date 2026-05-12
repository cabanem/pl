# SDC Data Collection — Recipe Plan (v1, Stage 7 invite cluster siblings)

## Status

Continuation through the full recipe plan series. Same template.

Stage 7 implements the **INV-cluster siblings** — INV-02, INV-03, INV-04. All three are post-`sent` re-engagement operations: refresh outreach, add a user, reassign the request. They share primitives with INV-01 (Stage 4) but have distinct semantics; the cluster resolutions earlier decided these are *siblings*, not modes of INV-01.

None of the three is conceptually large. The reason for three separate recipes rather than one is that conflating them would force INV-01-like logic to do triple duty with branching that obscures intent. Each sibling has a clear name and a clear contract; the WFA exposes them as distinct analyst actions.

---

## INV-02 — Refresh Outreach

### Identity
- **Code:** INV-02
- **Name:** Refresh Outreach
- **Domain:** INV
- **Role:** Callable

### Build queue stage
Stage 7.

### Capability
Re-sends the invitation to existing users on a supplier request. Same users, same access, fresh link, fresh email. The "I want to re-engage this supplier without changing anything structural" path.

INV-02 is the recipe analysts reach for when a supplier has gone quiet and the analyst wants to nudge. Distinct from REM-01 (Stage 8 reminders), which is automated; INV-02 is analyst-initiated.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `analyst_email` (string, required) — for sender identity and audit
- `optional_message` (string, optional) — analyst can add a personal note to the refresh email

**Output (return schema):**
- `users_emailed` (integer)
- `link` (string) — the new link, for the analyst's reference
- `dispositions` (array of objects) — per-user `{user_email, disposition}`

### Substage outline

1. **Validate request state.** Read the request. INV-02 is valid only when the request is in `sent` or `supplier_action_required`. If in `pending` (never invited), `pending_review` (already submitted), `approved`, or `cancelled`, emit `recipe_failed` with `state_inconsistent` and stop. The WFA should not have offered the action; if it did, refuse.
2. **Check idempotency guard.** If the request has a recent `invitation_sent` or `refresh_outreach_sent` event within the last 60 seconds, return early with `dispositions=[]` and a sentinel disposition `already_refreshed`. The double-click guard.
3. **Resolve users.** Pull all `SUP_SupplierUser` rows where `status=active` for this supplier. Same set as INV-01 reads — the assignee plus secondaries.
4. **Generate a fresh link.** Call UTL-01 against `assigned_variant_template_path` (or `seeded_template_path` if set, matching INV-01's preference).
5. **Per-user email.** Loop over users. Each gets a refresh email with the new link and the analyst's `optional_message` (if supplied). Record per-user dispositions. **No access grants, no task placements** — these are unchanged from the initial invitation. INV-02 is email-only.
6. **No state transition.** The request remains in its current state (`sent` or `supplier_action_required`). Refresh outreach doesn't transition; STS-01 is not called.
7. **Emit `refresh_outreach_sent`.** One emit per user, severity `info`. New phase — needs taxonomy addition.

### Cross-cutting calls
- **UTL-01** — for the fresh link
- **OBS-01** — for `refresh_outreach_sent` per user and `recipe_failed` on infrastructure issues

### Phases emitted
- `refresh_outreach_sent` (new phase, one per user)
- `recipe_failed` (on infrastructure failure)

### Error types possible
- `recipe_invariant` — zero active users (shouldn't happen if INV-01 succeeded previously); request in an invalid state
- `state_inconsistent` — request was cancelled or approved between WFA load and click
- `external_action_failed` — UTL-01 failed, email send failed

### State transitions triggered
None. INV-02 is deliberately stateless in the supplier-request sense — it sends mail, nothing more.

### Invariants honored
- **Re-invite is a sibling, not a mode.** INV-02 exists *because* INV-01 refuses to re-invite. The handoff is clean: INV-01 for initial, INV-02 for refresh.
- **60-second idempotency.** Same guard as INV-01.
- **Frozen link lifecycle.** Each call to INV-02 produces a fresh 10-day link via UTL-01. The prior link doesn't expire early — both work until their natural TTL elapses. Suppliers who clicked the old link can still resubmit.

### Open questions
- **Email content for the refresh.** Should it use the same template as INV-01 or a distinct "we haven't heard from you" template? Lean: distinct template. The supplier already knows about the engagement; a "first invitation" tone is wrong. Worth flagging in the engagement settings spec — `Project.refresh_email_template_path` or a constant.
- **The optional message field.** Analyst can add a personal note. Does it appear inline in the email body, as a quoted block, or in a separate paragraph? Build-time detail; the plan reserves the input.
- **Should INV-02 also place new tasks?** No — existing tasks are still on the assignee's queue from INV-01. Placing a duplicate task would be confusing. INV-02 is email-only; tasks remain whatever INV-01 / INV-04 set them to.
- **Cadence limits.** Should INV-02 refuse if the last refresh was within, say, 24 hours? The 60-second guard prevents accidental double-click; a longer guard would prevent analyst over-nagging. Lean: no system-side limit beyond the 60s guard. Analysts know their suppliers; the system shouldn't paternalize. If this turns out to cause problems in production, add a soft-warn at the WFA layer rather than refusal at the recipe layer.

---

## INV-03 — Add User to Request

### Identity
- **Code:** INV-03
- **Name:** Add User to Request
- **Domain:** INV
- **Role:** Callable

### Build queue stage
Stage 7.

### Capability
Adds a new user to an existing supplier request, granting portal access and (optionally) emailing them. Two paths: activating an existing inactive `SUP_SupplierUser` row, or creating a new row entirely.

The analyst invokes INV-03 when the original config didn't include someone who should be involved — a contact discovered mid-engagement, a backup person in case the assignee is unavailable, an executive sponsor who wants visibility.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `analyst_email` (string, required)
- `mode` (string, required) — `activate_existing` | `create_new`
- `existing_user_id` (string, conditional) — required when `mode=activate_existing`
- `new_user_email` (string, conditional) — required when `mode=create_new`
- `new_user_name` (string, conditional) — required when `mode=create_new`
- `role` (string, required) — `primary` | `secondary`. **If `primary`, this triggers reassignment-like semantics** — see open questions.

**Output (return schema):**
- `user_id` (string) — the user's ID (existing or newly created)
- `disposition` (string) — `added` | `already_active` | `failed`
- `task_placed` (boolean) — whether the user got a task (true only if `role=primary` and the assignee changed)

### Substage outline

1. **Validate request state.** INV-03 is valid in `sent`, `supplier_action_required`, or `pending_review`. Not in `pending` (no invitation has fired; adding users at this stage should happen via the config workbook re-publish, not a per-request action), not in `approved` or `cancelled`. Emit `recipe_failed` with `state_inconsistent` if invalid.
2. **Branch on mode.**
   - **`activate_existing`:** Read `SUP_SupplierUser` by `existing_user_id`. Verify it belongs to this request's supplier. If `status=active`, return early with `disposition=already_active`. If `status=inactive`, proceed.
   - **`create_new`:** Validate email format. Check whether a `SUP_SupplierUser` row already exists for this supplier + email — if so, branch to `activate_existing` logic with the found row. If not, create a new `SUP_SupplierUser` row with `status=inactive` initially.
3. **Handle role.** If `role=primary` and the request currently has a different primary, **this is a reassignment** — refuse and direct to INV-04. INV-03 is for adding users, not changing assignment. Emit `recipe_failed` with `recipe_invariant` and a clear message. (Alternative: INV-03 delegates to INV-04 automatically; lean refuse-and-redirect to keep the recipes' intents distinct.)
4. **Activate the user.** Update `SUP_SupplierUser.status` to `active`. Stamp `activated_at`.
5. **Grant portal access.** Same mechanism INV-01 uses, scoped to this request.
6. **Place a task (if applicable).** Only if `role=primary` AND no current primary exists. Otherwise, no task — secondaries get access without tasks.
7. **Generate a link and send email.** Call UTL-01 for a fresh link. Send the new user an invitation email. (Existing users on the request are *not* re-emailed; they already know.)
8. **No state transition.** The supplier request stays in its current state. Adding a user is independent of the supplier-action flow.
9. **Emit `user_added`.** One emit, severity `info`. New phase — needs taxonomy addition.

### Cross-cutting calls
- **UTL-01** — for the fresh link
- **OBS-01** — for the success event and any failure

### Phases emitted
- `user_added` (new phase)
- `recipe_failed` (on infrastructure or invariant failure)

### Error types possible
- `recipe_invariant` — `role=primary` while another primary exists, mode/parameters mismatched, request in an invalid state
- `state_inconsistent` — request was cancelled or approved between WFA load and click
- `external_action_failed` — Data Tables write failed, access grant failed, email send failed

### State transitions triggered
None for the supplier request.

For the user, an implicit "transition" from `inactive` to `active` on `SUP_SupplierUser` — but `status` on the user row isn't governed by STS-01 (which only writes supplier-request status). INV-03 writes it directly.

### Invariants honored
- **Exactly one primary user per supplier.** INV-03 enforces this in Substage 3 — adding a primary when one exists is refused.
- **User identity is supplier-scoped, not request-scoped.** `SUP_SupplierUser` is tied to `SUP_Supplier`, not to `SUP_SupplierRequest`. INV-03 adds a user to *a request*, but the underlying user row is shared if the supplier has multiple requests (which currently doesn't happen — one request per supplier per engagement — but the data model supports it).

### Open questions
- **Primary-role addition.** Currently refused, redirected to INV-04. Alternative: INV-03 with `role=primary` accepts the demotion of the existing primary (with a `prior_primary_disposition` parameter). This collapses INV-03 and INV-04 into one recipe. Lean: keep separate. The intents are different — "I want to add this person" vs "I want to change who's leading" — and the WFA can show distinct analyst actions for clarity.
- **Email-only vs. with-link.** If the new user is a secondary (visibility-only role), do they need a link to act on, or just access to view? Lean: send the link anyway. Secondary users can still submit if the primary is unavailable; the link enables that. The role distinction is task placement, not link access.
- **Re-using existing user rows across suppliers.** The data model has `SUP_SupplierUser` rows per supplier. What if the same person (same email) is added as a user across multiple suppliers? Each gets its own `SUP_SupplierUser` row with the same email. Lean: this is fine — the row represents the user-in-the-context-of-this-supplier, not the user as a global identity. Different suppliers, different access scopes, same person.
- **WFA action filtering.** The WFA should only offer INV-03 in states where it's valid (per Substage 1). Worth confirming the WFA's action-availability logic matches the recipe's accepted states. If they drift, suppliers see actions that fail when clicked.

---

## INV-04 — Reassign Request

### Identity
- **Code:** INV-04
- **Name:** Reassign Request
- **Domain:** INV
- **Role:** Callable

### Build queue stage
Stage 7.

### Capability
Changes who's primary on a supplier request. The old primary may be demoted to secondary or deactivated; the new primary takes over the task. Email goes to both.

INV-04 is invoked when the original assignee is no longer the right person — they've left the company, they're not the right contact for this engagement, the supplier reorganized.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `analyst_email` (string, required)
- `new_primary_user_id` (string, required) — must be an existing `SUP_SupplierUser` for this supplier
- `prior_primary_disposition` (string, required) — `keep_as_secondary` | `deactivate`
- `reason` (string, optional) — analyst's reason, persisted for audit

**Output (return schema):**
- `transitioned` (boolean) — always false; INV-04 doesn't transition supplier-request state
- `prior_primary_user_id` (string)
- `new_primary_user_id` (string)
- `prior_primary_disposition` (string) — echoed

### Substage outline

1. **Validate request state.** Same as INV-03 — `sent`, `supplier_action_required`, `pending_review` are valid. Refuse otherwise with `state_inconsistent`.
2. **Check idempotency guard.** If a `reassignment_complete` event fired in the last 60 seconds for this request, return early.
3. **Resolve the new primary.** Read `SUP_SupplierUser` by `new_primary_user_id`. Verify it belongs to this request's supplier. Verify it's not already the primary (no-op refusal — emit `recipe_failed` with `recipe_invariant`). If status is `inactive`, that's fine — the reassignment activates them.
4. **Identify the prior primary.** Read all `SUP_SupplierUser` rows for the supplier where `primary=true`. There should be exactly one. If zero (data inconsistency), refuse. If more than one, refuse — the data model invariant is broken and reassigning would make it worse.
5. **Atomic role swap.** Update both rows in sequence:
   - Set the prior primary's `primary` to false.
   - If `prior_primary_disposition=deactivate`, set `status` to `inactive` and revoke their portal access via the platform mechanism.
   - If `prior_primary_disposition=keep_as_secondary`, leave their `status=active` and their portal access intact.
   - Set the new primary's `primary` to true. If their `status=inactive`, set it to `active` and grant portal access.
6. **Move the task.** Remove the task from the prior primary's queue. Place a task on the new primary's queue. Both are platform-side mechanisms.
7. **Generate a fresh link.** Call UTL-01. The new primary's email needs an active link.
8. **Email both parties.**
   - New primary: invitation-style email with link, noting they've been assigned.
   - Prior primary: notification email — either "you're now a secondary, no action needed" (keep_as_secondary) or "you've been removed from this engagement" (deactivate). Tone matters; build-time detail.
9. **Persist a `RUN_ReviewNote`-style audit row.** Records the reassignment with the reason. (May warrant its own `RUN_AssignmentChange` table; current data model doesn't have one. Worth flagging.)
10. **No state transition.** The supplier request stays in its current state. The state machine has no "request was reassigned" state; the change is in user composition, not request state.
11. **Emit `reassignment_complete`.** One emit, severity `info`. New phase — needs taxonomy addition.

### Cross-cutting calls
- **UTL-01** — for the fresh link
- **OBS-01** — for the reassignment event and any failure

### Phases emitted
- `reassignment_complete` (new phase)
- `recipe_failed` (on infrastructure or invariant failure)

### Error types possible
- `recipe_invariant` — new primary not found, new primary already primary, zero or multiple existing primaries, request in an invalid state
- `state_inconsistent` — request was cancelled or approved between WFA load and click
- `external_action_failed` — any platform-side mechanism (access grant, task move, email) failed

### State transitions triggered
None on the supplier request. Implicit `primary` flag flip on two `SUP_SupplierUser` rows.

### Invariants honored
- **Exactly one primary user per supplier.** INV-04's Substage 5 enforces this via the atomic swap. Worth noting the swap is *not* truly atomic across two Data Tables operations in Workato — there's a moment between the unset and the set where zero primaries exist. If a query runs at that moment, it sees an inconsistent state. Worth a build-time check on whether this matters in practice. Mitigation: do the *set* first (creating a brief two-primary state), then the *unset* (returning to one primary). Two primaries momentarily is less broken than zero primaries momentarily — a query in the middle sees an over-eager state rather than a missing one. Lean: set first, unset second.
- **Audit trail.** Every reassignment is recorded. The reason field is optional but encouraged.

### Open questions
- **The atomic-swap question.** Flagged above. Worth a build-time decision and an entry in the architectural decisions register.
- **Where the assignment-change audit row lives.** Current data model has `RUN_ReviewNote` for analyst-driven actions on submissions, but no analogous table for assignment changes. Three options: (a) reuse `RUN_ReviewNote` with a `kind` field, (b) add a new `RUN_AssignmentChange` table, (c) only store the audit info in EventLog via the `reassignment_complete` event's `details_json`. Lean (c) — EventLog already exists, the audit is queryable, no schema change needed. The cost is that surfaces wanting "history of assignment changes for this supplier" have to query EventLog rather than a dedicated table; acceptable.
- **What if the new primary was already a secondary?** Substage 3 handles this — they get promoted. Their portal access is unchanged (they had it as secondary); they get a task they didn't have before; they get an email noting the change.
- **What if `deactivate` is chosen and the prior primary had submitted recently?** Their submission record (`RUN_Upload`, `RUN_ValidationResult`) is unaffected — those rows are historical. Deactivation only removes future access and task. Submissions in flight aren't rolled back.
- **Cadence considerations.** Repeated reassignments in quick succession (analyst keeps changing their mind) — the 60s guard catches accidents; beyond that, no system-side limit. Same principle as INV-02.

---

## Stage 7 cross-cutting notes

**The three siblings share INV-01's primitives but make distinct choices about which to use.**

| Primitive | INV-01 | INV-02 | INV-03 | INV-04 |
|---|---|---|---|---|
| Generate fresh link via UTL-01 | yes | yes | yes (for new user) | yes (for new primary) |
| Grant portal access | yes | no (existing) | yes (new user) | yes (new primary if inactive) |
| Place task on assignee queue | yes | no | only if primary and none exists | yes (move from old to new) |
| Send email | yes (all users) | yes (all users) | yes (new user only) | yes (both parties) |
| Transition state | yes (`pending → sent`) | no | no | no |
| 60-second idempotency guard | yes | yes | weak (data-layer no-op) | yes |

The pattern: INV-01 does everything; siblings do *some* of it. None of the siblings transitions state — that's specific to the initial invitation. All three reuse the fresh-link discipline, which is what Invariant 8 (path canonical, link volatile) makes possible.

**Three new phases are introduced in Stage 7.** `refresh_outreach_sent`, `user_added`, `reassignment_complete`. All belong in the supplier-engagement phase category alongside `invitation_sent`. The phase taxonomy needs amendment when Stage 7 is built.

**WFA action filtering matters more than usual.** Each sibling has tight state-validity rules. The WFA must only offer the action when the state allows it; if WFA action availability drifts from recipe state-validity, analysts will hit `state_inconsistent` errors that look like bugs. Worth a WFA / recipe synchronization check during build.

**No new STS-01 derivation rows are needed.** None of the three siblings calls STS-01, because none transitions state. STS-01's derivation table is unchanged by Stage 7. (Contrast with Stage 6, where REV-01's corrections branch added a row.)

### Pre-positioned test cases for Stage 7

- **INV-02 happy path.** Request in `sent`, supplier hasn't acted, analyst clicks refresh, all users get a new email with a fresh link, no state change.
- **INV-02 in `supplier_action_required`.** Same as above but the request is mid-failure-cycle. Verifies INV-02 works there too.
- **INV-02 idempotency.** Double-click within 60 seconds. Second call returns early without firing emails.
- **INV-03 activate-existing happy path.** Add an inactive user as secondary. Verify activation, access grant, no task placement.
- **INV-03 create-new happy path.** Add a brand new user (not in `SUP_SupplierUser` yet). Verify row creation, activation, access grant, email send.
- **INV-03 refusal on primary collision.** Try to add a user with `role=primary` when a primary exists. Expect refusal, redirect to INV-04.
- **INV-04 reassign with `keep_as_secondary`.** Verify old primary becomes secondary, retains access, loses task. New primary gets task and link.
- **INV-04 reassign with `deactivate`.** Verify old primary loses access entirely. New primary takes over.
- **INV-04 atomic swap stress test.** Force an interruption between the unset-old-primary and set-new-primary calls. Verify the state is recoverable; ideally the recipe is idempotent on retry.

---

## What's next

**Stage 8 — Reminders:**
- REM-01 (Reminder firing)
- Reminder eligibility — likely a callable separate from REM-01 (worth deciding during planning)

After Stage 8, the recipe planning artifact is complete. The build queue's Stages 9 (engagement closure) and 10 (monitoring) are small enough to fold into existing recipes or warrant a brief addendum rather than full per-recipe plans.

Stage 8 is the last substantive stage. After it, the system has a complete recipe scope from foundation utilities through automated reminders.
