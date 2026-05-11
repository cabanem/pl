# SDC Data Collection — Recipe Plan (v1, Stage 4 invitation)

## Status

Continuation of `sdc-recipe-plan-v1.md` (Stage 1), `sdc-recipe-plan-stage2.md` (Stage 2), and `sdc-recipe-plan-stage3.md` (Stage 3). Same template. Stage 4 has a single recipe — INV-01 — but it's the most consequential one in the system from the supplier's perspective, because it's the **first outward-facing recipe**.

Stage 4 implements **R1 (Issue invitation)**. The verification milestone after this stage is: "A real supplier user receives a real email with a real link." Per the build queue, this is the natural pause point for confirming the platform-side mechanisms (mail, link, portal access) work as expected before building five more capabilities on top of them.

---

## Domain code decision

The sibling scopes doc flagged a cross-cutting open question: none of the nine existing domain codes (PRV, CFG, VAL, UPL, STS, REM, REV, OBS, UTL) cleanly fits invite/outreach/access-management work. Candidates were `INV` for invitation, `ACS` for access, or `NTF` for notification. Absorbing into REM was also considered but REM is for reminder firing; outreach isn't a reminder.

**Decision: `INV` for invitation/outreach domain.** Reasoning:

- The work is fundamentally about invitations — first send, refresh, add user, reassign. "Invite" reads more naturally than "access" or "notify."
- "Access management" (`ACS`) implies a broader scope (deactivation, permissions) the system doesn't currently have.
- "Notification" (`NTF`) implies a generic outbound-messaging utility, which this isn't — these recipes have specific state-machine and business semantics, not just mail-send mechanics.
- INV cluster siblings (Refresh outreach, Add user to request, Reassign request) all read naturally under the same domain.

INV-01 is the primary; INV-02 (Refresh outreach), INV-03 (Add user to request), INV-04 (Reassign request) are siblings in Stage 7.

---

## INV-01 — Invite Supplier Users

### Identity
- **Code:** INV-01
- **Name:** Invite Supplier Users
- **Domain:** INV (invitation/outreach)
- **Role:** Callable

### Build queue stage
Stage 4. First outward-facing recipe in the system.

### Capability
Primary deep dive — Invite Supplier Users. The first capability that *reaches outward*: it grants people portal access, places tasks on their queues, and sends mail. Stage 4 verification — confirming real platform-side mechanisms work — happens through this recipe.

INV-01 is called per supplier request, from R1's batch action. R1 iterates over the analyst's selected requests; INV-01 handles one request at a time.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required) — the request to invite against
- `analyst_email` (string, required) — for sender identity and audit

**Output (return schema):**
- `transitioned` (boolean) — whether the request advanced to `sent`
- `assignee_disposition` (string) — `sent` | `failed`
- `secondary_dispositions` (array of objects) — per-user `{user_email, disposition}` for non-assignee users
- `link` (string) — the generated link (snapshot, for the caller's reference)

### Substage outline

Seven substages, following the deep dive's structure:

1. **Resolve the user list.** Read the supplier request; resolve the supplier; pull all `SUP_SupplierUser` rows where `status=active`. The user with `primary=true` is the designated assignee; the rest are secondary. If zero active users (degenerate case), emit `recipe_failed` with `recipe_invariant` and stop — CFG-01 should have caught this at config time.

2. **Resolve the template path.** Read the request's `assigned_variant_id`; resolve to `CFG_Variant.template_path`. If no path (the variant template was never produced — a provisioning failure), emit `recipe_failed` and stop.

3. **Generate the shareable link.** Call UTL-01 with the template path. Returns a 10-day link. Capture both the link (for embedding) and the path (for audit).

4. **Check idempotency guard.** If the request is already in `sent` state and `current_state_entered_at` is within the last 60 seconds, return early with `transitioned=false` and a sentinel `assignee_disposition=already_invited`. The double-click guard from the cluster resolutions. No emit on this path beyond a debug-level recipe_failed if desired — it's not really a failure, but it's worth flagging.

5. **Per-user side effects.** Loop over the user list:
   - **5a. Grant portal access.** Use the platform's access-grant mechanism, scoped to this request. (The mechanism — likely Workato's user-invite or a custom platform action — is build-time.)
   - **5b. Place the task on the user's queue.** For the assignee only — secondary users get access but not the task. Use the platform's task-creation mechanism.
   - **5c. Send the email.** Compose with `analyst_email` as sender, the link embedded, the outreach text from a stored template. Record success/failure as the user's disposition.
   
   The assignee is processed first; if assignee fails, the remaining users still get processed (eventual-with-hard-floor policy from the cluster resolutions), but the recipe returns without transitioning.

6. **State transition.** If the assignee succeeded (sent + task placed), call STS-01 with `target_state=sent`, `trigger_context=invitation_sent`. STS-01 writes the state, the display fields, the timestamp, and emits its own `state_transition` event.

7. **Emit invitation events.** Call OBS-01 once per user with `phase=invitation_sent`, severity `info`, `details_json` carrying the user_email and disposition. The deep dive specifies one emit per user — not one summary emit — because per-user invitation status is what analysts and ops will query.

### Cross-cutting calls
- **UTL-01** — for generating the shareable link
- **STS-01** — for the `pending → sent` transition
- **OBS-01** — for `invitation_sent` (one per user) and `recipe_failed` on infrastructure failure

### Phases emitted
- `invitation_sent` (one per supplier user emailed)
- `recipe_failed` (on any infrastructure failure)

Note: STS-01 emits `state_transition` when INV-01 calls it. That event is associated with STS-01 as the `source_recipe`, but it's part of the same workflow run. The phase taxonomy distinguishes these by source_recipe rather than by phase.

### Error types possible
- `recipe_invariant` — zero active users on the supplier (CFG-01 should have caught it but didn't); request not in `pending` state (R1's batch logic should have filtered, but didn't); template path missing
- `external_action_failed` — UTL-01 returned an error; portal access grant failed; task placement failed; email send rejected
- `state_inconsistent` — request is in a terminal state (`approved`, `cancelled`) — the analyst shouldn't have been able to select it, but if they did, refuse

### State transitions triggered
- `pending → sent` (via STS-01, after assignee success)
- The transition only fires if the assignee succeeded. If the assignee failed but secondary users succeeded, the request stays in `pending` and the analyst sees per-user dispositions showing partial success.

### Invariants honored
- **Per-user-task model: designated assignee, not shared.** Cluster resolution: portal access for all users, task assigned to the primary user only. INV-01 enforces this — secondary users get access but no task.
- **Partial-success policy: hard floor at the assignee.** Cluster resolution. The transition only fires when the assignee succeeded; secondary failures are reported but don't block the transition. Assignee failure with secondary success returns without transitioning and reports the failure.
- **Idempotency: 60-second guard.** Cluster resolution. A second call within 60 seconds of the prior `sent` transition returns no-op with `already_invited`. Outside the guard, INV-01 refuses with `state_inconsistent`.
- **Re-invite is a sibling, not a mode.** Cluster resolution. INV-01 invites; it does not re-invite. Refresh outreach (INV-02), Add user (INV-03), and Reassign (INV-04) are the legitimate paths for re-engagement after `sent`.

### Open questions
- **Where does the outreach email template live?** Three options. (a) Hardcoded in INV-01's email step. (b) A constant in the canonical model. (c) A project-level setting on `Project`. Lean (c) — the email content is engagement-specific (different clients, different tone, different language) and shouldn't require recipe changes to update. Worth adding to `Project` schema if not already there; alternatively, default to a system constant with `Project`-level override.
- **The platform access-grant mechanism.** This is build-time. Workato's user-invite action exists for analyst-side access but the supplier portal access model isn't fully spec'd. May involve creating WFA-app users programmatically; may involve a custom mechanism. The recipe plan assumes the action exists; the build will discover its actual shape.
- **Failure visibility to the analyst.** A partial-success run (assignee succeeded, two secondaries failed) doesn't fail the recipe — the transition fires. The analyst learns about the secondary failures only by querying EventLog or by reading the recipe's return value (`secondary_dispositions`). Worth confirming the WFA's batch-action UI surfaces these dispositions; if not, the analyst won't notice silent failures. Possibly INV-01 should emit a `severity=warn` event when any secondary fails, separate from the per-user `severity=info` emits, to make partial-success queryable as a category.
- **The 60-second idempotency guard's persistence.** The guard reads `current_state_entered_at`. If the analyst double-clicks within a few seconds, the second call sees the recent timestamp and exits cleanly. But what if there's a transient failure on the first call that leaves the state at `pending` despite the assignee succeeding? The second call would see `pending` and try again. Lean: this is acceptable — partial failures on the first call mean the second call gets a chance to complete the work. The guard is for the "successful first call, accidental double-click" case, not for failure recovery.
- **Email content variables.** The cluster resolutions specify the link, the supplier name, and submission instructions. Other variables (analyst signature, due date, custom guidance) may want to be in the template. Worth a small companion artifact — `inv-01-email-template-v1.md` — naming the canonical email template and its placeholder slots. Defer until INV-01 build starts; not blocking the plan.

---

## Stage 4 cross-cutting notes

Stage 4 has only one recipe, so cross-cutting notes are lighter than Stages 2 and 3. But three things are worth flagging because they extend across the broader system:

**This is the first stage with real outward-facing effects.** Stages 1–3 wrote to data tables and FileStorage. Stage 4 sends mail, grants access, places tasks on a portal that real suppliers will see. Failure modes here have real consequences in a way that earlier stages didn't. The pre-positioned tests should be deliberately conservative — use test addresses, test suppliers, sandboxed access.

**INV-01 defines the contract for the INV-cluster siblings.** INV-02 (Refresh outreach), INV-03 (Add user), and INV-04 (Reassign) all consume the same primitives INV-01 uses: UTL-01 for links, the platform's access-grant mechanism, the platform's task-management, the platform's email send. Getting these primitives clean in INV-01 means the siblings inherit them; getting them wrong in INV-01 means three more recipes have to work around the same problems.

**The verification milestone after Stage 4 is "real supplier sees real outreach."** End-to-end test: provisioning runs (Stage 3), one supplier is invited via R1 → INV-01, that supplier receives a real email with a working link, clicks the link, sees the template in their portal. The full happy-path chain — Stages 1 through 4 — is verifiable from this single end-to-end run.

### Pre-positioned test cases for Stage 4

From the build queue and the deep dive:

- **Happy path, single supplier.** One supplier with one user (the primary). End-to-end: provisioning → invitation → email received → link works.
- **Multi-user supplier.** One supplier with three users (one primary, two secondaries). All three get access; only the primary gets a task; all three get email.
- **Assignee failure with secondary success.** Force the primary user's email to fail (invalid address). Expect: secondaries succeed, request stays in `pending`, return value reports the assignee disposition as `failed`.
- **Idempotency double-click.** Call INV-01 twice in quick succession against the same `pending` request. Expect: first call succeeds and transitions, second call returns `already_invited` with no side effects.
- **Re-invite refusal.** Call INV-01 against a request already in `sent` state (outside the guard window). Expect: refused with `state_inconsistent`, pointing the analyst at INV-02 (Refresh outreach).

---

## What's next

**Stage 5 — Submission + Review:**
- UPL-01 (File submission intake / R2 trigger)
- REV-01 (Analyst review handler / R5)
- (R6 cancellation likely needs no dedicated recipe; cancellation routes through STS-01 with `trigger_context=analyst_cancel` from the WFA)

Stage 5 is the supplier-side counterpart to Stage 4 — Stage 4 invited them, Stage 5 receives what they send back. The validation pipeline from Stage 2 (VAL-01) finally runs end-to-end in Stage 5, because Stage 5 is where the recipes that *call* VAL-01 come into existence.

Three recipes (two of substance plus the R6-via-STS-01 routing) means Stage 5 will be the longest planning artifact since Stage 3. After that, Stages 6 (smart-UX), 7 (INV siblings), 8 (reminders) are smaller.
