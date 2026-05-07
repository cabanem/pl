# SDC Data Collection — Naming & Conventions (v1, Phase 0)

## Status

Workstream 3 of Phase 0. Locked decisions on table prefixes, field-level naming conventions, file storage layout, and recipe naming are recorded here. Companion document to `sdc-data-model-v1.md` and `sdc-state-machines-v1.md`. ADR triage and callable reuse-vs-rebuild are still pending in subsequent sessions.

## Foundational decisions

Five answers shaped the conventions:

1. **Prefixes are shelves, not labels.** A table prefix earns its keep when it tells a recipe author something they'd otherwise have to look up. `CFG_` carries snapshot/immutable semantics; `RUN_` and `SUP_` group by lifecycle role for navigation. `Project` and `EventLog` are bare because they cross all groups.

2. **Path is canonical, link is volatile.** Every long-lived file reference is a path. Shareable links are generated on demand by a single helper recipe. The 10-day FileStorage TTL is one recipe's problem, not the data model's.

3. **Files belong to the entity that creates them.** No parent row mirrors child file pointers. Recipes that need the latest upload join `RUN_Upload`; recipes that need the latest validation report join `RUN_ValidationResult`.

4. **One-shot data, smart-UX resubmissions.** Submissions are atomic — wholesale validation, wholesale approval — but resubmission templates carry forward valid rows so the supplier only fixes what's broken. The data layer doesn't accumulate; the UX does.

5. **Recipes are addressed by domain plus sequence.** A 3-letter domain code plus a number gives every recipe a stable handle, independent of folder location, callable-vs-trigger role, or eventual restructuring.

## Summary of changes from the prior workspace

**Table prefixes:**
- 7 prefixes (HOME_, MAIN_, WFA_, VER_, CFG_, RUN_, SYS_) → 3 (CFG_, SUP_, RUN_) plus bare for Project and EventLog
- HOME_ and WFA_ retired (cross-project scope and stage-machine concept both gone)

**Field naming:** ratified the snake_case + `<verb>_at` + positive-boolean conventions implicit in the v1 data model. Two columns renamed for consistency:
- `RUN_Upload.valid_payload` → `valid_payload_json`
- `RUN_ValidationResult.valid_rows` / `invalid_rows` → `valid_row_count` / `invalid_row_count`

**File model:** every file column reshaped from `*_file_id` (Workato handle, often paired with a `*_link`) to `*_path`. Eight file fields on `SUP_SupplierRequest` collapse to three:
- `latest_upload_file_id`, `last_submitted_file_link` → drop (read from `RUN_Upload`)
- `last_validation_report_path`, `last_validation_report_link` → drop (read from `RUN_ValidationResult`; link via `UTL-01`)
- `seeded_template_file_id` → drop (was just `template_path` after seed merge)
- `seeded_data_file_id` → `seeded_slice_path` (scope clarified: this request's slice, not the source dataset)

**Project gains:**
- `seeded_data_path` — source-of-truth seeded dataset at project scope, nullable

**Recipe naming:** ad-hoc names (P-01, C-01, V-01a, F-CALLBACK-LOG) → `<domain>-<seq>` over 9 domains (PRV, CFG, VAL, UPL, STS, REM, REV, OBS, UTL).

---

## Group-level prefixes

Three prefixes for the 16 grouped tables; two tables stay bare.

| Prefix | Scope | Tables |
|---|---|---|
| (none) | Workspace singleton or cross-cutting | Project, EventLog |
| CFG_ | Version-scoped configuration; snapshot/immutable after publish | TemplateVersion, Field, Lookup, ValidationRule, Variant, VariantField, FormSlotMapping, ErrorMessage |
| SUP_ | Supplier domain; survives across versions | Supplier, SupplierUser, SupplierRequest |
| RUN_ | Per-request runtime artifacts | Upload, ValidationResult, FieldError, ManualEntry, ReviewNote |

**FK columns do not carry table prefixes.** `SUP_SupplierRequest.supplier_id` references `SUP_Supplier.supplier_id`, not `SUP_Supplier.SUP_supplier_id`. Prefixes live on table names only.

**The `SUP_Supplier` stutter is accepted.** The prefix is a shelf marker, not a phonetic element. Dropping it for one table to avoid the stutter would introduce an exception clause that the consistency benefit was meant to avoid.

**Extensibility.** The rule reads as "prefix marks lifecycle group; bare means singleton or cross-cutting." When the reminder workflow eventually needs a per-send tracking table, it falls under RUN_ rather than earning its own prefix.

---

## Field-level conventions

Snake_case throughout. Table names are the only PascalCase surface, locked by the prefix scheme above.

**Primary keys.** `<entity>_id`. UUIDs by default. (`project_id`, `validation_result_id`, `form_slot_id`.)

**Foreign keys.** Column name mirrors the referenced PK exactly. No source-table prefix on FK columns.

**Datetimes.** `<verb>_at`. (`approved_at`, `submitted_at`, `created_at`, `completed_at`, `published_at`, `current_state_entered_at`.)

**Booleans.** Positive form, never negated. Three sub-patterns:
- `has_<thing>` for presence (`has_seeded_data`)
- `<thing>_enabled` for opt-in flags (`reminders_enabled`)
- Bare adjectives for properties (`required`, `strict`, `visible`, `resolved`)

Pick whichever reads most naturally; don't force one shape.

**Enums.** snake_case values, lowercase. (`pending_review`, `supplier_action_required`, not `PendingReview` or `SUPPLIER_ACTION_REQUIRED`.)

**File pointers.** `<purpose>_path` for FileStorage references. Drive references use `*_drive_folder_id` / `*_drive_file_id`. The storage system is in the column name so re-hydration knows where to look.

**Shareable links.** `*_link` for URL-shaped values. Always paired with a `*_path`; the link is volatile, the path is stable. Links are not stored as long-lived state — see invariant 8.

**External references.** `external_*` for upstream-system traceability strings that don't FK locally. (`external_request_id`.)

**"Last" vs "current".** `last_*` for snapshots of the most recent occurrence (`last_reminder_sent_at`, `last_invalid_row_count`); `current_*` for active pointers to a related row (`current_validation_result_id`). The distinction is meaningful — `last_*` survives state transitions as historical residue; `current_*` is replaced as state moves.

**Defaults.** `default_*` for fallback values (`default_variant_id`, `default_due_days`).

**JSON columns.** `*_json` suffix for long-text columns containing JSON payloads (`valid_payload_json`, `details_json`). Storage shape is explicit at the column level.

---

## File model

### Principles

1. All long-term file references are paths.
2. Files are owned by the entity that creates them; parent rows don't mirror child file pointers.
3. Paths are computed and stored at row-creation time; no recipe ever appends suffixes at read time.
4. Links are generated on demand by `UTL-01`; TTLs are not the data model's problem.
5. Every file lives at one canonical path. New content means a new entity row with a new path (sole exception: invariant 11).

### Layout

```
/configs/
  parsed_config.json                                   Project.parsed_config_path
  incumbent_data.xlsx                                  Project.incumbent_data_path
  seeded_data.xlsx                                     Project.seeded_data_path

/templates/v<NNN>/
  master.xlsx                                          CFG_TemplateVersion.master_template_path
  parsed_config.json                                   CFG_TemplateVersion.parsed_config_path
  variants/<variant_id>.xlsx                           CFG_Variant.template_path

/requests/<request_id>/
  template.xlsx                                        SUP_SupplierRequest.template_path
  seeded_slice.xlsx                                    SUP_SupplierRequest.seeded_slice_path
  approved.xlsx                                        SUP_SupplierRequest.approved_path
  uploads/<upload_id>/
    submitted.xlsx                                     RUN_Upload.submitted_path
    extracted.json                                     RUN_Upload.extracted_path
  validations/<validation_result_id>/
    report.xlsx                                        RUN_ValidationResult.report_path
```

Path segments use stable identifiers — UUIDs for entities that have them, immutable `version_number` for versions. `<variant_id>` is preferred over `variant_name` for variant files: even though `variant_name` is immutable within version, the UUID removes a variable from "what makes a path stable."

### Seeded data

Three distinct artifacts, separated cleanly:

1. **Source seeded dataset** — `Project.seeded_data_path`. One per project. Nullable. Provided at project start or later; late provision triggers slice-and-distribute for any in-flight requests that should pick it up.
2. **Split config** — `Project.incumbent_split_config`. The metadata describing how to slice (typically by supplier name; one row per resource).
3. **Per-request slice** — `SUP_SupplierRequest.seeded_slice_path`. Derived from #1 by applying #2 at provisioning time. The supplier-facing template is rendered with this slice merged in; no separate "seeded template" file is needed.

### Field renames from the v1 data model

| Old | New |
|---|---|
| `Project.parsed_config_file_id` | `Project.parsed_config_path` |
| `Project.incumbent_data_file_id` | `Project.incumbent_data_path` |
| (new) | `Project.seeded_data_path` |
| `CFG_TemplateVersion.master_template_file_id` | `CFG_TemplateVersion.master_template_path` |
| `CFG_TemplateVersion.parsed_config_file_id` | `CFG_TemplateVersion.parsed_config_path` |
| `CFG_Variant.template_file_id` | `CFG_Variant.template_path` |
| `SUP_SupplierRequest.template_file_id` | `SUP_SupplierRequest.template_path` |
| `SUP_SupplierRequest.approved_file_id` | `SUP_SupplierRequest.approved_path` |
| `SUP_SupplierRequest.seeded_data_file_id` | `SUP_SupplierRequest.seeded_slice_path` |
| `SUP_SupplierRequest.seeded_template_file_id` | (drop) |
| `SUP_SupplierRequest.latest_upload_file_id` | (drop; read from `RUN_Upload`) |
| `SUP_SupplierRequest.last_submitted_file_link` | (drop; generate via `UTL-01`) |
| `SUP_SupplierRequest.last_validation_report_path` | (drop; read from `RUN_ValidationResult.report_path`) |
| `SUP_SupplierRequest.last_validation_report_link` | (drop; generate via `UTL-01`) |
| `RUN_Upload.submitted_file_id` | `RUN_Upload.submitted_path` |
| `RUN_Upload.extracted_file_version_id` | `RUN_Upload.extracted_path` |
| (new) | `RUN_ValidationResult.report_path` |

### One-shot data with smart-UX resubmissions

Settled question: when a 3000-row submission has 2 invalid rows, the system rejects all 3000, but the resubmission template carries forward the 2998 valid rows so the supplier only fixes the 2.

**Data model:** atomic. ValidationResult is per-Upload. Approval is wholesale. Row-level state machines and accumulating datasets are not introduced.

**UX:** a recipe (`UPL-02 Generate Resubmission Template`) fires on the system-driven `sent → supplier_action_required` transition. It reads the failing upload's `extracted_path`, identifies invalid rows from `RUN_FieldError`, and renders a fresh template at `SUP_SupplierRequest.template_path` with valid rows pre-populated and invalid rows flagged. The analyst-driven rework path defaults to a blank template; carry-forward becomes a UX option for content-level rework reasons (deferred to the review workstream).

This decision rests on two facts: the operating model is one-shot (the state machine treats `approved` as terminal), and templates do not reliably carry a row-level business key across submissions (so accumulation can't be uniform across the platform). The implicit assumption that one row represents a distinct resource is strong enough to make the smart-UX path feel right, but not strong enough to support cross-submission row identity.

### Re-hydration

`UTL-01 Generate Shareable Link` is the single recipe that knows about FileStorage TTLs. Input: a path. Output: a fresh shareable link, 10-day TTL. Every recipe that needs to expose a file to a supplier or analyst calls `UTL-01` at composition time. No other recipe ever stores or refreshes a link.

Two places where links are persisted as snapshots — `EventLog.details_json` (audit of what was sent) and `SUP_SupplierRequest.supplier_message` (what the supplier saw). Both are write-time captures, not authoritative state; both are regenerated on the next state-handler run when the underlying message refreshes. As long as reminder cadence runs faster than the 10-day TTL, the supplier never sees a dead link.

---

## Recipe naming

`<DOM>-<NN>` where `DOM` is a 3-letter domain code and `NN` is a global sequence number within that domain.

| Domain | Scope |
|---|---|
| PRV | Provisioning (workspace setup, version publishing pipeline) |
| CFG | Config-table writers (parse, hydrate, validate config) |
| VAL | Validation pipeline (Upload → ValidationResult → FieldError) |
| UPL | Upload intake and resubmission template generation |
| STS | Status handler (single writer of state and display fields) |
| REM | Reminders |
| REV | Review and approval handlers |
| OBS | Observability writers (EventLog) |
| UTL | Cross-cutting utility helpers (link generation, etc.) |

**Sequence is global within domain, not within role.** A callable spawned from `PRV-01` becomes `PRV-02`, not `PRV-C-01`. This means a recipe's number stays stable if its role ever changes (trigger ↔ callable, top-level ↔ nested), and a step reference like "calls `PRV-04`" is unambiguous in five characters.

**Folder structure carries the role; name carries identity.** Triggers and callables sit in separate folders within their domain folder. The recipe name is just `PRV-01 Provisioning Webhook` — no role suffix.

```
/Provisioning/
  /Triggers/
    PRV-01 Provisioning Webhook
  /Callables/
    PRV-02 Parse Config
    PRV-03 Hydrate CFG Tables
    PRV-04 Publish Version
/Validation/
  /Callables/
    VAL-01 Run Validation
/Status/
  /Callables/
    STS-01 Status Handler
/Utility/
  /Callables/
    UTL-01 Generate Shareable Link
```

**Variant suffix `a/b/c`** for genuine logical branches that share a sequence slot — the old `V-01a` / `V-01b` were two validation paths from the same upstream point. Reserve the suffix for that case only; "version 2 of the recipe" bumps the sequence number.

**Migration mapping** (illustrative, not exhaustive):

| Old | New |
|---|---|
| P-01 | PRV-01 |
| C-01 | PRV-02 (or split between PRV and CFG) |
| C-02 | PRV-03 |
| V-00 | VAL-00 |
| V-01a / V-01b | VAL-01a / VAL-01b |
| U-01 | UPL-01 |
| F-CALLBACK-LOG | OBS-01 |

This is a clean rebuild, not an in-place rename: old recipes are not renamed in the existing workspace.

---

## Invariants

These extend the invariants in `sdc-data-model-v1.md` (1–5) and `sdc-state-machines-v1.md` (1–7). Numbering continues from the state machine doc.

8. **Path is canonical, link is volatile.** Every long-term file reference is a path. Links are generated on demand by `UTL-01`. Storing a link in a column is a smell.

9. **Files belong to the entity that creates them.** No parent row mirrors child file pointers. Recipes that need the latest upload join `RUN_Upload`; recipes that need the latest validation report join `RUN_ValidationResult`.

10. **No path computation at read time.** Paths are computed at row-creation time and stored on the row. Every read is a column lookup; no recipe concatenates a base path with a suffix.

11. **Templates regenerate; everything else is write-once.** `SUP_SupplierRequest.template_path` is the only file path whose contents change over the row's lifetime; it is rewritten on each resubmission cycle to carry forward valid prior rows. Historical template state is reconstructable from the `RUN_Upload` chain. All other paths are write-once.

---

## Backports queued for end-of-Phase-0

Each folds into a `sdc-data-model-v1.md` or `sdc-state-machines-v1.md` revision once Phase 0 is complete.

- Apply table prefixes (`CFG_`, `SUP_`, `RUN_`) and bare-naming for `Project`, `EventLog` throughout the data model doc.
- Apply file-column renames per the table above.
- Add `Project.seeded_data_path`.
- Drop `seeded_template_file_id`, `latest_upload_file_id`, `last_submitted_file_link`, `last_validation_report_path`, `last_validation_report_link` from `SUP_SupplierRequest`.
- Rename `valid_payload` → `valid_payload_json` on `RUN_Upload`.
- Rename `valid_rows` / `invalid_rows` → `valid_row_count` / `invalid_row_count` on `RUN_ValidationResult`.
- Add invariants 8–11 to a consolidated invariants section once the three docs merge.
- Update the state machine derivation table: `{validation_report_link}` is generated via `UTL-01` from `RUN_ValidationResult.report_path` at handler-write time; the link itself is not stored.

---

## Deliberately omitted

- **A central path-resolution helper recipe.** Considered as an alternative to per-row stored paths. Rejected: it centralizes generation but distributes interpretation across every caller, which is exactly the failure mode of the prior workspace's path-building connector. Storing the path on the row pushes both responsibilities together.

- **`*_file_id` columns mirroring `*_path` columns.** The Workato file ID is recoverable from the path on demand if any tool ever needs it; storing both creates two writeable shapes for the same handle and an implicit "keep these in sync" rule.

- **A row-level state machine for accumulating partial submissions** (Position B in the resubmission discussion). Rejected because the operating model is one-shot and templates don't reliably carry a row-level business key across submissions, so accumulation can't be uniform across the platform.

- **A separate `LOG_` prefix for observability.** EventLog is the only observability table; bare-naming is simpler than a one-table prefix.

- **Per-recipe role suffixes** (e.g., `PRV-01-T` for trigger, `PRV-02-C` for callable). Folder structure carries the role; the name doesn't need to.

- **Path-style identifiers in code references** (e.g., `/Provisioning/Callables/PRV-02`). The flat `<DOM>-<NN>` handle is stable across folder reorganizations.

- **Renaming the existing workspace's recipes in place.** Migration is the v1 cutover, not an incremental rename pass.

---

## Pending in Phase 0

- **ADR triage.** AD-1 through AD-38 review. Several decisions in this doc — file model, recipe naming, prefix scheme — likely supersede earlier ADRs.
- **Callable reuse-vs-rebuild.** Which existing callables port forward, which get rewritten under the v1 conventions. Depends on ADR triage outcomes.
