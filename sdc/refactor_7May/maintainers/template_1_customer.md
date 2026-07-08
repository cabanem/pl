# Maintainer Guide: Updating `1_customer`

**Scope:** Any change to the `1_customer` sheet of the SDC master config workbook — adding a field, renaming a label, removing a field, or repositioning content.
**Applies to:** SDC GAS library (v1.4.0+), SDC Platform Connector, master config template, deployed workbooks.
**Companion constants:** `003_Schema.js` (`Labels`), `005_Preflight.js`, `003_Payload.js`, `008_Version.js`, `002_Migrations.js`; connector `parse_customer_sheet` and `customer_definition`.

---

## 1. Mental model: who reads this sheet, and how

`1_customer` is not a table. It is a **label → value** sheet: question text in column B, the analyst's answer in column D. Four consumers read it, each with different rules. Every gotcha in this guide traces back to a mismatch between two of these consumers.

| # | Consumer | Mechanism | Forgiveness |
|---|----------|-----------|-------------|
| 1 | GAS library (`Preflight.run` via `Util.findValueRightOfLabel`) | Searches the whole sheet for the label text; takes the first non-blank value from up to 3 cells to the label's right (C, D, E). | Case-insensitive, trims edge whitespace. Otherwise **exact** — punctuation, interior spacing, and quote style (straight vs. smart) all count. |
| 2 | GAS library (`Variant._readVariantCount`) | Reads cell **`D6` by address**. The only positional read on the sheet. | None. Zero. This is the landmine — see §6.1. |
| 3 | Config JSON serialization (`Drive.serializeConfig`) | Ships the entire sheet as a raw 2D array into the config JSON (and, via passthrough, into every variant JSON). | N/A — wholesale copy. Any cell change moves `config_fingerprint`. That is correct behavior. |
| 4 | Connector (`parse_customer_sheet`) | Builds a kv map: label = column **B** (index 1) lowercased + trimmed, value = column **D** (index 3). Skips rows shorter than 4 cells. | Lowercase + trim only. Otherwise **exact**, and stricter than consumer 1: the value must be in column D specifically. |

**The two-matcher rule.** Every label string exists in three places that must agree character-for-character (modulo case and edge whitespace): the sheet cell, `Labels` in `003_Schema.js`, and the kv key in `parse_customer_sheet`. A drift between any pair produces a **silent nil**, not an error — the field simply arrives blank downstream. Two such drifts shipped and lived undetected (§7). Treat every label change as a three-way sync.

**The column-D rule.** GAS forgives a value in C or E; the connector does not. A value in column C works in every GAS flow and arrives blank in the connector — "provision succeeds, downstream field empty," the worst kind of bug to chase. Convention, no exceptions: **label in B, value in D.**

---

## 2. Versioning: which axis bumps when

Three independent version axes live in `008_Version.js`. A `1_customer` change touches them as follows:

| Change | SCHEMA | PAYLOAD | LIBRARY |
|---|---|---|---|
| Add a field (GAS-only, not on the wire) | bump | — | bump |
| Add a field (ships on provision payload) | bump | bump | bump |
| Rename a label | bump | — | bump |
| Remove a field | bump | bump if it was on the wire | bump |
| Reposition rows/columns | bump | — | bump |

SCHEMA bumps on **any** structural change to the sheet, because the label strings are part of the workbook schema contract (see the comment block above `Labels`). LIBRARY bumps because every SCHEMA bump ships a migration entry. PAYLOAD bumps **only** when the wire shape changes — renaming where a value is *found* does not change what is *sent*.

Every SCHEMA bump requires a corresponding `MIGRATION_CHAIN` entry, even if notes-only. Whether it can be notes-only is determined by one question: **does the old workbook still work against the new library without mutation?** Additive-with-safe-default → notes-only. Label rename or required-field addition → the migration must mutate (§5).

---

## 3. Procedure: adding a field

Work through in order. Steps 4–6 apply only if the field ships on the provision payload.

1. **`003_Schema.js` → `Labels`.** Add the key with the exact label string. This is the single source of truth on the GAS side.
2. **`005_Preflight.js` → extraction.** In the `requireCustomerData` block, add:
   `myNewField: Util.findValueRightOfLabel(customerSheet, Labels.myNewField)`
3. **`005_Preflight.js` → required check** (if required). The pattern depends on the value type — this is not optional style, it is correctness:
   - **string** → `if (!customerData.myNewField) missingFields.push(...)`
   - **numeric** → `if (v === null || v === '') ...` — the reminderDays pattern. A truthy check treats a legitimate `0` as missing.
   - **boolean** → do **not** required-check with either pattern; `false` is a valid answer. (This is the `is_initial` lesson, encoded in `Payload._requireArgs`'s presence-not-truthiness contract.)
   - **date** → two checks with **distinct errors**: presence on the *raw* cell value (blank → the standard missing-fields error) and shape on the *normalized* value (present but not a usable date → a specific "not a recognizable date" error). Never let malformed fall into "missing" — the analyst can see a value in the cell. Normalization happens at extraction via `Util.toIsoDate` (§6.7).
4. **`003_Payload.js` → `Payload.provision`.** Add the snake_case wire field (the builder owns camelCase→wire translation). If required, add the camelCase name to the `_requireArgs` array. If optional, normalize with `|| ''` (the `targetVms` pattern).
5. **`005_Provision.js`.** Thread it: `myNewField: pf.myNewField` in the `Payload.provision({...})` call. Preflight already returned it on `pf` via `Object.assign` — nothing else changes.
6. **`008_Version.js`.** PAYLOAD bump + history line in the header comment, following the established convention: *"N.0 — Provision payload: added `my_new_field` (required string; sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged."*
7. **Template workbook.** Add the row: label in **B**, value cell in **D**, positioned **below row 6** (§6.1). **Date fields additionally:** put data validation on the D-cell (Data → Data validation → "is valid date," reject input) so the picker appears and text/serial entry is blocked at the source — this is what makes Preflight's strict rejection a backstop rather than a common failure. Add a cell note prohibiting formulas: `=TODAY()+N` is §6.5's volatile-content ban wearing a business-logic disguise, and it isn't what "expected date" means anyway — a commitment is a static value.
8. **Migration entry.** Append the label row to existing workbooks; leave the value **blank**. Do not invent a default — preflight's missing-fields error will name the field, which is a self-explanatory failure, whereas a migration-supplied value is dishonest provenance.
9. **Connector `parse_customer_sheet`.** Add the kv lookup. The key is the label **lowercased and trimmed, otherwise character-exact** — including any trailing punctuation.
10. **Connector `customer_definition`.** Add the output field so the datapill exists in the recipe editor.
11. **Recipes.** Wire the new datapill where consumed. R-1's `payload_version` handshake is how the recipe side knows the field is present.

---

## 4. Procedure: renaming a label

Shorter list, sharper teeth. The GAS code change is one line; the deployment risk is entirely in steps 2–4.

1. **`003_Schema.js` → `Labels`.** Change the string value. The key stays, so Preflight and Provision — which reference `Labels.X` — need no edits. This is the payoff of the centralization; do not bypass it by inlining a string anywhere.
2. **Template workbook.** Update the cell text to match verbatim.
3. **Migration entry — must mutate.** The old text physically exists in cell B*n* of every deployed workbook. Once the library searches for the new text, an unmigrated workbook returns nil and fails preflight — while the analyst stares at a sheet that visibly contains the answer under the old wording. See §5 for the required mechanics.
4. **Connector `parse_customer_sheet`.** Update the kv key to the lowercased/trimmed form of the new string.
5. **No PAYLOAD bump.** Wire names and shapes are unchanged.

**Before shipping any string:** run the three-way character check (sheet cell ↔ `Labels` ↔ connector kv key). Diff the strings mechanically, not by eye — the two live drifts (§7) were a missing "the" and a trailing period.

---

## 5. Migration mechanics

One `MIGRATION_CHAIN` entry per SCHEMA bump, carrying **all** structural changes in that bump. Requirements for any entry that touches `1_customer`:

- **Mirror the lookup's normalization.** Match cells with `String(cell).toLowerCase().trim() === target` — exactly what `findValueRightOfLabel` does — so the migration finds precisely what the lookup would.
- **Idempotency is mandatory, not polite.** The framework re-enters steps after partial failure. For a rename: if the *new* text is already present, treat the rename as done and continue. For a field addition: check for the label's absence (via both `findValueRightOfLabel` and a raw cell scan) before appending.
- **Renames rewrite in place** (`getRange(i+1, j+1).setValue(newText)`); **additions append below existing content** — never insert rows (§6.1). Report a not-found label in `notes` rather than throwing, so one anomalous workbook doesn't strand the chain.
- **Return honest `changed`/`notes` arrays.** These land in `_script_logs` and the migration Result; they are the audit trail for "what did the migration do to my workbook."

**The major-version gap.** `Config._assertSchemaCompatible` compares **major** versions only. An unmigrated `1.2` workbook against a `1.3` library passes config and fails later at preflight with a misleading "Customer name missing." Recommended standing guard at the top of `Provision.run` (and any orchestrator that reads customer data):

```javascript
if (Migrations.isMigrationNeeded(ss)) {
  var e = new Error('Workbook schema is outdated. Run "Migrate workbook schema" from the menu first.');
  e.stage = 'schema-outdated';
  throw e;
}
```

**Rollout order:** library publish → template update → connector release → repin containers (versioned, not dev mode) → workbooks self-migrate via the onOpen menu item. The connector's `parse_customer_sheet` and the workbook must change in the same coordinated release; the GAS library tolerates nothing in between.

---

## 6. Invariants and gotchas

### 6.1 The D6 landmine
`Variant._readVariantCount` reads cell **`D6`** by address — the single positional read on an otherwise label-driven sheet. Inserting a row at or above row 6 silently shifts the variant count onto a neighboring cell; every downstream variant behavior degrades **without an error**. Two rules until it's fixed, one fix to retire it:

- Never insert rows at or above row 6. Migrations append below existing content.
- Never move the variant-count question from D6.
- **Permanent fix (fold into the next SCHEMA bump):** add `Labels.variantCount: 'How many variations are there of the template?'` and convert `_readVariantCount` to `Util.findValueRightOfLabel`. The connector already reads this value by exactly that label — GAS is the only positional holdout.

### 6.2 Column D discipline
Label in B, value in D. Always. (Rationale in §1; the asymmetry between GAS's C/D/E forgiveness and the connector's D-only read is the trap.)

### 6.3 Presence vs. truthiness
`false` and `0` are valid values. Required-field checks test *presence* (`!== null && !== undefined && !== ''`), never truthiness. Both `Payload._requireArgs` and the reminderDays preflight checks encode this; new checks must match.

### 6.4 Expected fingerprint movement
Any `1_customer` cell change moves `config_fingerprint` on the next provision, and — because `1_customer` passes through unfiltered into every variant envelope — every variant JSON changes identically. This is correct (real content changed). Do not chase it in a diff; do not exclude the sheet from the fingerprint to "fix" it.

### 6.5 Volatile content is banned from serialized sheets
No `NOW()`, `TODAY()`, `RAND()`, or formulas chained off them in any `CONNECTOR_SHEETS` member. A volatile cell makes `config_fingerprint` drift on every run by construction, destroying its "has the config changed?" semantics. If a timestamp is genuinely content, capture it statically (onEdit); if it's display convenience, it doesn't belong on a serialized sheet. (Case history: `_mapping!AR2`.)

### 6.6 Label strings are API, not copy
The question text in column B is a schema-versioned identifier consumed by two exact-match parsers. Wording "improvements" made directly in a workbook — by anyone — break the lookup silently. This is why the template protects these cells and why every wording change routes through §4.

### 6.7 Dates cross boundaries as `yyyy-MM-dd` strings — never as Date objects
A date cell has three possible representations (`Date` instance, `yyyy-MM-dd` string, date-formatted numeric serial) and two paths downstream (the payload via Preflight, the config JSON via `normalizeDates`). Normalize **once, at Preflight extraction**, via `Util.toIsoDate(value, ss.getSpreadsheetTimeZone())`:

- **Format `Date` instances with `Utilities.formatDate` in the workbook's timezone — never `toISOString`/`JSON.stringify`.** A raw `Date` reaching `JSON.stringify` serializes as UTC datetime, and midnight-local → UTC **shifts the calendar date backward for any UTC-positive workbook timezone**. The analyst types August 1; the wire says July 31. Same code, different client timezone, off-by-one.
- **Reject numeric serials (return null) rather than doing epoch arithmetic.** A serial in the cell means template data validation was bypassed; fail loudly at preflight with an actionable message, don't guess.
- `YYYY-MM-DD` is the platform-wide date dialect: the connector's `check_data_type`/`check_data_format` regexes and `evaluate_date_interval`'s lexicographic comparison all assume it, and it's the one format where string comparison *is* date comparison. Datapills for these fields are declared `type: "string"` (with a format hint), **not** `date_time` — a `date_time` declaration invites `parse_output` conversion, reintroducing the timezone ambiguity. Recipes convert string → datetime only at the last step before a `date_time` Data Table column write, where the timezone decision is explicit and owned by the recipe author.

---

## 7. Known live bugs (fix with the next connector release)

Recorded here so they ship with the next coordinated release rather than being rediscovered.

1. **`incumbent_split_field` kv drift.** Connector key: *"what field should we use to split data by supplier?"* GAS label: *"...split **the** data by supplier?"* Missing "the" → lookup returns nil → the parsed customer copy of this field is silently blank. (Masked today because the split field also rides the provision payload directly.)
2. **`wfa_instructions` kv drift.** GAS label ends with a trailing period, which survives `strip.downcase`; the connector key has no period. Same silent nil.
3. **`validate_config` → `lookup_has_values` details lambda:** calls `field_select` (missing receiver — should be `fields.select`). Latent `NoMethodError` that fires exactly when the check fails, converting a useful validation finding into an action crash.
4. **Same block:** emits `"emtity"` instead of `"entity"` — the finding renders blank in `ValidationReport._toRows`, which reads `d.entity`.
5. **Cosmetic:** `lookup_rows_by_name` is defined twice in `validate_config`; drop one.

---

## 8. Pre-release verification

Run all of these before calling a `1_customer` change done.

1. **Three-way string check, mechanically.** For every added/renamed label: sheet cell ↔ `Labels` value ↔ connector kv key. Normalize (lowercase + trim) and compare programmatically. Eyes miss trailing periods; diffs don't.
2. **Column check.** Every value cell is in column D; every affected row is ≥ 4 cells wide.
3. **D6 check.** `1_customer!D6` still holds the variant count (until §6.1's permanent fix lands).
4. **Migration idempotency.** Run the migration twice on a copy of a deployed workbook; the second run must report no changes.
5. **Preflight on an unmigrated copy** (if the standing guard from §5 isn't in place yet): confirm the failure message is survivable, and document the "run migration first" answer for support.
6. **Fingerprint stability regression.** Run validate twice back-to-back with no edits and diff the two JSONs: `_meta.serialized_at` differs, **nothing else** — including `config_fingerprint`. This is the standing test that catches any volatile content that slipped in (§6.5).
7. **Fingerprint movement.** One provision after the change: fingerprint moves once, then holds. Note it in release notes so nobody chases the ghost.
8. **Connector round-trip.** Feed a freshly serialized config JSON through `parse_config_file`; confirm the new/renamed customer fields arrive non-nil in the `customer` output and the datapills populate.
9. **Date round-trip** (date fields only): enter a date in the template cell, provision, and confirm the wire value and the config-JSON value are the **same `yyyy-MM-dd` string** as the cell displays. Then repeat with the workbook timezone set to a UTC-positive zone (e.g., Europe/Berlin) — the date must not shift. This catches any raw `Date` that slipped past the boundary normalizer (§6.7).
10. **Handshake** (wire changes only): confirm R-1 accepts the new `payload_version` and any consuming recipe reads the new field.

---

## Appendix: file-to-concern map

| File | Owns |
|---|---|
| `000_Util.js` | Boundary primitives — `findValueRightOfLabel`, `toIsoDate` (date normalization, §6.7) |
| `003_Schema.js` | `Labels` (label strings), `CONNECTOR_SHEETS`, layout constants — the structural contract |
| `005_Preflight.js` | Extraction from `1_customer` + required-field enforcement |
| `003_Payload.js` | Wire shape + presence validation (`_requireArgs`) |
| `005_Provision.js` | Threading `pf.*` into the payload builder |
| `008_Version.js` | SCHEMA / PAYLOAD / LIBRARY axes + payload history |
| `002_Migrations.js` | `MIGRATION_CHAIN` — one mutating or notes-only entry per SCHEMA bump |
| `008_Variant.js` | `_readVariantCount` — the D6 positional read (§6.1) |
| Connector `parse_customer_sheet` | kv extraction (B → D, lowercase/trim exact match) |
| Connector `customer_definition` | Datapill surface for parsed customer fields |
