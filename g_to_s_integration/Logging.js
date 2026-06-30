/**
 * Logging.gs — append-to-sheet logger for the contract intake pipeline.
 * Add as another file in the SAME project (it calls getConfigSpreadsheet_()).
 * -----------------------------------------------------------------------------
 * Reuses the dual-write AppLogger pattern: every call writes to a _logs tab AND
 * to Stackdriver (console). The sheet is the human-visible audit; the console is
 * the fallback if the sheet write fails. It NEVER swallows — the failure mode
 * that killed the old _script_logs attempt was a try/catch eating the error.
 *
 * Three deliberate choices, all learned the hard way:
 *   1. No LockService here. Both entry points already hold the script lock, so
 *      every append is already serialized. appendRow() is used instead of
 *      getLastRow()+setValues() so there's no manual last-row race to begin with.
 *   2. The log sheet name is a constant, NOT a config key. Logging must keep
 *      working even when readConfig_ is the thing that just threw — otherwise you
 *      can't log the config failure. (The old bug: an undefined config key made a
 *      sheet literally named "undefined".)
 *   3. The tab is created visible. (The old one was hidden, so it looked empty.)
 *
 * The Correlation ID column threads logs to contracts: filter _logs by a
 * correlation_id to trace one contract from extraction through push.
 * -----------------------------------------------------------------------------
 */

const LOG_SHEET_NAME = '_logs';
const LOG_HEADERS = ['Timestamp', 'Level', 'Context', 'Correlation ID', 'Message', 'Details'];

var logSheetCache_ = null;   // cached for the duration of one execution

function logInfo_(ctx, msg, corr, details)  { writeLog_('INFO',  ctx, msg, corr, details); }
function logWarn_(ctx, msg, corr, details)  { writeLog_('WARN',  ctx, msg, corr, details); }
function logError_(ctx, msg, corr, details) { writeLog_('ERROR', ctx, msg, corr, details); }

function writeLog_(level, ctx, msg, corr, details) {
  // Console first, so there is ALWAYS a trail even if the sheet write fails.
  var line = formatLogLine_(level, ctx, msg, corr, details);
  if (level === 'ERROR')      console.error(line);
  else if (level === 'WARN')  console.warn(line);
  else                        console.log(line);

  try {
    var sheet = getLogSheet_();
    sheet.appendRow([new Date(), level, ctx || '', corr || '', String(msg),
                     details ? String(details) : '']);
    var bg = (level === 'ERROR') ? '#fde7e9' : (level === 'WARN') ? '#fff4e5' : null;
    if (bg) sheet.getRange(sheet.getLastRow(), 1, 1, LOG_HEADERS.length).setBackground(bg);
  } catch (e) {
    // Do not throw out of the logger — but do not hide it either.
    console.error('Log sheet write failed: ' + e.message + ' | dropped: ' + line);
  }
}

/** Pure (testable) one-line rendering used for the console trail. */
function formatLogLine_(level, ctx, msg, corr, details) {
  return '[' + level + '] [' + (ctx || '') + ']' +
         (corr ? ' {' + corr + '}' : '') + ' ' + msg +
         (details ? ' — ' + details : '');
}

/** The _logs sheet, created with headers on first use, then cached. */
function getLogSheet_() {
  if (logSheetCache_) return logSheetCache_;
  var ss = getConfigSpreadsheet_();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  logSheetCache_ = sheet;
  return sheet;
}
