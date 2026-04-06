# Recipe Responsibility Map

## How to read this

Each recipe has one job. The "Owns" line is the single sentence you'd put on
a slide. Everything under it is detail.

---

## Base project recipes

These live in the home base folder. They manage infrastructure, routing, and
cross-client concerns. They never touch per-client data directly.

---

### R-B-00 — Package and version data table manifest

**Owns:** Snapshotting the template project definition into a versioned manifest.

**Trigger:** Scheduler (or manual)

**Reads:** Template definition from FileStorage, HOME - Manifests table

**Writes:** HOME - Manifests (new row with manifest_id, snapshot_file_id)

**Calls:** Nothing

**When it runs:** When the template project definition changes (new tables added,
schema changes, recipe bundle updates). Not part of the provisioning chain —
runs independently.

---

### R-B-01 — Receive request via webhook

**Owns:** Front door. Validates the webhook payload and decides if this is a
new client or a config update.

**Trigger:** Webhook (POST from Apps Script)

**Reads:** HOME_Requests (lookup by config_file_id to detect new vs update)

**Writes:** HOME_Requests (one row per webhook, always)

**Calls:**
- New client → R-B-02 (route)
- Config update → R-2b directly (once Step 12 is wired) ← **not yet built**

**Key logic:** Python validates payload structure (correlation_id UUID format,
email format, etc.). Then checks if an ACTIVE request already exists for this
config_file_id. New request → status PENDING, call R-B-02. Existing →
status CONFIG_UPDATE, call R-2b.

---

### R-B-02 — Route data collection request

**Owns:** Workspace routing. Finds an available workspace and dispatches
provisioning.

**Trigger:** Callable (from R-B-01)

**Input:** request_id, correlation_id, client_name, analyst_email, target_vms,
config_file_id, template_file_ids, timestamp, separate_workspace_required

**Reads:** HOME_Requests, HOME_WorkspaceRegistry

**Writes:** HOME_Requests (workspace_id), HOME_WorkspaceRegistry (project_count)

**Calls:**
- Separate workspace required → R-B-3b (stub)
- Same workspace → R-B-3a (provision project)

**Key logic:** Checks if a separate workspace is needed. If not, queries
WorkspaceRegistry for an available workspace. No capacity → FAILED. Found →
stamps workspace_id on Requests, increments project_count, calls R-B-3a.

---

### R-B-3a — Instantiate a project in this workspace

**Owns:** Provisioning. Creates the client folder with all tables, recipes,
and infrastructure via package export/import.

**Trigger:** Callable (from R-B-02)

**Input:** request_id, correlation_id, workspace_id, client_name, analyst_email,
config_file_id, target_vms, template_file_ids

**Reads:** HOME_Requests, template project package

**Writes:** HOME_Requests (project_folder_id), creates new Workato project folder

**Calls:** R-2b ← **not yet wired (Blocker 3)**

**Key logic:** Looks up the request. Creates a top-level folder and FileStorage
directory. Exports the template project as a package via the Developer APIs
connector. Imports the package into the new folder. Polls for completion. Starts
the cloned recipes. The import automatically creates all 13 data tables and
rebinds all recipe references.

**Missing:** Does not return useful data (empty return_result). Does not call
R-2b after provisioning. These are open blockers.

---

### R-B-3b — Instantiate a workspace

**Owns:** Multi-workspace provisioning (Case B). Currently a stub.

**Trigger:** Callable (from R-B-02)

**Input:** request_id, correlation_id, project_folder_id, table_results_map,
config_file_id, template_file_ids

**Calls:** SDC Platform Connector → parse_config_file (just calls and returns)

**Status:** Stub/future. Case B (separate workspace) is deferred.

---

## Client folder recipes — Configuration layer

These are cloned into each client's project folder by R-B-3a. They use static
table bindings (001_*) that get repointed during package import. They own
the configuration lifecycle: parsing, hydrating, validating, and
generating templates.

---

### R-2b — Parse and hydrate configuration

**Owns:** Config hydration. Takes a config file, parses it, and populates the
CFG_* data tables. Creates the template version.

**Trigger:** Callable (from R-B-3a on initial, from R-B-01 on config update)

**Input:** request_id, correlation_id, project_folder_id,
workato_file_storage_path, table_results_map, config_file_id,
template_file_ids, drive_id_config_json

**Reads:** 001_WFA_TemplateProject, 001_VER_TemplateVersion, Google Drive (config JSON)

**Writes:**
- 001_VER_TemplateVersion (create draft, deprecate old)
- 001_CFG_Field (batch insert)
- 001_CFG_Rule (batch insert)
- 001_CFG_Lookup (batch insert) ← **not yet built**
- 001_CFG_ErrorTranslation (batch insert) ← **not yet built**
- 001_CFG_Variant (batch insert, conditional) ← **not yet built**
- 001_CFG_VariantField (batch insert, conditional) ← **not yet built**
- 001_WFA_TemplateProject (parsed_config_file_id) ← **not yet built**
- FileStorage (parsed config JSON snapshot)

**Calls:**
- R-1a sync (template generation + validation + publish) ← **not yet built**
- R-4 async (bootstrap suppliers, initial only) ← **not yet built**

**Key logic:** Downloads the GAS-serialized config JSON from Drive. Passes it to
the SDC Platform Connector (parse_config_file). If parse fails, stops. On
success: generates a template_version_id, runs a Python step that generates
business PKs (field_id, rule_id, etc.), resolves FK references (depends_on,
condition_field_id), and explodes variants into flat junction rows. Batch-inserts
into all CFG tables. Version-aware: deprecates any existing published version
before creating a new one.

---

### R-1a — Register a new template or template version

**Owns:** Template generation orchestration. Generates XLSX supplier templates
from hydrated config and triggers validation.

**Trigger:** Currently webhook. **Being rewritten as callable** (from R-2b).

**Input (revised):** template_version_id, template_project_id,
workato_file_storage_path

**Reads:** 001_CFG_Field, 001_CFG_Lookup, 001_CFG_Variant,
001_CFG_VariantField, 001_WFA_TemplateProject

**Writes:**
- FileStorage (one XLSX per variant or one base XLSX)
- 001_VER_TemplateVersion (master_template_file_id)

**Calls:**
- R-1B sync × N (once per variant, or once for base)
- R-001b sync (validate + publish)

**Returns:** {status: "published"|"failed", error_details, template_version_id}

**Key logic (revised):** Reads the hydrated config from Data Tables. Python step
builds per-variant payloads by joining CFG_VariantField to CFG_Field to get
visible fields per variant. Loops over variants, calling R-1B for each. Stores
each XLSX to FileStorage. Attaches the base template to VER_TemplateVersion.
Calls R-001b to validate and publish (or reject). Returns the outcome to R-2b.

---

### R-1B — Build XLSX from Sheets configuration

**Owns:** XLSX rendering. Generates one supplier-facing template file with
column headers, data validation dropdowns, and dependent dropdowns.

**Trigger:** Callable (from R-1a)

**Input:** fields (JSON), lookups (JSON), client_name, variant_name

**Reads:** Nothing (pure computation)

**Writes:** Nothing (returns file content to caller)

**Returns:** {success, error_message, file_content (base64), file_name}

**Key logic:** Python (openpyxl) builds a workbook with column headers from
field definitions, data validation rules from lookup values, and dependent
dropdowns from parent-child lookup relationships. Returns base64-encoded XLSX.

**Status:** Python is untested, particularly dependent dropdown rendering.

---

### R-001b — Validate new or updated template

**Owns:** Config integrity validation and version publishing.

**Trigger:** Callable (from R-1a)

**Input:** template_version_id

**Reads:** 001_VER_TemplateVersion, 001_CFG_Field, 001_CFG_Rule, 001_CFG_Lookup

**Writes:** 001_VER_TemplateVersion (status → "published" or "invalid")

**Returns:** {is_valid, error_details, template_version_id} ← **return_result not yet added**

**Calls:** Sends email to analyst on validation failure

**Key logic:** Reads the draft version's config from Data Tables. Python checks
for duplicate field names, orphaned lookups (lookup_name in field not found in
lookup table), malformed lookup syntax, ghost fields in rules (target or
condition field doesn't exist). On failure: marks version "invalid", emails
analyst. On success: sets status "published", published_at = now.

---

## Client folder recipes — Operational layer

These handle the supplier-facing lifecycle: bootstrapping supplier records,
sending outreach, ingesting uploads, validating data, and routing results.

---

### R-4 — Process supplier and user information (formerly R-008)

**Owns:** Supplier bootstrapping. Creates WFA_SupplierRequest and
WFA_SupplierUser rows from the frozen config.

**Trigger:** Callable (from R-2b, initial provisioning only)

**Input:** template_project_id, template_version_id, parsed_config_file_id

**Reads:** 001_WFA_TemplateProject, 001_VER_TemplateVersion, 001_CFG_Variant,
FileStorage (parsed config JSON for supplier/user data)

**Writes:**
- 001_WFA_SupplierRequest (batch insert — one per supplier)
- 001_WFA_SupplierUser (batch insert — one per supplier-user pair)

**Key logic:** Reads the frozen parsed config JSON from FileStorage (using
parsed_config_file_id). Extracts suppliers from the 2_suppliers sheet data and
users from the 3_users sheet data. Python builds the records, resolving variant
assignments (supplier → variant_name → variant_id from CFG_Variant). Batch-
inserts into WFA_SupplierRequest and WFA_SupplierUser.

---

### R-5 — Generate template and send outreach

**Owns:** Supplier communication. Sends outreach email with portal access.

**Trigger:** Webhook

**Reads:** 001_WFA_SupplierRequest, supplier context

**Writes:** 001_WFA_SupplierRequest (status update)

**Calls:** Workflow App invite user, email

**Status:** 1 step in block — likely incomplete/stub.

---

### R-6 — Ingest supplier input (Workflow App)

**Owns:** Upload logging. Records that a supplier submitted a file through the
Workflow App portal.

**Trigger:** Workflow App (app_function_generic_request)

**Input:** supplier_request_id, supplier_completed_file

**Reads:** 001_WFA_SupplierRequest

**Writes:** 001_RUN_Upload (new row with upload_id, file reference)

**Calls:** R-7 async (validate the upload)

**Key logic:** Creates a RUN_Upload row to record the submission. Stores the
uploaded file to FileStorage. Calls R-7 to validate.

---

### R-7 — Validate supplier input (callable function)

**Owns:** Upload validation. Validates one supplier's upload against the frozen
config version.

**Trigger:** Callable (from R-6)

**Input:** upload_id, file_id, transposed_payload (optional — for manual/UI input)

**Reads:** 001_RUN_Upload, 001_WFA_SupplierRequest, 001_CFG_Field, 001_CFG_Rule,
001_CFG_Lookup, 001_CFG_ErrorTranslation, FileStorage (uploaded file)

**Writes:**
- 001_RUN_ValidationResult (one row per validation run)
- 001_RUN_FieldError (batch insert — one row per field error)

**Calls:** R-8 async (route the results)

**Key logic:** Looks up the upload → supplier request → current version. Loads
the config (fields, rules, lookups, error translations). Downloads the uploaded
file from FileStorage. Python transposes the file into entity-attribute-value
format. SQL CTE joins data against config to produce validation results. Parses
results, writes RUN_ValidationResult, batch-inserts RUN_FieldError rows.

**Note:** This is the existing R-002 recipe, renumbered. It may be replaced or
supplemented by the SDC Platform Connector's Validate Upload action (Action 3)
in a future iteration.

---

### R-8 — Route results

**Owns:** Post-validation routing. Determines what happens after validation
completes.

**Trigger:** Callable (from R-7)

**Input:** validation_result_id

**Reads:** 001_RUN_ValidationResult, 001_WFA_SupplierRequest

**Writes:** 001_WFA_SupplierRequest (status update)

**Calls:** Workflow App return (supplier portal update)

**Key logic:** Reads the validation result. If valid: updates supplier request
status to "validation_success", returns to Workflow App. If invalid: updates
to "supplier_action_required", returns to Workflow App so supplier can
resubmit.

---

### R-009a — File merge for incumbent data

**Owns:** Incumbent data merging. Merges existing supplier data into a template
for a single supplier request.

**Trigger:** Webhook

**Input:** supplier_request_id, file context

**Reads:** 001_WFA_SupplierRequest, 001_RUN_Upload

**Writes:** FileStorage (merged file), 001_WFA_SupplierRequest (update)

**Key logic:** Takes incumbent data and merges it into the published template
format for a specific supplier. Uses Python for the merge operation.

---

### R-009b — Ingest incumbent data from Apps Script

**Owns:** Incumbent data ingestion from GAS. Receives incumbent data pushed by
Apps Script and routes it to the right supplier.

**Trigger:** Webhook

**Reads:** 001_WFA_SupplierRequest

**Writes:** FileStorage (stored file), 001_WFA_SupplierRequest (update)

**Key logic:** Receives incumbent/seed data from Apps Script, stores it to
FileStorage, and updates the supplier request to reflect that seeded data is
available.

---

## The two call chains

### New client (full provisioning)

```
GAS webhook
  → R-B-01 (validate, log, detect new)
    → R-B-02 (route to workspace)
      → R-B-3a (provision folder via package import)
        → R-2b (hydrate CFG tables)
          → R-1a (generate XLSX templates per variant)
            → R-1B × N (render each XLSX)
            → R-001b (validate config, publish version)
          → R-4 (bootstrap supplier + user rows)
```

### Config update (existing client)

```
GAS webhook
  → R-B-01 (validate, log, detect existing)
    → R-2b (hydrate CFG tables, deprecate old version)
      → R-1a (regenerate XLSX templates)
        → R-1B × N (render each XLSX)
        → R-001b (validate config, publish new version)
      → (no R-4 — suppliers already exist)
```

### Supplier submission (runtime)

```
Supplier uploads via Workflow App portal
  → R-6 (log upload to RUN_Upload)
    → R-7 (validate against frozen config version)
      → R-8 (route result — success or resubmit)
```
