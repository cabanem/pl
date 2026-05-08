# SDC Data Collection — Callable Triage (v2, Phase 0)

## Status

Closes Phase 0. Companion to the workflow inventory, the data model, the stage-by-stage workflow document, the four capability deep dives, and the Phase 0 handoff that set the rebuild-default stance.

Three formal outputs:

1. A **carry-forward list** — what survives the inclusion test and is reused in Phase 1.
2. A **capability-coverage map** — for each of the four capabilities, what carries forward and what gets built.
3. **Resolutions** for the open questions the deep dives flagged as must-resolve or should-resolve before the build can proceed cleanly.

Stance, recapped: rebuild is the default disposition. The capability deep dives are the source of truth. A callable carries forward only if it passes all seven criteria of the inclusion test in the handoff. The bar is high on purpose, and the carry-forward set is meant to be defensibly small.

What changed between v1 and v2:

- *Connector decisions folded in.* The handoff deferred them to the build session; reading the code resolved them. The SDC Platform Connector actions all carry; the two YAML-spec connectors stay deferred. (Already in v1.)
- *Open-questions resolutions folded in.* The Invite cluster (per-user vs. shared task, partial-success policy, idempotency, re-invite semantics) and the Validate cluster (normalization policy, cross-row rule scope) are resolved and integrated into the relevant capability sections. The Phase 1 work list now reflects the schema and signature changes those resolutions imply.
- *CI/CD connector explicitly deferred as feature work.* Treated as out-of-scope for the rebuild itself rather than as a deferred decision.

---

## Carry-forward list

### Recipes

None.

P-02a Build XLSX template was the only candidate that survived first inspection. Close reading of its Python disqualified it — see the rationale section below. Every other callable in the catalog sorts to rebuild on the inclusion test, most of them on criterion 2 alone (no platform side effects).

### Connector actions

The SDC Platform Connector's actions and the methods block they depend on carry forward in their current shape, with small adjustments deferred to the build session as they surface. The actions:

- **`parse_config_file`** — parses sheet JSON into the structured configuration object. Pure transformation. Aligns with the upstream-of-validation parsing the *Validate config* deep dive explicitly excluded from its own scope.
- **`validate_config`** — runs the eight check categories (lookup references, depends-on, rule targets, rule conditions, variant fields, user-to-supplier, dependent-dropdown parents) plus constraint and syntax checks. Read-only. *This is Validate config.*
- **`validate_upload`** — per-field, cross-field, and cross-row validation against a frozen configuration. Returns the verdict shape the *Validate supplier input* deep dive describes. *This is the engine of Validate supplier input.*
- **`extract_form_fields`** — projects visible fields and their lookups for manual-entry form provisioning. Sibling capability adjacent to *Build XLSX template*; useful for the manual-entry side of the system.
- **`generate_validation_report`** — shapes a validation result into report-ready rows for XLSX/PDF rendering. Sibling capability that runs after *Validate supplier input* persists.
- **`build_storage_path`** — pure utility for canonical FileStorage path construction.

The methods block — `parse_interval`, `evaluate_interval`, `evaluate_date_interval`, `resolve_error_message`, `coerce_boolean`, `apply_cleaning_flag`, `check_data_type`, `check_data_format`, the per-sheet parsers, `sanitize_slug`, and the rest — carries with the actions. These are the small pure utilities the actions are built from; they pass the inclusion test individually and they're the right shape for the new design.

### Connectors not yet adjudicated

The Workato Developer APIs CI/CD connector and the Data Tables API connector remain deferred. Whether the rebuild relies on them depends on choices not yet made about how the new design reads and writes the data model, and the cleaner path is to make those choices in the build session with the new code in front of us.

---

## Capability-coverage map

For each capability, what carries forward and what gets built. Phrased as the input to Phase 1's build queue.

### Validate config

**Carries forward:** `parse_config_file` and `validate_config` from the connector cover the capability end to end.

**To build:** a thin recipe-level orchestration that calls the parser, calls the validator, and returns the result to its caller. The "persistence is the caller's job" principle from the deep dive is naturally satisfied because the connector actions are read-only — there's no persistence in the validation path itself.

**Notes:** the existing C-01 recipe demonstrates the orchestration shape but mixes persistence into the same recipe. The rebuild separates that — validation is one capability, persisting the validated configuration is a separate concern that calls the validator and writes if the result is clean.

### Build XLSX template

**Carries forward:** nothing.

**To build:** the full capability per the deep dive's substages 1 to 10. P-02a's Python is reference material for the per-type DataValidation builders (date with TODAY resolution, numeric with bounds, textLength), the lookup grouping helpers, and the workbook layout. The interval-parser parallel structure between the connector's Ruby `parse_interval` and the Python `parse_interval` is genuinely good and worth preserving — same notation, same semantics, two languages.

**Build-time invariant:** one shared sanitization function, called from both the named-range naming step and the INDIRECT-formula resolution step. Same function, same inputs, same outputs. The bug the deep dive predicted ("the sanitization rule used to name the columns and the sanitization rule used inside the indirect-resolving formula must match exactly, or the dropdown silently goes blank") is present in the existing P-02a code — see the rationale section. This isn't a guideline; it's the test the new implementation has to pass.

### Invite supplier users

**Carries forward:** nothing.

**To build:** the full capability per the deep dive's substages 1 to 7, with the resolutions below shaping its behaviour.

**Reference material:** P-03a's structure (resolve users, generate link, loop), P-03b's task-assignment shape. Useful as a starting outline; the actual implementation is new.

**Resolutions for the cluster:**

- *Task model.* Designated assignee, not shared, not per-user. Platform access is granted for every attached user; the task is assigned to one designated user (the "primary" on `SupplierUser`). Reassignment via the platform's native mechanism is the explicit handoff path. The platform constraint of one-assignee-per-task forces this shape, and it works well — explicit handoff produces a cleaner audit trail than silent shared-action would have.
- *Partial-success policy.* Eventual, with a hard floor at the assignee. The request transitions to "sent" only if the assignee got their email and the task was placed. Other users are best-effort with per-user dispositions reported. Assignee failure with secondary success returns an error suggesting the analyst fix the assignee's email or change the assignee — the system does not auto-promote a secondary.
- *Idempotency.* 60-second guard on Invite. Second call within the window on a sent request returns "no action, recently invited" and exits cleanly. The double-click case never produces duplicate emails. The 60-second window is a placeholder; tune later if needed.
- *Re-invite semantics.* Not a mode of Invite. Three sibling capabilities cover the legitimate intentional cases (see below). A second call to Invite outside the guard window is refused with an error pointing at the appropriate sibling.

**Sibling capabilities the Invite resolution introduces:**

- **Refresh outreach.** Regenerate link, send fresh emails to all users (or a specified subset), no task changes. Subsumes the link-refresh / stale-link-recovery sibling the deep dive flagged — they're the same thing under different names.
- **Add user to request.** Grant access to the new user, send them outreach, leave the existing users and the task assignment alone. Covers the "adding users mid-engagement" gap from the workflow stages pass.
- **Reassign request.** Move the task to a new assignee using the platform's reassign mechanism. Notify both the new assignee ("this is now yours") and the previous one (FYI, if still active). No link or outreach changes for non-assignees. Covers the "supplier deactivation mid-engagement" case when the deactivated user was the assignee.

These three are sibling capabilities rather than modes of Invite — they have different inputs, different success conditions, and different side-effect signatures. Lumping them under one re-invite mode would force the implementation to branch on which side effects to perform, which is the orchestration-in-disguise pattern the inclusion test was specifically designed to catch.

**Schema implication:** a `primary` boolean on `SupplierUser`, validated as exactly-one-per-supplier at config time. The data model document needs this addition.

### Validate supplier input

**Carries forward:** `validate_upload` from the connector is the engine. `generate_validation_report` is the sibling that shapes the result into a supplier-facing report.

**To build:** a recipe-level orchestration that handles the upstream transformation (parse XLSX into rows for file submission, or read RUN_ManualEntry rows for manual entry) and the downstream persistence (writes the validation result and per-error rows as the system of record per the deep dive). The validation engine itself is the connector action.

**Reference material:** V-01b's "transpose to entity-attribute-value" py_eval (step 23) for the XLSX-to-rows transformation.

**Strictness regime — substantively settled by the existing code.** The deep dive flagged "soft-fail vs. hard-fail granularity" as the central open question and predicted the answer would be "per-rule strictness in the configuration plus a global default rather than a single global threshold." That's exactly what the existing connector and configuration schema already do — `Field.strict` and `Rule.strict_enforcement` are per-record booleans, and the `validate_upload` action honors them per-error. This isn't a question we have to debate; it's an answer we can ratify and build on.

**Resolutions for the cluster:**

- *Normalization policy.* Require exact, with two narrow exceptions. Defaults are require-exact across the board: case sensitivity, internal whitespace, numeric format, and date format are all enforced against what the configuration specifies. The two exceptions are (a) trim leading/trailing whitespace silently on every field — universally — because trailing whitespace is never a meaningful difference, and (b) honor the existing per-field `data_cleaning_flags` configuration option as the explicit place to opt into more aggressive coercion. The reasoning: silent coercion produces silent failures, and date/numeric format ambiguity is the kind of bug that ships to production. Per-field opt-in via cleaning flags lets the analyst express coercion where it's appropriate without making the whole system permissive.
- *Cross-row rule scope.* Configuration-driven per rule, with within-submission as the default. The rule schema gains a `scope` attribute taking three values (`submission`, `supplier`, `engagement`); unspecified defaults to `submission`. The validation engine reads the scope and pulls the comparison set accordingly. Within-submission is the default because it's the cheapest scope, the most common case in practice, and the safest failure mode (a missed-error is more recoverable than a false-error against data the supplier can't see).

**Schema and signature implications:**

- A `scope` attribute on the rule definition, an enum of `submission` / `supplier` / `engagement`. The data model document needs this addition.
- An optional `prior_values` parameter on `validate_upload`, shaped as `{ field_id: [{value, row_number, submission_id}, ...] }`. The orchestrating recipe handles the fetch when the rule's scope says to; the action stays pure-compute.
- A test case during the build that exercises resubmit-after-failure with a supplier-scope uniqueness rule. The pre-fetch query has to filter to *successful* prior submissions (validated, approved) — not "any prior submission" — or the supplier gets uniqueness errors against their own failed prior attempts. Easy to get wrong, worth catching with a deliberate test.

### Sibling capabilities (not in the four primary, but flagged)

Capabilities the deep dives surfaced — and the cluster resolutions added — that need their own substages or callables in Phase 1, listed here so they don't get lost between the capability-coverage map and the build queue:

*From the Invite cluster resolution:*

- *Refresh outreach.* Regenerate link, send fresh emails. Subsumes the link-refresh / re-hydration sibling the deep dive flagged for the FileStorage 10-day TTL — same work under a different name.
- *Add user to request.* Grant access, send outreach to one user. Covers the "adding users mid-engagement" gap.
- *Reassign request.* Move task to a new assignee using the platform's reassign mechanism.

*From the deep dives, unchanged:*

- *Incumbent data seeding* (P-02b's job today). Sibling of *Build XLSX template*; runs after the empty template is built.
- *Resubmission template generation with carry-forward rows.* Sibling, runs against a built template plus prior valid rows. The system-driven path on R2 failure.
- *Status-change handler* (the single-writer rule). Cross-cutting — referenced from R1, R2, R3, R5, R6, and from R2 again on display refresh.
- *Event emission* (a U-01-equivalent). Cross-cutting utility, not a domain capability.
- *Reminder eligibility evaluation.* R-07's py_eval is reference. Sibling capability or a substage of a future reminder workflow.

---

## Rationale: the catalog walk

Sixteen recipes in the catalog. Rebuild-default means we don't enumerate "rebuild" sixteen times; we group by why each callable fails the inclusion test and spend our time on the candidates for keeping. The grouping:

**Outward-facing side effects (criterion 2):** B-05 (analyst portal access webhook, calls `invite_user`), P-03a (loops over rows firing `invite_user`, `share_request`, `create_shareable_link`), P-03b (`human_review_on_existing_record` is the entire body), R-07 (scheduled reminder send). The recipe *is* the side effect.

**Persistence orchestration (criterion 2):** C-02 (reads canonical model from FileStorage, writes nine CFG/VER tables in batch — the whole job is the writes), U-01 (formats and writes to RUN_PipelineError), V-02 (reads validation tables, writes report file, creates shareable links, calls RW-01 — routing plus persistence plus outward-facing all in one).

**Multi-substage orchestrators that span capabilities (criteria 1, 2, 7):** B-01 (webhook → log → route — existed for the cross-project boundary that's gone in the new model), B-02 (same lineage, largely obsolete in "one project per workspace"), P-01 (the 94-step monolith that spans every capability in sequence), V-01a (64 steps spanning prepare → validate → persist → route).

**Capability-bearing orchestrators with mixed effects (criterion 2):** C-01 (orchestrates parse → extract → validate → persist — its substages line up well with *Validate config*, but persistence is baked in; the rebuild is mostly a re-expression of what's there with the persistence pulled into a separate explicit step), V-01b (reads six tables, reads FileStorage, runs two beefy py_evals — the py_evals are strong reference for the rebuild but the recipe fails 2, and the `today` output in the normalize py_eval also fails 3 on determinism), P-02b (reads tables, reads FileStorage, writes seeded XLSX — capability-aligned for incumbent seeding but the read/write pattern is platform-coupled).

That's fifteen of sixteen. The candidate worth a close read is P-02a.

### P-02a close-read

Walking the seven criteria explicitly:

1. **Single responsibility, capability-aligned.** Pass. One variant in, one workbook out. Maps cleanly onto *Build XLSX template* substages 4 to 9.
2. **Computation only, no platform side effects.** Pass. No table reads or writes, no FileStorage operations, no outbound calls. Returns `file_content` and `file_name` as outputs; the caller (P-01 step 45) does the FileStorage write.
3. **Deterministic.** Pass, modulo the openpyxl version. Same fields, lookups, and labels in produce the same bytes out.
4. **Input/output shapes survive the new design.** Conditional. The capability spec calls for "the validated configuration of a single template version" plus a variant identifier plus labelling context; P-02a takes flattened `fields` and `lookups` arrays separately — close enough that this is a rename-and-restructure, but worth verifying the rebuild's input shape doesn't grow a third array (rules, error translations) that would force structural change.
5. **No baked-in caller assumptions.** Pass at the recipe-shell level. The recipe is a try/catch around the py_eval. Whatever the py_eval assumes is the real question.
6. **No platform-version-specific or recipe-version-specific quirks.** **Fail.** This is the criterion the close-read disqualifies the candidate on. See below.
7. **Clear, narrow, short.** Pass on the recipe shell (seven steps). Fail on the Python — XLSX generation with dependent dropdowns is intricate, and verifying the Python is non-trivial. But it's a single self-contained block, so verification is at least possible.

The disqualifying issue on criterion 6 is the sanitization mismatch the *Build XLSX template* deep dive flagged as a known historical bug class.

In `write_named_ranges`, parent values are sanitized into named-range names by `sanitize_range_name`:

```
re.sub(r'\s+', '_', name)         # whitespace → underscore
re.sub(r'[^A-Za-z0-9_]', '', s)   # strip non-alphanumeric
'_' + s if s[0].isdigit() else s  # leading-digit guard
```

Three transformations: whitespace-to-underscore, strip-non-alphanumeric, leading-digit guard.

In the dependent-dropdown branch, the INDIRECT formula resolves the parent cell with:

```
f'INDIRECT(SUBSTITUTE({parent_letter}2," ","_"))'
```

One transformation: spaces-to-underscore. That's it.

The two are not the same function, and the difference is silent. `R&D` becomes the named range `RD` but the formula resolves it to `R&D`, so the child dropdown is blank. `IT/Security` becomes `ITSecurity` but resolves to `IT/Security`, blank. `1st Quarter` becomes `_1st_Quarter` but resolves to `1st_Quarter`, blank. Any parent value with characters outside `[A-Za-z0-9_ ]`, or starting with a digit, breaks the child dropdown silently with no error message — and unless QA happens to pick one of those parent values in testing, the bug ships.

This is exactly the failure mode the deep dive named, present in the candidate that was meant to be the cleanest carry-forward. Even setting the inclusion test aside, we wouldn't port code with a known defect into the rebuild — we'd be importing the bug along with the asset. The rebuild fixes it cleanly: one shared sanitization function, called from both sites, exercised by tests against the awkward parent-value cases (`R&D`, `IT/Security`, `1st Quarter`, leading punctuation, Unicode).

A smaller secondary issue, worth noting in passing: `field_col_map` is double-populated under both `field_name` and `lookup_name` keys, conflating two different namespaces. Probably dead code from an earlier iteration, but it's the sort of confusion that makes verification expensive — which is criterion 7's concern.

P-02a doesn't carry. The Python remains useful as reference material for the per-type DataValidation builders, the lookup grouping, and the workbook layout, but the recipe and the code as a whole get rebuilt.

### The connector

The handoff deferred connector decisions to the build session. Reading the code makes the deferral much less suspenseful — the actions are pure-compute Ruby, capability-aligned, and the methods block is composed of small well-shaped utilities. There's no useful sense in which the build session would adjudicate `validate_upload` differently from how triage adjudicates it now.

`parse_config_file` is the upstream parser the *Validate config* deep dive explicitly excluded from its own scope; its decomposition (customer, fields, rules, lookups, variants, suppliers, users, error_translations) matches the parsed-configuration object the deep dive describes. The base-variant synthesis logic — when no variants are defined, synthesize one called "base" containing every field — is a thoughtful touch that handles the empty-variant edge case the deep dive flagged.

`validate_config` is, structurally, *Validate config* itself. The check categories map directly: `lookup_references`, `depends_on_references`, `rule_target_field_exists`, `rule_condition_field_exists`, `variant_field_exists`, `user_supplier_exists`, `dependent_dropdown_has_parent`, plus the constraint checks (`no_duplicate_field_names`, etc.) and syntax checks (`interval_notation_valid`, `email_format_valid`). The `form_field_limit` warning is the kind of soft-fail the deep dive said should exist. Carries.

`validate_upload` deserves a closer look because of what it answers. The deep dive's most consequential open question was the strictness regime — soft-fail vs. hard-fail, with the predicted answer being "per-rule strictness in the configuration plus a global default rather than a single global threshold." Reading the action: that answer is already implemented. `Field.strict` and `Rule.strict_enforcement` are per-record booleans; `validate_upload` reads them per-error and decides the overall verdict (`status: passed | failed`) based on whether *any* strict error occurred. The verdict shape (status, summary, errors, valid_payload) matches the deep dive's substage 8 description. This isn't a question we have to debate further; it's an answer we can ratify and build on.

`extract_form_fields`, `generate_validation_report`, and `build_storage_path` are sibling capabilities and a utility — all carry, all shaped right.

The methods block — interval parsing and evaluation, error message resolution, boolean coercion, cleaning flags, type and format checks, sheet parsers, slug sanitization — passes the inclusion test as a collection of small pure functions that the actions are composed from. Carries with the actions.

---

## What this leaves for Phase 1

Triage produced the deliberately small carry-forward list and the capability-coverage map. The open-questions clusters worked through after triage closed the must-resolve and should-resolve items. The Phase 0 surface is now settled enough that Phase 1's build queue can start without further blocking decisions.

**Resolved:**

- *Strictness regime* (Validate supplier input). Per-rule, in the configuration. Existing connector implementation already does this — ratify and build on.
- *Connector dispositions* (SDC Platform Connector). All six actions carry, plus the methods block.
- *Task model* (Invite cluster). Designated assignee. Platform access for all users; task assigned to one primary.
- *Partial-success policy* (Invite cluster). Eventual, hard floor at the assignee.
- *Idempotency* (Invite cluster). 60-second guard on Invite.
- *Re-invite semantics* (Invite cluster). Three sibling capabilities (Refresh outreach, Add user to request, Reassign request); not modes of Invite.
- *Normalization policy* (Validate cluster). Require exact, with universal trim and per-field opt-in coercion via `data_cleaning_flags`.
- *Cross-row rule scope* (Validate cluster). Configuration-driven per rule via a `scope` attribute; default `submission`.

**Deferred (genuinely, not as decision avoidance):**

- *CI/CD connector and Data Tables API connector dispositions.* Treated as feature work for after the rebuild is coherent. Designing the deployment pipeline before the thing being deployed has settled would bake in assumptions worth discovering are wrong later.
- The "can defer to later in Phase 1" list from the handoff, unchanged. Empty edge cases, cross-version compatibility checks, X1 specification depth, etc. — surface during build if a specific capability touches them, otherwise leave alone.

**New Phase 1 work that emerged from the resolutions:**

Schema changes, all small and additive:

- A `primary` boolean on `SupplierUser`, validated as exactly-one-per-supplier at config time. (Invite cluster.)
- A `scope` attribute on the rule definition, enum of `submission` / `supplier` / `engagement`, defaulting to `submission`. (Validate cluster.)

Capability scopes to draft before building (probably half-page each, lighter than the four primary deep dives):

- *Refresh outreach.* (Invite cluster.)
- *Add user to request.* (Invite cluster.)
- *Reassign request.* (Invite cluster.)
- *Incumbent data seeding.* (Already flagged by the deep dives.)
- *Resubmission template generation.* (Already flagged.)
- *Status-change handler.* (Already flagged.)
- *Event emission utility.* (Already flagged.)
- *Reminder eligibility evaluation.* (Already flagged.)

Action signature change:

- An optional `prior_values` parameter on `validate_upload`, for supplier-scope and engagement-scope uniqueness checks. (Validate cluster.)

Test cases worth building deliberately:

- Resubmit-after-failure with a supplier-scope uniqueness rule, to catch the "filter to successful prior submissions" trap. (Validate cluster.)
- Dependent-dropdown parent values containing awkward characters (`R&D`, `IT/Security`, `1st Quarter`, leading punctuation, Unicode) to lock in the shared-sanitization invariant for *Build XLSX template*. (Triage rationale.)

The natural next step is the build queue itself — sequencing the eight capability scopes and four primary capabilities in an order that respects their dependencies (data model first, then status-change handler and event emission, then the pure-validation capabilities, then the side-effecting ones). That ordering is build-session work, not Phase 0 work.
