/**
 * @file 41_Maintenance.js
 * @description
 *   Data-lifecycle maintenance actions, surfaced under the Advanced menu.
 *
 *   Why each exists:
 *   - Inventory/analysis sheets are OVERWRITE-on-sync (SheetService.write clears first), so they never accumulate 
 *     stale rows. "Reset" is for handoff, switching workspaces/tokens, or decommissioning (not routine hygiene)
 *     and is reversible, since a sync regenerates everything.
 *   - System_Logs is APPEND-only, so it grows without bound. Prune keeps the most recent N rows.
 *   - The Drive debug folder gets a new timestamped file per debug/doc run, so it grows too. Purge moves files older 
 *     than N days to Trash (recoverable), rather than hard-deleting.
 *
 *   All actions are confirmation-gated. Global entry points are at the bottom.
 */

class MaintenanceService {
  static _confirm_(title, message) {
    const ui = SpreadsheetApp.getUi();
    return ui.alert(title, message, ui.ButtonSet.YES_NO) === ui.Button.YES;
  }

  static _toast_(msg) {
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, "Maintenance", 4);
  }

  /**
   * Clear the inventory + call-graph analysis sheets back to just their headers.
   * Reuses SheetService.write so headers are re-created and formatted exactly as a sync would. Leaves Input_Requests, 
   * System_Logs, AI/process-map outputs, and the dashboard untouched. Reversible via a workspace sync.
   */
  static resetInventory() {
    const cfg = AppConfig.get();
    const keys = ["PROJECTS", "FOLDERS", "RECIPES", "PROPERTIES", "TABLES", "LOOKUP_TABLES", "DEPENDENCIES", "CALL_EDGES"];

    if (!this._confirm_(
      "Reset inventory sheets?",
      "Clears the data from Projects, Folders, Recipes, Properties, Data/Lookup Tables, " +
      "Dependencies, and Call Edges, leaving only the header row.\n\n" +
      "Input_Requests, System_Logs, and AI outputs are left alone. A workspace sync " +
      "regenerates everything, so this is reversible."
    )) return;

    const sheetSvc = new SheetService();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let cleared = 0;

    keys.forEach(k => {
      const headers = cfg.HEADERS[k];
      const name = cfg.SHEETS[k];
      if (!headers || !name) return;
      if (!ss.getSheetByName(name)) return; // don't create tabs for resources you never synced
      sheetSvc.write(k, [headers]);
      cleared++;
    });

    this._toast_(`Reset ${cleared} inventory sheet(s) to headers.`);
  }

  /**
   * Trim System_Logs to the most recent `keepLast` rows (header preserved).
   * @param {number} keepLast
   */
  static pruneSystemLogs(keepLast) {
    const cfg = AppConfig.get();
    const keep = Number(keepLast) > 0 ? Number(keepLast) : 500;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(cfg.SHEETS.DEBUG);

    if (!sheet) { this._toast_("No System_Logs sheet to prune."); return; }

    const dataRows = Math.max(0, sheet.getLastRow() - 1);
    if (dataRows <= keep) {
      this._toast_(`System_Logs has ${dataRows} row(s), under the ${keep} kept — nothing to prune.`);
      return;
    }

    const toDelete = dataRows - keep;
    if (!this._confirm_(
      "Prune System_Logs?",
      `System_Logs has ${dataRows} entries. This permanently deletes the ${toDelete} oldest, ` +
      `keeping the ${keep} most recent. This can't be undone.`
    )) return;

    sheet.deleteRows(2, toDelete); // oldest entries sit just under the header
    this._toast_(`Deleted ${toDelete} old log row(s).`);
  }

  /**
   * Move Drive debug files older than `days` to Trash (recoverable).
   * @param {number} days
   */
  static purgeDriveLogs(days) {
    const olderThanDays = Number(days) > 0 ? Number(days) : 30;

    if (!this._confirm_(
      "Clear old Drive debug files?",
      `Moves debug log files older than ${olderThanDays} days to Trash (recoverable for ~30 days). ` +
      `Recent files are kept.`
    )) return;

    const folder = this._debugFolder_();
    if (!folder) { this._toast_("No debug folder found; nothing to clear."); return; }

    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const files = folder.getFiles();
    let deleted = 0;
    while (files.hasNext()) {
      const f = files.next();
      if (f.getDateCreated() < cutoff) {
        f.setTrashed(true);
        deleted++;
      }
    }

    this._toast_(`Moved ${deleted} old debug file(s) to Trash.`);
  }

  /**
   * ***UPDATED*** One-time header widening for Output_QA_Log (8 -> 10 columns: Duration ms, Status).
   * appendRows_ writes a header only when it CREATES a tab, so a live tab keeps its old 8-cell header
   * while new asks write 10-cell rows -- this realigns row 1. Idempotent (checks the last header
   * cell) and additive only: data rows are never touched, and pre-migration rows read back with
   * empty duration/status, which recent() maps to 0 / "ok".
   */
  static upgradeQaLogHeader() {
    const cfg = AppConfig.get();
    const header = cfg.HEADERS.QA_LOG;
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.SHEETS.QA_LOG);
    if (!sh) {
      this._toast_("No Q&A log tab yet -- the first ask creates it with the full header.");
      return;
    }
    if (String(sh.getRange(1, header.length).getValue()) === header[header.length - 1]) {
      this._toast_("Q&A log header is already current.");
      return;
    }
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    this._toast_(`Q&A log header upgraded to ${header.length} columns.`);
  }

  // --- INTERNALS ---------------------------------------------------------------------------------------
  /**
   * Resolve the debug folder WITHOUT creating it (unlike DriveService, which creates + caches). Returns null 
   * if it doesn't exist; a purge shouldn't conjure an empty folder.
   * @private
   */
  static _debugFolder_() {
    const dbg = AppConfig.get().DEBUG;
    const id = ConfigStore.get('DEBUG_FOLDER_ID', { preferUser: true, defaultValue: "" });
    if (id) {
      try { return DriveApp.getFolderById(id); } catch (e) { /* stale id, fall through */ }
    }
    const it = DriveApp.getFoldersByName(dbg.DRIVE_FOLDER_NAME);
    return it.hasNext() ? it.next() : null;
  }
}

// ---------------------------------------------------------------------------------------
// Manual entrypoints (wired to the Advanced -> Maintenance menu)
// ---------------------------------------------------------------------------------------
function resetInventorySheets() { MaintenanceService.resetInventory(); }
function pruneSystemLogs()      { MaintenanceService.pruneSystemLogs(500); }
function purgeOldDriveLogs()    { MaintenanceService.purgeDriveLogs(30); }
function migrateQaLogHeaderV2()  { MaintenanceService.upgradeQaLogHeader(); }   // ***UPDATED***
