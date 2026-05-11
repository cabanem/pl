# SDC Data Collection — ADR Triage (v1, Phase 0)

## Status

Workstream 4 of Phase 0. Pass-through review of all existing ADRs against the v1 design captured in `sdc-data-model-v1.md`, `sdc-state-machines-v1.md`, and `sdc-naming-conventions-v1.md`. Each ADR is marked **still-applies**, **obsolete**, or **needs-revisiting**. Companion document to the three workstream-1–3 docs; precedes the callable reuse-vs-rebuild workstream.

The ADR file as triaged contains 61 entries (ADR-000 through ADR-060). The Phase 0 plan referenced "AD-1 through AD-38"; the count grew to 61 between plan-time and triage-time. All 61 are triaged here.

## Foundational decisions

Three answers shaped the triage:

1. **Two questions per ADR.** Does the problem still exist in v1? If yes, does the recorded decision still solve it correctly? An ADR survives intact only if both answers are yes; otherwise it lands in obsolete or needs-revisiting.

2. **The threshold for needs-revisiting is "load-bearing."** An ADR earns a rewrite when its principle is meaningfully shaping v1 design (version chain of custody, lifecycle separation, auto-versioning) but its references — recipes, tables, multi-project artifacts — are stale enough that leaving the document in place misleads. ADRs whose surviving principle is generic engineering hygiene ("single responsibility per recipe") get marked obsolete and absorbed by v1's structure rather than rewritten.

3. **Patterns get called out once, not repeated 11 times.** The multi-project collapse, the recipe naming supersession, and the state machine redesign each take down a cluster of ADRs for the same reason. The clusters are named in the cross-cutting patterns section; per-ADR notes reference them rather than restating.

## Summary of triage

| Status | Count | Share |
|---|---|---|
| still-applies | 34 | 56% |
| needs-revisiting | 9 | 15% |
| obsolete | 18 | 29% |
| **Total** | **61** | **100%** |

Three observations from the distribution:

- **More than half survive intact.** The platform's foundational decisions — EAV transpose, append-only execution, asynchronous validation, configurable error messages, slot pool, validation pipeline split, structured event logging, supplier-as-authenticated-user — are unchanged by the v1 model. The reorganization affected topology, not the core operational model.
- **The obsolete pile is dominated by one cluster.** Of 18 obsolete ADRs, 9 collapse with the multi-project model. Most of the rest collapse with the dual-state-machine model or the GAS-controller pattern. Few ADRs are obsolete on their own merits; almost all of them go down with a structural change made elsewhere.
- **The needs-revisiting pile is small and load-bearing.** Nine ADRs need rewrites — most because they capture a principle that v1 still relies on but reference dead recipes or extinct tables. Each rewrite is bounded; none requires reopening a foundational decision.

## Cross-cutting patterns

Three clusters explain most of the obsolete and needs-revisiting calls. Each is described once here; per-ADR notes reference them by name.

### Cluster A — Multi-project model collapse

The largest single source of obsolescence. The v1 model is one workspace, one project, one set of tables. The home-base-project + per-client-folder + cross-client orchestration model that ran through the prior workspace is gone. Every ADR anchored in that topology — WorkspaceRegistry, the routing seam, manifest_id chains, table_results_map persistence, the R-2a/R-2b infrastructure-vs-data split, client folder self-containment, the home base as control plane — collapses for the same reason: there is no inter-folder boundary left to govern. Affected ADRs: **009, 022, 023, 024, 026, 029, 033, 041, 044, 045** (nine).

### Cluster B — Recipe naming supersession

Workstream 3 adopted `<DOM>-<NN>` naming over 9 domain codes (PRV, CFG, VAL, UPL, STS, REM, REV, OBS, UTL). This supersedes the older `{phase}_{sequence}` convention (ADR-052) and renders most legacy R-### references stale. ADRs whose surviving principle is independent of recipe naming retain their **still-applies** status with stale-reference notes; ADRs whose entire content was a specific R-### decomposition decision (e.g., the R-008/R-004 split) become **obsolete** because the v1 callable triage will redecide the decomposition under the new naming. Affected ADRs as primary cause: **002, 004, 052**. Many other ADRs carry stale R-### references as a secondary issue.

### Cluster C — State machine redesign

Workstream 2 redesigned the SupplierRequest state machine (six states), formalized the Upload/ValidationResult/TemplateVersion machines, established the single-writer rule for status fields, and collapsed the parallel WFA-stage tracking system into a derived view of `status`. ADRs whose specific transition tables or states are now wrong are marked **obsolete** (the principle of separate lifecycles is reaffirmed by workstream 2; the specific machines are not). Affected ADRs: **039, 054 (partial), 055, 056**.

## Conflicts requiring resolution

Two architectural claims in the existing ADRs directly contradict v1 design decisions. The triage marks the affected ADRs based on the v1 stance, but the underlying claims should be confirmed before the v1 stance is locked.

### Conflict 1 — WFA relation traversal

**ADR-038** (slot label denormalization) and **ADR-051** (`customer_name` denormalization onto SupplierRequest) both rest on the same load-bearing claim:

> *"The Workflow App form builder binds directly to data table columns. It cannot perform joins to CFG_FormSlot at render time."* (ADR-038)
>
> *"WFA pages cannot traverse relation columns to display fields from linked tables."* (ADR-051)

The v1 data model contradicts this directly:

> *"Form labels via linked table. The WFA app can join `FormSlotMapping` at render time, so the 20 `*_label` columns on the old request table are gone; labels live in one place per version."* (`sdc-data-model-v1.md`, foundational decisions)

The two stances cannot both be correct. Three possibilities:

- **(a)** New WFA capability discovered between ADR-038/051 authorship and v1 design — joins are now possible. The v1 stance stands; ADR-038/051 are obsolete.
- **(b)** ADR-038/051 were always overstated — joins were possible all along for the relevant binding shapes, just not for the specific case the original author hit. The v1 stance stands; ADR-038/051 are obsolete.
- **(c)** v1 is wrong — WFA still cannot traverse, and the linked-table approach to FormSlotMapping labels and Project's `customer_name` will not render. v1 must walk back to denormalization for at least the supplier-facing fields.

The triage marks ADR-038 and ADR-051 as **needs-revisiting** rather than committing to obsolete, pending resolution of which possibility holds. If (a) or (b), they fold to obsolete. If (c), v1 needs amendment and these ADRs likely return as still-applies.

### Conflict 2 — Re-stamping pending records on config update

**ADR-039** ("Re-publish stamps pending records, freezes those in progress") asserts pending SupplierRequest rows get their `assigned_version_id` rewritten when a new template version publishes. **ADR-046** ("Existing suppliers unaffected by config updates") asserts no automatic migration. The v1 data model marks `assigned_version_id` as immutable on SupplierRequest, which structurally chooses ADR-046 over ADR-039 — even pending records can't be re-stamped if the FK is immutable.

The triage marks **ADR-039 obsolete** and **ADR-046 still-applies** on this basis. If you want to preserve the smart-UX behavior of ADR-039 (pending suppliers see the latest config without manual analyst action), the immutability invariant on `assigned_version_id` would need to relax for the `pending` state specifically. That's a real design choice, not just a wording fix; flagging here so it's not silently locked.

---

## Triage table

| ADR | Title | Status | Note |
|---|---|---|---|
| 000 | EAV transpose before validation | still-applies | EAV shape preserved on `RUN_FieldError` and `RUN_ManualEntry`. |
| 001 | CFG tables as runtime configuration | still-applies | All `CFG_*` tables are data, per workstream 1. Prefix now formally `CFG_` per workstream 3. |
| 002 | Separation of bootstrap and outreach | obsolete | Cluster B. R-008/R-004 references dead; surviving principle (single responsibility) is generic. |
| 003 | Auto-versioning in R-008 | needs-revisiting | Principle survives — see elaboration. |
| 004 | R-008 owns record creation | obsolete | Cluster B. Same as ADR-002. |
| 005 | Single validation recipe for all paths | still-applies | VAL-01 still spans file upload, manual entry. EAV transpose makes inputs shape-agnostic. |
| 006 | Callable recipes as internal functions | still-applies | Workato recipe-to-recipe handoff convention unchanged. |
| 007 | Idempotent infrastructure provisioning | needs-revisiting | Scope narrowed — see elaboration. |
| 008 | Append-only execution layer | still-applies | `RUN_*` tables are append-only; reaffirmed by state machine invariant 7 (repeated failures don't churn state). |
| 009 | Workspace-level client data isolation | obsolete | Cluster A. v1 is one project per workspace; row-level scoping by `template_project_id` is gone. |
| 010 | Templates are generated artifacts, not stored assets | still-applies | Generated from `CFG_Field` on demand. File handle is now `*_path` per workstream 3. |
| 011 | Asynchronous validation | still-applies | Upload owns the in-flight pipeline; SupplierRequest waits in resting states. |
| 012 | Configurable error messages | still-applies | `CFG_ErrorMessage` per-version copies, snapshot integrity. |
| 013 | Apps Script ↔ Workato via webhooks | still-applies | Reaffirmed by ADR-021. |
| 014 | Environment-specific values in workspace properties | obsolete | Cluster A. Multi-client property pattern is gone; `Project` singleton holds engagement-level config. |
| 015 | Incumbent data as a first-class workflow state | still-applies | `has_seeded_data` preserved. Field name `seeded_data_file_id` becomes `seeded_slice_path` per workstream 3. |
| 016 | Suppliers are authenticated users, not anonymous submitters | still-applies | `SUP_SupplierUser` preserved. |
| 017 | Store file paths, not file content | still-applies | Reinforced by workstream 3 invariant 8 (path canonical, link volatile). UPDATE clause in ADR re: `{client-slug}_{variant-slug}_…` naming is superseded by workstream 3's `/requests/<request_id>/…` layout. |
| 018 | UI layer contains no business logic | obsolete | GAS-controller pattern. With ADR-021 collapsing GAS to a thin webhook trigger, there's no UI layer with logic to govern. |
| 019 | Per-client configurable reminder schedule | still-applies | `Project.reminder_days_1/2/3` preserved. Workstream 2 adds `reminders_enabled` and `default_due_days`. |
| 020 | Four independent lifecycle boundaries | needs-revisiting | Three of four lifecycles survive — see elaboration. |
| 021 | Collapse Apps Script to thin webhook trigger | still-applies | Reaffirmed throughout. GAS does only `onOpen` → menu → `UrlFetchApp.fetch`. |
| 022 | Workato home base project as control plane | obsolete | Cluster A. No home base; the workspace is the system. |
| 023 | Single workspace with a multi-workspace seam | obsolete | Cluster A. WorkspaceRegistry, R-1b routing seam — gone. |
| 024 | correlation_id as a universal tracing key | obsolete | Cluster A. Demoted to `external_request_id` (plain string, no FK). Internal tracing now via `EventLog.supplier_request_id`. |
| 025 | Five-point version chain of custody | needs-revisiting | Principle survives — see elaboration. |
| 026 | Split R-2a and R-2b | obsolete | Cluster A. The infrastructure-vs-data-hydration split was a multi-folder concern. v1's decomposition is decided in callable triage. |
| 027 | Config file as source of truth, parsed once | still-applies | `parsed_config_path` on both `Project` (workspace-scope) and `CFG_TemplateVersion` (per-version snapshot). |
| 028 | Multi-user supplier model | needs-revisiting | Direction right, model evolved — see elaboration. |
| 029 | Manifest based IaC versioning | obsolete | Cluster A. Recipe-bundle versioning now via Workato's native project export. |
| 030 | Webhook contract design (lean payload) | still-applies | Pointers, not data. Recipe references stale (R-1, R-2b → PRV-01, PRV-02). |
| 031 | SDC platform connector for domain logic | still-applies | Phase plan flags Connector as port-as-is. |
| 032 | Automated configuration phase | still-applies | PRV chain still automates hydration. |
| 033 | Client folder self-containment | obsolete | Cluster A. No client folders. |
| 034 | Field visibility authored in spreadsheet, derived in pipeline | still-applies | `_field_visibility` extraction pattern preserved. `CFG_Field.visible` is the merged result. |
| 035 | Form field extraction as a separate connector action | still-applies | Connector is port-as-is. |
| 036 | Control type derived from data type and data format | still-applies | `CFG_Field.control_type` derived in connector. |
| 037 | Fixed slot pool with config-driven assignment | still-applies | 20-slot typed pool (8/2/4/4/2) preserved on `SUP_SupplierRequest`. |
| 038 | Slot metadata denormalized into supplier request records | needs-revisiting | **Conflict 1 above.** v1 stance: labels live on `FormSlotMapping`, joined at render. ADR's premise that joins are unsupported contradicts that. |
| 039 | Re-publish stamps pending records, freezes those in progress | obsolete | **Conflict 2 above.** v1's `assigned_version_id` immutability structurally chooses ADR-046 over this. |
| 040 | Configuration update reuses the front door | still-applies | Webhook is the single entry point for both initial provisioning and updates. |
| 041 | R-2b stays in the base project | obsolete | Cluster A. No base/client split. |
| 042 | One hydration recipe for all versions (monolithic R-2b) | needs-revisiting | Principle survives in modified form — see elaboration. |
| 043 | Version scoping, not deletion | still-applies | Reaffirmed by snapshot semantics invariant (workstream 1 invariant 2). |
| 044 | Every webhook gets a CFG_Request record | obsolete | Cluster A. The `Requests` / `HOME_Requests` table is gone with the multi-project model; webhook audit trail is now `EventLog`. |
| 045 | table_results_map persisted to FileStorage | obsolete | Cluster A. No multi-folder model means no table_results_map. |
| 046 | Existing suppliers unaffected by config updates | still-applies | Reinforced by `assigned_version_id` immutability on `SUP_SupplierRequest`. |
| 047 | No incremental supplier bootstrapping on config update | still-applies | Adding suppliers stays an explicit analyst action; deferred until use case forces it. |
| 048 | Slot-based manual input staging | still-applies | Slot pool → `RUN_ManualEntry` mapping preserved. Recipe references stale. |
| 049 | Validation pipeline split into Python pre-processing and SQL | still-applies | Connector is port-as-is. Two-phase pipeline (Python parse + 16-CTE SQL) intact. |
| 050 | Rule keys are backend_error_code, not display names | still-applies | `CFG_ValidationRule.rule` stores error codes; `_mapping` is canonical. |
| 051 | customer_name denormalized onto WFA_SupplierRequest | needs-revisiting | **Conflict 1 above.** v1 removes `customer_name` from SupplierRequest, sourcing from `Project` singleton via join. |
| 052 | Recipe naming convention | obsolete | Cluster B. Superseded by `<DOM>-<NN>` over 9 domain codes (workstream 3). |
| 053 | Task assignment wired to WFA_SupplierUser | still-applies | `SUP_SupplierUser` is the FK target for any per-user task. P-03/S-00 references stale. |
| 054 | Stage change moved from submission recipe to validation recipe | needs-revisiting | Cluster C. Principle survives in altered form — see elaboration. |
| 055 | Three state machines govern the provisioning lifecycle | obsolete | Cluster C. Specific transition tables are wrong; superseded by `sdc-state-machines-v1.md`. Principle (separate lifecycles) is reaffirmed there. |
| 056 | State machines documented in working spreadsheet | obsolete | Cluster C. Workstream 2 chose markdown over spreadsheet; ADR's premise (markdown can't hold transition tables) is reversed. |
| 057 | Observability through structured event logging | still-applies | `EventLog` in v1 (bare-named, no `SYS_` prefix per workstream 3). |
| 058 | Event phase taxonomy is canonical and shared | still-applies | `EventLog.phase` field; shared vocabulary across recipes. |
| 059 | U-01 generalizes from error handler to event emitter | still-applies | One emitter, severity-keyed. Recipe handle becomes `OBS-01` (or similar) per workstream 3 naming. |
| 060 | Generalization criteria for shared recipes | still-applies | General engineering principle. B-01/B-05 references stale. |

---

## Needs-revisiting elaborations

The nine entries marked needs-revisiting, with sketches of the rewrite direction.

### ADR-003 — Auto-versioning

**Surviving principle.** When a new template version publishes, `version_number` increments automatically by querying the highest existing value. No hardcoded `version_number: 1`, no manual recipe edits per re-publish.

**Rewrite direction.** Restate against `CFG_TemplateVersion`. The recipe owning version creation in v1 (currently expected to land in the PRV domain — likely PRV-04 or whatever the publish-version callable is named after callable triage) computes `MAX(version_number) + 1` for the project at write time. Re-publishes are safe and traceable via the version_number sequence plus `published_at` timestamps.

### ADR-007 — Idempotent infrastructure provisioning

**Surviving principle.** Recipes that create resources check before creating, so re-runs are safe.

**Scope change.** "Infrastructure provisioning" in the ADR meant the multi-table-creation surface of R-2a — creating per-client tables, deferred relations, recipe clones. None of that exists in v1; the workspace's tables are static. What survives is much smaller: the PRV chain creating the `Project` row, the initial `CFG_TemplateVersion`, and supplier rows on first-publish. Each of those still earns idempotency (the same webhook firing twice should not produce two `Project` rows). Rewrite as "Idempotent provisioning" without "infrastructure," scoped to PRV-domain row creation.

### ADR-020 — Independent lifecycle boundaries

**Surviving principle.** Distinct lifecycles get distinct state machines; conflating them produces ambiguous status fields.

**Count change.** The ADR names four boundaries: workspace, recipe bundle, business template, request. v1 collapses workspace into the project itself (one workspace = one project, no separate workspace lifecycle to track). Three remain: recipe bundle (Workato project export, outside the data model), business template (`CFG_TemplateVersion`), and request (`SUP_SupplierRequest`). Workstream 2 adds Upload and ValidationResult as additional machines, formalized in `sdc-state-machines-v1.md`. Rewrite as "Independent lifecycle boundaries (three across the data model, plus Upload/ValidationResult sub-machines)."

### ADR-025 — Version chain of custody

**Surviving principle.** Version identity is copied forward at known freeze points; no recipe ever reads a mutable "current version" pointer that could change between write and read.

**Rewrite direction.** The five-point chain (R-2a → R-2b → R-008 → R-007a → R-002) referenced specific recipes that no longer exist. The v1 chain is shorter and uses workstream-3 recipe names: `CFG_TemplateVersion` published with status `published` (PRV chain) → `assigned_version_id` stamped on `SUP_SupplierRequest` (PRV chain, immutable) → `template_version_id` copied onto `RUN_Upload` from `SUP_SupplierRequest.assigned_version_id` (UPL-01) → `template_version_id` copied onto `RUN_ValidationResult` from `RUN_Upload` (VAL-01). Three freeze points in v1, not five; each freeze inherits, never looks up. The principle is preserved verbatim.

### ADR-028 — Multi-user supplier model

**Surviving principle.** Portal access (who can log in and upload) is decoupled from outreach target (who gets reminder emails). Multi-user-per-supplier is supported.

**Model change.** ADR-028 made `WFA_SupplierUser → WFA_SupplierRequest` the FK direction. v1 inverts that: `SUP_SupplierUser → SUP_Supplier` (workstream 1, group C). Users are first-class to the supplier, surviving across template versions and re-engagement. The cardinality and access-scope logic in the ADR is correct in spirit but anchored in the wrong relation. Rewrite to reflect: SupplierUser belongs to Supplier; portal scoping joins `current_user → SUP_SupplierUser → SUP_Supplier → SUP_SupplierRequest`.

### ADR-038 — Slot metadata denormalization

**Conflict 1 above.** Pending resolution of WFA traversal capability. If joins are supported (v1's stance), this ADR is obsolete. If joins are not supported, v1 needs to restore the `*_label` columns on `SUP_SupplierRequest` and this ADR returns as still-applies. Rewrite is contingent.

### ADR-042 — One hydration recipe for all versions

**Surviving principle.** Initial provisioning and config update share parse/validate/hydrate logic. One recipe, parameterized, beats two recipes that drift.

**Rewrite direction.** R-2b is being decomposed in callable triage; whatever lands as the v1 hydration callable (likely a CFG-domain recipe) inherits the `is_initial` parameter pattern. The dual-path semantics — initial calls the supplier-bootstrap step, update does not — survive. Rewrite once callable triage names the recipe.

### ADR-051 — customer_name denormalization

**Conflict 1 above.** Same shape as ADR-038. If WFA can join, v1's stance (drop `customer_name` from `SUP_SupplierRequest`, source from `Project` singleton) holds and the ADR is obsolete. If not, this ADR returns as still-applies and v1 needs amendment.

### ADR-054 — Stage change after task resolution

**Surviving principle.** `app_function_return` terminates recipe execution. Side effects that depend on task resolution must run in the next recipe in the chain, not in the recipe that returns.

**Model change.** The ADR was anchored in the dual-state-machine model: `status` and `WFA stage` were separate fields, and the stage change to "Validating" had to move out of WFA-03. In v1, WFA stage is a derived view of `status` — there's only one field to update, written by the single status-change handler (STS-01). The constraint about `app_function_return` terminating execution still applies: the submission recipe (UPL-domain) writes `status = submitted` *before* the return; the status-change handler invocation that flips the request to its post-submission resting state runs from the validation recipe afterward. Rewrite to restate against the single-writer model: the recipe that resolves the task writes the pre-return status; the next recipe in the chain invokes the status-change handler.

---

## Backports queued for end-of-Phase-0

Items that fall out of triage and fold into existing or future workstream documents.

- **ADR-017 UPDATE clause supersession.** The file naming convention `{client-slug}_{variant-slug}_{version-short}_{date}.xlsx` is superseded by workstream 3's `/requests/<request_id>/…` layout. Note in any rewritten ADR-017 successor.
- **ADR-024 retirement and EventLog tracing story.** With `correlation_id` demoted to `external_request_id` (plain string, no FK), the in-system tracing story changes. Internal correlation now flows through `EventLog.supplier_request_id` plus the audit chain (`Upload → ValidationResult → FieldError`). Worth a short note in observability documentation that "tracing across recipes" no longer relies on a universal key.
- **Recipe-reference cleanup pass.** Many still-applies ADRs carry stale R-### references (R-1, R-2b, R-008, R-007a, R-002, V-01, etc.). At ADR rewrite time, map these to workstream-3 names. The mapping is partial in `sdc-naming-conventions-v1.md`'s migration table and will be completed during callable triage.
- **WFA traversal claim verification.** Whichever way Conflict 1 resolves, both v1 docs and the affected ADRs (038, 051) need to reflect the resolved stance. If v1 is right, ADR-038/051 fold to obsolete. If v1 is wrong, `*_label` columns return to `SUP_SupplierRequest` and `customer_name` is restored.
- **Config-update re-stamp policy.** If you want to preserve ADR-039's smart-UX behavior (pending suppliers see the latest config without manual analyst action), the `assigned_version_id` immutability invariant relaxes for the `pending` state. That's a workstream-2 amendment; flagging here so it's visible if it comes up.

---

## Deliberately omitted

- **A "needs-clarification" status.** Considered for Conflict 1 (ADR-038, 051) and Conflict 2 (ADR-039 vs 046). Rejected: the conflicts are surfaced in their own section, and the affected ADRs land in needs-revisiting (which already covers "the recorded decision needs to change before locking"). Adding a fourth status would split the same concept across two labels.

- **A pattern-collapse rule that absorbs ADRs into workstream docs without explicit triage.** Considered: simply note "the multi-project ADRs are gone with the model" and not list them. Rejected: an ADR triage doc whose audit value is in being explicit about each entry. The Cluster A/B/C summaries do the deduplication; per-ADR rows still record the call.

- **Splitting "obsolete-but-principle-survives" from pure obsolete.** Considered as a sub-status. Rejected: collapses cleanly into the threshold rule in foundational decision 2. If the surviving principle is generic engineering hygiene or implicit in v1's structure, it's obsolete; if it's load-bearing, it's needs-revisiting. The line is workable in practice.

- **Promoting any v1-introduced principle to a new ADR slot.** Considered for the path-canonical-link-volatile rule (workstream 3 invariant 8), the audit-chain-carries-the-why rule (workstream 2 foundational decision 1), and the supplier-extracted-from-request decision (workstream 1 foundational decision 4 implicit). Rejected for now: these live in their workstream docs, where they're co-located with the model that produced them. ADR-format may be appropriate later if a unified ADR record is the chosen format post-Phase-0; deferring that meta-decision.

- **Renumbering or rewriting ADRs in place.** All ADR rewrites are queued for after Phase 0 completes; this triage document records the calls but does not modify the ADR file. Treating the existing ADR file as a historical record (with this triage as the lens) is simpler than maintaining a parallel rewritten ADR set during Phase 0.

---

## Pending in Phase 0

- **Callable reuse-vs-rebuild.** The final workstream. Several needs-revisiting ADRs (003, 007, 020, 025, 042, 054) will get their rewrites resolved once callable triage names the recipes that own each principle.
- **Conflict 1 resolution.** WFA relation traversal capability — confirmation needed before ADR-038, ADR-051 statuses lock.
- **Conflict 2 acknowledgment.** Re-stamp behavior on config update — confirm the v1 stance (no re-stamping, even of pending records) is the intended one before ADR-039 status locks.
