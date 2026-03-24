/**
 * @file 000_Config.gs
 * @description Reads and caches the global configuration from the '_developer_settings' sheet.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * {@link https://docs.google.com/document/d/1dEoCTXGgpmIdhnghAHsBO7BymgnHBsQhMGfU36BaRvw/edit|internal_technical_documentation}
 *
 * CHANGES FROM ORIGINAL:
 *  - No logic changes. Minor formatting and comment cleanup only.
 */

let _cachedAppConfig = null;

/**
 * Reads and caches the application config from the '_developer_settings' sheet.
 * Two caching layers: in-memory (_cachedAppConfig) + CacheService (1hr, 95k limit guard).
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object} Nested config object keyed by Category → Key.
 */
function getAppConfig(ss) {
  if (!ss) throw new Error('Critical: Spreadsheet context (ss) not passed to getAppConfig.');
  if (_cachedAppConfig) return _cachedAppConfig;

  const cache        = CacheService.getScriptCache();
  const cachedString = cache.get('APP_CONFIG');
  if (cachedString) {
    _cachedAppConfig = JSON.parse(cachedString);
    return _cachedAppConfig;
  }

  const sheet = ss.getSheetByName('_developer_settings');
  if (!sheet) throw new Error("Configuration sheet '_developer_settings' not found.");

  const data      = sheet.getDataRange().getValues();
  const configObj = {};

  for (let i = 0; i < data.length; i++) {
    const category = String(data[i][1] || '').trim();
    const key      = String(data[i][2] || '').trim();
    let   value    = data[i][3];

    if (!category || !key || category === 'Category' || category === 'Developer settings') continue;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if      (trimmed.toUpperCase() === 'TRUE')          value = true;
      else if (trimmed.toUpperCase() === 'FALSE')         value = false;
      else if (!isNaN(trimmed) && trimmed !== '')         value = Number(trimmed);
    }

    if (!configObj[category]) configObj[category] = {};
    configObj[category][key] = value;
  }

  try {
    const configString = JSON.stringify(configObj);
    if (configString.length < 95000) {
      cache.put('APP_CONFIG', configString, 3600);
    } else {
      console.warn('Config exceeds 95k characters — skipping CacheService.');
    }
  } catch (err) {
    console.warn('Failed to write to CacheService: ' + err.message);
  }

  _cachedAppConfig = configObj;
  return _cachedAppConfig;
}

/**
 * Busts both the in-memory and CacheService config caches.
 * Called automatically when '_developer_settings' is edited.
 */
function resetConfigCache() {
  CacheService.getScriptCache().remove('APP_CONFIG');
  _cachedAppConfig = null;
}

/**
 * @file 001_Utils_Logger.gs
 * @description Shared utility functions: column conversion, UUID generation, sheet logging.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - No logic changes. Minor formatting cleanup only.
 */

/**
 * Converts a 1-based column index to its spreadsheet letter(s).
 * e.g. 1 → 'A', 27 → 'AA'
 *
 * @param {number} column - 1-based column index.
 * @returns {string}
 */
function columnToLetter(column) {
  let temp, letter = '';
  while (column > 0) {
    temp   = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

/**
 * @returns {string} A new UUID (v4).
 */
function getUUID() {
  return Utilities.getUuid();
}

/**
 * Appends an event row to the CONFIG.sheets.logs sheet.
 * Creates the sheet with headers if it does not yet exist.
 *
 * @param {string} status - e.g. 'INFO', 'SUCCESS', 'WARNING', 'ERROR'
 * @param {string} message
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function writeLog(status, message, ss) {
  if (!ss) throw new Error('Critical: Spreadsheet context (ss) not passed to writeLog.');

  const CONFIG    = getAppConfig(ss);
  let   logSheet  = ss.getSheetByName(CONFIG.sheets.logs);

  if (!logSheet) {
    logSheet = ss.insertSheet(CONFIG.sheets.logs);
    logSheet.appendRow(['Timestamp', 'Status', 'User', 'Message']);
    logSheet.getRange('A1:D1').setFontWeight('bold').setBackground('#f3f3f3');
    logSheet.setFrozenRows(1);
    logSheet.setColumnWidth(4, 450);
    logSheet.getRange('D:D').setWrap(true);
    logSheet.hideSheet();
  }

  let email = 'Anonymous/Unauthorized';
  try {
    email = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || email;
  } catch (e) {
    console.warn('Email capture failed in writeLog: ' + e.message);
  }

  logSheet.appendRow([new Date(), status, email, message]);
}

/**
 * @file 002_API.gs
 * @description Google Drive file operations and outbound webhook helpers.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - No logic changes. Minor formatting and comment cleanup only.
 */

// ---------------------------------------------------------------------------
// DRIVE / FILE OPERATIONS
// ---------------------------------------------------------------------------

/**
 * Exports a single named sheet to Excel (.xlsx) via a temporary spreadsheet.
 * Also copies the hidden lookups sheet so dropdown validations survive.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Source spreadsheet.
 * @param {string} targetFolderId - Drive folder to save into.
 * @param {string} outputFileName - Desired filename (without extension).
 * @param {string} sheetName - Name of the template sheet to export.
 * @returns {{ id: string, url: string, name: string }}
 */
function exportSheetToExcel(ss, targetFolderId, outputFileName, sheetName) {
  const CONFIG = getAppConfig(ss);
  const tempSs = SpreadsheetApp.create('Temp_' + outputFileName);
  const tempId = tempSs.getId();

  try {
    const templateSheet = ss.getSheetByName(sheetName);
    if (!templateSheet) throw new Error(`Sheet "${sheetName}" not found for export.`);

    templateSheet.copyTo(tempSs).setName('Data entry template');

    const lookupSheet = ss.getSheetByName(CONFIG.sheets.hiddenLookups);
    if (lookupSheet) {
      const lookupCopy = lookupSheet.copyTo(tempSs);
      lookupCopy.setName(CONFIG.sheets.hiddenLookups).hideSheet();
      lookupCopy.protect().setWarningOnly(false);
    }

    const defaultSheet = tempSs.getSheetByName('Sheet1');
    if (defaultSheet) tempSs.deleteSheet(defaultSheet);

    SpreadsheetApp.flush();

    const exportUrl = `https://docs.google.com/spreadsheets/d/${tempId}/export?format=xlsx`;
    const response  = UrlFetchApp.fetch(exportUrl, {
      headers:           { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      throw new Error(`Failed to download Excel blob. Response code: ${response.getResponseCode()}`);
    }

    const blob    = response.getBlob().setName(outputFileName + '.xlsx');
    const newFile = DriveApp.getFolderById(targetFolderId).createFile(blob);

    DriveApp.getFileById(tempId).setTrashed(true);
    return { id: newFile.getId(), url: newFile.getUrl(), name: newFile.getName() };

  } catch (e) {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
    throw e;
  }
}

/**
 * Renames the bound Apps Script project using the Drive REST API.
 * Failure is non-fatal — logged as WARNING but not thrown.
 *
 * @param {string} scriptId
 * @param {string} newName
 */
function renameBoundScript(scriptId, newName) {
  const response = UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${scriptId}`, {
    method:             'patch',
    headers:            { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType:        'application/json',
    payload:            JSON.stringify({ name: newName }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() >= 400) {
    console.warn(`Failed to rename script project. Code: ${response.getResponseCode()}, Error: ${response.getContentText()}`);
  }
}

// ---------------------------------------------------------------------------
// OUTBOUND WEBHOOKS
// ---------------------------------------------------------------------------

/**
 * @param {Object} payload
 * @param {string} webhookUrl
 * @returns {boolean}
 */
function sendTemplateGeneratedWebhook(payload, webhookUrl) {
  const response = UrlFetchApp.fetch(webhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code === 200 || code === 201) return true;
  throw new Error(`Workato Webhook (Template) returned code ${code}: ${response.getContentText()}`);
}

/**
 * @param {Object} payload
 * @param {string} webhookUrl
 * @returns {boolean}
 */
function sendSupplierOutreachWebhook(payload, webhookUrl) {
  const response = UrlFetchApp.fetch(webhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code === 200 || code === 201) return true;
  throw new Error(`Workato Webhook (Outreach) returned code ${code}: ${response.getContentText()}`);
}

/**
 * Sends the initialization payload to the backend provisioning webhook.
 * Respects the embedded GAS {statusCode, body} envelope.
 *
 * @param {Object} payload
 * @param {string} webhookUrl
 * @returns {Object} Parsed JSON response from the backend.
 */
function sendInitializeWorkspaceWebhook(payload, webhookUrl) {
  const response = UrlFetchApp.fetch(webhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return parseJsonWebhookResponse_(response, 'Initialization Webhook', { respectEmbeddedStatusCode: true });
}

/**
 * Sends seed data to the backend /inject-seed-data route.
 * Respects the embedded GAS {statusCode, body} envelope.
 *
 * @param {Object} payload
 * @param {string} webhookUrl
 * @returns {Object} Parsed JSON response.
 */
function sendInjectSeedDataWebhook(payload, webhookUrl) {
  const response = UrlFetchApp.fetch(webhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return parseJsonWebhookResponse_(response, 'Inject Seed Data Webhook', { respectEmbeddedStatusCode: true });
}

// ---------------------------------------------------------------------------
// INTERNAL
// ---------------------------------------------------------------------------

/**
 * Parses an HTTP response as JSON. Optionally validates the embedded GAS
 * {statusCode, body} envelope used by the backend provisioning web app.
 *
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @param {string} label - Used in error messages.
 * @param {{ respectEmbeddedStatusCode?: boolean }} [opts]
 * @returns {Object|null}
 * @private
 */
function parseJsonWebhookResponse_(response, label, opts = {}) {
  const httpCode       = response.getResponseCode();
  const responseText   = response.getContentText() || '';

  if (httpCode < 200 || httpCode >= 300) {
    throw new Error(`${label} returned HTTP ${httpCode}: ${responseText}`);
  }

  if (!responseText) return null;

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    throw new Error(`${label} returned non-JSON content: ${responseText}`);
  }

  if (opts.respectEmbeddedStatusCode && parsed && typeof parsed.statusCode === 'number') {
    const embeddedCode = parsed.statusCode;
    if (embeddedCode < 200 || embeddedCode >= 300) {
      const details = parsed.body
        ? (parsed.body.details || parsed.body.error || JSON.stringify(parsed.body))
        : 'Unknown backend error';
      throw new Error(`${label} returned embedded status ${embeddedCode}: ${details}`);
    }
  }

  return parsed;
}

/**
 * @file 003_Repo_Spreadsheet.gs
 * @description Data Access Layer. All direct grid reads and writes go here.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - No logic changes.
 *  - Added NOTE comments on hardcoded sheet names in getMappedRules_ and
 *    getMappedErrors_ — these should be moved to _developer_settings to be
 *    consistent with all other sheet name references.
 *  - Minor formatting cleanup.
 */

// ---------------------------------------------------------------------------
// CUSTOMER DATA
// ---------------------------------------------------------------------------

/**
 * Reads the customer info sheet and returns a key→value map.
 * Keys are column B values (question/label); values are column D (answer).
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function getCustomerData(ss) {
  const CONFIG = getAppConfig(ss);
  const sheet  = ss.getSheetByName(CONFIG.sheets.customer);
  if (!sheet) return {};

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const data      = sheet.getRange(1, 2, lastRow, 3).getValues();
  const customerObj = {};

  data.forEach(row => {
    const key   = String(row[0]).trim();
    const value = row[2];
    if (key && !key.startsWith('1.') && !key.startsWith('1A.') && !key.startsWith('1B.') && !key.startsWith('1C.')) {
      customerObj[key] = value;
    }
  });

  return customerObj;
}

// ---------------------------------------------------------------------------
// FIELD MATRIX
// ---------------------------------------------------------------------------

/**
 * Reads the field matrix sheet and returns structured field definitions.
 * Used by runTemplateGeneration to build the template column headers and validations.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Array<Object>}
 */
function getFieldMatrix(ss) {
  const CONFIG         = getAppConfig(ss);
  const matrixSheetName = CONFIG.sheets.fieldMatrix1 || CONFIG.sheets.fieldMatrix;
  const sheet          = ss.getSheetByName(matrixSheetName);
  if (!sheet) throw new Error(`Matrix sheet not found: ${matrixSheetName}`);

  const lastRow  = sheet.getLastRow();
  const startRow = CONFIG.ui.matrixDataStart || 9;
  if (lastRow < startRow) return [];

  const data = sheet.getRange(startRow, 1, lastRow - (startRow - 1), 13).getValues();
  return data.filter(row => row[0]).map(row => ({
    fieldName:      row[0],
    description:    row[1],
    isRequired:     String(row[2]).toUpperCase() === 'TRUE',
    dataType:       String(row[5]).toLowerCase(),
    standardFormat: row[6],
    lookupName:     row[7],
    isUnique:       String(row[4]).toUpperCase() === 'TRUE'
  }));
}

// ---------------------------------------------------------------------------
// LOOKUPS
// ---------------------------------------------------------------------------

/**
 * Clears and rebuilds the hidden lookup sheet used for dropdown data validations.
 * Each column corresponds to one named lookup table.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function rebuildHiddenLookups(ss) {
  const CONFIG      = getAppConfig(ss);
  let   hiddenSheet = ss.getSheetByName(CONFIG.sheets.hiddenLookups);
  if (!hiddenSheet) hiddenSheet = ss.insertSheet(CONFIG.sheets.hiddenLookups);
  hiddenSheet.clear().hideSheet();

  const lookupDataSheet = ss.getSheetByName(CONFIG.sheets.lookupTables);
  if (!lookupDataSheet) return;

  const data      = lookupDataSheet.getDataRange().getValues();
  const lookupDict = {};

  for (let i = 1; i < data.length; i++) {
    const [tableName, value, , isActive] = data[i];
    if (String(isActive).toUpperCase() === 'TRUE' && tableName && value) {
      if (!lookupDict[tableName]) lookupDict[tableName] = [];
      lookupDict[tableName].push([value]);
    }
  }

  let col = 1;
  for (const [name, vals] of Object.entries(lookupDict)) {
    hiddenSheet.getRange(1, col).setValue(name);
    hiddenSheet.getRange(2, col, vals.length, 1).setValues(vals);
    col++;
  }
}

// ---------------------------------------------------------------------------
// SUPPLIERS
// ---------------------------------------------------------------------------

/**
 * Reads the supplier sheet and returns rows where status is empty (pending).
 * Also returns the full allStatuses array for efficient batch write-back.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {{ pendingSuppliers: Array, allStatuses: Array, startRow: number, statusColIndex: number }}
 */
function getPendingSuppliers(ss) {
  const CONFIG = getAppConfig(ss);
  const sheet  = ss.getSheetByName(CONFIG.sheets.suppliers);
  if (!sheet) throw new Error(`Sheet "${CONFIG.sheets.suppliers}" not found.`);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const startRow = CONFIG.webhook.dataStartRow;

  if (lastRow < startRow) {
    return { pendingSuppliers: [], allStatuses: [], startRow, statusColIndex: -1 };
  }

  const dataRows = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
  const headers  = sheet.getRange(CONFIG.webhook.headerRow, 1, 1, lastCol).getValues()[0];

  const statusIndex      = headers.indexOf(CONFIG.webhook.statusColumnName);
  const supplierIndex    = headers.indexOf('Supplier');
  const emailIndex       = headers.indexOf('Contact email');
  const seededFlagIndex  = headers.indexOf('Has seeded data?');
  const seedLocationIndex = headers.indexOf('Location of seed data');

  if (statusIndex === -1 || supplierIndex === -1 || emailIndex === -1) {
    throw new Error('Required columns (Supplier, Contact email, or Status) not found.');
  }

  const pendingSuppliers = [];
  const allStatuses      = [];

  dataRows.forEach((row, index) => {
    const rowNum       = startRow + index;
    const supplierName = String(row[supplierIndex]).trim();
    const email        = String(row[emailIndex]).trim();
    const currentStatus = String(row[statusIndex]).trim();
    const hasSeededData = seededFlagIndex !== -1 ? String(row[seededFlagIndex]).toUpperCase() === 'TRUE' : false;
    const seedLocation  = seedLocationIndex !== -1 ? String(row[seedLocationIndex]).trim() : '';

    if (supplierName && email && currentStatus === '') {
      pendingSuppliers.push({
        name:                   supplierName,
        email:                  email,
        spreadsheet_row_number: rowNum,
        has_seeded_data:        hasSeededData,
        seed_data_location:     seedLocation,
        arrayIndex:             index
      });
      allStatuses.push(['']);
    } else {
      allStatuses.push([currentStatus]);
    }
  });

  return {
    pendingSuppliers,
    allStatuses,
    startRow,
    statusColIndex: statusIndex + 1  // +1: getRange uses 1-based indexing
  };
}

/**
 * Writes a 2D status array back to the supplier sheet in a single batch operation.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<Array<string>>} statusUpdates
 * @param {number} startRow
 * @param {number} statusColIndex
 */
function updateSupplierStatuses(ss, statusUpdates, startRow, statusColIndex) {
  const CONFIG = getAppConfig(ss);
  const sheet  = ss.getSheetByName(CONFIG.sheets.suppliers);
  if (!sheet) throw new Error(`Sheet "${CONFIG.sheets.suppliers}" not found.`);
  if (statusUpdates.length > 0) {
    sheet.getRange(startRow, statusColIndex, statusUpdates.length, 1).setValues(statusUpdates);
  }
}

// ---------------------------------------------------------------------------
// MATRIX SCHEMA
// ---------------------------------------------------------------------------

/**
 * Compiles the full matrix schema from all four source sheets.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {{ fields: Array, rules: Array, lookups: Array, error_translations: Array }}
 */
function getFullMatrixSchema(ss) {
  const CONFIG = getAppConfig(ss);
  return {
    fields:             getMappedFields_(ss, CONFIG),
    rules:              getMappedRules_(ss, CONFIG),
    lookups:            getMappedLookups_(ss, CONFIG),
    error_translations: getMappedErrors_(ss, CONFIG)
  };
}

// --- Private schema parsers -------------------------------------------------

/** @private */
function getMappedFields_(ss, CONFIG) {
  // NOTE: Uses CONFIG.sheets.fieldMatrix2 with a hardcoded fallback.
  // This is distinct from fieldMatrix1 used by getFieldMatrix().
  // If both v1 and v2 are intentional (template generation vs schema extraction),
  // document explicitly. If not, consolidate to a single sheet name key.
  const sheet = ss.getSheetByName(CONFIG.sheets.fieldMatrix2 || '3_field_matrix_v2');
  if (!sheet) return [];

  const data = sheet.getRange(9, 1, sheet.getLastRow() - 8, 13).getValues();
  return data.filter(row => row[0]).map((row, index) => ({
    id:                  `field_${getUUID()}`,
    field_name:          String(row[0]).trim(),
    description:         String(row[1]).trim(),
    required:            String(row[2]).toUpperCase() === 'TRUE',
    must_be_empty:       String(row[3]).toUpperCase() === 'TRUE',
    column_unique:       String(row[4]).toUpperCase() === 'TRUE',
    data_type:           String(row[5]).toLowerCase(),
    data_cleaning_flags: String(row[10]).trim(),
    position:            index + 1
  }));
}

/** @private */
function getMappedRules_(ss, CONFIG) {
  // NOTE: Sheet name '4_rule_matrix' is hardcoded here.
  // Should be moved to CONFIG.sheets.ruleMatrix in _developer_settings.
  const sheet = ss.getSheetByName('4_rule_matrix');
  if (!sheet) return [];

  const data = sheet.getRange(9, 1, sheet.getLastRow() - 8, 9).getValues();
  return data.filter(row => row[0]).map(row => ({
    id:                 `rule_${getUUID()}`,
    rule_type:          String(row[1]).trim(),
    condition_field:    String(row[2]).trim(),
    condition_operator: String(row[3]).trim(),
    condition_value:    String(row[4]).trim(),
    parameter_1:        String(row[5]).trim(),
    parameter_2:        String(row[6]).trim(),
    error_message:      String(row[7]).trim(),
    strict_enforcement: String(row[8]).toUpperCase() !== 'FALSE'
  }));
}

/** @private */
function getMappedLookups_(ss, CONFIG) {
  const sheet = ss.getSheetByName(CONFIG.sheets.lookupTables);
  if (!sheet) return [];

  const data       = sheet.getDataRange().getValues();
  const lookupDict = {};

  for (let i = 1; i < data.length; i++) {
    const [tableName, value, , isActive] = data[i];
    if (String(isActive).toUpperCase() === 'TRUE' && tableName && value) {
      if (!lookupDict[tableName]) lookupDict[tableName] = [];
      lookupDict[tableName].push(String(value).trim());
    }
  }

  return Object.entries(lookupDict).map(([name, vals]) => ({
    id:           `lookup_${getUUID()}`,
    lookup_name:  name,
    valid_values: vals
  }));
}

/** @private */
function getMappedErrors_(ss, CONFIG) {
  // NOTE: Sheet name '_error_translation' is hardcoded here.
  // Should be moved to CONFIG.sheets.errorTranslation in _developer_settings.
  const sheet = ss.getSheetByName('_error_translation');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  return data.filter((row, i) => i > 0 && row[0]).map(row => ({
    id:                    `err_${getUUID()}`,
    sql_error_code:        String(row[0]).trim(),
    human_readable_message: String(row[2]).trim()
  }));
}

/**
 * @file 004_Services.gs
 * @description Business logic orchestrators, audit stamping, and tab visibility utilities.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - Decomposed runTemplateGeneration into named step helpers (_buildTemplateSheet_,
 *    _applyTemplateHeaders_, _exportAndRegisterTemplate_, _triggerSeedMerge_).
 *    The original had all steps inlined.
 *  - Standardized error handling across all four orchestrators: each catches,
 *    logs, alerts the user, and returns (no rethrow). This is consistent with
 *    what runTemplateGeneration and runInjectSeedData already did. Previously
 *    runSupplierOutreach re-threw after alerting, causing a double-alert when
 *    Wrappers.gs also caught the error.
 *  - applyValidations_ extracted from runTemplateGeneration into a clearly
 *    named private helper (was already private but inlined).
 */

// ---------------------------------------------------------------------------
// AUDIT STAMPING (onEdit handler)
// ---------------------------------------------------------------------------

/**
 * Processes an installable onEdit event.
 * If '_developer_settings' was edited: resets the config cache.
 * Otherwise: stamps UUID and first-edit timestamp on rows in the tracked sheet.
 *
 * @param {Object} e - The validated onEdit event object.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function processEditEvent(e, ss) {
  if (!e || !e.range) return;
  const sheetName = e.range.getSheet().getName();

  if (sheetName === '_developer_settings') {
    resetConfigCache();
    return;
  }

  const CONFIG = getAppConfig(ss);
  if (sheetName !== CONFIG.editTracker.sheetName) return;

  const startCol = e.range.getColumn();
  const endCol   = e.range.getLastColumn();
  if (CONFIG.editTracker.watchField < startCol || CONFIG.editTracker.watchField > endCol) return;

  stampRow(e, ss, CONFIG);
}

/**
 * For each row in the edited range: independently stamps UUID (if blank)
 * and timestamp + editor email (if blank). Both checks are decoupled so
 * a missing UUID never blocks a missing timestamp.
 *
 * @param {Object} e
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} CONFIG
 */
function stampRow(e, ss, CONFIG) {
  const range    = e.range;
  const sheet    = range.getSheet();
  const startRow = range.getRow();
  const endRow   = range.getLastRow();

  for (let row = startRow; row <= endRow; row++) {
    if (row < CONFIG.webhook.dataStartRow) continue;

    const watchFieldValue = sheet.getRange(row, CONFIG.editTracker.watchField).getValue();
    if (watchFieldValue === '' || watchFieldValue === null) continue;

    const timestampRange = sheet.getRange(row, CONFIG.editTracker.timestampField);
    const uuidRange      = sheet.getRange(row, CONFIG.editTracker.uuidField);

    if (uuidRange.isBlank()) {
      try {
        const uuid = getUUID();
        uuidRange.setValue(uuid);
        writeLog('INFO', `Row ${row} initialized with UUID: ${uuid}`, ss);
      } catch (err) {
        writeLog('ERROR', `Failed to write UUID: ${err.message}`, ss);
      }
    }

    if (timestampRange.isBlank()) {
      const timestamp = new Date();
      let   email     = 'Anonymous/Unauthorized';
      try {
        email = (e.user && e.user.getEmail()) || Session.getActiveUser().getEmail() || email;
      } catch (err) {
        writeLog('WARNING', `Could not fetch email for row ${row}: ${err.message}`, ss);
      }

      try {
        timestampRange.setValue(timestamp);
      } catch (err) {
        writeLog('ERROR', `Failed to write Timestamp: ${err.message}`, ss);
      }

      if (CONFIG.editTracker.editorField) {
        try {
          sheet.getRange(row, CONFIG.editTracker.editorField).setValue(email);
        } catch (err) {
          writeLog('ERROR', `Failed to write Email: ${err.message}`, ss);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR: Workspace Initialization
// ---------------------------------------------------------------------------

/**
 * Gathers customer data, supplier roster, and field matrix schema, then sends
 * the initialization payload to the backend provisioning webhook.
 * Persists returned workflow IDs and supplier request mappings to runtime state.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function runWorkspaceInitialization(ss) {
  const CONFIG = getAppConfig(ss);

  try {
    writeLog('INFO', 'Gathering data for Workspace Initialization...', ss);

    const customerRaw   = getCustomerData(ss);
    const fallbackEmail = Session.getActiveUser().getEmail();
    const projectMeta   = buildProjectMetadata(customerRaw, fallbackEmail);

    try {
      const scriptId      = ScriptApp.getScriptId();
      const newScriptName = `Control Center - ${projectMeta.project_name}`;
      renameBoundScript(scriptId, newScriptName);
      writeLog('INFO', `Renamed script project to: ${newScriptName}`, ss);
    } catch (renameErr) {
      writeLog('WARNING', `Could not rename script project: ${renameErr.message}`, ss);
    }

    const pendingSuppliers = getPendingSuppliers(ss).pendingSuppliers;
    const matrixSchema     = getFullMatrixSchema(ss);

    const payload    = buildInitializeWorkspacePayload(ss.getId(), customerRaw, pendingSuppliers, matrixSchema, fallbackEmail, getUUID);
    const webhookUrl = CONFIG.webhook.initializeWorkspaceUrl;
    if (!webhookUrl) throw new Error("Missing 'initializeWorkspaceUrl' in _developer_settings tab.");

    writeLog('INFO', 'Sending payload to provisioning webhook...', ss);
    const response = sendInitializeWorkspaceWebhook(payload, webhookUrl);
    const body     = response && response.body ? response.body : {};

    const persisted = persistWorkflowIdentifiers(ss, {
      template_project_id: body.template_project_id || '',
      template_version_id: body.template_version_id || '',
      assigned_workspace:  body.assigned_workspace  || '',
      target_folder_id:    body.target_folder_id    || body._debug_folder_id || ''
    }, 'initialize_workspace_response');

    setRuntimeStates(ss, {
      last_initialize_at:           new Date().toISOString(),
      last_initialize_project_name: projectMeta.project_name
    });

    let persistedSupplierCount = 0;
    if (Array.isArray(body.supplier_requests) && body.supplier_requests.length > 0) {
      const supplierMap        = persistSupplierRequestMappings(ss, pendingSuppliers, body.supplier_requests);
      persistedSupplierCount   = Array.isArray(supplierMap.items) ? supplierMap.items.length : 0;
      writeLog('INFO', `Persisted ${persistedSupplierCount} supplier request mappings.`, ss);
    } else {
      writeLog('WARNING', 'No supplier request mappings returned by backend.', ss);
    }

    writeLog('SUCCESS', `Workspace initialized. Template Project: ${persisted.template_project_id || 'Unknown'} | Version: ${persisted.template_version_id || 'Unknown'} | Workspace: ${persisted.assigned_workspace || 'Unknown'}`, ss);

    SpreadsheetApp.getUi().alert(
      'Workspace Initialized!',
      `Template Project ID: ${persisted.template_project_id || 'Unknown'}\nTemplate Version ID: ${persisted.template_version_id || 'Unknown'}\nAssigned Workspace: ${persisted.assigned_workspace || 'Unknown'}\nSupplier Requests Stored: ${persistedSupplierCount}`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );

  } catch (error) {
    writeLog('ERROR', `Workspace Initialization Failed: ${error.toString()}`, ss);
    SpreadsheetApp.getUi().alert('Initialization Error:\n\n' + error.toString());
  }
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR: Template Generation
// ---------------------------------------------------------------------------

/**
 * Builds a timestamped template sheet from the field matrix, applies headers and
 * validations, exports it as .xlsx to Drive, fires the template-registered webhook,
 * and optionally triggers the seed data merge webhook.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function runTemplateGeneration(ss) {
  const CONFIG    = getAppConfig(ss);
  const timestamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd_HHmm');

  try {
    writeLog('INFO', 'Starting template generation process.', ss);

    const fieldMatrixParams  = getFieldMatrix(ss);
    rebuildHiddenLookups(ss);

    const dynamicSheetName = CONFIG.sheets.targetTemplatePrefix + timestamp;
    const targetSheet      = _buildTemplateSheet_(ss, dynamicSheetName);

    _applyTemplateHeaders_(targetSheet, fieldMatrixParams, CONFIG);
    SpreadsheetApp.flush();

    const savedFileData = _exportAndRegisterTemplate_(ss, targetSheet, dynamicSheetName, timestamp, fieldMatrixParams, CONFIG);

    _triggerSeedMerge_(ss, CONFIG);

    writeLog('SUCCESS', `Template ${dynamicSheetName} exported and webhook fired.`, ss);
    SpreadsheetApp.getUi().alert('Success! Template generated and exported.');

  } catch (error) {
    writeLog('ERROR', `Template Generation Failed: ${error.toString()}`, ss);
    SpreadsheetApp.getUi().alert('Error: ' + error.toString());
  }
}

/**
 * Creates the target sheet, sets it as active, and moves it to the end.
 * @private
 */
function _buildTemplateSheet_(ss, sheetName) {
  const targetSheet = ss.insertSheet(sheetName);
  ss.setActiveSheet(targetSheet);
  ss.moveActiveSheet(ss.getNumSheets());
  return targetSheet;
}

/**
 * Writes headers, applies notes/colors/validations for all field columns.
 * @private
 */
function _applyTemplateHeaders_(targetSheet, fieldMatrixParams, CONFIG) {
  const headers = [];

  fieldMatrixParams.forEach((field, index) => {
    const colIndex = index + 1;
    const colLetter = columnToLetter(colIndex);
    headers.push(field.fieldName);

    if (field.description) targetSheet.getRange(1, colIndex).setNote(field.description);
    targetSheet.getRange(1, colIndex).setBackground(
      field.isRequired ? CONFIG.ui.requiredHeaderColor : CONFIG.ui.optionalHeaderColor
    );

    applyValidations_(targetSheet, colIndex, colLetter, field, CONFIG);
  });

  targetSheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold');
  targetSheet.setFrozenRows(1);
  targetSheet.autoResizeColumns(1, headers.length);
}

/**
 * Exports the sheet to Excel, resolves the version ID, builds the webhook
 * payload, and fires the template-generated webhook.
 * @private
 */
function _exportAndRegisterTemplate_(ss, targetSheet, dynamicSheetName, timestamp, fieldMatrixParams, CONFIG) {
  const outputFileName = CONFIG.export.fileNamePrefix + timestamp;
  const savedFileData  = exportSheetToExcel(ss, CONFIG.export.targetFolderId, outputFileName, dynamicSheetName);
  if (!savedFileData) throw new Error('Excel export failed to return file data.');

  const customerData = getCustomerData(ss);
  const versionId    = resolveTemplateVersionId(ss, customerData);

  if (!versionId) {
    throw new Error('Template Version ID is missing from runtime state. Initialize the workspace before generating the template.');
  }

  const webhookPayload = buildTemplateGeneratedPayload(savedFileData, ss.getId(), customerData, versionId);
  sendTemplateGeneratedWebhook(webhookPayload, CONFIG.webhook.fileExportUrl);

  return savedFileData;
}

/**
 * Fires the optional seed data merge webhook if configured.
 * Non-fatal: logs WARNING and returns rather than throwing if URL is absent.
 * @private
 */
function _triggerSeedMerge_(ss, CONFIG) {
  const seedWebhookUrl = CONFIG.webhook.seedDataMergeUrl;
  if (!seedWebhookUrl) {
    writeLog('WARNING', 'Skipping seed data merge trigger — seedDataMergeUrl not configured.', ss);
    return;
  }

  const customerData = getCustomerData(ss);
  const versionId    = resolveTemplateVersionId(ss, customerData);

  UrlFetchApp.fetch(seedWebhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({ template_version_id: String(versionId) }),
    muteHttpExceptions: true
  });

  writeLog('INFO', `Seed data merge triggered for version: ${versionId}`, ss);
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR: Supplier Outreach
// ---------------------------------------------------------------------------

/**
 * Resolves supplier_request_id for each pending supplier row, batches them
 * into an outreach payload, fires the webhook, and marks sent rows.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function runSupplierOutreach(ss) {
  const CONFIG = getAppConfig(ss);

  try {
    syncKnownIdentifiersFromCustomerSheet(ss);

    const { pendingSuppliers, allStatuses, startRow, statusColIndex } = getPendingSuppliers(ss);

    if (pendingSuppliers.length === 0) {
      writeLog('INFO', 'Outreach triggered, but no pending rows found.', ss);
      SpreadsheetApp.getUi().alert('No pending suppliers found to process.');
      return;
    }

    const customerData     = getCustomerData(ss);
    const templateVersionId = resolveTemplateVersionId(ss, customerData);
    const resolvedRequests  = [];
    const unresolvedSuppliers = [];

    pendingSuppliers.forEach(supplier => {
      const supplierRequestId = resolveSupplierRequestIdByRow(ss, supplier);
      if (!supplierRequestId) {
        unresolvedSuppliers.push(supplier);
        return;
      }
      resolvedRequests.push({
        supplier_request_id:    supplierRequestId,
        name:                   supplier.name,
        email:                  supplier.email,
        spreadsheet_row_number: supplier.spreadsheet_row_number,
        has_seeded_data:        supplier.has_seeded_data,
        seed_data_location:     supplier.seed_data_location,
        arrayIndex:             supplier.arrayIndex
      });
    });

    if (resolvedRequests.length === 0) {
      writeLog('ERROR', 'Supplier Outreach aborted: no supplier_request_id mappings available for pending rows.', ss);
      SpreadsheetApp.getUi().alert('Supplier Outreach Error:\n\nNo supplier request mappings were available. Initialize the workspace first.');
      return;
    }

    const webhookPayload = buildSupplierOutreachPayload(ss.getId(), customerData, resolvedRequests, templateVersionId);
    sendSupplierOutreachWebhook(webhookPayload, CONFIG.webhook.supplierOutreachUrl);

    resolvedRequests.forEach(supplier => { allStatuses[supplier.arrayIndex] = ['Sent']; });
    updateSupplierStatuses(ss, allStatuses, startRow, statusColIndex);

    if (unresolvedSuppliers.length > 0) {
      writeLog('WARNING', `Sent ${resolvedRequests.length} supplier requests; skipped ${unresolvedSuppliers.length} row(s) — supplier_request_id could not be resolved.`, ss);
      SpreadsheetApp.getUi().alert(`Outreach sent for ${resolvedRequests.length} supplier(s).\n\n${unresolvedSuppliers.length} row(s) skipped — no supplier_request_id mapping found.`);
    } else {
      writeLog('SUCCESS', `Sent ${resolvedRequests.length} suppliers to Workato.`, ss);
      SpreadsheetApp.getUi().alert(`Success! ${resolvedRequests.length} suppliers sent.`);
    }

  } catch (error) {
    writeLog('ERROR', `Supplier Outreach Failed: ${error.toString()}`, ss);
    SpreadsheetApp.getUi().alert('Supplier Outreach Error:\n\n' + error.toString());
  }
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR: Inject Seed Data
// ---------------------------------------------------------------------------

/**
 * Reads the seed data sheet, resolves the supplier_request_id, flattens the
 * data into row/field/value tuples, and fires the inject-seed-data webhook.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function runInjectSeedData(ss) {
  const CONFIG = getAppConfig(ss);

  try {
    writeLog('INFO', 'Starting incumbent data injection...', ss);

    syncKnownIdentifiersFromCustomerSheet(ss);

    const seedSheet = ss.getSheetByName(CONFIG.sheets.seedData);
    if (!seedSheet) throw new Error('Seed data sheet not found.');

    const lastRow = seedSheet.getLastRow();
    const lastCol = seedSheet.getLastColumn();
    if (lastRow < 2) {
      SpreadsheetApp.getUi().alert('No seed data found in the sheet.');
      return;
    }

    const headers  = seedSheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const dataRows = seedSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    const customerData      = getCustomerData(ss);
    const supplierRequestId = resolveDefaultSupplierRequestId(ss, customerData);

    if (!supplierRequestId) {
      throw new Error('Supplier Request ID not found. Populate it in the customer sheet or persist it into runtime state before running seed injection.');
    }

    const payload = buildInjectSeedDataPayload(supplierRequestId, headers, dataRows);

    if (!payload.seed_data_payload || payload.seed_data_payload.length === 0) {
      SpreadsheetApp.getUi().alert('No valid rows found in seed data sheet.');
      return;
    }

    const webhookUrl = CONFIG.webhook.injectSeedDataUrl;
    if (!webhookUrl) throw new Error("Missing 'injectSeedDataUrl' in settings.");

    const response = sendInjectSeedDataWebhook(payload, webhookUrl);
    const body     = response && response.body ? response.body : {};

    persistWorkflowIdentifiers(ss, { supplier_request_id: supplierRequestId }, 'inject_seed_data_request');

    writeLog('SUCCESS', `Injected ${body.row_count || payload.seed_data_payload.length} seed rows for request: ${supplierRequestId}`, ss);
    SpreadsheetApp.getUi().alert(`Success! ${body.row_count || payload.seed_data_payload.length} rows of seed data sent.`);

  } catch (error) {
    writeLog('ERROR', `Seed data injection failed: ${error.toString()}`, ss);
    SpreadsheetApp.getUi().alert('Seed Data Injection Error:\n\n' + error.message);
  }
}

// ---------------------------------------------------------------------------
// VALIDATION HELPER
// ---------------------------------------------------------------------------

/**
 * Applies data validation to a template sheet column based on field type.
 * Supports: boolean (checkbox), lookup (range), date/datetime, unique (COUNTIF formula).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} colIndex
 * @param {string} colLetter
 * @param {Object} field
 * @param {Object} CONFIG
 * @private
 */
function applyValidations_(sheet, colIndex, colLetter, field, CONFIG) {
  const range       = sheet.getRange(2, colIndex, CONFIG.ui.maxDataRows - 1);
  let   ruleBuilder = SpreadsheetApp.newDataValidation().setAllowInvalid(false);
  let   ruleApplied = false;

  if (field.dataType === 'boolean') {
    ruleBuilder.requireCheckbox();
    ruleApplied = true;

  } else if (field.lookupName) {
    const lookupSheet = sheet.getParent().getSheetByName(CONFIG.sheets.hiddenLookups);
    if (lookupSheet) {
      const headers   = lookupSheet.getRange(1, 1, 1, lookupSheet.getLastColumn()).getValues()[0];
      const lookupCol = headers.indexOf(field.lookupName) + 1;
      if (lookupCol > 0) {
        const lookupColData  = lookupSheet.getRange(2, lookupCol, lookupSheet.getLastRow()).getValues();
        let   lastRowInLookup = 0;
        for (let i = 0; i < lookupColData.length; i++) {
          if (lookupColData[i][0] !== '') lastRowInLookup = i + 1;
        }
        ruleBuilder.requireValueInRange(lookupSheet.getRange(2, lookupCol, Math.max(1, lastRowInLookup), 1), true);
        ruleApplied = true;
      }
    }

  } else if (field.dataType === 'date' || field.dataType === 'datetime') {
    ruleBuilder.requireDate();
    if (field.standardFormat) {
      range.setNumberFormat(field.standardFormat.replace(/Y/g, 'y').replace(/D/g, 'd'));
    }
    ruleApplied = true;

  } else if (field.isUnique) {
    ruleBuilder.requireFormulaSatisfied(`=COUNTIF(${colLetter}$2:${colLetter}, ${colLetter}2)<=1`);
    ruleApplied = true;
  }

  if (ruleApplied) range.setDataValidation(ruleBuilder.build());
}

// ---------------------------------------------------------------------------
// TAB VISIBILITY UTILITIES
// ---------------------------------------------------------------------------

const ADMIN_TABS = [
  '_developer_settings', '_error_translation', 'Acceptance posture',
  '_mapping', '_script_logs', '_template_lookups', '_HiddenLookups'
];

/** @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss */
function hideAllAdminTabs(ss) {
  ss.getSheets().forEach(sheet => {
    if (ADMIN_TABS.includes(sheet.getName()) && !sheet.isSheetHidden()) sheet.hideSheet();
  });
}

/** @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss */
function showAllAdminTabs(ss) {
  ss.getSheets().forEach(sheet => {
    if (ADMIN_TABS.includes(sheet.getName()) && sheet.isSheetHidden()) sheet.showSheet();
  });
}

/** @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss */
function getSheetVisibilities(ss) {
  return ss.getSheets().map(sheet => ({ name: sheet.getName(), isHidden: sheet.isSheetHidden() }));
}

/**
 * @param {Array<{name: string, isHidden: boolean}>} selections
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function applyTabVisibilities(selections, ss) {
  const visibleCount = selections.filter(s => !s.isHidden).length;
  if (visibleCount === 0) throw new Error('You must leave at least one tab visible.');

  const sheetMap = {};
  ss.getSheets().forEach(sheet => { sheetMap[sheet.getName()] = sheet; });

  selections.filter(s => !s.isHidden).forEach(selection => {
    const sheet = sheetMap[selection.name];
    if (sheet && sheet.isSheetHidden()) sheet.showSheet();
  });

  selections.filter(s => s.isHidden).forEach(selection => {
    const sheet = sheetMap[selection.name];
    if (sheet && !sheet.isSheetHidden()) sheet.hideSheet();
  });
}

/**
 * @file 005_RuntimeState.gs
 * @description Hidden-sheet-backed key-value store for cross-step workflow identifiers.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - Added in-memory cache to getAllRuntimeState. A single workflow step was
 *    hitting the sheet 3-4 times via syncKnownIdentifiers, resolveTemplateVersionId,
 *    and resolveSupplierRequestIdByRow. Cache is busted on every setRuntimeStates call.
 *  - Renamed resolveSupplierRequestId → resolveDefaultSupplierRequestId
 *    (resolves the single default ID from runtime state or customer sheet —
 *    used by runInjectSeedData for single-supplier flows).
 *  - Renamed resolveSupplierRequestIdForSupplier → resolveSupplierRequestIdByRow
 *    (resolves by spreadsheet row number or email from the supplier map —
 *    used by runSupplierOutreach for multi-supplier flows).
 *    These two functions had similar names and overlapping purposes; the rename
 *    makes the distinction clear without changing any logic.
 */

const RUNTIME_STATE_SHEET_NAME = '_runtime_state';
const RUNTIME_STATE_HEADERS    = ['key', 'value', 'updated_at'];
const SUPPLIER_REQUEST_MAP_KEY = 'supplier_request_map_json';

// In-memory cache for runtime state. Busted on every write.
let _runtimeStateCache = null;

/**
 * Maps visible customer sheet labels to runtime state keys.
 * Extend this when downstream workflows write new identifiers into the customer sheet.
 */
const KNOWN_IDENTIFIER_LABEL_MAP = {
  'Supplier Request ID':         'supplier_request_id',
  'Template Version ID':         'template_version_id',
  'Assigned Workspace':          'assigned_workspace',
  'Target Folder ID':            'target_folder_id',
  'Current Template Version ID': 'current_template_version_id'
};

// ---------------------------------------------------------------------------
// SHEET BOOTSTRAP
// ---------------------------------------------------------------------------

/**
 * Ensures the _runtime_state sheet exists, is hidden, and has correct headers.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureRuntimeStateSheet(ss) {
  if (!ss) throw new Error('Critical: Spreadsheet context (ss) not passed to ensureRuntimeStateSheet.');

  let sheet = ss.getSheetByName(RUNTIME_STATE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RUNTIME_STATE_SHEET_NAME);
    sheet.getRange(1, 1, 1, RUNTIME_STATE_HEADERS.length)
      .setValues([RUNTIME_STATE_HEADERS])
      .setFontWeight('bold')
      .setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  } else if (!sheet.isSheetHidden()) {
    sheet.hideSheet();
  }

  return sheet;
}

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/**
 * Returns all runtime state as a key→value object.
 * Cached in memory — busted on every write via setRuntimeStates.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function getAllRuntimeState(ss) {
  if (_runtimeStateCache) return _runtimeStateCache;

  const sheet   = ensureRuntimeStateSheet(ss);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    _runtimeStateCache = {};
    return _runtimeStateCache;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  const out  = {};
  data.forEach(row => {
    const key = String(row[0] || '').trim();
    if (key) out[key] = row[1];
  });

  _runtimeStateCache = out;
  return _runtimeStateCache;
}

/**
 * Returns a single runtime state value.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} key
 * @param {*} [defaultValue]
 * @returns {*}
 */
function getRuntimeState(ss, key, defaultValue = '') {
  const state = getAllRuntimeState(ss);
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : defaultValue;
}

// ---------------------------------------------------------------------------
// WRITE
// ---------------------------------------------------------------------------

/**
 * Sets a single runtime state value.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} key
 * @param {*} value
 */
function setRuntimeState(ss, key, value) {
  setRuntimeStates(ss, { [key]: value });
}

/**
 * Sets multiple runtime state values in one sheet pass.
 * Busts the in-memory cache before writing.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} kvObject
 */
function setRuntimeStates(ss, kvObject) {
  _runtimeStateCache = null;  // bust cache before any write

  const sheet = ensureRuntimeStateSheet(ss);
  const keys  = Object.keys(kvObject || {});
  if (keys.length === 0) return;

  const lastRow    = sheet.getLastRow();
  const existingData = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, 3).getValues()
    : [];

  const rowIndexByKey = {};
  existingData.forEach((row, index) => {
    const existingKey = String(row[0] || '').trim();
    if (existingKey) rowIndexByKey[existingKey] = index + 2;
  });

  const now     = new Date();
  const updates = [];
  const appends = [];

  keys.forEach(key => {
    const normalizedKey   = String(key || '').trim();
    if (!normalizedKey) return;
    const normalizedValue = kvObject[key] === null || kvObject[key] === undefined ? '' : String(kvObject[key]);

    if (rowIndexByKey[normalizedKey]) {
      updates.push({ row: rowIndexByKey[normalizedKey], values: [[normalizedKey, normalizedValue, now]] });
    } else {
      appends.push([normalizedKey, normalizedValue, now]);
    }
  });

  updates.forEach(update => {
    sheet.getRange(update.row, 1, 1, 3).setValues(update.values);
  });

  if (appends.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, 3).setValues(appends);
  }

  if (!sheet.isSheetHidden()) sheet.hideSheet();
}

// ---------------------------------------------------------------------------
// IDENTIFIER PERSISTENCE
// ---------------------------------------------------------------------------

/**
 * Validates and persists a controlled set of workflow identifiers.
 * Adds sync metadata (last_identifier_sync_at, last_identifier_sync_source).
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} identifiers - May contain any of: template_project_id,
 *   supplier_request_id, template_version_id, current_template_version_id,
 *   assigned_workspace, target_folder_id
 * @param {string} [sourceLabel]
 * @returns {Object} The normalized identifiers that were actually persisted.
 */
function persistWorkflowIdentifiers(ss, identifiers, sourceLabel = 'unknown') {
  const safeIdentifiers = identifiers || {};
  const normalized      = {};

  ['template_project_id', 'supplier_request_id', 'template_version_id',
   'current_template_version_id', 'assigned_workspace', 'target_folder_id']
    .forEach(key => {
      const value = safeIdentifiers[key];
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        normalized[key] = String(value).trim();
      }
    });

  if (Object.keys(normalized).length === 0) return {};

  normalized.last_identifier_sync_at     = new Date().toISOString();
  normalized.last_identifier_sync_source = sourceLabel;

  setRuntimeStates(ss, normalized);
  return normalized;
}

/**
 * Reads known identifier labels from the customer sheet and persists any found
 * into runtime state. Useful when downstream automations write IDs back into
 * visible spreadsheet cells.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function syncKnownIdentifiersFromCustomerSheet(ss) {
  const customerData = getCustomerData(ss);
  const found        = {};

  Object.keys(KNOWN_IDENTIFIER_LABEL_MAP).forEach(label => {
    const runtimeKey = KNOWN_IDENTIFIER_LABEL_MAP[label];
    const value      = customerData[label];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      found[runtimeKey] = String(value).trim();
    }
  });

  return persistWorkflowIdentifiers(ss, found, 'customer_sheet_sync');
}

// ---------------------------------------------------------------------------
// RESOLUTION HELPERS
// ---------------------------------------------------------------------------

/**
 * Resolves the template version ID.
 * Priority: runtime state → customer sheet 'Template Version ID'
 *           → customer sheet 'Current Template Version ID' → ''.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} [customerData]
 * @returns {string}
 */
function resolveTemplateVersionId(ss, customerData) {
  const runtimeValue = String(getRuntimeState(ss, 'template_version_id', '') || '').trim();
  if (runtimeValue) return runtimeValue;

  const safeCustomer = customerData || getCustomerData(ss);
  const sheetValue   = safeCustomer['Template Version ID'] || safeCustomer['Current Template Version ID'] || '';

  if (String(sheetValue).trim()) {
    const synced = persistWorkflowIdentifiers(ss, { template_version_id: String(sheetValue).trim() }, 'resolve_template_version_id');
    return synced.template_version_id || '';
  }

  return '';
}

/**
 * Resolves the single default supplier request ID.
 * Used by runInjectSeedData for single-supplier seed injection flows.
 * Priority: runtime state → customer sheet 'Supplier Request ID' → ''.
 *
 * RENAMED FROM: resolveSupplierRequestId
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} [customerData]
 * @returns {string}
 */
function resolveDefaultSupplierRequestId(ss, customerData) {
  const runtimeValue = String(getRuntimeState(ss, 'supplier_request_id', '') || '').trim();
  if (runtimeValue) return runtimeValue;

  const safeCustomer = customerData || getCustomerData(ss);
  const sheetValue   = safeCustomer['Supplier Request ID'] || '';

  if (String(sheetValue).trim()) {
    const synced = persistWorkflowIdentifiers(ss, { supplier_request_id: String(sheetValue).trim() }, 'resolve_default_supplier_request_id');
    return synced.supplier_request_id || '';
  }

  return '';
}

/**
 * Resolves supplier_request_id for a specific supplier row.
 * Used by runSupplierOutreach for multi-supplier outreach flows.
 * Priority: match by spreadsheet row number → match by email.
 *
 * RENAMED FROM: resolveSupplierRequestIdForSupplier
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object|number|string} supplierOrRowNumber - Supplier object or row number.
 * @param {string} [email]
 * @returns {string}
 */
function resolveSupplierRequestIdByRow(ss, supplierOrRowNumber, email = '') {
  const mapObj = getSupplierRequestMap(ss);

  let rowNumber  = '';
  let emailValue = '';

  if (supplierOrRowNumber && typeof supplierOrRowNumber === 'object') {
    rowNumber  = String(supplierOrRowNumber.spreadsheet_row_number || '').trim();
    emailValue = String(supplierOrRowNumber.email || supplierOrRowNumber.contact_email || '').trim().toLowerCase();
  } else {
    rowNumber  = String(supplierOrRowNumber || '').trim();
    emailValue = String(email || '').trim().toLowerCase();
  }

  if (rowNumber && mapObj.by_row_number[rowNumber] && mapObj.by_row_number[rowNumber].supplier_request_id) {
    return String(mapObj.by_row_number[rowNumber].supplier_request_id);
  }

  if (emailValue && mapObj.by_email[emailValue] && mapObj.by_email[emailValue].supplier_request_id) {
    return String(mapObj.by_email[emailValue].supplier_request_id);
  }

  return '';
}

/**
 * Manual override: sets a supplier_request_id directly into runtime state.
 * Useful during staged rollout before fully automated callback exists.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} supplierRequestId
 * @returns {Object}
 */
function setSupplierRequestId(ss, supplierRequestId) {
  return persistWorkflowIdentifiers(ss, { supplier_request_id: supplierRequestId }, 'manual_set');
}

// ---------------------------------------------------------------------------
// SUPPLIER REQUEST MAP
// ---------------------------------------------------------------------------

/**
 * Returns the persisted supplier request map: { by_row_number, by_email, items }.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {{ by_row_number: Object, by_email: Object, items: Array }}
 */
function getSupplierRequestMap(ss) {
  const raw = String(getRuntimeState(ss, SUPPLIER_REQUEST_MAP_KEY, '') || '').trim();
  if (!raw) return { by_row_number: {}, by_email: {}, items: [] };

  try {
    const parsed = JSON.parse(raw);
    return {
      by_row_number: parsed.by_row_number || {},
      by_email:      parsed.by_email      || {},
      items:         parsed.items         || []
    };
  } catch (err) {
    writeLog('WARNING', `Failed to parse supplier request map JSON: ${err.message}`, ss);
    return { by_row_number: {}, by_email: {}, items: [] };
  }
}

/**
 * Persists the supplier request map as JSON.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} mapObj
 */
function setSupplierRequestMap(ss, mapObj) {
  setRuntimeState(ss, SUPPLIER_REQUEST_MAP_KEY, JSON.stringify(mapObj || { by_row_number: {}, by_email: {}, items: [] }));
}

/**
 * Merges supplier request IDs returned by the backend into the persistent map,
 * keyed by both spreadsheet row number and email for flexible lookup.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<Object>} pendingSuppliers - The local supplier rows.
 * @param {Array<Object>} supplierRequestsFromBackend - The backend response array.
 * @returns {{ by_row_number: Object, by_email: Object, items: Array }}
 */
function persistSupplierRequestMappings(ss, pendingSuppliers, supplierRequestsFromBackend) {
  const current = getSupplierRequestMap(ss);
  const byRow   = Object.assign({}, current.by_row_number);
  const byEmail = Object.assign({}, current.by_email);
  const items   = Array.isArray(current.items) ? current.items.slice() : [];

  const roster  = Array.isArray(supplierRequestsFromBackend) ? supplierRequestsFromBackend : [];
  const pending = Array.isArray(pendingSuppliers)            ? pendingSuppliers            : [];

  roster.forEach((backendItem, index) => {
    const rosterIndex      = backendItem && backendItem.roster_index !== undefined ? Number(backendItem.roster_index) : index;
    const pendingSupplier  = pending[rosterIndex];
    if (!pendingSupplier) return;

    const supplierRequestId = String(backendItem.supplier_request_id || '').trim();
    if (!supplierRequestId) return;

    const rowKey   = String(pendingSupplier.spreadsheet_row_number || '').trim();
    const emailKey = String(pendingSupplier.email || backendItem.contact_email || '').trim().toLowerCase();

    const item = {
      supplier_request_id:    supplierRequestId,
      supplier_name:          backendItem.supplier_name || pendingSupplier.name || '',
      contact_email:          backendItem.contact_email || pendingSupplier.email || '',
      spreadsheet_row_number: pendingSupplier.spreadsheet_row_number || '',
      roster_index:           rosterIndex
    };

    if (rowKey)   byRow[rowKey]     = item;
    if (emailKey) byEmail[emailKey] = item;

    const existingIndex = items.findIndex(x =>
      String(x.supplier_request_id || '') === supplierRequestId ||
      (
        String(x.spreadsheet_row_number || '') === String(item.spreadsheet_row_number || '') &&
        String(x.contact_email || '').toLowerCase() === String(item.contact_email || '').toLowerCase()
      )
    );

    if (existingIndex >= 0) items[existingIndex] = item;
    else items.push(item);
  });

  const out = { by_row_number: byRow, by_email: byEmail, items };
  setSupplierRequestMap(ss, out);
  return out;
}

// ---------------------------------------------------------------------------
// DEBUG
// ---------------------------------------------------------------------------

/**
 * Logs the full runtime state to console. Useful during development.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function logRuntimeState(ss) {
  const state = getAllRuntimeState(ss);
  console.log(JSON.stringify(state, null, 2));
  return state;
}


/**
 * @file 006_PayloadBuilders.gs
 * @description Pure payload construction helpers for webhook and workflow contracts.
 *   All functions are stateless — they receive data and return an object.
 *   No sheet reads or service calls should live here.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - Added buildTemplateGeneratedPayload. The original called this function from
 *    runTemplateGeneration but never defined it — a hard ReferenceError at runtime.
 *    Shape inferred from sendMockTemplateRegistrationPayload in the dev tools and
 *    from the R-001a webhook spec.
 *  - Removed the first definition of buildSupplierOutreachPayload. It was silently
 *    overwritten by the second definition below. The first had no templateVersionId
 *    parameter and was dead code.
 *  - Added controlCenterId parameter to buildInitializeWorkspacePayload. The backend
 *    handler (handleInitializeWorkspace) requires control_center_id in the payload
 *    and throws without it. The spreadsheet ID is the natural control center ID —
 *    ss.getId() is passed by runWorkspaceInitialization.
 */

// ---------------------------------------------------------------------------
// PROJECT METADATA
// ---------------------------------------------------------------------------

/**
 * Builds normalized project metadata from customer sheet data.
 *
 * @param {Object} customerRaw
 * @param {string} fallbackEmail
 * @returns {{ project_name: string, target_vms: string, analyst_email: string, has_incumbent_data: boolean }}
 */
function buildProjectMetadata(customerRaw, fallbackEmail) {
  const safe = customerRaw || {};
  return {
    project_name:       safe['Customer name']      || 'Unknown Project',
    target_vms:         safe['Target VMS']         || 'Unknown VMS',
    analyst_email:      safe['Analyst email address'] || fallbackEmail || '',
    has_incumbent_data: String(safe['Has incumbent data?']).toUpperCase() === 'TRUE'
  };
}

// ---------------------------------------------------------------------------
// WORKSPACE INITIALIZATION
// ---------------------------------------------------------------------------

/**
 * Builds the supplier roster for workspace initialization.
 *
 * @param {Array<Object>} pendingSuppliers
 * @param {Function} [uuidFn]
 * @returns {Array<{ supplier_id: string, supplier_name: string, contact_email: string, has_seeded_data: boolean }>}
 */
function buildSupplierRoster(pendingSuppliers, uuidFn) {
  const makeUuid = uuidFn || getUUID;
  return (pendingSuppliers || []).map(s => ({
    supplier_id:     makeUuid(),
    supplier_name:   s.name,
    contact_email:   s.email,
    has_seeded_data: Boolean(s.has_seeded_data)
  }));
}

/**
 * Builds the /initialize-workspace payload.
 *
 * CHANGED: Added controlCenterId parameter. The backend handler requires
 * control_center_id in the payload — the spreadsheet ID (ss.getId()) is the
 * natural value and should be passed by the calling orchestrator.
 *
 * @param {string} controlCenterId - The spreadsheet ID (ss.getId()).
 * @param {Object} customerRaw
 * @param {Array<Object>} pendingSuppliers
 * @param {Object} matrixSchema
 * @param {string} fallbackEmail
 * @param {Function} [uuidFn]
 * @returns {Object}
 */
function buildInitializeWorkspacePayload(controlCenterId, customerRaw, pendingSuppliers, matrixSchema, fallbackEmail, uuidFn) {
  return {
    control_center_id: String(controlCenterId || ''),
    project_metadata:  buildProjectMetadata(customerRaw, fallbackEmail),
    supplier_roster:   buildSupplierRoster(pendingSuppliers, uuidFn),
    matrix_schema:     matrixSchema || { fields: [], rules: [], lookups: [], error_translations: [] }
  };
}

// ---------------------------------------------------------------------------
// TEMPLATE GENERATION
// ---------------------------------------------------------------------------

/**
 * Builds the template-generated webhook payload (R-001a).
 *
 * ADDED: This function was called by runTemplateGeneration but was never defined
 * in the original codebase. Shape inferred from sendMockTemplateRegistrationPayload
 * and the R-001a webhook contract.
 *
 * @param {{ id: string, url: string, name: string }} savedFileData - From exportSheetToExcel.
 * @param {string} spreadsheetId - The control center spreadsheet ID.
 * @param {Object} customerData - From getCustomerData.
 * @param {string} versionId - The template version ID from runtime state.
 * @returns {Object}
 */
function buildTemplateGeneratedPayload(savedFileData, spreadsheetId, customerData, versionId) {
  return {
    event_type:            'template_generated',
    template_version_id:   String(versionId || ''),
    file_name:             savedFileData.name || '',
    google_drive_file_id:  savedFileData.id   || '',
    google_drive_file_url: savedFileData.url  || '',
    config_spreadsheet_id: String(spreadsheetId || ''),
    customer_info:         customerData || {},
    timestamp:             new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// SUPPLIER OUTREACH
// ---------------------------------------------------------------------------

/**
 * Builds the supplier outreach webhook payload.
 * Optionally includes template_version_id when provided.
 *
 * NOTE: The first definition of this function (without templateVersionId) was
 * removed — it was dead code silently overwritten by this definition.
 *
 * @param {string} spreadsheetId
 * @param {Object} customerData
 * @param {Array<Object>} resolvedRequests - Suppliers with resolved supplier_request_id.
 * @param {string} [templateVersionId]
 * @returns {Object}
 */
function buildSupplierOutreachPayload(spreadsheetId, customerData, resolvedRequests, templateVersionId = '') {
  const requestsPayload = (resolvedRequests || []).map(s => ({
    supplier_request_id:    s.supplier_request_id,
    name:                   s.name,
    email:                  s.email,
    spreadsheet_row_number: s.spreadsheet_row_number,
    has_seeded_data:        Boolean(s.has_seeded_data),
    seed_data_location:     s.seed_data_location || ''
  }));

  const out = {
    config_spreadsheet_id: spreadsheetId,
    customer_info:         customerData || {},
    requests:              requestsPayload
  };

  if (String(templateVersionId || '').trim()) {
    out.template_version_id = String(templateVersionId).trim();
  }

  return out;
}

// ---------------------------------------------------------------------------
// SEED DATA INJECTION
// ---------------------------------------------------------------------------

/**
 * Flattens 2D sheet data into the row/field/value format expected by the
 * /inject-seed-data route.
 *
 * @param {string[]} headers
 * @param {Array<Array<*>>} dataRows
 * @returns {Array<{ row_number: number, field_name: string, submitted_value: string }>}
 */
function buildSeedDataRows(headers, dataRows) {
  const safeHeaders = headers  || [];
  const safeRows    = dataRows || [];
  const result      = [];

  safeRows
    .filter(row => row.some(cell => cell !== ''))
    .forEach((row, rowIndex) => {
      safeHeaders.forEach((header, colIndex) => {
        if (header) {
          result.push({
            row_number:      rowIndex + 1,
            field_name:      String(header).trim(),
            submitted_value: String(row[colIndex] ?? '').trim()
          });
        }
      });
    });

  return result;
}

/**
 * Builds the /inject-seed-data payload.
 *
 * @param {string} supplierRequestId
 * @param {string[]} headers
 * @param {Array<Array<*>>} dataRows
 * @returns {{ supplier_request_id: string, seed_data_payload: Array }}
 */
function buildInjectSeedDataPayload(supplierRequestId, headers, dataRows) {
  return {
    supplier_request_id: String(supplierRequestId || '').trim(),
    seed_data_payload:   buildSeedDataRows(headers, dataRows)
  };
}
