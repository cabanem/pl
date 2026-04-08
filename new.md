# Items 1–7: MVP to Correct Implementation

---

## Item 1: Connector — `parse_customer_sheet` column fix

The current parser reads labels from `row[0]` and values from `row[1]`.
Your spreadsheet has labels in column B (index 1) and values in column D
(index 3).

### Replace the entire `parse_customer_sheet` method:

```ruby
parse_customer_sheet: lambda do |sheets, cfg|
  sheet_name = cfg["sheet_name"]
  raw = sheets[sheet_name]
  return nil if raw.blank?

  # Build a flat lookup: label (col B, index 1) → value (col D, index 3)
  kv = {}
  (raw || []).each do |row|
    next if row.blank? || row.size < 4
    label = row[1].to_s.strip.downcase
    kv[label] = row[3] unless label.empty?
  end

  {
    "analyst_email"               => kv["analyst email address"].to_s.strip,
    "drive_folder_id"             => kv["where should we save the template (google drive folder id)?"].to_s.strip,
    "variant_count"               => (kv["how many variations are there of the template?"] || 0).to_i,
    "client_name"                 => kv["customer name"].to_s.strip,
    "target_vms"                  => kv["what is the target vendor management system (vms)?"].to_s.strip,
    "requires_separate_workspace" => call(:coerce_boolean, kv["is a separate workato workspace required?"]),
    "has_incumbent_data"          => call(:coerce_boolean, kv["did the customer provide incumbent data?"]),
    "single_incumbent_file"       => call(:coerce_boolean, kv["can we find the incumbent data in a single file?"]),
    "incumbent_file_id"           => kv["if located in a single file, please provide the file id."].to_s.strip.presence ||
                                     kv["if located in a single file, please provide the file id. \notherwise, provide it on the next tab."].to_s.strip.presence,
    "reminder_days_1"             => kv["from the initial request, how many days before we send the first reminder to each non-compliant supplier?"].to_s.strip.presence&.to_i,
    "reminder_days_2"             => kv["when should we send the second reminder?"].to_s.strip.presence&.to_i,
    "reminder_days_3"             => kv["when should we send a third reminder?"].to_s.strip.presence&.to_i
  }
end,
```

**Note on the incumbent_file_id label:** Row 14 contains a multi-line label
with a `\n` in the middle. The `.downcase` of the full label is:
`"if located in a single file, please provide the file id. \notherwise, provide it on the next tab."`
The `||` fallback handles both the clean and multi-line versions.

### Also update `customer_definition` in object_definitions:

Add the new `single_incumbent_file` field:

```ruby
customer_definition: {
  fields: lambda do |_connection, _config|
    [
      { name: "analyst_email",               type: "string" },
      { name: "drive_folder_id",             type: "string" },
      { name: "variant_count",               type: "integer" },
      { name: "client_name",                 type: "string" },
      { name: "target_vms",                  type: "string" },
      { name: "requires_separate_workspace", type: "boolean" },
      { name: "has_incumbent_data",          type: "boolean" },
      { name: "single_incumbent_file",       type: "boolean" },
      { name: "incumbent_file_id",           type: "string",  optional: true },
      { name: "reminder_days_1",             type: "integer", optional: true },
      { name: "reminder_days_2",             type: "integer", optional: true },
      { name: "reminder_days_3",             type: "integer", optional: true }
    ]
  end
},
```

### Test

After deploying, run C-01 and check Step 3 output → `customer`. Verify:
- `client_name` = "Test customer"
- `analyst_email` = your email
- `variant_count` = 1
- `has_incumbent_data` = false

---

## Item 2: Connector — supplier header fixes

In `parse_suppliers_sheet`, change two lines:

```ruby
# Old:
"seed_data_file_id" => raw["Seed data file ID"].to_s.strip.presence,
"seed_data_range"   => raw["Seed data range"].to_s.strip.presence

# New:
"seed_data_file_id" => raw["Location of incumbent data"].to_s.strip.presence,
"seed_data_range"   => raw["Incumbent data range"].to_s.strip.presence
```

### Also check the header row index

The default config says `header_row: 7, data_start_row: 8` for suppliers.
Your actual sheet has:
- Row 5: Definition row (`Def`, `Primary key (UUID)`, ...)
- Row 6: Hint row
- Row 7: **Actual headers** (`Supplier name`, `Has incumbent data?`, ...)
- Row 8: First data row

Row 7 (0-indexed) is correct. But the headers start at column C (index 2),
not column A. The `extract_sheet_rows` method reads headers from position 0,
so the first two columns map to empty-string keys. This works because none
of the parser's expected header names collide with `""`. But the connector
is silently ignoring the `_pk_suppliers_` column (UUID primary key) — which
is fine, C-01's Python generates its own UUIDs.

### Test

After deploying, run C-01 and check Step 3 output → `suppliers`. Verify:
- `supplier_name` = "Test supplier"
- `has_seeded_data` = false
- `seed_data_file_id` = null (for your test data)
- `seed_data_range` = null

---

## Item 3: C-01 Step 49 `raw_config` mapping fix

Step 49 (initial bootstrap Python) currently maps `raw_config` to the
Phase 2 Python output. That output contains `cfg_fields`, `cfg_rules`,
etc. — not `suppliers` or `users`. The Python does
`config.get("suppliers")` which returns None.

### Fix

Change the `raw_config` input mapping from:

```
=_dp('{"pill_type":"output","provider":"py_eval","line":"31a07068","path":["output"]}').to_json
```

To the connector's parse output:

```
=_dp('{"pill_type":"output","provider":"sdc_platform_connector_connector_500787859_1775117259","line":"08babb10","path":[]}').to_json
```

This gives the Python access to `config["suppliers"]` and `config["users"]`
from the connector output.

### Also verify the Python reads the right keys

The connector outputs supplier objects with these keys:
```json
{
  "supplier_name": "Test supplier",
  "has_seeded_data": false,
  "variant_name": "",
  "seed_data_file_id": null,
  "seed_data_range": null
}
```

And user objects:
```json
{
  "user_email": "supplier@test.com",
  "supplier_name": "Test supplier",
  "contact_name": "Test User"
}
```

Confirm Step 49's Python uses these exact keys when building the request
and user rows. If it uses different keys (from an older version), update
them.

### Test

After fixing, run C-01 with `is_initial = true`. Check:
- WFA_SupplierRequest has rows
- WFA_SupplierUser has rows
- `supplier_name`, `assignee_email`, `correlation_id` populated

---

## Item 4: Add `template_file_id` to CFG_Variant

Open `001_CFG_Variant` in Data Tables and add a new column:

| Column name       | Type       | Required | Hint                                   |
|-------------------|------------|----------|----------------------------------------|
| template_file_id  | short-text | false    | FileStorage ID of this variant's XLSX  |

Note the UUID assigned to this column — you'll need it for Item 5.

---

## Item 5: C-01 Phase 4 — stamp variant file IDs

Currently, Phase 4's repeat loop stores each XLSX to FileStorage (Step 41)
but doesn't persist the file ID. The file ID is available from Step 41's
output as `file_id`.

### Add a step inside the repeat's success branch (after Step 41, before Step 42)

**New step: Update CFG_Variant with template_file_id**

`Data tables` → `Update record`
**Table:** `001_CFG_Variant`

This step needs the CFG_Variant Record ID for the current variant. The
challenge: the repeat loop iterates over the Python payloads (Step 36
output), not over CFG_Variant records. The payloads contain `variant_id`
(the business PK) but not the Workato Record ID.

**Two approaches:**

**Approach A (simpler):** Use `get_records` inside the loop to find the
CFG_Variant row by `variant_id`, then update it.

Inside the repeat's success branch, after Step 41:

```
Step 41a: Get records → 001_CFG_Variant
  Filter: variant_id = {current_item} → variant_id
  Limit: 1

Step 41b: Update record → 001_CFG_Variant
  Record ID: Step 41a → Records → Record ID
  template_file_id: Step 41 → file_id
```

**Approach B:** Add `variant_id` to the Python payload output so you
can query by it. This is already there — the payload contains
`variant_id`. Use Approach A.

**For the no-variant case:** When `has_variants = false`, there's one
template stored as the base. Update `master_template_file_id` on
VER_TemplateVersion (Step 42 already does this in some form). No
CFG_Variant row to update.

### Also add `template_file_id` to WFA_SupplierRequest

Open `001_WFA_SupplierRequest` in Data Tables and add:

| Column name       | Type       | Required | Hint                                    |
|-------------------|------------|----------|-----------------------------------------|
| template_file_id  | short-text | false    | FileStorage ID of the template to serve |

Note the UUID — S-00 will write to it.

### Move Step 42 (publish) outside the repeat loop

Looking at your C-01, Step 42 (publish version) is currently INSIDE the
repeat's success IF block. That means it runs once per variant — and
only for variants where C-02 succeeded. It should run ONCE, after ALL
variants succeed.

Move Step 42 to after the generation failure check (after Step 45/46).
The step order should be:

```
38. REPEAT (for each payload)
39.   Call C-02
40.   IF success
41.     Store XLSX
41a.    Get CFG_Variant by variant_id
41b.    Update CFG_Variant (template_file_id)
43.   ELSE
44.     Set generation_status = failed
45. IF generation failed → return error
42. Update VER_TemplateVersion (status=published, published_at=now)   ← MOVED HERE
```

### Test

After fixing, run C-01 and check:
- CFG_Variant rows have `template_file_id` populated
- VER_TemplateVersion has `master_template_file_id` populated
- VER_TemplateVersion status = `published` (happens once, not per variant)

---

## Item 6: Minimal S-00 — Onboard suppliers

### Trigger — Callable

| Parameter            | Type    | Source                          |
|----------------------|---------|----------------------------------|
| template_version_id  | string  | C-01 Phase 5                    |
| template_project_id  | string  | WFA_TemplateProject              |
| correlation_id       | string  | Trigger passthrough              |

### Return schema

```json
[
  {"name": "onboarded_count", "type": "integer"},
  {"name": "status",          "type": "string"}
]
```

### Steps

**Step 1 — Get pending supplier requests**

`Data tables` → `Get records`
**Table:** `001_WFA_SupplierRequest`
**Filter:** `status_StateMachine` = `pending`
**Limit:** 500
**Alias:** `pending_suppliers`

**Step 2 — Get published version (for base template fallback)**

`Data tables` → `Get records`
**Table:** `001_VER_TemplateVersion`
**Filter:** `template_version_id` = Trigger → `template_version_id`
**Limit:** 1
**Alias:** `version_record`

**Step 3 — Declare variables**

| Variable         | Type    | Default |
|------------------|---------|---------|
| onboarded_count  | integer | 0       |

**Step 4 — REPEAT (for each pending supplier)**

Source: Step 1 → Records

**Step 5 (inside repeat) — Resolve template_file_id**

`IF` → `assigned_variant_id` is present:

**Step 5a — Get CFG_Variant**

`Data tables` → `Get records`
**Table:** `001_CFG_Variant`
**Filter:** `variant_id` = {current_item} → `assigned_variant_id`
**Limit:** 1

**Step 5b — Set template_file_id from variant**

Variable or formula: Step 5a → Records → `template_file_id`

**ELSE:**

**Step 5c — Set template_file_id from base**

Variable or formula: Step 2 → Records → `master_template_file_id`

**Step 6 — Update WFA_SupplierRequest**

`Data tables` → `Update record`
**Table:** `001_WFA_SupplierRequest`
**Record ID:** {current_item} → Record ID

| Column              | Map to                          |
|---------------------|---------------------------------|
| template_file_id    | Resolved file ID from Step 5    |
| status_StateMachine | `sent`                          |
| last_updated_at     | `=now`                          |

**Step 7 — Get users for this supplier**

`Data tables` → `Get records`
**Table:** `001_WFA_SupplierUser`
**Filter:** `supplier_request_id` = {current_item} → `supplier_request_id`
**Limit:** 100

**Step 8 — REPEAT (for each user)**

Source: Step 7 → Records

**Step 9 (inside user repeat) — Invite to WFA portal**

This depends on your WFA setup. Typically:
`Workflow Apps by Workato` → `Invite user`

| Parameter | Map to                              |
|-----------|-------------------------------------|
| email     | {current_user_item} → `user_email`  |
| app_id    | Your WFA app ID (hardcoded or from config) |

If `invite_user` isn't available as a native action, this may need
the Workato API connector to POST to the WFA invitation endpoint.
Check your existing R-5 for the exact action used.

End of user repeat.

**Step 10 — Send outreach email**

`Email` → `Send email`

| Field   | Map to                                                 |
|---------|--------------------------------------------------------|
| To      | {current_supplier} → `contact_email` (or first user's email) |
| Subject | `Your data collection template is ready`               |
| Body    | Include: client name, supplier name, portal link       |

**Step 11 — Increment counter**

Update variable `onboarded_count` = `onboarded_count + 1`

End of supplier repeat.

**Step 12 — Return result**

```
return_result: {
  onboarded_count: variable → onboarded_count,
  status: "complete"
}
```

### S-00 step map

```
Trigger: Callable (template_version_id, template_project_id, correlation_id)
│
├─ 1. Get WFA_SupplierRequest (status = pending)
├─ 2. Get VER_TemplateVersion (for base template fallback)
├─ 3. Declare variables
│
├─ REPEAT (each supplier)
│  ├─ 5. IF assigned_variant_id present
│  │  ├─ 5a. Get CFG_Variant → template_file_id
│  │  └─ ELSE → use master_template_file_id
│  ├─ 6. Update WFA_SupplierRequest (template_file_id, status → sent)
│  ├─ 7. Get WFA_SupplierUser for this supplier
│  ├─ REPEAT (each user)
│  │  └─ 9. Invite to WFA
│  ├─ 10. Send outreach email
│  └─ 11. Increment counter
│
└─ 12. Return {onboarded_count, status}
```

~12 steps. No Python.

---

## Item 7: Wire C-01 → S-00

Add `call_recipe_async` at the end of C-01, AFTER the Phase 6 IF/ELSE
block and BEFORE the final `return_result` (Step 58).

### New step: Call S-00 async

`Recipe functions` → `Call recipe (async)`
**Recipe:** `S-00 Onboard suppliers`

| S-00 parameter       | Map to                                            |
|----------------------|---------------------------------------------------|
| template_version_id  | Step 9 variable → `new_template_version_id`       |
| template_project_id  | Step 1 → Records → `template_project_id`          |
| correlation_id       | Trigger → `correlation_id`                        |

**Async, not sync.** C-01's job is done — it shouldn't wait for emails
to send. S-00 runs independently. If S-00 fails, it doesn't roll back
C-01's published version.

**Both paths need it.** The call goes after the Phase 6 IF/ELSE block
(after Step 51 for initial, after Step 57 for update). Since both paths
create new `pending` supplier rows, and S-00 queries for `status = pending`,
a single async call after the IF/ELSE handles both cases.

---

## Testing checklist (end-to-end)

### With connector fixes + Items 3–7:

- [ ] Fire webhook from GAS with test config
- [ ] B-01 routes to C-01 (config update path or directly via recipe test)
- [ ] C-01 Step 3: customer fields populated (client_name, analyst_email, variant_count)
- [ ] C-01 Step 3: supplier fields populated (supplier_name, has_seeded_data)
- [ ] C-01 Phase 2: CFG tables hydrated, CFG_Variant has template_file_id
- [ ] C-01 Phase 3: validation passes
- [ ] C-01 Phase 4: XLSX files stored, variant file IDs persisted
- [ ] C-01 Phase 5: version published (once, not per variant)
- [ ] C-01 Phase 6: WFA_SupplierRequest + WFA_SupplierUser rows created
- [ ] S-00: pending suppliers resolved to correct template_file_id
- [ ] S-00: users invited to WFA portal
- [ ] S-00: outreach email sent
- [ ] S-00: status = sent on all supplier requests
- [ ] Log in as test supplier → see template available for download
- [ ] Download template → correct columns, dropdowns, dependent dropdowns
- [ ] Upload filled template → S-01 logs → S-02 validates → results returned
