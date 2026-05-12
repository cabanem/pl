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
 * set the identifier to SDC in Project Settings â†’ Libraries. The shim
 * names below assume that identifier and will not work otherwise.
 *
 * @author Emily Cabaniss
 * @since  2026-04-27 (v1.0 â€” full library lift)
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
  // the library's. Self-detecting upgrade prompt â€” no manual
  // coordination across N workbooks.
  if (SDC.Migrations.isMigrationNeeded(ss)) {
    menu.addSeparator();
    menu.addItem('Migrate workbook schema...', 'migrateWorkbookSchema');
  }

  menu.addToUi();
}


// --- Flow shims ------------------------------------------------------

/**
 * Provision flow. Library does the work; container renders the Result.
 */
function initializeOrUpdateWorkspace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Sending to Workato...', 'Status');
  var r = SDC.Provision.run(ss);
  ss.toast('');
  showResult_(r);
}

/**
 * Validate flow. Renders structured validation results in a modal when
 * the success Result carries them; falls back to standard alert otherwise.
 */
function validateConfiguration() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Validating configuration...', 'Status');
  var r = SDC.Validate.run(ss);
  ss.toast('');

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
  ss.toast('Requesting portal access...', 'Status');
  var r = SDC.Portal.run(ss);
  ss.toast('');
  showResult_(r);
}


// --- Setup / maintenance shims --------------------------------------

/**
 * One-time PK column setup. Idempotent â€” safe to re-run on existing
 * workbooks; no-op for sheets already correctly configured.
 *
 * Now returns a canonical Result; routed through the shared translator.
 */
function setupPrimaryKeyColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var r  = SDC.PrimaryKey.setupColumns(ss);
  showResult_(r);
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
  showResult_(r);
}


// --- UI translation --------------------------------------------------

/**
 * Translate any canonical Result into a single ui.alert.
 *
 * Title:
 *   - Success, no warnings: "<Flow> â€” success"
 *   - Success, warnings:    "<Flow> â€” success with warnings"
 *   - Failure:              "<Flow> â€” failed"
 *
 * Body composition (in order):
 *   1. Result.message (always)
 *   2. Warnings block (when warnings.length > 0)
 *   3. Correlation ID line (only for Workato-talking flows: provision,
 *      validate, portalInvite â€” other flows generate IDs for log
 *      correlation but the user has nothing to do with them)
 *
 * Defensive: handles undefined/missing Result by surfacing a clear
 * "no result returned" alert rather than a TypeError. This shouldn't
 * happen with the current library but protects against future shim
 * mistakes.
 */
function showResult_(r) {
  var ui = SpreadsheetApp.getUi();

  if (!r) {
    ui.alert('Operation', 'No result returned from the library. This is a bug.', ui.ButtonSet.OK);
    return;
  }

  var flowLabel    = flowTitle_(r.flow);
  var hasWarnings  = Array.isArray(r.warnings) && r.warnings.length > 0;
  var titleSuffix  = r.ok
    ? (hasWarnings ? ' â€” success with warnings' : ' â€” success')
    : ' â€” failed';
  var title        = flowLabel + titleSuffix;

  var bodyParts = [String(r.message || '(no message)')];

  if (hasWarnings) {
    bodyParts.push('');
    bodyParts.push('Warnings:');
    r.warnings.forEach(function(w) {
      bodyParts.push('  â€¢ ' + w);
    });
  }

  if (showsCorrelationId_(r.flow) && r.correlationId) {
    bodyParts.push('');
    bodyParts.push('Correlation ID: ' + r.correlationId);
  }

  ui.alert(title, bodyParts.join('\n'), ui.ButtonSet.OK);
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
    .setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}

/**
 * Map canonical flow names to user-facing titles. Falls back to a
 * generic "Operation" if the library introduces a flow name this
 * shim doesn't know about â€” the alert still renders, just without
 * a flow-specific title.
 */
function flowTitle_(flow) {
  switch (flow) {
    case 'provision':       return 'Provision';
    case 'validate':        return 'Validation';
    case 'portalInvite':    return 'Portal invite';
    case 'primaryKeySetup': return 'Field ID setup';
    case 'migration':       return 'Schema migration';
    default:                return 'Operation';
  }
}

/**
 * True for flows whose correlation ID has cross-system meaning (matches
 * a Workato request). Setup and migration generate correlation IDs for
 * log-line tying but the user has nothing to look up with them.
 */
function showsCorrelationId_(flow) {
  return flow === 'provision' || flow === 'validate' || flow === 'portalInvite';
}
