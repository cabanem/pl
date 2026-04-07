/**
 * @file main.gs
 * @description Thin trigger layer for the SDC platform.
 *
 * Two responsibilities:
 *   1. Serialize the master config spreadsheet as JSON → save to Drive
 *   2. Fire a webhook to Workato with pointers to the config + metadata
 *
 * Template generation has moved to Workato (C-02).
 * Config parsing and validation live in the SDC Platform Connector.
 *
 * @author Emily Cabaniss
 * @since  2026-03-30
 * @modified 2026-04-07  Refactored to serialize-and-POST architecture
 */


// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sheets the SDC Platform Connector expects in the serialized JSON.
 * Everything else (START_HERE, .user_guide, .math_notation, .regex,
 * _script_logs, _developer_settings) is excluded.
 */
const CONNECTOR_SHEETS = new Set([
  '1_customer',
  '2_suppliers',
  '3_users',
  '4_fields',
  '4_complex_validations',
  '5_lookups',
  '6_variants',
  '_error_translation',
  '_mapping'
]);

/**
 * Reads the _developer_settings tab and builds a centralized config object.
 * All magic strings live in the spreadsheet, not in code.
 */
function buildConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const devSheet = ss.getSheetByName('_developer_settings');

  if (!devSheet) {
    throw new Error("Critical Error: The '_developer_settings' tab is missing.");
  }

  const devData = devSheet.getDataRange().getValues();

  const getSetting = (category, key, defaultValue = null) => {
    const row = devData.find(r => r[1] === category && r[2] === key);
    return row ? row[3] : defaultValue;
  };

  return {
    sheets: {
      customer:    getSetting('sheets', 'customer', '1_customer'),
      suppliers:   getSetting('sheets', 'suppliers', '2_suppliers'),
      users:       getSetting('sheets', 'supplier_users', '3_users'),
      fields:      getSetting('sheets', 'fields', '4_fields'),
      validations: getSetting('sheets', 'validations', '4_complex_validations'),
      lookups:     getSetting('sheets', 'lookupTables', '5_lookups'),
      variants:    getSetting('sheets', 'variants', '6_variants')
    },
    webhook: {
      url: getSetting('webhook', 'fileExportUrl')
    },
    labels: {
      customerName:       'Customer name',
      analystEmail:       'Analyst email address',
      folderId:           'Where should we save the template (Google Drive folder ID)?',
      separateWorkspace:  'Is a separate Workato workspace required?',
      targetVMS:          'What is the target vendor management system (VMS)?'
    }
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  MENU
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds the custom menu on spreadsheet open.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('Supplier Integration')
    .addItem('Initialize / Update Workspace', 'initializeOrUpdateWorkspace');

  appendPkSetupMenuItem(menu);
  menu.addToUi();
}


// ═══════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main entry point. Called from the custom menu.
 * Serializes the full config to Drive, then fires the webhook.
 */
function initializeOrUpdateWorkspace() {
  const CONFIG = buildConfig();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // ── Validate prerequisites ──────────────────────────────
  const customerSheet = ss.getSheetByName(CONFIG.sheets.customer);
  if (!customerSheet) {
    ui.alert('Error', `Sheet "${CONFIG.sheets.customer}" not found.`, ui.ButtonSet.OK);
    return;
  }

  const webhookUrl = CONFIG.webhook.url;
  if (!webhookUrl) {
    ui.alert(
      'Error',
      'Webhook URL not configured. Check _developer_settings → webhook.fileExportUrl.',
      ui.ButtonSet.OK
    );
    return;
  }

  const clientName        = findValueByLabel(customerSheet, CONFIG.labels.customerName);
  const analystEmail      = findValueByLabel(customerSheet, CONFIG.labels.analystEmail);
  const targetVms         = findValueByLabel(customerSheet, CONFIG.labels.targetVMS);
  const separateWorkspace = findValueByLabel(customerSheet, CONFIG.labels.separateWorkspace);

  if (!clientName || !analystEmail) {
    ui.alert('Error', 'Customer name and analyst email are required in the 1_customer tab.', ui.ButtonSet.OK);
    return;
  }

  // ── Step 1: Serialize config to Drive ───────────────────
  ui.showSidebar(
    HtmlService.createHtmlOutput('<p>Serializing configuration…</p>').setTitle('Status')
  );

  let configJsonFileId;
  try {
    configJsonFileId = serializeConfigToDrive();
  } catch (e) {
    ui.alert('Error', 'Failed to serialize config:\n\n' + e.message, ui.ButtonSet.OK);
    return;
  }

  // ── Step 2: Build payload ───────────────────────────────
  const correlationId = Utilities.getUuid();

  const payload = {
    correlation_id:             correlationId,
    client_name:                clientName,
    analyst_email:              analystEmail,
    target_vms:                 targetVms || '',
    config_file_id:             ss.getId(),
    template_file_ids:          '[]',                          // backward compat — Workato generates templates now
    timestamp:                  new Date().toISOString(),
    separate_workspace_required: String(separateWorkspace || false),
    drive_id_config_json:       configJsonFileId
  };

  // ── Step 3: Fire webhook ────────────────────────────────
  try {
    sendWebhookNotification(webhookUrl, payload);
  } catch (e) {
    ui.alert(
      'Error',
      'Config was serialized to Drive, but the Workato webhook failed:\n\n' + e.message,
      ui.ButtonSet.OK
    );
    return;
  }

  // ── Done ────────────────────────────────────────────────
  ui.alert(
    'Success',
    'Configuration sent to Workato.\n\nCorrelation ID: ' + correlationId,
    ui.ButtonSet.OK
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reads every connector-relevant sheet and produces a JSON object keyed by
 * sheet name, where each value is a 2D array of row arrays (the native
 * format returned by getDataRange().getValues()).
 *
 * Saves the JSON as a file in the same Drive folder as the spreadsheet.
 *
 * @returns {string} Google Drive file ID of the saved JSON file.
 */
function serializeConfigToDrive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const output = {};

  for (const sheet of ss.getSheets()) {
    const name = sheet.getName();
    if (!CONNECTOR_SHEETS.has(name)) continue;

    const data = sheet.getDataRange().getValues();

    // Convert Date objects to YYYY-MM-DD strings; preserve everything else as-is
    const cleaned = data.map(row =>
      row.map(cell => {
        if (cell instanceof Date) {
          return Utilities.formatDate(cell, tz, 'yyyy-MM-dd');
        }
        return cell;
      })
    );

    output[name] = cleaned;
  }

  // Save to the same Drive folder as the spreadsheet
  const json     = JSON.stringify(output);
  const stamp    = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const fileName = `config_${ss.getId()}_${stamp}.json`;

  const ssFile       = DriveApp.getFileById(ss.getId());
  const parentFolder = ssFile.getParents().next();
  const blob         = Utilities.newBlob(json, 'application/json', fileName);
  const file         = parentFolder.createFile(blob);

  return file.getId();
}


// ═══════════════════════════════════════════════════════════════════════════
//  WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POSTs the payload to the Workato webhook with exponential backoff.
 *
 * @param {string} webhookUrl - The Workato webhook endpoint.
 * @param {Object} payload    - The JSON payload to send.
 */
function sendWebhookNotification(webhookUrl, payload) {
  if (!webhookUrl || !payload) {
    throw new Error('Missing webhook URL or payload.');
  }

  const options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const response   = UrlFetchApp.fetch(webhookUrl, options);
      const statusCode = response.getResponseCode();

      if (statusCode >= 200 && statusCode < 300) {
        console.log('Webhook delivered successfully.');
        return true;
      }

      // Client errors (except 429) are not retryable
      if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        throw new Error(`Client error ${statusCode}: ${response.getContentText()}`);
      }

      console.warn(`Attempt ${attempt + 1} failed with status ${statusCode}. Retrying…`);

    } catch (e) {
      console.error(`Fetch exception on attempt ${attempt + 1}: ${e.message}`);
      if (attempt === maxRetries - 1) {
        throw new Error(`Failed to contact Workato after ${maxRetries} attempts. Last error: ${e.message}`);
      }
    }

    attempt++;
    if (attempt < maxRetries) {
      Utilities.sleep(Math.pow(2, attempt - 1) * 1000);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Searches a sheet for a label string and returns the first non-empty
 * value found in the three columns to its right.
 *
 * Works with the 1_customer layout where labels are in column B
 * and values are in column C (or D/E as fallback).
 *
 * @param {Sheet}  sheet - The sheet to search.
 * @param {string} label - The label text to match (case-insensitive).
 * @returns {*} The value, or null if not found.
 */
function findValueByLabel(sheet, label) {
  const data   = sheet.getDataRange().getValues();
  const target = label.toLowerCase().trim();

  for (let i = 0; i < data.length; i++) {
    for (let j = 0; j < data[i].length; j++) {
      if (String(data[i][j]).toLowerCase().trim() === target) {
        return data[i][j + 1] || data[i][j + 2] || data[i][j + 3] || null;
      }
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
//  PRIMARY KEY STAMPER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses the primary_keys block from _developer_settings.
 *
 * @returns {Array<{sheetName: string, colIndex: number, fieldName: string, dataStartRow: number}>}
 */
function getPrimaryKeyConfig() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const dev = ss.getSheetByName('_developer_settings');
  if (!dev) throw new Error('_developer_settings tab not found.');

  const data = dev.getDataRange().getValues();

  const find = (key) => {
    const row = data.find(r => r[1] === 'primary_keys' && r[2] === key);
    return row ? String(row[3]) : '';
  };

  const sheetNames   = find('sheetNames').split(',').map(s => s.trim());
  const indices      = find('indices').split(',').map(s => parseInt(s.trim(), 10));
  const fieldNames   = find('field_names').split(',').map(s => s.trim());
  const dataStartRows = find('data_start_row').split(',').map(s => parseInt(s.trim(), 10));

  return sheetNames.map((name, i) => ({
    sheetName:    name,
    colIndex:     indices[i],
    fieldName:    fieldNames[i],
    dataStartRow: dataStartRows[i]
  }));
}


/**
 * One-time setup. Inserts PK columns, backfills UUIDs, protects columns,
 * and installs the onEdit trigger.
 */
function setupPrimaryKeyColumns() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const configs = getPrimaryKeyConfig();

  configs.forEach(cfg => {
    const sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) {
      console.warn(`Sheet "${cfg.sheetName}" not found — skipping.`);
      return;
    }

    const headerRow = cfg.dataStartRow - 1;
    const pkCol     = cfg.colIndex + 1;

    // Insert column if header doesn't match
    const currentHeader = sheet.getRange(headerRow, pkCol).getValue();
    if (String(currentHeader).trim() !== cfg.fieldName) {
      sheet.insertColumnBefore(pkCol);
      sheet.getRange(headerRow, pkCol).setValue(cfg.fieldName);

      if (headerRow >= 2) sheet.getRange(headerRow - 1, pkCol).setValue('Do not edit.');
      if (headerRow >= 3) sheet.getRange(headerRow - 2, pkCol).setValue('Primary key (UUID)');

      console.log(`Inserted PK column in "${cfg.sheetName}" at column ${pkCol}.`);
    }

    // Backfill UUIDs for existing data rows
    const lastRow = sheet.getLastRow();
    if (lastRow >= cfg.dataStartRow) {
      const dataRows  = lastRow - cfg.dataStartRow + 1;
      const pkRange   = sheet.getRange(cfg.dataStartRow, pkCol, dataRows, 1);
      const pkValues  = pkRange.getValues();
      const nameCol   = pkCol === 1 ? 2 : 1;
      const nameValues = sheet.getRange(cfg.dataStartRow, nameCol, dataRows, 1).getValues();

      let stamped = 0;
      for (let i = 0; i < dataRows; i++) {
        if (String(nameValues[i][0]).trim() !== '' && String(pkValues[i][0]).trim() === '') {
          pkValues[i][0] = Utilities.getUuid();
          stamped++;
        }
      }

      if (stamped > 0) {
        pkRange.setValues(pkValues);
        console.log(`Backfilled ${stamped} UUIDs in "${cfg.sheetName}".`);
      }
    }

    // Protect the PK column
    const protection = sheet.getRange(1, pkCol, sheet.getMaxRows(), 1)
      .protect()
      .setDescription(`${cfg.fieldName} — immutable primary key`);

    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    protection.setWarningOnly(true);

    sheet.hideColumns(pkCol);
    console.log(`Protected and hid PK column in "${cfg.sheetName}".`);
  });

  ensureEditTrigger_();

  SpreadsheetApp.getUi().alert(
    'Setup complete.\n\n'
    + '• Primary key columns inserted and protected.\n'
    + '• Edit trigger installed — new rows will receive UUIDs automatically.\n\n'
    + 'If this workbook is ever copied, run this setup again in the copy.'
  );
}


/**
 * Creates an installable onEdit trigger for stampPrimaryKey (idempotent).
 * @private
 */
function ensureEditTrigger_() {
  const functionName = 'stampPrimaryKey';

  const existing = ScriptApp.getProjectTriggers().some(
    t => t.getHandlerFunction() === functionName
      && t.getEventType() === ScriptApp.EventType.ON_EDIT
  );

  if (existing) {
    console.log('Edit trigger already installed — skipping.');
    return;
  }

  ScriptApp.newTrigger(functionName)
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  console.log('Installed onEdit trigger for stampPrimaryKey.');
}


/**
 * Installable onEdit trigger. Stamps a UUID when a new data row is
 * entered in a tracked sheet and the PK cell is still empty.
 */
function stampPrimaryKey(e) {
  if (!e || !e.range) return;

  const sheet     = e.range.getSheet();
  const sheetName = sheet.getName();

  const configs = getPrimaryKeyConfig();
  const cfg = configs.find(c => c.sheetName === sheetName);
  if (!cfg) return;

  const editedRow = e.range.getRow();
  if (editedRow < cfg.dataStartRow) return;

  const pkCol  = cfg.colIndex + 1;
  const pkCell = sheet.getRange(editedRow, pkCol);

  if (String(pkCell.getValue()).trim() !== '') return;

  const rowData = sheet.getRange(editedRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const hasContent = rowData.some((val, idx) => {
    if (idx === cfg.colIndex) return false;
    return String(val).trim() !== '';
  });

  if (!hasContent) return;

  pkCell.setValue(Utilities.getUuid());
}


/**
 * Adds the PK setup menu item if the trigger isn't installed yet.
 * Called from onOpen().
 */
function appendPkSetupMenuItem(menu) {
  try {
    const triggerExists = ScriptApp.getProjectTriggers().some(
      t => t.getHandlerFunction() === 'stampPrimaryKey'
        && t.getEventType() === ScriptApp.EventType.ON_EDIT
    );

    if (!triggerExists) {
      menu.addSeparator();
      menu.addItem('⚠ Set up field IDs (required)', 'setupPrimaryKeyColumns');
    }
  } catch (e) {
    menu.addSeparator();
    menu.addItem('⚠ Set up field IDs (required)', 'setupPrimaryKeyColumns');
  }
}
