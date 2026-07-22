# SDC Persona Test Scripts — v1

Executable evaluation scripts for two personas: **Supplier User** and **Analyst**.
Companion to (not a replacement for) the engineering rubrics:

- `sdc-state-machine-test-rubric-v1-pilot.md` — verifies the *machine* (transitions, invariants)
- Supplier UX rubric — audits the *surfaces* against design intent

These scripts verify the *experience*: can a person in each role complete their job
unaided, and does the system behave correctly while they do it. Each script produces
numbers, not just pass/fail, so runs are comparable across testers and across builds.

---

## 1. How these scripts work

**Two layers per script.** Testers see only the *Scenario* and *Steps* — written in
persona voice, no recipe IDs, no table names. The *Coordinator notes* (staging,
backend verification, recipe references) are for whoever runs the session. Never
show coordinator notes to the tester; half of what we're measuring is whether the
surfaces explain themselves.

**Roles in the room.** One **tester** (plays the persona; ideally someone who has
never seen SDC), one **coordinator** (stages data, observes, records, performs
backend checks). The coordinator does not help unless the tester is fully stuck —
and an assist gets recorded.

**One request per script.** Stage a fresh SupplierRequest for each script unless
the script explicitly chains from a prior one (S-05→S-07, A-04→A-05). State is
staged via the normal creation path + STS-01 replay, never by direct column writes.

---

## 2. Measurement instruments

Record these for **every** script:

| Instrument | Definition | Scale |
|---|---|---|
| **Completion** | U = unaided; A = assisted (coordinator intervened); F = failed (tester gave up or task impossible) | U / A / F |
| **Time-on-task** | First interaction with the surface → tester declares done | mm:ss |
| **Errors** | Count of wrong actions: wrong page, wrong button, invalid input the tester had to retry, re-reads of instructions after a wrong turn | integer |
| **SEQ** | Single Ease Question, asked immediately after: "Overall, how easy was that task?" | 1 (very hard) – 7 (very easy) |

Some scripts add a **comprehension probe**: a question asked *before* the tester
sees any coordinator information, scored against a key. Probes measure whether the
surface communicated what it was supposed to — the pilot's neutral messaging lives
or dies on these.

**Defect logging.** Any anomaly gets a row: script ID, step, description, severity.

| Severity | Meaning |
|---|---|
| **B** | Blocker — persona cannot proceed |
| **M** | Major — persona proceeds but is misled, temporarily blocked, or must ask a human |
| **m** | Minor — cosmetic or clarity issue |

**Suggested quality bar** (tune to taste): ≥ 80% of scripts completed Unaided,
mean SEQ ≥ 5.5, zero B-severity defects, probe accuracy ≥ 90%. The point of stating
a bar up front is that "how did the pilot go?" gets a numeric answer.

---

## 3. Environment pre-flight (coordinator fills in before any session)

Expected results in several scripts depend on what has shipped. Fill this card in
and attach it to the run record — otherwise two runs a month apart aren't comparable.

| # | Question | Answer | Affects |
|---|---|---|---|
| E1 | Routing mode: **pilot** (all completed validations → pending_review, neutral supplier messaging) or **default** (failures auto-return to supplier)? | ☐ pilot ☐ default | S-03, S-04, S-08, A-01, A-03 |
| E2 | Q1(b) remediation live? (UPL-01 trigger-normalization guard for failed resubmission from supplier_action_required) | ☐ yes ☐ no | S-06 gate |
| E3 | WFA-013 verdict-leak fix live? (supplier results surface must not expose verdict / invalid-row counts) | ☐ yes ☐ no | S-04 probe key |
| E4 | Seeded-data review gate built? (fingerprint capture, analyst seed page, INV-01 precondition) | ☐ yes ☐ no | A-06 |
| E5 | Reminder workflow (Workflow 7) built? | ☐ yes ☐ no (expected: no) | S-09 scope |

Scripts below are written against **pilot mode** as primary, with default-mode
deltas noted inline where they differ.

---

## 4. Supplier User persona scripts

Persona framing to read to the tester before S-01:

> *"You are a contact at a supplier company. A client you work with has asked your
> company to provide some data. You'll receive an email about it. Handle this the
> way you would at work — you have no training on this system, and no one to ask."*

---

### S-01 — Invitation receipt and orientation

**What this isolates:** whether the invitation alone gets a cold supplier oriented —
what's being asked, where the template is, where to go.

**Coordinator staging:** request in `pending`; issue the invitation (INV-01), which
moves it to `sent` and delivers email + portal task + template link. Confirm the
FileStorage link is fresh (10-day TTL).

**Steps (tester):**
1. Open the invitation email.
2. **Probe P1** (before clicking anything): "In one sentence, what are you being asked to do, and by when?"
3. Download the template file.
4. Find and open the portal task for this request.
5. **Probe P2:** "What status does the portal show, and what does it mean you should do?"

**Expected:**
- Email renders correctly; template downloads on first click.
- Portal task is findable from the email without coordinator help.
- P1 scored against the invitation copy's actual ask; P2 key: status reflects `sent` derivation — "action is with you: complete and submit the template."

**Coordinator backend check:** request row untouched by the tester's browsing —
the four protected columns (`status`, `supplier_display_status`, `supplier_message`,
`current_state_entered_at`) identical before/after.

**Metrics:** U/A/F, time, errors, SEQ, P1+P2 accuracy.

---

### S-02 — Template comprehension and data entry

**What this isolates:** the TPL-02 template as a self-explanatory instrument —
instruction banner, locking, dropdowns, dependent dropdowns.

**Coordinator staging:** the S-01 template. Prepare a realistic data slip (on paper
or a separate doc) with values the tester must enter, including at least one pair
that exercises a **dependent** dropdown (child list must narrow after the parent
is chosen) and one date and one currency value (number-format hydration check).

**Steps (tester):**
1. Open the template. Read whatever instructions it presents.
2. Attempt to type into a header/locked cell. Note what happens.
3. Enter the provided data across at least 5 rows.
4. For the dependent-dropdown pair: pick the parent value, then open the child dropdown.
5. Try to enter a value not in a dropdown's list. Note what happens.
6. Save the file locally.

**Expected:**
- Locked cells refuse edits with the protection message; unlocked data cells accept input.
- Child dropdown shows only options valid for the chosen parent; changing the parent afterward invalidates/refreshes the child.
- Non-list entries are rejected by data validation.
- Dates and currency display in the intended formats after entry.
- Hidden reference sheet stays hidden; tester never needs it.

**Metrics:** U/A/F, time, errors (each rejected-then-corrected entry counts), SEQ.
**Watch for (m unless blocking):** tester confusion at the banner row, hunting for which cells are editable.

---

### S-03 — First submission (clean file)

**What this isolates:** the upload path end-to-end from the supplier's chair, and
whether post-submit messaging tells the supplier the right thing.

**Coordinator staging:** S-02's completed file, verified clean (would produce a
`passed` verdict). Request in `sent`.

**Steps (tester):**
1. In the portal task, submit your completed file.
2. Note any confirmation shown.
3. Refresh / revisit the task. **Probe P3:** "What happens next? Do you need to do anything?"

**Expected (pilot):**
- Upload accepted; no error surfaced.
- Status surface moves to the `pending_review` derivation — neutral "submission received / under review" language. P3 key: *"nothing — it's with them now."*
- **Default-mode delta:** same, since the file passes; the modes diverge only in S-08.

**Coordinator backend check:** upload row + validation result persisted; verdict
`passed`; state `pending_review`; `trigger_context` consistent with the routing mode.

**Metrics:** U/A/F, time, errors, SEQ, P3 accuracy, and **pipeline latency**
(submit click → status change visible) — record it; suppliers will refresh.

---

### S-04 — Status comprehension and information exposure

**What this isolates:** the pilot's core promise — the supplier sees a neutral,
truthful status and *cannot* see the system verdict or row counts. This is the
persona-level twin of the rubric's D-suite.

**Coordinator staging:** stage (or reuse) **two** requests resting in
`pending_review`: one whose underlying verdict was `passed`, one `failed`. The
tester must not be told which is which — that's the test.

**Steps (tester):**
1. Open each request's status surface in the portal.
2. **Probe P4**, per request: "What is the status of this submission? Did it pass or fail their checks? How can you tell?"
3. Explore every element of the results/status surface — expand anything expandable, download anything downloadable.

**Expected (E3 = yes):**
- Both requests read identically to the supplier. P4 key: *"under review; I can't tell pass/fail from here."*
- No element exposes verdict tokens, invalid-row counts, or field-level errors.

**Expected (E3 = no):** this script becomes **evidence collection** for the known
WFA-013 defect — record exactly which elements leak, screenshot them, log one
M-severity defect row. Do not treat as a new finding.

**Metrics:** P4 accuracy (the headline number), plus an exposure inventory:
list every data element the tester could see.

---

### S-05 — Rework loop (analyst-initiated)

**What this isolates:** the only live path into `supplier_action_required` during
the pilot — does the supplier notice, understand the feedback, and know what to do.

**Coordinator staging:** run A-04 first against the tester's S-03 request (analyst
requests rework with a specific, checkable note, e.g. "Row 4: contract end date
precedes start date — please correct"). Then hand back to the supplier tester.

**Steps (tester):**
1. You've been told nothing. Check your email and the portal as you naturally would.
2. **Probe P5:** "What went wrong, and what exactly do you need to change?"
3. Retrieve your previous submission (if the surface offers it), make the correction, resubmit.
4. Confirm the status after resubmission.

**Expected:**
- Rework notification arrives (email and/or task change) and is noticed without prompting.
- Analyst's note is surfaced verbatim or near-verbatim; review history visible. P5 scored against the staged note.
- Resubmission accepted; status returns to under-review messaging (pilot).

**Coordinator backend check:** review note row present and displayed; state walked
`pending_review → supplier_action_required → pending_review`; attempt counter incremented.

**Metrics:** U/A/F, time (split: time-to-notice vs time-to-resubmit), errors, SEQ, P5 accuracy.

---

### S-06 — Resubmission of a still-failing file from rework ⚠ gated on E2

**What this isolates:** the Q1(b) path — supplier in `supplier_action_required`
resubmits a file that fails validation again.

**If E2 = no, do not run with a tester.** The known failure mode is a stall *after*
upload writes have landed — the supplier sees an accepted upload and a status that
never advances. Coordinator may run it solo as a controlled probe; log outcome
against Q1(b), not as a new defect.

**Coordinator staging (E2 = yes):** request in `supplier_action_required` (via A-04);
prepare a file with a known validation failure (e.g., a required field blanked).

**Steps (tester):**
1. Resubmit the (still imperfect) file per the rework instructions.
2. Observe the status.

**Expected (pilot, E2 = yes):** upload accepted; status returns to neutral
under-review messaging; no stall, no error page. (The failure is the *analyst's*
to discover — see A-03.)

**Metrics:** U/A/F, time, SEQ, plus coordinator confirmation that state actually
advanced (this is the one supplier script where the backend check is the headline).

---

### S-07 — Approval and terminal-state comprehension

**What this isolates:** closure. Does the supplier know they're done and stop
checking?

**Coordinator staging:** run A-02 (approve) against the tester's request.

**Steps (tester):**
1. Check email and portal as you naturally would.
2. **Probe P6:** "Is there anything left for you to do on this request — now or later?"

**Expected:** confirmation is unambiguous; status surface reads terminal;
no residual calls-to-action (no lingering upload button inviting a pointless
resubmission). P6 key: *"no — complete."*

**Metrics:** P6 accuracy, SEQ, defect log for any residual action affordances (M).

---

### S-08 — Bad-file submission (structural failure path)

**What this isolates:** graceful handling when the supplier does the natural wrong
things.

**Coordinator staging:** request in `sent`. Prepare three files: (a) the template
completely unmodified, (b) a CSV or renamed file of the wrong type, (c) a valid
XLSX that is not the template (random spreadsheet).

**Steps (tester):** submit each in turn (coordinator resets between attempts as
needed), and for each, answer **Probe P7:** "Did that work? What should you do now?"

**Expected (pilot):**
- No raw error pages, no stack traces, no silent black holes: every attempt yields *some* intelligible outcome.
- Unmodified template → routes as an empty/failed submission to review (neutral messaging), or a clear "no data found" style message — record which.
- Wrong file type → rejected at upload or handled as structural failure with a message the tester can act on. P7 scored on whether the tester correctly infers their next move.
- **Default-mode delta:** (a) and (c) should return corrective feedback directly (`supplier_action_required`) — P7 key changes to "fix and resubmit," and the feedback text itself gets scored for actionability.

**Coordinator backend check:** verdicts land as `empty` / `structural_failure` (not
`error` — an `error` verdict here means an extractor exception escaped the graceful
path; log **B** and stop the script).

**Metrics:** per-file U/A/F, P7 accuracy, defect log.

---

### S-09 — Expired template link (known-gap documentation probe)

**Not a pass/fail script while E5 = no.** The 10-day FileStorage TTL with no
reminder/regeneration workflow means an expired link is a known product gap.
Purpose here is to *document the failure experience* so the Workflow 7 build has
a before/after.

**Coordinator staging:** a request whose template link has aged past TTL (or a
deliberately invalidated link if aging one is impractical).

**Steps (tester):** open the invitation email, click the template link, narrate
what you see and what you'd do next.

**Record:** the exact error surface, whether any recovery path exists, tester's
stated next action (most will say "email the person who sent this" — that's the
support-load datum). One defect row, severity M, tagged `known-gap / Workflow 7`.

---

## 5. Analyst persona scripts

Persona framing to read to the tester before A-01:

> *"You are an analyst responsible for supplier data on this project. Suppliers
> submit files; the system checks them; you decide what's clean enough to accept.
> You have not been trained on this tool."*

---

### A-01 — Queue discovery and triage

**What this isolates:** whether the review dashboard answers the analyst's first
question — *what needs me right now* — accurately and at a glance.

**Coordinator staging:** a mixed population of requests: 2 × `pending_review`
(one passed-verdict, one failed-verdict — pilot mode puts both in the queue),
1 × `sent`, 1 × `supplier_action_required`, 1 × `approved`, 1 × `cancelled`.

**Steps (tester):**
1. Open the analyst workspace.
2. **Probe P8:** "How many items need your action right now? Which ones?"
3. For each queue item, identify: supplier name, when it arrived, and how long it's been waiting.

**Expected:**
- Queue shows exactly the 2 `pending_review` items; terminal and supplier-owned states absent.
- P8 = 2, correctly identified.
- **Default-mode delta:** failed-verdict submissions auto-return to suppliers, so the queue shows only the passed one; P8 key = 1.

**Metrics:** U/A/F, time-to-P8, P8 accuracy, SEQ.

---

### A-02 — Review and approve a clean submission

**What this isolates:** the happy-path decision — find the item, inspect the
submission, approve with a note, and have the world end up consistent.

**Coordinator staging:** one `pending_review` request with a `passed` verdict and
a downloadable submission.

**Steps (tester):**
1. Open the passed-verdict item from the queue.
2. Download and open the supplier's submitted file. Confirm it opens and looks like real data.
3. Approve it, adding a short review note.
4. Confirm the item leaves your queue.

**Expected:**
- Verdict and submission are both reachable from the review surface without hunting.
- Approve action succeeds; item exits the queue immediately (or on refresh — record which).

**Coordinator backend check (the consistency triad):**
1. State `approved`; supplier surface shows the terminal derivation.
2. Approved snapshot exists at `/approved/<supplier_request_id>/<upload_id>.xlsx` and byte-matches the submission.
3. Review note persisted with action `approve` and visible in history.

**Metrics:** U/A/F, time, errors, SEQ.

---

### A-03 — Review a failed submission (pilot's reason for existing)

**What this isolates:** the asymmetry the pilot is built on — the *analyst* must
see everything the supplier must not: verdict, invalid-row counts, field-level
errors, the validation report.

**Coordinator staging:** one `pending_review` request whose verdict is `failed`,
with a validation report containing at least 3 distinct, checkable errors
(coordinator keeps the answer key).

**Steps (tester):**
1. Open the failed-verdict item.
2. **Probe P9:** "Did this submission pass the automated checks? How many problems were found?"
3. Locate the detailed error information. List every problem you can find: row, field, what's wrong.
4. **Probe P10:** "Would you approve this, or send it back? Why?"

**Expected:**
- P9 answerable from the review surface alone — verdict and counts visible.
- Tester's error list matches the answer key (score: found / total).
- Line-level errors are attributed to rows and fields specifically enough that the tester could write a rework note from them.

**Metrics:** P9 accuracy, error-recall score (n of 3), time, SEQ. A recall score
below 3/3 with the data present = findability defect (M), not tester failure.

---

### A-04 — Request rework with a note

**What this isolates:** the analyst→supplier handoff — the only pilot path into
`supplier_action_required` — and whether what the analyst writes is what the
supplier receives.

**Coordinator staging:** the A-03 request, still in `pending_review`.

**Steps (tester):**
1. From the review surface, send the submission back to the supplier.
2. Write a rework note naming the specific problems (use your A-03 findings).
3. Confirm what the item now shows on your side.

**Expected:**
- Rework action succeeds; item leaves the active queue (record where it's visible now, if anywhere — analysts will want to track in-flight rework).
- Note persisted with action `rework`.

**Coordinator backend check:** state `supplier_action_required` via
`analyst_rework` context; supplier surface now shows corrective messaging with the
note; reminder eligibility flipped (structural check only while E5 = no).

**Metrics:** U/A/F, time, SEQ. **Then hand off to S-05** — the note written here
is the input to the supplier's P5 probe, which closes the loop: *P5 accuracy is
the true fidelity measure of this handoff.*

---

### A-05 — Full-cycle history integrity

**What this isolates:** after a rework→resubmit→approve cycle, does the record
tell the whole story.

**Coordinator staging:** a request that has completed A-04 → S-05 → A-02 (approve
the corrected resubmission).

**Steps (tester):**
1. Open the (now approved) request.
2. **Probe P11:** "Reconstruct what happened on this request, in order, with dates: every submission and every decision."
3. Confirm which submitted file the approved snapshot corresponds to.

**Expected:**
- Review history shows both notes (rework, then approve) in order.
- Both uploads/attempts are distinguishable; the approved snapshot maps to the *second* submission.
- P11 scored against the coordinator's timeline.

**Metrics:** P11 accuracy, time, SEQ. Any ambiguity about *which file was approved*
is an M defect — this is the audit-trail question a client will eventually ask.

---

### A-06 — Seeded-data review gate ⚠ gated on E4

**What this isolates:** the pre-invitation PII gate — analyst approves the seeded
*bytes*, invitations are blocked until then, and a reseed silently voids the approval.

**Coordinator staging:** one request with seeded data integrated (fingerprint
captured, unapproved); a second, unseeded request as control. Do **not** issue
invitations yet.

**Steps (tester):**
1. Find the list of seeded requests awaiting your review. **Probe P12:** "How many are waiting, and what was seeded into each?" (manifest summary: rows, keys, when)
2. Download the seeded template for the pending item and spot-check it against the manifest.
3. Attempt (or ask the coordinator to attempt) the invitation for this request **before** approving. Observe the outcome.
4. Approve the seeded data.
5. Retry the invitation.
6. Coordinator reseeds the request (new bytes). Re-open your review list.

**Expected:**
- P12: exactly 1 pending (control absent), manifest summary legible without opening the file.
- Step 3: invitation cleanly blocked (`blocked_pending_seed_review`-class disposition) with no side effects — **no email sent, no link shared**. This is the script's non-negotiable line; a sent email here is **B**.
- Step 5: invitation proceeds normally post-approval.
- Step 6: the request reappears as pending review — fingerprint mismatch after reseed voids the prior approval with no one clearing a flag.

**Coordinator backend check:** approval columns stamped (fingerprint, by, at);
audit events emitted for the approval; post-reseed, stored approval fingerprint ≠
current seed fingerprint.

**Metrics:** U/A/F, P12 accuracy, SEQ, and the binary outcomes of steps 3 and 6.

---

### A-07 — Validation report actionability

**What this isolates:** the report artifact itself, decoupled from the review UI —
can an analyst turn it into supplier-fixable instructions.

**Coordinator staging:** a validation report (CSV) from a failed submission with
a planted error mix: a missing required value, a format violation, and a
cross-field/consistency failure. Answer key in hand.

**Steps (tester):**
1. Download and open the report.
2. For each error listed: state the row, the field, and — in your own words — what you would tell the supplier to change.
3. **Probe P13:** "Are any of these errors ones the supplier *couldn't* fix from your description alone?"

**Expected:** every planted error is translatable into a concrete supplier
instruction without coordinator help. Score: instructions rated actionable / total.
Errors the tester can locate but not explain indicate message-catalog gaps —
log m/M per instance rather than failing the script.

**Metrics:** actionability score, time, SEQ.

---

### A-08 — Guard behavior on out-of-order actions

**What this isolates:** the system's manners when an analyst does something at the
wrong time — the persona-level face of the transition-legality invariants.

**Coordinator staging:** one `approved` request, one `cancelled` request, plus a
`pending_review` request opened simultaneously in **two** browser sessions
(two analysts, one item).

**Steps (tester):**
1. Attempt to approve the already-approved request.
2. Attempt to request rework on the cancelled request.
3. Double-review race: coordinator approves the shared item in session 2 *first*; tester then attempts rework in session 1.

**Expected, uniformly:** refusal with a human-readable reason; **no partial writes**
(coordinator verifies the protected columns are byte-identical before/after each
attempt); the tester can tell *why* it was refused without seeing an error code.
A raw `illegal_transition` token surfaced to the analyst is m; a silent success or
silent no-op is M; a partial write is B.

**Metrics:** per-attempt outcome classification, defect log.

---

## 6. Run record and roll-up

One row per script execution:

| Script | Tester | Date | Mode (E1) | Completion | Time | Errors | SEQ | Probe scores | Defects (IDs) |
|---|---|---|---|---|---|---|---|---|---|

Roll-up per persona per build:

- **Unaided completion rate** = U / (U+A+F)
- **Mean SEQ** and its floor (the single worst task is more informative than the mean)
- **Probe accuracy** overall, with P4 (no-leak) and P5 (handoff fidelity) reported individually — those two are the pilot's thesis statements
- **Defect count by severity**, B-list enumerated

Re-run the full set per candidate build; the deltas between runs are the measure
of whether remediation and UX work actually moved anything.

---

## 7. Deliberately out of scope

- **State-machine legality sweep, dormant default-routing suite, revert mapping** — engineering rubric territory; duplicating it here would drift.
- **Reminder flows** (E5 = no): S-09 documents the gap; nothing else touches reminders.
- **`prior_values` supplier/engagement-scoped rules**: known silent no-op in the validation call — cross-submission rule checks would test a feature that cannot currently fire. Add a supplier script for it when the backlog fix ships.
- **Provisioning/config authoring personas** (the person who sets up a project): a third persona worth its own script set later — different user, different surfaces.
