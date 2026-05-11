# SDC Data Collection — Capability Deep Dive: Invite Supplier Users (v1, Phase 0)

## Status

Third of four per-capability plain-language deep dives. Companion to the workflow inventory, the data model, the stage-by-stage workflow document, and the first two deep dives (Validate config, Build XLSX template).

The first two deep dives are construction-side capabilities — Validate config inspects, Build XLSX template constructs. This one is the first capability that *reaches outward*: it grants people access, it places work on their queue, and it sends mail. Of the four, it's the one with side effects on the world outside the system.

---

## Intent

For one supplier request, grant the attached supplier users access to the supplier portal, place the data-entry task on each one's queue, and send each one an email with a download link to the template they're meant to fill in.

---

## Where it's called from

- **Issue invitation workflow (R1).** The primary callsite. Once per supplier request that the analyst has decided to invite. R1 is the workflow that flips suppliers from "configured but waiting" into "actively expected to respond."
- **Possible secondary callsite: adding a user mid-engagement.** If the system grows the ability to onboard a new user against an already-active supplier request, this capability is the natural workhorse for that path. Currently an open item — the workflow stages doc flagged "adding suppliers / users mid-engagement" as a gap, and this capability is one place that gap will land if and when it's filled.

There is no automatic callsite from initial provisioning. The provisioning workflow deliberately leaves new supplier requests in their initial waiting state and does not invite anyone — invitation is always an explicit analyst action via R1. This is a design decision worth keeping visible: invitation is an event, not a side effect of setup.

---

## What goes in

The capability needs four things, in plain language:

1. **A supplier request to invite against.** This is the unit of work. One call processes one request. Through that request, the capability can find: which supplier this is, which users are attached to that supplier, which template version this request was stamped with, and which variant (if any) of that version applies.

2. **The location of the template file the supplier should see.** Either passed in directly, or looked up from the request's variant assignment. The capability needs to know *which file* to put a link to in the outreach email.

3. **The outreach text.** The body of the email — its subject line, its greeting, its instructions, its sign-off, and the slot where the download link goes. May be a single shared template or may have analyst-customizable parts. For this deep dive, treated as input — not constructed inside this capability.

4. **The analyst's identity (or a system-actor identity), as the sender.** Who appears in the "from" line, who's accountable for the outreach, and who gets cc'd or notified if anything goes wrong.

The capability assumes the supplier request has already been correctly set up by an earlier capability — it has a variant assignment (or the explicit "no variant" flag), it has a template file the link can resolve to, and it has at least one user attached. None of those preconditions is re-validated here. If they're broken, this capability fails and reports which one was broken; it does not try to fix them.

---

## What comes out

**Success:** the supplier request is now in the "sent" state, every user attached to it has portal access, every user has the data-entry task on their queue, and every user has been sent an email with a download link to the right file. The capability returns a structured summary of what happened — how many users were processed, how many emails went out, the timestamp of the transition, and the link that was sent.

**Partial success:** in the realistic case where one user's email fails but two others succeed, the capability needs an explicit policy. Two defensible answers:

- *All-or-nothing.* If any per-user step fails, roll back the whole invitation, leave the request in its waiting state, and report what failed. Clean state, but expensive on retries.
- *Eventual.* Each user's invitation is independent. The capability invites whoever it can, marks the others as "needs retry," advances the request to "sent" only if at least one user got through (or maybe always), and reports a per-user disposition.

This is one of the open questions surfaced by writing this deep dive — see *Edge cases* below. Without a decision, the capability has no defensible behaviour for the case it will most often hit.

**Failure:** a structured error naming which substage failed and against which user (where applicable). The supplier request stays in its waiting state. No partial transition.

---

## What it does — substages

1. **Resolve the user list.** Look up the supplier request, find the supplier it belongs to, find the users attached to that supplier. Build the working list. If the list is empty, fail fast — see *Edge cases*.

2. **Resolve the template file location.** Look up the request's variant assignment (or "no variant"), and from that, find where the template file is stored. The file should already exist; if it doesn't, fail. The capability does not build templates.

3. **Generate a shareable download link.** A link that points to the template file in storage and is valid for some bounded window (currently ten days). The link is generated *now*, at invitation time — not earlier when the file was built — so the supplier's response window is anchored to when they're asked, not to when the file happened to be ready.

4. **Validate that link freshness is achievable.** If the storage layer or some upstream constraint can't produce a fresh link, fail before any user is told anything. Better to fail entirely than to send some users a working link and some users a dead one.

5. **For each user:**
   - **a. Grant portal access scoped to this request.** The user can now log in and see this request, and only this request, on the supplier-facing app. Existing access from other engagements is not affected.
   - **b. Place the data-entry task on the user's queue.** The supplier-facing app's task list now shows them an item to act on. Whether this is one task per user or one shared task on the request that all users see is an open question — see *Edge cases*.
   - **c. Send the outreach email.** The email goes to the user's address, with the link embedded, the analyst as the sender, and the configured outreach text. The capability records the send attempt (succeeded, failed, deferred).

6. **Transition the request.** Once the per-user loop has finished, mark the supplier request as "sent" with a timestamp. If the chosen partial-success policy says transitioning requires all users to have succeeded, only transition then. If eventual, transition unconditionally with a per-user disposition map attached.

7. **Return the summary.** Counts, timestamps, the link itself, the per-user dispositions. Caller decides whether and how to surface this to the analyst.

The substages are listed in the order they have to run for the outward-facing effects to be coherent. Steps 1–4 are pure preparation — nothing the supplier sees has happened yet, and any failure cleanly aborts. Step 5 is the per-user loop where the world outside the system is touched. Step 6 finalises the state change. Step 7 reports.

---

## Edge cases & open questions

**Supplier with zero users.** The provisioning capability is supposed to refuse to create a supplier with no users, and validate-config flagged "supplier with zero users" as an empty-edge case. But if one slips through, this capability has nothing to do for that request. Two reasonable answers: fail loudly so the analyst notices, or no-op silently and leave the request in its waiting state. Failing loudly is better because the silent path produces a request that looks invitable but never advances. *Connects to the empty-edge-cases open question.*

**User with no email address, or with an obviously invalid one.** A per-user failure that the capability can detect before sending. Should the whole invitation halt (because at least one user can't be reached) or proceed and mark that one user as "needs follow-up"? Per-user invariants like this are part of the partial-success question.

**Partial-success policy.** All-or-nothing vs. eventual, called out under *What comes out*. This is the most consequential open question raised by this deep dive — every retry path and every analyst-visible status hangs off the answer.

**Re-invite of an already-sent request.** What happens if the analyst calls invite a second time on a request that is already sent? Legitimate cases include: a user lost the email, the link expired and the analyst wants to send a fresh one, an extra user has been added since the original send. Three answers worth considering: refuse (and force the analyst to use a different "re-invite" capability); refresh quietly (regenerate the link, send fresh emails, leave state alone); or treat as a state change and stamp a "re-invited" timestamp separately. *Connects to the open item about re-invites and to workflow 7's link-refresh requirement.*

**Adding a user mid-engagement.** A new user joins the supplier's team after the original invitation was sent. The user needs portal access, a task on their queue, and an outreach email — exactly what this capability does, but for one user against an already-sent request. If this becomes a supported path, the capability needs to be callable in a "for one specific user" mode rather than always "for all users on a request." *Connects to the open item carried forward from the workflow stages pass.*

**Per-user vs. shared task on the supplier portal.** When two users are attached to one supplier, do they each have their own task on their own queue, or do they share a single task that either of them can act on? The answer matters for analyst-visible reporting (does "task complete" mean "any user finished" or "all users finished?") and for cleanup when one user leaves the supplier mid-cycle. Currently unsettled.

**Stale-link interaction with reminder cycle.** Once an invitation has been sent, its link has a fixed lifetime. If the supplier doesn't act within that lifetime, the reminder workflow needs to issue a fresh link — which means *something* needs to refresh the link without re-running the full invitation. Whether that something is this capability in a "refresh-only" mode or a sibling capability is a clean-design question. The latter is probably cleaner. *Connects to the policy-layer open item and to workflow 7.*

**Idempotency.** If this capability is called twice in quick succession with the same input — say, a user double-clicks an analyst-side button — the worst-case behaviour is two emails to the same supplier and a confused supplier. The capability should be idempotent at the request level: two calls should produce one invitation, not two. The simplest mechanism is a state-based guard at step 6 — if the request is already in "sent" state, refuse step 5's effects.

**Email-service unavailability.** A different failure shape from "user has no email." The address is fine, but the system's outbound mail service is down. This is a transient failure and the right behaviour is to mark the user as "send pending" and let a retry mechanism handle it later. Whether that retry lives inside this capability or in an outer queue is an architecture choice.

---

## What it deliberately does not do

- **Does not build the template.** The template file is a precondition, not a deliverable of this capability.
- **Does not validate supplier input.** Inviting users does not check anything about the data they will eventually submit.
- **Does not confirm receipt or open of the email.** The mail-service handshake is the boundary — once the system has handed the message off, this capability is done with that user.
- **Does not handle reminders.** The reminder workflow is a separate, scheduled concern. This capability fires once, at invitation time.
- **Does not refresh links after the fact.** A sibling concern (or a different mode of this capability — open question above). The 10-day clock starts ticking the moment the link is sent, and resetting that clock is not part of "invite."
- **Does not advance the request beyond "sent."** The supplier acting on the invitation — viewing the template, submitting data — is what moves the request forward from there. Invitation only handles the transition out of waiting.
- **Does not register users outside the supplier portal.** No corporate-directory account creation, no SSO provisioning, no notification of internal teams. The portal is the boundary.
- **Does not invite users for multiple suppliers in one call.** One supplier request per call. The caller (typically R1) handles the loop.

---

## Inputs / outputs at a glance

| | Shape |
|---|---|
| **In: supplier request** | One request to invite against. Provides the supplier, the users, the variant, the version. |
| **In: template file location** | Where the file lives in storage (or derivable from the variant assignment). |
| **In: outreach text** | Subject, body, link slot. May be shared or analyst-customised. |
| **In: sender identity** | Analyst (or system actor) who appears as the sender. |
| **Out (success)** | Request is in "sent" state. All users have portal access, queued task, and outreach email. Returns a structured summary. |
| **Out (partial success)** | Per partial-success policy — currently *unsettled*. |
| **Out (failure)** | Structured error naming the failed substage and (where applicable) the failed user. Request stays in waiting state. |
| **Side effects** | Portal access granted, tasks placed, emails sent. *Outward-facing, not undoable.* |
| **Idempotent?** | Should be — state-based guard at step 6 prevents a double-call producing duplicate emails. The behaviour-on-second-call is the re-invite open question. |

---

## Where this leaves us

Three of the four deep dives are now done. After this, the only remaining one — **Validate supplier input** — depends on this one only loosely (a supplier can't submit until they've been invited, but the validation logic itself is independent of how the invitation went). Worth keeping in view as we move toward the last deep dive:

- The **partial-success decision** isn't optional. Both this capability and Validate supplier input have plausible "some inputs failed, some didn't" shapes. Picking a consistent stance for both will save trouble later.
- The **per-user vs. shared task** decision shapes how Validate supplier input thinks about who submitted what, especially in the manual-entry path where multiple users might be editing at once.
- The **link-freshness story** is the seam between this capability and the future reminder workflow. The cleaner the seam, the simpler R4 is to specify.

Open items still alive after this pass, carried forward to the last deep dive and to callable triage:

- **Partial-success policy.** All-or-nothing vs. eventual; the most consequential decision raised here.
- **Per-user vs. shared task** on the supplier portal.
- **Re-invite semantics.** Refuse, refresh, or distinct re-invite capability.
- **Adding a user mid-engagement.** Already on the list from the workflow stages pass; sharpens here as a "single-user mode" of this capability vs. a sibling.
- **Link refresh (stale-link recovery).** Sibling capability vs. a mode of this one.
- **Empty edge cases.** Adds: supplier with zero users, user with no valid email.
- **Idempotency mechanism.** State-based guard is the simplest answer and worth confirming.
