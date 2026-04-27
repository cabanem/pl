/**
 * @file Drive.gs (SDC library)
 * Serialization of workbook config to Drive, plus folder resolution,
 * cleanup, and Drive sharing.
 *
 * Public:
 *   Drive.serializeConfig(ss, config, options)        → fileId
 *   Drive.resolveDestinationFolder(ss, config)        → Folder
 *   Drive.shareWithEditors(fileId, emails)            → { granted, failed }
 *   Drive.shareWithIntegrationAccount(fileId, email)  → void (throws)
 *
 * Envelope shape (co-mingled, underscore-prefixed metadata):
 *   {
 *     _meta: { schema_version, library_version, payload_version,
 *              purpose, workbook_id, serialized_at },
 *     _field_visibility: { fieldName: bool, ... },
 *     "1_customer": [[...]], "2_suppliers": [[...]], ...
 *   }
 */

var Drive = {};

// --- Constants -------------------------------------------------------
var FILE_PREFIX_PROVISION = 'config_';
var FILE_PREFIX_VALIDATE  = 'validate_';

// --- Public API ------------------------------------------------------

/**
 * Serialize the workbook's connector-relevant sheets to a JSON file on Drive.
 *
 * Cleanup rule (asymmetric):
 *   - purpose='provision' → trashes ALL prior config_{ssId}_* AND validate_{ssId}_*
 *     for this workbook. A successful provision invalidates everything prior.
 *   - purpose='validate'  → trashes nothing. User manages validate-file
 *     accumulation manually; validation is a preview, not a commit.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config        - From Config.build(ss).
 * @param {Object}      [options]
 * @param {string}      [options.purpose='provision'] - 'provision' | 'validate'.
 * @returns {string} Drive file ID of the saved JSON.
 */
Drive.serializeConfig = function(ss, config, options) {
  if (!ss)     throw new Error('Drive.serializeConfig: ss is required.');
  if (!config) throw new Error('Drive.serializeConfig: config is required.');

  var opts    = options || {};
  var purpose = opts.purpose || 'provision';
  if (purpose !== 'provision' && purpose !== 'validate') {
    throw new Error('Drive.serializeConfig: purpose must be "provision" or "validate".');
  }

  var tz     = ss.getSpreadsheetTimeZone();
  var output = {};

  // 1. Read connector-relevant sheets in canonical order (stable JSON output)
  for (var i = 0; i < CONNECTOR_SHEETS_ORDER.length; i++) {
    var name  = CONNECTOR_SHEETS_ORDER[i];
    var sheet = ss.getSheetByName(name);
    if (!sheet) continue;  // preflight should have caught this; defensive

    var data = sheet.getDataRange().getValues();
    output[name] = Drive._normalizeDates(data, tz);
  }

  // 2. Derived: field visibility from 7_form
  if (output['7_form']) {
    output['_field_visibility'] = Drive._buildFieldVisibilityMap(output['7_form']);
  }

  // 3. Envelope metadata
  output['_meta'] = {
    schema_version:  config.schemaVersion,
    library_version: SDC_LIBRARY_VERSION,
    payload_version: SDC_PAYLOAD_VERSION,
    purpose:         purpose,
    workbook_id:     ss.getId(),
    serialized_at:   new Date().toISOString()
  };

  // 4. Resolve destination
  var folder = Drive.resolveDestinationFolder(ss, config);

  // 5. Cleanup — asymmetric per workflow rule
  var ssId = ss.getId();
  if (purpose === 'provision') {
    Drive._cleanupOldFiles(folder, [
      FILE_PREFIX_PROVISION + ssId + '_',
      FILE_PREFIX_VALIDATE  + ssId + '_'
    ]);
  }
  // purpose === 'validate' → no cleanup

  // 6. Write
  var prefix   = (purpose === 'validate' ? FILE_PREFIX_VALIDATE : FILE_PREFIX_PROVISION)
               + ssId + '_';
  var stamp    = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  var fileName = prefix + stamp + '.json';
  var json     = JSON.stringify(output);
  var blob     = Utilities.newBlob(json, 'application/json', fileName);
  var file     = folder.createFile(blob);

  return file.getId();
};

/**
 * Resolve where serialized config should land.
 *   1. config.storage.configExportFolderId (preferred — deterministic).
 *   2. Spreadsheet's parent folder (fallback — permission-sensitive).
 * @throws If neither path resolves to a folder.
 */
Drive.resolveDestinationFolder = function(ss, config) {
  var explicitId = String(
    (config && config.storage && config.storage.configExportFolderId) || ''
  ).trim();

  if (explicitId) {
    try {
      return DriveApp.getFolderById(explicitId);
    } catch (e) {
      throw new Error(
        'Could not open the destination folder ' +
        '(storage.configExportFolderId = "' + explicitId + '"). ' +
        'Verify the folder ID and that the running user has access. ' +
        'Underlying error: ' + e.message
      );
    }
  }

  var ssFile  = DriveApp.getFileById(ss.getId());
  var parents = ssFile.getParents();

  if (!parents.hasNext()) {
    throw new Error(
      'Cannot determine a destination folder for the config JSON. ' +
      'The running user has no visible parent folder for this spreadsheet, ' +
      'and storage.configExportFolderId is not set. ' +
      'Add an explicit folder ID under category "storage", key "configExportFolderId" ' +
      'in _developer_settings.'
    );
  }

  return parents.next();
};

/**
 * Grant editor access on a Drive file to a list of emails. Non-fatal:
 * collects per-email outcomes. Use for the human "audit/visibility" share list.
 *
 * @param {string}   fileId
 * @param {string[]} emails
 * @returns {{granted: string[], failed: Array<{email: string, error: string}>}}
 */
Drive.shareWithEditors = function(fileId, emails) {
  var result = { granted: [], failed: [] };
  if (!emails || emails.length === 0) return result;

  var file = DriveApp.getFileById(fileId);

  for (var i = 0; i < emails.length; i++) {
    var email = emails[i];
    try {
      file.addEditor(email);
      result.granted.push(email);
    } catch (e) {
      result.failed.push({ email: email, error: e.message });
      console.warn('Could not share with ' + email + ': ' + e.message);
    }
  }
  return result;
};

/**
 * Grant editor access to the Workato OAuth account and verify the share landed.
 * Fatal on failure — Workato cannot read the file otherwise.
 *
 * @throws If the share fails or cannot be verified.
 */
Drive.shareWithIntegrationAccount = function(fileId, email) {
  var file = DriveApp.getFileById(fileId);

  try {
    file.addEditor(email);
  } catch (e) {
    throw new Error(
      'Could not grant Workato OAuth account (' + email + ') editor access on the ' +
      'config JSON file. Workato will not be able to read it. ' +
      'Underlying error: ' + e.message
    );
  }

  // Verify: addEditor can succeed silently when the address is malformed
  // or blocked by domain policy. Confirm the address is on the editor list.
  var target  = email.trim().toLowerCase();
  var editors = file.getEditors().map(function(u) {
    return String(u.getEmail()).toLowerCase();
  });

  if (editors.indexOf(target) === -1) {
    throw new Error(
      'Share with Workato OAuth account (' + email + ') returned without error, ' +
      'but the address is not present on the file\'s editor list. This usually ' +
      'indicates a domain sharing policy restriction or an invalid address. ' +
      'Verify sharing.integrationAccountEmail in _developer_settings.'
    );
  }

  console.log('Granted and verified editor access for Workato OAuth account: ' + email);
};

// --- Private helpers -------------------------------------------------

/**
 * Normalize Date instances to yyyy-MM-dd strings. Currently date-only;
 * if a datetime field is added to any connector sheet, branch on
 * cell.getHours()/getMinutes() here to preserve time. Numeric date-formatted
 * cells come through as numbers (formatting is presentation-only) and are
 * not normalized.
 */
Drive._normalizeDates = function(data, tz) {
  return data.map(function(row) {
    return row.map(function(cell) {
      if (cell instanceof Date) {
        return Utilities.formatDate(cell, tz, 'yyyy-MM-dd');
      }
      return cell;
    });
  });
};

Drive._buildFieldVisibilityMap = function(formData) {
  var map = {};
  for (var i = FORM_LAYOUT.DATA_START; i < formData.length; i++) {
    var fieldName = String(formData[i][FORM_LAYOUT.FIELD_COL] || '').trim();
    if (fieldName === '') continue;
    map[fieldName] = Sheet.coerceTruthy(formData[i][FORM_LAYOUT.VISIBLE_COL]);
  }
  return map;
};

/**
 * Trash JSON files in `folder` whose names start with any of the given prefixes.
 * Single folder pass regardless of prefix count. Non-fatal — logs and continues.
 */
Drive._cleanupOldFiles = function(folder, prefixes) {
  if (!prefixes || prefixes.length === 0) return;

  try {
    var files = folder.getFilesByType('application/json');
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      for (var i = 0; i < prefixes.length; i++) {
        if (name.indexOf(prefixes[i]) === 0) {
          file.setTrashed(true);
          console.log('Trashed old config file: ' + name);
          break;
        }
      }
    }
  } catch (e) {
    console.warn('Config cleanup failed: ' + e.message);
  }
};



/**
 * @file Webhook.gs (SDC library)
 * Single HTTP transport for all SDC webhook calls. Uniform retry policy,
 * uniform error contract, library-stamped payload_version.
 *
 * Public:
 *   Webhook.call(url, payload, options) → { statusCode, body, parsed }
 *
 * Retry policy:
 *   - 2xx        → success, return
 *   - 3xx        → returned as success (UrlFetchApp follows redirects;
 *                  if one slips through, pass it through unchanged)
 *   - 4xx (≠429) → permanent, throw immediately, no retry
 *   - 429        → retry with backoff (rate limit)
 *   - 5xx        → retry with backoff (transient server)
 *   - exception  → retry with backoff (network)
 *
 *   Backoff: 1s, 2s, 4s between attempts (max 3 attempts total).
 *
 * payload_version is injected by the library and cannot be overridden by
 * the caller — even if the caller's payload contains a payload_version key,
 * the library's value wins.
 */

var Webhook = {};

var WEBHOOK_MAX_ATTEMPTS = 3;
var WEBHOOK_BASE_DELAY_MS = 1000;

/**
 * POST a JSON payload to a webhook URL. Returns parsed response if JSON,
 * raw body otherwise.
 *
 * @param {string} url
 * @param {Object} payload                  - Caller payload. payload_version
 *                                            will be stamped by the library.
 * @param {Object} [options]
 * @param {number} [options.maxAttempts=3]  - Total attempts including the first.
 * @returns {{statusCode: number, body: string, parsed: (Object|null)}}
 * @throws  Error on permanent failure or after exhausting retries.
 */
Webhook.call = function(url, payload, options) {
  if (!url)     throw new Error('Webhook.call: url is required.');
  if (!payload) throw new Error('Webhook.call: payload is required.');

  var opts        = options || {};
  var maxAttempts = opts.maxAttempts || WEBHOOK_MAX_ATTEMPTS;

  // Library-controlled payload_version — non-spoofable from caller.
  var enriched = {};
  for (var k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      enriched[k] = payload[k];
    }
  }
  enriched.payload_version = SDC_PAYLOAD_VERSION;

  var fetchOptions = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(enriched),
    muteHttpExceptions: true
  };

  var lastError = null;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var response, statusCode, body;

    try {
      response   = UrlFetchApp.fetch(url, fetchOptions);
      statusCode = response.getResponseCode();
      body       = response.getContentText();
    } catch (e) {
      lastError = new Error('Network exception on attempt ' + (attempt + 1) + ': ' + e.message);
      if (attempt < maxAttempts - 1) {
        Utilities.sleep(Webhook._backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    // 2xx and 3xx → success
    if (statusCode >= 200 && statusCode < 400) {
      return {
        statusCode: statusCode,
        body:       body,
        parsed:     Webhook._tryParseJson(body)
      };
    }

    // 4xx except 429 → permanent
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      throw new Error('Webhook ' + statusCode + ' (permanent): ' + Webhook._truncate(body, 500));
    }

    // 429 or 5xx → retry-eligible
    lastError = new Error('Webhook ' + statusCode + ' on attempt ' + (attempt + 1) +
                          ': ' + Webhook._truncate(body, 500));
    if (attempt < maxAttempts - 1) {
      Utilities.sleep(Webhook._backoffMs(attempt));
    }
  }

  throw new Error('Webhook failed after ' + maxAttempts + ' attempts. Last error: ' +
                  lastError.message);
};

// --- Private helpers -------------------------------------------------

Webhook._backoffMs = function(attempt) {
  return Math.pow(2, attempt) * WEBHOOK_BASE_DELAY_MS;
};

Webhook._tryParseJson = function(body) {
  if (!body) return null;
  try { return JSON.parse(body); }
  catch (e) { return null; }
};

Webhook._truncate = function(s, max) {
  s = String(s || '');
  return s.length > max ? s.substring(0, max) + '…' : s;
};



/**
 * @file Payload.gs (SDC library)
 * Webhook payload builders. One builder per webhook contract.
 *
 * Builders own the wire format (snake_case) and the field-name contract.
 * Callers pass JS-idiomatic camelCase args; builders translate.
 *
 * payload_version is NOT stamped here — Webhook.call owns that invariant.
 *
 * Public:
 *   Payload.provision(args)    → object
 *   Payload.validate(args)     → object
 *   Payload.portalInvite(args) → object
 *
 * Each builder validates its required args and throws on missing/blank.
 * Optional fields are normalized (e.g. boolean → 'true'/'false' string).
 */

var Payload = {};

// --- Provision -------------------------------------------------------

/**
 * Build the provision webhook payload (R-1 Receive Webhook contract).
 *
 * @param {Object} args
 * @param {string} args.correlationId        - UUID linking the request across systems.
 * @param {string} args.clientName           - From 1_customer.
 * @param {string} args.analystEmail         - From 1_customer.
 * @param {string} args.configFileId         - The workbook's own Drive file ID (ss.getId()).
 * @param {string} args.configJsonFileId     - The serialized JSON's Drive file ID.
 * @param {string} [args.targetVms='']       - Optional, from 1_customer.
 * @param {boolean} [args.separateWorkspace=false] - From 1_customer.
 * @param {Array}  [args.templateFileIds=[]] - Reserved for future template uploads.
 * @returns {Object} wire-format payload
 */
Payload.provision = function(args) {
  Payload._requireArgs(args, ['correlationId', 'clientName', 'analystEmail',
                               'configFileId', 'configJsonFileId'], 'provision');

  return {
    correlation_id:              args.correlationId,
    client_name:                 args.clientName,
    analyst_email:               args.analystEmail,
    target_vms:                  args.targetVms || '',
    config_file_id:              args.configFileId,
    config_json_file_id:         args.configJsonFileId,
    template_file_ids:           args.templateFileIds || [],
    separate_workspace_required: Boolean(args.separateWorkspace),
    timestamp:                   new Date().toISOString()
  };
};

// --- Validate --------------------------------------------------------

/**
 * Build the validate webhook payload.
 */
Payload.validate = function(args) {
  Payload._requireArgs(args, ['correlationId', 'configJsonFileId', 'requesterEmail'],
                       'validate');

  return {
    correlation_id:      args.correlationId,
    config_json_file_id: args.configJsonFileId,
    requester_email:     args.requesterEmail,
    timestamp:           new Date().toISOString()
  };
};

// --- Portal invite ---------------------------------------------------

/**
 * Build the portal invite webhook payload.
 */
Payload.portalInvite = function(args) {
  Payload._requireArgs(args, ['correlationId', 'userEmail', 'role'], 'portalInvite');

  return {
    correlation_id: args.correlationId,
    user_email:     args.userEmail,
    contact_name:   args.contactName || '',
    role:           args.role,
    timestamp:      new Date().toISOString()
  };
};

// --- Private ---------------------------------------------------------

Payload._requireArgs = function(args, required, builderName) {
  if (!args) {
    throw new Error('Payload.' + builderName + ': args object is required.');
  }
  for (var i = 0; i < required.length; i++) {
    var k = required[i];
    var v = args[k];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      throw new Error('Payload.' + builderName + ': "' + k + '" is required and must be non-empty.');
    }
  }
};
