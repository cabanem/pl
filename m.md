# SDC Platform — WFA Wiring Build Guide

**Date:** 2026-04-08
**Goal:** End-to-end supplier flow: webhook → onboard → portal → upload → validate → results

---

## Task 1: Create WFA App + Build Minimal Supplier Page

**Where:** Workato UI → Workflow Apps → Page Builder
**Time estimate:** 30–45 min
**Blocks:** Everything. Without this, suppliers see nothing.

### 1A. Create the Workflow App (if not already created)

1. Navigate to **Workflow Apps** in Workato
2. Create a new app in the `[WFA-001] Supplier data collection` project
3. Name it something like `Supplier Data Collection Portal`
4. Set WFA_SupplierRequest as the **primary data table** backing the app

### 1B. Configure a User Group

1. Create a user group called **`Supplier`**
   - This is what S-00 Step 14 (`invite_user`) references in `user_group_ids: ['Supplier']`
2. Assign the **Member** role to this group (NOT Manager)
   - Members can only see requests they created or are **assigned to**
   - Managers see all requests (use this for the analyst group)
3. No data filter needed — visibility scoping is built into Workato's native role model
   - The `create_request` action in S-00 (Task 3) is what assigns a request to a supplier
   - That assignment is what makes the request visible to the supplier when they log in

### 1C. Build the Minimal Supplier Page

The page is backed by WFA_SupplierRequest. You need **three functional components** for MVP:

#### Component 1: Status Display (read-only)

| Setting          | Value                                          |
|------------------|------------------------------------------------|
| Source field      | `status_StateMachine` (UUID: `eee9bd1f-3ca7-427f-9f29-19735b1d905e`) |
| Display as        | Read-only text or badge                        |
| Purpose           | Shows the supplier where they are: `sent` → `in_progress` → `validated` / `supplier_action_required` |

#### Component 2: Template Download (Button → Open Webpage)

| Setting          | Value                                          |
|------------------|------------------------------------------------|
| Component type    | **Button**                                     |
| Action            | **Open webpage**                               |
| URL source        | `template_file_id` (UUID: `fcb89b24-697c-45e7-8952-441e02d3347e`) |
| Button label      | "Download Template" or similar                 |
| Purpose           | Opens the FileStorage shareable link in-browser; supplier downloads XLSX |

This field holds a **shareable FileStorage URL** (not a raw file ID).
S-00 generates this URL via `generate_shareable_link` with a 10-day TTL.
The link never appears in outreach emails — suppliers must authenticate
into the portal first, then click the button. If the link expires before
the supplier acts, the future reminder workflow (Workflow 7) will
regenerate the link and re-stamp it on WFA_SupplierRequest.

#### Component 3: File Upload

| Setting          | Value                                          |
|------------------|------------------------------------------------|
| Target field      | `file_upload` (UUID: `5f0d230b-4d61-46c5-b07c-58932e559843`) |
| Component type    | File upload                                    |
| On submit         | Fires WFA trigger → R-6                       |
| Trigger parameter | `supplier_completed_file` maps to this upload  |
| Also pass         | `supplier_request_id` (UUID: `98922f09-130c-47f9-8a4f-8be13524861a`) |

#### Nice-to-have display fields (not required for MVP, but helpful)

| Field              | UUID                                           | Display as    |
|--------------------|------------------------------------------------|---------------|
| `supplier_name`    | `81eb50d6-3764-465b-8df7-afa36098b2dd`         | Page title / heading |
| `contact_email`    | `a2065722-9987-447e-aefb-bf720c1276a1`         | Read-only text |

### 1D. Wire the Page Trigger to R-6

The file upload component's submit action should fire the WFA trigger (`app_function_generic_request`) that R-6 listens on. In the page builder:

- On submit → call recipe function
- Pass `supplier_request_id` from the request context
- Pass `supplier_completed_file` from the upload component

R-6's trigger is already configured to receive these two parameters.

### 1E. Note the App ID

After creating the app, record the **App ID** — you'll need it for S-00's `create_request` action (Task 3).

---

## Task 2: Fix S-00 Step 10 — record_id Datapill

**Where:** S-00 recipe editor → Step 10 (Update WFA_SupplierRequest)
**Time estimate:** 5 min
**Blocks:** Onboarding. Without this fix, the update targets the wrong record.

### The Bug

Step 10 updates WFA_SupplierRequest, but its `record_id` input pulls from:

```
provider:  "workato_db_table"
line:      "ddebfe4c"            ← Step 6: Get CFG_Variant
path:      ["records", {current_item}, "11fbe9a6_a16d_4d7e_86ea_afe42ec03005"]
```

This is the Record ID of the **CFG_Variant row**, not the WFA_SupplierRequest row.
Additionally, Step 6 only runs inside the IF branch (variant present).
When the ELSE fires, this datapill is null or stale.

### The Fix

Re-map `record_id` to pull from the **foreach iterator** (Step 4):

```
provider:  "foreach"
line:      "d568a68e"            ← Step 4: foreach over pending suppliers
path:      ["11fbe9a6_a16d_4d7e_86ea_afe42ec03005"]
```

**In the recipe editor:**

1. Click into Step 10
2. Clear the Record ID field
3. From the datapill tree: **Step 4 (foreach) → current item → Record ID**
4. Drop it in

**Verification:** The datapill should match the same pattern used in Step 5's IF condition and Step 11's filter — both correctly reference `d568a68e` (the foreach).

### Also: Add `generate_shareable_link` Step Before Step 10

Insert a new step between the variant/base resolution (Steps 5–9) and Step 10:

| Setting           | Value / Source                                 |
|-------------------|------------------------------------------------|
| Action            | `workato_files.generate_shareable_link`         |
| File path         | Variable `current_template_file_id` (from Step 7 or 9) |
| Duration          | `10` days                                      |

This produces a temporary authenticated download URL. Then in Step 10,
map `template_file_id` to the **shareable link URL output** from this step
(instead of the raw FileStorage path). The supplier's portal button opens
this URL to download their XLSX.

---

## Task 3: Add `create_request` to S-00

**Where:** S-00 recipe editor → new step between current Step 10 and Step 11
**Time estimate:** 20 min
**Blocks:** Supplier portal experience. Without this, suppliers log in and see an empty portal.

### Why This Is Needed

`invite_user` (Step 14) grants portal *access* — the supplier can log in.
`create_request` creates the actual *task/request* the supplier sees when they log in.
Without it, the supplier authenticates but has no request context, no data, no page content.

### New Step: Create Request

Insert **after** Step 10 (update WFA_SupplierRequest) and **before** Step 11 (get users):

| Setting           | Value / Source                                 |
|-------------------|------------------------------------------------|
| Action            | `workato_workflow_task.create_request`          |
| App               | Your WFA app (from Task 1E)                    |

**Field mappings for the request:**

| Request Field     | Map To                                         | Source Datapill |
|-------------------|------------------------------------------------|-----------------|
| Assignee          | `contact_email` from foreach                   | foreach `d568a68e` → `a2065722_9987_447e_aefb_bf720c1276a1` |
| Request data      | The WFA_SupplierRequest row context             | (see note below) |

**Note on request data:** The exact fields you pass into `create_request` depend on how the page components are wired. At minimum, the request needs to carry the `supplier_request_id` so the page can resolve which WFA_SupplierRequest row to display. The page builder binds components to columns on WFA_SupplierRequest; `create_request` is what ties a specific *row* to a specific *user's task*.

**Important:** Check what input fields `create_request` exposes in the recipe editor — it may auto-populate from the backing data table schema, or it may need explicit field mapping. The exact schema depends on how the page was configured in Task 1.

### Error Handling

Wrap in try/catch (same pattern as `invite_user` at Step 14):

- **Catch:** If request already exists, swallow the error
- This makes the recipe idempotent — re-running S-00 won't create duplicate requests

---

## Task 4: Map R-6 Steps 2 & 4

**Where:** R-6 recipe editor
**Time estimate:** 15 min
**Blocks:** Validation chain. Without these mappings, R-7 has no upload context.

### R-6 Context

R-6 fires when the WFA trigger detects a supplier file upload.

```
Trigger → Step 1 (get WFA_SupplierRequest) → Step 2 (create RUN_Upload) →
Step 3 (store file) → Step 4 (update RUN_Upload) → Step 5 (call R-7 async)
```

Steps 2 and 4 currently have `parameters: {}` — empty.

### Step 2: Create RUN_Upload Row

**Action:** `workato_db_table.add_record`
**Table:** `001_RUN_Upload`

| Column                   | UUID                                           | Value / Source                                |
|--------------------------|-------------------------------------------------|-----------------------------------------------|
| `upload_id`              | `4fddb53e-6b7e-4ed9-8a34-1568e2c2c7e8`         | Generate UUID (formula: `=uuid`)              |
| `supplier_request_id`    | `2ff2e349-2022-44cd-83a7-3cf620d707ed`         | Trigger → `supplier_request_id`               |
| `template_version_id`    | `32f07cf8-950c-4468-a8dc-8933202d90d6`         | Step 1 (`09805e23`) → `assigned_version_id` (UUID: `fe1703bb-6423-44dd-998e-2673cb108493`) |
| `status`                 | `1bd6ca28-b75c-4d9a-8fbf-655e5ea263ed`         | Static string: `received`                     |
| `submitted_at`           | `62bcdf09-631c-4324-baac-05382ea055e6`         | `=now`                                        |

**Datapill sources:**

- Trigger (`supplier_request_id`): `provider: workato_workflow_task, line: bbf8bf3b, path: [parameters, supplier_request_id]`
- Step 1 result (`assigned_version_id`): `provider: workato_db_table, line: 09805e23, path: [records, {current_item}, fe1703bb_6423_44dd_998e_2673cb108493]`

### Step 4: Update RUN_Upload After File Storage

**Action:** `workato_db_table.update_record`
**Table:** `001_RUN_Upload`
**Record ID:** Step 2 output → Record ID (`provider: workato_db_table, line: 5eac9012, path: [record, 11fbe9a6_a16d_4d7e_86ea_afe42ec03005]`)

| Column                   | UUID                                           | Value / Source                                |
|--------------------------|-------------------------------------------------|-----------------------------------------------|
| `submitted_file_id`      | `a036abdb-6369-41d0-aeae-08b0b440b0f5`         | Step 3 (`5cc549cb`) → file path/ID from FileStorage output |
| `status`                 | `1bd6ca28-b75c-4d9a-8fbf-655e5ea263ed`         | Static string: `validating`                   |

**Note on Step 3's output:** The `store_file` action returns a file path. Check the exact datapill path in the recipe editor — it's typically something like `provider: workato_files, line: 5cc549cb, path: [file_path]` or `[file_id]`.

### Verify Step 5 (Call R-7)

Step 5 already maps `upload_id` and `file_id` to R-7. Confirm these datapills still resolve correctly after you populate Steps 2 and 4:

- `upload_id` should come from Step 2's output (the business key `upload_id`, not the Record ID)
- `file_id` should come from Step 3's FileStorage output

---

## Task 5: Map R-8 Steps 9 & 12

**Where:** R-8 recipe editor
**Time estimate:** 10 min
**Blocks:** Status advancement. Without these, supplier status never changes after validation.

### R-8 Context

R-8 routes validation results. The IF branch handles failures, the ELSE handles success.

```
Steps 1-3: Context hydration (RUN_ValidationResult → RUN_Upload → WFA_SupplierRequest)
Step 4: IF status = "invalid"
  Steps 5-10: failure path
ELSE
  Steps 12-14: success path
```

Both status update steps have `parameters: {}`.

### Step 9: Update Status — Validation Failed

**Action:** `workato_db_table.update_record`
**Table:** `001_WFA_SupplierRequest`
**Record ID:** Already mapped correctly — pulls from Step 3 (`152e3055`) → WFA_SupplierRequest Record ID

| Column                   | UUID                                           | Value                                         |
|--------------------------|-------------------------------------------------|-----------------------------------------------|
| `status_StateMachine`    | `eee9bd1f-3ca7-427f-9f29-19735b1d905e`         | Static string: `supplier_action_required`     |
| `last_updated_at`        | `705a457d-eaf6-407d-b772-b3b9bc0cbdff`         | `=now`                                        |

### Step 12: Update Status — Validation Passed

**Action:** `workato_db_table.update_record`
**Table:** `001_WFA_SupplierRequest`
**Record ID:** Already mapped correctly — same source as Step 9

| Column                   | UUID                                           | Value                                         |
|--------------------------|-------------------------------------------------|-----------------------------------------------|
| `status_StateMachine`    | `eee9bd1f-3ca7-427f-9f29-19735b1d905e`         | Static string: `validated`                    |
| `last_updated_at`        | `705a457d-eaf6-407d-b772-b3b9bc0cbdff`         | `=now`                                        |

---

## Smoke Test Checklist

After completing Tasks 1–5, run through this sequence:

1. **Fire webhook from GAS** — click "Start supplier data collection" in the config spreadsheet
2. **Watch B-01 job log** — confirm payload validates and routes to B-02
3. **Watch C-01 job log** — confirm all 6 phases complete:
   - Parse config ✓
   - Hydrate tables ✓
   - Validate referential integrity ✓
   - Generate XLSX templates ✓
   - Publish version ✓
   - Bootstrap suppliers ✓
4. **Watch S-00 job log** — confirm:
   - Pending suppliers found
   - Template file IDs resolved (variant or base)
   - WFA_SupplierRequest updated (template_file_id, status → sent)
   - WFA request created (new step)
   - Users invited to portal
   - Emails sent
5. **Log in as test supplier** — use the email from a WFA_SupplierUser row
6. **Verify portal** — supplier should see:
   - Their request with status "sent"
   - A download link for the template
   - An upload component for submitting the filled template
7. **Download template** — confirm it's the correct XLSX
8. **Upload filled template** — submit through the portal
9. **Watch R-6 job log** — confirm:
   - RUN_Upload row created with correct fields
   - File stored to FileStorage
   - RUN_Upload updated with file ID and status "validating"
   - R-7 called async
10. **Watch R-7 job log** — confirm validation runs against config
11. **Watch R-8 job log** — confirm:
    - Status updated on WFA_SupplierRequest (validated or supplier_action_required)
12. **Check portal again** — status should reflect validation result

---

## Quick Reference: Key Aliases

| Alias        | Recipe | Step | What It Is                          |
|--------------|--------|------|-------------------------------------|
| `d568a68e`   | S-00   | 4    | Foreach over pending suppliers      |
| `ddebfe4c`   | S-00   | 6    | Get CFG_Variant (inside IF)         |
| `86aafdfb`   | S-00   | 3    | Declared variables                  |
| `b67b2bc3`   | S-00   | 2    | Get VER_TemplateVersion             |
| `cf0c31aa`   | S-00   | 1    | Get pending WFA_SupplierRequests    |
| `09805e23`   | R-6    | 1    | Get WFA_SupplierRequest             |
| `5eac9012`   | R-6    | 2    | Add RUN_Upload record               |
| `5cc549cb`   | R-6    | 3    | Store file to FileStorage           |
| `5f7b3d79`   | R-8    | 1    | Get RUN_ValidationResult            |
| `d6501d34`   | R-8    | 2    | Get RUN_Upload                      |
| `152e3055`   | R-8    | 3    | Get WFA_SupplierRequest             |

## Quick Reference: Key Field UUIDs (WFA_SupplierRequest)

| Field                  | UUID                                           |
|------------------------|------------------------------------------------|
| Record ID              | `11fbe9a6-a16d-4d7e-86ea-afe42ec03005`         |
| supplier_request_id    | `98922f09-130c-47f9-8a4f-8be13524861a`         |
| template_project_id    | `e8286f04-94b0-497e-b39c-e55040402a52`         |
| assigned_version_id    | `fe1703bb-6423-44dd-998e-2673cb108493`         |
| assigned_variant_id    | `aad154f7-5108-4baa-8334-587c47d0d71c`         |
| correlation_id         | `c1c6edb9-c08e-44d9-84a8-7e2083358d28`         |
| supplier_name          | `81eb50d6-3764-465b-8df7-afa36098b2dd`         |
| contact_email          | `a2065722-9987-447e-aefb-bf720c1276a1`         |
| assignee_email         | `a1ca04b2-1dfd-4e3b-aa55-f11efdffd477`         |
| template_file_id       | `fcb89b24-697c-45e7-8952-441e02d3347e`         |
| has_seeded_data        | `c2f57493-fd3b-4bb8-baee-51fa6dbaf53f`         |
| file_upload            | `5f0d230b-4d61-46c5-b07c-58932e559843`         |
| status_StateMachine    | `eee9bd1f-3ca7-427f-9f29-19735b1d905e`         |
| last_updated_at        | `705a457d-eaf6-407d-b772-b3b9bc0cbdff`         |

## Quick Reference: Key Field UUIDs (RUN_Upload)

| Field                    | UUID                                           |
|--------------------------|------------------------------------------------|
| Record ID                | `11fbe9a6-a16d-4d7e-86ea-afe42ec03005`         |
| upload_id                | `4fddb53e-6b7e-4ed9-8a34-1568e2c2c7e8`         |
| supplier_request_id      | `2ff2e349-2022-44cd-83a7-3cf620d707ed`         |
| template_version_id      | `32f07cf8-950c-4468-a8dc-8933202d90d6`         |
| submitted_file_id        | `a036abdb-6369-41d0-aeae-08b0b440b0f5`         |
| extracted_file_version_id| `c76db493-6676-4ae4-8bbd-55b1a092a8aa`         |
| valid_payload            | `88f8b771-33a9-4322-9b0b-859751b600da`         |
| status                   | `1bd6ca28-b75c-4d9a-8fbf-655e5ea263ed`         |
| submitted_at             | `62bcdf09-631c-4324-baac-05382ea055e6`         |
