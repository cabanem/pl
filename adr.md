# SDC Platform — Architectural Decisions Register

Compiled from the P-02b seeding design session. These decisions affect the platform broadly, not just the seeding feature.

---

## AD-01: Seeding is split-and-merge in a single recipe

**Context:** Incumbent data arrives as a single file containing all suppliers' rows. Each supplier needs only their rows, pre-filled into their template XLSX.

**Decision:** One recipe (P-02b) handles both partitioning the incumbent file by supplier and merging each supplier's rows into their template. No intermediate seed files are stored.

**Rationale:** The deprecated 9a (merge) and 9b (ingest) split this across two recipes with intermediate storage. Combining them eliminates a file write per supplier and a recipe handoff. The py_eval does the partition and merge in one pass — pandas filters, openpyxl writes.

**Replaces:** Recipes 9a and 9b (both deprecated).

---

## AD-02: GAS remains a thin POST layer

**Context:** GAS previously handled template generation and could have handled incumbent data splitting.

**Decision:** GAS serializes the config workbook to JSON, saves it to Drive, and fires a webhook. No business logic, no splitting, no template generation. All computation lives in Workato (connector actions and py_eval steps).

**Rationale:** Keeps GAS maintainable, testable, and interchangeable. Business logic changes don't require Apps Script deployments.

---

## AD-03: FileStorage path as text field, not File column

**Context:** `WFA_SupplierRequest.seeded_template_file_id` stores the location of the seeded template. Workato Data Tables offer both text fields and File columns.

**Decision:** Use a text field containing the FileStorage path. The File column (500 MB, clickable preview in UI) was evaluated but not adopted.

**Rationale:** Every other file reference in the platform (`template_file_id`, `master_template_file_id`, `parsed_config_file_id`) uses text fields with FileStorage paths. P-03's shareable link generation requires a FileStorage path. Using a File column would require a bridge step (download from Data Table → re-upload to FileStorage → create link) in P-03 and every future recipe that needs a shareable link. One pattern is better than two.

**Escape hatch:** A File Column Variant Change Guide was produced in case this decision is revisited.

---

## AD-04: Canonical path construction via connector action

**Context:** Four different root path strategies existed (trigger parameter, account property, hardcoded `/clients`, py_eval `base_path` default). Two different sanitization methods produced different slugs for the same client name.

**Decision:** A `build_storage_path` action on the SDC Platform Connector is the single source of truth for FileStorage path construction. It takes raw inputs (root, client_name, template_project_id, optional subfolder and file_name) and returns slugified, consistent paths. No recipe ever runs its own `gsub`, `re.sub`, or hardcodes a directory.

**Rationale:** One function, one slugification rule (`lowercase → replace non-alphanumeric runs with hyphen → trim`), one place to change if the convention evolves. Also provides `parent_path`/`leaf_name` outputs for Workato's `ensure_dir_exists` action, which requires the path split into directory and name.

---

## AD-05: FileStorage folder hierarchy

**Context:** Files were dumped flat into the root or one level down with no project isolation.

**Decision:** Standard hierarchy:

```
/{root}/{client_slug}/{project_short}/
  ├── /config
  ├── /templates
  ├── /seeded
  ├── /uploads
  └── /reports
```

B-02 creates the project root. P-01 creates the five subfolders. Each recipe appends its subfolder to the stored `project_storage_path`.

**Rationale:** Three-click navigation in the FileStorage UI: whose → which project → what kind of file. No file name collisions across projects or clients.

---

## AD-06: `project_storage_path` stored once, passed downstream

**Context:** Multiple recipes need the FileStorage base path. Previously some read the account property directly, others received it as a parameter, others hardcoded paths.

**Decision:** B-02 computes `project_storage_path` via `build_storage_path`, stores it on `WFA_TemplateProject`, and passes it to P-01 as a trigger parameter. Downstream recipes (P-02b, P-03, WFA-04, V-01, V-02) receive it as a parameter or read it from the project record. No recipe reads `ENV_FILE_STORAGE_ROOT` directly except through the connector action.

**Rationale:** Single source of truth. If the root changes, only the account property and the connector action matter — no recipe hardcodes are affected.

---

## AD-07: Account property renamed from `ENV_FILE_STORAGE_ROOT_ID` to `ENV_FILE_STORAGE_ROOT`

**Context:** The property stores a path (`/sdc`), not an ID. The `_ID` suffix was misleading.

**Decision:** Rename to `ENV_FILE_STORAGE_ROOT`.

**Rationale:** Naming accuracy. Prevents confusion with actual IDs (Drive file IDs, Workato internal IDs).

---

## AD-08: `ENV_CLIENT_NAME` replaced with datapill

**Context:** P-03 used an `ENV_CLIENT_NAME` account property to build the task assignment label. This is a workspace-level property holding a project-level value.

**Decision:** Replace with `customer_name` from the `WFA_SupplierRequest` record (already fetched in P-03 Step 1).

**Rationale:** In a shared workspace with multiple clients, the account property can only hold one name. The datapill is per-supplier-request and always correct.

---

## AD-09: Seeding config lives on `1_customer`, not `2_suppliers`

**Context:** The original config had per-supplier fields for incumbent data location (Drive file ID, data range) on the `2_suppliers` sheet.

**Decision:** Seeding config is project-scoped: one file, one sheet, one split field. These fields (`incumbent_sheet_name`, `incumbent_split_field`) live on `1_customer`. The per-supplier columns F (`Location of incumbent data`) and G (`Incumbent data range`) on `2_suppliers` are deprecated.

**Rationale:** The platform's seeding model is "single file, partition by split field." Per-supplier file references are unnecessary and add configuration burden. The split field approach is extensible — compound filters can be added to the JSON spec without changing the workbook layout.

---

## AD-10: Filter spec is a JSON object, extensible without recipe changes

**Context:** The split logic needs to support partitioning by supplier name today and compound criteria (e.g., supplier name WHERE region = "US") in the future.

**Decision:** `incumbent_split_config` is stored as a JSON string:

```json
{
  "sheet_name": "Worker Data",
  "split_field": "Supplier Name",
  "filters": []
}
```

The `filters` array accepts `{"field", "op", "value"}` objects. Supported operators: `eq`, `ne`, `in`, `contains`.

**Rationale:** Adding filter criteria means updating the JSON — no recipe structural changes, no new Data Table columns, no connector changes. The py_eval iterates whatever's in the array.

---

## AD-11: P-02b supports two callers with a flag parameter

**Context:** Seeding happens at two points — during initial provisioning (P-01 calls P-02b, only flagged suppliers) and late (analyst triggers via WFA page, all seedable suppliers).

**Decision:** P-02b accepts `skip_seed_flag_check` (boolean, default false). When false (P-01 path), non-flagged suppliers are skipped inside the loop. When true (WFA-Seed path), the gate doesn't fire — all suppliers in seedable status are processed.

**Rationale:** One recipe, two behaviors. The flag check is an if/else at the top of the foreach body — no query duplication, no separate recipes. The broad query (`status IN pending, sent`) is the same for both callers; only the in-loop gate differs.

---

## AD-12: `has_seeded_data` becomes an output, not just an input

**Context:** `has_seeded_data` was originally set in the config workbook (analyst declares intent). For late seeding, the analyst never set the flag.

**Decision:** P-02b stamps `has_seeded_data = true` on every supplier it successfully seeds (Step 20), regardless of its prior value.

**Rationale:** The flag reflects reality — was this supplier seeded? — rather than just intent. This supports the WFA-Seed flow where the flag was never set, and makes dashboard queries accurate (count of seeded suppliers = count where `has_seeded_data = true`).

---

## AD-13: P-03 template resolution is three-tier

**Context:** P-03 resolves which template to share with each supplier. Previously: variant template if assigned, else master template.

**Decision:** Three-tier priority: `seeded_template_file_id` → variant `template_file_id` → `master_template_file_id`. If the seeded template exists, it's used — no variant lookup needed because P-02b already merged into the correct variant/master template.

**Rationale:** The seeded template is the "final answer" for that supplier. It already contains the correct structure. Checking variant after seeding would be redundant and potentially conflicting.

---

## AD-14: B-02 calls P-01 synchronously

**Context:** B-02 previously called P-01 asynchronously. Errors in routing (e.g., request not found in `HOME_Requests`) couldn't be reported to the caller.

**Decision:** B-02 is a callable recipe function with a return schema (`success`, `error_message`). B-01 calls B-02 synchronously and inspects the result.

**Rationale:** B-02 is lightweight — a few DB lookups, one connector action, one directory creation. The heavy work (config parsing, template building, onboarding) stays async in P-01. Sync return lets B-01 log failures and update `HOME_Requests` with error status.

---

## AD-15: B-02 return schema simplified

**Context:** B-02 had two result variables (`result` for log lines, `error_details` for the actual error message) serving the same purpose in different formats.

**Decision:** Collapse to a single return schema: `success` (boolean) + `error_message` (string). The caller (B-01) decides how to log it.

**Rationale:** Eliminates the Step 1 variable declaration entirely. One return shape, one place to read results.

---

## AD-16: Variant count on `1_customer` is a UI control, not pipeline data

**Context:** Row 6 on `1_customer` ("How many variations are there of the template?") appeared redundant with the actual variants defined on `6_variants`.

**Decision:** Keep it. The value drives spreadsheet-level conditional formatting and visibility on the `6_variants` tab. It is not a source of truth for the pipeline — `parse_summary.variant_count` from the connector is authoritative.

**Rationale:** The config workbook serves dual duty as a user-facing form and a data source. UI controls that improve the analyst's editing experience are worth keeping even if the pipeline doesn't need them.

---

## AD-17: Late-arriving incumbent data flows through a WFA page

**Context:** Incumbent data may arrive after initial provisioning. The analyst needs a way to provide it without re-triggering the full pipeline.

**Decision:** A dedicated WFA page ("Seed Incumbent Data") with a project selector dropdown, three text inputs (file ID, sheet name, split field), and a button that calls P-02b via a thin WFA-Seed recipe. The page shows eligibility stats before the analyst acts.

**Rationale:** The analyst is already in the WFA app. A dedicated page scopes the action to exactly what's happening — no config workbook round-trip, no webhook, no re-provision. The WFA-Seed recipe is thin (lookup project, build split config JSON, call P-02b, return toast).

---

## AD-18: Status filter protects in-progress suppliers from re-seeding

**Context:** Late seeding could overwrite a supplier's template after they've started working.

**Decision:** P-02b's query filters to `status IN (pending, sent)`. Suppliers with status `started`, `submitted`, or `complete` are never seeded. This filter applies to both the P-01 and WFA-Seed callers.

**Rationale:** A supplier who has downloaded and started filling out their template would lose work if the file were replaced. The status boundary is conservative and clearly auditable. During initial provisioning all suppliers are `pending`, so the filter has no impact on that path.

---

## AD-19: Dashboards built as WFA pages, not external tools

**Context:** Needed operational, analyst, and management visibility into project status.

**Decision:** Three WFA pages in the existing Supplier Data Collection app — Ops (developer), Analyst (supplier tracking), Manager (portfolio view). All backed by Data Table queries against existing tables.

**Rationale:** Data already lives in Data Tables. WFA pages read directly — no sync layer, no staleness, no maintenance. The shared workspace means all clients are visible; the Analyst and Seed pages use a project selector dropdown to scope to one client at a time.

---

## AD-20: `project_status` stamped by each recipe, not derived at read time

**Context:** Project status could be derived by joining across tables (template version exists? suppliers bootstrapped? any submissions?). WFA pages don't handle complex joins well.

**Decision:** Add `project_status` to `WFA_TemplateProject`. Each recipe stamps it as the pipeline progresses: `config_pending` → `building` → `bootstrapping` → `onboarding` → `active` → `complete`.

**Rationale:** Every dashboard page becomes a single-table query with a string filter. No joins, no derivation, no lag. The stamping adds one field update per pipeline stage — negligible cost.

---

## AD-21: B-02 double-nesting bug identified and fixed

**Context:** B-02 Step 18's `ensure_dir_exists` had `directory_path` and `directory_name` both containing the same `{client}_{corr_short}` value, creating `{root}/Client_Name_a3b2c1d4/Client_Name_a3b2c1d4/`.

**Decision:** Replace with `build_storage_path` call (AD-04) followed by `ensure_dir_exists` using `parent_path` and `leaf_name` from the connector output.

**Rationale:** The connector handles the path split correctly. The bug was caused by Workato's `ensure_dir_exists` always creating `directory_name` inside `directory_path` — a behavior that's easy to get wrong when building paths manually.

---

## AD-22: `customer_name` added to `WFA_SupplierRequest`

**Context:** Downstream recipes (WFA-04, P-03) need the client name for file naming and task labels. Previously required a join to `WFA_TemplateProject`.

**Decision:** P-01's bootstrapping py_eval (Step 54) stamps `customer_name` on each `WFA_SupplierRequest` record.

**Rationale:** Avoids an extra DB lookup in WFA-04 and P-03. The value is static for the life of the supplier request.

---

## AD-23: `ENV_CURRENT_MANIFEST_ID` is overloaded (future fix)

**Context:** `ENV_CURRENT_MANIFEST_ID` is used as a FileStorage filename in R-B-00 and as a Developer API package ID in B-03a. Neither is active today.

**Decision:** Documented as a known issue. No fix now — cross-workspace provisioning (B-03a) and manifest versioning (R-B-00) are not yet active. When either is built, split into two properties.

**Rationale:** Fixing an unused property has no ROI. The documentation ensures it's not rediscovered later.



--------


# Session Summary: Control Plane Recipe Build-Out

## What we built

Four base-project recipes in the SDC provisioning chain, plus an architectural
revision to support config updates through the same front door as initial
provisioning.

---

## Deliverables produced

| File                                  | What it is                                      |
|---------------------------------------|------------------------------------------------|
| `r_001_receive_webhook.recipe.json`   | R-1 recipe JSON                                |
| `r_001_build_guide.md`               | R-1 step-by-step builder walkthrough            |
| `r_001_field_uuid_mapping.md`        | R-1 placeholder → column mapping reference      |
| `r_01b_route_request.recipe.json`    | R-1b recipe JSON                               |
| `r_01b_build_guide.md`              | R-1b step-by-step builder walkthrough           |
| `r_02b_parse_hydrate_config.recipe.json` | R-2b recipe JSON (revised, version-aware)   |
| `r_02b_build_guide.md`              | R-2b step-by-step builder walkthrough (revised) |
| `architecture_revision_option1.md`   | Architecture doc for unified hydration flow     |
| `r1_r1b_delta_for_config_update.md` | Delta changes to R-1 and R-1b for update path   |

---

## Recipe designs

### R-1 — Receive Webhook (10 steps)

Webhook trigger receives POST from Apps Script. Validates payload via a Python
step (correlation_id UUID format, client_name non-empty, analyst_email email
format, config_file_id non-empty, timestamp ISO-8601). Branches: validation
failure writes a REJECTED Requests row and stops; validation success writes a
PENDING Requests row and calls R-1b async.

Uses `__FIELD_UUID__` placeholders for Requests table columns since those are
home-base table UUIDs not present in the per-client data_table_manifest.

### R-1b — Route Request (11 steps)

Callable recipe triggered by R-1. Looks up the Requests row (to get Workato
Record ID for updates). Queries WorkspaceRegistry for an AVAILABLE workspace.
Branches: no workspace → updates Requests to FAILED; workspace found → stamps
workspace_id on Requests, increments WorkspaceRegistry project_count, sets
WorkspaceRegistry status to ASSIGNED, calls R-2a async.

Uses `__WR_FIELD_UUID__` placeholders for WorkspaceRegistry columns and
`__FIELD_UUID__` for Requests columns.

### R-2b — Parse & Hydrate Config (30 steps, revised)

Callable recipe triggered by R-2a (initial) or R-1b (update). Version-aware:
queries for existing published VER_TemplateVersion, deprecates it if found,
bumps version_number. Downloads config from Google Drive, runs it through SDC
Platform Connector (Parse Config → Validate Config). On validation failure,
logs and stops. On success: creates new VER_TemplateVersion in draft, runs one
Python step to remap all six table arrays from logical field names to field
UUIDs using table_results_map, batch-inserts into CFG_Field, CFG_Rule,
CFG_Lookup, CFG_ErrorTranslation, conditionally CFG_Variant + CFG_VariantField,
publishes the version, stores frozen config JSON to FileStorage, stamps
parsed_config_file_id on WFA_TemplateProject, and conditionally calls R-008
(initial only).

Uses Data Tables API custom connector for all per-client table operations
(dynamic table_id from table_results_map). Uses `__SDC_PLATFORM_CONNECTOR__`
placeholder for the SDC Platform Connector provider name.

---

## Architectural decisions

### 1. Config update reuses the front door (Option 1)

The analyst fires the same webhook for both initial provisioning and config
updates. R-1 detects the difference by looking up `config_file_id` in the
Requests table: if an ACTIVE row exists, it's an update; if not, it's new.

- **New request path:** R-1 → R-1b → R-2a → R-2b(is_initial=true) → R-008
- **Update path:** R-1 → R-1b → R-2b(is_initial=false) — skips R-2a and R-008

### 2. R-2b stays in the base project

Workato's `call_recipe_async` requires a static flow_id at design time. A
client-folder recipe's ID is only known after R-2a clones it. Keeping R-2b in
the base project means both R-2a and R-1b can call it without dynamic recipe
resolution. It uses the Data Tables API connector for dynamic table addressing.

### 3. One hydration recipe for all versions

Initial hydration and config updates are the same operation — only the version
number and the R-008 call differ. The `is_initial` boolean parameter controls
the R-008 gate. Version deprecation (Steps 4–7) is a no-op on first run
because no published version exists yet.

### 4. Version scoping, not deletion

Old CFG rows are never deleted. Each hydration creates new rows scoped to a new
`template_version_id`. The old version's rows become inert when its status
changes to `deprecated`. This preserves audit trail and enables potential
rollback.

### 5. table_results_map persisted to FileStorage

R-2a serializes table_results_map to FileStorage after provisioning and stores
the file ID on both WFA_TemplateProject and the Requests row. On the update
path, R-1b reads it from FileStorage (via the Requests row pointer) and passes
it to R-2b. The map is immutable — table IDs and field UUIDs don't change after
provisioning.

### 6. Existing suppliers unaffected by config updates

When a new version is published, existing WFA_SupplierRequest rows keep their
frozen `assigned_version_id`. They continue validating against the old version.
Supplier reassignment to the new version is deferred — not in scope for this
iteration.

### 7. No incremental supplier bootstrapping on update

If the analyst adds new suppliers to the config, the update path does not call
R-008 to create rows for them. That's deferred to a future iteration.

### 8. CONFIG_UPDATE as a Requests status

Config update webhooks create a new Requests row with `status = CONFIG_UPDATE`,
which transitions to `CONFIG_APPLIED` on success or `FAILED` on failure. The
original ACTIVE row stays ACTIVE untouched. The VER_TemplateVersion chain
provides the detailed audit trail of what changed and when.

---

## Schema changes agreed upon

### Requests table — new column

| Column                      | Type   | Optional | Purpose                              |
|-----------------------------|--------|----------|--------------------------------------|
| table_results_map_file_id   | string | yes      | FileStorage pointer. Written by R-2a. Read by R-1b on update path. |

### Requests.status — new enum values

`PENDING | PROVISIONING | CONFIG_UPDATE | CONFIG_APPLIED | ACTIVE | REJECTED | FAILED`

### WFA_TemplateProject — new column

| Column                      | Type   | Optional | Purpose                              |
|-----------------------------|--------|----------|--------------------------------------|
| table_results_map_file_id   | string | yes      | Same FileStorage pointer, also accessible from per-client context. |

(`parsed_config_file_id` already exists in the v3.1.0 schema.)

---

## What's NOT yet built

| Recipe / Component | Status | Notes |
|--------------------|--------|-------|
| R-00 (Package & Version) | Not started | Snapshots template definition into Manifests table |
| R-2a (Provision Client Folder) | Not started | Creates folder, 13 tables, clones recipes, deferred relations. Needs delta for table_results_map persistence and is_initial=true call to R-2b |
| R-008 (Bootstrap Supplier Requests) | Not started | Client-folder recipe. Reads frozen config from FileStorage, creates WFA_SupplierRequest + WFA_SupplierUser rows |
| R-1 / R-1b update-path steps | Documented in delta, not yet in recipe JSON | ~3 new steps each |
| Supplier reassignment on version update | Deferred | Existing suppliers stay on old version |
| Incremental R-008 on update | Deferred | New suppliers added to config not bootstrapped on update path |

---

## Conventions established

- **Placeholder prefixes:** `__FIELD_UUID__` (Requests columns), `__WR_FIELD_UUID__`
  (WorkspaceRegistry columns), `__SYS_UUID__` (system columns), `__SDC_PLATFORM_CONNECTOR__`
  (connector provider name)
- **Step alias format:** 8-char hex strings (e.g., `a1b2c3d4`), or structured
  prefixes for R-2b (e.g., `r2b00001`)
- **Datapill syntax:** `_dp('{...}')` with JSON payload containing `pill_type`,
  `provider`, `line` (alias), and `path`
- **Async handoffs:** All cross-recipe calls use `call_recipe_async` — callers
  don't need return values
- **Error handling pattern:** Caller is responsible for Requests status updates
  on failure (R-2b logs but doesn't update Requests directly)
- **Boolean conditions in IF blocks:** Use `.to_s` conversion and compare against
  string `"true"` or `"false"` to avoid type coercion issues



  -------------


  # SDC Platform: Architectural Decisions — Session Summary

## 1. Task Visibility and Assignment (S-00)

**Problem:** Suppliers could log into the WFA portal but saw no tasks assigned to them.

**Root cause:** Steps 22 (`share_request`) and 23 (`human_review_on_existing_record`) in S-00 used `contact_email` from `WFA_SupplierRequest` to assign tasks. That field is never populated — the config's `2_suppliers` sheet has no email column. Emails exist only on `WFA_SupplierUser.user_email` (sourced from `3_users`).

Additionally, both steps were inside the request foreach but outside the SupplierUser foreach, so even if `contact_email` had a value, only one user per request would ever get a task.

**Decision:** Move steps 22–23 inside the SupplierUser foreach loop. Rewire the `email` pill from `contact_email` (request field `a2065722`) to `user_email` (SupplierUser field `231e764a`). Every invited user now receives their own task. Multi-user suppliers are supported naturally.

---

## 2. RUN_ManualEntry Relation Binding (S-00, Step 14)

**Problem:** The `RUN_ManualEntry` table widget on P-002 showed no rows, even though rows existed in the table.

**Root cause:** S-00 step 14 (`create_records_batch` for `RUN_ManualEntry`) never mapped the `supplier_request_id` relation field (`8ac88e63`). Rows were created but orphaned — the page widget's `relatedColumnId` filter found nothing.

**Decision:** Add the relation field to step 14's batch create mapping, using the Workato Record ID from the SupplierRequest (not the business UUID). Relation fields always require the internal Record ID.

---

## 3. Page Button Wiring (P-002)

**Problem:** The "Submit worker data" button passed an empty `supplier_request_id` to R-007c, causing a cascade failure: no request found → no FormSlots → empty rows → "Records can't be blank."

**Root cause:** The button read from page variable `REQUEST.supplier_request_id` (id `6f8fca1a`), which was never populated — no `pageLoad` handler set it, and no other handler wrote to it.

**Decision:** Rewire the button's input mapping from the page variable to a direct request field pill (`source: request, path: ["field", "98922f09"]`), matching the pattern used by every other widget on the page.

---

## 4. Slot-Based Manual Input Staging (R-007c + P-002)

**Problem:** The original manual input design exposed the raw `RUN_ManualEntry` EAV table directly on the page. When the supplier clicked "Submit worker data," it called R-007c (which added blank rows) and then cleared the form via `reset-widgets-values`. The supplier lost their entered data and had to figure out where they were.

**Root cause:** The page had one button trying to do two jobs (save data + add another worker), pointed at the wrong recipe (R-007c instead of R-007b), and the EAV table was not a usable input surface.

**Decision:** Redesign the flow around the slot fields that already exist on `WFA_SupplierRequest`:

1. Slots (`slot_text_01` through `slot_date_04`) serve as a clean, dynamic input form with labels from `CFG_FormSlot`.
2. **"Save & add worker"** button calls R-007c via `invoke-app-function`, passing slot values directly as trigger parameters from the page widgets. No `save-data` step needed.
3. R-007c reads slot values from trigger parameters, maps each to its `field_id` via `CFG_FormSlot.slot_name`, writes populated rows into `RUN_ManualEntry` with the correct `row_number`, and returns success.
4. The page clears the form via `reset-widgets-values` on the follow-up action.
5. The `RUN_ManualEntry` table stays on the page as a read-only summary of workers saved so far.
6. A separate **"Submit all"** button calls R-007b to trigger validation.

This eliminated the need for the supplier to interact with the raw EAV table. The slot → staging → accumulator pattern keeps the UX clean while preserving multi-worker support.

**Rejected alternative:** Dynamically creating per-client/per-version/per-variant data tables. Workato Data Tables are design-time artifacts — they can't be created or schema-altered programmatically. The table widget also needs a static binding at design time.

**Rejected alternative:** One request per worker with slot-only input. This was considered but rejected as a core requirement — the business needs multiple workers per request.

---

## 5. Task Completion Ordering (R-007b)

**Problem:** R-007b tried to change the workflow stage to "Validating" before the `app_function_return` resolved the human review task. The stage change failed because the task was still pending.

**Root cause:** `app_function_return` terminates recipe execution in Workato, so the stage change and status update were never going to work after it. But placing them before the return also failed because the task wasn't complete yet.

**Decision:** Reorder R-007b:
- Move `update request status → submitted` before the return (this is just a data table write — it works regardless of task state).
- `app_function_return` terminates the recipe and resolves the task.
- Move the stage change (`→ Validating`) into the validation recipe (V-01), which runs asynchronously after the task is resolved.

---

## 6. Manual Input Payload Routing (V-01)

**Problem:** When validation was triggered from manual input (no file upload), the SQL had no data to validate.

**Root cause:** The variable `resolved_payload` was only set inside the `if (file_id present)` branch (step 8). For manual input, the if block was skipped entirely and `resolved_payload` stayed empty.

**Decision:** Add an else branch to step 8 that sets `resolved_payload` from the trigger's `transposed_payload` parameter. The SQL now receives data regardless of input method.

---

## 7. Validation SQL: Lookup CTE Fix (V-01)

**Problem:** The `lookup_failures` CTE used `json_each(l.valid_values)` assuming each `CFG_Lookup` row held a JSON array of values.

**Root cause:** `CFG_Lookup` stores one valid value per row (the schema hint says "Acceptable value for this lookup option"). `json_each()` either errored or produced incorrect results, and the `INNER JOIN` pattern created duplicate error rows.

**Decision:** Replace with a `NOT EXISTS` subquery that checks across all lookup rows for the given `lookup_name`. One error per failed field, no duplicates.

---

## 8. Validation Pipeline Expansion (V-01)

**Problem:** The validation SQL implemented 1 of 17 promised rule types (`conditional_required` only). The `_mapping` sheet advertises: Required if, Must be empty if, At least one required, Mutually exclusive, Must be greater than, Must be greater than or equal to, Must be less than, Must be less than or equal to, Must match, Must not match, Combined fields must be unique, plus single-field validations for length, numeric range, date range, regex, and column uniqueness.

**Decision:** Split into two phases.

### Phase 1: Python Pre-processing

A new py_eval step inserted between data loading and the SQL that:

- **Parses validation strings:** `field_length_validation` ("min:1,max:50") → `len_min`, `len_max`; `numeric_field_validation` → `numeric_min`, `numeric_max`; `date_field_validation` → `date_min`, `date_max`.
- **Resolves tokens:** `today` in date constraints → current date string.
- **Normalizes dates:** Submitted date values are converted to ISO-8601 (`YYYY-MM-DD`) based on `data_format`, enabling lexicographic comparison in SQL.
- **Evaluates regex:** `field_input_validation` patterns are checked via `re.fullmatch()`. Failures are emitted as pre-computed error rows (SQLite doesn't support regex).
- **Outputs:** `enriched_fields` (fields with parsed columns), `normalized_payload` (dates normalized), `precomputed_errors` (regex + unparseable date failures).

### Phase 2: SQL Expansion

Rewrote the SQL with 16 CTEs:

**Single-field (from CFG_Field):** presence_required, presence_must_be_empty, lookup_failures, column_unique_failures, length_failures, numeric_range_failures, date_range_failures.

**Cross-field (from CFG_Rule):** conditional_required, conditional_empty, mutually_exclusive, at_least_one, must_match, must_not_match, comparison (gt/gte/lt/lte combined), composite_unique.

**Pre-computed (from Python):** precomputed_passthrough — merges regex and date parse errors into the unified output.

The SQL's source tables were rewired: `payload` → `normalized_payload`, `fields` → `enriched_fields`, and `precomputed_errors` added as a 6th source table.

---

## 9. Rule Key Convention

**Problem:** `CFG_Rule.rule` stored display names ("Required if") from the config spreadsheet dropdown, but the SQL needs machine-readable keys to match on.

**Decision:** Standardize on `backend_error_code` values from the `_mapping` sheet (`err_conditional_required`, `err_conditional_empty`, etc.) as the canonical rule keys. A new column was added to `_mapping` to hold these alongside the display names. The config parser (connector Action 1) translates display name → error code when writing `CFG_Rule` rows. Analysts continue to see and select human-readable names in the dropdown.

---

## 10. Connector Change (Action 1: Parse Config)

**Problem:** The parse config action copies rule display names directly into `CFG_Rule.rule`.

**Decision:** Update Action 1 to look up the display name from `4_complex_validations` against the new `_mapping` column and write the corresponding `backend_error_code` into `CFG_Rule.rule` instead. No other connector actions are affected.

---

## 11. Long-Text Field Type Corrections

**Problem:** `VER_TemplateVersion.validation_summary` and `RUN_Upload.valid_payload` are typed as `short-text` but their hints warn about needing long-text capacity.

**Findings:**
- `validation_summary` is written only in C-01 (steps 18 and 34), storing JSON parse summaries and template validation errors.
- `valid_payload` is never written by any recipe — it's a dead field. It appears only in schema declarations on get_records steps.

**Decision:** Change both to long-text. Only C-01 needs retesting (for `validation_summary`). `valid_payload` can be changed or removed — nothing will break.

---

## 12. Client Name Denormalization

**Problem:** The supplier-facing page needs to display the client/project name, but it lives on `WFA_TemplateProject`, not on `WFA_SupplierRequest`.

**Decision:** Add `client_name` as a plain `short-text` field on `WFA_SupplierRequest`, populated at bootstrap from `WFA_TemplateProject.project_name`. Written in S-00 step 12 alongside the existing status update.

**Rejected alternative:** A relation column to `WFA_TemplateProject`. WFA pages can't traverse relations to display fields from linked tables — you'd still need a text field. Since `project_name` is write-once and immutable, there's no sync risk from denormalizing.

---

## 13. Data Table Field Naming and Hints

**Renames (6):**
1. `WFA_SupplierRequest.status_StateMachine` → `status`
2. `WFA_SupplierRequest.file_upload` → `latest_upload_file_id`
3. `WFA_TemplateProject.drive_file_id` → `incumbent_data_file_id`
4. `WFA_TemplateProject.drive_folder_id` → `output_folder_id`
5. `CFG_Lookup.lookup_field_id` → `lookup_id`
6. `CFG_Lookup.valid_values` → `valid_value` (singular — each row is one option)

**Stale recipe references (5):** Hints referencing R-2a, R-006, R-007a, R-002 updated to generic descriptions reflecting the current recipe inventory.

**Missing hints added (18):** Primarily slot fields on `WFA_SupplierRequest` (documenting the dynamic form slot pattern and CFG_FormSlot linkage), relation fields on `RUN_ManualEntry` and `RUN_FieldError`, and the `created_at` field on `WFA_SupplierUser`.

**Hints improved (12):** `CFG_FormSlot` received the most attention — nearly every hint was a 3-word fragment. Now documents the slot lookup pattern, widget types, and cross-table relationships.

**Decision pending:** `WFA_SupplierRequest.contact_email` — either populate from the first `WFA_SupplierUser` at bootstrap and rename to `primary_user_email`, or remove entirely.

---

## 14. Recipe Naming Convention

**Convention:** `{phase}_{sequence} {verb} {object}`

**Phase prefixes:**
- **P** — Provisioning (setup, onboarding)
- **WFA** — App-function-triggered (page interactions)
- **V** — Validation pipeline

| Old Name | New Name |
|---|---|
| C-01: Hydrate, generate, validate, publish | P-01 Provision project |
| C-02: Build XLSX from Sheets configuration | P-02 Build XLSX template |
| S-00: Onboard suppliers | P-03 Onboard suppliers |
| WFA-001: Change workflow stage to started | WFA-01 Advance stage to started |
| R-007c: Add worker (WFA manual input button) | WFA-02 Save worker entry |
| R-007b Ingest manual supplier input | WFA-03 Submit manual input |
| R-6 Ingest supplier input from WFA | WFA-04 Submit file upload |
| R-7 Validate supplier input | V-01 Validate supplier input |
| R-8 Route results | V-02 Route validation results |
