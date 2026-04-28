/**
 * @file Log.gs (SDC library)
 * Reads and writes against the workbook's _script_logs sheet.
 *
 * Schema (v1.0): Timestamp | Status | User | Message | CorrelationId
 * Status values: INFO | SUCCESS | ERROR | WARNING
 *
 * Public:
 *   Log.append(ss, status, message, correlationId)  → void
 *   Log.getMostRecentCorrelationId(ss)              → string | null
 *   Log.ensureSchema(ss)                            → void
 *
 * Logging is best-effort: append failures are swallowed and warned to
 * console rather than thrown. The workflow must never fail because the
 * log sheet is missing or unwritable.
 */

var Log = {};

// --- Schema ---------------------------------------------------------
var LOG_SHEET_NAME = '_script_logs';

// Column indices (0-based) and headers — single source of truth for the schema.
var LOG_COL = Object.freeze({
  TIMESTAMP:      0,
  STATUS:         1,
  USER:           2,
  MESSAGE:        3,
  CORRELATION_ID: 4
});

var LOG_HEADERS = Object.freeze([
  'Timestamp', 'Status', 'User', 'Message', 'Correlation ID'
]);

var VALID_STATUSES = Object.freeze(new Set(['INFO', 'SUCCESS', 'ERROR', 'WARNING']));

// --- Public API -----------------------------------------------------

/**
 * Append a log entry. Best-effort — missing sheet or write failure is
 * logged to console and swallowed.
 *
 * Invalid status values are coerced to INFO. The console warning includes
 * the original value, the calling location (where available), and the
 * message tail so the typo is easy to find when reviewing execution logs.
 *
 * @param {Spreadsheet} ss
 * @param {string}      status          - One of INFO | SUCCESS | ERROR | WARNING.
 * @param {string}      message
 * @param {string}      [correlationId] - Optional; threaded through the run.
 */
Log.append = function(ss, status, message, correlationId) {
  try {
    if (!ss) return;

    var rawStatus        = status;
    var normalizedStatus = String(status || '').toUpperCase();

    if (!VALID_STATUSES.has(normalizedStatus)) {
      var msgTail = String(message || '').substring(0, 80);
      console.warn(
        'Log.append: invalid status "' + rawStatus + '" coerced to INFO. ' +
        'Valid values: INFO | SUCCESS | ERROR | WARNING. ' +
        'Message starts: "' + msgTail + '". ' +
        'Fix the calling code to use one of the valid status values.'
      );
      normalizedStatus = 'INFO';
    }

    var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
    if (!logSheet) return;

    var user = Util.getActiveUserEmail();

    logSheet.appendRow([
      new Date(),
      normalizedStatus,
      user,
      String(message || ''),
      String(correlationId || '')
    ]);
  } catch (e) {
    console.warn('Log.append failed: ' + e.message);
  }
};

/**
 * Return the most recent correlation ID from a SUCCESS log entry, or null.
 * Reads the CorrelationId column directly — no message parsing.
 */
Log.getMostRecentCorrelationId = function(ss) {
  try {
    if (!ss) return null;

    var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
    if (!logSheet) return null;

    var data = logSheet.getDataRange().getValues();

    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      var status        = String(row[LOG_COL.STATUS] || '');
      var correlationId = String(row[LOG_COL.CORRELATION_ID] || '').trim();

      if (status === 'SUCCESS' && correlationId !== '') {
        return correlationId;
      }
    }
    return null;
  } catch (e) {
    console.warn('Log.getMostRecentCorrelationId failed: ' + e.message);
    return null;
  }
};

/**
 * Self-heal the _script_logs schema. Idempotent. Safe to call from onOpen.
 *
 * Behavior:
 *   - If the sheet doesn't exist, no-op (workbook setup is a different concern).
 *   - If headers are missing or different, writes the canonical header row.
 *   - If the sheet is narrower than the canonical schema, columns are inserted.
 *   - Existing log rows below header are left intact (correlation_id will
 *     be empty for pre-v1.0 entries; that's expected).
 *
 * The schema is library-owned. A workbook owner who renamed "Status" to
 * "Severity" in row 1 would otherwise silently break the column-index reads;
 * this function corrects that.
 */
Log.ensureSchema = function(ss) {
  try {
    if (!ss) return;
    var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
    if (!logSheet) return;

    var lastCol = logSheet.getLastColumn();
    var needed  = LOG_HEADERS.length;

    // Pad columns if the sheet is narrower than the canonical schema.
    if (lastCol < needed) {
      var toAdd = needed - lastCol;
      logSheet.insertColumnsAfter(Math.max(lastCol, 1), toAdd);
    }

    // Read row 1 (headers). Empty/mismatched → rewrite canonical headers.
    var headerRange    = logSheet.getRange(1, 1, 1, needed);
    var currentHeaders = headerRange.getValues()[0].map(function(v) { return String(v).trim(); });

    var needsRewrite = false;
    for (var i = 0; i < needed; i++) {
      if (currentHeaders[i] !== LOG_HEADERS[i]) { needsRewrite = true; break; }
    }
    if (needsRewrite) {
      headerRange.setValues([LOG_HEADERS.slice()]);
      console.log('Log.ensureSchema: wrote canonical headers to ' + LOG_SHEET_NAME);
    }
  } catch (e) {
    console.warn('Log.ensureSchema failed: ' + e.message);
  }
};
