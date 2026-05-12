# SDC Data Collection — Recipe Plan (v1, Stage 6 smart-UX paths)

## Status

Continuation of `sdc-recipe-plan-v1.md` (Stage 1), `sdc-recipe-plan-stage2.md` (Stage 2), `sdc-recipe-plan-stage3.md` (Stage 3), `sdc-recipe-plan-stage4.md` (Stage 4), and `sdc-recipe-plan-stage5.md` (Stage 5). Same template.

Stage 6 is the **smart-UX** stage. The happy path (Stages 1–5) works end-to-end; Stage 6 adds the features that make the supplier experience smoother. Two recipes:

- **UPL-02 (Resubmission template generation)** — extends REV-01's reject path with a "rejection with corrections" mode where the analyst marks specific issues and the system produces a corrections-prefilled template.
- **INC-01 (Incumbent data seeding)** — during E1 provisioning, if the analyst has supplied existing data about the suppliers, INC-01 generates per-supplier seeded templates pre-filled with that data.

Both recipes produce per-supplier-per-context XLSX files. They share a common underlying mechanism (template building with prefill data) but fire from different triggers — UPL-02 reactively from REV-01, INC-01 proactively during provisioning.

---

## Domain code decision: INC for incumbent data

Build queue flagged "likely a new domain code" for incumbent data seeding. Candidates were `INC` (incumbent), `SED` (seed), or absorbing into PRV.

**Decision: `INC` for incumbent data domain.** Reasoning:

- "Incumbent" captures the staffing-industry meaning (existing supplier relationships, prior data, ongoing contracts) better than the generic "seed."
- Future sibling work — re-seeding from updated incumbent data, syncing changes mid-engagement, cross-engagement incumbent matching — naturally clusters under the same domain.
- Absorbing into PRV would conflate provisioning workflow with data-population work; they have different lifecycles (PRV is one-shot at config change, INC may be invoked multiple times).

`INC-01` is the primary; future siblings (INC-02 re-seed, etc.) are not currently planned but the domain reserves space for them.

---

## UPL-02 — Resubmission Template Generation

### Identity
- **Code:** UPL-02
- **Name:** Resubmission Template Generation
- **Domain:** UPL (upload handling)
- **Role:** Callable

### Build queue stage
Stage 6. Called by REV-01's extended reject path when the analyst marks specific issues for correction.

### Capability
Smart-UX extension to the reject path. Takes a rejected submission plus analyst-marked corrections and produces a pre-filled template that highlights the issues and (optionally) pre-populates valid cells, making the supplier's resubmission easier and more accurate.

The "rejection with corrections" feature is what UPL-02 enables. Without UPL-02, a rejected supplier resubmits using the original blank template; with UPL-02, they resubmit using a personalized template that shows what they submitted, which cells failed validation, and what the analyst's feedback was at the cell level.

### Contract

**Input (trigger schema):**
- `supplier_request_id` (string, required)
- `validation_result_id` (string, required) — the failed validation that's being responded to
- `review_note_id` (string, required) — the new `RUN_ReviewNote` that triggered this regeneration
- `analyst_corrections` (array of objects, required) — per-cell annotations from the analyst: `{row_index, field_id, annotation_text, severity}`

**Output (return schema):**
- `corrections_template_path` (string) — FileStorage path to the generated template
- `suggested_filename` (string)

### Substage outline

1. **Read context.** Read the supplier request, the failed `RUN_ValidationResult`, all `RUN_FieldError` rows for that result, the `RUN_Upload` row for `submitted_path`, and the canonical model for the assigned version.
2. **Read the submitted data.** Branch on `submission_source`:
   - *File:* FileStorage read `submitted_path`, parse XLSX, transpose to record-shape rows. (This is the same logic as VAL-01's Phase 2 extraction — worth confirming whether to factor it out as a shared utility action on the connector, or duplicate. Build-time decision.)
   - *Manual entry:* FileStorage read `extracted_path` — rows are already serialized.
3. **Build the corrections overlay.** For each row, for each cell:
   - Was there a `RUN_FieldError` for this (row, field)? If so, mark it for highlighting.
   - Is there an `analyst_corrections` entry for this (row, field)? If so, capture the annotation text and severity.
   - The merge produces a per-cell overlay: `{value, validation_error?, analyst_annotation?, severity}`.
4. **Call the connector.** A new action (sibling to `build_template`) — call it `build_corrections_template` — taking `canonical_model_json`, `variant_id`, `prefill_rows`, and `overlay` parameters. Returns XLSX bytes with the prefill values, error highlights, and annotation comments rendered into cells. Cell-level rendering details (red fill for errors, yellow for warnings, openpyxl comments for annotations) are build-time decisions.
5. **Store the corrections template.** FileStorage write at `/corrections/<supplier_request_id>/<submission_attempt>.xlsx`. The path naming surfaces the request and attempt.
6. **Update the review note.** Set `RUN_ReviewNote.regenerated_template_path` to the new path. This is the audit trail — every regeneration is tied to a specific review event.
7. **Emit `corrections_template_built`.** OBS-01 with the request ID, validation result ID, and counts (cells highlighted, annotations applied).
8. **Return** the path and filename.

UPL-02 does not transition state and does not directly contact the supplier. REV-01 (Stage 5, extended for Stage 6) is responsible for calling STS-01 with `trigger_context=analyst_reject_with_corrections` and passing the corrections path in `context_bag`. STS-01's derivation embeds the link in `supplier_message` via UTL-01.

### Cross-cutting calls
- **OBS-01** — for the success event and any failure event

### Phases emitted
- `corrections_template_built` (success)
- `recipe_failed` (on infrastructure failure)

### Error types possible
- `recipe_invariant` — validation result not found, review note not found, canonical model unreadable, analyst_corrections references a field_id not in the canonical model
- `external_action_failed` — FileStorage operations failed, connector returned an error
- `unexpected_error` — connector's `build_corrections_template` action crashed (e.g., on edge-case data)

### State transitions triggered
None. UPL-02 produces an artifact; REV-01 handles the transition.

### Invariants honored
- **Pure construction (with persistence).** UPL-02 produces the corrections template and stores it; it doesn't transition state, doesn't message suppliers, doesn't grant access. Same shape as TPL-01 + a write step.
- **Per-attempt isolation.** Each corrections template is stored at a path that includes `submission_attempt`. A supplier who fails three times has three corrections templates in FileStorage, one per attempt, none overwriting the others.
- **Review-note linkage.** Every corrections template is tied to a specific `RUN_ReviewNote`. The audit chain is: rejection → review note → corrections template → next submission. Walkable in both directions.

### Open questions
- **Shared extraction utility vs. duplication.** VAL-01 and UPL-02 both need to extract rows from a submitted XLSX. The logic should be identical (same canonical model, same expected sheet name, same transpose). Options: (a) Factor into a shared connector action that VAL-01 also adopts; (b) Duplicate the Python step in UPL-02; (c) UPL-02 reads the *already-extracted* data from somewhere VAL-01 wrote it (e.g., VAL-01 persists extracted rows to FileStorage as a side effect, UPL-02 reads from there). Lean (c) for the cleanest separation — but requires VAL-01 to gain a small persistence step. Worth deciding before UPL-02 build; for now, the plan assumes (a) or (c), with (b) as a fallback.
- **Cell-level rendering choices.** The connector's `build_corrections_template` action needs to decide how to mark errors and annotations. Options: red fill for hard errors / yellow for warnings / openpyxl comments for analyst notes; or a separate "Issues" sheet that lists problems by row; or both. Lean: both — fills and comments inline (immediate visual signal), plus a summary sheet for analysts who want an at-a-glance view. Build-time detail; the plan reserves the connector surface.
- **What does the supplier see if they had partial successes?** A submission with 100 rows, of which 30 failed — does the corrections template show all 100 with 30 highlighted, or only the 30? Lean: show all 100. Removing valid rows would lose context (the supplier wouldn't know what they correctly submitted). The 30 highlighted are clearly distinguishable.
- **Resubmission against the corrections template.** When the supplier downloads the corrections template, makes changes, and re-uploads, does VAL-01 treat the upload normally? Yes — VAL-01 doesn't know or care that the template is a corrections version. It validates against the canonical model, which is unchanged. The corrections feature is purely a supplier-facing UX layer; the validation engine is unaffected.
- **What if the analyst marks zero corrections?** REV-01's reject path supports both "plain reject" and "reject with corrections." If the analyst clicks "reject with corrections" but doesn't mark any cells, the corrections template would just be the submitted data without highlights. Two options: (a) UPL-02 still produces a template (which is functionally just a "here's what you sent, please fix it" template), (b) REV-01 detects empty corrections and downgrades to plain reject. Lean (b) — a corrections template with no corrections is misleading. REV-01 checks and falls back.

---

## INC-01 — Incumbent Data Seeding

### Identity
- **Code:** INC-01
- **Name:** Incumbent Data Seeding
- **Domain:** INC (incumbent data)
- **Role:** Callable

### Build queue stage
Stage 6. Called by PRV-04 during E1 provisioning if `Project.seeded_data_path` is set.

### Capability
Smart-UX feature for engagements where Randstad or the client has pre-existing data about the suppliers. INC-01 reads that data and generates per-supplier seeded templates — XLSX files pre-filled with what's already known, so suppliers only need to fill gaps and verify rather than re-enter everything from scratch.

INC-01 fires once per E1 provisioning (if seeded data is supplied). It produces one seeded template per supplier that has seed data; suppliers without seed data fall back to the default `CFG_Variant.template_path`.

### Contract

**Input (trigger schema):**
- `template_version_id` (string, required) — the version this seeding is for
- `seeded_data_path` (string, required) — FileStorage path to the seed data file
- `project_id` (string, required) — for resolving the supplier list

**Output (return schema):**
- `seeded_supplier_count` (integer) — how many suppliers got seeded templates
- `unseeded_supplier_count` (integer) — how many had no matching seed data
- `errors` (array) — per-supplier error reports if seeding failed for some

### Substage outline

1. **Read the canonical model.** From `CFG_TemplateVersion.canonical_model_path`. Needed for the template build engine.
2. **Read the seed data file.** Format is system-defined — likely an XLSX with one sheet per supplier or a single sheet with a `supplier_id` column. Parse into a `{supplier_id: rows}` mapping. (Format spec is build-time; the plan reserves the input.)
3. **Read the supplier list.** Query `SUP_Supplier` for the project — these are the suppliers PRV-04 just staged. Resolve each to their `SUP_SupplierRequest` row (one request per supplier for E1).
4. **Per-supplier seeded template generation.** For each supplier that has matching seed data:
   - **4a.** Determine the supplier's variant from `SUP_SupplierRequest.assigned_variant_id`.
   - **4b.** Call the connector — same action UPL-02 uses (`build_corrections_template` or a sibling, depending on whether prefill and corrections logic share a single action). Pass `canonical_model_json`, `variant_id`, `prefill_rows`, and no overlay (no errors, no annotations — seeding is pure prefill).
   - **4c.** Store the XLSX at `/seeded/<supplier_request_id>.xlsx`.
   - **4d.** Update `SUP_SupplierRequest.seeded_template_path` to the new path.
5. **Emit `supplier_seeded`.** One emit per seeded supplier, severity `info`. The phase taxonomy doesn't currently include this — needs adding to the taxonomy v1 list.
6. **Emit `seeding_complete`.** Once, at the end. Carries counts in `details_json`.
7. **Return** the summary.

INV-01 (Stage 4, no plan changes needed) reads `SUP_SupplierRequest.seeded_template_path` before falling back to `CFG_Variant.template_path`. If seeded path is set, the supplier's invitation link points to the seeded template; otherwise, to the variant default.

### Cross-cutting calls
- **OBS-01** — for per-supplier and summary events

### Phases emitted
- `supplier_seeded` (one per supplier; new phase, needs taxonomy update)
- `seeding_complete` (once per invocation; new phase, needs taxonomy update)
- `recipe_failed` (on infrastructure failure)

### Error types possible
- `recipe_invariant` — seed data file missing or malformed, canonical model unreadable, supplier list empty (PRV-04 staging failed and INC-01 was called anyway)
- `external_action_failed` — FileStorage operations failed, connector returned an error
- `unexpected_error` — connector crash on edge-case seed data

### State transitions triggered
None. INC-01 produces artifacts and updates a non-status field (`seeded_template_path`); state transitions are not in its scope. The supplier's request remains in `pending` (the state PRV-04 created it in) until R1 fires.

### Invariants honored
- **Snapshot semantics deferred.** INC-01 writes to `SUP_SupplierRequest` (a `SUP_*` table) during draft-version provisioning. Once PRV-04 has marked the version `published`, the seeded templates are part of the version's frozen state. Subsequent E2 provisionings produce *new* versions with their own (possibly re-seeded) templates.
- **Idempotency at the per-supplier level.** If INC-01 fails partway through and is re-invoked, each per-supplier step is independently re-runnable. The corrections-template path overwrites; if the same template is re-generated, the result is identical.
- **Fallback discipline.** Suppliers without seed data get nothing — `seeded_template_path` stays null. INV-01's fallback to `CFG_Variant.template_path` handles them. INC-01 never produces an "empty seeded template" as a partial result.

### Open questions
- **Seed data file format.** This is the largest open question. The format determines what the analyst supplies, how INC-01 parses, and what error messages mean. Options: (a) An XLSX matching the variant's column structure, with one row per supplier and a `supplier_identifier` column; (b) A more flexible format that allows partial coverage (some fields, some suppliers); (c) Multiple XLSX files, one per supplier, named by `supplier_identifier`. Lean (a) — single file, structured like the template, easy for analysts to produce. Needs a small spec doc (`inc-01-seed-data-format-v1.md` or similar) before INC-01 build.
- **Supplier identification key.** How is "the seed data row for supplier X" matched to the `SUP_Supplier` row for X? Options: `supplier_email`, a custom analyst-supplied identifier, the supplier's name (fragile). Lean: a `supplier_identifier` column in the seed file that matches `SUP_Supplier.identifier` (a new field that the parsed config also produces, matching the workbook's primary contact email or a deliberate ID column). Needs the parsed config schema to support this; if it doesn't currently, that's a Stage 6 prerequisite.
- **What happens with E2 (re-publish)?** When the analyst updates the config and a new version is published, the previously-seeded templates were for the *old* version. Three options: (a) E2 re-runs INC-01 against the new version, producing new seeded templates; (b) E2 carries forward seeded data unchanged, the new version inherits seeded paths; (c) E2 invalidates seeded paths and suppliers fall back to the variant default. Lean (a) — the most thorough — but it requires the seed data path to still be available. The Project's `seeded_data_path` is set per-engagement; if E2 reads it again, the same data is re-applied. Build-time decision.
- **Concurrent template generation.** INC-01 generates templates per-supplier in a loop. For 50+ suppliers, this could be slow. Options: parallelize via Workato's batch processing, accept serial timing, or move the generation to a background queue. Lean: serial for first build, evaluate against actual provisioning time. The supplier-facing impact is "how long after analyst clicks 'publish' until suppliers can be invited" — likely acceptable at minutes-scale.
- **Partial seed data — what if a supplier has data for only some fields?** Lean: render the seeded template with the fields that have data, leave the rest blank. Same behavior as a partial upload — the supplier fills in the gaps.
- **Phase taxonomy update.** `supplier_seeded` and `seeding_complete` are new phases. They belong in the engagement-scope phase category (similar to `suppliers_staged`). Worth a small amendment to the phase taxonomy doc when Stage 6 is built; not blocking the plan.

---

## Stage 6 cross-cutting notes

**Both recipes share a connector surface.** UPL-02 and INC-01 both need "build a template with prefilled rows and optional overlay." The connector should expose this as one action (likely a generalized `build_template` with optional prefill and overlay parameters), not two. Worth flagging at build — the temptation will be to split the actions per-recipe; the discipline is to share. Same template engine, different callers.

**The smart-UX layer is the first place the recipes care about the *supplier's prior submission*.** Stages 1–5 treated each submission as an independent event. Stage 6 introduces cross-event awareness: the corrections template references the prior validation result; the seeded template references engagement-pre-existing data. This is a meaningful architectural shift, even though the recipes are small.

**PRV-04 gets a small amendment.** Substage 7 of PRV-04 stages suppliers for E1. Stage 6 inserts a new Substage 7.5: "If `Project.seeded_data_path` is set, call INC-01." The amendment doesn't change PRV-04's responsibilities; it adds one optional call.

**REV-01 gets a meaningful amendment.** The reject path branches: plain reject (`trigger_context=analyst_reject`) vs. reject with corrections (`trigger_context=analyst_reject_with_corrections`). The corrections branch calls UPL-02, captures the path, passes it in `context_bag` to STS-01. STS-01's derivation table gains a new row for the with-corrections case. The amendment is small in scope but touches three recipes (REV-01, UPL-02, STS-01).

**Phase taxonomy and derivation table updates required.** Stage 6 introduces new phases (`corrections_template_built`, `supplier_seeded`, `seeding_complete`) and new trigger_contexts (`analyst_reject_with_corrections`). Both taxonomies and STS-01's derivation table need updates before the recipes can run. Worth bundling these into a "Stage 6 prerequisites" mini-amendment that touches the relevant docs together.

### Pre-positioned test cases for Stage 6

From the build queue and deep dives:

- **UPL-02 happy path.** Supplier submits → validation fails on 5 of 100 rows → analyst rejects with corrections marked on 3 cells → UPL-02 produces a template with all 100 rows pre-filled, 5 highlighted (validation errors), 3 with annotations (analyst's). Supplier downloads, fixes, resubmits. Round-trip succeeds.
- **UPL-02 empty corrections fallback.** Analyst clicks "reject with corrections" but marks zero cells. REV-01 detects empty corrections and downgrades to plain reject. UPL-02 is not called.
- **UPL-02 repeated rejection.** Two consecutive corrections-template generations against the same request (two rejection cycles). Each stored at a path including `submission_attempt`. Both queryable via their respective `RUN_ReviewNote` rows.
- **INC-01 happy path E1.** Analyst supplies seed data file → PRV-04 runs → INC-01 generates seeded templates for matched suppliers → INV-01 issues invitations using seeded paths → suppliers see pre-filled templates.
- **INC-01 partial matching.** Seed data covers 7 of 10 suppliers. INC-01 produces 7 seeded templates; 3 suppliers fall back to variant default. No errors emitted for unmatched suppliers (it's not an error, it's a normal partial-coverage case).
- **INC-01 E2 re-seeding.** E2 publishes a new version. INC-01 re-runs against the new version with the same seed data file. Old version's seeded paths are untouched; new version has new seeded paths. In-flight suppliers (still on old version) keep their old templates; new suppliers (none, in this case, since E2 doesn't currently add suppliers) would use new ones.
- **INC-01 malformed seed data.** Seed data file references a `supplier_identifier` not in `SUP_Supplier`. INC-01 logs the unmatched identifier, continues with matched ones. Returns a non-empty `errors` array. PRV-04 sees the partial success and decides whether to publish anyway (lean: publish anyway, treating seed data as best-effort).

---

## What's next

**Stage 7 — Invite cluster siblings:**
- INV-02 (Refresh outreach)
- INV-03 (Add user to request)
- INV-04 (Reassign request)

**Stage 8 — Reminders:**
- REM-01 (Reminder firing)
- (Reminder eligibility — possibly its own callable, possibly a method)

Two stages remaining. After Stage 8, the recipe planning artifact is complete. Stage 9 (engagement closure) and Stage 10 (monitoring) per the build queue are small enough to either fold into existing recipes (Stage 9: REV-01's approve path is most of engagement closure already) or warrant a brief addendum rather than full per-recipe plans.

The Stage 6 prerequisites bundle (phase taxonomy update, derivation table row, PRV-04 amendment, REV-01 amendment) is the natural follow-up artifact when Stage 6 build begins. Not blocking Stage 7 planning.
