SDC Platform — Architectural Decisions Register

Compiled from the P-02b seeding design session. These decisions affect the platform broadly, not just the seeding feature.

AD-01: Seeding is split-and-merge in a single recipe

Context: Incumbent data arrives as a single file containing all suppliers' rows. Each supplier needs only their rows, pre-filled into their template XLSX.

Decision: One recipe (P-02b) handles both partitioning the incumbent file by supplier and merging each supplier's rows into their template. No intermediate seed files are stored.

Rationale: The deprecated 9a (merge) and 9b (ingest) split this across two recipes with intermediate storage. Combining them eliminates a file write per supplier and a recipe handoff. The py_eval does the partition and merge in one pass — pandas filters, openpyxl writes.

Replaces: Recipes 9a and 9b (both deprecated).

AD-02: GAS remains a thin POST layer

Context: GAS previously handled template generation and could have handled incumbent data splitting.

Decision: GAS serializes the config workbook to JSON, saves it to Drive, and fires a webhook. No business logic, no splitting, no template generation. All computation lives in Workato (connector actions and py_eval steps).

Rationale: Keeps GAS maintainable, testable, and interchangeable. Business logic changes don't require Apps Script deployments.

AD-03: FileStorage path as text field, not File column

Context: WFA_SupplierRequest.seeded_template_file_id stores the location of the seeded template. Workato Data Tables offer both text fields and File columns.

Decision: Use a text field containing the FileStorage path. The File column (500 MB, clickable preview in UI) was evaluated but not adopted.

Rationale: Every other file reference in the platform (template_file_id, master_template_file_id, parsed_config_file_id) uses text fields with FileStorage paths. P-03's shareable link generation requires a FileStorage path. Using a File column would require a bridge step (download from Data Table → re-upload to FileStorage → create link) in P-03 and every future recipe that needs a shareable link. One pattern is better than two.

Escape hatch: A File Column Variant Change Guide was produced in case this decision is revisited.

AD-04: Canonical path construction via connector action

Context: Four different root path strategies existed (trigger parameter, account property, hardcoded /clients, py_eval base_path default). Two different sanitization methods produced different slugs for the same client name.

Decision: A build_storage_path action on the SDC Platform Connector is the single source of truth for FileStorage path construction. It takes raw inputs (root, client_name, template_project_id, optional subfolder and file_name) and returns slugified, consistent paths. No recipe ever runs its own gsub, re.sub, or hardcodes a directory.

Rationale: One function, one slugification rule (lowercase → replace non-alphanumeric runs with hyphen → trim), one place to change if the convention evolves. Also provides parent_path/leaf_name outputs for Workato's ensure_dir_exists action, which requires the path split into directory and name.

AD-05: FileStorage folder hierarchy

Context: Files were dumped flat into the root or one level down with no project isolation.

Decision: Standard hierarchy:

/{root}/{client_slug}/{project_short}/
  ├── /config
  ├── /templates
  ├── /seeded
  ├── /uploads
  └── /reports
B-02 creates the project root. P-01 creates the five subfolders. Each recipe appends its subfolder to the stored project_storage_path.

Rationale: Three-click navigation in the FileStorage UI: whose → which project → what kind of file. No file name collisions across projects or clients.

AD-06: project_storage_path stored once, passed downstream

Context: Multiple recipes need the FileStorage base path. Previously some read the account property directly, others received it as a parameter, others hardcoded paths.

Decision: B-02 computes project_storage_path via build_storage_path, stores it on WFA_TemplateProject, and passes it to P-01 as a trigger parameter. Downstream recipes (P-02b, P-03, WFA-04, V-01, V-02) receive it as a parameter or read it from the project record. No recipe reads ENV_FILE_STORAGE_ROOT directly except through the connector action.

Rationale: Single source of truth. If the root changes, only the account property and the connector action matter — no recipe hardcodes are affected.

AD-07: Account property renamed from ENV_FILE_STORAGE_ROOT_ID to ENV_FILE_STORAGE_ROOT

Context: The property stores a path (/sdc), not an ID. The _ID suffix was misleading.

Decision: Rename to ENV_FILE_STORAGE_ROOT.

Rationale: Naming accuracy. Prevents confusion with actual IDs (Drive file IDs, Workato internal IDs).

AD-08: ENV_CLIENT_NAME replaced with datapill

Context: P-03 used an ENV_CLIENT_NAME account property to build the task assignment label. This is a workspace-level property holding a project-level value.

Decision: Replace with customer_name from the WFA_SupplierRequest record (already fetched in P-03 Step 1).

Rationale: In a shared workspace with multiple clients, the account property can only hold one name. The datapill is per-supplier-request and always correct.

AD-09: Seeding config lives on 1_customer, not 2_suppliers

Context: The original config had per-supplier fields for incumbent data location (Drive file ID, data range) on the 2_suppliers sheet.

Decision: Seeding config is project-scoped: one file, one sheet, one split field. These fields (incumbent_sheet_name, incumbent_split_field) live on 1_customer. The per-supplier columns F (Location of incumbent data) and G (Incumbent data range) on 2_suppliers are deprecated.

Rationale: The platform's seeding model is "single file, partition by split field." Per-supplier file references are unnecessary and add configuration burden. The split field approach is extensible — compound filters can be added to the JSON spec without changing the workbook layout.

AD-10: Filter spec is a JSON object, extensible without recipe changes

Context: The split logic needs to support partitioning by supplier name today and compound criteria (e.g., supplier name WHERE region = "US") in the future.

Decision: incumbent_split_config is stored as a JSON string:

{
  "sheet_name": "Worker Data",
  "split_field": "Supplier Name",
  "filters": []
}
The filters array accepts {"field", "op", "value"} objects. Supported operators: eq, ne, in, contains.

Rationale: Adding filter criteria means updating the JSON — no recipe structural changes, no new Data Table columns, no connector changes. The py_eval iterates whatever's in the array.

AD-11: P-02b supports two callers with a flag parameter

Context: Seeding happens at two points — during initial provisioning (P-01 calls P-02b, only flagged suppliers) and late (analyst triggers via WFA page, all seedable suppliers).

Decision: P-02b accepts skip_seed_flag_check (boolean, default false). When false (P-01 path), non-flagged suppliers are skipped inside the loop. When true (WFA-Seed path), the gate doesn't fire — all suppliers in seedable status are processed.

Rationale: One recipe, two behaviors. The flag check is an if/else at the top of the foreach body — no query duplication, no separate recipes. The broad query (status IN pending, sent) is the same for both callers; only the in-loop gate differs.

AD-12: has_seeded_data becomes an output, not just an input

Context: has_seeded_data was originally set in the config workbook (analyst declares intent). For late seeding, the analyst never set the flag.

Decision: P-02b stamps has_seeded_data = true on every supplier it successfully seeds (Step 20), regardless of its prior value.

Rationale: The flag reflects reality — was this supplier seeded? — rather than just intent. This supports the WFA-Seed flow where the flag was never set, and makes dashboard queries accurate (count of seeded suppliers = count where has_seeded_data = true).

AD-13: P-03 template resolution is three-tier

Context: P-03 resolves which template to share with each supplier. Previously: variant template if assigned, else master template.

Decision: Three-tier priority: seeded_template_file_id → variant template_file_id → master_template_file_id. If the seeded template exists, it's used — no variant lookup needed because P-02b already merged into the correct variant/master template.

Rationale: The seeded template is the "final answer" for that supplier. It already contains the correct structure. Checking variant after seeding would be redundant and potentially conflicting.

AD-14: B-02 calls P-01 synchronously

Context: B-02 previously called P-01 asynchronously. Errors in routing (e.g., request not found in HOME_Requests) couldn't be reported to the caller.

Decision: B-02 is a callable recipe function with a return schema (success, error_message). B-01 calls B-02 synchronously and inspects the result.

Rationale: B-02 is lightweight — a few DB lookups, one connector action, one directory creation. The heavy work (config parsing, template building, onboarding) stays async in P-01. Sync return lets B-01 log failures and update HOME_Requests with error status.

AD-15: B-02 return schema simplified

Context: B-02 had two result variables (result for log lines, error_details for the actual error message) serving the same purpose in different formats.

Decision: Collapse to a single return schema: success (boolean) + error_message (string). The caller (B-01) decides how to log it.

Rationale: Eliminates the Step 1 variable declaration entirely. One return shape, one place to read results.

AD-16: Variant count on 1_customer is a UI control, not pipeline data

Context: Row 6 on 1_customer ("How many variations are there of the template?") appeared redundant with the actual variants defined on 6_variants.

Decision: Keep it. The value drives spreadsheet-level conditional formatting and visibility on the 6_variants tab. It is not a source of truth for the pipeline — parse_summary.variant_count from the connector is authoritative.

Rationale: The config workbook serves dual duty as a user-facing form and a data source. UI controls that improve the analyst's editing experience are worth keeping even if the pipeline doesn't need them.

AD-17: Late-arriving incumbent data flows through a WFA page

Context: Incumbent data may arrive after initial provisioning. The analyst needs a way to provide it without re-triggering the full pipeline.

Decision: A dedicated WFA page ("Seed Incumbent Data") with a project selector dropdown, three text inputs (file ID, sheet name, split field), and a button that calls P-02b via a thin WFA-Seed recipe. The page shows eligibility stats before the analyst acts.

Rationale: The analyst is already in the WFA app. A dedicated page scopes the action to exactly what's happening — no config workbook round-trip, no webhook, no re-provision. The WFA-Seed recipe is thin (lookup project, build split config JSON, call P-02b, return toast).

AD-18: Status filter protects in-progress suppliers from re-seeding

Context: Late seeding could overwrite a supplier's template after they've started working.

Decision: P-02b's query filters to status IN (pending, sent). Suppliers with status started, submitted, or complete are never seeded. This filter applies to both the P-01 and WFA-Seed callers.

Rationale: A supplier who has downloaded and started filling out their template would lose work if the file were replaced. The status boundary is conservative and clearly auditable. During initial provisioning all suppliers are pending, so the filter has no impact on that path.

AD-19: Dashboards built as WFA pages, not external tools

Context: Needed operational, analyst, and management visibility into project status.

Decision: Three WFA pages in the existing Supplier Data Collection app — Ops (developer), Analyst (supplier tracking), Manager (portfolio view). All backed by Data Table queries against existing tables.

Rationale: Data already lives in Data Tables. WFA pages read directly — no sync layer, no staleness, no maintenance. The shared workspace means all clients are visible; the Analyst and Seed pages use a project selector dropdown to scope to one client at a time.

AD-20: project_status stamped by each recipe, not derived at read time

Context: Project status could be derived by joining across tables (template version exists? suppliers bootstrapped? any submissions?). WFA pages don't handle complex joins well.

Decision: Add project_status to WFA_TemplateProject. Each recipe stamps it as the pipeline progresses: config_pending → building → bootstrapping → onboarding → active → complete.

Rationale: Every dashboard page becomes a single-table query with a string filter. No joins, no derivation, no lag. The stamping adds one field update per pipeline stage — negligible cost.

AD-21: B-02 double-nesting bug identified and fixed

Context: B-02 Step 18's ensure_dir_exists had directory_path and directory_name both containing the same {client}_{corr_short} value, creating {root}/Client_Name_a3b2c1d4/Client_Name_a3b2c1d4/.

Decision: Replace with build_storage_path call (AD-04) followed by ensure_dir_exists using parent_path and leaf_name from the connector output.

Rationale: The connector handles the path split correctly. The bug was caused by Workato's ensure_dir_exists always creating directory_name inside directory_path — a behavior that's easy to get wrong when building paths manually.

AD-22: customer_name added to WFA_SupplierRequest

Context: Downstream recipes (WFA-04, P-03) need the client name for file naming and task labels. Previously required a join to WFA_TemplateProject.

Decision: P-01's bootstrapping py_eval (Step 54) stamps customer_name on each WFA_SupplierRequest record.

Rationale: Avoids an extra DB lookup in WFA-04 and P-03. The value is static for the life of the supplier request.

AD-23: ENV_CURRENT_MANIFEST_ID is overloaded (future fix)

Context: ENV_CURRENT_MANIFEST_ID is used as a FileStorage filename in R-B-00 and as a Developer API package ID in B-03a. Neither is active today.

Decision: Documented as a known issue. No fix now — cross-workspace provisioning (B-03a) and manifest versioning (R-B-00) are not yet active. When either is built, split into two properties.

Rationale: Fixing an unused property has no ROI. The documentation ensures it's not rediscovered later.

# SDC Platform — Architectural Decisions Register (Consolidated)

This document extends the original ADR (AD-01 through AD-23, from the P-02b seeding session) with decisions extracted from the Control Plane Recipe Build-Out and the Validation/Manual Input design sessions.

Decisions are organized as:
- **AD-##** — Architectural decisions (design choices with alternatives considered)
- **BF-##** — Bug fixes (implementation corrections with root cause)
- **SC-##** — Schema changes (field additions, renames, type corrections)
- **CV-##** — Conventions (naming patterns, placeholder standards, structural rules)

---

# Architectural Decisions (continued from AD-23)

---

## AD-24: Config update reuses the front door

**Context:** Config updates (analyst changes the config workbook after initial provisioning) need a trigger mechanism. Options: a separate webhook endpoint, a WFA page action, or the same webhook used for initial provisioning.

**Decision:** The analyst fires the same GAS webhook for both initial provisioning and config updates. R-1 detects the difference by looking up `config_file_id` in the Requests table — if an ACTIVE row exists, it's an update; if not, it's new.

- **New request path:** R-1 → R-1b → R-2a → R-2b(`is_initial=true`) → R-008
- **Update path:** R-1 → R-1b → R-2b(`is_initial=false`) — skips R-2a and R-008

**Rationale:** One entry point, one payload shape, one validation step. The analyst's workflow is identical — edit the config, click the button. The routing logic is a single DB lookup that already happens in R-1. A separate endpoint would duplicate webhook handling and validation for no benefit.

---

## AD-25: R-2b stays in the base project

**Context:** Most per-client recipes are cloned into client folders by R-2a. R-2b (Parse & Hydrate Config) is called by both R-2a (initial) and R-1b (update). Workato's `call_recipe_async` requires a static `flow_id` at design time.

**Decision:** R-2b lives in the base project, not the client folder. It uses the Data Tables API connector for dynamic table addressing (`table_id` from `table_results_map`) instead of the standard Data Tables connector.

**Rationale:** A client-folder recipe's flow_id is only known after R-2a clones it. Both R-2a and R-1b need to call R-2b — keeping it in the base project means both callers can reference a known, static flow_id. The Data Tables API connector makes dynamic table access possible without per-client recipe copies.

---

## AD-26: One hydration recipe for all versions

**Context:** Initial config hydration and config updates perform the same logical operation — parse config, validate, create version, write CFG rows, store frozen config. Only two things differ: version number and whether R-008 is called afterward.

**Decision:** R-2b handles both paths. An `is_initial` boolean parameter controls the R-008 gate. Version deprecation (Steps 4–7) is a no-op on first run because no published version exists yet.

**Rationale:** One recipe, one code path, one place to fix parsing bugs. The `is_initial` flag is a single if/else — the cost of two separate recipes (with duplicated logic that drifts) far outweighs the cost of one boolean branch.

---

## AD-27: Version scoping, not deletion

**Context:** When a config update creates a new version, the old version's CFG rows (CFG_Field, CFG_Rule, CFG_Lookup, etc.) need to be handled. Options: delete old rows, or leave them scoped to the old version.

**Decision:** Old CFG rows are never deleted. Each hydration creates new rows scoped to a new `template_version_id`. The old version's rows become inert when its status changes to `deprecated`.

**Rationale:** Preserves full audit trail — you can always see what a supplier was validating against at any point. Enables potential rollback (re-activate old version without re-parsing). Deletion is destructive and irreversible; scoping is additive and safe.

---

## AD-28: `table_results_map` persisted to FileStorage

**Context:** `table_results_map` (the mapping of logical table names to Workato table IDs and field UUIDs) is produced by R-2a during provisioning. The config update path (R-1b → R-2b) needs this map but doesn't run R-2a.

**Decision:** R-2a serializes `table_results_map` to FileStorage after provisioning and stores the file ID on both `WFA_TemplateProject` and the Requests row. On the update path, R-1b reads it from FileStorage (via the Requests row pointer) and passes it to R-2b.

**Rationale:** The map is immutable — table IDs and field UUIDs don't change after provisioning. FileStorage is the established distribution mechanism for frozen data (see AD-03 for the parsed config pattern). Storing the pointer on the Requests row means R-1b can resolve it without a project lookup.

---

## AD-29: Existing suppliers unaffected by config updates

**Context:** When a new config version is published, existing `WFA_SupplierRequest` rows reference the old version via `assigned_version_id`. Should they be migrated to the new version?

**Decision:** No. Existing suppliers keep their frozen `assigned_version_id` and continue validating against the old version. Supplier reassignment to a new version is deferred to a future iteration.

**Rationale:** A supplier who is mid-workflow could have their validation rules change out from under them. The safe default is stability — each supplier sees the version they were onboarded with. Reassignment is a conscious analyst action, not an automatic side effect.

---

## AD-30: No incremental supplier bootstrapping on config update

**Context:** If the analyst adds new suppliers to the config workbook and re-fires the webhook, should the update path create `WFA_SupplierRequest` rows for the new suppliers?

**Decision:** No. The update path (R-2b with `is_initial=false`) does not call R-008. New suppliers added to the config are not bootstrapped on the update path.

**Rationale:** Incremental bootstrapping requires diffing the new config against existing supplier rows, handling edge cases (renamed suppliers, removed suppliers, changed user assignments), and deciding what happens to the new suppliers' versions. This is real complexity with real risk. Deferred until the use case is validated by actual analyst requests.

---

## AD-31: `CONFIG_UPDATE` as a Requests status

**Context:** Config update webhooks need audit trail in the Requests table. Options: reuse the existing ACTIVE row, or create a new row.

**Decision:** Config update webhooks create a new Requests row with `status = CONFIG_UPDATE`, which transitions to `CONFIG_APPLIED` on success or `FAILED` on failure. The original ACTIVE row stays ACTIVE untouched.

**Rationale:** Each webhook invocation = one Requests row. The original row's ACTIVE status is the canonical "this project is live" marker and shouldn't be overwritten. The `VER_TemplateVersion` chain provides the detailed audit trail of what changed; the Requests row provides the operational audit trail of when and who triggered it.

**Extended enum:** `PENDING | PROVISIONING | CONFIG_UPDATE | CONFIG_APPLIED | ACTIVE | REJECTED | FAILED`

---

## AD-32: Slot-based manual input staging

**Context:** Suppliers can enter worker data manually via a WFA page (P-002) instead of uploading a file. The original design exposed the raw `RUN_ManualEntry` EAV table directly as an editable widget. Problems: the EAV table is not a usable input surface, the page lost data on save, and the UX was confusing.

**Decision:** Redesign around the slot fields already present on `WFA_SupplierRequest` (`slot_text_01` through `slot_date_04`):

1. Slots serve as a clean, dynamic input form. Labels come from `CFG_FormSlot`.
2. **"Save & add worker"** calls WFA-02 (née R-007c) via `invoke-app-function`, passing slot values as trigger parameters.
3. WFA-02 maps each slot to its `field_id` via `CFG_FormSlot.slot_name`, writes rows into `RUN_ManualEntry` with the correct `row_number`, returns success.
4. The page clears the form via `reset-widgets-values`.
5. `RUN_ManualEntry` table widget stays on the page as a read-only accumulator.
6. A separate **"Submit all"** button calls WFA-03 (née R-007b) to trigger validation.

**Rejected alternative:** Dynamically creating per-client data tables. Workato Data Tables are design-time artifacts — they can't be created or schema-altered programmatically. Table widgets also require static bindings.

**Rejected alternative:** One request per worker with slot-only input. Business requirement is multiple workers per supplier request.

**Rationale:** The slot → staging → accumulator pattern separates the input surface (slots, controlled by config) from the storage surface (EAV table, structural). The supplier interacts with a clean form; the complexity is hidden in the recipe.

---

## AD-33: Validation pipeline split into Python pre-processing and SQL

**Context:** The V-01 validation SQL originally implemented only 1 of 17 rule types (`conditional_required`). Expanding to all 17 within pure SQL is impractical — SQLite lacks regex support, date normalization requires format-aware parsing, and constraint strings (e.g., `"min:1,max:50"`) need parsing.

**Decision:** Two-phase validation:

**Phase 1 — Python pre-processing (py_eval step):**
- Parses constraint strings: `field_length_validation` → `len_min`/`len_max`, `numeric_field_validation` → `numeric_min`/`numeric_max`, `date_field_validation` → `date_min`/`date_max`
- Resolves tokens (`today` → current date)
- Normalizes submitted dates to ISO-8601 (`YYYY-MM-DD`) based on `data_format`
- Evaluates regex patterns via `re.fullmatch()`
- Outputs: `enriched_fields`, `normalized_payload`, `precomputed_errors`

**Phase 2 — SQL (16 CTEs):**
- Single-field: `presence_required`, `presence_must_be_empty`, `lookup_failures`, `column_unique_failures`, `length_failures`, `numeric_range_failures`, `date_range_failures`
- Cross-field: `conditional_required`, `conditional_empty`, `mutually_exclusive`, `at_least_one`, `must_match`, `must_not_match`, `comparison` (gt/gte/lt/lte), `composite_unique`
- Pre-computed: `precomputed_passthrough` (regex and date parse errors from Python)

**Rationale:** Each phase does what it's good at. Python handles parsing, normalization, and regex. SQL handles set-based comparisons, joins, and cross-row checks. The boundary is clean: Python enriches the inputs, SQL evaluates the rules.

---

## AD-34: Rule keys are `backend_error_code`, not display names

**Context:** `CFG_Rule.rule` stored display names from the config spreadsheet dropdown ("Required if", "Must be empty if"). The SQL needs machine-readable keys for CTE matching.

**Decision:** The canonical rule key is the `backend_error_code` from the `_mapping` sheet (e.g., `err_conditional_required`, `err_conditional_empty`). The config parser (connector Action 1) translates display name → error code when writing `CFG_Rule` rows. Analysts continue to use human-readable dropdown labels.

**Rationale:** Display names are for humans; code paths need stable, predictable strings. Adding a new rule type means adding one `_mapping` row — the SQL picks it up via the CTE name, no recipe changes needed.

---

## AD-35: `customer_name` denormalized onto `WFA_SupplierRequest`

**Context:** Multiple downstream recipes and the supplier-facing WFA page need the client/project name. It lives on `WFA_TemplateProject`. WFA pages cannot traverse relation columns to display fields from linked tables.

**Decision:** `customer_name` is a plain `short-text` field on `WFA_SupplierRequest`, populated at bootstrap time from `WFA_TemplateProject.project_name`. Written in P-03 (née S-00) step 12.

**Rejected alternative:** A relation column to `WFA_TemplateProject`. WFA pages can't traverse relations — you'd still need the text field.

**Rationale:** `project_name` is write-once and immutable for the life of a project. No sync risk from denormalizing. Avoids an extra DB lookup in every recipe that needs the name.

**Note:** This extends AD-22 (which added `customer_name` via the bootstrap py_eval in the earlier P-01 design). The implementation point shifted to P-03 step 12 in the later session.

---

## AD-36: Recipe naming convention

**Context:** Recipe names were inconsistent — some used R-### codes, some used descriptive names, some mixed both. The prefix gave no indication of what pipeline phase the recipe belonged to.

**Decision:** Convention: `{phase}_{sequence} {verb} {object}`

| Phase | Meaning |
|-------|---------|
| **B** | Bootstrap (base-project provisioning chain) |
| **P** | Provisioning (project setup, config, onboarding) |
| **WFA** | App-function-triggered (page interactions) |
| **V** | Validation pipeline |

**Canonical mapping:**

| Old Name | New Name |
|---|---|
| C-01 | P-01 Provision project |
| C-02 | P-02 Build XLSX template |
| P-02b | P-02b Seed incumbent data |
| S-00 | P-03 Onboard suppliers |
| WFA-001 | WFA-01 Advance stage to started |
| R-007c | WFA-02 Save worker entry |
| R-007b | WFA-03 Submit manual input |
| R-6 | WFA-04 Submit file upload |
| R-7 | V-01 Validate supplier input |
| R-8 | V-02 Route validation results |

**Rationale:** Phase prefix tells you where the recipe lives in the pipeline at a glance. Verb-object tells you what it does. Sequence numbers within a phase reflect execution order. Old R-### codes were arbitrary and didn't communicate pipeline position.

---

## AD-37: Task assignment wired to `WFA_SupplierUser`, not `WFA_SupplierRequest`

**Context:** P-03 (née S-00) steps 22–23 assigned tasks using `contact_email` from `WFA_SupplierRequest`. That field is never populated — emails exist only on `WFA_SupplierUser.user_email`. Additionally, both steps were inside the request foreach but outside the user foreach, so only one user per request would ever get a task.

**Decision:** Move steps 22–23 inside the SupplierUser foreach loop. Wire the email pill to `WFA_SupplierUser.user_email`. Every invited user receives their own task. Multi-user suppliers are supported naturally.

**Rationale:** The data model already supports multiple users per supplier request (via `WFA_SupplierUser`). The task assignment must follow the same cardinality.

---

## AD-38: Stage change moved from submission recipe to validation recipe

**Context:** WFA-03 (née R-007b) tried to change the workflow stage to "Validating" before `app_function_return` resolved the human review task. This failed because `app_function_return` terminates recipe execution, and the stage change can't happen while the task is still pending.

**Decision:** Reorder: WFA-03 updates the request status to `submitted`, then calls `app_function_return` (which terminates the recipe and resolves the task). The stage change to "Validating" moves into V-01, which runs asynchronously after the task resolves.

**Rationale:** `app_function_return` is a hard stop — nothing executes after it. The status update (a plain data table write) works regardless of task state. The stage change requires the task to be resolved first, so it belongs in the next recipe in the chain.

---

# Bug Fixes

These are implementation corrections with identified root causes. Documented here because the root causes reveal Workato platform behaviors worth remembering.

---

## BF-01: `RUN_ManualEntry` relation field not mapped

**Symptom:** `RUN_ManualEntry` table widget on P-002 showed no rows despite rows existing.

**Root cause:** P-03 step 14 (`create_records_batch` for `RUN_ManualEntry`) never mapped the `supplier_request_id` relation field. Rows were orphaned — the page widget's `relatedColumnId` filter found nothing.

**Fix:** Add the relation field to the batch create mapping using the Workato Record ID from `WFA_SupplierRequest` (not the business UUID).

**Platform lesson:** Relation fields in Workato Data Tables always require the internal Record ID, not any business-layer identifier.

---

## BF-02: P-002 button passed empty `supplier_request_id`

**Symptom:** "Submit worker data" button triggered a cascade failure: no request found → no FormSlots → empty rows → "Records can't be blank."

**Root cause:** The button read from page variable `REQUEST.supplier_request_id`, which was never populated — no handler ever set it.

**Fix:** Rewire from page variable to a direct request field pill (`source: request, path: ["field", "98922f09"]`), matching the pattern used by every other widget on the page.

---

## BF-03: V-01 `resolved_payload` empty for manual input

**Symptom:** When validation was triggered from manual input (no file upload), the SQL had no data.

**Root cause:** `resolved_payload` was only set inside the `if (file_id present)` branch. For manual input, the branch was skipped entirely.

**Fix:** Add an else branch that sets `resolved_payload` from the trigger's `transposed_payload` parameter.

---

## BF-04: V-01 lookup CTE produced duplicates

**Symptom:** Lookup validation returned duplicate error rows.

**Root cause:** The `lookup_failures` CTE used `json_each(l.valid_values)` assuming each `CFG_Lookup` row held a JSON array. In fact, `CFG_Lookup` stores one valid value per row. The `INNER JOIN` pattern created row multiplication.

**Fix:** Replace with `NOT EXISTS` subquery checking across all `CFG_Lookup` rows for the given `lookup_name`. One error per failed field, no duplicates.

---

# Schema Changes

Consolidated from all sessions. Grouped by table.

---

## SC-01: Requests table additions

| Column | Type | Purpose | Written by | Read by |
|--------|------|---------|------------|---------|
| `table_results_map_file_id` | string (optional) | FileStorage pointer to the serialized table_results_map | R-2a | R-1b (update path) |

**Status enum extended:** `PENDING | PROVISIONING | CONFIG_UPDATE | CONFIG_APPLIED | ACTIVE | REJECTED | FAILED`

---

## SC-02: `WFA_TemplateProject` additions

| Column | Type | Purpose |
|--------|------|---------|
| `table_results_map_file_id` | string (optional) | Same pointer as on Requests, accessible from per-client context |

(`parsed_config_file_id` and `project_storage_path` already exist in v3.1.0 schema.)

---

## SC-03: `WFA_SupplierRequest` additions

| Column | Type | Purpose |
|--------|------|---------|
| `customer_name` | short-text | Denormalized from `WFA_TemplateProject.project_name` (AD-35) |

---

## SC-04: Field renames (6)

| Table | Old Name | New Name | Reason |
|-------|----------|----------|--------|
| `WFA_SupplierRequest` | `status_StateMachine` | `status` | Redundant suffix |
| `WFA_SupplierRequest` | `file_upload` | `latest_upload_file_id` | Clarifies it's a FileStorage pointer, not a File column |
| `WFA_TemplateProject` | `drive_file_id` | `incumbent_data_file_id` | Clarifies purpose; `drive_file_id` is generic |
| `WFA_TemplateProject` | `drive_folder_id` | `output_folder_id` | Same reasoning |
| `CFG_Lookup` | `lookup_field_id` | `lookup_id` | Not a field ID — it's a lookup group identifier |
| `CFG_Lookup` | `valid_values` | `valid_value` | Singular — each row is one option, not a collection |

---

## SC-05: Field type corrections (2)

| Table | Column | Old Type | New Type | Impact |
|-------|--------|----------|----------|--------|
| `VER_TemplateVersion` | `validation_summary` | short-text | long-text | Only C-01 (now P-01) writes this field |
| `RUN_Upload` | `valid_payload` | short-text | long-text | Dead field — never written by any recipe. Safe to change or remove. |

---

## SC-06: Pending decision — `contact_email`

`WFA_SupplierRequest.contact_email` is never populated. Options:
1. Populate from the first `WFA_SupplierUser` at bootstrap and rename to `primary_user_email`
2. Remove entirely

No action taken yet.

---

# Conventions

---

## CV-01: Placeholder prefixes in recipe JSON

| Prefix | Scope | Example |
|--------|-------|---------|
| `__FIELD_UUID__` | Requests table columns | `__FIELD_UUID__config_file_id` |
| `__WR_FIELD_UUID__` | WorkspaceRegistry columns | `__WR_FIELD_UUID__project_count` |
| `__SYS_UUID__` | System columns | `__SYS_UUID__created_at` |
| `__SDC_PLATFORM_CONNECTOR__` | Connector provider name | Used in recipe JSON where the connector is referenced |

---

## CV-02: Step alias format

- **General recipes:** 8-character hex strings (e.g., `a1b2c3d4`)
- **R-2b specifically:** Structured prefixes (e.g., `r2b00001`, `r2b00002`)

---

## CV-03: Datapill syntax

`_dp('{...}')` with a JSON payload containing `pill_type`, `provider`, `line` (step alias), and `path`.

---

## CV-04: Async handoffs

All cross-recipe calls use `call_recipe_async`. Callers don't need return values. Exception: B-02 → B-01 is synchronous (AD-14) because B-02 is lightweight and B-01 needs error feedback.

---

## CV-05: Error handling ownership

The caller is responsible for Requests status updates on failure. Called recipes (e.g., R-2b) log errors but don't update Requests directly.

---

## CV-06: Boolean conditions in IF blocks

Use `.to_s` conversion and compare against string `"true"` or `"false"` to avoid Workato type coercion issues.

---

## CV-07: FileStorage path hierarchy

Standard hierarchy (from AD-05, restated for completeness):

```
/{root}/{client_slug}/{project_short}/
  ├── /config
  ├── /templates
  ├── /seeded
  ├── /uploads
  └── /reports
```

Paths are always constructed via the `build_storage_path` connector action (AD-04). No recipe ever runs its own slugification.

---

# Cross-Reference: Decision Dependencies

Some decisions form chains where one depends on or extends another:

- **AD-03 → AD-28:** FileStorage-as-text-field pattern extends to `table_results_map`
- **AD-04 → AD-05 → AD-06:** Path construction → hierarchy → single storage of `project_storage_path`
- **AD-22 → AD-35:** `customer_name` denormalization, implementation point shifted from P-01 py_eval to P-03 step 12
- **AD-24 → AD-25 → AD-26:** Unified front door → R-2b in base project → single hydration recipe
- **AD-27 → AD-29:** Version scoping enables frozen supplier assignments
- **AD-32 → AD-33 → AD-34:** Slot input → validation pipeline → rule key convention (the manual input flow feeds into validation which uses the rule keys)
- **AD-37 → AD-38:** Task assignment fix and stage-change reorder are both P-03/WFA-03 corrections discovered in the same session
