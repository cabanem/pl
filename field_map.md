# SDC Platform — Field Lineage + Manifest Overlay (v2)

**Sources:** 15 recipe JSON exports + Data Table Manifest v4.0.0

**Legend:** ✅ covered · 🔇 orphaned (manifest only) · 👻 ghost (recipe only) · ⏸ skipped step

---

## CFG_ErrorTranslation (001_CFG_ErrorTranslation)
**Data collection** · Error code to supplier-facing message mapping.

**Read by:** V-01 Validate supplier input s7

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `error_code` | `string` **req** | P-01 Provision project s29 (B) | — |
| ✅ | `error_translation_id` | `string` **req** | P-01 Provision project s29 (B) | — |
| ✅ | `human_readable_message` | `string` **req** | P-01 Provision project s29 (B) | — |
| ✅ | `required_placeholders` | `string` **req** | P-01 Provision project s29 (B) | — |
| ✅ | `template_version_id` | `string` **req** | P-01 Provision project s29 (B) | V-01 Validate supplier input s7 |

---

## CFG_Field (001_CFG_Field)
**Data collection** · Column-level field definitions.

**Read by:** P-01 Provision project s34, V-01 Validate supplier input s4, V-02 Route validation results s6

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `column_unique` | `boolean` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `control_type` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `data_cleaning_flags` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `data_format` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `data_type` | `string` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `date_field_validation` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `depends_on` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `description` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `field_id` | `string` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `field_input_validation` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `field_length_validation` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `field_name` | `string` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `lookup_name` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `must_be_empty` | `boolean` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `numeric_field_validation` | `string` | P-01 Provision project s24 (B) | — |
| ✅ | `position` | `integer` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `required` | `boolean` **req** | P-01 Provision project s24 (B) | — |
| ✅ | `strict` | `boolean` | P-01 Provision project s24 (B) | — |
| ✅ | `template_version_id` | `string` **req** | P-01 Provision project s24 (B) | P-01 Provision project s34, V-01 Validate supplier input s4, V-02 Route validation results s6 |
| ✅ | `visible` | `boolean` | P-01 Provision project s24 (B) | — |

---

## CFG_FormSlot (001_CFG_FormSlot)
**Data collection** · WFA form layout definition.

**Read by:** P-03 Onboard suppliers s4, WFA-02 Save worker entry s2

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `control_type` | `string` | P-01 Provision project s30 (B) | — |
| ✅ | `field_id` | `string` | P-01 Provision project s30 (B) | — |
| ✅ | `field_name` | `string` | P-01 Provision project s30 (B) | — |
| ✅ | `form_slot_id` | `string` | P-01 Provision project s30 (B) | — |
| ✅ | `lookup_name` | `string` | P-01 Provision project s30 (B) | — |
| ✅ | `position` | `integer` | P-01 Provision project s30 (B) | — |
| ✅ | `required` | `boolean` | P-01 Provision project s30 (B) | — |
| ✅ | `slot_name` | `string` | P-01 Provision project s30 (B) | — |
| ✅ | `template_version_id` | `string` | P-01 Provision project s30 (B) | P-03 Onboard suppliers s4, WFA-02 Save worker entry s2 |

---

## CFG_Lookup (001_CFG_Lookup)
**Data collection** · Allowed-value lists for dropdowns.

**Read by:** P-01 Provision project s36, V-01 Validate supplier input s6

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `lookup_id` | `string` **req** | P-01 Provision project s28 (B) | — |
| ✅ | `lookup_name` | `string` **req** | P-01 Provision project s28 (B) | — |
| ✅ | `parent_value` | `string` | P-01 Provision project s28 (B) | — |
| ✅ | `project_specific` | `boolean` | P-01 Provision project s28 (B) | — |
| ✅ | `template_version_id` | `string` **req** | P-01 Provision project s28 (B) | P-01 Provision project s36, V-01 Validate supplier input s6 |
| ✅ | `valid_value` | `string` **req** | P-01 Provision project s28 (B) | — |

---

## CFG_Rule (001_CFG_Rule)
**Data collection** · Cross-field validation rules.

**Read by:** P-01 Provision project s35, V-01 Validate supplier input s5

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `condition_field` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `condition_field_id` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `conditional_value` | `string` | P-01 Provision project s26 (B) | — |
| ✅ | `error_message` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `error_message_custom` | `string` | P-01 Provision project s26 (B) | — |
| ✅ | `field_id` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `rule` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `rule_id` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `strict_enforcement` | `boolean` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `target_field` | `string` **req** | P-01 Provision project s26 (B) | — |
| ✅ | `template_version_id` | `string` **req** | P-01 Provision project s26 (B) | P-01 Provision project s35, V-01 Validate supplier input s5 |

---

## CFG_Variant (001_CFG_Variant, CFG_Variant)
**Data collection** · Named template variants.

**Read by:** P-01 Provision project s42, P-01 Provision project s50, P-01 Provision project s58, P-02b Seed incumbent data s14, P-02b Seed incumbent data s7, P-03 Onboard suppliers s9

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `description` | `string` | P-01 Provision project s32 (B) | — |
| ✅ | `template_file_id` | `string` | P-01 Provision project s51 (U) | — |
| ✅ | `template_version_id` | `string` **req** | P-01 Provision project s32 (B) | P-01 Provision project s42, P-01 Provision project s58, P-02b Seed incumbent data s7 |
| ✅ | `variant_id` | `string` **req** | P-01 Provision project s32 (B) | P-01 Provision project s50, P-02b Seed incumbent data s14, P-03 Onboard suppliers s9 |
| ✅ | `variant_name` | `string` **req** | P-01 Provision project s32 (B) | — |

---

## CFG_VariantField (001_CFG_VariantField)
**Data collection** · Junction table: fields per variant.

**Read by:** P-01 Provision project s43

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `field_id` | `string` **req** | P-01 Provision project s33 (B) | — |
| 👻 | `template_version_id` | — | — | P-01 Provision project s43 |
| ✅ | `variant_field_id` | `string` **req** | P-01 Provision project s33 (B) | — |
| ✅ | `variant_id` | `string` **req** | P-01 Provision project s33 (B) | — |

---

## HOME_Manifests
**Base** · Stores versioned snapshots of the data table schema.

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| 🔇 | `bundle_version` | `string` | — | — |
| 🔇 | `created_at` | `date_time` | — | — |
| 🔇 | `is_current` | `boolean` **req** | — | — |
| 🔇 | `manifest_hash` | `string` | — | — |
| 🔇 | `manifest_id` | `string` | — | — |
| 🔇 | `schema_version` | `string` | — | — |
| 🔇 | `snapshot_json` | `string [long]` | — | — |

---

## HOME_Requests (HOME_Requests)
**Base** · Inbound request log. One row per webhook invocation.

**Read by:** B-01 s5, B-02 s2

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `analyst_email` | `string` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | — |
| ✅ | `client_name` | `string` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | — |
| ✅ | `config_drive_file_id` | `string` | B-01 s7 (I), B-01 s11 (I) | B-01 s5 |
| ✅ | `correlation_id` | `string` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | — |
| ✅ | `created_at` | `date_time` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | — |
| ✅ | `error_message` | `string [long]` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U), B-02 s22 ⏸ (U) | — |
| ✅ | `manifest_id` | `string` | B-01 s11 (I) | — |
| ✅ | `project_id` | `string` | B-01 s11 (I) | — |
| ✅ | `request_id` | `string` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | B-02 s2 |
| ✅ | `separate_workspace_required` | `boolean` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | — |
| ✅ | `status` | `string` | B-01 s7 (I), B-01 s11 (I), B-02 s12 (U), B-02 s18 (U), B-02 s22 ⏸ (U) | B-01 s5 |
| ✅ | `target_vms` | `string` | B-01 s7 (I), B-01 s11 (I), B-02 s18 (U) | — |
| ✅ | `template_file_ids` | `string [long]` | B-01 s7 (I), B-01 s11 (I) | — |
| ✅ | `updated_at` | `date_time` | B-02 s12 (U) | — |
| ✅ | `workato_file_storage_paths` | `string` | B-01 s11 (I), B-02 s12 (U) | — |
| ✅ | `workspace_id` | `string` | B-01 s11 (I), B-02 s25 ⏸ (U) | — |

---

## HOME_WorkspaceRegistry (HOME_WorkspaceRegistry)
**Base** · Fleet inventory. Tracks workspace capacity and status.

**Read by:** B-02 s20 ⏸

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| 🔇 | `api_token_ref` | `string` | — | — |
| 🔇 | `capacity` | `integer` | — | — |
| 🔇 | `initialized_at` | `date_time` | — | — |
| ✅ | `project_count` | `integer` | B-02 s26 ⏸ (U) | — |
| 🔇 | `region` | `string` | — | — |
| ✅ | `status` | `string` | B-02 s26 ⏸ (U) | B-02 s20 ⏸ |
| 🔇 | `workspace_id` | `string` | — | — |
| 🔇 | `workspace_name` | `string` | — | — |

---

## MAIN_ProvisioningResults
**Base** · Pass-1 provisioning output map.

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| 🔇 | `correlation_id` | `string` | — | — |
| 🔇 | `schema_json` | `string` | — | — |
| 🔇 | `table_id` | `string` | — | — |
| 🔇 | `table_name` | `string` | — | — |

---

## RUN_FieldError (001_RUN_FieldError)
**Data collection** · Per-cell error detail.

**Read by:** V-02 Route validation results s5

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `error_message` | `string` **req** | V-01 Validate supplier input s17 (B) | — |
| ✅ | `field_error_id` | `string` **req** | V-01 Validate supplier input s17 (B) | — |
| ✅ | `field_id` | `string` **req** | V-01 Validate supplier input s17 (B) | — |
| ✅ | `row_number` | `integer` **req** | V-01 Validate supplier input s17 (B) | — |
| ✅ | `submitted_value` | `string` | V-01 Validate supplier input s17 (B) | — |
| ✅ | `validation_result_id` | `string` **req** | V-01 Validate supplier input s17 (B) | V-02 Route validation results s5 |

---

## RUN_ManualEntry (RUN_ManualEntry)
**Data collection** · EAV store for WFA form submissions.

**Read by:** WFA-02 Save worker entry s3, WFA-03 Submit manual input s2

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `field_id` | `string` | P-03 Onboard suppliers s16 (B), WFA-02 Save worker entry s6 (B) | — |
| ✅ | `field_name` | `string` | P-03 Onboard suppliers s16 (B), WFA-02 Save worker entry s6 (B) | — |
| ✅ | `manual_entry_id` | `string` | P-03 Onboard suppliers s16 (B), WFA-02 Save worker entry s6 (B) | — |
| ✅ | `row_number` | `integer` | P-03 Onboard suppliers s16 (B), WFA-02 Save worker entry s6 (B) | — |
| ✅ | `submitted_value` | `string` | WFA-02 Save worker entry s6 (B) | — |
| 👻 | `supplier_request_id` | — | — | WFA-02 Save worker entry s3, WFA-03 Submit manual input s2 |
| 👻 | `supplier_request_id Record ID` | — | P-03 Onboard suppliers s16 (B), WFA-02 Save worker entry s6 (B) | — |

---

## RUN_Upload (001_RUN_Upload)
**Data collection** · Upload event log.

**Read by:** V-01 Validate supplier input s2, V-02 Route validation results s2

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| 🔇 | `extracted_file_version_id` | `string` | — | — |
| ✅ | `status` | `string` **req** | WFA-03 Submit manual input s5 (I), WFA-04 Submit file upload s2 (I), WFA-04 Submit file upload s8 (U) | — |
| ✅ | `submitted_at` | `date_time` **req** | WFA-03 Submit manual input s5 (I), WFA-04 Submit file upload s2 (I) | — |
| ✅ | `submitted_file_id` | `string` | WFA-04 Submit file upload s8 (U) | — |
| ✅ | `supplier_request_id` | `string` **req** | WFA-03 Submit manual input s5 (I), WFA-04 Submit file upload s2 (I) | — |
| ✅ | `template_version_id` | `string` **req** | WFA-03 Submit manual input s5 (I), WFA-04 Submit file upload s2 (I) | — |
| ✅ | `upload_id` | `string` **req** | WFA-03 Submit manual input s5 (I), WFA-04 Submit file upload s2 (I) | V-01 Validate supplier input s2, V-02 Route validation results s2 |
| 🔇 | `valid_payload` | `string [long]` | — | — |

---

## RUN_ValidationResult (001_RUN_ValidationResult)
**Data collection** · Validation run summary.

**Read by:** V-02 Route validation results s1

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `completed_at` | `date_time` | V-01 Validate supplier input s15 (I) | — |
| ✅ | `invalid_rows` | `integer` | V-01 Validate supplier input s15 (I) | — |
| ✅ | `status` | `string` **req** | V-01 Validate supplier input s15 (I), V-01 Validate supplier input s18 (U) | — |
| ✅ | `template_version_id` | `string` **req** | V-01 Validate supplier input s15 (I) | — |
| ✅ | `upload_id` | `string` **req** | V-01 Validate supplier input s15 (I) | — |
| 🔇 | `valid_rows` | `integer` | — | — |
| ✅ | `validation_result_id` | `string` **req** | V-01 Validate supplier input s15 (I) | V-02 Route validation results s1 |

---

## VER_TemplateVersion (001_VER_TemplateVersion, VER_TemplateVersion)
**Data collection** · Immutable version snapshots.

**Read by:** P-01 Provision project s20, P-02b Seed incumbent data s8, P-03 Onboard suppliers s2, WFA-05c (Seed data page) Seed incumbent data s7

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| 🔇 | `manifest_id` | `string` | — | — |
| ✅ | `master_template_file_id` | `string` | P-01 Provision project s56 (U) | — |
| ✅ | `published_at` | `date_time` | P-01 Provision project s56 (U) | — |
| ✅ | `status` | `string` **req** | P-01 Provision project s22 (U), P-01 Provision project s23 (I), P-01 Provision project s39 (U), P-01 Provision project s56 (U) | P-01 Provision project s20, WFA-05c (Seed data page) Seed incumbent data s7 |
| ✅ | `template_project_id` | `string` **req** | P-01 Provision project s23 (I) | WFA-05c (Seed data page) Seed incumbent data s7 |
| ✅ | `template_version_id` | `string` **req** | P-01 Provision project s23 (I) | P-02b Seed incumbent data s8, P-03 Onboard suppliers s2 |
| ✅ | `validation_summary` | `string [long]` | P-01 Provision project s39 (U) | — |
| 🔇 | `version_label` | `string` | — | — |
| ✅ | `version_number` | `integer` **req** | P-01 Provision project s23 (I) | — |

---

## WFA_SupplierRequest (001_WFA_SupplierRequest, WFA_SupplierRequest)
**Data collection** · One row per supplier per project.

**Read by:** P-01 Provision project s63, P-02b Seed incumbent data s2, P-03 Onboard suppliers s1, V-01 Validate supplier input s3, V-02 Route validation results s3, WFA-02 Save worker entry s1, WFA-03 Submit manual input s1, WFA-04 Submit file upload s1, WFA-05b (Seed data page) Get data for page event (dropdown selection) s1

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `assigned_variant_id` | `string` | P-01 Provision project s60 (B) | — |
| ✅ | `assigned_version_id` | `string` **req** | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `assignee_email` | `string` **req** | P-01 Provision project s60 (B), P-01 Provision project s67 (B) | — |
| ✅ | `correlation_id` | `string` **req** | P-01 Provision project s60 (B), P-01 Provision project s67 (B) | — |
| 🔇 | `customer_name` | `string` | — | — |
| ✅ | `has_seeded_data` | `boolean` **req** | P-02b Seed incumbent data s22 (U), P-01 Provision project s60 (B), P-01 Provision project s67 (B) | P-02b Seed incumbent data s2, WFA-05b (Seed data page) Get data for page event (dropdown selection) s1 |
| ✅ | `last_updated_at` | `date_time` | P-03 Onboard suppliers s14 (U), V-02 Route validation results s9 (U), V-02 Route validation results s14 (U) | — |
| 🔇 | `latest_upload_file_id` | `string` | — | — |
| ✅ | `primary_user_email` | `string` | P-01 Provision project s60 (B) | — |
| ✅ | `seeded_data_file_id` | `string` | P-01 Provision project s60 (B) | — |
| ✅ | `seeded_template_file_id` | `string` | P-02b Seed incumbent data s22 (U) | — |
| ✅ | `slot_bool_01` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_bool_01_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_bool_02` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_bool_02_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_date_01` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_date_01_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_date_02` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_date_02_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_date_03` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_date_03_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_date_04` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_date_04_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_num_01` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_num_01_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_num_02` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_num_02_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_sel_01` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_sel_01_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_sel_02` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_sel_02_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_sel_03` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_sel_03_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_sel_04` | `string` | P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_sel_04_label` | `string` | P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_01` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_01_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_02` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_02_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_03` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_03_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_04` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_04_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_05` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_05_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_06` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_06_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_07` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_07_label` | `string` | P-01 Provision project s60 (B), P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `slot_text_08` | `string` | P-01 Provision project s65 (B), P-01 Provision project s67 (B), WFA-02 Save worker entry s7 ⏸ (U) | — |
| ✅ | `slot_text_08_label` | `string` | P-01 Provision project s65 (B), P-01 Provision project s67 (B) | — |
| ✅ | `status` | `string` **req** | P-01 Provision project s60 (B), P-01 Provision project s67 (B) | — |
| 👻 | `status_StateMachine` | — | P-03 Onboard suppliers s14 (U), V-02 Route validation results s9 (U), V-02 Route validation results s14 (U) | P-01 Provision project s63, P-03 Onboard suppliers s1 |
| ✅ | `supplier_name` | `string` **req** | P-01 Provision project s60 (B), P-01 Provision project s67 (B) | — |
| ✅ | `supplier_request_id` | `string` **req** | P-01 Provision project s60 (B), P-01 Provision project s67 (B) | V-01 Validate supplier input s3, V-02 Route validation results s3, WFA-02 Save worker entry s1, WFA-03 Submit manual input s1, WFA-04 Submit file upload s1 |
| ✅ | `template_file_id` | `string` | P-03 Onboard suppliers s14 (U) | — |
| ✅ | `template_project_id` | `string` | P-01 Provision project s60 (B) | P-01 Provision project s63, P-02b Seed incumbent data s2, P-03 Onboard suppliers s1, WFA-05b (Seed data page) Get data for page event (dropdown selection) s1 |
| 🔇 | `upload_from_ui` | `file` | — | — |

---

## WFA_SupplierUser (001_WFA_SupplierUser)
**Data collection** · Portal access control.

**Read by:** P-03 Onboard suppliers s17

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `contact_name` | `string` | P-01 Provision project s61 (B) | — |
| ✅ | `created_at` | `date_time` | P-01 Provision project s61 (B) | — |
| ✅ | `status` | `string` | P-01 Provision project s61 (B) | — |
| ✅ | `supplier_request_id` | `string` **req** | P-01 Provision project s61 (B) | P-03 Onboard suppliers s17 |
| ✅ | `supplier_user_id` | `string` **req** | P-01 Provision project s61 (B) | — |
| ✅ | `user_email` | `string` **req** | P-01 Provision project s61 (B) | — |

---

## WFA_TemplateProject (001_WFA_TemplateProject, WFA_TemplateProject)
**Data collection** · Top-level project record per client engagement.

**Read by:** P-01 Provision project s1, WFA-05a (Seed data page) Get data for project selector s1, WFA-05c (Seed data page) Seed incumbent data s2

| St | Field | Type | Writers | Filters |
|----|-------|------|---------|---------|
| ✅ | `analyst_email` | `string` | B-02 s11 (I) | — |
| ✅ | `config_file_id` | `string` | B-02 s11 (I) | — |
| ✅ | `correlation_id` | `string` **req** | B-02 s11 (I) | P-01 Provision project s1 |
| 🔇 | `incumbent_data_file_id` | `string` | — | — |
| 🔇 | `incumbent_split_config` | `string` | — | — |
| 🔇 | `output_drive_folder_id` | `string` | — | — |
| ✅ | `parsed_config_file_id` | `string` | P-01 Provision project s19 (U) | — |
| ✅ | `project_completion_status` | `string` | — | WFA-05a (Seed data page) Get data for project selector s1 |
| ✅ | `project_name` | `string` **req** | B-02 s11 (I) | — |
| ✅ | `project_storage_path` | `string` | B-02 s11 (I) | — |
| 🔇 | `reminder_days_1` | `integer` | — | — |
| ✅ | `target_vms` | `string` | B-02 s11 (I) | — |
| ✅ | `template_project_id` | `string` **req** | B-02 s11 (I) | WFA-05c (Seed data page) Seed incumbent data s2 |
| 🔇 | `variant_count` | `integer` | — | — |

---

## Summary

- **Covered (✅):** 176
- **Orphaned (🔇):** 30
- **Ghost (👻):** 4

### Orphaned Fields (🔇)
Fields in the manifest with no direct write or filter from these 15 recipes. Most are legitimately read as `get_records` output columns; some may be written by pass-2 recipes (R-00, provisioning) or by the WFA UI.

- **HOME_Manifests:** bundle_version, created_at, is_current, manifest_hash, manifest_id, schema_version, snapshot_json
- **HOME_WorkspaceRegistry:** api_token_ref, capacity, initialized_at, region, workspace_id, workspace_name
- **MAIN_ProvisioningResults:** correlation_id, schema_json, table_id, table_name
- **RUN_Upload:** extracted_file_version_id, valid_payload
- **RUN_ValidationResult:** valid_rows
- **VER_TemplateVersion:** manifest_id, version_label
- **WFA_SupplierRequest:** customer_name, latest_upload_file_id, upload_from_ui
- **WFA_TemplateProject:** incumbent_data_file_id, incumbent_split_config, output_drive_folder_id, reminder_days_1, variant_count

### Ghost Fields (👻)

- `CFG_VariantField.template_version_id`
- `RUN_ManualEntry.supplier_request_id`
- `RUN_ManualEntry.supplier_request_id Record ID`
- `WFA_SupplierRequest.status_StateMachine`
