# Workato Validation Recipe: Build Guide
## Starting From Zero

---

## Overview: What You're Building

A Workato recipe that:
1. Picks up a supplier CSV file
2. Loads your validation config from Lookup Tables
3. Pivots the data (wide → tall) so generic SQL can validate it
4. Runs Tier 1 (field-level), uniqueness, and Tier 2 (cross-field) validation
5. Outputs an error report CSV

The three config Lookup Tables (field_config, valid_values, field_rules) are the "brain." The recipe is the "engine." Once built, you change behavior by editing config — not the recipe.

---

## Prerequisites

Before you touch the recipe builder:

- [ ] You have access to a Workato workspace with **SQL Collection by Workato** connector enabled
- [ ] You have the **Lookup Tables by Workato** connector enabled
- [ ] You have **FileStorage by Workato** (or another file source — S3, SFTP, etc.) available
- [ ] You have the three CSV files ready to import (provided below)

---

## Phase 1: Create the Three Lookup Tables

This is your config layer. You're doing this *before* building the recipe.

### 1.1 — Create the `field_config` Lookup Table

**Navigation:** Tools → Lookup Tables → New Lookup Table

| Setting | Value |
|---|---|
| Table name | `field_config` |
| Key column | `field_name` |

**Add these columns** (all type: String unless noted):

```
field_name, display_name, position, data_type, is_required,
format_pattern, min_length, max_length, min_value, max_value,
max_decimal_places, date_format, date_max, date_window_days,
lookup_name, case_rule, no_control_chars, is_unique, error_message
```

> **Tip:** Workato will let you add columns one at a time in the UI, OR you can skip manual column creation and go straight to CSV import — the import will create columns from the header row.

**Import the data:** Once the table exists, click **Import CSV** and paste/upload this content:

```csv
field_name,display_name,position,data_type,is_required,format_pattern,min_length,max_length,min_value,max_value,max_decimal_places,date_format,date_max,date_window_days,lookup_name,case_rule,no_control_chars,is_unique,error_message
po_number,PO Number,1,text,true,PO-[0-9]*,,,,,,,,,,,true,Required unique PO number format PO-99999
line_number,Line Number,2,integer,true,,,,1,,,,,,,,,,Required positive integer
supplier_code,Supplier Code,3,text,true,,,,,,,,,,supplier_codes,upper,,,Required valid supplier code
ship_date,Ship Date,4,date,true,,,,,,,YYYY-MM-DD,TODAY,,,,,,Required date not in future
delivery_date,Delivery Date,5,date,true,,,,,,,YYYY-MM-DD,,,,,,,Required date
sku,SKU,6,text,true,,3,20,,,,,,,,,,Required 3-20 characters
description,Description,7,text,true,,,200,,,,,,,,,,Required max 200 chars
quantity,Quantity,8,integer,true,,,,1,,,,,,,,,,Required positive integer
unit_of_measure,UOM,9,text,true,,,,,,,,,uom_codes,,,,Required valid UOM
unit_price,Unit Price,10,currency,true,,,,0.01,,2,,,,,,,,Required positive with 2 decimals
line_total,Line Total,11,currency,true,,,,0.01,,2,,,,,,,,Required must equal qty x price
warehouse_code,Warehouse,12,text,true,,,,,,,,,warehouse_codes,,,,Required valid warehouse
carrier_code,Carrier,13,text,false,,,,,,,,,carrier_codes,,,,Valid carrier code
ship_method,Ship Method,14,text,true,,,,,,,,,ship_methods,,,,Required valid ship method
notes,Notes,15,text,false,,,500,,,,,,,,,true,,Max 500 chars no control chars
```

**Verify:** After import you should see 15 rows in the table preview.

---

### 1.2 — Create the `valid_values` Lookup Table

**Navigation:** Tools → Lookup Tables → New Lookup Table

| Setting | Value |
|---|---|
| Table name | `valid_values` |
| Key column | `lookup_name` |

> Note: Workato Lookup Tables require a unique key per row. Since multiple values share the same `lookup_name`, you'll need a **composite key** or a surrogate. Use `lookup_name` + `value` as a composite key if Workato supports it in your plan — otherwise add a surrogate `id` column (e.g., `supplier_codes_SUP001`).

**Import CSV:**

```csv
lookup_name,value,display_name,is_active
supplier_codes,SUP001,Acme Corp,true
supplier_codes,SUP002,Global Parts,true
supplier_codes,SUP003,FastShip Inc,true
uom_codes,EA,Each,true
uom_codes,CS,Case,true
uom_codes,PL,Pallet,true
uom_codes,KG,Kilogram,true
uom_codes,LB,Pound,true
warehouse_codes,WH-EAST,East Coast DC,true
warehouse_codes,WH-WEST,West Coast DC,true
warehouse_codes,WH-CENT,Central DC,true
carrier_codes,UPS,UPS,true
carrier_codes,FEDEX,FedEx,true
carrier_codes,FREIGHT01,ABC Freight,true
carrier_codes,FREIGHT02,XYZ Logistics,true
ship_methods,ground,Ground,true
ship_methods,express,Express,true
ship_methods,freight,Freight,true
ship_methods,air,Air,true
```

---

### 1.3 — Create the `field_rules` Lookup Table

**Navigation:** Tools → Lookup Tables → New Lookup Table

| Setting | Value |
|---|---|
| Table name | `field_rules` |
| Key column | `rule_id` |

**Import CSV:**

```csv
rule_id,target_field,rule_type,condition_field,condition_op,condition_value,param1,param2,error_message
R-001,delivery_date,compare_gt,ship_date,,,,,Delivery date must be after ship date
R-002,delivery_date,date_gap,ship_date,,,1,90,Delivery must be 1-90 days after ship date
R-003,carrier_code,conditional_required,ship_method,eq,freight,,,Carrier required when ship method is freight
R-004,line_total,equals_product,,,,"quantity,unit_price",0.01,Line total must equal quantity x unit price
```

**Verify:** 4 rows.

---

### 1.4 — Upload the Test CSV to FileStorage

**Navigation:** Tools → FileStorage → Upload file

Upload a file named `test_shipment.csv` with this content:

```csv
po_number,line_number,supplier_code,ship_date,delivery_date,sku,description,quantity,unit_of_measure,unit_price,line_total,warehouse_code,carrier_code,ship_method,notes
PO-10001,1,SUP001,2026-02-10,2026-02-15,WIDGET-A,Standard Widget,100,EA,5.00,500.00,WH-EAST,,ground,
PO-10002,2,SUP001,2026-02-10,2026-02-08,WIDGET-B,Premium Widget,50,EA,12.50,625.00,WH-EAST,,ground,
PO-10003,3,INVALID,2026-02-10,2026-02-20,AB,Short SKU Desc,0,XX,0.00,0.00,WH-FAKE,,freight,
PO-10004,4,SUP002,2026-13-45,2026-02-25,WIDGET-C,Another Widget,10,CS,25.00,250.01,WH-WEST,FEDEX,express,Has	a	tab
PO-10001,5,SUP003,2026-02-10,2027-02-10,WIDGET-D,Far Away Delivery,5,PL,100.00,500.00,WH-CENT,,air,
```

> The tab character in row 4's notes field is intentional — it should trigger a `control_chars` error. Make sure it doesn't get converted to spaces when you copy-paste.

---

## Phase 2: Build the Recipe

**Navigation:** Recipes → New Recipe

| Setting | Value |
|---|---|
| Recipe name | `Supplier File Validation - PoC` |
| Starting point | Build my own |

---

### Step 1 — Trigger: Scheduler (for PoC testing)

**Add trigger:** Scheduler by Workato → **Scheduled trigger**

| Setting | Value |
|---|---|
| Trigger on | Manually |

> This lets you click "Test recipe" and run it on demand. You'll swap this for a file-based trigger (new file in S3/SFTP) later — the rest of the recipe doesn't change.

---

### Step 2 — Get the Test File from FileStorage

**Add action:** FileStorage by Workato → **Get file contents**

| Setting | Value |
|---|---|
| File path | `/test_shipment.csv` (or wherever you uploaded it) |

**Name this step:** `Get test file`

This produces a `File contents` datapill you'll use in Step 4.

---

### Step 3 — Export the Three Lookup Tables

You need to pull your config data out of Lookup Tables and into a list format that SQL Collection can use. Do this with three sequential actions.

#### Step 3a — Get field_config

**Add action:** Lookup Tables by Workato → **Search entries**

| Setting | Value |
|---|---|
| Lookup table | `field_config` |
| Conditions | *(leave empty — fetch all rows)* |

**Name this step:** `Get field_config`

The output is a list of entries. The datapill will be something like `Get field_config > Entries`.

#### Step 3b — Get valid_values

**Add action:** Lookup Tables by Workato → **Search entries**

| Setting | Value |
|---|---|
| Lookup table | `valid_values` |
| Conditions | *(leave empty)* |

**Name this step:** `Get valid_values`

#### Step 3c — Get field_rules

**Add action:** Lookup Tables by Workato → **Search entries**

| Setting | Value |
|---|---|
| Lookup table | `field_rules` |
| Conditions | *(leave empty)* |

**Name this step:** `Get field_rules`

---

### Step 4 — Create SQL Collection Lists

SQL Collection is an in-memory SQLite database that lives for the duration of the recipe job. You need to load all four data sources (the file + three config tables) into it. Each "Create list" action is a separate step.

#### Step 4a — Load the supplier data file

**Add action:** SQL Collection by Workato → **Create list in SQL Collection from CSV**

| Setting | Value |
|---|---|
| CSV source | Datapill: `Get test file > File contents` |
| List name | `data` |
| Ignore CSV header row | Yes |
| Column delimiter | Comma |

> **Important:** The list name `data` is what you'll reference in every subsequent SQL query. Keep it exactly this.

#### Step 4b — Load field_config

**Add action:** SQL Collection by Workato → **Create list in SQL Collection**

| Setting | Value |
|---|---|
| List source | Datapill: `Get field_config > Entries` |
| List name | `field_config` |

#### Step 4c — Load valid_values

**Add action:** SQL Collection by Workato → **Create list in SQL Collection**

| Setting | Value |
|---|---|
| List source | Datapill: `Get valid_values > Entries` |
| List name | `valid_values` |

#### Step 4d — Load field_rules

**Add action:** SQL Collection by Workato → **Create list in SQL Collection**

| Setting | Value |
|---|---|
| List source | Datapill: `Get field_rules > Entries` |
| List name | `field_rules` |

> After these four steps you have a small in-memory database with four tables. All remaining steps just query it.

---

### Step 5 — Transpose: Wide → Tall

This is the architectural pivot that makes all the generic SQL work. Each row in `data` (15 columns) becomes 15 rows in `transposed` (one per field). You're trading width for length so the validation query can treat every field the same way.

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| Write to CSV | No |

**SQL:**

```sql
INSERT INTO transposed (row_number, field_name, value)
SELECT rowid, 'po_number',       po_number       FROM data UNION ALL
SELECT rowid, 'line_number',     line_number      FROM data UNION ALL
SELECT rowid, 'supplier_code',   supplier_code    FROM data UNION ALL
SELECT rowid, 'ship_date',       ship_date        FROM data UNION ALL
SELECT rowid, 'delivery_date',   delivery_date    FROM data UNION ALL
SELECT rowid, 'sku',             sku              FROM data UNION ALL
SELECT rowid, 'description',     description      FROM data UNION ALL
SELECT rowid, 'quantity',        quantity         FROM data UNION ALL
SELECT rowid, 'unit_of_measure', unit_of_measure  FROM data UNION ALL
SELECT rowid, 'unit_price',      unit_price       FROM data UNION ALL
SELECT rowid, 'line_total',      line_total       FROM data UNION ALL
SELECT rowid, 'warehouse_code',  warehouse_code   FROM data UNION ALL
SELECT rowid, 'carrier_code',    carrier_code     FROM data UNION ALL
SELECT rowid, 'ship_method',     ship_method      FROM data UNION ALL
SELECT rowid, 'notes',           notes            FROM data
```

> The `INSERT INTO transposed` syntax creates the `transposed` table implicitly — you don't need to define it separately. SQL Collection infers the schema from the INSERT.

> **For your real 300-column template:** this query would be 300 UNION ALL lines. You'd generate it dynamically in a formula step using the `field_config` list before this step runs. For the PoC, hardcoding all 15 is fine.

**Name this step:** `Transpose data`

---

### Step 6 — Tier 1: Field-Level Validation

This is the main validation query. It JOINs every value in `transposed` against its config row in `field_config` and tests each applicable rule. A row only appears in the output if it fails at least one check.

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| Write to CSV | No |
| Output list name | `tier1_errors` |

**Define the output schema** (Workato needs this to know what columns come back):

```
row_number (integer)
field_name (string)
submitted_value (string)
error_type (string)
error_message (string)
```

**SQL:**

```sql
SELECT
    t.row_number,
    t.field_name,
    t.value AS submitted_value,
    CASE
        WHEN fc.is_required = 'true'
         AND COALESCE(TRIM(t.value), '') = ''
        THEN 'required'

        WHEN fc.data_type = 'integer'
         AND t.value != ''
         AND t.value GLOB '*[^0-9-]*'
        THEN 'type_integer'

        WHEN fc.data_type IN ('currency', 'number')
         AND t.value != ''
         AND TYPEOF(CAST(t.value AS REAL)) NOT IN ('integer', 'real')
        THEN 'type_number'

        WHEN fc.data_type = 'date'
         AND t.value != ''
         AND t.value NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        THEN 'format_date'

        WHEN fc.date_max = 'TODAY'
         AND t.value != ''
         AND t.value > DATE('now')
        THEN 'date_future'

        WHEN fc.format_pattern IS NOT NULL
         AND fc.format_pattern != ''
         AND t.value != ''
         AND t.value NOT GLOB fc.format_pattern
        THEN 'format_pattern'

        WHEN fc.min_length IS NOT NULL
         AND fc.min_length != ''
         AND t.value != ''
         AND LENGTH(TRIM(t.value)) < CAST(fc.min_length AS INTEGER)
        THEN 'min_length'

        WHEN fc.max_length IS NOT NULL
         AND fc.max_length != ''
         AND t.value != ''
         AND LENGTH(TRIM(t.value)) > CAST(fc.max_length AS INTEGER)
        THEN 'max_length'

        WHEN fc.min_value IS NOT NULL
         AND fc.min_value != ''
         AND t.value != ''
         AND CAST(t.value AS REAL) < CAST(fc.min_value AS REAL)
        THEN 'below_min'

        WHEN fc.max_decimal_places IS NOT NULL
         AND fc.max_decimal_places != ''
         AND t.value != ''
         AND t.value LIKE '%.%'
         AND LENGTH(t.value) - INSTR(t.value, '.') > CAST(fc.max_decimal_places AS INTEGER)
        THEN 'decimal_precision'

        WHEN fc.lookup_name IS NOT NULL
         AND fc.lookup_name != ''
         AND t.value != ''
         AND NOT EXISTS (
            SELECT 1 FROM valid_values vv
            WHERE vv.lookup_name = fc.lookup_name
              AND vv.value = t.value
         )
        THEN 'lookup_invalid'

        WHEN fc.case_rule = 'upper'
         AND t.value != ''
         AND t.value != UPPER(t.value)
        THEN 'case_upper'

        WHEN fc.no_control_chars = 'true'
         AND t.value != ''
         AND (INSTR(t.value, CHAR(9)) > 0
           OR INSTR(t.value, CHAR(10)) > 0
           OR INSTR(t.value, CHAR(13)) > 0)
        THEN 'control_chars'

        ELSE NULL
    END AS error_type,
    fc.error_message

FROM transposed t
JOIN field_config fc ON t.field_name = fc.field_name
HAVING error_type IS NOT NULL
```

**Name this step:** `Tier 1 - Field validation`

---

### Step 7 — Uniqueness Check

A separate query because uniqueness requires comparing rows against each other — it can't be expressed as a single-row check in Step 6.

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| Write to CSV | No |
| Output list name | `uniqueness_errors` |
| Output schema | Same as Step 6 |

**SQL:**

```sql
SELECT
    t.row_number,
    t.field_name,
    t.value AS submitted_value,
    'duplicate' AS error_type,
    'Value must be unique within file' AS error_message
FROM transposed t
JOIN field_config fc ON t.field_name = fc.field_name
WHERE fc.is_unique = 'true'
  AND t.value != ''
  AND EXISTS (
    SELECT 1 FROM transposed t2
    WHERE t2.field_name = t.field_name
      AND t2.value = t.value
      AND t2.row_number != t.row_number
  )
```

**Name this step:** `Tier 1 - Uniqueness check`

---

### Step 8 — Tier 2: Cross-Field Rules

This query handles conditional required, date comparisons, and date gap checks. It uses a self-join on `transposed` to bring both fields (target + condition) onto the same row.

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| Write to CSV | No |
| Output list name | `tier2_errors` |
| Output schema | Same as Step 6 |

**SQL:**

```sql
SELECT
    t.row_number,
    t.field_name,
    t.value AS submitted_value,
    r.rule_type AS error_type,
    r.error_message
FROM transposed t
JOIN field_rules r ON t.field_name = r.target_field
LEFT JOIN transposed cond
    ON cond.row_number = t.row_number
   AND cond.field_name = r.condition_field
WHERE
    CASE r.rule_type

        WHEN 'conditional_required' THEN
            CASE r.condition_op
                WHEN 'eq' THEN cond.value = r.condition_value
            END
            AND COALESCE(TRIM(t.value), '') = ''

        WHEN 'compare_gt' THEN
            t.value != '' AND cond.value != ''
            AND t.value <= cond.value

        WHEN 'date_gap' THEN
            t.value != '' AND cond.value != ''
            AND (
                JULIANDAY(t.value) - JULIANDAY(cond.value) < CAST(r.param1 AS REAL)
                OR JULIANDAY(t.value) - JULIANDAY(cond.value) > CAST(r.param2 AS REAL)
            )

        ELSE 0
    END
```

**Name this step:** `Tier 2 - Cross-field rules`

---

### Step 9 — Tier 2: Arithmetic Check

The `equals_product` rule needs its own query because it JOINs three fields simultaneously (line_total, quantity, unit_price), which doesn't fit the generic two-field pattern of Step 8.

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| Write to CSV | No |
| Output list name | `arithmetic_errors` |
| Output schema | Same as Step 6 |

**SQL:**

```sql
SELECT
    t.row_number,
    'line_total' AS field_name,
    t.value AS submitted_value,
    'equals_product' AS error_type,
    r.error_message
FROM transposed t
JOIN field_rules r
    ON r.rule_type = 'equals_product'
   AND r.target_field = t.field_name
JOIN transposed qty
    ON qty.row_number = t.row_number
   AND qty.field_name = 'quantity'
JOIN transposed prc
    ON prc.row_number = t.row_number
   AND prc.field_name = 'unit_price'
WHERE t.field_name = 'line_total'
  AND t.value != ''
  AND qty.value != ''
  AND prc.value != ''
  AND ABS(
        CAST(t.value AS REAL) -
        (CAST(qty.value AS REAL) * CAST(prc.value AS REAL))
      ) > CAST(r.param2 AS REAL)
```

**Name this step:** `Tier 2 - Arithmetic check`

---

### Step 10 — Combine All Errors

Union all four error sets into a single sorted output and write it to CSV.

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| **Write to CSV** | **Yes** |
| Add CSV header | Yes |
| Column delimiter | Comma |
| Output variable | `error_report_csv` |

**SQL:**

```sql
SELECT * FROM tier1_errors
UNION ALL
SELECT * FROM uniqueness_errors
UNION ALL
SELECT * FROM tier2_errors
UNION ALL
SELECT * FROM arithmetic_errors
ORDER BY row_number, field_name
```

**Name this step:** `Combine all errors`

---

### Step 11 — Generate Summary Stats

**Add action:** SQL Collection by Workato → **Query list in SQL Collection**

| Setting | Value |
|---|---|
| SQL query | *(see below)* |
| Write to CSV | No |

**SQL:**

```sql
SELECT
    (SELECT COUNT(DISTINCT rowid) FROM data)                              AS total_rows,
    (SELECT COUNT(DISTINCT rowid) FROM data
     WHERE rowid NOT IN (
       SELECT DISTINCT row_number FROM tier1_errors
       UNION SELECT DISTINCT row_number FROM uniqueness_errors
       UNION SELECT DISTINCT row_number FROM tier2_errors
       UNION SELECT DISTINCT row_number FROM arithmetic_errors
     ))                                                                   AS valid_rows,
    (SELECT COUNT(DISTINCT row_number) FROM tier1_errors
     UNION ALL ...) -- simplify as needed                                 AS invalid_rows,
    (SELECT COUNT(*) FROM tier1_errors) +
    (SELECT COUNT(*) FROM uniqueness_errors) +
    (SELECT COUNT(*) FROM tier2_errors) +
    (SELECT COUNT(*) FROM arithmetic_errors)                              AS total_errors
```

> Workato SQL Collection doesn't support multi-statement scripts, so you may need to run this as 4 separate single-value queries and combine them using formula mode, or use a simpler version:

**Simplified version:**

```sql
SELECT
    COUNT(DISTINCT row_number) AS rows_with_errors
FROM (
    SELECT row_number FROM tier1_errors
    UNION ALL SELECT row_number FROM uniqueness_errors
    UNION ALL SELECT row_number FROM tier2_errors
    UNION ALL SELECT row_number FROM arithmetic_errors
)
```

**Name this step:** `Generate summary`

---

### Step 12 — Route: Pass or Fail

**Add action:** IF condition

**Condition:**
```
Generate summary > rows_with_errors  equals  0
```

#### If YES (validation passed):
- **Add action:** Logger by Workato → Log message: `"Validation passed. All rows clean."`
- *(Later: add downstream file delivery here)*

#### If NO (errors found):
- **Add action:** FileStorage by Workato → **Save file**
  - File path: `/validation_results/error_report_{{job_id}}.csv`
  - File contents: Datapill from `Combine all errors > CSV output`
- **Add action:** Logger → Log message: `"Validation failed. {{rows_with_errors}} rows have errors."`

**Name this step:** `Route results`

---

## Phase 3: Test

### Run the Recipe

1. Click **Test recipe** (top right in recipe builder)
2. The scheduler trigger fires immediately
3. Watch the job run step by step in the job log

### What to Expect

Check the job output for `Combine all errors` — you should get 14 errors matching this table:

| Row | Field | Error |
|---|---|---|
| 2 | delivery_date | compare_gt |
| 3 | supplier_code | lookup_invalid |
| 3 | sku | min_length |
| 3 | quantity | below_min |
| 3 | unit_of_measure | lookup_invalid |
| 3 | unit_price | below_min |
| 3 | line_total | below_min |
| 3 | warehouse_code | lookup_invalid |
| 3 | carrier_code | conditional_required |
| 4 | ship_date | format_date |
| 4 | line_total | equals_product |
| 4 | notes | control_chars |
| 5 | po_number | duplicate |
| 5 | delivery_date | date_gap |

**Summary:** 5 rows total, 1 valid, 4 invalid, 14 errors.

---

## Troubleshooting Common Issues

**SQL Collection can't find table `transposed`**
→ The INSERT in Step 5 creates the table implicitly. If it's not found in Step 6, the Step 5 query may have failed silently. Check the job log for Step 5 errors.

**Lookup table search returns empty**
→ The "Search entries" action with no conditions should return everything. Double-check your Lookup Table names match exactly (case-sensitive).

**`rowid` not available in `data` table**
→ SQL Collection assigns `rowid` automatically to every list. If queries against `data` fail on `rowid`, try `_row_number` — the exact column name varies slightly by Workato version.

**Errors from Step 6 appear for empty fields that should be skipped**
→ Most checks have an `AND t.value != ''` guard. If a required field is empty, only the `required` check fires. Non-required empty fields should produce no errors. Double-check your `is_required` values in `field_config`.

**Notes tab character not triggering control_chars**
→ The `CHAR(9)` check is correct for a real tab. If you copy-pasted the test CSV and the tab converted to spaces, the check won't fire. Use a hex editor or the Workato job log to confirm the character is present.

---

## What's Next After PoC

Once this runs correctly end-to-end:

1. **Swap the trigger** — replace Scheduler with your actual file source (S3 new file, SFTP new file, email attachment, etc.)
2. **Dynamic transpose** — replace the hardcoded 15-line UNION ALL with a formula step that generates it from `field_config` — making the recipe template-agnostic
3. **Template routing** — add a step that reads the filename or a header value to select which `field_config` to load, enabling multi-template support
4. **Error report delivery** — replace FileStorage save with email/Slack notification including the CSV attachment
5. **Promote to production** — move configs from test Lookup Tables to production, wire up real file sources
