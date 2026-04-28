/**
 * @file main.gs (container-bound)
 *
 * Thin trigger and UI layer for the SDC platform. All real work lives
 * in the SDC library; this file only does what container scripts must:
 *
 *   - Define onOpen (must be a simple trigger in the container).
 *   - Resolve menu-callable function names in the container's global scope.
 *   - Translate library Result objects into spreadsheet UI.
 *
 * Library identifier: SDC. If adding the library to a new workbook,
 * set the identifier to SDC in Project Settings → Libraries. The shim
 * names below assume that identifier and will not work otherwise.
 *
 * @author Emily Cabaniss
 * @since  2026-04-27 (v1.0 — full library lift)
 */


// --- Menu ------------------------------------------------------------

/**
 * Builds the custom menu on spreadsheet open. Also runs the Log
 * schema self-heal so legacy workbooks gain the correlation_id column
 * silently on first open after the v1.0 library install.
 */
function onOpen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  // Self-heal _script_logs schema (additive, idempotent).
  SDC.Log.ensureSchema(ss);

  var menu = ui.createMenu('Supplier data collection')
    .addItem('Start supplier data collection', 'initializeOrUpdateWorkspace')
    .addItem('Update configuration',           'initializeOrUpdateWorkspace')
    .addSeparator()
    .addItem('Validate configuration',         'validateConfiguration')
    .addSeparator()
    .addItem('Request portal access',          'requestPortalAccess')
    .addSeparator()
    .addItem('Set up field IDs',               'setupPrimaryKeyColumns');

  // Migration menu item appears only when the workbook's schema lags
  // the library's. Self-detecting upgrade prompt — no manual
  // coordination across N workbooks.
  if (SDC.Migrations.isMigrationNeeded(ss)) {
    menu.addSeparator();
    menu.addItem('Migrate workbook schema…', 'migrateWorkbookSchema');
  }

  menu.addToUi();
}


// --- Flow shims ------------------------------------------------------

/**
 * Provision flow. Library does the work; container renders the Result.
 */
function initializeOrUpdateWorkspace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Sending to Workato…', 'Status');
  var r = SDC.Provision.run(ss);
  ss.toast('');
  showResult_(r);
}

/**
 * Validate flow.
 */
function validateConfiguration() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Validating configuration…', 'Status');
  var r = SDC.Validate.run(ss);
  ss.toast('');

  // Validate has a structured response body that goes in a modal,
  // separate from the success/failure alert.
  if (r.ok && r.data && r.data.validationResult) {
    showValidationResults_(r.data.validationResult);
  } else {
    showResult_(r);
  }
}

/**
 * Portal-invite flow.
 */
function requestPortalAccess() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var r  = SDC.Portal.run(ss);
  showResult_(r);
}


// --- Setup / maintenance shims --------------------------------------

/**
 * One-time PK column setup. Idempotent — safe to re-run on existing
 * workbooks; no-op for sheets already correctly configured.
 */
function setupPrimaryKeyColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var r  = SDC.PrimaryKey.setupColumns(ss);
  SpreadsheetApp.getUi().alert(
    r.ok ? 'Setup complete' : 'Setup completed with issues',
    r.message,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * Migrate the workbook to the library's expected schema version.
 * Confirmed before running because it mutates _developer_settings
 * and may change sheet structure in future versions.
 */
function migrateWorkbookSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var current = SDC.Migrations.currentWorkbookVersion(ss);
  var target  = SDC.Version.SCHEMA;

  var confirm = ui.alert(
    'Migrate workbook schema',
    'This will update the workbook from schema v' + current +
      ' to v' + target + '.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var r = SDC.Migrations.run(ss);
  ui.alert(
    r.ok ? 'Migration complete' : 'Migration incomplete',
    r.message,
    ui.ButtonSet.OK
  );
}


// --- UI translation --------------------------------------------------

/**
 * Translate any library Result into a single ui.alert. Title comes from
 * Result.flow, body from Result.message, alert variant inferred from
 * Result.ok. One translator for all three orchestrators — the contract
 * is that Result.message is always user-ready.
 */
function showResult_(r) {
  var ui    = SpreadsheetApp.getUi();
  var title = r.ok ? flowTitle_(r.flow) + ' — success'
                   : flowTitle_(r.flow) + ' — failed';
  ui.alert(title, r.message, ui.ButtonSet.OK);
}

/**
 * Render the validation results in a modal dialog (richer than alert).
 * Template lives in the container so workbooks can rebrand without
 * library changes.
 */
function showValidationResults_(validationResult) {
  var template  = HtmlService.createTemplateFromFile('validate_results');
  template.data = validationResult;

  var html = template.evaluate()
    .setWidth(720)
    .setHeight(520)
    .setTitle('Validation results');

  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}

function flowTitle_(flow) {
  switch (flow) {
    case 'provision':    return 'Provision';
    case 'validate':     return 'Validation';
    case 'portalInvite': return 'Portal invite';
    default:             return 'Operation';
  }
}
