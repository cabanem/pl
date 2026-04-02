/**
 * @file pk_stamper.gs
 * @description Write-once UUID stamping for primary key columns.
 *
 * Reads _developer_settings.primary_keys to discover which sheets
 * need PK columns, where the column is, what the header name is,
 * and where data starts. The onEdit trigger stamps a UUID the
 * moment a user types into a data row — but only if the PK cell
 * is still empty. The UUID never changes after that.
 *
 * Run setupPrimaryKeyColumns() once to insert headers, apply
 * column protection, and install the onEdit trigger. If the
 * workbook is copied, run setup again in the copy — triggers
 * don't survive copies.
 *
 * @author Emily Cabaniss
 * @since 2026-04-02
 */


// ── Configuration reader ──────────────────────────────────────

/**
 * Parses the primary_keys block from _developer_settings into
 * a usable array of sheet configs.
 *
 * @returns {Array<{sheetName: string, colIndex: number, fieldName: string, dataStartRow: number}>}
 */
function getPrimaryKeyConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dev = ss.getSheetByName('_developer_settings');
  if (!dev) throw new Error('_developer_settings tab not found.');

  const data = dev.getDataRange().getValues();

  const find = (key) => {
    const row = data.find(r => r[1] === 'primary_keys' && r[2] === key);
    return row ? String(row[3]) : '';
  };

  const sheetNames   = find('sheetNames').split(',').map(s => s.trim());
  const indices       = find('indices').split(',').map(s => parseInt(s.trim(), 10));
  const fieldNames    = find('field_names').split(',').map(s => s.trim());
  const dataStartRows = find('data_start_row').split(',').map(s => parseInt(s.trim(), 10));

  return sheetNames.map((name, i) => ({
    sheetName:    name,
    colIndex:     indices[i],       // 0-based
    fieldName:    fieldNames[i],
    dataStartRow: dataStartRows[i]  // 1-based
  }));
}


// ── One-time setup ────────────────────────────────────────────

/**
 * Run once. For each tracked sheet:
 *   1. Inserts the PK column if the header isn't already present.
 *   2. Backfills UUIDs for existing data rows that lack one.
 *   3. Applies column protection (script-writable, human-readonly).
 */
function setupPrimaryKeyColumns() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const configs = getPrimaryKeyConfig();
  const me      = Session.getEffectiveUser();

  configs.forEach(cfg => {
    const sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) {
      console.warn(`Sheet "${cfg.sheetName}" not found — skipping.`);
      return;
    }

    const headerRow = cfg.dataStartRow - 1; // row above data holds column headers
    const pkCol     = cfg.colIndex + 1;     // 1-based for Sheets API

    // ── Step 1: Insert column if header doesn't match ──
    const currentHeader = sheet.getRange(headerRow, pkCol).getValue();
    if (String(currentHeader).trim() !== cfg.fieldName) {
      sheet.insertColumnBefore(pkCol);
      sheet.getRange(headerRow, pkCol).setValue(cfg.fieldName);

      // Label the definition/hints rows above the header if they exist
      if (headerRow >= 2) {
        sheet.getRange(headerRow - 1, pkCol).setValue('Do not edit.');
      }
      if (headerRow >= 3) {
        sheet.getRange(headerRow - 2, pkCol).setValue('Primary key (UUID)');
      }

      console.log(`Inserted PK column in "${cfg.sheetName}" at column ${pkCol}.`);
    }

    // ── Step 2: Backfill UUIDs for existing data rows ──
    const lastRow = sheet.getLastRow();
    if (lastRow >= cfg.dataStartRow) {
      const dataRows = lastRow - cfg.dataStartRow + 1;
      const pkRange  = sheet.getRange(cfg.dataStartRow, pkCol, dataRows, 1);
      const pkValues = pkRange.getValues();

      // Detect which column holds the "name" field (first non-PK content column)
      const nameCol     = pkCol === 1 ? 2 : 1;
      const nameValues  = sheet.getRange(cfg.dataStartRow, nameCol, dataRows, 1).getValues();

      let stamped = 0;
      for (let i = 0; i < dataRows; i++) {
        const hasName = String(nameValues[i][0]).trim() !== '';
        const hasPK   = String(pkValues[i][0]).trim() !== '';

        if (hasName && !hasPK) {
          pkValues[i][0] = Utilities.getUuid();
          stamped++;
        }
      }

      if (stamped > 0) {
        pkRange.setValues(pkValues);
        console.log(`Backfilled ${stamped} UUIDs in "${cfg.sheetName}".`);
      }
    }

    // ── Step 3: Protect the PK column ──
    const protection = sheet.getRange(1, pkCol, sheet.getMaxRows(), 1)
      .protect()
      .setDescription(`${cfg.fieldName} — immutable primary key`);

    // Remove all editors except the script owner, so only onEdit can write
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) {
      protection.setDomainEdit(false);
    }

    // Show a warning instead of a hard block — Apps Script onEdit still writes through
    protection.setWarningOnly(true);

    console.log(`Protected PK column in "${cfg.sheetName}".`);
  });

  // ── Step 4: Install the onEdit trigger (idempotent) ──
  ensureEditTrigger_();

  SpreadsheetApp.getUi().alert(
    'Setup complete.\n\n'
    + '• Primary key columns inserted and protected.\n'
    + '• Edit trigger installed — new rows will receive UUIDs automatically.\n\n'
    + 'If this workbook is ever copied, run this setup again in the copy.'
  );
}


// ── Trigger installer ─────────────────────────────────────────

/**
 * Creates an installable onEdit trigger for stampPrimaryKey,
 * but only if one doesn't already exist. Safe to call repeatedly.
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


// ── onEdit trigger ────────────────────────────────────────────

/**
 * Installable onEdit trigger. Stamps a UUID when:
 *   - The edited sheet is in the tracked list
 *   - The edited row is at or below dataStartRow
 *   - The PK cell for that row is empty
 *   - At least one non-PK cell in the row has content
 */
function stampPrimaryKey(e) {
  if (!e || !e.range) return;

  const sheet     = e.range.getSheet();
  const sheetName = sheet.getName();

  // Quick exit for sheets we don't track
  const configs = getPrimaryKeyConfig();
  const cfg = configs.find(c => c.sheetName === sheetName);
  if (!cfg) return;

  const editedRow = e.range.getRow();
  if (editedRow < cfg.dataStartRow) return;

  const pkCol  = cfg.colIndex + 1; // 1-based
  const pkCell = sheet.getRange(editedRow, pkCol);

  // Already stamped — do nothing
  if (String(pkCell.getValue()).trim() !== '') return;

  // Check that the row has at least one non-empty content cell
  const rowData = sheet.getRange(editedRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const hasContent = rowData.some((val, idx) => {
    if (idx === cfg.colIndex) return false; // skip the PK column itself
    return String(val).trim() !== '';
  });

  if (!hasContent) return;

  pkCell.setValue(Utilities.getUuid());
}


// ── onOpen hook ───────────────────────────────────────────────

/**
 * Call this from your existing onOpen() in main.gs.
 * Checks whether the PK trigger is installed. If not, adds a
 * menu item so the analyst can run setup with one click.
 *
 * Usage in main.gs:
 *
 *   function onOpen() {
 *     const ui = SpreadsheetApp.getUi();
 *     const menu = ui.createMenu('Supplier data collection')
 *       .addItem('Generate template(s) and initialize Workato', 'executeFullWorkflow')
 *       .addSeparator()
 *       .addItem('Draft specific variant...', 'draftSpecificVariant');
 *
 *     appendPkSetupMenuItem(menu);   // ← add this line
 *     menu.addToUi();
 *   }
 */
function appendPkSetupMenuItem(menu) {
  const triggerExists = ScriptApp.getProjectTriggers().some(
    t => t.getHandlerFunction() === 'stampPrimaryKey'
       && t.getEventType() === ScriptApp.EventType.ON_EDIT
  );

  if (!triggerExists) {
    menu.addSeparator();
    menu.addItem('⚠ Set up field IDs (required)', 'setupPrimaryKeyColumns');
  }
}
