/**
 * @file Wrappers.gs
 * @description Thin controller layer. Handles UI triggers and menu bindings.
 *   All business logic delegates to CoreLib.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * {@link https://docs.google.com/document/d/1y0h4llJKnaXaiqP562QWElgQbY7l9KzSdOz7hjgENZ8/edit|internal_technical_documentation}
 *
 * DESIGN RULE: No business logic lives here. Every menu handler follows:
 *   get ss → call CoreLib.fn(ss) → last-resort catch if CoreLib itself throws.
 *
 * CHANGES FROM ORIGINAL:
 *  - Fixed string concatenation bug in menu_syncWorkflowIdentifiers catch block:
 *    the original had '... + error.message' inside the string literal, so the
 *    actual error message was never shown to the user — it printed the literal
 *    text "+ error.message".
 *  - Simplified catch blocks on the four workflow menu handlers (menu_generateTemplate,
 *    menu_injectSeedData, menu_sendOutreach, menu_initializeWorkspace). CoreLib
 *    orchestrators now catch, alert, and return without rethrowing, so the Wrappers
 *    catch should only fire for unexpected failures (e.g. CoreLib itself not loaded).
 *    Catch blocks are kept but marked as last-resort safety nets, and their alert
 *    text clarifies this. Previously they could produce double-alert dialogs when
 *    CoreLib re-threw after already alerting.
 */

// ---------------------------------------------------------------------------
// MENU SETUP
// ---------------------------------------------------------------------------

function onOpen(e) {
  const ui = SpreadsheetApp.getUi();
  try {
    ui.createMenu('Supplier data collection')
      .addItem('1. Initialize workspace (Deploy)',      'menu_initializeWorkspace')
      .addSeparator()
      .addItem('2. Generate and export blank template', 'menu_generateTemplate')
      .addItem('3. Integrate incumbent data',           'menu_injectSeedData')
      .addItem('4. Send supplier outreach',             'menu_sendOutreach')
      .addSeparator()
      .addSubMenu(ui.createMenu('Developer tools')
        .addItem('Setup audit trigger',                        'setupInstallableTrigger')
        .addItem('Manage tab visibility',                      'openTabManagerUi')
        .addItem('Hide Admin tabs',                            'hideAllAdminTabs')
        .addItem('Show Admin tabs',                            'showAllAdminTabs')
        .addItem('Sync known workflow IDs from customer sheet','menu_syncWorkflowIdentifiers')
        .addItem('Show supplier request mappings',             'menu_showSupplierRequestMappings')
        .addItem('Clear cached script config data',            'resetConfigCache'))
      .addToUi();
  } catch (err) {
    console.error('Menu creation failed: ' + err.toString());
  }
}

// ---------------------------------------------------------------------------
// INSTALLABLE TRIGGER
// ---------------------------------------------------------------------------

/**
 * Installable onEdit handler. Must be installable (not a simple trigger) so it
 * can access LockService and write to sheets other than the active one.
 * Install via Developer tools → Setup audit trigger.
 */
function processEditEvent(e) {
  const ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
  CoreLib.processEditEvent(e, ss);
}

/**
 * Creates the processEditEvent installable trigger if one does not already exist.
 * Idempotent — safe to run multiple times.
 */
function setupInstallableTrigger() {
  const ui           = SpreadsheetApp.getUi();
  const functionName = 'processEditEvent';
  const ss           = SpreadsheetApp.getActiveSpreadsheet();

  try {
    const existing = ScriptApp.getProjectTriggers();
    for (let i = 0; i < existing.length; i++) {
      if (existing[i].getHandlerFunction() === functionName) {
        ui.alert('Status', 'The audit tracking trigger is already installed.', ui.ButtonSet.OK);
        return;
      }
    }
    ScriptApp.newTrigger(functionName).forSpreadsheet(ss).onEdit().create();
    ui.alert('Success', 'Audit tracking trigger installed successfully.', ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Error', 'Failed to create trigger: ' + error.message, ui.ButtonSet.OK);
  }
}

// ---------------------------------------------------------------------------
// WORKFLOW MENU HANDLERS
// ---------------------------------------------------------------------------

/**
 * CoreLib orchestrators catch their own errors, alert the user, and return.
 * The catch blocks below are last-resort safety nets for unexpected failures
 * (e.g. a library load error). They should not fire in normal operation.
 */

function menu_generateTemplate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    CoreLib.runTemplateGeneration(ss);
  } catch (error) {
    SpreadsheetApp.getUi().alert('Unexpected error in Template Generation:\n\n' + error.message);
  }
}

function menu_injectSeedData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    CoreLib.runInjectSeedData(ss);
  } catch (error) {
    SpreadsheetApp.getUi().alert('Unexpected error in Seed Data Injection:\n\n' + error.message);
  }
}

function menu_sendOutreach() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    CoreLib.runSupplierOutreach(ss);
  } catch (error) {
    SpreadsheetApp.getUi().alert('Unexpected error in Supplier Outreach:\n\n' + error.message);
  }
}

function menu_initializeWorkspace() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const response = ui.alert('Initialize Workspace', 'Provision the database tables. Proceed?', ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;
  try {
    CoreLib.runWorkspaceInitialization(ss);
  } catch (error) {
    ui.alert('Unexpected error in Workspace Initialization:\n\n' + error.message);
  }
}

// ---------------------------------------------------------------------------
// DEVELOPER TOOLS MENU HANDLERS
// ---------------------------------------------------------------------------

function menu_syncWorkflowIdentifiers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const synced = CoreLib.syncKnownIdentifiersFromCustomerSheet(ss);
    const keys   = Object.keys(synced || {}).filter(k => !k.startsWith('last_'));
    SpreadsheetApp.getUi().alert(
      'Workflow ID sync',
      keys.length > 0
        ? 'Synced identifiers:\n\n' + keys.map(k => `${k}: ${synced[k]}`).join('\n')
        : 'No known workflow identifiers were found in the customer sheet.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (error) {
    // FIXED: original had the + operator inside the string literal, so
    // 'error.message' was printed as a literal string, not the actual error.
    SpreadsheetApp.getUi().alert('Workflow ID sync error:\n\n' + error.message);
  }
}

function menu_showSupplierRequestMappings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const mapObj = CoreLib.getSupplierRequestMap(ss);
    const pretty = JSON.stringify(mapObj, null, 2);
    const html   = HtmlService.createHtmlOutput(
      '<div style="font-family:monospace; white-space:pre-wrap; padding:12px; max-height:600px; overflow:auto;">' +
      escapeHtml_(pretty) +
      '</div>'
    ).setWidth(700).setHeight(600);
    SpreadsheetApp.getUi().showModalDialog(html, 'Supplier Request Mappings');
  } catch (error) {
    SpreadsheetApp.getUi().alert('Supplier request mapping error:\n\n' + error.message);
  }
}

function resetConfigCache() {
  CoreLib.resetConfigCache();
}

function hideAllAdminTabs() {
  CoreLib.hideAllAdminTabs(SpreadsheetApp.getActiveSpreadsheet());
}

function showAllAdminTabs() {
  CoreLib.showAllAdminTabs(SpreadsheetApp.getActiveSpreadsheet());
}

// ---------------------------------------------------------------------------
// TAB MANAGER UI
// ---------------------------------------------------------------------------

function openTabManagerUi() {
  const html = HtmlService.createHtmlOutputFromFile('TabManagerUi').setWidth(400).setHeight(500);
  SpreadsheetApp.getUi().showModalDialog(html, 'Manage tab visibility');
}

/** Called by google.script.run inside TabManagerUi.html */
function getSheetVisibilities() {
  return CoreLib.getSheetVisibilities(SpreadsheetApp.getActiveSpreadsheet());
}

/** Called by google.script.run inside TabManagerUi.html */
function applyTabVisibilities(selections) {
  CoreLib.applyTabVisibilities(selections, SpreadsheetApp.getActiveSpreadsheet());
}

// ---------------------------------------------------------------------------
// INTERNAL UTILITIES
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters for safe rendering in modal dialogs.
 * Handles the three characters needed for JSON display: &, <, >
 * @private
 */
function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// html

<!DOCTYPE html>
<html>
  <head>
    <base target="_top">
    <!--
      TabManagerUi.html
      Modal dialog for managing spreadsheet tab visibility.

      Checked  = tab is visible.
      Unchecked = tab is hidden.

      Calls getSheetVisibilities() on load to populate the list.
      Calls applyTabVisibilities(selections) on save.

      CHANGES FROM ORIGINAL:
       - No logic changes. Minor formatting and comment cleanup only.
    -->
    <style>
      body {
        font-family: Arial, sans-serif;
        padding: 15px;
        margin: 0;
        color: #333;
        box-sizing: border-box;
        height: 100vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      /* main-ui uses flex column so the checkbox list scrolls independently */
      #main-ui {
        display: none;
        flex-direction: column;
        height: 100%;
      }

      .instruction {
        font-size: 13px;
        color: #555;
        margin-bottom: 12px;
        background-color: #f1f3f4;
        padding: 10px;
        border-radius: 4px;
        border-left: 4px solid #1a73e8;
        flex-shrink: 0;
      }

      /* flex-grow + min-height: 0 enables inner scrolling */
      .container {
        flex-grow: 1;
        overflow-y: auto;
        min-height: 0;
        margin-bottom: 15px;
        border-bottom: 1px solid #ddd;
        padding-bottom: 10px;
      }

      .sheet-row { display: flex; align-items: center; margin-bottom: 10px; }
      .sheet-row input { margin-right: 10px; cursor: pointer; width: 16px; height: 16px; }
      .sheet-row label { cursor: pointer; font-size: 14px; }

      .btn-container {
        display: flex;
        justify-content: space-between;
        flex-shrink: 0;
      }

      button { padding: 8px 15px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px; }
      .btn-save          { background-color: #1a73e8; color: white; }
      .btn-save:hover    { background-color: #1557b0; }
      .btn-save:disabled { background-color: #8ab4f8; cursor: not-allowed; }
      .btn-cancel        { background-color: #f1f3f4; color: #333; }
      .btn-cancel:hover  { background-color: #e8eaed; }

      #loading { font-size: 14px; color: #666; font-style: italic; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div id="loading">Loading tabs...</div>

    <div id="main-ui">
      <div class="instruction">
        <strong>&#9745; Checked</strong> = Tab is visible in the sheet.<br>
        <strong>&#9744; Unchecked</strong> = Tab is hidden from view.
      </div>

      <div class="container" id="checkbox-container"></div>

      <div class="btn-container">
        <button class="btn-cancel" onclick="google.script.host.close()">Cancel</button>
        <button class="btn-save"   onclick="saveSettings()" id="saveBtn">Save Changes</button>
      </div>
    </div>

    <script>
      google.script.run
        .withSuccessHandler(renderCheckboxes)
        .withFailureHandler(function(err) {
          document.getElementById('loading').innerText = 'Error loading tabs: ' + err.message;
        })
        .getSheetVisibilities();

      function renderCheckboxes(sheets) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('main-ui').style.display = 'flex';

        var container = document.getElementById('checkbox-container');

        sheets.forEach(function(sheet, index) {
          var row      = document.createElement('div');
          row.className = 'sheet-row';

          var checkbox   = document.createElement('input');
          checkbox.type  = 'checkbox';
          checkbox.id    = 'sheet_' + index;
          checkbox.value = sheet.name;
          checkbox.checked = !sheet.isHidden;

          var label      = document.createElement('label');
          label.htmlFor  = 'sheet_' + index;
          label.innerText = sheet.name;

          row.appendChild(checkbox);
          row.appendChild(label);
          container.appendChild(row);
        });
      }

      function saveSettings() {
        var saveBtn = document.getElementById('saveBtn');
        saveBtn.innerText  = 'Saving...';
        saveBtn.disabled   = true;

        var checkboxes = document.querySelectorAll('#checkbox-container input[type="checkbox"]');
        var selections = Array.from(checkboxes).map(function(cb) {
          return { name: cb.value, isHidden: !cb.checked };
        });

        google.script.run
          .withSuccessHandler(function() { google.script.host.close(); })
          .withFailureHandler(function(err) {
            alert(err.message);
            saveBtn.innerText = 'Save Changes';
            saveBtn.disabled  = false;
          })
          .applyTabVisibilities(selections);
      }
    </script>
  </body>
</html>
