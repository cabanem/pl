# SDC Recipe Call Graph

Generated from the recipe catalog. Sync calls block; async calls fire-and-forget.

## Webhook intake & request routing
_Receives analyst webhooks, logs requests, routes to provisioning workspace._

### B-01 — B-01: Receive request (via webhook), then log and route the request
- **Trigger:** webhook `/new_request`
- **Calls (async):** B-02, P-01, U-01

### B-02 — B-02: Route data collection request
- **Trigger:** callable function (correlation_id, client_name, analyst_email, target_vms, config_file_id, template_file_ids, timestamp, separate_workspace_required, request_id, drive_id_config_json)
- **Calls (sync):** U-01
- **Calls (async):** P-01
- **Called by:** B-01

### B-05 — B-05 Request analyst portal access (webhook)
- **Trigger:** webhook `/portal-invite`

## Project provisioning
_Stands up template projects, builds XLSX templates, seeds incumbent data, onboards suppliers._

### P-01 — P-01 Provision project
- **Trigger:** callable function (request_id, correlation_id, project_storage_path, config_file_id, drive_id_config_json, is_initial)
- **Calls (sync):** C-01, P-02a, P-02b
- **Calls (async):** P-03a, U-01
- **Called by:** B-01, B-02

### P-02a — P-02a Build XLSX template
- **Trigger:** callable function (fields, lookups, client_name, variant_name)
- **Called by:** P-01

### P-02b — P-02b Seed incumbent data
- **Trigger:** callable function (template_project_id, template_version_id, incumbent_data_file_id, incumbent_split_config, project_storage_path, client_name, skip_seed_flag_check)
- **Called by:** P-01, WFA-05c

### P-03a — P-03a Onboard suppliers
- **Trigger:** callable function (template_version_id, template_project_id, correlation_id, project_storage_path)
- **Calls (async):** P-03b
- **Called by:** P-01

### P-03b — P-03b Invite and assign task to supplier user
- **Trigger:** callable function (contact_name, user_email, request_id, customer_name, request_expiration)
- **Called by:** P-03a

## Config validation (P-01 dependency)
_Accepts raw config file, validates and parses it into the canonical model. Wiring is recent and largely untested._

### C-01 — C-01 Accept raw config file, return validation result
- **Trigger:** callable function (drive_id_config_json, template_version_id, project_storage_path, persist, form_field_limit)
- **Called by:** P-01

## Supplier workflow (WFA-03/04)
_Supplier-facing WFA app: file uploads (WFA-03*) and form-based input (WFA-04*)._

### WFA-03a — WFA-03a Listen for new files in WFA_SupplierRequest
- **Trigger:** table listener on `WFA_SupplierRequest` (updated records, realtime)
- **Calls (sync):** U-01
- **Calls (async):** WFA-03b

### WFA-03b — WFA-03b Submit supplier input from file upload
- **Trigger:** callable function (supplier_request_id, web_session_data, cache_record_id, file_id)
- **Calls (async):** V-01a
- **Called by:** WFA-03a

### WFA-04a — WFA-04a Accept supplier input from form and stage
- **Trigger:** WFA app function (share_method, supplier_request_id, action_type, file_id)
- **Calls (sync):** U-01
- **Calls (async):** WFA-04c

### WFA-04b — WFA-04b Save a single worker entry (supplier)
- **Trigger:** WFA app function (supplier_request_id, slot_text_01, slot_text_02, slot_text_03, slot_text_04, slot_text_05, slot_text_06, slot_text_07, slot_text_08, slot_num_01, slot_num_02, slot_bool_01, slot_bool_02, slot_sel_01, slot_sel_02, slot_sel_03, slot_sel_04, slot_date_01, slot_date_02, slot_date_03, slot_date_04)

### WFA-04c — WFA-04c Submit supplier input from form
- **Trigger:** callable function (supplier_request_id, web_session_data)
- **Calls (async):** V-01a
- **Called by:** WFA-04a

## Supplier upload validation
_Validates supplier data submissions against the configured field/rule/lookup model and routes results._

### V-01a — V-01a Validate supplier input
- **Trigger:** callable function (upload_id, file_id, project_storage_path, transposed_payload, supplier_request_id, template_project_id)
- **Calls (sync):** U-01, V-01b, V-02
- **Calls (async):** U-01
- **Called by:** WFA-03b, WFA-04c

### V-01b — V-01b Prepare validation context
- **Trigger:** callable function (project_storage_path, upload_id, file_id, transposed_payload)
- **Calls (sync):** U-01
- **Called by:** V-01a

### V-02 — V-02 Route validation results
- **Trigger:** callable function (validation_result_id, project_storage_path)
- **Calls (sync):** RW-01
- **Calls (async):** U-01
- **Called by:** V-01a

## Analyst review workflow (WFA-05/06)
_Analyst-facing WFA app: seed-data page (WFA-05*) and submission review (WFA-06*)._

### WFA-05a — WFA-05a Get data for project selector (seed data page)
- **Trigger:** WFA dropdown loader (search_enabled=false)

### WFA-05b — WFA-05b Get data for page event/dropdown selection (seed data page)
- **Trigger:** WFA app function (template_project_id)

### WFA-05c — WFA-05c Seed incumbent data (late-arriving)
- **Trigger:** WFA app function (template_project_id, incumbent_file_id, sheet_name, split_field)
- **Calls (sync):** P-02b

### WFA-06a — WFA-06a Analyst review - approve submission
- **Trigger:** WFA app function (supplier_request_id, note)

### WFA-06b — WFA-06b Analyst review - request supplier rework
- **Trigger:** WFA app function (supplier_request_id, note_text)
- **Calls (sync):** RW-01

## Supplier rework (incomplete)
_Supplier rework flow. Per Emily, this workflow is incomplete._

### RW-01 — RW-01 Request supplier rework
- **Trigger:** callable function (supplier_request_id, notes)
- **Calls (async):** U-01
- **Called by:** V-02, WFA-06b

## Utility recipes
_Cross-cutting utility recipes called by other recipes (error handling, etc.)._

### U-01 — U-01 Handle errors
- **Trigger:** callable function (recipe_name, error, context, return)
- **Called by:** B-01, B-02, P-01, RW-01, V-01a, V-01b, V-02, WFA-03a, WFA-04a