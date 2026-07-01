/**
 * @file 02_Core_Logging.gs
 * @desc Logging / notification utility.
 *
 *   Named AppLog (not Logger) on purpose: Apps Script has a built-in global
 *   `Logger` (Logger.log). Declaring our own `class Logger` shadows it across
 *   the whole project, so any later call to Logger.log() would throw. AppLog
 *   keeps the built-in reachable and matches the App* family (AppConfig,
 *   AppContext, AppFactory, AppHelpers).
 */
// -------------------------------------------------------------------------------------------------------
// LOGGING
//-------------------------------------------------------------------------------------------------------
/**
 * @class
 * @classdesc Static utility for logging to both the Apps Script console and the Sheets UI.
 */
class AppLog {
  /**
   * Logs a message to the console only if VERBOSE mode is enabled in Config.
   * @param {string} msg - The message to log.
   */
  static verbose(msg) {
    if (AppConfig.get().VERBOSE) console.log(`[VERBOSE] ${msg}`);
  }
  /**
   * Logs to console and displays a Toast notification in the active Spreadsheet.
   * @param {string} msg - The message to display.
   * @param {boolean} [isError=false] - If true, logs as console.error and styles toast as error.
   */
  static notify(msg, isError = false) {
    if (isError) console.error(msg);
    else console.log(msg);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) ss.toast(msg, isError ? "Error" : "Success", 5);
    } catch (e) {
      // console.log("UI notification skipped.");
    }
  }
}