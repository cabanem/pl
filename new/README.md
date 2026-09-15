# Description parser

An Apps Script for the SDC config sheet. It reads the **Description** column of `4_fields`. It works out what each description says about the field. It proposes values for the other columns. You review the proposals. You apply the ones you accept.

## What it fills

| Description says | Tool proposes |
| --- | --- |
| "Allowed values: A, B, C" / "(Yes/No)" / "one of ..." | `Data format = dropdown`, `Lookup name`, and a new table in `5_lookups` (or the existing table if the values already match one) |
| "Optional unless X is Y" / "Required if X is Y" | A `Required if` row in `4_complex_validations` |
| "Leave blank if X is Y" | A `Must be empty if` row in `4_complex_validations` |
| "Maximum of 500", "between 1 and 60", "greater than 0" | `Numeric field validation` in interval notation |
| "up to 20 characters", "exactly 9 characters" | `Field length validation` in interval notation |
| "cannot be in the future", "after 2024-01-01" | `Date field validation` |
| "DD/MM/YYYY", "email", "percentage", "in EUR" | `Data format` |
| "whole number", "decimal", "true/false" | `Data type` (only if the cell is empty) |
| "10 digits", "ISO 2-letter code", "alphanumeric" | `Field input validation` (a regex) |
| "uppercase" / "lowercase" | `Data cleaning flags` |
| "mandatory", "must be unique", "hidden from suppliers" | `Required`, `Unique`, `Hidden` |

Examples in a description ("e.g. Finance, HR") are ignored. They are not allowed values.

## How it works

Three steps. Nothing is written to the config tabs until step 3.

1. **Scan.** The script reads the config shape. It runs each description through a set of extractors. It writes every proposal to a review tab, `_description_proposals`.
2. **Review.** Each row has an `Accept` checkbox. High-confidence rows are ticked for you. Rows that would overwrite a filled cell are not ticked. You can edit `Proposed value` before you apply.
3. **Apply.** The script writes each accepted row to its target tab. It marks the row `applied`. It writes a line to `_script_logs`.

The script finds the config shape by reading the sheet. It does not use column letters or row numbers.

- Tab names come from `_developer_settings` (Category = `sheets`).
- Header rows are found by anchor text: `_pk_fields_`, `_pk_rules_`, `Table name`.
- Columns are found by header text.
- Allowed data types, formats, rule names, and cleaning flags come from `_mapping`.

If a tab or list is missing, the script falls back to the values in the master template.

## Confidence levels

| Level | Meaning | Ticked by default |
| --- | --- | --- |
| `high` | The phrase is unambiguous. | Yes |
| `medium` | The phrase is clear, but the result needs a look (new lookup table, partial field-name match, currency guess). | No |
| `low` | Something is unresolved. The `Note` column says what. | No |
| `ai` | Gemini proposed it. It passed validation. | No |

Every row shows the `Evidence` — the words in the description that triggered it.

## Files

| File | Purpose |
| --- | --- |
| `DescriptionParser.gs` | Shape discovery, scan, review tab, apply, logging, menu. |
| `Extractors.gs` | The rules. Pure functions. This is the file you will edit most. |
| `AiAdapter.gs` | Optional. Sends unmatched descriptions to Gemini and validates the answers. |
| `Tests.gs` | Tests for the extractors. Runs in the editor and in Node. |
| `run-tests-node.js` | `node run-tests-node.js` runs the tests without Sheets. |

## Install

1. Add the four `.gs` files to the Apps Script project bound to the config sheet (the shim project). Or add them to the shared library and call them from the shim.
2. Add the menu. In your existing `onOpen`, add one line:
   ```js
   dpAddMenu(SpreadsheetApp.getUi());
   ```
   If the project has no `onOpen`, rename `dpOnOpen` to `onOpen`.
3. Reload the sheet. A **Description parser** menu appears.

The script only needs the spreadsheet scope. If you turn on AI, see below.

## Settings

Defaults live in `DP_SETTINGS` at the top of `DescriptionParser.gs`. Two of them can be overridden with Script Properties, so the deployed code stays the same across workbooks.

| Setting | Default | Script Property | Meaning |
| --- | --- | --- | --- |
| `OVERWRITE_EXISTING` | `false` | `DP_OVERWRITE_EXISTING` | Apply skips cells that already have a value. `Data cleaning flags` is the exception: new flags are appended. |
| `ACCEPT_BY_DEFAULT` | `['high']` | — | Which confidence levels are pre-ticked. |
| `NEW_LOOKUP_PROJECT_SPECIFIC` | `true` | — | Value of `Project specific?` on lookup rows the tool creates. |
| `AI_MODE` | `off` | `DP_AI_MODE` | `off`, `gaps`, or `all`. See below. |
| `AI_BATCH_SIZE` | `10` | — | Descriptions per Gemini call. |

## AI (optional)

The regex extractors handle the common phrasings. Gemini handles the rest.

- `gaps` — send only descriptions that look like they carry a rule but got no regex hit.
- `all` — send every description. Regex proposals win when both propose the same cell.

Gemini returns JSON in a fixed schema. The script then checks every item against the sheet's own vocabulary. A data type must be in the list. Interval notation must parse. A regex must compile. A condition field must be a real field name. A rule must be a real rule name. Anything that fails is shown on the review tab as `low` with a `REJECTED` note. It is never applied.

To turn it on:

1. Set Script Properties: `DP_AI_MODE=gaps`, `DP_GCP_PROJECT=<project id>`. Optional: `DP_GCP_LOCATION` (default `global`), `DP_GEMINI_MODEL` (default `gemini-2.5-flash`).
2. Add the scope to `appsscript.json`:
   ```json
   "oauthScopes": [
     "https://www.googleapis.com/auth/spreadsheets",
     "https://www.googleapis.com/auth/script.external_request",
     "https://www.googleapis.com/auth/cloud-platform"
   ]
   ```
3. The account that runs the script needs **Vertex AI User** on that project.

If a call fails, the scan still completes. The toast and the log say the AI step was skipped and why.

To use your GeminiLib instead, replace the body of `dpAiComplete_` in `AiAdapter.gs`. Keep the signature. Return parsed JSON.

## Adding a rule

Each extractor is one object in `DP_EXTRACTORS` in `Extractors.gs`:

```js
DP_EXTRACTORS.push({
  id: 'my_rule',
  run: function (text, sentences, ctx) {
    var m = text.match(/\bsome phrase\b/i);
    if (!m) return [];
    return [dpP_('fields', DP_COL.HIDDEN, true, 'medium', 'my_rule', m[0], 'optional note')];
  }
});
```

`dpP_(sheet, column, value, confidence, rule, evidence, note)` builds a proposal. `sheet` is `fields`, `lookups`, or `rules`. `DP_COL` holds the column header names. `ctx` holds the row's current values, every field name, and every lookup table.

Then add a case to `DP_TEST_CASES` in `Tests.gs` and run the tests.

## Tests

- Editor: menu → **Run extractor tests**, or run `dpRunTests`. Results go to the execution log.
- Node: `node run-tests-node.js`. Exit code 1 on failure.

The tests need no Sheets access. They cover the extractors and the AI-output validator.

## Limits

- One condition per rule. "Required if A is X **and** B is Y" is flagged `low`. Add the rows by hand.
- Presence tests ("Required if X is not blank") are flagged `low`. The rule form takes a literal value.
- Dependent dropdowns are never created. If a field is already `dropdown (dependent)`, the tool leaves `Data format` alone.
- A new lookup table gets `Code = Value`. Edit `5_lookups` after apply if codes should differ.
- Apply checks that each target row still holds the same `Field name`. If rows moved since the scan, it skips and asks you to rescan.
- Programmatic writes do not fire `onEdit`. The tool writes its own UUIDs into the `_pk_` columns of new rows.
