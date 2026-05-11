# SDC Data Collection — Recipe Plan (v1, Stage 1 foundation)

## Status

Planning artifact for the implementation work. Each recipe gets a structured entry naming what it's responsible for, what it depends on, what it emits, and what open questions remain.

This is **not** an implementation spec. It doesn't tell you how to build the recipe step-by-step. It tells you what each recipe is for and how it relates to everything else. Step-level work happens per-recipe when that recipe comes up in the build queue.

Companion to the build queue (sequencing), the phase taxonomy (emit vocabulary), the error type taxonomy (failure vocabulary), the state machine (transitions), the data model (schema), and the naming conventions (handles).

This v1 covers Stage 1: the foundation utilities. Stages 2 and beyond follow in subsequent drafts.

## Template

Each recipe entry follows the same shape:

1. **Identity** — recipe code, name, domain, role
2. **Build queue stage** — when it's built
3. **Capability** — pointer to the deep dive or sibling scope
4. **Contract** — inputs (trigger schema), outputs (return schema)
5. **Substage outline** — what the recipe does, in plain language
6. **Cross-cutting calls** — which other recipes it calls
7. **Phases emitted** — per the phase taxonomy
8. **Error types possible** — per the error type taxonomy
9. **State transitions triggered** — where applicable
10. **Invariants honored** — constraints this recipe enforces or respects
11. **Open questions** — recipe-specific items that remain

---

## UTL-01 — Generate Shareable Link

### Identity
- **Code:** UTL-01
- **Name:** Generate Shareable Link
- **Domain:** UTL (cross-cutting utility)
- **Role:** Callable

### Build queue stage
Stage 1 (foundation utilities). Built concurrently with OBS-01.

### Capability
Sibling capability — link generation. Named in the naming conventions doc as the single owner of FileStorage TTL handling. Invariant 8 ("Path is canonical, link is volatile") relies on this recipe existing.

### Contract

**Input (trigger schema):**
- `path` (string, required) — FileStorage path to generate a link for

**Output (return schema):**
- `link` (string) — shareable URL, valid for 10 days
- `expires_at` (datetime) — when the link goes dead

### Substage outline

1. Validate that `path` is non-empty and well-formed.
2. Call Workato FileStorage's link-generation action against the path.
3. Capture the link and its TTL.
4. Return the structured result.

That's effectively it. UTL-01 is one of the smallest recipes in the system — its value is *centralization*, not complexity. Every recipe that needs a link calls this one; no recipe constructs links directly.

### Cross-cutting calls
- OBS-01 — on failure only. Successful link generation is too routine to emit.

### Phases emitted
- `recipe_failed` (error case only)

### Error types possible
- `external_action_failed` — the FileStorage link API returned an error or timed out
- `recipe_invariant` — `path` was empty or malformed (caller bug; never should happen if callers honor the contract)

### State transitions triggered
None. UTL-01 is read-only.

### Invariants honored
- **Invariant 8** (Path is canonical, link is volatile). UTL-01 is the *enforcement point* for this invariant — by being the only recipe that creates links, UTL-01 ensures links are never persisted as long-lived state. Callers persist paths and call UTL-01 at moments of use.

### Open questions
- **Should UTL-01 emit a success event?** Currently planned: no. Link generation runs many times per supplier cycle (one per reminder, one per outreach refresh, one per validation report view); emitting on success would flood EventLog. The failure-only emit is the right discipline. If observability ever needs to *count* link generations, that's a counter, not an EventLog query.
- **Caching.** A single recipe might generate the same link multiple times (e.g., for both `details_json` audit and `supplier_message` interpolation in one STS-01 invocation). Whether UTL-01 should cache per-invocation is a small optimization. Defer until it's a measured problem.

---

## OBS-01 — Event Emitter

### Identity
- **Code:** OBS-01
- **Name:** Event Emitter
- **Domain:** OBS (observability writer)
- **Role:** Callable

### Build queue stage
Stage 1 (foundation utilities). Built concurrently with UTL-01. STS-01 depends on OBS-01 (it emits on every transition).

### Capability
Sibling capability — Event emission. The single writer of `EventLog` rows. Every recipe that wants to write an event calls OBS-01; no recipe writes EventLog directly.

### Contract

**Input (trigger schema):**
- `severity` (string, required) — `info` | `warn` | `error`
- `source_recipe` (string, required) — the calling recipe's code (e.g., `VAL-01`, `STS-01`)
- `step_number` (integer, optional) — step within the source recipe, for debugging
- `phase` (string, required) — must be in the canonical phase taxonomy
- `human_message` (string, required) — one-line human-readable summary
- `details_json` (string, optional) — structured detail payload as JSON
- `supplier_request_id` (string, optional) — many events aren't request-scoped
- `error_type` (string, optional) — must be in the canonical error type taxonomy when present
- `alert_sent` (boolean, optional, default false)
- `resolved` (boolean, optional, default false)
- `resolved_at` (datetime, optional)

**Output (return schema):**
- `event_id` (string) — the newly-written event's PK, for callers that want to reference it

### Substage outline

1. **Validate inputs.** Severity is in `{info, warn, error}`. Phase is in the canonical taxonomy list. If `error_type` is present, it's in the error type taxonomy list, and the phase × error_type matrix permits the combination. Required fields aren't blank.
2. **Compose the row.** Stamp `timestamp` at write time. Map inputs to columns; missing optionals stay null.
3. **Write to EventLog.** One Data Tables create.
4. **Return event_id.**

Validation in step 1 is where OBS-01 earns its keep. The recipe rejects malformed emits at the boundary — phase not in taxonomy, error_type with a wrong-shaped phase, missing required fields. The discipline forces drift to be caught immediately rather than discovered three weeks later when someone queries EventLog and finds garbage.

### Cross-cutting calls
None. OBS-01 is a leaf — it doesn't call other recipes. (If it did, it would create a circular dependency: every recipe calls OBS-01, and OBS-01 would call OBS-01 to log its own failures, which is incoherent.)

### Phases emitted
None. OBS-01 *writes* phases on behalf of other recipes; it doesn't emit its own.

### Error types possible
None directly — OBS-01 doesn't emit. But OBS-01 *can fail*, and when it does, the calling recipe's monitor catches the failure and handles it. From the caller's perspective, an OBS-01 failure is an `external_action_failed` (it's a callable that returned an error).

### State transitions triggered
None.

### Invariants honored
- **Single-writer rule for EventLog.** Only OBS-01 writes the table. Other recipes never bypass it.
- **Phase taxonomy enforcement.** OBS-01 is the runtime enforcement point for `sdc-event-phase-taxonomy.md`. Phases outside the canonical list are rejected.
- **Error type taxonomy enforcement.** OBS-01 is the runtime enforcement point for `sdc-event-error-type-taxonomy.md`. Error types outside the canonical list are rejected.
- **Phase × error_type matrix.** OBS-01 enforces the matrix from the error type taxonomy doc Section 5.

### Open questions
- **What does OBS-01 do when validation fails?** Two options. (a) Reject the emit and return an error to the caller — the calling recipe is now stuck deciding what to do with a logging failure. (b) Accept the emit but stamp it with `severity=error`, `phase=recipe_failed`, `error_type=recipe_invariant` and a `human_message` describing the original (rejected) emit. Option (b) preserves the audit trail; option (a) is cleaner but creates a "what if logging fails" path in every caller. Lean toward (b) — observability shouldn't fail the work; it should record that it tried to record something it couldn't.
- **Alert dispatch.** The sibling scope flagged whether OBS-01 dispatches alerts directly or only writes the row. The cleaner design: OBS-01 writes; a separate watcher capability reads EventLog for unresolved error rows and dispatches. Keeps OBS-01 a pure-write utility. Defer the watcher to a later stage.
- **Atomicity assumptions.** Several recipes write EventLog alongside other writes (STS-01 writes the state transition plus the event). Workato's atomicity guarantee across multi-call sequences isn't airtight. Worth confirming at build whether OBS-01 needs to be called *before* or *after* the substantive writes for the audit trail to be coherent on partial failures. Lean: call OBS-01 *last*, so the event only fires when the substantive work succeeded.

---

## STS-01 — Status Change Handler

### Identity
- **Code:** STS-01
- **Name:** Status Change Handler
- **Domain:** STS
- **Role:** Callable

### Build queue stage
Stage 1 (foundation utilities). Built after OBS-01 (depends on it for transition events).

### Capability
Sibling capability — Status-change handler. The single writer of `SUP_SupplierRequest.status`, `current_state_entered_at`, `supplier_display_status`, and `supplier_message`. Every state transition in the system goes through STS-01.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `target_state` (string, required) — must be in the SupplierRequest state enum
- `trigger_context` (string, required) — names what's driving the transition; affects derivation
- `context_bag` (object, optional) — additional fields the derivation table consumes: `review_note_text`, `review_note_at`, `cancellation_reason`, `structural_error_summary`, etc.

**Output (return schema):**
- `transition_occurred` (boolean) — true for real transitions, false for display-refresh
- `from_state` (string) — the prior state (or current state, if refresh-only)
- `to_state` (string) — the new state (or current state, if refresh-only)

### Substage outline

1. **Read the current row.** Get current `status`, `current_validation_result_id`, `approved_at`, `approved_path`. Pull recent `ReviewNote` if needed for derivation.
2. **Validate the transition.** Check whether `target_state` is reachable from current state per the transition table. Refresh-only invocations (target_state == current state) are valid only for specific trigger contexts (`pipeline_error_alert`, repeated failure in `supplier_action_required`, etc.).
3. **Check field-level preconditions.** Per the state machine doc: `sent` requires non-null `template_path`; `pending_review` requires `current_validation_result_id` pointing at a passed result; `approved` requires `approved_at` and `approved_path`; `cancelled` has no positive precondition.
4. **Resolve the derivation row.** Use target_state + trigger_context to find the matching row in the derivation table. Compose the literal `supplier_display_status` and `supplier_message` strings, interpolating from the context bag and any per-row data needed.
5. **Generate links if needed.** Where the derived message contains a `{validation_report_link}` or similar, call UTL-01 against the appropriate path.
6. **Atomic write.** Update `status`, `current_state_entered_at`, `supplier_display_status`, `supplier_message` in one Data Tables update.
7. **Emit the event.** Call OBS-01 with phase `state_transition` (or `recipe_failed` if validation refused the transition), `details_json` carrying `from_state`, `to_state`, `trigger_context`, and any structured reason (e.g., `cancellation_reason`).
8. **Return** the transition outcome.

### Cross-cutting calls
- **UTL-01** — for generating links interpolated into `supplier_message`
- **OBS-01** — for the transition event

### Phases emitted
- `state_transition` (success — actual transition or successful display refresh)
- `recipe_failed` (failure — transition rejected, precondition violated, derivation error)

### Error types possible
- `recipe_invariant` — transition not in the table; field-level precondition not met; single-writer rule violated. **The most common failure mode for STS-01.**
- `external_action_failed` — Data Tables write failed; UTL-01 returned an error
- `unexpected_error` — derivation Python step crashed (if derivation uses Python)

### State transitions triggered
**STS-01 *is* the place state transitions happen.** Every transition in the state machine doc routes through this recipe. Per the transition table:
- `pending → sent` (from R1)
- `pending | sent | supplier_action_required | pending_review → cancelled` (from R6)
- `sent | supplier_action_required → pending_review` (from VAL-01 via R2/R3)
- `sent | supplier_action_required → supplier_action_required` (from VAL-01 — structural failure; this is a real transition when source is `sent`, a no-op refresh when source is already `supplier_action_required`)
- `pending_review → approved | supplier_action_required` (from R5)

Plus display-refresh invocations that don't transition.

### Invariants honored
- **Invariant 1 (Single-writer rule).** STS-01 is the only recipe that writes `status`, `supplier_display_status`, `supplier_message`, `current_state_entered_at` on `SUP_SupplierRequest`. Drift between these four fields is impossible by construction *if and only if* STS-01 is genuinely the single writer. This is the highest-leverage invariant in the system and the one most likely to be subverted by a future recipe that "just needs a quick status update" — discipline matters.
- **Invariant 6 (Snapshot semantics for display fields).** `supplier_display_status` and `supplier_message` are literal strings stamped at handler write time. The WFA does not template at render. Wording changes are recipe-code changes, not data migrations.
- **State transition table.** STS-01 enforces that only transitions listed in the state machine doc's table are accepted. New transitions require updating both the doc and STS-01.

### Open questions
- **Atomicity across multi-field writes.** The state machine doc and sibling scope both flag this. Workato's guarantee on a single Data Tables update across four fields may be weaker than "atomic." If a write succeeds for two of the four fields and fails for the other two, the row is inconsistent. Worth confirming the guarantee at build. Fallback if weak: write `status` last, with a read-after-write reconcile pass. The state machine doc treats atomicity as assumed; if the assumption is wrong, STS-01 grows a reconcile substage.
- **Refresh-only invocations.** STS-01 supports "target_state matches current_state, derivation runs anyway, no transition." The valid trigger_contexts for this are `pipeline_error_alert`, repeated validation failure in `supplier_action_required`, and repeated structural failure. The set is closed but currently lives in code (the recipe checks against the list). Worth flagging in the state machine doc more explicitly so future additions don't drift.
- **Cancellation derivation.** The derivation table needs a `cancellation_reason` (or sentinel) to render the cancelled-state message. The state machine doc says cancellations route to EventLog (good) but the same string is needed in `supplier_message`. Either STS-01's caller (R6) supplies it in the context bag, or STS-01 reads it from EventLog. Cleaner: caller supplies. Worth confirming.
- **Single-writer enforcement in code.** The invariant relies on discipline. Is there a runtime check — e.g., a Data Tables permission, an assertion in every other recipe — that would catch a rogue write? Likely no, in Workato. The discipline is the enforcement. Worth a build-time review to ensure no other recipe writes these fields.

---

## What's next

Stages 2+ get their own entries in subsequent drafts:

**Stage 2 (pure-compute capabilities):**
- CFG-01 (Validate config orchestrator)
- TPL-01 (Build XLSX template)
- VAL-01 (Validate supplier input)

**Stage 3 (provisioning workflows):**
- PRV-01 (Provisioning webhook trigger)
- PRV-02 (Parse config, build canonical model)
- PRV-03 (Hydrate CFG tables)
- PRV-04 (Publish version)

**Stage 4 (invitation):**
- INV-01 (Invite supplier users) — domain code TBD per the cross-cutting open question in the sibling scopes

**Stage 5 (submission + review):**
- UPL-01 (File submission intake / R2)
- REV-01 (Analyst review handler / R5)
- (R6 likely needs no dedicated recipe; cancellation routes through STS-01 with `trigger_context=analyst_cancel`)

**Stage 6 (smart-UX):**
- UPL-02 (Resubmission template generation)
- (Incumbent data seeding — probably folded into PRV or its own recipe)

**Stage 7 (siblings):**
- INV-02 (Refresh outreach)
- INV-03 (Add user to request)
- INV-04 (Reassign request)

**Stage 8 (reminders):**
- REM-01 (Reminder firing)
- (Reminder eligibility — possibly its own callable, possibly a method)

That's 13 additional recipes across stages 2–8, give or take consolidations. Each gets the same structural treatment as the three above.

The build queue's Stage 9 (engagement closure) is a single Data Tables update — too small for a dedicated recipe entry. R5's approval path may or may not need its own recipe beyond STS-01 invocation; that's a Stage 5 design decision.
