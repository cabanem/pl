# Workato Recipe Toolkit — File Manifest

Container-bound Apps Script project. Files load in this order in the Apps
Script editor (the editor doesn't enforce load order, but conceptually
this is the dependency direction — pure modules first, I/O on top).

## Setup

1. Open target Sheet → **Extensions → Apps Script**.
2. Add each `.js` file below as a script file in the project.
3. **Project Settings → Script Properties:**
   - `WORKATO_API_TOKEN` — required
   - `WORKATO_BASE_URL` — optional, defaults to `https://app.eu.workato.com`
   - `RECIPE_DRIVE_FOLDER_ID` — required for full-sync and cache operations
   - `TRIM_DRIVE_FOLDER_ID` — optional, falls back to `RECIPE_DRIVE_FOLDER_ID`
4. Reload the Sheet to pick up the **Workato** menu.

## Files (load order)

| # | File | Layer | Purpose |
|---|---|---|---|
| 1 | `canonical_hash.js` | pure | Canonical JSON, deep key strip, SHA-256 hashing |
| 2 | `workato_recipes.js` | API client | Fetch structured recipes from Workato |
| 3 | `recipe_trimmer.js` | pure | Trim recipe `code` per profile v0.1 |
| 4 | `recipe_extractor.js` | pure | Walk recipe trees, extract matching steps |
| 5 | `trim_measurement.js` | pure | Deterministic distribution stats |
| 6 | `recipe_sync.js` | I/O | onOpen menu, sync recipes to Sheet + Drive |
| 7 | `recipe_drive_cache.js` | I/O | Read recipes from Drive, write trimmed copies |
| 8 | `trim_measurement_sheet.js` | I/O | Render trim reports + comparisons to Sheet |
| 9 | `data_table_ops_report.js` | I/O | Extract Data Tables ops, join, write Sheet |
| 10 | `recipe_inspector.js` | diagnostic | Inspect provider/name pairs and input keys |

## Layer rules

- **Pure** modules: no `UrlFetchApp`, no `SpreadsheetApp`, no `DriveApp`,
  no `PropertiesService`. Take data, return data. Composable across runtimes.
- **API client** modules: `UrlFetchApp` only. No Sheets or Drive.
- **I/O** modules: do whatever they need. Compose pure modules into
  user-facing flows.

## Menu wiring

A single `onOpen` lives in `recipe_sync.js`. The full menu — including
trim measurement, comparison, cache operations, and the Data Tables
report — is set in that one place. See `recipe_sync.js` for the current
version.

## When extraction returns nothing

Run `inspectConnectorUsage()` from the Apps Script editor. It writes a
"Connector Usage" sheet showing every distinct `(provider, name)` pair
across cached recipes. Compare what's there to the `providers` set in
`DATA_TABLES_PROFILE` — usually the mismatch is obvious. Then
`inspectProviderInputKeys('your_provider_here')` shows which input keys
actually hold the table id, in case `tableIdKeys` needs updating.
