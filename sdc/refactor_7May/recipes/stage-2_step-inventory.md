# Workato Step Inventory — CFG-01, PRV-02, VAL-01

Step-by-step recipe layouts. Each follows the conventions: callable trigger with declared input schema, declared output schema, monitor-errors block invoking OBS-01, and explicit data table writes via the connector or Data Tables actions. Datapill references use Workato's `{{...}}` notation; field names match the data model v2 + naming-doc backports.

---

## CFG-01 — Validate config

**Recipe handle.** `CFG-01 Validate config`
**Folder.** `/CFG/Callables/`
**Trigger type.** New callable recipe (called by other recipes).

### Trigger input schema

```
config_drive_id        string   required
source_recipe          string   required
```

### Trigger result schema

```
verdict                object
  status                 string    pass | fail | structural_failure
  summary                object    optional
    field_count            integer
    lookup_count           integer
    rule_count             integer
    variant_count          integer
    supplier_count         integer
  errors                 array of object
    where                  string
    what                   string
    severity               string  warn | error
parsed_config          object    optional (null on structural_failure)
```

### Steps

```
[1]  variable: started_at = now()
     variable: recipe_handle = "CFG-01"

[2]  action: SDC Platform Connector → parse_config_file
     input.config_drive_id = {{trigger.config_drive_id}}
     [on error → step 3]

[3]  IF parse_config_file failed (catch block from step 2)
     [3a] return_result
          verdict.status = "structural_failure"
          verdict.summary = null
          verdict.errors = [{
            where: "config file",
            what: {{step_2_error.message}},
            severity: "error"
          }]
          parsed_config = null
     [exits recipe]

[4]  action: SDC Platform Connector → validate_config
     input.parsed_config = {{step_2.parsed_config}}
     [returns: status, errors[], summary]

[5]  variable: verdict_status =
       IF {{step_4.status}} == "valid" THEN "pass"
       ELSE "fail"

[6]  return_result
     verdict.status = {{variable.verdict_status}}
     verdict.summary.field_count = {{step_4.summary.field_count}}
     verdict.summary.lookup_count = {{step_4.summary.lookup_count}}
     verdict.summary.rule_count = {{step_4.summary.rule_count}}
     verdict.summary.variant_count = {{step_4.summary.variant_count}}
     verdict.summary.supplier_count = {{step_4.summary.supplier_count}}
     verdict.errors = {{step_4.errors}}
     parsed_config = {{step_2.parsed_config}}

# ---- monitor errors block (covers steps 1-6) ----
[M1] action: OBS-01 → emit
     severity = "error"
     source_recipe = "CFG-01"
     step_number = {{job.failed_step_number}}
     phase = "recipe_failed"
     human_message = "CFG-01 crashed: {{job.error.message}}"
     details_json = {{
       error_type: "pipeline",
       caller: {{trigger.source_recipe}},
       config_drive_id: {{trigger.config_drive_id}}
     }}.to_json

[M2] return_result
     verdict.status = "structural_failure"
     verdict.summary = null
     verdict.errors = [{
       where: "recipe execution",
       what: "Internal error during config validation. Please retry.",
       severity: "error"
     }]
     parsed_config = null
```

**Notes.**
- Step 3's catch is for the `structural_failure` case where `parse_config_file` throws (malformed JSON, Drive read error, missing required sheets). The connector's existing behavior covers this; the recipe just needs to receive the throw and shape the verdict.
- Step 4's `validate_config` is non-throwing for content-level issues — it returns `status: invalid` with errors. Step 5 maps the connector's enum (`valid` | `invalid`) into the recipe's enum (`pass` | `fail`) per the deep-dive verdict shape.
- The monitor-errors block emits `error_type: pipeline` per the working taxonomy. CFG-01's own "validation failed" return path (step 6 with `verdict.status = fail`) is not an error from CFG-01's perspective — it's a successful run that found problems. Only crashes go to OBS-01.

---

## PRV-02 — Build XLSX template

**Recipe handle.** `PRV-02 Build XLSX template`
**Folder.** `/PRV/Callables/`
**Trigger type.** New callable recipe.

### Trigger input schema

```
template_version_id    string   required
variant_id             string   optional   (null = base, all fields)
customer_name          string   required
variant_name           string   optional   (defaults to "base" or read from CFG_Variant)
```

### Trigger result schema

```
file_content           string   base64-encoded XLSX bytes
suggested_filename     string
metadata               object
  sheet_names            array of string
  byte_size              integer
  row_count              integer
  field_count            integer
```

### Steps

```
[1]  variable: started_at = now()
     variable: recipe_handle = "PRV-02"
     variable: resolved_variant_name =
       IF {{trigger.variant_id}} is null THEN "base"
       ELSE {{trigger.variant_name}}  # caller may pass it; if not, step 3 reads it

[2]  IF {{trigger.variant_id}} is not null AND {{trigger.variant_name}} is null
     [2a] action: Workato Data Tables → search rows
          table = CFG_Variant
          where: variant_id = {{trigger.variant_id}}
          [exit if 0 rows: this is a fail-loud case, see step 8]
     [2b] variable: resolved_variant_name = {{step_2a.records[0].variant_name}}

[3]  action: Workato Data Tables → search rows
     table = CFG_Field
     where: template_version_id = {{trigger.template_version_id}}
     order by: position ASC
     [returns: all fields for this version]

[4]  IF {{trigger.variant_id}} is not null
     [4a] action: Workato Data Tables → search rows
          table = CFG_VariantField
          where: variant_id = {{trigger.variant_id}}
     [4b] variable: included_field_ids = {{step_4a.records}}.map(r => r.field_id)
     [4c] variable: resolved_fields = {{step_3.records}}.filter(f =>
            {{variable.included_field_ids}}.includes(f.field_id))
     ELSE
     [4d] variable: resolved_fields = {{step_3.records}}

[5]  IF {{variable.resolved_fields}}.length == 0
     [5a] return_result with empty-variant fail
          (see step 8 for shape; reusing path)
     [exits recipe]

[6]  variable: needed_lookup_names =
       {{variable.resolved_fields}}.filter(f => f.lookup_name is not null)
                                   .map(f => f.lookup_name)
                                   .uniq()

[7]  IF {{variable.needed_lookup_names}}.length > 0
     [7a] action: Workato Data Tables → search rows
          table = CFG_Lookup
          where: template_version_id = {{trigger.template_version_id}}
                 AND lookup_name in {{variable.needed_lookup_names}}
     ELSE
     [7b] variable: lookups = []

[8]  action: Workato Data Tables → search rows
     table = CFG_ValidationRule
     where: template_version_id = {{trigger.template_version_id}}
            AND field_id in {{variable.resolved_fields}}.map(f => f.field_id)
     [returns: rules whose target field is in the resolved set]

[9]  action: Workato Data Tables → search rows
     table = CFG_ErrorMessage
     where: template_version_id = {{trigger.template_version_id}}
     [returns: all error messages for this version]

[10] action: Run Python script
     code: <PRV-02_build_workbook.py>
     input:
       fields           = {{variable.resolved_fields}}
       lookups          = {{step_7.records or step_7b.lookups}}
       rules            = {{step_8.records}}
       error_messages   = {{step_9.records}}
       customer_name    = {{trigger.customer_name}}
       variant_name     = {{variable.resolved_variant_name}}
     output:
       file_content       string  (base64)
       suggested_filename string
       metadata           object

[11] return_result
     file_content = {{step_10.file_content}}
     suggested_filename = {{step_10.suggested_filename}}
     metadata = {{step_10.metadata}}

# ---- empty-variant fail path (referenced from step 5) ----
[E1] action: OBS-01 → emit
     severity = "error"
     source_recipe = "PRV-02"
     step_number = 5
     phase = "recipe_failed"
     human_message = "PRV-02 invoked with a variant that resolves to zero fields"
     details_json = {{
       error_type: "configuration",
       template_version_id: {{trigger.template_version_id}},
       variant_id: {{trigger.variant_id}},
       resolved_field_count: 0
     }}.to_json
     supplier_request_id = null

[E2] (recipe halts via stop with error;
      caller's monitor-errors will receive the failure)

# ---- monitor errors block (covers steps 1-11) ----
[M1] action: OBS-01 → emit
     severity = "error"
     source_recipe = "PRV-02"
     step_number = {{job.failed_step_number}}
     phase = "recipe_failed"
     human_message = "PRV-02 crashed: {{job.error.message}}"
     details_json = {{
       error_type: "pipeline",
       template_version_id: {{trigger.template_version_id}},
       variant_id: {{trigger.variant_id}}
     }}.to_json

[M2] (recipe halts via stop with error)
```

**Python step (step 10) responsibilities** — substages 3–9 of the deep dive, in memory:

```python
def main(input):
    fields           = input['fields']
    lookups          = input['lookups']
    rules            = input['rules']
    error_messages   = input['error_messages']
    customer_name    = input['customer_name']
    variant_name     = input['variant_name']

    # Substage 3: lay out the reference sheet
    # - flat lookups: one column each
    # - dependent lookups: one column per parent value
    # - SHARED SANITIZATION FUNCTION used here AND in the INDIRECT formula step

    sanitize_for_named_range = build_sanitizer()  # ONE definition, used twice

    reference_layout = lay_out_reference_sheet(lookups, sanitize_for_named_range)

    # Substage 4: create workbook (openpyxl), two sheets

    # Substage 5: write data-entry header row (frozen, formatted)
    # Optional: header banner with customer_name, variant_name

    # Substage 6: write reference sheet content (lookup values per layout)

    # Substage 7: apply data validation rules
    # - flat dropdown: list-validation pointing at reference sheet column
    # - dependent dropdown: INDIRECT formula using sanitize_for_named_range
    #   (SAME function as substage 3 — invariant)
    # - type/format rules: per Field.data_type and Field.data_format

    # Substage 8: column-level formatting (widths, header style)

    # Substage 9: serialize to bytes, base64-encode

    file_content = base64.b64encode(serialized_bytes).decode('ascii')
    suggested_filename = f"{customer_name}_{variant_name}_{date}.xlsx"

    return {
        'file_content': file_content,
        'suggested_filename': suggested_filename,
        'metadata': {
            'sheet_names': ['Data Entry', 'Reference'],
            'byte_size': len(serialized_bytes),
            'row_count': 0,  # empty data area
            'field_count': len(fields)
        }
    }
```

**Notes.**
- Step 4 is the variant-filter branch. When `variant_id` is null, all fields from step 3 carry forward; when `variant_id` is provided, the field set is narrowed by joining `CFG_VariantField`. Workato Data Tables' search action returns rows; the filter happens in memory in step 4c.
- Step 5 implements the agreed empty-variant fail. A variant with zero resolved fields halts the recipe with an OBS-01 error event. The base case (`variant_id` null with at least one field defined for the version) does not hit step 5 unless the version itself has no fields, which is a config-validation error caught upstream.
- Step 7's lookup query is narrowed by `lookup_name in [...]` — only fetch lookups the resolved fields actually point at. Avoids loading lookups irrelevant to this variant.
- The Python step (step 10) is where the shared sanitization function lives, called from both the named-range step and the INDIRECT formula step. This is the build-time invariant that locks in the bug class P-02a shipped with.

---

## VAL-01 — Validate supplier input

**Recipe handle.** `VAL-01 Validate supplier input`
**Folder.** `/VAL/Callables/`
**Trigger type.** New callable recipe.

### Trigger input schema

```
submission_source      string   required   file_upload | manual_entry
supplier_request_id    string   required
upload_id              string   optional   (required when source = file_upload)
```

### Trigger result schema

```
verdict                object
  status                 string    pass | fail | structural_failure | pipeline_error
  summary                object
    valid_row_count        integer
    invalid_row_count      integer
    error_breakdown        object   optional
      by_category            object   optional
      by_field               object   optional
    structural_error_summary  string  optional  (set when status = structural_failure)
  errors                 array of object
    row                    integer
    field                  string
    category               string
    code                   string
    supplier_message       string
    severity               string  warn | error
validation_result_id   string
report_path            string   optional   (set when status = fail; null otherwise)
```

### Steps

```
[1]  variable: started_at = now()
     variable: recipe_handle = "VAL-01"

[2]  action: Workato Data Tables → search rows
     table = SUP_SupplierRequest
     where: supplier_request_id = {{trigger.supplier_request_id}}
     [returns one row; assigned_version_id is what we validate against]

[3]  variable: template_version_id = {{step_2.records[0].assigned_version_id}}
     variable: supplier_id = {{step_2.records[0].supplier_id}}

# ============== BRANCH: extract rows (R2 vs R3) ==============

[4]  IF {{trigger.submission_source}} == "file_upload"
     [4a] action: Workato Data Tables → search rows
          table = RUN_Upload
          where: upload_id = {{trigger.upload_id}}
     [4b] action: Workato Data Tables → update row
          table = RUN_Upload
          where: upload_id = {{trigger.upload_id}}
          set: status = "extracting"
     [4c] action: SDC Platform Connector → extract_xlsx_to_rows
          input.submitted_path = {{step_4a.records[0].submitted_path}}
          [on error → step 5: structural_failure path]
     [4d] action: Workato FileStorage → write file
          path = "/requests/{{variable.supplier_request_id}}/uploads/{{trigger.upload_id}}/extracted.json"
          content = {{step_4c.rows_json}}
     [4e] action: Workato Data Tables → update row
          table = RUN_Upload
          where: upload_id = {{trigger.upload_id}}
          set:
            extracted_path = {{step_4d.path}}
            status = "validating"
     [4f] variable: extracted_rows = {{step_4c.rows}}

     ELSE  # submission_source == "manual_entry"
     [4g] action: Workato Data Tables → search rows
          table = RUN_ManualEntry
          where: supplier_request_id = {{trigger.supplier_request_id}}
          order by: row_number ASC, field_id ASC
     [4h] variable: extracted_rows = transpose_eav_to_rows({{step_4g.records}})
          # Python step or formula: groups EAV rows by row_number,
          # produces array of {field_name: value} objects

# ============== STRUCTURAL FAILURE PATH (file_upload only, from 4c) ==============

[5]  IF step 4c failed (catch block)
     [5a] variable: structural_summary = {{step_4c_error.message}}
          # one-line: "missing required sheet 'WorkerData'", "file appears corrupted", etc.
     [5b] action: Workato Data Tables → update row
          table = RUN_Upload
          where: upload_id = {{trigger.upload_id}}
          set: status = "error"
     [5c] action: Workato Data Tables → create row
          table = RUN_ValidationResult
          fields:
            validation_result_id = {{uuid()}}
            upload_id = {{trigger.upload_id}}
            template_version_id = {{variable.template_version_id}}
            status = "error"
            valid_row_count = null
            invalid_row_count = null
            report_path = null
            completed_at = {{now()}}
     [5d] action: Workato Data Tables → create row
          table = RUN_FieldError
          fields:
            field_error_id = {{uuid()}}
            validation_result_id = {{step_5c.records[0].validation_result_id}}
            field_id = null
            row_number = null
            submitted_value = null
            error_message = {{variable.structural_summary}}
     [5e] action: Workato Data Tables → update row
          table = SUP_SupplierRequest
          where: supplier_request_id = {{trigger.supplier_request_id}}
          set:
            current_validation_result_id = {{step_5c.records[0].validation_result_id}}
            last_valid_row_count = null
            last_invalid_row_count = null
     [5f] return_result
          verdict.status = "structural_failure"
          verdict.summary.valid_row_count = null
          verdict.summary.invalid_row_count = null
          verdict.summary.structural_error_summary = {{variable.structural_summary}}
          verdict.errors = [{
            row: null, field: null, category: "structural",
            code: "structural_failure",
            supplier_message: {{variable.structural_summary}},
            severity: "error"
          }]
          validation_result_id = {{step_5c.records[0].validation_result_id}}
          report_path = null
     [exits recipe]

# ============== SHARED SPINE: empty gate, prior_values, validate ==============

[6]  IF {{variable.extracted_rows}}.length == 0
     [6a] (treat as a fail with one summary error: "submission contained no rows")
          # Composes a verdict with status = fail, single error
          # Falls through to the persist path at step 9
     ELSE
     [6b] continue

[7]  action: Workato Data Tables → search rows
     table = CFG_ValidationRule
     where: template_version_id = {{variable.template_version_id}}
            AND scope in ("supplier", "engagement")
     [returns: rules that need prior_values]

[8]  IF {{step_7.records}}.length > 0
     [8a] action: <Pre-fetch prior values>
          # For each scope-tagged rule, fetch prior submitted_value from
          # validated/approved prior submissions. The query joins:
          #   RUN_FieldError → RUN_ValidationResult (status = passed)
          #     → RUN_Upload → SUP_SupplierRequest
          # filtered by:
          #   - scope = "supplier": same supplier_id
          #   - scope = "engagement": all suppliers
          # AND SUP_SupplierRequest.status in ("pending_review", "approved")
          #
          # CRITICAL: filter to validated/approved prior submissions only.
          # Including failed prior attempts produces false-positive
          # uniqueness errors against the supplier's own rejected submissions.
          # (Pre-positioned test case from build queue.)
     [8b] variable: prior_values = {{step_8a.values_by_field}}
     ELSE
     [8c] variable: prior_values = {}

[9]  action: SDC Platform Connector → validate_upload
     input:
       template_version_id = {{variable.template_version_id}}
       rows                = {{variable.extracted_rows}}
       prior_values        = {{variable.prior_values}}
     [on error → step 10: pipeline_error path]
     [returns: status, summary, errors[], valid_payload_json]

# ============== PIPELINE ERROR PATH (engine crash, from step 9) ==============

[10] IF step 9 failed (catch block)
     [10a] action: OBS-01 → emit
           severity = "error"
           source_recipe = "VAL-01"
           step_number = 9
           phase = "recipe_failed"
           human_message = "validate_upload engine crashed: {{step_9_error.message}}"
           details_json = {{
             error_type: "pipeline",
             supplier_request_id: {{trigger.supplier_request_id}},
             upload_id: {{trigger.upload_id}}
           }}.to_json
           supplier_request_id = {{trigger.supplier_request_id}}
     [10b] IF {{trigger.submission_source}} == "file_upload"
           action: Workato Data Tables → update row
           table = RUN_Upload
           where: upload_id = {{trigger.upload_id}}
           set: status = "error"
     [10c] action: Workato Data Tables → create row
           table = RUN_ValidationResult
           fields:
             validation_result_id = {{uuid()}}
             upload_id = {{trigger.upload_id}}    # null for manual_entry
             template_version_id = {{variable.template_version_id}}
             status = "error"
             valid_row_count = null
             invalid_row_count = null
             report_path = null
             completed_at = {{now()}}
     [10d] return_result
           verdict.status = "pipeline_error"
           verdict.summary = {valid_row_count: null, invalid_row_count: null}
           verdict.errors = [{
             row: null, field: null, category: "pipeline",
             code: "engine_failure",
             supplier_message: "Internal error during validation. Analyst has been notified.",
             severity: "error"
           }]
           validation_result_id = {{step_10c.records[0].validation_result_id}}
           report_path = null
     [exits recipe]

# ============== HAPPY-PATH PERSIST (status = passed | failed) ==============

[11] variable: verdict_status =
       IF {{step_9.status}} == "passed" THEN "pass"
       ELSE "fail"

[12] action: Workato Data Tables → create row
     table = RUN_ValidationResult
     fields:
       validation_result_id = {{uuid()}}
       upload_id = {{trigger.upload_id}}    # null for manual_entry
       template_version_id = {{variable.template_version_id}}
       status = {{step_9.status}}            # "passed" or "failed"
       valid_row_count = {{step_9.summary.valid_row_count}}
       invalid_row_count = {{step_9.summary.invalid_row_count}}
       completed_at = {{now()}}

[13] IF {{step_9.errors}}.length > 0
     [13a] action: Workato Data Tables → batch create rows
           table = RUN_FieldError
           records: {{step_9.errors}}.map(e => ({
             field_error_id: {{uuid()}},
             validation_result_id: {{step_12.records[0].validation_result_id}},
             field_id: e.field_id,
             row_number: e.row_number,
             submitted_value: e.submitted_value,
             error_message: e.supplier_message
           }))

[14] IF {{variable.verdict_status}} == "fail"
     [14a] action: SDC Platform Connector → generate_validation_report
           input:
             template_version_id = {{variable.template_version_id}}
             errors = {{step_9.errors}}
             extracted_rows = {{variable.extracted_rows}}
     [14b] variable: report_path = "/requests/{{trigger.supplier_request_id}}/validations/{{step_12.records[0].validation_result_id}}/report.xlsx"
     [14c] action: Workato FileStorage → write file
           path = {{variable.report_path}}
           content = {{step_14a.file_content}}
     [14d] action: Workato Data Tables → update row
           table = RUN_ValidationResult
           where: validation_result_id = {{step_12.records[0].validation_result_id}}
           set: report_path = {{variable.report_path}}

[15] action: Workato Data Tables → update row
     table = SUP_SupplierRequest
     where: supplier_request_id = {{trigger.supplier_request_id}}
     set:
       current_validation_result_id = {{step_12.records[0].validation_result_id}}
       last_valid_row_count = {{step_9.summary.valid_row_count}}
       last_invalid_row_count = {{step_9.summary.invalid_row_count}}

[16] IF {{trigger.submission_source}} == "file_upload"
     action: Workato Data Tables → update row
     table = RUN_Upload
     where: upload_id = {{trigger.upload_id}}
     set: status = "validated"

[17] return_result
     verdict.status = {{variable.verdict_status}}
     verdict.summary.valid_row_count = {{step_9.summary.valid_row_count}}
     verdict.summary.invalid_row_count = {{step_9.summary.invalid_row_count}}
     verdict.summary.error_breakdown = {{step_9.summary.error_breakdown}}
     verdict.errors = {{step_9.errors}}
     validation_result_id = {{step_12.records[0].validation_result_id}}
     report_path = (verdict_status == "fail") ? {{variable.report_path}} : null

# ---- monitor errors block (covers all steps; pipeline-error path at step 10
#      handles validation engine crashes specifically) ----
[M1] action: OBS-01 → emit
     severity = "error"
     source_recipe = "VAL-01"
     step_number = {{job.failed_step_number}}
     phase = "recipe_failed"
     human_message = "VAL-01 crashed: {{job.error.message}}"
     details_json = {{
       error_type: "pipeline",
       supplier_request_id: {{trigger.supplier_request_id}},
       submission_source: {{trigger.submission_source}}
     }}.to_json
     supplier_request_id = {{trigger.supplier_request_id}}

[M2] (recipe halts via stop with error)
```

**Notes.**
- The recipe is structurally three paths through the same skeleton: structural_failure (steps 4c → 5), pipeline_error (step 9 → 10), and happy path (steps 11–17). Each owns its own persistence; no path leaves orphan rows.
- Step 4h (`transpose_eav_to_rows`) is a small Python step that takes EAV rows from `RUN_ManualEntry` and produces the same row-shaped form `validate_upload` expects from R2. V-01b's step 23 from the prior workspace is reference material.
- Step 8 (`prior_values` pre-fetch) is the resubmit-after-failure trap. The query has to filter to validated/approved prior submissions, not "any prior submission." This is the exact pre-positioned test case from the build queue.
- Step 14 (report generation) only runs on `fail` — `pass` doesn't need a report, and `structural_failure`/`pipeline_error` already exited before reaching here.
- Step 15 updates SupplierRequest's denormalized pointers regardless of pass/fail. `current_validation_result_id` always points at the latest result; `last_valid_row_count` and `last_invalid_row_count` mirror the result.
- VAL-01 does not write `SUP_SupplierRequest.status` anywhere. STS-01's exclusive domain. The caller (R2 or R3) reads VAL-01's verdict and invokes STS-01 with the appropriate trigger context.

---

## What's settled, what's open

**Settled by this draft:**
- Three recipes specified at step-level detail.
- Field names match data-model v2 + naming-doc backports.
- All three follow the conventions: callable trigger, declared schemas, monitor-errors block, OBS-01 for crashes only.
- VAL-01's three-path structure (structural_failure, pipeline_error, happy) with explicit persistence per path.
- The `prior_values` pre-fetch query semantics are documented inline with the trap warning.

**Open, flagged for build:**
- **`extract_xlsx_to_rows` connector action.** I assumed it exists or gets added — VAL-01 step 4c calls it. The current connector has `validate_upload` (which takes rows) but I'm not certain whether parsing the XLSX into rows is a connector responsibility or a separate Python step in the recipe. Worth confirming. If it's a Python step, the throw mechanics for structural failure are a little different (Python steps' error surface is different from connector actions').
- **`generate_validation_report` connector action.** Already exists in the carry-forward list per Triage v2. VAL-01 step 14a calls it; confirm the input shape matches what the action expects.
- **Step 8a's prior-values query mechanics.** I described the join in prose but didn't pick a concrete Workato action. Workato Data Tables' search action doesn't natively support multi-table joins, so this is likely a Python step doing two or three sequential searches and stitching them in memory. Worth pinning down at build.
- **Step 6a's empty-rows handling.** I sketched it as falling through to a fail verdict with one summary error, but didn't fully spec the persistence shape. Same shape as the structural-failure persist, probably, but with `status = failed` instead of `status = error` since the engine could in principle have run, just had nothing to run on. Worth confirming the right side of that line.
