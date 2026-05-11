# SDC Data Collection — Capability Deep Dive: Validate Supplier Input (v1, Phase 0)

## Status

Fourth and last of the per-capability plain-language deep dives. Companion to the workflow inventory, the data model, the stage-by-stage workflow document, and the first three deep dives (Validate config, Build XLSX template, Invite supplier users).

This is the capability that closes the loop. Validate config established what counts as a well-formed configuration. Build XLSX template put that configuration into the supplier's hands as a workbook. Invite supplier users got that workbook to the people who'd fill it in. This capability checks what they sent back.

It's also the capability that pairs most directly with Validate config — they're the same kind of work (rule-checking) against two different things (the analyst's configuration vs. the supplier's data). The pairing is structural: every rule expressed at config-validation time is a rule that has to be enforceable here. If a rule can be written in the configuration but not checked in supplier input, the configuration is making a promise the system can't keep.

---

## Intent

Take what a supplier submitted — either an uploaded workbook or rows entered manually through the portal — and check it against the configuration the request was stamped with, producing a verdict and a per-error list that drives downstream display and routing.

---

## Where it's called from

- **File submission workflow (R2).** When a supplier uploads a workbook, the upload triggers this capability against that file.
- **Manual-entry submission workflow (R3).** When a supplier finalises manual entry through the portal, the same capability runs against the rows they entered.
- **Re-validation on resubmission.** When a supplier corrects a previously-failed submission and submits again, this capability runs again on the new submission. There is no separate "re-validate" capability — re-validation is just a second call.

The capability is mode-agnostic from its own perspective. R2 and R3 differ in *where the rows come from* (a parsed workbook vs. a portal data structure), not in *how the rows are checked*. Drawing the boundary this way means the validation logic is shared rather than duplicated, which matters because divergence between the two paths is a class of bug the system should make hard to introduce. *Connects to the open item about mode switching R2 ↔ R3 — sharing the validation capability is one of the things that makes mode switching mid-cycle even tractable.*

---

## What goes in

The capability needs four things, in plain language:

1. **The supplier request being submitted against.** Through this, the capability finds the configuration version this request was stamped with at invitation time, the variant assignment, and the supplier identity. Crucially, the version is the one stamped at invitation — *not the latest published version*. A supplier who was invited under v3 is validated against v3 even if v4 has since been published. The version was frozen on their request and that freeze is the system of record for what they're being asked to comply with.

2. **The submitted data, in one of two shapes:**
   - *File submission:* a workbook the supplier uploaded. The capability has to parse it before it can check it.
   - *Manual-entry submission:* a structured row set assembled by the portal. Already in a form the checks can read.

   The capability accepts either. The downstream substages don't branch on which shape it was — once the rows are extracted, the checking is identical.

3. **The configuration to check against.** Looked up from the version stamped on the request — the field definitions, the lookup values (with their parent groupings for dependent ones), the rules, and the error-translation text that turns rule violations into supplier-readable messages.

4. **The strictness regime.** Which categories of rule are hard-fail (the supplier must fix before the submission is accepted) versus soft-fail (the submission is recorded, the analyst sees a warning, but the cycle isn't blocked). This is the open question carried forward from Validate config; without an answer, this capability has no defensible behaviour for a half-good submission.

---

## What comes out

**Pass:** the submission is well-formed and complies with the configuration. The capability returns a structured verdict — count of rows checked, zero hard-fail errors, possibly some soft-fail warnings — and persists a validation result keyed to this submission. The supplier request can advance.

**Fail:** the submission has at least one hard-fail error. The capability returns a structured verdict (count of rows checked, count of errors, breakdown by category) and persists both the result and the per-error detail. Each error has: which row, which field, the error category (missing-required, invalid-lookup, malformed-date, regex-mismatch, range-violation, uniqueness-conflict, conditional-rule-violation, etc.), the system-side error code, and the supplier-facing translated message. The supplier request stays where it is; a separate routing capability decides what happens next.

**Structural failure** (the file couldn't be parsed at all — wrong sheets, missing required columns, corrupt workbook): a different shape of error, surfaced before any per-row checking happens. The supplier sees a single blocking message rather than a per-row list. The submission is recorded as having structurally failed, distinct from "submitted but with content errors."

The validation result that gets persisted is itself the system of record. The supplier sees their errors by reading what this capability wrote. The analyst sees the analyst-facing summary by reading what this capability wrote. Downstream routing (accept, reject, ask-for-rework) reads what this capability wrote. The capability owns the existence of that result in the system — it doesn't return a verdict and ask the caller to record it somewhere; it records it and tells the caller it did.

---

## What it does — substages

1. **Resolve the configuration.** Find the version stamped on the supplier request. Read its field definitions, lookups, rules, and error translations. If the version isn't there or has been deleted, fail before doing anything else — this is a system invariant violation, not a supplier-input problem.

2. **Resolve the submission to rows.**
   - *File submission:* parse the uploaded workbook. Check the structure — expected sheet name present, expected columns present in expected order, no blocking corruption. If the structure is broken, emit the structural-failure shape and stop. If the structure is fine, extract rows. Empty trailing rows and blank sentinel rows are filtered out; what comes out is the supplier's actual data.
   - *Manual entry:* read the row set the portal provides. No parsing needed.

3. **Empty-submission gate.** If the row count is zero, decide before checking anything else — is empty a valid submission, a soft-fail, or a hard-fail? Almost certainly hard-fail by default, but the answer is configuration-driven.

4. **Walk per-field, per-row checks.** For every row, for every field the configuration defines:
   - *Required:* if the field is required and the cell is empty, error.
   - *Type:* if the field is numeric / date / boolean, the cell's content has to be the right type. Format guidance from the configuration drives the parser.
   - *Format:* if the field has a length cap, range, or regex, the cell has to match.
   - *Lookup membership:* if the field is dropdown-backed, the cell's value has to be one of the lookup's allowed values. For dependent lookups, the value has to be allowed *given the parent cell's value on the same row*.
   - *Must-be-empty:* if the field is configured to be empty (e.g., a slot reserved for analyst use), error if the supplier put something in it.

5. **Walk cross-field, per-row rules.** For every row, evaluate every rule whose scope is "within one row" — *if column A equals X, then column B is required*; *column C must be greater than column D*; *column E and column F can't both be filled in*. Each violation gets the same per-row, per-field error shape.

6. **Walk cross-row checks.** Some rules can only be evaluated by looking across rows: *column G must be unique across the submission*; *the count of rows where condition Z is true must not exceed N*. The error shape here is slightly different — the violation often points at multiple rows together (the duplicates). The capability emits one error per offending row, each pointing back at the others, so the supplier sees every row they need to fix.

7. **Translate every error.** Each error has a system-side code; the translation table converts that code into the supplier-readable message, with field name and offending value spliced in. If a translation is missing, fall back to a generic message keyed by code — and emit a soft-fail telling the analyst that a translation is missing for that code.

8. **Compose the verdict.** Total errors, breakdown by category, breakdown by field, breakdown by row. Mark each error as hard-fail or soft-fail per the strictness regime. Decide the overall verdict: pass (zero hard-fail), fail (at least one hard-fail), pass-with-warnings (zero hard-fail, at least one soft-fail).

9. **Persist.** Write the validation result. Write each error against the result. The result references this specific submission; it is not a global "current state of validity for the supplier request" — re-running creates a new result and the prior one stays as history.

10. **Return the verdict to the caller.** A small structured object. The caller doesn't have to know how the persistence happened; it gets the verdict directly and can decide what to do next.

---

## Edge cases & open questions

**Empty submissions.** The supplier submits zero rows. Hard-fail by default — there's nothing to validate, and "no data" is almost certainly not the analyst's intent. But there's a configuration where zero rows is meaningful (e.g., "we have nothing to report this cycle"). Whether that's expressible in the configuration today is unclear. *Connects to the empty-edge-cases open question carried forward from Validate config.*

**Sentinel and blank-content rows.** A historical bug class — the supplier-facing workbook may carry empty trailing rows or rows that look filled-in but only contain whitespace or a placeholder character. These need to be stripped before checking, because otherwise every empty row trips every required-field error. The strip-rule is itself a small rule that has to be right; getting it wrong shows up as cascading false errors.

**Soft-fail vs. hard-fail granularity.** The strictness regime has to be more than a global flag. Different categories naturally fall on different sides — *missing required field* is almost always hard, *missing optional field with a hint of expectation* is soft, *unrecognised lookup value* could be either, *cross-row uniqueness violation* is almost always hard. The configuration probably needs to mark each rule's strictness rather than relying on a global toggle. Either way, this is the central open question this capability surfaces, and it determines how the verdict composition step at substage 8 actually works. *The most consequential carry-forward from Validate config.*

**Lookup case sensitivity and whitespace.** Is "Finance" the same as "finance"? Is "Finance " (with a trailing space) the same as "Finance"? Strictly speaking, these are different strings. Pragmatically, suppliers will produce all of them and the system has to choose. The choice should be uniform across all lookup checks and probably configuration-controlled; current behaviour is undocumented.

**Numeric coercion.** A cell that says "1,000" is one thousand to a human and a string to a parser. Likewise "1.000" is one thousand in some locales and one with three trailing zeros in others. Numeric checks need an explicit coercion policy, and that policy interacts with the format guidance in the configuration.

**Date format ambiguity.** "01/02/2024" is January 2nd or February 1st depending on locale. Date checks need to know which the configuration intends. The XLSX cell format helps when the supplier used the dropdown date picker; manual entry doesn't have that signal.

**File submission with extra columns.** The supplier added a column the configuration doesn't recognise. Three plausible answers: ignore, soft-fail (warn the analyst), or hard-fail (the file structure is wrong). Probably ignore for content extras and structural-fail for header-row mismatches, but the boundary needs drawing.

**Cross-row rule scope.** Uniqueness "across the submission" is unambiguous. Uniqueness "across all of this supplier's submissions ever" is a different and harder check. Uniqueness "across all suppliers in this engagement" is harder still. The configuration probably needs to express which scope applies; current behaviour is the most local one.

**Re-validation against the same version vs. a re-published version.** When a supplier resubmits, they're still on the version their request was stamped with. The system never silently moves them to a newer version. But what happens if the analyst *deliberately* moves them to a newer version? That's a different capability (probably a re-issue capability that hasn't been written yet) and is out of scope here.

**Validation in preview mode.** As the supplier types into the portal in manual-entry mode, it would be useful to surface validation errors immediately rather than waiting for a final-submit. Whether the same capability does light "preview" validation as a sub-mode, or whether a separate capability does cheaper checks for preview, is an unsettled design question. The cleaner answer is probably a sub-mode of this capability that runs only the per-cell checks (substage 4) and skips the cross-row and cross-field ones, but that's speculation — flagging it for callable triage rather than deciding here.

**Partial-success policy applies here too.** The same question that came up for Invite supplier users — when *some* of the per-row checks succeed and *some* fail, what's the right shape of the result? Here the answer is more obvious: every row gets checked, every error is recorded, the overall verdict is composed at the end. This capability is naturally "eventual" rather than "all-or-nothing" because the supplier needs to see *every* error at once, not just the first one. Worth noting that the answer differs from invite by the nature of the work, not by inconsistency.

---

## What it deliberately does not do

- **Does not advance the supplier request state.** The verdict goes back to the caller; a separate routing capability decides what to do — accept, ask for rework, escalate. State transitions are not this capability's responsibility.
- **Does not notify the supplier or the analyst.** Notifications are the routing capability's job. This one writes a result and returns.
- **Does not modify the supplier's submitted data.** Read-only on the input. No autocorrection, no normalisation written back.
- **Does not store the supplier's submission permanently.** The submission itself is the supplier's artifact; what's persisted is the validation result. The file or row set may be archived elsewhere, but that's a different concern.
- **Does not re-validate the configuration.** Assumes the version stamped on the request is well-formed. If it isn't, that's an upstream invariant violation — fail loudly, don't try to compensate.
- **Does not generate a corrected workbook for the supplier.** A "here's what you submitted with errors marked" deliverable would be a useful sibling capability, but it's not this one.
- **Does not decide whether half-good is good enough.** The strictness regime decides; the capability applies it. The decision lives in the configuration and the global strictness policy, not in the validation logic.
- **Does not preview while the supplier types.** Probably — the preview question is an open one. Even if a preview mode is added, it's a sub-mode of this capability, not the capability's full scope.

---

## Inputs / outputs at a glance

| | Shape |
|---|---|
| **In: supplier request** | One request being submitted against. Provides the version stamp, the variant, the supplier identity. |
| **In: submission** | Either an uploaded workbook (parsed first) or a manual-entry row set. |
| **In: configuration** | Looked up from the request's stamped version — fields, lookups, rules, error translations. |
| **In: strictness regime** | Which rule categories are hard-fail vs. soft-fail. Currently unsettled. |
| **Out (pass)** | Verdict object, validation result persisted, zero hard-fail errors. |
| **Out (fail)** | Verdict object with error counts, validation result persisted, full per-row per-field error list persisted with translations. |
| **Out (structural failure)** | Single blocking error, no per-row analysis, distinct shape from content failure. |
| **Side effects** | Writes the validation result and per-error rows. *Persistence is part of the capability — the result is the system of record.* |
| **Idempotent?** | Each call produces a new result. Re-validating the same submission a second time produces a second result with the same content; prior results are kept as history. |

---

## Where this leaves us — closing observations across all four

All four deep dives are now done. A few cross-cutting themes emerged from doing them in plain language one after another, worth flagging before callable triage:

**The configuration is the spine.** Three of the four capabilities depend on it directly — Validate config inspects it, Build XLSX template renders it into a workbook, Validate supplier input enforces it. Invite supplier users only depends on it indirectly (via the variant assignment). The configuration's stability and immutability per version is what makes the rest of the system reasoning tractable; that pattern was reaffirmed in every deep dive.

**The "frozen at issuance" model showed up everywhere.** Each supplier request is stamped with a configuration version at invitation time, and that stamp is the system of record for everything that happens to that request afterward. Build XLSX template reads it to know what to render; Invite supplier users reads it to know what file to link to; Validate supplier input reads it to know what rules to apply. New versions don't silently migrate in-flight suppliers. This is one of the system's most important invariants and it should survive the refactor unchanged.

**Capabilities have clean side-effect signatures, and the four cover the spectrum.** Validate config is pure inspection (no side effects). Build XLSX template is pure construction (one in-memory artifact, no persistence). Invite supplier users is outward-facing (touches the world outside the system — accounts, queues, mail). Validate supplier input has internal persistence side effects (writes the validation result as system of record). Naming the side-effect signature explicitly in each deep dive made the differences easier to see and easier to discuss. Worth keeping that habit in callable triage.

**The plain-language constraint surfaced design questions the technical names had hidden.** Soft-fail vs. hard-fail for validation. Per-variant-as-its-own-file for templates. Partial-success policy and re-invite semantics for invitations. Per-user-vs-shared-task for the portal. Strictness as a per-rule attribute, not a global flag. These are all questions that would have been obscured by jargon — when you're saying "P-02 returns an XLSX," you don't have to ask "what does each variant being its own file imply about the future?", but when you say "this capability hands the caller a workbook for one variant," you do.

**Open items still alive going into callable triage:**

From validate config:
- *Soft-fail vs. hard-fail threshold,* sharpened: probably per-rule strictness in the configuration plus a global default.
- *Cross-version compatibility checks (republish-time warnings).*
- *Empty edge cases,* now: empty workbook, empty variant, empty user list, empty submission, lookup with zero values.

From build XLSX template:
- *Special-character handling in dependent-dropdown parent values* — one shared sanitization rule, not two parallel ones.
- *Static instruction sheet* — in scope or sibling concern?

From invite supplier users:
- *Partial-success policy* — all-or-nothing vs. eventual.
- *Per-user vs. shared task* on the portal.
- *Re-invite semantics* — refuse, refresh-quietly, or distinct event.
- *Adding a user mid-engagement.*
- *Link refresh / stale-link recovery* — sibling capability vs. mode of invite.
- *Idempotency mechanism* — state-based guard.

From validate supplier input:
- *Lookup case-sensitivity, whitespace, numeric coercion, date format* — a coherent normalisation policy across all field-level checks.
- *Cross-row rule scope* — within submission, across all of this supplier's submissions, across all suppliers.
- *Preview-mode validation* — sub-mode of this capability or sibling.
- *Extra columns in file submissions* — ignore, soft-fail, or structural-fail.

Plus the older items from the workflow stages pass that haven't moved:
- *Display refresh trigger surface.*
- *Policy layer contract for reminder firing.*
- *Mode switching mid-cycle (R2 ↔ R3)* — partially clarified by the shared-validation decision here.
- *X1 specification depth.*
- *Adding suppliers / users mid-engagement.*
- *E3 closure flag has no behavioral consequence.*

The natural next step is callable triage — taking the capabilities described here and the workflows described in the stage doc, and producing a port-as-is / port-with-changes / rebuild disposition for each existing callable, along with a callable-to-workflow map. That work has the most leverage now: the capabilities are clearly enough drawn that "which existing recipe does which capability's work" is a conversation the system can actually have.
