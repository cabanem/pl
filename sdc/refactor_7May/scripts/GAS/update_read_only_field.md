# Change set: supplier read-only field flag

**Goal:** add a field-level boolean to `4_fields` indicating whether a field is
read-only on the supplier side. The flag is a **field property** —
variant-independent, the same wherever the field appears — and is orthogonal to
`7_form`'s "Visible?" flag.

**Design summary**
- New column lives in `4_fields`, **to the right** of the existing attribute
  columns (so `FIELD_NAME_COL` / col C and the PK column / col B keep their
  indices).
- A derived envelope map `_field_supplier_readonly: { fieldName: bool }` is
  emitted alongside the existing `_field_visibility`, in both the base config
  and each variant config.
- Blank cell ⇒ `false` (via `Util.coerceTruthy`), so existing fields default to
  editable. No backfill required; the change is backward-compatible.
- The connector reads the derived map; the WFA portal renders matching fields
  locked. (Those two are outside this library and not covered here.)

**Edit count:** 5 sites across 4 files.

---

## 1. `003_Schema.js` — add the column constant

Add `SUPPLIER_READONLY_COL` to `FIELDS_LAYOUT`.

> ⚠️ **You must set the index.** It is the **0-indexed** position of the new
> column. If the new column is the Nth column (1-indexed) in `4_fields`, the
> value here is `N - 1`. Example below assumes the new column is column J
> (10th column ⇒ index 9) — **change `9` to your actual position.**

**Before**
```js
var FIELDS_LAYOUT = Object.freeze({
  HEADER_ROW:     7,  // 0-indexed, this is row 8
  DATA_START:     8,  // row 9
  FIELD_NAME_COL: 2   // column C - "Field name"

});
```

**After**
```js
var FIELDS_LAYOUT = Object.freeze({
  HEADER_ROW:            7,  // 0-indexed, this is row 8
  DATA_START:            8,  // row 9
  FIELD_NAME_COL:        2,  // column C - "Field name"
  SUPPLIER_READONLY_COL: 9   // <-- SET ME. 0-indexed col of the new read-only flag.
                             //     Must be RIGHT of existing attribute columns.
});
```

> Because this edits Schema.gs, the schema version bumps (see edit 5).

---

## 2. `001_Drive.js` — add the derived-map builder

Add `Drive.buildFieldReadonlyMap`, structurally a sibling of
`Drive.buildFieldVisibilityMap` but reading `4_fields` / `FIELDS_LAYOUT`
instead of `7_form` / `FORM_LAYOUT`. Place it directly after
`buildFieldVisibilityMap`.

**Add**
```js
/**
 * Build the {fieldName: supplierReadonly} map from 4_fields data.
 *
 * Field property, NOT a per-variant setting: the value is read off the field's
 * own row, so it is identical wherever the field appears. Sibling to
 * buildFieldVisibilityMap; emitted as _field_supplier_readonly.
 *
 * Blank / unrecognized cell -> false (field is editable). Existing fields with
 * no value in the new column therefore default to editable with no backfill.
 *
 * Public so Variant.gs can rebuild it from a filtered 4_fields slice.
 */
Drive.buildFieldReadonlyMap = function(fieldsData) {
  var map = {};
  for (var i = FIELDS_LAYOUT.DATA_START; i < fieldsData.length; i++) {
    var fieldName = String(fieldsData[i][FIELDS_LAYOUT.FIELD_NAME_COL] || '').trim();
    if (fieldName === '') continue;
    map[fieldName] = Util.coerceTruthy(fieldsData[i][FIELDS_LAYOUT.SUPPLIER_READONLY_COL]);
  }
  return map;
};
```

**Optional (doc accuracy):** update the file-header comment block so the
public-API list and envelope-shape sketch mention the new pieces.

```js
 *   Drive.buildFieldVisibilityMap(formData)      -> { fieldName: bool }
 *   Drive.buildFieldReadonlyMap(fieldsData)      -> { fieldName: bool }   // <-- add
```
```js
 *     _field_visibility: { fieldName: bool, ... },
 *     _field_supplier_readonly: { fieldName: bool, ... },                 // <-- add
```

---

## 3. `001_Drive.js` — emit the map in the base envelope

In `Drive.serializeConfig`, immediately after the step-2 `_field_visibility`
derivation, add the parallel derivation.

**Before**
```js
  // 2. Derived: field visibility from 7_form
  if (output['7_form']) {
    output['_field_visibility'] = Drive.buildFieldVisibilityMap(output['7_form']);
  }
```

**After**
```js
  // 2. Derived: field visibility from 7_form
  if (output['7_form']) {
    output['_field_visibility'] = Drive.buildFieldVisibilityMap(output['7_form']);
  }

  // 2b. Derived: supplier read-only flags from 4_fields (field property,
  //     variant-independent). Sibling to _field_visibility.
  if (output['4_fields']) {
    output['_field_supplier_readonly'] = Drive.buildFieldReadonlyMap(output['4_fields']);
  }
```

---

## 4. `008_Variant.js` — emit the map in each variant envelope

In `Variant._buildVariantEnvelope`, after the filtered `_field_visibility`
derivation, add the parallel derivation from the **already-filtered**
`4_fields`. This keeps the base and variant envelopes describing the same
fields with the same locked/unlocked intent.

**Before**
```js
  // Filtered _field_visibility derived from filtered 7_form.
  if (output['7_form']) {
    output['_field_visibility'] = Drive.buildFieldVisibilityMap(output['7_form']);
  }
```

**After**
```js
  // Filtered _field_visibility derived from filtered 7_form.
  if (output['7_form']) {
    output['_field_visibility'] = Drive.buildFieldVisibilityMap(output['7_form']);
  }

  // Filtered _field_supplier_readonly derived from filtered 4_fields.
  if (output['4_fields']) {
    output['_field_supplier_readonly'] = Drive.buildFieldReadonlyMap(output['4_fields']);
  }
```

> No change needed in `Variant._sheetsFromBaseOutput`: it already strips any
> leading-underscore top-level key, so `_field_supplier_readonly` is never
> mistaken for a sheet when `baseOutput` is reused.

---

## 5. `008_Version.js` + `002_Migrations.js` — version bump & migration entry

### 5a. `008_Version.js`

Schema structure changed (new column) and library code changed, so bump SCHEMA
and LIBRARY. **Leave PAYLOAD at `4.0`** — the webhook POST bodies built by
`Payload.*` are unchanged; the new envelope key is additive and optional. (Bump
PAYLOAD only if the connector decides to hard-gate on the presence of the new
map; an additive consumer read does not require it.)

**Before**
```js
var Version = Object.freeze({
  LIBRARY: '1.2.0',
  PAYLOAD: '4.0',
  SCHEMA:  '1.1'
});
```

**After**
```js
var Version = Object.freeze({
  LIBRARY: '1.3.0',
  PAYLOAD: '4.0',
  SCHEMA:  '1.2'
});
```

> `Config._assertSchemaCompatible` compares **major** versions only, so a
> `1.1 -> 1.2` workbook/library skew will not be rejected. Existing workbooks
> keep working; their fields default to editable until the column is added.

### 5b. `002_Migrations.js`

The Schema.gs contract requires a migration entry for any schema bump. The
migration is structurally a **no-op** — a blank/absent new column already reads
as `false`, so old workbooks are functionally correct without any structural
change. The entry exists so `Migrations.run` stamps the workbook's declared
version to `1.2` and the framework stays honest.

**Before**
```js
var MIGRATION_CHAIN = [
  // No migrations defined yet. v1.0 is the baseline.
  //
  // Example future shape (do not uncomment until needed):
  // ...
];
```

**After**
```js
var MIGRATION_CHAIN = [
  {
    from: '1.1',
    to:   '1.2',
    run:  function(ss) {
      // Additive, backward-compatible: a new supplier-read-only column in
      // 4_fields. Absent/blank cells read as false via Util.coerceTruthy, so
      // existing workbooks are already correct without structural change.
      // This step only records the version bump.
      //
      // OPTIONAL: to surface the column header in existing workbooks, write the
      // header text at FIELDS_LAYOUT.SUPPLIER_READONLY_COL here. Skipped by
      // default to avoid touching sheet structure (and to avoid any chance of
      // shifting column indices if positioned wrong).
      return {
        changed: [],
        notes:   ['Supplier read-only flag available in 4_fields; existing ' +
                  'fields default to editable.']
      };
    }
  }
];
```

---

## Carry-over checks (outside this library)

1. **Connector `fields_column_map`.** The raw new column still rides inside the
   `4_fields` grid in the JSON. If the connector does strict header or
   column-count validation on that grid, register the new header there too —
   even though the connector's *real* read is `_field_supplier_readonly`. This
   is the same exact-string-match class of bug as the earlier `"Strict?"` /
   `"Read-only"` header mismatches.

2. **Unique field names.** The derived map is keyed by field name and will
   collapse duplicates last-write-wins. If `validate_config` has no
   `no_duplicate_field_names` rule, add one — this new map quietly depends on
   name uniqueness (as `_field_visibility` already does).
