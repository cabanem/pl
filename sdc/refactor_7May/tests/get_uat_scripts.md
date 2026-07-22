# Prompt: Persona-Based UAT Test Scripts (SDC-instantiated)

Paste everything below the line into a fresh session. Section C is the only part
that changes per project — swap the fact sheet, keep A and B verbatim. Section B
is where the quality lives; every directive in it exists to prevent a specific
failure mode of low-context generation (noted in brackets — delete the brackets
before use if you prefer, they're for your understanding, not the tool's).

---

## A. Task

You are designing user-acceptance test scripts for a supplier data collection
platform. Produce a single markdown document containing persona-based test
scripts for two personas: **Supplier User** (external, untrained, has never seen
the system) and **Analyst** (internal, owns review decisions, also untrained on
this tool).

The scripts will be executed by a human **tester** playing the persona, observed
by a **coordinator** who stages data, records measurements, and performs backend
verification. The goal is to *measurably* evaluate whether each persona can
complete their job unaided and whether the system behaves correctly while they
do — numbers, not just pass/fail, so runs are comparable across testers and
across builds.

Work only from the fact sheet in Section C. If a script would require a fact not
stated there, flag the gap in an open-questions list rather than inventing
behavior.

## B. Design directives — follow all of these

1. **Two-layer scripts.** Each script has tester-facing content (scenario
   framing and steps, written in persona voice, zero internal component names,
   recipe IDs, or table names) and separate coordinator notes (staging
   preconditions, backend verification queries, internal references). Half of
   what is being measured is whether the surfaces explain themselves, so the
   tester must never see the coordinator layer.
   [prevents: scripts that leak the answer by naming internals]

2. **Fixed measurement instruments on every script.** Completion class
   (Unaided / Assisted / Failed, where any coordinator intervention = Assisted),
   time-on-task (first interaction → tester declares done), error count (with an
   operational definition of "error"), and a post-task Single Ease Question rated
   1–7. Define all four once, up front.
   [prevents: unmeasurable pass/fail-only scripts]

3. **Answer-keyed comprehension probes.** Wherever the thing under test is
   *understanding* rather than action (what a status means, what feedback is
   asking for, what happened historically), insert a probe: a question asked
   before the tester sees any coordinator information, scored against a key the
   coordinator holds. Number the probes (P1, P2…) so they can be reported
   individually.
   [prevents: assuming comprehension because the tester clicked the right thing]

4. **Blind designs where information *hiding* is the requirement.** If the system
   is supposed to withhold something from a persona, test it comparatively: stage
   two artifacts that differ only in the hidden property, tell the tester
   nothing, and probe whether they can distinguish them. Do not test hiding by
   asking a tester to inspect a single instance.
   [prevents: the weakest possible test of the most important requirement]

5. **Severity taxonomy.** Blocker (persona cannot proceed) / Major (persona
   proceeds but is misled, temporarily blocked, or must ask a human) / minor
   (cosmetic or clarity). Every anomaly gets a defect row: script, step,
   description, severity.

6. **Environment pre-flight card.** Some expected results depend on which fixes
   and features have shipped. Extract every such dependency from the fact sheet
   into a table the coordinator fills in before each run (question, answer
   checkbox, which scripts it affects). Write mode-dependent expectations inline
   in the affected scripts as explicit deltas, not as a separate parallel suite.
   [prevents: scripts that silently go stale, and incomparable runs]

7. **Gate hazardous scripts.** If a known unshipped fix means running a script
   would strand the tester in a broken state or corrupt data, mark the script
   coordinator-only until the pre-flight answer flips, and say what the
   coordinator should log if they run it solo.
   [prevents: manufacturing a known trap for a human tester]

8. **Interlock across personas at every handoff.** Where persona A's output
   becomes persona B's input (e.g., analyst writes a rework note the supplier
   must act on), chain the scripts and score the handoff by comparing what A
   produced against what B understood (B's probe is keyed to A's artifact).
   [prevents: two disconnected checks where the seam is the real risk]

9. **State "What this isolates" for every script,** one or two sentences, so a
   reader can tell why the script exists and what a failure would mean.

10. **Cover the unhappy paths the persona would naturally produce** — wrong
    file, unmodified template, out-of-order actions, concurrent actions on one
    item, expired links — with expectations about *graceful* handling
    (intelligible message, no partial writes, no silent no-ops), not just
    rejection.

11. **Declare scope.** End with an explicit out-of-scope section: tests that
    belong to companion artifacts (named in the fact sheet), features not yet
    built, and known no-op functionality that cannot currently fire.
    [prevents: duplicating other test assets and testing dead code]

12. **Close the loop on reporting.** Include a run-record table (one row per
    script execution), roll-up definitions (unaided completion rate, mean and
    floor SEQ, probe accuracy with the one or two thesis-critical probes reported
    individually, defects by severity), and a suggested numeric quality bar,
    labeled as tunable defaults.

## C. System fact sheet — authoritative; do not invent beyond this

> ⟨ SWAP THIS SECTION PER PROJECT. Keep facts at the level of behavioral
> contract — what each persona can see and do, what states and transitions
> exist, what is broken and whether the fix shipped. Omit implementation
> detail. ⟩

**System.** SDC (Supplier Data Collection): suppliers submit spreadsheet data
via a portal; automated validation runs on each submission; an analyst
adjudicates results.

**Supplier User surfaces.**
- Invitation email containing the ask and a template download link. Links expire
  after 10 days; there is currently no regeneration or reminder workflow.
- A portal task per request showing a display status and a status message.
- The template: a locked XLSX with an instruction banner row, protected
  non-input cells, single and dependent dropdowns (child options narrow based on
  the parent selection), rejected non-list entries, enforced date and currency
  formats, and a hidden reference sheet the supplier never needs.
- An upload control for submitting the completed file, usable repeatedly
  (resubmission), with an attempt counter tracked internally.
- Validation feedback and analyst rework notes, when the state calls for them;
  prior submission retrievable during rework.

**Analyst surfaces.**
- A review queue listing exactly the requests awaiting an analyst decision, with
  supplier identity and arrival/waiting time.
- Per item: the submitted file (downloadable), the validation verdict, and a
  validation report (CSV) with row- and field-level errors.
- Actions: **approve** (optionally with a note; writes an immutable approved
  snapshot of the submitted file to an approved-files area; terminal) and
  **request rework** (requires a note; the note is surfaced to the supplier).
- Review history: all notes, in order, with their action type, across the
  request's life.

**States and transitions.** pending → sent (invitation issued) → [submission +
validation] → pending_review → approved (terminal) or, via analyst rework,
supplier_action_required → [resubmission] → pending_review. cancelled is
terminal and can occur from non-terminal states. Reminder eligibility (future
feature) applies only to sent and supplier_action_required. Four columns
(status, display status, status message, state-entered-at) are written only by a
single status-change handler; any other write path changing them is a defect, and
refused actions must leave them byte-identical.

**Routing modes.** Current **pilot** mode: ALL completed validations — pass or
fail — route to pending_review; supplier-facing messaging is neutral and must
not reveal the verdict, error counts, or field-level errors; the only path into
supplier_action_required is analyst-requested rework. Dormant **default** mode:
failed validations return directly to the supplier with corrective, actionable
feedback.

**Verdict vocabulary.** passed | failed | empty | structural_failure | error.
`error` means an internal exception; a bad *file* must never produce `error` —
wrong file types and unmodified templates should land as structural_failure or
empty and be handled gracefully.

**Seeded-data review gate** (may or may not be shipped — pre-flight item). Some
requests are pre-populated with data before invitation. The seeded bytes are
fingerprinted (SHA-256); a dedicated analyst page lists seeded requests whose
fingerprint lacks a matching approval, with a manifest summary (rows seeded,
match keys, timestamp) and a download. Invitations for unapproved seeded
requests are blocked cleanly *before any side effect* (no email sent, no link
shared). Approval binds to the bytes: reseeding changes the fingerprint and
silently voids the prior approval, so the request reappears for review.

**Known defects and gaps (each is a pre-flight question).**
1. The supplier-facing results surface may leak the verdict and invalid-row
   counts, violating pilot neutrality — fix may or may not be live.
2. Resubmitting a still-failing file from supplier_action_required can stall the
   request *after* upload writes have landed (supplier sees an accepted upload
   that never advances) — fix may or may not be live. Treat as hazardous.
3. Reminder/link-regeneration workflow is unbuilt; expired links have no
   recovery path. Treat as a known gap to document, not a pass/fail test.
4. Validation rules scoped to prior submissions silently no-op; cross-submission
   checks cannot currently fire. Out of scope.

**Companion artifacts that already exist — do not duplicate.** An
engineering-facing state-machine test rubric (transition legality, invariants,
dormant default-routing suite) and a supplier UX audit rubric (surface-by-surface
design conformance).

## D. Output shape

One markdown document: how-the-scripts-work section, measurement instruments,
pre-flight card, supplier scripts, analyst scripts, run record and roll-up,
out-of-scope. Roughly 8–10 scripts per persona. Number scripts (S-01…, A-01…)
and probes (P1…) for cross-reference.
