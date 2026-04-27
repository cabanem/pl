/**
 * @file main.gs
 * @description Thin trigger layer for the SDC platform.
 *
 * Two responsibilities:
 *   1. Serialize the master config spreadsheet as JSON → save to Drive
 *   2. Fire a webhook to Workato with pointers to the config + metadata
 *
 * Template generation has moved to Workato.
 * Config parsing and validation live in the SDC Platform Connector.
 *
 * @author Emily Cabaniss
 * @since  2026-03-30
 * @modified 2026-04-23  ++ validate configuration w/o deployment
 * @modified 2026-04-27  ++ config-driven destination folder (storage.configExportFolderId);
 *                        replaces unsafe getParents().next() iterator call
 * @modified 2026-04-27  ++ Workato OAuth account share is fatal-on-failure with
 *                        post-share verification; preflight email-shape check;
 *                        sharing.workatoOAuthEmail in _developer_settings.
 *                        ++ bug fixes: VALIDATE_FILE_PREFIX defined,
 *                        getSheetByName(name) arg restored, UrlFetchApp.fetch,
 *                        getContentText() parens.
 * @modified 2026-04-27  ++ extracted runPreflight_ helper; consolidated
 *                        repeated alert+log+return blocks across
 *                        initializeOrUpdateWorkspace and validateConfiguration.
 */


//  --- CONFIGURATION --------------------------------------------------
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
  '7_form',
  '_error_translation',
  '_mapping'
]);

/**
 * 7_form layout constants (0-indexed row/col positions).
 *
 * These describe the fixed structure of the 7_form sheet so that
 * buildFieldVisibilityMap can extract the visibility mapping without
 * hard-coding magic numbers inline.
 */
const FORM_LAYOUT = {
  HEADER_ROW:  4,   // "All fields | Data type | … | Visible?"
  DATA_START:  5,   // first field row
  FIELD_COL:   1,   // column B — field name (cast from 4_fields)
  VISIBLE_COL: 6    // column G — checkbox boolean
};

/** Values recognized as boolean true by coerceTruthy. */
const TRUTHY_VALUES = new Set(['true', '1', 'yes']);

/** Filename prefix for validate-only config exports (vs. provision exports). */
const VALIDATE_FILE_PREFIX = 'validate_';

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
      variants:    getSetting('sheets', 'variants', '6_variants'),
      form_ui:     getSetting('sheets', 'form', '7_form')
    },
    webhook: {
      url:              getSetting('webhook', 'fileExportUrl'),
      portalInviteUrl:  getSetting('webhook', 'portalInviteUrl'),
      validateUrl:      getSetting('webhook', 'validateUrl')
    },
    sharing: {
      // Optional: humans who get editor access on the config JSON for
      // troubleshooting/visibility. Failures here are warnings — the
      // workflow does not depend on these shares succeeding.
      authorizedEditors: (getSetting('sharing', 'authorizedEditors', '') || '')
        .split(',')
        .map(e => e.trim())
        .filter(e => e !== ''),
      // Required: the corporate mailbox Workato OAuths against. Workato
      // reads Drive files as this user, so this share is load-bearing —
      // failure here halts the workflow before the webhook fires.
      workatoOAuthEmail: (getSetting('sharing', 'workatoOAuthEmail', '') || '').trim()
    },
    storage: {
      // Explicit destination folder for serialized config JSON exports.
      // When set, makes serialization deterministic regardless of who runs
      // the script. When omitted, falls back to the spreadsheet's parent
      // folder (which is permission-sensitive — see resolveDestinationFolder_).
      configExportFolderId: getSetting('storage', 'configExportFolderId')
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


//  --- MENU -----------------------------------------------------------
/**
 * Builds the custom menu on spreadsheet open.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('Supplier data collection')
    .addItem('Start supplier data collection', 'initializeOrUpdateWorkspace')
    .addItem('Update configuration', 'initializeOrUpdateWorkspace')
    .addSeparator()
    .addItem('Validate configuration', 'validateConfiguration')
    .addSeparator()
    .addItem('Request portal access', 'requestPortalAccess');

  appendPkSetupMenuItem(menu);
  menu.addToUi();
}


//  --- LOGGING --------------------------------------------------------
/**
 * Appends a log entry to the _script_logs sheet.
 *
 * Columns: Timestamp | Status | User | Message
 *
 * @param {string} status  - INFO | SUCCESS | ERROR | WARNING
 * @param {string} message - Log message text.
 */
function appendLog(status, message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName('_script_logs');
    if (!logSheet) return;

    const user = Session.getActiveUser().getEmail() || 'unknown';
    logSheet.appendRow([new Date(), status, user, message]);
  } catch (_) {
    // Logging should never break the workflow
    console.warn('Failed to write to _script_logs: ' + _.message);
  }
}


//  --- ORCHESTRATOR ---------------------------------------------------
/**
 * Main entry point. Called from the custom menu.
 * Serializes the full config to Drive, then fires the webhook.
 */
function initializeOrUpdateWorkspace() {
  const CONFIG = buildConfig();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  appendLog('INFO', 'Starting workspace initialization…');

  let pf;
  try {
    pf = runPreflight_(CONFIG, {
      webhookUrl:          CONFIG.webhook.url,
      webhookLabel:        'fileExportUrl',
      requireCustomerData: true
    });
  } catch (e) {
    appendLog('ERROR', e.message);
    ui.alert('Error', e.message, ui.ButtonSet.OK);
    return;
  }

  const webhookUrl        = CONFIG.webhook.url;
  const workatoOAuthEmail = pf.workatoOAuthEmail;
  const clientName        = pf.clientName;
  const analystEmail      = pf.analystEmail;
  const targetVms         = pf.targetVms;
  const separateWorkspace = pf.separateWorkspace;

  //  1: Serialize config to Drive
  ss.toast('Serializing configuration…', 'Status');

  let configJsonFileId;
  try {
    configJsonFileId = serializeConfigToDrive(CONFIG);
    appendLog('INFO', 'Config serialized to Drive. File ID: ' + configJsonFileId);
  } catch (e) {
    appendLog('ERROR', 'Failed to serialize config: ' + e.message);
    ss.toast('');
    ui.alert('Error', 'Failed to serialize config:\n\n' + e.message, ui.ButtonSet.OK);
    return;
  }

  // 1b: Share the config JSON with the Workato OAuth account (FATAL on failure).
  // Must run BEFORE the webhook fires — if Workato can't read the file,
  // there is no point in handing it the file ID.
  try {
    shareFileWithIntegrationAccount_(configJsonFileId, workatoOAuthEmail);
  } catch (e) {
    appendLog('ERROR', 'Workato share failed: ' + e.message);
    ss.toast('');
    ui.alert('Error', 'Workato share failed:\n\n' + e.message, ui.ButtonSet.OK);
    return;
  }

  // 1c: Share the config JSON with authorized editors (warning-only).
  shareFileWithEditors(configJsonFileId, CONFIG.sharing.authorizedEditors);

  // 2: Build payload
  const correlationId = Utilities.getUuid();

  const payload = {
    correlation_id:             correlationId,
    client_name:                clientName,
    analyst_email:              analystEmail,
    target_vms:                 targetVms || '',
    config_file_id:             ss.getId(),
    template_file_ids:          '[]',
    timestamp:                  new Date().toISOString(),
    separate_workspace_required: String(separateWorkspace || false),
    drive_id_config_json:       configJsonFileId
  };

  // 3: Fire webhook
  ss.toast('Sending to Workato…', 'Status');

  try {
    sendWebhookNotification(webhookUrl, payload);
    appendLog('SUCCESS', 'Webhook delivered. Correlation ID: ' + correlationId);
  } catch (e) {
    appendLog('ERROR', 'Webhook failed: ' + e.message);
    ss.toast('');
    ui.alert(
      'Error',
      'Config was serialized to Drive, but the Workato webhook failed:\n\n' + e.message,
      ui.ButtonSet.OK
    );
    return;
  }

  // ── Done ────────────────────────────────────────────────
  ss.toast('');
  ui.alert(
    'Success',
    'Configuration sent to Workato.\n\nCorrelation ID: ' + correlationId,
    ui.ButtonSet.OK
  );
}


//  --- SERIALIZATION --------------------------------------------------
/**
 * Reads every connector-relevant sheet and produces a JSON object keyed by
 * sheet name, where each value is a 2D array of row arrays (the native
 * format returned by getDataRange().getValues()).
 *
 * Also builds derived structures:
 *   • _field_visibility — { fieldName: boolean } map extracted from 7_form.
 *     Provides a flat lookup so C-01 can resolve which fields belong on
 *     the manual-input form without parsing raw 2D arrays.
 *
 * Saves the JSON as a file in the same Drive folder as the spreadsheet.
 * Cleans up prior config exports to avoid Drive folder clutter.
 *
 * @returns {string} Google Drive file ID of the saved JSON file.
 */
function serializeConfigToDrive(CONFIG, purpose = 'provision') {
  // purpose: 'provision' (default, native behavior) or 'validate'.
  const executionPurpose = purpose;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const output = {};

  for (const sheet of ss.getSheets()) {
    const name = sheet.getName();
    if (!CONNECTOR_SHEETS.has(name)) continue;

    const data = sheet.getDataRange().getValues();

    // Convert Date objects to YYYY-MM-DD strings.
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

  // Derived: field visibility map from 7_form
  if (output['7_form']) {
    output['_field_visibility'] = buildFieldVisibilityMap(output['7_form']);
  }

  // Resolve destination folder (config-driven, with safe fallback)
  const parentFolder = resolveDestinationFolder_(CONFIG);

  // Branch on purpose for filename prefix
  const prefix = executionPurpose === 'validate'
    ? `${VALIDATE_FILE_PREFIX}${ss.getId()}_`
    : `config_${ss.getId()}_`;

  cleanupOldConfigFiles(parentFolder, prefix);

  // Save new config file
  const json     = JSON.stringify(output);
  const stamp    = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const fileName = `${prefix}${stamp}.json`;

  const blob = Utilities.newBlob(json, 'application/json', fileName);
  const file = parentFolder.createFile(blob);

  return file.getId();
}

/**
 * Resolves the Drive folder where serialized config JSON is written.
 *
 * Priority:
 *   1. _developer_settings → storage.configExportFolderId (preferred — deterministic).
 *   2. Fallback to the parent folder of the active spreadsheet.
 *
 * The fallback is permission-sensitive: getParents() returns only folders
 * the running user can see. A teammate with file access but no folder
 * access will get an empty iterator — which is the original cause of
 * "Cannot retrieve the next object: iterator has reached the end."
 *
 * Setting an explicit folder ID in _developer_settings sidesteps the
 * permissions class entirely and makes serialization deterministic
 * regardless of who runs the script.
 *
 * @param {Object} CONFIG - Output of buildConfig().
 * @returns {Folder} The resolved destination folder.
 * @throws  If neither path can resolve a folder.
 * @private
 */
function resolveDestinationFolder_(CONFIG) {
  const explicitId = String(
    (CONFIG && CONFIG.storage && CONFIG.storage.configExportFolderId) || ''
  ).trim();

  // Path 1: explicit folder ID from _developer_settings (preferred)
  if (explicitId) {
    try {
      return DriveApp.getFolderById(explicitId);
    } catch (e) {
      throw new Error(
        `Could not open destination folder (storage.configExportFolderId = "${explicitId}"). ` +
        `Verify the folder ID is correct and that the running user has access. ` +
        `Underlying error: ${e.message}`
      );
    }
  }

  // Path 2: fallback to the spreadsheet's parent folder, with a safe guard
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const ssFile  = DriveApp.getFileById(ss.getId());
  const parents = ssFile.getParents();

  if (!parents.hasNext()) {
    throw new Error(
      'Cannot determine a destination folder for the config JSON. ' +
      'The running user has no visible parent folder for this spreadsheet, ' +
      'and storage.configExportFolderId is not set in _developer_settings. ' +
      'Add an explicit folder ID under category "storage", key "configExportFolderId" ' +
      'to make config exports work for any user with file access.'
    );
  }

  return parents.next();
}

/**
 * Deletes prior config JSON exports from the target folder.
 * Matches files by the naming prefix `config_{spreadsheetId}_`.
 *
 * @param {Folder} folder - The Drive folder to scan.
 * @param {string} prefix - Filename prefix to match.
 */
function cleanupOldConfigFiles(folder, prefix) {
  try {
    const files = folder.getFilesByType('application/json');
    while (files.hasNext()) {
      const file = files.next();
      if (file.getName().startsWith(prefix)) {
        file.setTrashed(true);
        console.log('Trashed old config file: ' + file.getName());
      }
    }
  } catch (e) {
    // Non-fatal — log and continue
    console.warn('Config cleanup failed: ' + e.message);
  }
}

/**
 * Extracts a field-name → visible map from the raw 7_form 2D array.
 *
 * Only rows with a non-empty field name are included, so the placeholder
 * rows (empty name, visibility = false) are naturally excluded.
 *
 * Handles native booleans (from checkboxes) and string equivalents
 * ("TRUE", "1", "yes") for resilience against manual edits.
 *
 * @param {Array<Array>} formData - Raw 2D array from the 7_form sheet.
 * @returns {Object} e.g. { "Employee name": true, "Contract ID": true }
 */
function buildFieldVisibilityMap(formData) {
  const map = {};

  for (let i = FORM_LAYOUT.DATA_START; i < formData.length; i++) {
    const fieldName = String(formData[i][FORM_LAYOUT.FIELD_COL] || '').trim();
    if (fieldName === '') continue;

    map[fieldName] = coerceTruthy(formData[i][FORM_LAYOUT.VISIBLE_COL]);
  }

  return map;
}

/**
 * Coerces a cell value to a boolean.
 * Recognizes native true, "true", "1", "yes" (case-insensitive).
 *
 * @param {*} value - The raw cell value.
 * @returns {boolean}
 */
function coerceTruthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;
  return TRUTHY_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * Grants editor access on a Drive file to a list of email addresses.
 * Silently skips any addresses that fail (e.g., invalid email, external
 * sharing disabled by domain policy) and logs warnings instead of
 * blocking the workflow.
 *
 * @param {string}   fileId - Google Drive file ID.
 * @param {string[]} emails - Email addresses to grant editor access.
 */
function shareFileWithEditors(fileId, emails) {
  if (!emails || emails.length === 0) return;

  const file = DriveApp.getFileById(fileId);

  for (const email of emails) {
    try {
      file.addEditor(email);
      console.log(`Granted editor access to ${email} on file ${fileId}.`);
    } catch (e) {
      console.warn(`Could not share with ${email}: ${e.message}`);
    }
  }
}

/**
 * Lightweight email-shape validator.
 *
 * Catches blanks, missing @, and missing TLDs — enough to reject obvious
 * misconfigurations early. Cannot verify that the address corresponds to
 * a real account; that's only knowable end-to-end (e.g. via a Workato
 * test-connection webhook).
 *
 * @param {string} email
 * @returns {boolean}
 * @private
 */
function isValidEmailShape_(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Grants editor access to the Workato OAuth account on the given Drive
 * file, then verifies the share actually landed.
 *
 * Unlike shareFileWithEditors, this function is FATAL on any failure —
 * Workato reads Drive files as this user, so a missing share guarantees
 * the recipe will fail with a permissions error downstream. Halting here
 * surfaces the problem at its source rather than as a confusing error
 * inside Workato.
 *
 * Verification compares against file.getEditors() after addEditor returns.
 * This catches blanks, domain policy blocks, and external-sharing
 * restrictions, but not typos pointing at a non-existent in-domain
 * mailbox — for that, an end-to-end test-connection check is required.
 *
 * @param {string} fileId - Google Drive file ID.
 * @param {string} email  - The Workato OAuth account email.
 * @throws  If the share could not be established or verified.
 * @private
 */
function shareFileWithIntegrationAccount_(fileId, email) {
  const file = DriveApp.getFileById(fileId);

  try {
    file.addEditor(email);
  } catch (e) {
    throw new Error(
      `Could not grant Workato OAuth account (${email}) editor access on the ` +
      `config JSON file. Workato will not be able to read it. ` +
      `Underlying error: ${e.message}`
    );
  }

  // Verify: addEditor can succeed silently when the address is malformed
  // or blocked by policy in some edge cases. Confirm the address is
  // actually on the editor list before we proceed.
  const target  = email.trim().toLowerCase();
  const editors = file.getEditors().map(u => String(u.getEmail()).toLowerCase());

  if (!editors.includes(target)) {
    throw new Error(
      `Share with Workato OAuth account (${email}) returned without error, ` +
      `but the address is not present on the file's editor list. This usually ` +
      `indicates a domain sharing policy restriction or an invalid address. ` +
      `Verify sharing.workatoOAuthEmail in _developer_settings.`
    );
  }

  console.log(`Granted and verified editor access for Workato OAuth account: ${email}`);
}


//  --- WEBHOOK --------------------------------------------------------
/**
 * POSTs the payload to the Workato webhook with exponential backoff.
 *
 * Backoff schedule: 1s, 2s, 4s (attempt 0 → 2).
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

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response   = UrlFetchApp.fetch(webhookUrl, options);
      const statusCode = response.getResponseCode();

      if (statusCode >= 200 && statusCode < 300) {
        console.log('Webhook delivered successfully. Response: ' + response.getContentText());
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

    // Exponential backoff: 1s, 2s, 4s
    Utilities.sleep(Math.pow(2, attempt) * 1000);
  }
}


// --- REQUEST PORTAL ACCESS -------------------------------------------
/**
 * Fires a portal invite webhook for the active user.
 * Reads correlation_id from _script_logs (most recent SUCCESS entry)
 * so the invite can be tied back to the originating request in Workato.
 */
function requestPortalAccess() {
  const CONFIG = buildConfig();
  const ui     = SpreadsheetApp.getUi();

  const portalInviteUrl = CONFIG.webhook.portalInviteUrl;
  if (!portalInviteUrl) {
    ui.alert('Error', 'Portal invite URL not configured.\nCheck _developer_settings → webhook.portalInviteUrl.', ui.ButtonSet.OK);
    return;
  }

  const userEmail = Session.getActiveUser().getEmail();
  if (!userEmail) {
    ui.alert('Error', 'Could not resolve your email address. Ensure you are signed in with a Google account.', ui.ButtonSet.OK);
    return;
  }

  // Recover the correlation_id from the most recent successful run
  const correlationId = getMostRecentCorrelationId_();
  if (!correlationId) {
    ui.alert('Error', 'No completed workspace initialization found.\nRun "Start supplier data collection" first.', ui.ButtonSet.OK);
    return;
  }

  const payload = {
    correlation_id: correlationId,
    user_email:     userEmail,
    contact_name:   '',
    role:           'analyst'
  };

  try {
    sendWebhookNotification(portalInviteUrl, payload);
    appendLog('INFO', 'Portal invite sent for: ' + userEmail);
    ui.alert('Success', 'Portal access request sent for:\n' + userEmail, ui.ButtonSet.OK);
  } catch (e) {
    appendLog('ERROR', 'Portal invite failed: ' + e.message);
    ui.alert('Error', 'Portal invite failed:\n\n' + e.message, ui.ButtonSet.OK);
  }
}

/**
 * Scans _script_logs in reverse for the most recent correlation ID
 * logged on a SUCCESS entry. Returns null if none found.
 * @private
 */
function getMostRecentCorrelationId_() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName('_script_logs');
  if (!logSheet) return null;

  const data = logSheet.getDataRange().getValues();

  for (let i = data.length - 1; i >= 0; i--) {
    const status  = String(data[i][1]);
    const message = String(data[i][3]);

    if (status === 'SUCCESS' && message.includes('Correlation ID: ')) {
      return message.split('Correlation ID: ')[1].trim();
    }
  }

  return null;
}


// --- VALIDATE CONFIGURATION ------------------------------------------
/**
 * Validate the current configuration without provisioning. 
 * Called from the custom menu.
 */
function validateConfiguration() {
  const CONFIG = buildConfig();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  appendLog('INFO', 'Starting validation...');

  let pf;
  try {
    pf = runPreflight_(CONFIG, {
      webhookUrl:   CONFIG.webhook.validateUrl,
      webhookLabel: 'validateUrl'
    });
  } catch (e) {
    appendLog('ERROR', e.message);
    ui.alert('Error', e.message, ui.ButtonSet.OK);
    return;
  }

  const validateWebhookUrl = CONFIG.webhook.validateUrl;
  const workatoOAuthEmail  = pf.workatoOAuthEmail;

  // 1. Serialize to Drive (persist w/validate-only naming)
  ss.toast('Validating configuration...', 'Status');

  let configJsonFileId;
  try {
    configJsonFileId = serializeConfigToDrive(CONFIG, 'validate');
  } catch (e) {
    appendLog('ERROR', 'Validation serialization failed: ' + e.message);
    ss.toast('');
    ui.alert('Error', 'Failed to serialize configuration: \n\n' + e.message, ui.ButtonSet.OK);
    return;
  }

  // 1b. Share with Workato OAuth account (FATAL on failure).
  // Validation webhook also reads the file as the Workato user.
  try {
    shareFileWithIntegrationAccount_(configJsonFileId, workatoOAuthEmail);
  } catch (e) {
    appendLog('ERROR', 'Workato share failed: ' + e.message);
    ss.toast('');
    ui.alert('Error', 'Workato share failed:\n\n' + e.message, ui.ButtonSet.OK);
    return;
  }

  // 2. Call validation webhook
  const payload = {
    correlation_id:       Utilities.getUuid(),
    drive_id_config_json: configJsonFileId,
    requester_email:      Session.getActiveUser().getEmail() || 'unknown'
  };

  let validationResult;
  try {
    validationResult = callValidateWebhook_(validateWebhookUrl, payload);
    appendLog('INFO', 'Validation returned: ' + JSON.stringify(validationResult));
  } catch (e) {
    appendLog('ERROR', 'Validation webhook failed: ' + e.message);
    ss.toast('');
    ui.alert('Error', 'Validation failed:\n\n' + e.message, ui.ButtonSet.OK);
    return;
  }

  ss.toast('');

  // 3. Emit results via the UI
  showValidationResults_(validationResult);
}

/**
 * POST to the validation webhook and return the parsed response body.
 * Separate function because this one requires the response body, and not a
 * fire-and-forget acknowledgement.
 */
function callValidateWebhook_(webhookUrl, payload) {
  const options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response    = UrlFetchApp.fetch(webhookUrl, options);
  const statusCode  = response.getResponseCode();
  const body        = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Webhook returned HTTP ${statusCode}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`Webhook response was not valid JSON: ${body.substring(0, 200)}`);
  }
}

/**
 * Render the validation results in a modal dialog.
 */
function showValidationResults_(result) {
  const template = HtmlService.createTemplateFromFile('validate_results');
  template.data = result;

  const html = template.evaluate()
    .setWidth(720)
    .setHeight(520)
    .setTitle('Validation results');

  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}

//  --- HELPERS --------------------------------------------------------
/**
 * Searches a sheet for a label string and returns the first non-empty
 * value found in the three columns to its right.
 *
 * Works with the 1_customer layout where labels are in column B
 * and values are in column C (or D/E as fallback).
 *
 * Treats 0 and false as valid values (only null, undefined, and empty
 * string are considered blank).
 *
 * @param {Sheet}  sheet - The sheet to search.
 * @param {string} label - The label text to match (case-insensitive).
 * @returns {*} The value, or null if not found.
 */
function findValueByLabel(sheet, label) {
  const data   = sheet.getDataRange().getValues();
  const target = label.toLowerCase().trim();

  const notBlank = v => v !== null && v !== undefined && v !== '';

  for (let i = 0; i < data.length; i++) {
    for (let j = 0; j < data[i].length; j++) {
      if (String(data[i][j]).toLowerCase().trim() === target) {
        // Check up to 3 columns to the right, with bounds protection
        const maxOffset = Math.min(3, data[i].length - j - 1);
        for (let k = 1; k <= maxOffset; k++) {
          if (notBlank(data[i][j + k])) return data[i][j + k];
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Runs the common preflight checks for any flow that serializes config and
 * hands it to Workato. Throws on the first failure with a user-facing
 * message; returns resolved data on success.
 *
 * Throw-on-failure (rather than alert-and-return) keeps the contract
 * consistent with resolveDestinationFolder_ and shareFileWithIntegrationAccount_,
 * and lets each orchestrator handle UI/logging in one place via a single
 * try/catch.
 *
 * Checks performed:
 *   1. All CONNECTOR_SHEETS exist in the workbook.
 *   2. The customer sheet (per CONFIG.sheets.customer) is present.
 *   3. The supplied webhook URL is non-empty.
 *   4. CONFIG.sharing.workatoOAuthEmail is present and email-shaped.
 *   5. (Optional) Customer name and analyst email are populated in 1_customer.
 *
 * @param {Object} CONFIG - Output of buildConfig().
 * @param {Object} options
 * @param {string} options.webhookUrl   - The webhook URL value to validate (caller resolves).
 * @param {string} options.webhookLabel - User-facing _developer_settings key for error messages
 *                                        (e.g. 'fileExportUrl', 'validateUrl').
 * @param {boolean} [options.requireCustomerData=false] - When true, also pull and validate
 *                                                        customer fields from 1_customer.
 * @returns {Object} { customerSheet, workatoOAuthEmail, [clientName, analystEmail,
 *                     targetVms, separateWorkspace] }
 * @throws  Error with a user-facing message on any preflight failure.
 * @private
 */
function runPreflight_(CONFIG, options) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. All connector sheets present
  const missing = [...CONNECTOR_SHEETS].filter(name => !ss.getSheetByName(name));
  if (missing.length > 0) {
    throw new Error('Missing required sheets: ' + missing.join(', '));
  }

  // 2. Customer sheet present
  const customerSheet = ss.getSheetByName(CONFIG.sheets.customer);
  if (!customerSheet) {
    throw new Error(`Sheet "${CONFIG.sheets.customer}" not found.`);
  }

  // 3. Webhook URL configured
  if (!options.webhookUrl) {
    throw new Error(
      `Webhook URL not configured. Check _developer_settings → webhook.${options.webhookLabel}.`
    );
  }

  // 4. Workato OAuth account email present and well-formed
  const workatoOAuthEmail = CONFIG.sharing.workatoOAuthEmail;
  if (!workatoOAuthEmail || !isValidEmailShape_(workatoOAuthEmail)) {
    throw new Error(
      'Workato OAuth account email is missing or malformed. ' +
      'Check _developer_settings → sharing.workatoOAuthEmail. ' +
      'Workato cannot read the config file without this share.'
    );
  }

  // 5. Optional: customer data fields (provision path only)
  let customerData = {};
  if (options.requireCustomerData) {
    customerData = {
      clientName:        findValueByLabel(customerSheet, CONFIG.labels.customerName),
      analystEmail:      findValueByLabel(customerSheet, CONFIG.labels.analystEmail),
      targetVms:         findValueByLabel(customerSheet, CONFIG.labels.targetVMS),
      separateWorkspace: findValueByLabel(customerSheet, CONFIG.labels.separateWorkspace)
    };

    if (!customerData.clientName || !customerData.analystEmail) {
      throw new Error('Customer name and analyst email are required in the 1_customer tab.');
    }
  }

  return Object.assign({ customerSheet, workatoOAuthEmail }, customerData);
}


// --- PRIMARY KEY STAMPER ---------------------------------------------
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
      menu.addItem('Set up field IDs', 'setupPrimaryKeyColumns');
    }
  } catch (e) {
    menu.addSeparator();
    menu.addItem('Set up field IDs', 'setupPrimaryKeyColumns');
  }
}


// --- DEBUGGING -------------------------------------------------------
function debugUsersHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName('3_users');
  const row8 = ws.getRange(8, 1, 1, 7).getValues()[0];
  console.log('Row 8 raw values: ' + JSON.stringify(row8));
}
function debugHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName('3_users');
  // Check rows 6, 7, 8 to see where merged values exist
  const rows = ws.getRange(6, 1, 3, 7).getValues();
  rows.forEach((r, i) => console.log(`Row ${i+6}: ${JSON.stringify(r)}`));

  // Also check merges
  const merges = ws.getRange(1, 1, 10, 7).getMergedRanges();
  merges.forEach(m => console.log(`Merge: ${m.getA1Notation()}`));
}
function testDevApiCallableInvocation() {
  const CONFIG = buildConfig();
  const apiToken = '';
  const url = 'https://apim.eu.workato.com//configuration_management-v1/';


  const client = Lib_WorkatoClient.newClient(
    CONFIG.workato.apiToken,
    CONFIG.workato.baseUrl,
    { verbose: true }
  );

  try {
    const result = client.post(
      `/recipes/2013838/start`
    )
  } catch (e) {
    console.error('FAILED: ', e.message, e.statusCode);
  }
}
