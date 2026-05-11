# SDC Data Collection — Recipe Plan (v1, Stage 3 provisioning workflows)

## Status

Continuation of `sdc-recipe-plan-v1.md` (Stage 1) and `sdc-recipe-plan-stage2.md` (Stage 2). Same template — four more recipes — the provisioning workflows for engagement-scope work.

Stage 3 implements **E1 (Initial provisioning)** and **E2 (Config update / re-publish)**. The four recipes split the work along natural seams: webhook intake, parse-and-build-canonical-model, hydrate the configuration tables, publish the version. E1 and E2 share most of the chain; the difference is at the boundaries (whether a Project already exists, whether the prior version needs deprecating, whether supplier records get staged).

This is the substantive engagement-side work the system depends on. Until PRV-02 produces a canonical model, VAL-01 cannot run end-to-end against real data.

---

## PRV-01 — Provisioning Webhook

### Identity
- **Code:** PRV-01
- **Name:** Provisioning Webhook
- **Domain:** PRV
- **Role:** Trigger (HTTP webhook from GAS)

### Build queue stage
Stage 3. First of the PRV chain; entry point for both E1 and E2.

### Capability
Engagement-scope workflow trigger. Receives the JSON payload GAS produces from the analyst's master config workbook, routes it into the provisioning chain. The thinnest of the four PRV recipes — its job is intake and dispatch.

### Contract

**Input (webhook payload):**
- `drive_id_config_json` (string, required) — Drive file ID of the GAS-exported config JSON
- `is_initial` (boolean, required) — `true` for E1, `false` for E2
- `correlation_id` (string, optional) — upstream traceability handle from GAS
- `analyst_email` (string, required) — for audit and failure routing

**Output:** None directly. PRV-01 fires PRV-02 asynchronously and returns an acknowledgment to GAS.

### Substage outline

1. **Validate payload shape.** Required fields present, types correct. On malformed payload, emit and return an error to GAS without firing downstream.
2. **Fetch the config JSON from Drive.** Resolve `drive_id_config_json` to file content. Save to FileStorage at `Project.parsed_config_path` (E1) or a staging location (E2 — actual storage at the project happens after Project resolution).
3. **Determine project context.** For E1, no Project exists yet; create one with a fresh `project_id`. For E2, look up the existing Project (matching by `analyst_email` + customer name in the parsed config, or by some other stable handle).
4. **Emit provisioning_triggered.** OBS-01 with the resolved `project_id` for context.
5. **Fire PRV-02.** Pass `project_id`, FileStorage path to the config JSON, `is_initial` flag, and correlation_id. Asynchronous — PRV-01 returns immediately.
6. **Return acknowledgment to GAS.** HTTP 200 with the `project_id`.

### Cross-cutting calls
- **OBS-01** — for the trigger event and any failure event
- **PRV-02** — asynchronous call to start the parse/validate/build chain

### Phases emitted
- `provisioning_triggered` (first system-side event in E1/E2)
- `recipe_failed` (on payload validation or Drive read failure)

### Error types possible
- `recipe_invariant` — payload missing required fields, `is_initial` doesn't match Project existence (e.g., `is_initial=true` but a Project for this customer already exists)
- `external_action_failed` — Drive read failed, FileStorage write failed

### State transitions triggered
None. PRV-01 doesn't touch supplier requests; it operates at the Project layer.

### Invariants honored
- **One project per workspace.** PRV-01 enforces that E1 only fires when no Project exists, and E2 only fires when one does. If `is_initial=true` and a Project already exists, the recipe rejects with `recipe_invariant`.
- **Asynchronous trigger boundary.** PRV-01 acknowledges to GAS quickly and lets the chain run async. The analyst sees "submitted, processing" rather than a 30-second blocking response.

### Open questions
- **Project resolution for E2.** How does PRV-01 know which Project an `is_initial=false` request belongs to? The customer name from the config workbook is the natural key, but it's not enforced unique anywhere. Lean: rely on the workspace-singleton invariant — there's exactly one Project per workspace, so E2 always means "the one Project here." Worth confirming this matches deployment reality.
- **Failure routing on the chain.** If PRV-02 fails downstream, the analyst submitted GAS already returned 200. The failure surface is EventLog + an email to `analyst_email` on `severity=error` events. Worth confirming the alert pathway exists (it's flagged in OBS-01's open questions).
- **Idempotency.** If GAS fires the webhook twice (network retry), PRV-01 needs to not create two Projects or fire two PRV-02 chains. Either a correlation-based dedup guard or accepting eventual duplicates and cleaning up post-hoc. Lean: dedup on `correlation_id` if present, accept the risk if not.

---

## PRV-02 — Parse Config and Build Canonical Model

### Identity
- **Code:** PRV-02
- **Name:** Parse Config and Build Canonical Model
- **Domain:** PRV
- **Role:** Callable

### Build queue stage
Stage 3. **The substantive piece** — this is where the canonical model gets built. VAL-01 cannot run end-to-end until PRV-02 is producing canonical models at the expected FileStorage paths.

### Capability
Engagement-scope orchestration. Wraps two concerns: parsing the GAS-exported JSON into a structured config (via the connector), and resolving that config into a *canonical model* (UUIDs minted, FKs wired, slot pool assigned). The canonical model is the artifact every downstream runtime consumer (VAL-01, TPL-01) reads.

### Contract

**Input (trigger schema):**
- `project_id` (string, required)
- `parsed_config_path` (string, required) — FileStorage path to the GAS export
- `is_initial` (boolean, required) — affects whether a new TemplateVersion is created or an existing one is updated
- `correlation_id` (string, optional)

**Output (return schema):**
- `template_version_id` (string) — the newly-created or updated version
- `canonical_model_path` (string) — FileStorage path to the resolved canonical model
- `validation_summary` (object) — counts and outcome from CFG-01

### Substage outline

1. **Call the connector to parse.** `parse_config_file` action with the GAS export content. Returns structured config (fields, rules, lookups, variants, suppliers, users, error_translations). Save to FileStorage as `parsed_config.json` at the version's path.
2. **Emit `config_parsed`.** OBS-01 with `project_id` and the parse summary.
3. **Call CFG-01.** Pass `parsed_config_path`. CFG-01 returns the verdict.
4. **Branch on the verdict.** If `invalid`, emit `config_rejected` (already done by CFG-01), stop the chain, return early with the validation summary. PRV-03 is not called. If `valid`, continue.
5. **Create or update the TemplateVersion.** For E1: create `CFG_TemplateVersion` row in `draft` status. For E2: create a new version (vN+1) in `draft`, leave the prior version intact (deprecation happens in PRV-04).
6. **Build the canonical model.** Python step. Take the parsed config + the new `template_version_id`. Mint UUIDs for each field, rule, lookup, variant, variant_field, form_slot_mapping. Resolve FK references (`depends_on_field_name` → field UUID, rule's `target_field_name` → field UUID, etc.). Assign slot pool positions for form-eligible fields. Build the resolved canonical model object.
7. **Write the canonical model to FileStorage.** Path: `/templates/v<NNN>/canonical_model.json`. Update `CFG_TemplateVersion.canonical_model_path` and `parsed_config_path`.
8. **Fire PRV-03.** Pass `template_version_id` and the canonical model. PRV-03 hydrates the CFG tables.
9. **Return.** The caller (PRV-01) doesn't typically consume this output, but it's available for synchronous test paths.

### Cross-cutting calls
- **OBS-01** — for `config_parsed`, `recipe_failed` on parse or canonical-model failure
- **CFG-01** — for validation
- **PRV-03** — asynchronous call to continue the chain

### Phases emitted
- `config_parsed` (after the connector's parse step)
- `config_rejected` is emitted by CFG-01, not PRV-02; the recipe just observes and routes on the verdict
- `recipe_failed` (on parse failure, canonical-model build crash, FileStorage write failure)

### Error types possible
- `config_unparseable` — the connector's `parse_config_file` returned a parse error (the GAS export was malformed)
- `config_invalid` — propagated up after CFG-01 returns invalid (PRV-02 catches this; the originating emit was CFG-01's `config_rejected`)
- `external_action_failed` — FileStorage operations failed, connector returned an error
- `unexpected_error` — Python canonical-model build step crashed

### State transitions triggered
TemplateVersion is created in `draft` (not a transition — initial state). Transition to `published` happens in PRV-04.

### Invariants honored
- **Snapshot semantics deferred.** PRV-02 builds a *draft* canonical model. The snapshot invariant kicks in at publish (PRV-04). Until then, the canonical model exists but the version is in `draft` and isn't visible to runtime consumers.
- **FK resolution at canonical-model build time.** The canonical model is the place where name-based references become ID-based references. Downstream code (VAL-01, TPL-01) never has to resolve names — it reads UUIDs from the model.

### Open questions
- **The "is CFG-01 called by PRV-02" question from Stage 2.** Resolved here: yes, PRV-02 calls CFG-01 between parse and canonical-model build. Validation gates whether the canonical model is even constructed. Worth confirming this is the right place — alternative is for PRV-01 to call CFG-01 right after parse, but that splits the parse-validate sequence across two recipes for no clear benefit.
- **Canonical model schema.** What fields does it contain? Two surfaces have come up:
  - `expected_sheet_name` for VAL-01's XLSX parser (flagged in VAL-01's plan)
  - `strict` defaults for fields and rules (the parser-defaults-to-false decision; canonical model carries through what the parser produced)
  
  Worth a small companion spec — a "canonical model shape" doc — that names the fields PRV-02 produces. Belongs alongside the data-model doc as a runtime-artifact spec rather than a database-schema spec. Not blocking PRV-02 but worth flagging.

- **What happens to draft versions that fail to publish?** PRV-02 creates the draft, PRV-04 publishes (or doesn't, if a downstream failure occurs). If the chain breaks between PRV-02 and PRV-04, the workspace has a `draft` TemplateVersion with a canonical model but no hydrated CFG tables. The cleanup path is unspecified. Options: PRV-02 explicitly cleans up on PRV-03 failure, or there's an orphan-detection sweep that runs separately. Defer; not critical for first build.
- **E2 version numbering.** Where does the new version number come from? The natural answer: `MAX(version_number) + 1` from `CFG_TemplateVersion`. Worth confirming Workato Data Tables supports this query pattern cleanly; if not, PRV-02 reads all existing versions and computes.

---

## PRV-03 — Hydrate CFG Tables

### Identity
- **Code:** PRV-03
- **Name:** Hydrate CFG Tables
- **Domain:** PRV
- **Role:** Callable

### Build queue stage
Stage 3. Called by PRV-02 after canonical model is written. Last work before PRV-04 publishes.

### Capability
Persistence. Takes the canonical model produced by PRV-02 and writes one row per entity into the CFG_* tables. This is the step where the data tables become queryable for this version's configuration. The WFA app reads CFG_* tables directly (for form labels, dropdown values, etc.), so hydration is the precondition for the WFA app showing anything sensible for this version.

### Contract

**Input (trigger schema):**
- `template_version_id` (string, required)
- `canonical_model_path` (string, required) — passed in for clarity, even though the path is also on `CFG_TemplateVersion`

**Output (return schema):**
- `hydration_summary` (object) — row counts written per table

### Substage outline

1. **Read the canonical model.** FileStorage read at `canonical_model_path`.
2. **Batch create per CFG_ table.** Walk the canonical model's entity collections:
   - `cfg_fields` → `CFG_Field` rows
   - `cfg_lookups` → `CFG_Lookup` rows
   - `cfg_rules` → `CFG_ValidationRule` rows
   - `cfg_variants` → `CFG_Variant` rows
   - `cfg_variant_fields` → `CFG_VariantField` rows
   - `cfg_form_slot_mappings` → `CFG_FormSlotMapping` rows
   - `cfg_error_messages` → `CFG_ErrorMessage` rows
   
   Each row stamps `template_version_id` so the version is the join key.
3. **Validate hydration.** Re-query each table and confirm row counts match the canonical model. A discrepancy is a system invariant violation — emit `recipe_failed` with `recipe_invariant`.
4. **Emit summary.** OBS-01 — but **no dedicated phase**; this is internal bookkeeping, the meaningful milestone is `version_published` at PRV-04. The hydration emit happens only if hydration fails.
5. **Fire PRV-04.** Pass `template_version_id`.

### Cross-cutting calls
- **OBS-01** — on failure only
- **PRV-04** — asynchronous call to continue the chain

### Phases emitted
- `recipe_failed` (only — hydration success is implicit in `version_published` downstream)

### Error types possible
- `external_action_failed` — Data Tables batch create failed
- `recipe_invariant` — hydration count mismatch, canonical model missing expected collections

### State transitions triggered
None directly. The TemplateVersion's `draft → published` transition happens in PRV-04.

### Invariants honored
- **Snapshot semantics will lock in at publish.** PRV-03 writes to CFG_ tables under a `draft` version. Until PRV-04 publishes, these rows are editable. After publish, they're immutable.

### Open questions
- **No success emit feels weird.** PRV-03 does substantial work and emits nothing on success. The principle is "no per-phase emit on intermediate steps" — the workflow's milestone is `version_published`, not `tables_hydrated`. But it's the kind of recipe that someone debugging "where did provisioning stop" would want a marker for. Two options. (a) Stay disciplined; debugging uses `current_state_entered_at`-like timestamps on the version row, plus `recipe_failed` if it fails. (b) Add a `cfg_hydrated` phase to the taxonomy. Lean (a) for now — the phase taxonomy discipline matters, and the workflow milestone *is* `version_published`. If debugging proves cumbersome, add the phase deliberately.
- **Failure during partial hydration.** If `CFG_Field` rows write but `CFG_Lookup` rows fail, the version has half-hydrated tables. Cleanup options similar to the PRV-02 question: explicit rollback (delete the partial rows), orphan detection, or leave it — the draft version is already inconsistent and PRV-04 won't publish it. Lean: leave it, let an orphan sweep handle it later.
- **Batch size for Workato Data Tables.** Some collections (especially `CFG_Lookup`, which can have hundreds of values across many lookups) may exceed batch limits. Worth knowing the limit and chunking accordingly. Stress-test during build.

---

## PRV-04 — Publish Version

### Identity
- **Code:** PRV-04
- **Name:** Publish Version
- **Domain:** PRV
- **Role:** Callable

### Build queue stage
Stage 3. Last of the PRV chain.

### Capability
The transition that locks the snapshot. Marks the TemplateVersion as `published`, deprecates the prior version (for E2), and produces the per-variant XLSX templates that suppliers will eventually receive. For E1, also stages the initial `SUP_Supplier`, `SUP_SupplierUser`, and `SUP_SupplierRequest` rows. The recipe that closes the provisioning workflow.

### Contract

**Input (trigger schema):**
- `template_version_id` (string, required)

**Output (return schema):**
- `status` (string) — `published`
- `variant_count` (integer) — number of variant templates produced

### Substage outline

1. **Read the canonical model.** From `CFG_TemplateVersion.canonical_model_path`.
2. **For each variant, call TPL-01.** Pass `canonical_model_path`, `variant_id`, labelling context. Get back XLSX bytes.
3. **Store each variant's bytes to FileStorage.** Path: `/templates/v<NNN>/variants/<variant_id>.xlsx`. Update `CFG_Variant.template_path`.
4. **Determine whether this is E1 or E2.** If a prior `CFG_TemplateVersion` exists at `published` for this project, this is E2.
5. **For E2: deprecate the prior version.** Update the prior `CFG_TemplateVersion.status` to `deprecated`. Emit `version_deprecated`.
6. **Publish this version.** Update `CFG_TemplateVersion`: set `status` to `published`, stamp `published_at`. **From this moment, snapshot semantics lock in** — no row scoped to this version is ever updated.
7. **For E1 only: stage supplier records.** Walk the canonical model's suppliers and users. Create one `SUP_Supplier` per supplier, one `SUP_SupplierUser` per user (with the `primary` flag from the parsed config), one `SUP_SupplierRequest` per supplier in `pending` state. Emit `suppliers_staged`.
8. **Emit `version_published`.** OBS-01 with `template_version_id`, variant count, and the E1/E2 distinction in `details_json`.
9. **Emit `provisioning_complete`.** Terminal milestone for the workflow.
10. **Return.**

### Cross-cutting calls
- **OBS-01** — for `template_built` (one per variant, emitted by TPL-01), `version_deprecated` (E2 only), `suppliers_staged` (E1 only), `version_published`, `provisioning_complete`
- **TPL-01** — once per variant
- **No STS-01 calls** — the supplier requests are created directly in `pending` state. `pending` is the initial state, not a transition.

### Phases emitted
- `template_built` (delegated to TPL-01 — one per variant)
- `version_deprecated` (E2 only)
- `suppliers_staged` (E1 only)
- `version_published`
- `provisioning_complete`
- `recipe_failed` (on any infrastructure failure)

### Error types possible
- `external_action_failed` — FileStorage writes, Data Tables updates
- `recipe_invariant` — canonical model missing expected variants; trying to publish a version that's not in `draft`; in E2, no prior published version found despite the recipe expecting one
- `unexpected_error` — TPL-01 returned an unexpected shape

### State transitions triggered
- `CFG_TemplateVersion`: `draft → published` (this version)
- `CFG_TemplateVersion`: `published → deprecated` (E2 only, prior version)
- For E1: creates `SUP_SupplierRequest` rows in `pending`. Not a transition — initial state. The first real transition for these requests is `pending → sent` via R1.

### Invariants honored
- **Snapshot semantics.** The `published` transition is the moment after which no row scoped to this version can be edited. PRV-04 is the enforcer — once it stamps `published_at`, every downstream recipe is bound by the invariant.
- **In-flight suppliers stay on their version.** For E2, the recipe **does not touch** existing `SUP_SupplierRequest` rows on the prior version. They keep their original `assigned_version_id` and run to terminal on the deprecated version.
- **Supplier independence from versions.** For E1, `SUP_Supplier` and `SUP_SupplierUser` rows are created without a `template_version_id` FK. They're version-independent identities.
- **Exactly one primary user per supplier.** For E1's user staging, this invariant must hold (validated upstream by CFG-01). PRV-04 trusts the upstream validation; it doesn't re-check.

### Open questions
- **What if TPL-01 fails for one variant out of many?** Two options. (a) Fail the entire PRV-04 invocation — no version is published if any variant failed to render. (b) Publish the version anyway and flag the failed variant; suppliers assigned to that variant get held up at R1. Lean (a) — partial publish is the kind of inconsistent state that produces "why is this supplier stuck" support tickets weeks later. All variants must succeed for publish to fire.
- **E2 supplier staging.** PRV-04 currently stages supplier records only for E1. For E2, suppliers added to the config workbook *aren't* incrementally added — the chain runs to publish, but the new supplier records aren't created. This is a known gap (per the workflow stages doc's open question 1). Worth surfacing whether E2 should stage *new* suppliers (those not present in the prior version's supplier list) or whether that's deferred. Defer for now; E2 currently means "update the configuration for in-flight suppliers"; adding suppliers mid-engagement is a different operation that doesn't have a workflow yet.
- **Seeded data wiring.** If `Project.seeded_data_path` is set, the build queue calls for Incumbent Data Seeding to fire in the PRV chain (Stage 6 work, deferred). PRV-04 either calls a seeding capability or doesn't; lean: defer entirely, supplier records get seeded data slices populated by a separate Stage 6 step *after* publish completes.
- **Atomicity of the publish moment.** PRV-04 does many writes — variant templates, version status, supplier records. If it crashes mid-way, the system is in a partially-published state. The invariant says publish is a moment; the implementation crosses it as a sequence of writes. Worst case: prior version is deprecated, new version is `draft`, no `published` version exists for the project, suppliers can't be invited. Cleanup path is to retry PRV-04 idempotently — re-running should pick up where it left off. Worth a "PRV-04 idempotency" build check.

---

## Stage 3 cross-cutting notes

Provisioning is **engagement-scope, infrequent, and multi-recipe**. Two implications for how the four recipes work together:

**The chain runs asynchronously.** PRV-01 acknowledges to GAS quickly; PRV-02 fires PRV-03 which fires PRV-04. From the analyst's perspective, the provisioning workflow takes 30 seconds to a minute (depending on variant count and config size) and the only signal is EventLog plus a completion email. The asynchronous boundary is at PRV-01/GAS; everything after that is sequential async-via-Workato.

**Failure cleanup is sketched, not built.** Each recipe's "open questions" section flags partial-failure cleanup. The unifying answer: PRV-04's transition to `published` is the commit moment. A failure anywhere before that leaves a `draft` version with partial side effects but **nothing visible to suppliers or the WFA**. A failure during PRV-04 itself is the worst case — partially published state — and is the one that warrants idempotent retry logic.

**The canonical model is the contract.** Every downstream consumer reads it. PRV-02 produces it; PRV-03 hydrates from it; PRV-04 reads it for variants; VAL-01 reads it for validation; TPL-01 reads it for templates. The schema of the canonical model is the most important artifact in the system after the data model itself. **Worth a dedicated companion spec** — `sdc-canonical-model-shape-v1.md` or similar — naming the fields PRV-02 produces and the contracts downstream consumers depend on. Not blocking Stage 3 build but flagged as the natural next planning artifact after Stage 3's plan lands.

### Pre-positioned test cases for Stage 3

From the build queue:

- **PRV-04 idempotent retry.** Verify that re-running PRV-04 against a partially-published version completes the publish cleanly. Catches the atomicity-of-publish trap.
- **PRV-02 FK resolution.** Synthetic config with cross-reference chains: a rule whose target field has a `depends_on` to another field. The canonical model's FK resolution must traverse correctly. Reference material: the V-01b transpose Python from the old workspace.
- **E2 prior-version deprecation.** Confirm that after E2 runs, the prior version is `deprecated` and no `SUP_SupplierRequest` rows have been touched.
- **PRV-04 partial-variant failure.** Force one TPL-01 call to fail. Confirm that no version is published and the workspace is in a `draft` state that's safe to retry.

---

## What's next

Stages 4 onward, in order:

**Stage 4 — Invitation:**
- INV-01 (Invite supplier users) — domain code TBD per the cross-cutting open question in the sibling scopes

**Stage 5 — Submission + Review:**
- UPL-01 (File submission intake / R2 trigger)
- REV-01 (Analyst review handler / R5)
- (R6 cancellation likely needs no dedicated recipe; cancellation routes through STS-01 with `trigger_context=analyst_cancel` from the WFA)

**Stage 6 — Smart-UX paths:**
- UPL-02 (Resubmission template generation)
- INC-01 (Incumbent data seeding) — likely a new domain code

**Stage 7 — Invite cluster siblings:**
- INV-02 (Refresh outreach)
- INV-03 (Add user to request)
- INV-04 (Reassign request)

**Stage 8 — Reminders:**
- REM-01 (Reminder firing)
- REM-02 (Reminder eligibility evaluation) — possibly a method on STS-01 or its own callable

That's roughly 9–10 more recipes across Stages 4–8. Each gets the same structural treatment.

The companion canonical-model shape spec (flagged above) is worth doing **before Stage 4**. It's the natural next planning artifact — Stage 4's INV-01 reads supplier and user data from a place that depends on what PRV-04 staged, and having the canonical model shape locked down clarifies the boundary.
