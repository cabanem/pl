/**
 * @file PrimaryKey.gs (SDC library)
 * Primary-key column setup and backfill.
 *
 * No trigger. PKs are stamped during serialization (orchestrators call
 * backfill before Drive.serializeConfig). This is correct because nothing
 * in the workbook references rows by PK — cross-sheet references use
 * field names. The PK is a Workato-side identifier only, written back
 * to the sheet so it remains stable across re-publishes.
 *
 * Public:
 *   PrimaryKey.setupColumns(ss) → { ok, configured: [...], skipped: [...], message }
 *   PrimaryKey.backfill(ss)     → { ok, stamped: { sheetName: count }, totalStamped }
 */

var PrimaryKey = {};

// --- Public API ------------------------------------------------------

/**
 * One-time setup for a fresh workbook: insert PK columns where missing,
 * backfill UUIDs for existing data rows, apply column protection, hide.
 *
 * Idempotent — safe to call repeatedly. If a sheet already has the PK
 * column with the correct header, no column insertion happens.
 *
 * Returns a Result; the container shim renders the alert.
 *
 * @param {Spreadsheet} ss
 * @returns {{ok: boolean, configured: string[], skipped: Array<{sheetName: string, reason: string}>, message: string}}
 */
PrimaryKey.setupColumns = function(ss) {
  if (!ss) throw new Error('PrimaryKey.setupColumns: ss is required.');

  var configured = [];
  var skipped    = [];

  PRIMARY_KEY_COLUMNS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) {
      skipped.push({ sheetName: cfg.sheetName, reason: 'Sheet not found.' });
      return;
    }

    try {
      PrimaryKey._ensureColumn(sheet, cfg);
      PrimaryKey._backfillSheet(sheet, cfg);  // stamp existing rows
      PrimaryKey._applyProtection(sheet, cfg);
      configured.push(cfg.sheetName);
    } catch (e) {
      skipped.push({ sheetName: cfg.sheetName, reason: e.message });
    }
  });

  var message = 'Setup complete.\n\n'
    + '• Configured: ' + (configured.length ? configured.join(', ') : 'none') + '\n'
    + '• Skipped: '    + (skipped.length    ? skipped.map(function(s) {
        return s.sheetName + ' (' + s.reason + ')';
      }).join(', ') : 'none');

  return {
    ok:         skipped.length === 0,
    configured: configured,
    skipped:    skipped,
    message:    message
  };
};

/**
 * Stamp UUIDs into PK columns for any rows that have content but no ID.
 * Idempotent and cheap when nothing needs stamping. Called by orchestrators
 * before serialization.
 *
 * Writes back to the sheet so IDs are stable across re-publishes.
 *
 * @param {Spreadsheet} ss
 * @returns {{ok: boolean, stamped: Object<string, number>, totalStamped: number}}
 */
PrimaryKey.backfill = function(ss) {
  if (!ss) throw new Error('PrimaryKey.backfill: ss is required.');

  var stamped      = {};
  var totalStamped = 0;

  PRIMARY_KEY_COLUMNS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) {
      stamped[cfg.sheetName] = 0;
      return;
    }

    var count = PrimaryKey._backfillSheet(sheet, cfg);
    stamped[cfg.sheetName] = count;
    totalStamped += count;
  });

  return { ok: true, stamped: stamped, totalStamped: totalStamped };
};

// --- Private helpers -------------------------------------------------

/**
 * Ensure the PK column exists at cfg.colIndex with the correct header.
 * If the existing header doesn't match, insert a new column before it.
 * If a column is inserted, also writes a "Do not edit." note above the
 * header and "Primary key (UUID)" two rows above (when those rows exist).
 */
PrimaryKey._ensureColumn = function(sheet, cfg) {
  var headerRow = cfg.dataStartRow - 1;
  var pkCol     = cfg.colIndex + 1;

  var currentHeader = sheet.getRange(headerRow, pkCol).getValue();
  if (String(currentHeader).trim() === cfg.fieldName) return;  // already set up

  sheet.insertColumnBefore(pkCol);
  sheet.getRange(headerRow, pkCol).setValue(cfg.fieldName);

  if (headerRow >= 2) sheet.getRange(headerRow - 1, pkCol).setValue('Do not edit.');
  if (headerRow >= 3) sheet.getRange(headerRow - 2, pkCol).setValue('Primary key (UUID)');

  console.log('Inserted PK column in "' + cfg.sheetName + '" at column ' + pkCol + '.');
};

/**
 * Backfill UUIDs for rows that have content (in any non-PK column) but
 * an empty PK cell. Returns the number of rows stamped.
 *
 * Reads only the PK column and one neighbor column for the content check,
 * to avoid loading the full sheet width.
 */
PrimaryKey._backfillSheet = function(sheet, cfg) {
  var lastRow = sheet.getLastRow();
  if (lastRow < cfg.dataStartRow) return 0;

  var pkCol      = cfg.colIndex + 1;
  var dataRows   = lastRow - cfg.dataStartRow + 1;
  var pkRange    = sheet.getRange(cfg.dataStartRow, pkCol, dataRows, 1);
  var pkValues   = pkRange.getValues();
  var nameCol    = pkCol === 1 ? 2 : 1;
  var nameValues = sheet.getRange(cfg.dataStartRow, nameCol, dataRows, 1).getValues();

  var stamped = 0;
  for (var i = 0; i < dataRows; i++) {
    var hasName = String(nameValues[i][0]).trim() !== '';
    var hasPk   = String(pkValues[i][0]).trim() !== '';
    if (hasName && !hasPk) {
      pkValues[i][0] = Utilities.getUuid();
      stamped++;
    }
  }

  if (stamped > 0) {
    pkRange.setValues(pkValues);
    console.log('Stamped ' + stamped + ' UUIDs in "' + cfg.sheetName + '".');
  }
  return stamped;
};

/**
 * Apply warning-only protection on the PK column and hide it.
 * Idempotent — re-running adjusts editors and warning-only state on
 * an existing protection rather than creating duplicates.
 */
PrimaryKey._applyProtection = function(sheet, cfg) {
  var pkCol = cfg.colIndex + 1;

  var protection = sheet.getRange(1, pkCol, sheet.getMaxRows(), 1)
    .protect()
    .setDescription(cfg.fieldName + ' — immutable primary key');

  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  protection.setWarningOnly(true);

  sheet.hideColumns(pkCol);
  console.log('Protected and hid PK column in "' + cfg.sheetName + '".');
};
