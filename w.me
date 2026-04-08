# WFA Page Test — Mock Data Seed

**Goal:** Verify supplier can see their request and download a template.

---

## Prerequisite

Upload any test XLSX to FileStorage, then generate a shareable link (`workato_files.generate_shareable_link`, 10-day TTL). Paste the resulting URL into `template_file_id` in Table 3.

---

## Table 1: WFA_TemplateProject

| Field                  | Value                        | Notes                        |
|------------------------|------------------------------|------------------------------|
| template_project_id    | `tp-test-001`                | Business PK                  |
| project_name           | `Test Client`                |                              |
| analyst_email          | `your-email@company.com`     | Your email                   |
| target_vms             | `Fieldglass`                 | Or any value                 |
| correlation_id         | `corr-test-001`              | Ties back to HOME_Requests   |
| variant_count          | `0`                          | No variants for this test    |
| config_file_id         | *(leave blank)*              | Not needed for WFA test      |
| parsed_config_file_id  | *(leave blank)*              | Not needed for WFA test      |

---

## Table 2: VER_TemplateVersion

| Field                    | Value                        | Notes                        |
|--------------------------|------------------------------|------------------------------|
| template_version_id      | `tv-test-001`                | Business PK                  |
| template_project_id      | `tp-test-001`                | FK → Table 1                 |
| version_number           | `1`                          |                              |
| version_label            | `v1.0-test`                  |                              |
| status                   | `published`                  | Must be published            |
| master_template_file_id  | `/path/to/test.xlsx`         | FileStorage path of test XLSX|
| published_at             | `now`                        |                              |

---

## Table 3: WFA_SupplierRequest

| Field                  | Value                              | Notes                            |
|------------------------|------------------------------------|----------------------------------|
| supplier_request_id    | `sr-test-001`                      | Business PK                      |
| template_project_id    | `tp-test-001`                      | FK → Table 1                     |
| assigned_version_id    | `tv-test-001`                      | FK → Table 2                     |
| assigned_variant_id    | *(leave blank)*                    | No variant for this test         |
| correlation_id         | `corr-test-001`                    | Same as project                  |
| supplier_name          | `Acme Staffing`                    | Display name                     |
| contact_email          | `test-supplier@example.com`        | The email you'll log in with     |
| assignee_email         | `your-email@company.com`           | Analyst email                    |
| template_file_id       | `https://workato.com/fs/share/...` | Shareable link URL from prereq   |
| has_seeded_data        | `false`                            |                                  |
| status_StateMachine    | `sent`                             | Simulates post-onboarding state  |
| last_updated_at        | `now`                              |                                  |

---

## Table 4: WFA_SupplierUser

| Field                | Value                        | Notes                              |
|----------------------|------------------------------|------------------------------------|
| supplier_user_id     | `su-test-001`                | Business PK                        |
| supplier_request_id  | `sr-test-001`                | FK → Table 3                       |
| user_email           | `test-supplier@example.com`  | Must match contact_email in Table 3|
| contact_name         | `Test Supplier User`         |                                    |
| status               | `active`                     |                                    |
| created_at           | `now`                        |                                    |

---

## After Seeding

1. Invite `test-supplier@example.com` to the WFA portal via Platform → Workflow apps portal → Users and groups
2. Add them to the Supplier group (Member role)
3. Log in as that user
4. Verify: do you see the "Acme Staffing" request?
5. Click the download button — does the XLSX download?

If the Member can't see the request, that confirms `share_request` or `assign_task` is required in S-00.
