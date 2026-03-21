# PROMPT

You are working on a multi-project Google Apps Script + Workato supplier data collection system.

Act as a world-class enterprise Apps Script architect and implementation engineer.

## Architectural decisions already made
- Each client gets one long-lived Workato workspace per implementation.
- A new workspace is used only for breaking platform changes.
- Apps Script backend/control plane provisions Workato workspaces and coordinates bootstrap.
- Wrapper spreadsheet uses CoreLib and stores mirrored runtime state in `_runtime_state`.
- The backend/admin registry workbook is the system of record; `_runtime_state` is a mirror only.
- Business IDs must cross recipe boundaries.
- Workato Record IDs must remain local to update actions only.
- Canonical business IDs:
  - `template_project_id`
  - `template_version_id`
  - `supplier_request_id`
  - `upload_id`
  - `validation_result_id`
- The effective template version must freeze per supplier request.
- Re-initialize is unsafe by default.
- Safe replay policy:
  - hard refusal on re-initialize by default
  - exact-manifest-match idempotent return only when the manifest hash matches exactly

## Current system direction
- Create admin registry tabs:
  - `Workspace_Registry`
  - `Bootstrap_Ledger`
  - `Manifest_Registry`
- Add Apps Script services for registry access, manifest hashing, initialize guard, and runtime mirror behavior
- `_runtime_state` should keep only mirror/binding data
- `R-008`, `R-007a`, and `R-002` are being fixed separately to enforce frozen version propagation

## Coding expectations
- Production-grade Google Apps Script
- No unnecessary abstractions
- Clear constants, helper methods, and service boundaries
- Backward-compatible where practical
- Prefer explicit code over pseudo-code
- Show exactly what to add/change
- If updating an existing codebase, provide:
  1. summary
  2. new files/classes
  3. exact code
  4. integration notes
  5. test notes

Using the architectural context above, generate the Apps Script scaffolding for the admin registry workbook.

## Objective
Create the constants, header definitions, and helper utilities needed to manage these tabs:

- `Workspace_Registry`
- `Bootstrap_Ledger`
- `Manifest_Registry`

## Required output
Return:

1. Overview
2. Suggested file layout
3. A `RegistrySheetConfig` implementation containing:
   - workbook/tab constants
   - column header arrays
   - status enums
4. A `RegistryWorkbookService` implementation with methods to:
   - open the registry workbook
   - ensure required tabs exist
   - ensure headers are written
   - read all rows as objects
   - append rows
   - update rows by key
   - find row by key
5. Integration notes
6. Smoke test checklist

## Constraints
- Use Google Apps Script JavaScript syntax
- Write production-ready code
- Avoid pseudo-code
- Prefer explicit header arrays and column maps
- Assume the workbook ID is provided by config

# RESPONSE

Here’s the scaffolding package for the **admin registry workbook**. It matches the direction already settled: a **separate backend registry workbook** is authoritative, `_runtime_state` stays a mirror, and the first required tabs are `Workspace_Registry`, `Bootstrap_Ledger`, and `Manifest_Registry`.  

## 1. Overview

This package gives you:

* explicit tab/header constants
* status enums
* a production-grade workbook service for:

  * opening the registry workbook
  * ensuring tabs exist
  * ensuring headers exist
  * reading rows as objects
  * appending rows
  * updating rows by key
  * finding rows by key

It is intentionally boring and explicit. No clever abstractions, no magic schemas, no ordinal-column mutation. That fits the current codebase direction and the recommended class layout for `RegistrySheetConfig` and `RegistryWorkbookService`. 

---

## 2. Suggested file layout

Add these backend files first:

* `007_Registry_Sheet_Config.gs`
* `009_Registry_Workbook_Service.gs`

Later files can build on these:

* `011_Workspace_Binding_Service.gs`
* `012_Manifest_Service.gs`
* `013_Bootstrap_Ledger_Service.gs`
* `017_Initialize_Guard_Service.gs`  

---

## 3. `RegistrySheetConfig` implementation

**File: `007_Registry_Sheet_Config.gs`**

```javascript
/**
 * @file 007_Registry_Sheet_Config.gs
 * @fileoverview Constants and header definitions for the admin registry workbook.
 *
 * Admin registry workbook is the authoritative control-plane system of record.
 * The wrapper spreadsheet's _runtime_state is a mirror/cache only.
 */

/**
 * Static config for admin registry workbook tabs, headers, and enums.
 */
const RegistrySheetConfig = (() => {
  const WORKBOOK = Object.freeze({
    /**
     * Preferred config path:
     *   getAppConfig(ss).adminRegistryWorkbookId
     *
     * Fallback:
     *   Script Property: ADMIN_REGISTRY_ID
     */
    SCRIPT_PROPERTY_KEY: 'ADMIN_REGISTRY_ID'
  });

  const TABS = Object.freeze({
    WORKSPACE_REGISTRY: 'Workspace_Registry',
    BOOTSTRAP_LEDGER: 'Bootstrap_Ledger',
    MANIFEST_REGISTRY: 'Manifest_Registry'
  });

  const HEADERS = Object.freeze({
    WORKSPACE_REGISTRY: Object.freeze([
      'workspace_binding_id',
      'control_center_id',
      'client_implementation_id',
      'client_name',
      'workspace_name',
      'workspace_api_token_ref',
      'workspace_status',
      'recipe_bundle_version',
      'recipe_manifest_hash',
      'schema_contract_version',
      'active_bootstrap_id',
      'current_template_project_id',
      'current_template_version_id',
      'initialized_at',
      'draining_at',
      'retired_at',
      'last_error',
      'created_by',
      'created_at',
      'updated_at'
    ]),

    BOOTSTRAP_LEDGER: Object.freeze([
      'bootstrap_id',
      'workspace_binding_id',
      'control_center_id',
      'client_name',
      'init_manifest_hash',
      'bootstrap_status',
      'idempotency_decision',
      'recipe_bundle_version',
      'schema_contract_version',
      'template_project_id',
      'template_version_id',
      'supplier_roster_hash',
      'supplier_count',
      'response_payload_hash',
      'started_at',
      'completed_at',
      'error_message',
      'created_by',
      'created_at',
      'updated_at'
    ]),

    MANIFEST_REGISTRY: Object.freeze([
      'manifest_hash',
      'manifest_type',
      'canonical_json',
      'source_reference',
      'created_at'
    ])
  });

  const STATUS = Object.freeze({
    WORKSPACE: Object.freeze({
      PLANNED: 'PLANNED',
      RESERVED: 'RESERVED',
      PROVISIONING: 'PROVISIONING',
      BUNDLE_DEPLOYING: 'BUNDLE_DEPLOYING',
      BOOTSTRAP_PENDING: 'BOOTSTRAP_PENDING',
      ACTIVE: 'ACTIVE',
      FAILED: 'FAILED',
      QUARANTINED: 'QUARANTINED',
      DRAINING: 'DRAINING',
      RETIRED: 'RETIRED'
    }),

    BOOTSTRAP: Object.freeze({
      STARTED: 'STARTED',
      SUCCESS: 'SUCCESS',
      FAILED: 'FAILED',
      REFUSED: 'REFUSED'
    }),

    IDEMPOTENCY: Object.freeze({
      NEW: 'NEW',
      EXACT_MATCH_RETURN: 'EXACT_MATCH_RETURN',
      REFUSED: 'REFUSED'
    }),

    MANIFEST_TYPE: Object.freeze({
      BOOTSTRAP: 'BOOTSTRAP',
      RECIPE_BUNDLE: 'RECIPE_BUNDLE',
      SCHEMA_CONTRACT: 'SCHEMA_CONTRACT',
      TEMPLATE_CONFIG: 'TEMPLATE_CONFIG'
    })
  });

  function getRequiredTabs() {
    return [
      {
        name: TABS.WORKSPACE_REGISTRY,
        headers: HEADERS.WORKSPACE_REGISTRY
      },
      {
        name: TABS.BOOTSTRAP_LEDGER,
        headers: HEADERS.BOOTSTRAP_LEDGER
      },
      {
        name: TABS.MANIFEST_REGISTRY,
        headers: HEADERS.MANIFEST_REGISTRY
      }
    ];
  }

  function getHeadersForTab(tabName) {
    switch (tabName) {
      case TABS.WORKSPACE_REGISTRY:
        return HEADERS.WORKSPACE_REGISTRY;
      case TABS.BOOTSTRAP_LEDGER:
        return HEADERS.BOOTSTRAP_LEDGER;
      case TABS.MANIFEST_REGISTRY:
        return HEADERS.MANIFEST_REGISTRY;
      default:
        throw new Error(`No registry headers are defined for tab "${tabName}".`);
    }
  }

  function getHeaderIndexMap(tabName) {
    const headers = getHeadersForTab(tabName);
    const map = {};
    headers.forEach((header, index) => {
      map[header] = index;
    });
    return map;
  }

  function isKnownTab(tabName) {
    return Object.values(TABS).indexOf(tabName) !== -1;
  }

  return Object.freeze({
    WORKBOOK,
    TABS,
    HEADERS,
    STATUS,
    getRequiredTabs,
    getHeadersForTab,
    getHeaderIndexMap,
    isKnownTab
  });
})();
```

---

## 4. `RegistryWorkbookService` implementation

**File: `009_Registry_Workbook_Service.gs`**

```javascript
/**
 * @file 009_Registry_Workbook_Service.gs
 * @fileoverview Admin registry workbook access helpers.
 *
 * Responsibilities:
 * - open registry workbook
 * - ensure required tabs exist
 * - ensure headers are written
 * - read rows as objects
 * - append rows
 * - update rows by key
 * - find row by key
 */

/**
 * Workbook service for the admin registry workbook.
 *
 * Usage:
 *   const service = new RegistryWorkbookService(getAppConfig(ss));
 *   service.ensureRequiredTabsExist();
 *   const row = service.findRowByKey(
 *     RegistrySheetConfig.TABS.WORKSPACE_REGISTRY,
 *     'workspace_binding_id',
 *     'abc-123'
 *   );
 */
class RegistryWorkbookService {
  /**
   * @param {Object=} appConfig Optional config object, typically getAppConfig(ss)
   */
  constructor(appConfig) {
    this.appConfig_ = appConfig || null;
    this.workbookId_ = this.resolveWorkbookId_();
  }

  /**
   * Opens the authoritative admin registry workbook.
   * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
   */
  openRegistryWorkbook() {
    if (!this.workbookId_) {
      throw new Error(
        'Admin registry workbook ID is not configured. ' +
        'Set getAppConfig(ss).adminRegistryWorkbookId or script property ADMIN_REGISTRY_ID.'
      );
    }
    return SpreadsheetApp.openById(this.workbookId_);
  }

  /**
   * Ensures all required registry tabs exist and have correct headers.
   * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
   */
  ensureRequiredTabsExist() {
    const ss = this.openRegistryWorkbook();
    const tabDefs = RegistrySheetConfig.getRequiredTabs();

    tabDefs.forEach(def => {
      this.ensureSheet_(ss, def.name, def.headers);
    });

    return ss;
  }

  /**
   * Ensures a specific tab exists and has the expected header row.
   * @param {string} tabName
   * @returns {GoogleAppsScript.Spreadsheet.Sheet}
   */
  ensureTab(tabName) {
    const ss = this.openRegistryWorkbook();
    const headers = RegistrySheetConfig.getHeadersForTab(tabName);
    return this.ensureSheet_(ss, tabName, headers);
  }

  /**
   * Reads all non-empty rows from a registry tab as plain objects.
   * @param {string} tabName
   * @returns {Array<Object>}
   */
  readAllRows(tabName) {
    const sheet = this.ensureTab(tabName);
    const lastRow = sheet.getLastRow();
    const headers = RegistrySheetConfig.getHeadersForTab(tabName);

    if (lastRow < 2) return [];

    const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    return values
      .map(row => this.rowToObject_(headers, row))
      .filter(obj => this.rowHasAnyValue_(obj, headers));
  }

  /**
   * Appends a single row object to the given tab.
   * Missing fields are written as empty strings.
   * Extra fields are rejected.
   *
   * @param {string} tabName
   * @param {Object} rowObject
   * @returns {number} 1-based row number of the appended row
   */
  appendRow(tabName, rowObject) {
    const sheet = this.ensureTab(tabName);
    const headers = RegistrySheetConfig.getHeadersForTab(tabName);

    this.assertNoUnknownFields_(tabName, rowObject);

    const rowValues = this.objectToRow_(headers, rowObject);
    const targetRow = sheet.getLastRow() + 1;

    sheet.getRange(targetRow, 1, 1, headers.length).setValues([rowValues]);
    return targetRow;
  }

  /**
   * Finds a row by a key column value.
   *
   * @param {string} tabName
   * @param {string} keyColumn
   * @param {*} keyValue
   * @returns {Object|null} Object with rowNumber, values, object; or null if not found
   */
  findRowByKey(tabName, keyColumn, keyValue) {
    const sheet = this.ensureTab(tabName);
    const headers = RegistrySheetConfig.getHeadersForTab(tabName);
    const keyIndex = this.getHeaderIndexOrThrow_(tabName, keyColumn);
    const lastRow = sheet.getLastRow();

    if (lastRow < 2) return null;

    const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const normalizedKeyValue = this.normalizeCellValue_(keyValue);

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const candidate = this.normalizeCellValue_(row[keyIndex]);
      if (candidate === normalizedKeyValue) {
        return {
          rowNumber: i + 2,
          values: row,
          object: this.rowToObject_(headers, row)
        };
      }
    }

    return null;
  }

  /**
   * Updates an existing row by key. Only fields present in patchObject are updated.
   * Unknown fields are rejected.
   *
   * @param {string} tabName
   * @param {string} keyColumn
   * @param {*} keyValue
   * @param {Object} patchObject
   * @returns {Object} Updated row object
   */
  updateRowByKey(tabName, keyColumn, keyValue, patchObject) {
    const found = this.findRowByKey(tabName, keyColumn, keyValue);
    if (!found) {
      throw new Error(
        `No row found in "${tabName}" where ${keyColumn} = "${this.normalizeCellValue_(keyValue)}".`
      );
    }

    this.assertNoUnknownFields_(tabName, patchObject);

    const headers = RegistrySheetConfig.getHeadersForTab(tabName);
    const updatedObject = Object.assign({}, found.object, patchObject);
    const updatedValues = this.objectToRow_(headers, updatedObject);

    const sheet = this.ensureTab(tabName);
    sheet.getRange(found.rowNumber, 1, 1, headers.length).setValues([updatedValues]);

    return updatedObject;
  }

  /**
   * Upserts by key: update if present, append if absent.
   *
   * @param {string} tabName
   * @param {string} keyColumn
   * @param {Object} rowObject
   * @returns {Object} { action: 'inserted'|'updated', rowNumber: number }
   */
  upsertRowByKey(tabName, keyColumn, rowObject) {
    if (!rowObject || !Object.prototype.hasOwnProperty.call(rowObject, keyColumn)) {
      throw new Error(`Upsert into "${tabName}" requires key field "${keyColumn}" in rowObject.`);
    }

    const existing = this.findRowByKey(tabName, keyColumn, rowObject[keyColumn]);
    if (existing) {
      this.updateRowByKey(tabName, keyColumn, rowObject[keyColumn], rowObject);
      return { action: 'updated', rowNumber: existing.rowNumber };
    }

    const rowNumber = this.appendRow(tabName, rowObject);
    return { action: 'inserted', rowNumber };
  }

  /**
   * Internal: ensure a sheet exists and header row is correct.
   *
   * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
   * @param {string} sheetName
   * @param {Array<string>} headers
   * @returns {GoogleAppsScript.Spreadsheet.Sheet}
   * @private
   */
  ensureSheet_(ss, sheetName, headers) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    this.ensureHeaders_(sheet, headers);
    return sheet;
  }

  /**
   * Internal: writes or repairs header row if needed.
   *
   * Fail closed on structural mismatch. For scaffolding/bootstrap registry tabs,
   * it is safer to overwrite the header row than tolerate drift silently.
   *
   * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
   * @param {Array<string>} headers
   * @private
   */
  ensureHeaders_(sheet, headers) {
    const currentLastColumn = Math.max(sheet.getLastColumn(), headers.length);
    const existingHeaders = currentLastColumn > 0
      ? sheet.getRange(1, 1, 1, currentLastColumn).getValues()[0]
      : [];

    const expected = headers.slice();
    const current = existingHeaders.slice(0, expected.length).map(v => String(v || '').trim());

    const needsWrite =
      sheet.getLastRow() === 0 ||
      current.length !== expected.length ||
      expected.some((header, index) => current[index] !== header);

    if (needsWrite) {
      sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
      sheet.getRange(1, 1, 1, expected.length)
        .setFontWeight('bold')
        .setBackground('#f3f3f3');
      sheet.setFrozenRows(1);

      if (currentLastColumn > expected.length) {
        sheet.getRange(1, expected.length + 1, 1, currentLastColumn - expected.length).clearContent();
      }
    }
  }

  /**
   * @private
   */
  resolveWorkbookId_() {
    if (this.appConfig_ && this.appConfig_.adminRegistryWorkbookId) {
      return String(this.appConfig_.adminRegistryWorkbookId).trim();
    }

    const scriptProp = PropertiesService.getScriptProperties()
      .getProperty(RegistrySheetConfig.WORKBOOK.SCRIPT_PROPERTY_KEY);

    if (scriptProp && String(scriptProp).trim()) {
      return String(scriptProp).trim();
    }

    return '';
  }

  /**
   * @private
   */
  getHeaderIndexOrThrow_(tabName, headerName) {
    const indexMap = RegistrySheetConfig.getHeaderIndexMap(tabName);
    if (!Object.prototype.hasOwnProperty.call(indexMap, headerName)) {
      throw new Error(`Column "${headerName}" is not defined for registry tab "${tabName}".`);
    }
    return indexMap[headerName];
  }

  /**
   * @private
   */
  rowToObject_(headers, row) {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = row[index];
    });
    return out;
  }

  /**
   * @private
   */
  objectToRow_(headers, rowObject) {
    return headers.map(header => {
      if (!rowObject || !Object.prototype.hasOwnProperty.call(rowObject, header)) {
        return '';
      }
      return rowObject[header];
    });
  }

  /**
   * @private
   */
  rowHasAnyValue_(obj, headers) {
    return headers.some(header => {
      const value = obj[header];
      return value !== '' && value !== null && value !== undefined;
    });
  }

  /**
   * @private
   */
  normalizeCellValue_(value) {
    if (value === null || value === undefined) return '';
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return value.toISOString();
    }
    return String(value).trim();
  }

  /**
   * @private
   */
  assertNoUnknownFields_(tabName, obj) {
    if (!obj) return;

    const validHeaders = RegistrySheetConfig.getHeadersForTab(tabName);
    const validSet = {};
    validHeaders.forEach(header => {
      validSet[header] = true;
    });

    Object.keys(obj).forEach(key => {
      if (!validSet[key]) {
        throw new Error(`Unknown field "${key}" for registry tab "${tabName}".`);
      }
    });
  }
}
```

---

## 5. Integration notes

This should plug into your backend without changing the architectural split you already settled on: **dedicated backend registry workbook**, not the fleet workbook, and `_runtime_state` as mirror-only.  

### Config

Add one config value first:

```javascript
// Example: existing config/bootstrap file
const APP_BACKEND_CONFIG = {
  // ...
  adminRegistryWorkbookId: 'PUT_WORKBOOK_ID_HERE'
};
```

If your backend already centralizes config via script properties, set:

* `ADMIN_REGISTRY_ID`

The service supports either path.

### First use

Call this once during setup or startup:

```javascript
function ensureAdminRegistryWorkbook() {
  const service = new RegistryWorkbookService(APP_BACKEND_CONFIG);
  service.ensureRequiredTabsExist();
}
```

### Recommended next service boundaries

Once these two files are in place, the next classes should sit on top of them instead of touching sheets directly:

* `WorkspaceBindingService`
* `BootstrapLedgerService`
* `ManifestService`
* `InitializeGuardService` 

### Key discipline

Do not let downstream code mutate these sheets by column number. Always go through the service and update by named key columns. That is exactly the kind of direct sheet mutation this lifecycle work is trying to eliminate. 

---

## 6. Smoke test checklist

1. Set `ADMIN_REGISTRY_ID` or `appConfig.adminRegistryWorkbookId`.
2. Run `ensureAdminRegistryWorkbook()`.
3. Confirm these tabs exist:

   * `Workspace_Registry`
   * `Bootstrap_Ledger`
   * `Manifest_Registry`
4. Confirm header rows exactly match the definitions above.
5. Append a row into `Manifest_Registry`:

   * `manifest_hash = test-hash-001`
   * `manifest_type = BOOTSTRAP`
6. Read all rows from `Manifest_Registry` and verify the inserted object comes back with the expected fields.
7. Update that same row by key:

   * key column: `manifest_hash`
   * patch `source_reference = test`
8. Find the row by key again and verify the patch is present.
9. Upsert a `Workspace_Registry` row by `workspace_binding_id` and verify insert, then update.
10. Intentionally pass an unknown field and verify the service throws instead of silently writing bad columns.

If you want the next step, the logical follow-on is `WorkspaceBindingService` plus a wrapper-side `InitializePreflight`, because that is where the real rebinding risk gets shut down.
