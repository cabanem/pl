# SDC Library v1.0

Apps Script library + container shim for the Supplier Data Collection workflow.

## Layout

```
sdc_library/         ← Apps Script library project (publish as numbered version)
  Version.gs         ← LIBRARY / PAYLOAD / SCHEMA version constants
  Schema.gs          ← Structural facts: connector sheets, layouts, PK config, labels
  Util.gs            ← Pure primitives: coerceTruthy, isValidEmailShape, newCorrelationId,
                       findValueRightOfLabel, getActiveUserEmail
  Config.gs          ← Reads _developer_settings → typed config object (with schema check)
  Drive.gs           ← serializeConfig (returns {fileId, baseOutput}), folder resolution,
                       sharing, cleanup, normalizeDates, buildFieldVisibilityMap
  Variant.gs         ← Per-variant JSON serialization (skips re-reads via baseOutput)
  Webhook.gs         ← Uniform HTTP transport with retry + payload_version stamping
  Payload.gs         ← Provision / validate / portalInvite payload builders
  Log.gs             ← Append, getMostRecentCorrelationId, ensureSchema
  Preflight.gs       ← Common pre-execution checks
  PrimaryKey.gs      ← Column setup + backfill (no trigger; runs at serialize time)
  Migrations.gs      ← Schema migration framework (no-op chain for v1.0)
  Provision.gs       ← Provision orchestrator (Result-returning)
  Validate.gs        ← Validate orchestrator (Result-returning)
  Portal.gs          ← Portal-invite orchestrator (Result-returning)

sdc_container/       ← Container-bound script that lives in each workbook
  main.gs            ← onOpen, menu, three flow shims, setup shim, migration shim,
                       UI translators (showResult_, showValidationResults_)
```

## Public surface (consumer access)

Every namespace is reached via `SDC.<Namespace>.<function>` from the container:

- `SDC.Version.{LIBRARY, PAYLOAD, SCHEMA}` — version strings
- `SDC.Provision.run(ss)` → Result
- `SDC.Validate.run(ss)` → Result
- `SDC.Portal.run(ss)` → Result
- `SDC.PrimaryKey.setupColumns(ss)` → Result
- `SDC.Migrations.run(ss)` / `isMigrationNeeded(ss)` / `currentWorkbookVersion(ss)`
- `SDC.Log.ensureSchema(ss)` — called from onOpen for self-healing

## Result object shape

Every orchestrator returns:

```javascript
{
  ok:            boolean,            // success end-to-end
  flow:          string,             // 'provision' | 'validate' | 'portalInvite'
  correlationId: string,             // always present (generated up-front)
  message:       string,             // user-ready text
  data:          object | null,      // flow-specific payload
  error:         { stage, message } | null  // null when ok:true
}
```

## Three independent version axes

- **LIBRARY** — semver of library code. Bumps on any release.
- **PAYLOAD** — webhook contract version. Bumps when payload SHAPE changes (renames, type changes). Stamped by `Webhook.call`. R-1 reads to handshake.
- **SCHEMA** — workbook schema version the library expects. Bumps when structural shape of the workbook changes. `Migrations.run` reconciles workbooks.

Each axis versions independently.

## Install (per workbook)

1. In the container script, open Project Settings → Libraries.
2. Add the SDC library by Script ID, set identifier to `SDC`, pin a numbered version.
3. Save the container script. Open the workbook — `onOpen` runs and `SDC.Log.ensureSchema(ss)` adds the correlation_id column to `_script_logs` if missing.
4. Custom menu "Supplier data collection" appears.

The migration menu item ("Migrate workbook schema…") only appears when the workbook's declared schema version lags the library's.

## R-1 / Workato changes required to receive v1.0 payloads

These are coordinated changes — ship together with the library cutover:

1. **Read `payload_version`**: reject anything not `'1.0'` with a clear "outdated workbook library" error.
2. **Read `_meta.purpose` from the JSON envelope**: reject if not `'provision'` (provision recipe) or `'validate'` (validate recipe).
3. **Field name updates**:
   - `config_json_file_id` (was `drive_id_config_json`)
   - `template_file_ids` is an actual array now (was JSON-stringified `'[]'`)
   - `separate_workspace_required` is a native boolean (was string `'true'`/`'false'`)

## Files Workato writes / reads

Per workbook (`{ssId}` = `ss.getId()`):

```
config_{ssId}_{timestamp}.json                        ← base provision JSON
validate_{ssId}_{timestamp}.json                      ← base validate JSON
variant_{ssId}_Variant_{N}_{timestamp}.json           ← per-variant provision JSON
validate-variant_{ssId}_Variant_{N}_{timestamp}.json  ← per-variant validate JSON
```

Cleanup rule (asymmetric):
- A `provision` run trashes ALL prior `config_*`, `validate_*`, `variant_*`, and `validate-variant_*` for this workbook.
- A `validate` run trashes nothing. User manages validate-file accumulation.

## Open items before v1.0 ships

1. **Reconcile `PRIMARY_KEY_COLUMNS` in Schema.gs** against the actual workbook. Current values are placeholders — see comment in Schema.gs. The `_developer_settings.primary_keys` rows in master_config_v0.9.7 show inconsistent parallel arrays (7 sheets, 4 field names, 5 dataStartRow values). Decide canonical set before publishing.
2. **`4_fields` magic numbers in `Variant._filter4Fields`** (DATA_START_ROW = 8, FIELD_NAME_COL_INDEX = 2) should reference the reconciled Schema.gs constant.
3. **Verify library identifier `SDC`** is documented in the runbook for future workbook copies.
4. **Smoke test** end-to-end against test webhook before cutting v1.0.
5. **Consider unit tests** for Util, Drive (pure helpers), Payload, Migrations._planPath. ~4 hours of work, highest-ROI test investment.
```
