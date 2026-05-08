# SDC Data Collection — Callable Triage (v1, Phase 0)

## Status

Closes Phase 0. Companion to the workflow inventory, the data model, the stage-by-stage workflow document, the four capability deep dives, and the Phase 0 handoff that set the rebuild-default stance.

Two formal outputs, per the handoff:

1. A **carry-forward list** — what survives the inclusion test and is reused in Phase 1.
2. A **capability-coverage map** — for each of the four capabilities, what carries forward and what gets built.

Stance, recapped: rebuild is the default disposition. The capability deep dives are the source of truth. A callable carries forward only if it passes all seven criteria of the inclusion test in the handoff. The bar is high on purpose, and the carry-forward set is meant to be defensibly small.

What changed during triage: the connector decisions, deferred to the build session in the handoff, are now made — we read the code, the actions are pure-compute and capability-aligned, and there's no useful sense in which the build session would adjudicate differently. They're folded into this document.

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

**To build:** the full capability per the deep dive's substages 1 to 7.

**Reference material:** P-03a's structure (resolve users, generate link, loop), P-03b's task-assignment shape. Useful as a starting outline; the actual implementation is new.

**Open questions that gate the build:**

- *Partial-success policy.* All-or-nothing vs. eventual. The most consequential open question for this capability — every retry path and every analyst-visible status hangs off the answer.
- *Per-user vs. shared task* on the supplier portal.
- *Re-invite semantics.* Refuse, refresh quietly, or stamp as a distinct event.
- *Idempotency mechanism.* State-based guard at step 6 is the simplest answer and worth confirming.

### Validate supplier input

**Carries forward:** `validate_upload` from the connector is the engine. `generate_validation_report` is the sibling that shapes the result into a supplier-facing report.

**To build:** a recipe-level orchestration that handles the upstream transformation (parse XLSX into rows for file submission, or read RUN_ManualEntry rows for manual entry) and the downstream persistence (writes the validation result and per-error rows as the system of record per the deep dive). The validation engine itself is the connector action.

**Reference material:** V-01b's "transpose to entity-attribute-value" py_eval (step 23) for the XLSX-to-rows transformation.

**Strictness regime — substantively settled by the existing code.** The deep dive flagged "soft-fail vs. hard-fail granularity" as the central open question and predicted the answer would be "per-rule strictness in the configuration plus a global default rather than a single global threshold." That's exactly what the existing connector and configuration schema already do — `Field.strict` and `Rule.strict_enforcement` are per-record booleans, and the `validate_upload` action honors them per-error. This isn't a question we have to debate; it's an answer we can ratify and build on.

**Still-open:** normalization policy (case sensitivity, whitespace, numeric coercion, date format ambiguity) and cross-row rule scope (within submission, across this supplier's submissions, across all suppliers in this engagement). The connector's `apply_cleaning_flag` and `check_data_type` give us hooks for normalization; the policy choice is what's missing.

### Sibling capabilities (not in the four primary, but flagged)

Capabilities the deep dives surfaced that need their own substages or callables in Phase 1, listed here so they don't get lost between the capability-coverage map and the build queue:

- *Link refresh / re-hydration* (FileStorage 10-day TTL). Either a mode of *Invite supplier users* or a sibling.
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

Triage produced the deliberately small carry-forward list and the capability-coverage map. What it didn't produce, on purpose, was decisions on the open questions that shape the build. Those are the next thing to settle, and the triage gives us better leverage on them than we had going in:

**Resolved by demonstration during triage:**

- *Strictness regime.* Per-rule, in the configuration. The connector and schema already implement this; the build ratifies and extends rather than designs from scratch.
- *Connector dispositions.* All six SDC Platform Connector actions carry. Decisions on the CI/CD and Data Tables API connectors stay deferred per the handoff.

**Still must resolve, ideally before the relevant capability is built:**

- *Partial-success policy* for *Invite supplier users* — all-or-nothing vs. eventual.
- *Per-user vs. shared task* on the supplier portal.
- *Re-invite semantics* — refuse, refresh quietly, or distinct event.
- *Idempotency mechanism* for *Invite supplier users* — state-based guard at step 6 is the suggested default.

**Should resolve during build:**

- *Normalization policy* for *Validate supplier input* — case sensitivity, whitespace, numeric coercion, date format ambiguity. A coherent stance across all field-level checks.
- *Cross-row rule scope* — within submission, across this supplier's submissions, or across the engagement.

**Can defer:** the existing list from the handoff, unchanged.

The natural next step is to pick up partial-success policy. It gates the most downstream work, and now that strictness is no longer the central open question, it's the one most worth resolving before the *Invite supplier users* build session.
