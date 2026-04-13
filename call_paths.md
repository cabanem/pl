# SDC Platform — Recipe Call Path Trace

**Source:** 15 recipe JSON exports  
**Note:** Some recipes appear under display names in call targets that differ from their file names. Mappings are resolved below.

---

## Name Resolution

Recipe JSON exports use file-level names, but `call_recipe_async` targets reference display names. These are the same recipes:

| Call target (display name) | Actual recipe |
|---------------------------|---------------|
| `C-01: Hydrate, generate, validate, publish` | P-01 Provision project |
| `S-001: Onboard suppliers` | P-03 Onboard suppliers |
| `R-002 Validate supplier input (callable function)` | V-01 Validate supplier input |
| `R-006 Route results` | V-02 Route validation results |
| `Route data collection request` | B-02 Route data collection request |

---

## Workflow Stages (from recipe JSON)

These are the WFA workflow stages referenced by `change_workflow_stage` and `human_review_on_existing_record` actions:

| Stage | Set by | Context |
|-------|--------|---------|
| Started | WFA-01 step 1 | Supplier begins working |
| Data entry | P-03 step 24 | Supplier onboarded, template sent |
| Validating | WFA-04 step 10 | File upload submitted |
| Corrections needed | V-02 step 10, 11 | Validation failed |
| Review | V-02 step 15 | Validation passed |

---

## Pipeline 1 — New Data Collection Request

**Entry:** GAS webhook POST → B-01

```
⚡ GAS Webhook
 │
 ▼
B-01: Receive request (WEBHOOK)
 ├── Step 3: py_eval — validate webhook payload
 ├── Step 5: get_records → HOME_Requests (check for existing config_file_id)
 │
 ├── IF new request (no existing record):
 │   ├── Step 7:  add_record → HOME_Requests (status from validation)
 │   ├── IF validation passed:
 │   │   └── Step 9: ASYNC → B-02 ─────────────────────────────────┐
 │   │       params: correlation_id, client_name, analyst_email,    │
 │   │               target_vms, config_file_id, template_file_ids, │
 │   │               separate_workspace_required, request_id,       │
 │   │               drive_id_config_json, timestamp                │
 │   └── ELSE: (validation failed — no downstream call)            │
 │                                                                  │
 └── ELSE config update (existing record):                         │
     ├── Step 11: add_record → HOME_Requests (CONFIG_UPDATE)       │
     └── Step 12: ASYNC → P-01 ──────────────────────────────┐     │
         params: request_id, correlation_id,                  │     │
                 project_folder_id,                           │     │
                 workato_file_storage_path, ← ⚠ CRIT-2       │     │
                 config_file_id, drive_id_config_json,        │     │
                 is_initial=false                             │     │
                                                              │     │
┌─────────────────────────────────────────────────────────────┘     │
│                                                                   │
│  P-01: Provision project (CALLABLE)                               │
│  (config update path — is_initial=false)                          │
│  ├── Step 1:  get_records → WFA_TemplateProject                   │
│  ├── Step 5:  CONNECTOR parse_config_file                         │
│  ├── Step 8:  CONNECTOR extract_form_fields                       │
│  ├── Steps 17-33: py_eval + batch writes (CFG_*)                  │
│  ├── Steps 34-44: read-back, validate, build templates            │
│  ├── Steps 58-67: bootstrap/update supplier requests              │
│  └── Step 72: ASYNC → P-03 ───────────────────────────────┐      │
│      params: template_version_id, template_project_id,     │      │
│              correlation_id, project_storage_path           │      │
│                                                             │      │
│  ┌──────────────────────────────────────────────────────────┘      │
│  │                                                                 │
│  │  P-03: Onboard suppliers (CALLABLE)                             │
│  │  ├── Step 1:  get_records → WFA_SupplierRequest                 │
│  │  │            (status=pending, scoped by template_project_id)   │
│  │  ├── Step 2:  get_records → VER_TemplateVersion                 │
│  │  ├── Step 4:  get_records → CFG_FormSlot                        │
│  │  ├── Step 9:  get_records → CFG_Variant (per supplier)          │
│  │  ├── Step 14: update_record → WFA_SupplierRequest               │
│  │  │            (status → sent, template_file_id → shareable link)│
│  │  ├── Step 17: get_records → WFA_SupplierUser                    │
│  │  └── Step 24: STAGE → "Data entry"                              │
│  │                                                                 │
│  │  (Supplier now has template link + portal access)               │
│  │                                                                 │
│                                                                    │
┌────────────────────────────────────────────────────────────────────┘
│
│  B-02: Route data collection request (CALLABLE)
│  (new request path — is_initial=true)
│  ├── Step 2:  get_records → HOME_Requests (by request_id)
│  ├── IF request not found:
│  │   └── Step 4: set error, success=false
│  │       (⚠ MED-3: no stop — falls through)
│  │
│  ├── IF separate_workspace NOT required:
│  │   ├── Step 7:  declare template_project_id = UUID
│  │   ├── Step 8:  CONNECTOR build_storage_path
│  │   │            (⚠ uses ENV_FILE_STORAGE_ROOT — this is correct, canonical derivation point)
│  │   ├── Step 9:  update variable project_storage_path
│  │   ├── Step 10: FileStorage ensure_dir_exists
│  │   ├── Step 11: add_record → WFA_TemplateProject
│  │   │            (⚠ CRIT-1: project_storage_path from wrong variable)
│  │   ├── Step 12: update_record → HOME_Requests (status → ACTIVE)
│  │   ├── Step 13: ASYNC → P-01 ──────────────────────┐
│  │   │   params: request_id, correlation_id,          │
│  │   │           project_storage_path,                │
│  │   │           config_file_id, drive_id_config_json,│
│  │   │           is_initial=true                      │
│  │   │                                                │
│  │   │   (Joins P-01 flow above ↑)                    │
│  │   │                                                │
│  │   └── Step 14: set success=true, project_storage_path
│  │
│  └── ELSE separate_workspace required:
│      ├── Step 18: update_record → HOME_Requests (status → FAILED)
│      └── Step 19: set error (not yet implemented)
│
│  Step 30: return_result (success, error_message, project_storage_path)
```

---

## Pipeline 2 — Supplier File Upload

**Entry:** Supplier clicks upload on WFA page → WFA-04

```
🖱 Supplier uploads file via WFA page
 │
 ▼
WFA-04: Submit file upload (WFA_PAGE_EVENT)
 ├── Step 1:  get_records → WFA_SupplierRequest (by supplier_request_id)
 ├── Step 2:  add_record → RUN_Upload (status=received, upload_id=UUID)
 ├── Step 3:  CONNECTOR build_storage_path
 │            (⚠ MED-1: uses ENV_FILE_STORAGE_ROOT directly)
 ├── Step 5:  FileStorage store uploaded file
 ├── Step 8:  update_record → RUN_Upload (status=extracting, submitted_file_id)
 ├── Step 9:  ASYNC → V-01 ──────────────────────────────────────┐
 │   params: upload_id, file_id, project_storage_path             │
 ├── Step 10: STAGE → "Validating"                                │
 └── return success to WFA page                                   │
                                                                   │
┌──────────────────────────────────────────────────────────────────┘
│
│  V-01: Validate supplier input (CALLABLE)
│  ├── Step 2:  get_records → RUN_Upload (by upload_id)
│  ├── Step 3:  get_records → WFA_SupplierRequest
│  ├── Step 4:  get_records → CFG_Field (by template_version_id)
│  ├── Step 5:  get_records → CFG_Rule
│  ├── Step 6:  get_records → CFG_Lookup
│  ├── Step 7:  get_records → CFG_ErrorTranslation
│  ├── Step 10: py_eval — transpose payload
│  ├── Step 12: py_eval — enrich fields
│  ├── Step 13: CONNECTOR validate_upload (core validation engine)
│  ├── Step 15: add_record → RUN_ValidationResult
│  ├── Step 18: update_record → RUN_ValidationResult (final status)
│  └── Step 19: ASYNC → V-02 ─────────────────────────────────────┐
│      params: validation_result_id, project_storage_path          │
│                                                                   │
┌───────────────────────────────────────────────────────────────────┘
│
│  V-02: Route validation results (CALLABLE)
│  ├── Step 1:  get_records → RUN_ValidationResult
│  ├── Step 2:  get_records → RUN_Upload
│  ├── Step 3:  get_records → WFA_SupplierRequest
│  │
│  ├── IF validation FAILED (status=invalid):
│  │   ├── Step 5:  get_records → RUN_FieldError
│  │   ├── Step 6:  get_records → CFG_Field
│  │   ├── Step 7:  py_eval → CSV error report
│  │   ├── Step 8:  FileStorage store report           ⏸ STUB → wire up
│  │   ├── Step 9:  update WFA_SupplierRequest
│  │   │            (status → supplier_action_required)
│  │   ├── Step 10: STAGE → "Corrections needed"
│  │   └── Step 11: HUMAN_REVIEW → "Corrections needed"
│  │
│  └── ELSE validation PASSED:
│      ├── Step 14: update WFA_SupplierRequest           ← expand to pending_review
│      │            (status → validated)                    + row counts + links
│      ├── Step 15: STAGE → "Review"
│      ├── Step 16: ⏸ STUB                              ← replace with:
│      │            create workflow task                    assign to analyst
│      └── Step 17: ⏸ STUB                              ← replace with:
│                   send analyst email
│
│  (Analyst receives task → Approval form page)
│  │
│  ▼
│  WFA-06: Handle analyst review decision (TASK_COMPLETED trigger)
│  ├── IF approved:
│  │   ├── Copy file to approved/ (immutable snapshot)
│  │   ├── Update WFA_SupplierRequest (status → approved)
│  │   └── Write RUN_ReviewNote (review_action=approved)
│  │
│  └── IF rejected (rework):
│      ├── Refresh template shareable link (TTL)
│      ├── Update WFA_SupplierRequest (status → supplier_action_required)
│      ├── Write RUN_ReviewNote (review_action=rework)
│      └── Email supplier with notes + download link
│          │
│          ▼
│          (Supplier resubmits → re-enters Pipeline 2 at WFA-04)
```

---

## Pipeline 3 — Supplier Manual Entry

**Entry:** Supplier fills WFA form and clicks submit → WFA-03

```
🖱 Supplier submits manual entry via WFA page
 │
 ▼
WFA-03: Submit manual input (WFA_PAGE_EVENT)
 ├── Step 1:  get_records → WFA_SupplierRequest
 ├── Step 2:  get_records → RUN_ManualEntry
 ├── Step 5:  add_record → RUN_Upload (status=received)
 ├── Step 9:  ASYNC → V-01
 │   params: upload_id, transposed_payload
 │   ⚠ HIGH-1: missing project_storage_path
 │
 └── (joins Pipeline 2 at V-01 → V-02)
```

---

## Pipeline 4 — Late Incumbent Data Seeding

**Entry:** Analyst selects project on seed data page → WFA-05a/05b/05c chain

```
🖱 Analyst opens Seed Data page
 │
 ▼
WFA-05a: Get data for project selector (WFA_PAGE_EVENT)
 └── get_records → WFA_TemplateProject (active projects)
     (populates project dropdown)
 │
 ▼ (analyst selects project)
 │
WFA-05b: Get data for dropdown selection (WFA_PAGE_EVENT)
 ├── get_records → WFA_SupplierRequest (by template_project_id)
 └── py_eval → compute seed eligibility counts
     (populates page with supplier stats)
 │
 ▼ (analyst clicks "Seed Data")
 │
WFA-05c: Seed incumbent data (WFA_PAGE_EVENT)
 ├── Step 2:  get_records → WFA_TemplateProject
 ├── Step 7:  get_records → VER_TemplateVersion
 │            (⚠ filters on template_project_id — correct for VER)
 ├── Step 12: py_eval → build split config
 └── calls P-02b with skip_seed_flag_check=true
     │
     ▼
     P-02b: Seed incumbent data (CALLABLE)
     ├── Step 2:  get_records → WFA_SupplierRequest
     │            (by template_project_id, has_seeded_data=false)
     ├── Step 7:  get_records → CFG_Variant (by template_version_id) ✅
     ├── Step 8:  get_records → VER_TemplateVersion
     ├── Step 14: get_records → CFG_Variant (by variant_id per supplier)
     ├── Step 19: py_eval → merge incumbent data into template
     └── Step 22: update WFA_SupplierRequest
                  (has_seeded_data=true, seeded_template_file_id)
```

---

## Standalone Page Events

```
🖱 WFA-01: Advance stage to started
 └── Step 1: STAGE → "Started"
     (Fired when supplier first opens their request)

🖱 WFA-02: Save worker entry
 ├── Step 1: get_records → WFA_SupplierRequest
 ├── Step 2: get_records → CFG_FormSlot
 ├── Step 3: get_records → RUN_ManualEntry
 ├── Step 4: py_eval → transform slot values to EAV rows
 └── (writes to RUN_ManualEntry, clears slot fields)
     (No outbound recipe calls — contained within page)
```

---

## Recipes Not in This Batch

Referenced by call targets but JSON not provided:

| Reference | Called by | Likely identity |
|-----------|-----------|-----------------|
| `R-002 Validate supplier input` | WFA-04 step 9, WFA-03 step 9 | V-01 (naming alias) |
| `R-006 Route results` | V-01 step 19 | V-02 (naming alias) |
| `C-01: Hydrate, generate, validate, publish` | B-01 step 12, B-02 step 13 | P-01 (naming alias) |
| `S-001: Onboard suppliers` | P-01 step 72 | P-03 (naming alias) |

These are naming aliases, not missing recipes. The display names in `dynamicPickListSelection.flow_id` differ from the export file names, but the `input.flow_id.zip_name` paths confirm they point to the same recipe files.

---

## Audit Findings Mapped to Call Paths

| Finding | Location in call path |
|---------|----------------------|
| CRIT-1: project_storage_path nil | B-02 step 11 (Pipeline 1, new request) |
| CRIT-2: workato_file_storage_path mismatch | B-01 step 12 → P-01 (Pipeline 1, config update) |
| CRIT-3: error_details vs python_error_details | B-01 step 3 (Pipeline 1, entry point) |
| HIGH-1: missing project_storage_path | WFA-03 step 9 → V-01 (Pipeline 3) |
| HIGH-2: incumbent_spit_config typo | WFA-05c → P-02b (Pipeline 4) |
| MED-1: ENV_FILE_STORAGE_ROOT re-derivation | WFA-04 step 3 (Pipeline 2) |
| MED-3: no stop after error | B-02 step 4 (Pipeline 1, new request) |
