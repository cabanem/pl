# STS-01 — Submission Routing: Maintainer Guide

**Scope:** How and where to change what happens to a supplier submission after
validation — specifically, where the "route failures back to the supplier"
behaviour is decided, and how to change it safely.

**Recipe:** `STS-01 Status-change handler` (v39)
**Companion doc:** `sdc-state-machines-v1.md` (authoritative source for the transition graph)

---

## 0. The one thing to understand first

STS-01 is an **executor, not a router.**

It is the near-exclusive writer of `status`, `supplier_display_status`, and
`supplier_message` on `SUP_SupplierRequest`. But it does **not decide** that a
failed submission should go back to the supplier. It is *told* where to go by
its caller, via two governing inputs:

- `target_state` — the state to move into
- `trigger_context` — why the move is happening

STS-01's entire job is then:

1. **Refuse** the move if the `(prior_state, target_state, trigger_context)`
   triple isn't in its legal set.
2. **Render** the status + message the supplier will see for that move.
3. **Write** those fields, emit an event, and return.

So when you read "the recipe routes all failed submissions back to the
supplier," the routing *decision* is upstream. STS-01 is just the place where
that decision is *permitted* and *given words*. Changing the behaviour almost
always means coordinating an edit here with an edit in the caller.

---

## 1. How a failed submission flows today

```
VAL-01 (or whatever runs validation)
  detects failure
  └─> calls STS-01 with:
        target_state    = supplier_action_required
        trigger_context = system_validation_failed     (first failure)
                       or display_refresh               (repeat failure, same state)

STS-01:
  [1]  Load the request row by supplier_request_id
  [4]  Legality gate  → is the triple in LEGAL_TRANSITIONS?   (else illegal_transition)
  [32] Context gather → load invalid_row_count, validated_at, report link
  [47] Derivation     → look up (target, trigger) in DERIVATION_TABLE,
                        render display_status + message       (else derivation_lookup_failed)
  [50] Write          → status, supplier_display_status, supplier_message,
                        current_state_entered_at, submission_attempt, ...
  [51] Emit event ('info')
  [52] Return result
```

Two rows govern the failure experience today, both in the step-47 table:

| `(target_state, trigger_context)` | When | Message shown |
|---|---|---|
| `(supplier_action_required, system_validation_failed)` | first failure | "Action needed: corrections required" + invalid-row count |
| `(supplier_action_required, display_refresh)` | repeat failure (no-op self-transition, **invariant 7**) | identical wording |

The repeat-failure case exists so that a supplier who resubmits and fails again
doesn't churn the state machine — the state stays `supplier_action_required`
and only the display fields refresh.

---

## 2. The three coordination points

Any change to "where a failed submission goes" touches some subset of these.
Memorise the order — it's also the order you should edit in.

### Point A — The caller (the routing *decision*)
**Lives in:** the validation recipe (e.g. VAL-01), **not** in STS-01.
This is the only place that can *choose* a different destination. If you want
some failures to go to an analyst instead of the supplier, the branch that
decides that has to exist here. STS-01 can't make the decision for you — it can
only honour or refuse the call it receives.

### Point B — `LEGAL_TRANSITIONS` (the *gate*)
**Lives in:** STS-01 step 4 (`Validate transition`, py_eval).
A `set` of `(from_state, to_state, trigger_context)` triples. If the caller asks
for a triple that isn't here, STS-01 returns `illegal_transition` and writes
nothing. This is your safety net: a new route is inert until you add its triple.

```python
LEGAL_TRANSITIONS = {
    ("", "pending", "initial_creation"),
    ("pending", "sent", "invitation_issued"),
    ("sent", "pending_review", "system_validation_passed"),
    ("sent", "supplier_action_required", "system_validation_failed"),   # <-- failure route
    ("supplier_action_required", "supplier_action_required", "display_refresh"),
    # ...
}
```

### Point C — `DERIVATION_TABLE` (the *wording*)
**Lives in:** STS-01 step 47 (`Derive display fields`, py_eval).
A `dict` keyed by `(target_state, trigger_context)` → `{display_status, message}`.
Message templates use `str.format` placeholders. If there's no row for the
incoming key, STS-01 returns `derivation_lookup_failed`. This is what the
supplier actually reads.

### (Point C′) — Context-gathering branch — *only if your message needs new data*
**Lives in:** STS-01 steps 24–46 (one `if` branch per trigger).
If your new message template references a placeholder that isn't already being
loaded, you must:
1. Add/extend an `if trigger_context == ...` branch to load the value into a
   `workato_variable`.
2. Wire that variable into step 47's input map.
3. Add the placeholder name to `CONTEXT_KEYS` in step 47 (and to `DATE_KEYS`
   if it's a date that should render as "June 2, 2026").

Forgetting step 3 is the loud-failure guard: an unknown placeholder raises a
`KeyError` at derivation time rather than silently producing a blank message.

---

## 3. The change recipe (generic procedure)

Follow these in order. Stop as early as the change allows — see §4 for which
scenarios stop where.

1. **Update the doc first.** The step-4 table header says it explicitly:
   change `sdc-state-machines-v1.md`, then mirror into the recipe. The two
   py_eval tables are *mirrors* of that doc; the doc is the source of truth.
2. **Decide if you need a new state.** You usually don't (see §4). A new
   `trigger_context` against an existing state is almost always enough and far
   cheaper.
3. **Caller (Point A):** add the branch that selects the new
   `target_state` / `trigger_context`.
4. **Gate (Point B):** add the new triple to `LEGAL_TRANSITIONS`.
5. **Wording (Point C):** add the matching row to `DERIVATION_TABLE`.
6. **Context (Point C′):** only if the new message needs data not already
   loaded — add the branch, the input wiring, and the `CONTEXT_KEYS` entry.
7. **Test the refusal paths too.** Confirm an *unmatched* triple still returns
   `illegal_transition`, and an unmatched derivation key still returns
   `derivation_lookup_failed`. These are the design's seatbelts; don't loosen them.

---

## 4. Worked scenarios

Three representative changes, ordered simplest to most involved. Pick the
lowest-cost pattern that satisfies the goal — the design rewards minimalism.

### Scenario 1 — Reword / rebrand the failure message only
**Goal:** same routing, different text (tone, branding, add the report link).
**Edits:** Point C only.
Change the `message` / `display_status` strings on the two failure rows in
`DERIVATION_TABLE`. Note that `validation_report_link` is already in
`CONTEXT_KEYS` and loaded by the step-32 branch, so you can drop
`{validation_report_link}` into the template with no other wiring.
**No state-machine change. No caller change.** This is a one-place edit.

### Scenario 2 — Send *structural* failures to an analyst, *data* failures to the supplier
**Goal:** a malformed file / wrong template the supplier can't self-fix should
go to an analyst for review, not bounce back to the supplier.
**Edits:** Points A, B, C (and C′ to surface the structural reason).

- **A (caller):** in VAL-01, branch on failure *type*. Data failures keep the
  existing `(supplier_action_required, system_validation_failed)` call.
  Structural failures call STS-01 with a new trigger, e.g.
  `(pending_review, system_validation_failed_structural)` — routing the request
  to the analyst's review queue instead of the supplier.
- **B (gate):** add `("sent", "pending_review", "system_validation_failed_structural")`.
- **C (wording):** add a `DERIVATION_TABLE` row for that key. For an
  analyst-facing destination the `supplier_message` may legitimately be empty;
  the analyst learns *why* from the audit chain, not the display field.
- **C′ (context):** the input contract **already declares
  `structural_error_summary`** but nothing consumes it yet — this is a latent
  hook. Add it to `CONTEXT_KEYS`, load it in a context branch, and reference it
  in the new row's template if you want the reason rendered.

> Watch-out: do **not** invent a new state for this if `pending_review` already
> means "an analyst owns it." Reuse the state, add the trigger. A new state
> means new rows in *every* table that enumerates states and is the most
> expensive change you can make.

### Scenario 3 — Escalate to an analyst after N repeated failures
**Goal:** after, say, 3 failed resubmissions, stop bouncing back to the
supplier and escalate.
**Edits:** Points A, B, C; reuse existing counters.

- **A (caller):** STS-01 already maintains `submission_attempt` on the row
  (it's in the step-50 write set). Branch in the caller: below threshold →
  existing failure route; at/over threshold → escalation trigger, e.g.
  `(pending_review, failure_escalation)`.
- **B / C:** add the triple and the derivation row as in Scenario 2.
- No new state required; `submission_attempt` is the data you need and it's
  already there.

---

## 5. Guardrails — invariants not to break

- **Single writer.** STS-01 is the near-exclusive writer of `status`,
  `supplier_display_status`, `supplier_message`. Do not write these fields from
  other recipes; route the transition through STS-01 so the gate and derivation
  always run.
- **`concurrency: 1`.** The recipe is serialised on purpose. Don't raise this to
  "speed things up" — it protects the read-modify-write on the request row.
- **Two tables, one doc.** `LEGAL_TRANSITIONS` and `DERIVATION_TABLE` are mirrors
  of `sdc-state-machines-v1.md`. Edit the doc first; keep both tables in sync
  with it and with each other (a legal transition with no derivation row will
  pass the gate and then fail at step 47).
- **Display fields are a temporal slice, not the record of truth.** The *why* of
  a failure lives in the audit chain (`ValidationResult` + `FieldError` +
  `ReviewNote`). `supplier_message` is a human-facing snapshot of that why at
  that moment — it can be reworded freely without losing history.
- **Keep the two refusal codes meaningful.** `illegal_transition` (unknown
  triple) and `derivation_lookup_failed` (unknown derivation key) are the
  design's way of failing loudly instead of writing a wrong or blank status.
  When you add a route, make sure the *negative* cases still hit these.
- **Invariant 7 (no state churn on repeat failure).** Repeated failures use the
  `display_refresh` no-op self-transition rather than re-entering the state. If
  you add an escalation path, decide deliberately whether it's a real transition
  or another refresh.

---

## 6. Quick reference

**Governing inputs:** `supplier_request_id`, `target_state`, `trigger_context`
(+ `cancellation_reason`, `due_date_override`).

**Fields STS-01 writes (step 50):** `status`, `supplier_display_status`,
`supplier_message`, `current_state_entered_at`, `submission_attempt`,
plus context fields it carries through.

**Return error codes:** `request_not_found` | `illegal_transition` |
`precondition_failed` | `derivation_lookup_failed`.

**Failure-relevant rows (today):**

| from | to | trigger | meaning |
|---|---|---|---|
| `sent` | `supplier_action_required` | `system_validation_failed` | first failure → supplier |
| `supplier_action_required` | `supplier_action_required` | `display_refresh` | repeat failure → refresh only |

**Edit map:**

| You want to change… | Edit |
|---|---|
| The words the supplier sees | Step 47 `DERIVATION_TABLE` |
| Whether a route is allowed | Step 4 `LEGAL_TRANSITIONS` |
| Where a failure is sent | The caller (VAL-01) + B + C |
| Data shown in a new message | Steps 24–46 branch + step 47 input map + `CONTEXT_KEYS` |
