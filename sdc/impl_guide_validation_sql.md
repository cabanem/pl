# SDC validation: Smart List build guide (production)

## Decisions applied

| # | Decision | Impact |
|---|---|---|
| 1 | Lookup column = `valid_value` (singular) | Used in Q2b lookup query |
| 2 | Dependent dropdown = implemented | Q2b lookup joins to parent field value via `depends_on_field_name` |
| 3 | Phase 1→2 gating = yes | Q2b adds `NOT EXISTS` against `presence_errors` per field |
| 4 | Strict flag = included | 6-column error contract: adds `strict` to every tier |

---

## Prerequisites: Python pre-parse output contract

The py_eval step that runs before the Smart List pipeline must output
these collections. Two fields are newly required — flagged with ⚠️.

### `enriched_fields` (fed to `fields` collection)

All existing columns plus:

| Column | Type | Notes |
|---|---|---|
| field_id | string | PK |
| field_name | string | Business key, join target for payload |
| required | string | `'true'` / `'false'` |
| must_be_empty | string | `'true'` / `'false'` |
| data_type | string | `string`, `integer`, `date`, `float (2)`, `boolean`, `none` |
| lookup_name | string | FK to lookups, nullable |
| column_unique | string | `'true'` / `'false'` |
| len_min | integer | Pre-parsed from `field_length_validation`, nullable |
| len_max | integer | Pre-parsed from `field_length_validation`, nullable |
| numeric_min | real | Pre-parsed from `numeric_field_validation`, nullable |
| numeric_max | real | Pre-parsed from `numeric_field_validation`, nullable |
| date_min | string | ISO-8601, pre-parsed from `date_field_validation`, nullable |
| date_max | string | ISO-8601, pre-parsed from `date_field_validation`, nullable |
| depends_on_field_name | string | ⚠️ Must be included — original field name string, not the FK. Used for dependent dropdown lookup join. |
| strict | string | ⚠️ Must be included as `'true'` / `'false'` string. Defaults to `'false'` if null. |

### `clean_rules` (fed to `rules` collection)

| Column | Type | Notes |
|---|---|---|
| field_id | string | FK to fields |
| rule | string | Error code key, e.g. `err_conditional_required` |
| error_message | string | Custom error message, nullable |
| condition_field | string | Field name of the condition field |
| conditional_value | string | Expected value for conditional rules, nullable |
| target_field | string | Field name of the target (same as field's field_name) |
| strict | string | ⚠️ `'true'` / `'false'`. Map from `strict_enforcement` if column name differs. |

### `clean_lookups` (fed to `lookups` collection)

| Column | Type | Notes |
|---|---|---|
| lookup_name | string | Groups valid values for a field |
| valid_value | string | One allowed value per row (singular, post-rename) |
| parent_lookup_value | string | ⚠️ Required for dependent dropdowns. The parent lookup value this child value belongs to. Nullable for non-dependent lookups. |

### `normalized_payload` (fed to `payload` collection)

| Column | Type |
|---|---|
| row_number | integer |
| field_name | string |
| submitted_value | string |

### `clean_errors` (fed to `errors` collection)

| Column | Type |
|---|---|
| error_code | string |
| human_readable_message | string |

### `precomputed_errors` (fed to `precomputed_errors` collection)

| Column | Type | Notes |
|---|---|---|
| row_number | integer | |
| field_id | string | |
| submitted_value | string | |
| error_message | string | Already resolved, not a code |
| strict | string | ⚠️ Must be included. From the field's `strict` value. |

---

## Standard error output contract

Every tier query outputs the same 6 columns. This is the schema you
define in each `query_list` action's output configuration.

| Column | Type | Notes |
|---|---|---|
| `row_number` | integer | Row in the supplier's file (header = 1, data starts at 2) |
| `field_id` | string | FK to CFG_Field |
| `submitted_value` | string | The value that failed, nullable for missing-field errors |
| `sql_error_code` | string | Machine-readable error code |
| `rule_error_message` | string | Custom message from CFG_Rule or precomputed, nullable |
| `strict` | string | `'true'` if row-rejecting, `'false'` if warning |

---

## Pipeline steps

### Step 1–6: Load collections (create_list)

Each step is a **Create list** action. Wire the list source to the
corresponding datapill from the Python pre-parse output.

| Step | Collection name | Source datapill | Index fields |
|---|---|---|---|
| 1 | `payload` | Python → `normalized_payload` | `row_number`, `field_name` |
| 2 | `fields` | Python → `enriched_fields` | `field_name`, `field_id` |
| 3 | `rules` | Python → `clean_rules` | `field_id`, `rule` |
| 4 | `lookups` | Python → `clean_lookups` | `lookup_name` |
| 5 | `errors` | Python → `clean_errors` | `error_code` |
| 6 | `precomputed_errors` | Python → `precomputed_errors` | `row_number` |

No SQL for these — just data loading. Each is inspectable in the job log.

---

### Step 7: Q1a — All rows (query_list)

**Input collections:** `payload`

```sql
SELECT DISTINCT row_number
FROM payload
```

**Output schema:**

| Field | Type |
|---|---|
| `row_number` | integer |

### Step 8: Load `all_rows` (create_list)

Source: Step 7 output. Index on: `row_number`.

---

### Step 9: Q1b — Base data (query_list)

**Input collections:** `payload`, `fields`

```sql
SELECT
    p.row_number,
    p.field_name,
    p.submitted_value,
    LOWER(TRIM(p.submitted_value))  AS norm_submitted_value,
    f.field_id,
    f.required,
    f.must_be_empty,
    f.data_type,
    f.lookup_name,
    f.column_unique,
    f.depends_on_field_name,
    f.strict,
    f.len_min,
    f.len_max,
    f.numeric_min,
    f.numeric_max,
    f.date_min,
    f.date_max
FROM payload p
INNER JOIN fields f
    ON p.field_name = f.field_name
```

**Output schema:**

| Field | Type |
|---|---|
| `row_number` | integer |
| `field_name` | string |
| `submitted_value` | string |
| `norm_submitted_value` | string |
| `field_id` | string |
| `required` | string |
| `must_be_empty` | string |
| `data_type` | string |
| `lookup_name` | string |
| `column_unique` | string |
| `depends_on_field_name` | string |
| `strict` | string |
| `len_min` | integer |
| `len_max` | integer |
| `numeric_min` | real |
| `numeric_max` | real |
| `date_min` | string |
| `date_max` | string |

**Debug check:** Row count should equal `payload` row count. If lower,
some payload field_names don't match any `fields.field_name` — likely a
column header mismatch in the supplier's file.

### Step 10: Load `base_data` (create_list)

Source: Step 9 output. Index on: `row_number`, `field_id`.

---

### Step 11: Q2a — Presence checks (query_list)

**Input collections:** `all_rows`, `fields`, `payload`, `base_data`

```sql
SELECT
    r.row_number,
    f.field_id,
    p.submitted_value,
    'err_required' AS sql_error_code,
    NULL AS rule_error_message,
    f.strict
FROM all_rows r
CROSS JOIN (
    SELECT field_id, field_name, strict
    FROM fields
    WHERE required = 'true'
) f
LEFT JOIN payload p
    ON r.row_number = p.row_number
   AND f.field_name = p.field_name
WHERE p.submitted_value IS NULL
   OR TRIM(p.submitted_value) = ''

UNION ALL

SELECT
    row_number,
    field_id,
    submitted_value,
    'err_must_be_empty' AS sql_error_code,
    NULL AS rule_error_message,
    strict
FROM base_data
WHERE must_be_empty = 'true'
  AND submitted_value IS NOT NULL
  AND TRIM(submitted_value) != ''
```

**Output schema:** Standard 6-column error contract.

**Debug check:** For a clean file this returns zero rows. Each row tells
you exactly which field on which row failed.

### Step 12: Load `presence_errors` (create_list)

Source: Step 11 output. Index on: `row_number`, `field_id`.

---

### Step 13: Q2b — Single-field constraints (query_list)

⚠️ **PHASE 1→2 GATING IS ACTIVE.** Every segment in this query includes
a `NOT EXISTS` check against `presence_errors`. This means: if a field
already failed `err_required` or `err_must_be_empty` for a given row, no
constraint errors are emitted for that same row+field combination. This
prevents noise like "field is required" AND "field length too short" on
the same blank cell. **Tell your team:** if they see a field with only an
`err_required` error and no length/lookup errors, that's by design — the
constraint checks were intentionally suppressed.

**Input collections:** `base_data`, `lookups`, `payload`, `presence_errors`

```sql
-- Lookup mismatch (with dependent dropdown support)
SELECT
    b.row_number,
    b.field_id,
    b.submitted_value,
    'err_lookup_mismatch' AS sql_error_code,
    NULL AS rule_error_message,
    b.strict
FROM base_data b
LEFT JOIN payload p_parent
    ON b.row_number = p_parent.row_number
   AND b.depends_on_field_name = p_parent.field_name
WHERE b.lookup_name IS NOT NULL
  AND b.submitted_value IS NOT NULL
  AND TRIM(b.submitted_value) != ''
  AND NOT EXISTS (
      SELECT 1
      FROM lookups l
      WHERE l.lookup_name = b.lookup_name
        AND LOWER(TRIM(l.valid_value)) = b.norm_submitted_value
        AND (
            b.depends_on_field_name IS NULL
            OR LOWER(TRIM(l.parent_lookup_value)) = LOWER(TRIM(p_parent.submitted_value))
        )
  )
  AND NOT EXISTS (
      SELECT 1 FROM presence_errors pe
      WHERE pe.row_number = b.row_number AND pe.field_id = b.field_id
  )

UNION ALL

-- Length constraint violation
SELECT
    b.row_number,
    b.field_id,
    b.submitted_value,
    'err_length_constraint' AS sql_error_code,
    NULL AS rule_error_message,
    b.strict
FROM base_data b
WHERE b.submitted_value IS NOT NULL
  AND TRIM(b.submitted_value) != ''
  AND (
      (b.len_min IS NOT NULL AND LENGTH(TRIM(b.submitted_value)) < b.len_min)
      OR
      (b.len_max IS NOT NULL AND LENGTH(TRIM(b.submitted_value)) > b.len_max)
  )
  AND NOT EXISTS (
      SELECT 1 FROM presence_errors pe
      WHERE pe.row_number = b.row_number AND pe.field_id = b.field_id
  )

UNION ALL

-- Numeric range violation
SELECT
    b.row_number,
    b.field_id,
    b.submitted_value,
    'err_value_range' AS sql_error_code,
    NULL AS rule_error_message,
    b.strict
FROM base_data b
WHERE b.submitted_value IS NOT NULL
  AND TRIM(b.submitted_value) != ''
  AND b.data_type IN ('integer', 'float (2)', 'currency', 'number')
  AND (
      (b.numeric_min IS NOT NULL AND CAST(b.submitted_value AS REAL) < b.numeric_min)
      OR
      (b.numeric_max IS NOT NULL AND CAST(b.submitted_value AS REAL) > b.numeric_max)
  )
  AND NOT EXISTS (
      SELECT 1 FROM presence_errors pe
      WHERE pe.row_number = b.row_number AND pe.field_id = b.field_id
  )

UNION ALL

-- Date range violation
SELECT
    b.row_number,
    b.field_id,
    b.submitted_value,
    'err_date_constraint' AS sql_error_code,
    NULL AS rule_error_message,
    b.strict
FROM base_data b
WHERE b.submitted_value IS NOT NULL
  AND TRIM(b.submitted_value) != ''
  AND b.data_type = 'date'
  AND (
      (b.date_min IS NOT NULL AND b.submitted_value < b.date_min)
      OR
      (b.date_max IS NOT NULL AND b.submitted_value > b.date_max)
  )
  AND NOT EXISTS (
      SELECT 1 FROM presence_errors pe
      WHERE pe.row_number = b.row_number AND pe.field_id = b.field_id
  )
```

**Output schema:** Standard 6-column error contract.

**Debug check:** If lookup errors fire unexpectedly, inspect the `lookups`
collection — confirm `valid_value` (singular) and `parent_lookup_value`
are populated correctly. For dependent dropdowns, also inspect `base_data`
to confirm `depends_on_field_name` is non-null for the dependent field.

### Step 14: Load `constraint_errors` (create_list)

Source: Step 13 output. Index on: `row_number`.

---

### Step 15: Q3a — Column unique duplicates (query_list)

**Input collections:** `base_data`

```sql
SELECT field_id, norm_submitted_value
FROM base_data
WHERE column_unique = 'true'
  AND submitted_value IS NOT NULL
  AND TRIM(submitted_value) != ''
GROUP BY field_id, norm_submitted_value
HAVING COUNT(*) > 1
```

**Output schema:**

| Field | Type |
|---|---|
| `field_id` | string |
| `norm_submitted_value` | string |

### Step 16: Load `column_unique_dupes` (create_list)

Source: Step 15 output. Index on: `field_id`, `norm_submitted_value`.

---

### Step 17: Q3b — Uniqueness errors (query_list)

**Input collections:** `base_data`, `column_unique_dupes`, `rules`, `payload`

```sql
-- Column uniqueness
SELECT
    b.row_number,
    b.field_id,
    b.submitted_value,
    'err_column_unique' AS sql_error_code,
    NULL AS rule_error_message,
    b.strict
FROM base_data b
INNER JOIN column_unique_dupes d
    ON b.field_id = d.field_id
   AND b.norm_submitted_value = d.norm_submitted_value
WHERE b.column_unique = 'true'
  AND b.submitted_value IS NOT NULL
  AND TRIM(b.submitted_value) != ''

UNION ALL

-- Composite uniqueness (from CFG_Rule)
SELECT
    cu.row_number,
    cu.field_id,
    cu.submitted_value,
    'err_composite_unique' AS sql_error_code,
    cu.rule_error_message,
    cu.strict
FROM (
    SELECT
        b.row_number,
        r.field_id,
        b.submitted_value,
        r.error_message AS rule_error_message,
        r.strict,
        COUNT(*) OVER (
            PARTITION BY r.field_id,
                         b.norm_submitted_value,
                         LOWER(TRIM(p_cond.submitted_value))
        ) AS dupe_count
    FROM base_data b
    INNER JOIN rules r
        ON b.field_id = r.field_id
       AND r.rule = 'err_composite_unique'
    INNER JOIN payload p_cond
        ON b.row_number = p_cond.row_number
       AND p_cond.field_name = r.condition_field
    WHERE b.submitted_value IS NOT NULL
      AND TRIM(b.submitted_value) != ''
) cu
WHERE cu.dupe_count > 1
```

**Output schema:** Standard 6-column error contract.

**Debug check:** `column_unique_dupes` (Step 16) should be empty for
clean data. If non-empty, each row tells you exactly which field has
duplicate values and what the duplicated value is.

### Step 18: Load `uniqueness_errors` (create_list)

Source: Step 17 output. Index on: `row_number`.

---

### Step 19: Q4 — Cross-field rules (query_list)

**Input collections:** `base_data`, `rules`, `payload`

```sql
-- Conditional required
SELECT
    b.row_number, b.field_id, b.submitted_value,
    'err_conditional_required' AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id AND r.rule = 'err_conditional_required'
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE LOWER(TRIM(p_cond.submitted_value)) = LOWER(TRIM(r.conditional_value))
  AND (b.submitted_value IS NULL OR TRIM(b.submitted_value) = '')

UNION ALL

-- Conditional empty
SELECT
    b.row_number, b.field_id, b.submitted_value,
    'err_conditional_empty' AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id AND r.rule = 'err_conditional_empty'
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE LOWER(TRIM(p_cond.submitted_value)) = LOWER(TRIM(r.conditional_value))
  AND b.submitted_value IS NOT NULL AND TRIM(b.submitted_value) != ''

UNION ALL

-- Mutually exclusive
SELECT
    b.row_number, b.field_id, b.submitted_value,
    'err_mutually_exclusive' AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id AND r.rule = 'err_mutually_exclusive'
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE b.submitted_value IS NOT NULL AND TRIM(b.submitted_value) != ''
  AND p_cond.submitted_value IS NOT NULL AND TRIM(p_cond.submitted_value) != ''

UNION ALL

-- At least one required
SELECT
    b.row_number, b.field_id, b.submitted_value,
    'err_require_one_of' AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id AND r.rule = 'err_require_one_of'
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE (b.submitted_value IS NULL OR TRIM(b.submitted_value) = '')
  AND (p_cond.submitted_value IS NULL OR TRIM(p_cond.submitted_value) = '')

UNION ALL

-- Must match
SELECT
    b.row_number, b.field_id, b.submitted_value,
    'err_must_match' AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id AND r.rule = 'err_must_match'
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE b.submitted_value IS NOT NULL AND TRIM(b.submitted_value) != ''
  AND p_cond.submitted_value IS NOT NULL AND TRIM(p_cond.submitted_value) != ''
  AND b.norm_submitted_value != LOWER(TRIM(p_cond.submitted_value))

UNION ALL

-- Must not match
SELECT
    b.row_number, b.field_id, b.submitted_value,
    'err_must_not_match' AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id AND r.rule = 'err_must_not_match'
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE b.submitted_value IS NOT NULL AND TRIM(b.submitted_value) != ''
  AND p_cond.submitted_value IS NOT NULL AND TRIM(p_cond.submitted_value) != ''
  AND b.norm_submitted_value = LOWER(TRIM(p_cond.submitted_value))

UNION ALL

-- Comparison operators (gt, gte, lt, lte)
SELECT
    b.row_number, b.field_id, b.submitted_value,
    r.rule AS sql_error_code,
    r.error_message AS rule_error_message,
    r.strict
FROM base_data b
INNER JOIN rules r
    ON b.field_id = r.field_id
   AND r.rule IN (
       'err_greater_than', 'err_greater_than_equal',
       'err_less_than', 'err_less_than_equal'
   )
INNER JOIN payload p_cond
    ON b.row_number = p_cond.row_number AND p_cond.field_name = r.condition_field
WHERE b.submitted_value IS NOT NULL AND TRIM(b.submitted_value) != ''
  AND p_cond.submitted_value IS NOT NULL AND TRIM(p_cond.submitted_value) != ''
  AND CASE r.rule
      WHEN 'err_greater_than'
          THEN CAST(b.submitted_value AS REAL) <= CAST(p_cond.submitted_value AS REAL)
      WHEN 'err_greater_than_equal'
          THEN CAST(b.submitted_value AS REAL) <  CAST(p_cond.submitted_value AS REAL)
      WHEN 'err_less_than'
          THEN CAST(b.submitted_value AS REAL) >= CAST(p_cond.submitted_value AS REAL)
      WHEN 'err_less_than_equal'
          THEN CAST(b.submitted_value AS REAL) >  CAST(p_cond.submitted_value AS REAL)
      ELSE 0
  END
```

**Output schema:** Standard 6-column error contract.

**Debug check:** If a cross-field rule doesn't fire, verify three things:
(a) `rules.rule` uses the `err_` prefix convention, (b) `rules.condition_field`
matches a `field_name` in the payload, (c) for conditional rules,
`rules.conditional_value` matches what the supplier actually submitted
(case-insensitive comparison is applied).

### Step 20: Load `cross_field_errors` (create_list)

Source: Step 19 output. Index on: `row_number`.

---

### Step 21: Q5a — Combine all errors (query_list)

**Input collections:** `presence_errors`, `constraint_errors`,
`uniqueness_errors`, `cross_field_errors`, `precomputed_errors`

```sql
SELECT row_number, field_id, submitted_value,
       sql_error_code, rule_error_message, strict
FROM presence_errors

UNION ALL

SELECT row_number, field_id, submitted_value,
       sql_error_code, rule_error_message, strict
FROM constraint_errors

UNION ALL

SELECT row_number, field_id, submitted_value,
       sql_error_code, rule_error_message, strict
FROM uniqueness_errors

UNION ALL

SELECT row_number, field_id, submitted_value,
       sql_error_code, rule_error_message, strict
FROM cross_field_errors

UNION ALL

SELECT row_number, field_id, submitted_value,
       'precomputed' AS sql_error_code,
       error_message AS rule_error_message,
       strict
FROM precomputed_errors

ORDER BY row_number ASC, field_id ASC
```

**Output schema:** Standard 6-column error contract.

### Step 22: Load `all_errors` (create_list)

Source: Step 21 output. Index on: `row_number`, `sql_error_code`.

---

### Step 23: Q5b — Translate and output (query_list)

**Input collections:** `all_errors`, `errors`

```sql
SELECT
    a.row_number,
    a.field_id,
    a.submitted_value,
    a.sql_error_code,
    COALESCE(
        a.rule_error_message,
        e.human_readable_message,
        a.sql_error_code
    ) AS error_message,
    a.strict
FROM all_errors a
LEFT JOIN errors e
    ON a.sql_error_code = e.error_code
ORDER BY
    a.row_number ASC,
    a.field_id ASC
```

**Output schema:**

| Field | Type | Notes |
|---|---|---|
| `row_number` | integer | |
| `field_id` | string | |
| `submitted_value` | string | |
| `sql_error_code` | string | Machine-readable, for logging/debugging |
| `error_message` | string | Human-readable, for supplier-facing report |
| `strict` | string | `'true'` = row rejected, `'false'` = warning only |

This is the **final output** consumed by the downstream recipe steps
(R-8 report generation, RUN_FieldError writes, RUN_ValidationResult).

### Step 24: Load `translated_errors` (create_list)

Source: Step 23 output. Index on: `row_number`.

This is the collection the recipe reads from after the pipeline completes.

---

## Summary: action count

| Steps | Type | Count |
|---|---|---|
| 1–6 | create_list (load source data) | 6 |
| 7–8 | query_list + create_list (all_rows) | 2 |
| 9–10 | query_list + create_list (base_data) | 2 |
| 11–12 | query_list + create_list (presence) | 2 |
| 13–14 | query_list + create_list (constraints) | 2 |
| 15–16 | query_list + create_list (unique dupes) | 2 |
| 17–18 | query_list + create_list (uniqueness errors) | 2 |
| 19–20 | query_list + create_list (cross-field) | 2 |
| 21–22 | query_list + create_list (combine) | 2 |
| 23–24 | query_list + create_list (translate) | 2 |
| **Total** | | **24 actions** |

---

## Team callout: Phase 1→2 gating behavior

**This is by design and should be communicated to the team.**

When a field fails a Phase 1 check (`err_required` or `err_must_be_empty`),
Phase 2 constraint checks (lookup, length, numeric range, date range) are
**suppressed** for that same row+field combination. This prevents
confusing error stacking like:

> ❌ "Worker Name is required"
> ❌ "Worker Name must be between 1 and 100 characters"

Instead the supplier sees only:

> ❌ "Worker Name is required"

The gating is per-field, not per-row. If Row 3 has "Worker Name" missing
and "Country" set to an invalid lookup value, both errors appear — the
gating only suppresses Country's constraint check if Country itself
failed a presence check.

Uniqueness (Q3) and cross-field rules (Q4) are **not gated** by Phase 1.
A blank required field will still trigger `err_conditional_required` if
a cross-field rule references it. This is intentional — cross-field rules
express business logic that may need to fire regardless of presence.

---

## Downstream usage: strict flag

After the pipeline completes, the downstream recipe can determine row
outcomes:

```
For each distinct row_number in translated_errors:
  If ANY error for that row has strict = 'true':
    → Row is REJECTED (excluded from valid_payload)
  Else:
    → Row is WARNING (included in valid_payload, errors reported)

Rows with zero errors:
  → Row is VALID
```

This replaces the current "all errors are rejections" behavior and
enables soft validation for advisory fields.
