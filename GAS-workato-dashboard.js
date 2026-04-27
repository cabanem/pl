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

    var user = 'unknown';
    try {
      user = Session.getActiveUser().getEmail() || 'unknown';
    } catch (e) {
      // Identity unavailable in some trigger contexts — fall through.
    }

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
 *   - If headers are missing, writes the canonical header row.
 *   - If the CorrelationId column is missing, appends it.
 *   - Existing log rows below header are left intact (correlation_id will
 *     be empty for pre-v1.0 entries; that's expected).
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
    var headerRange  = logSheet.getRange(1, 1, 1, needed);
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



/**
 * @file Util.gs (SDC library)
 * Small, pure (or near-pure) primitives used across the library and
 * available to consumers. Nothing here knows about the SDC domain;
 * if it does, it belongs in a domain namespace.
 *
 * Public:
 *   Util.coerceTruthy(value)            → boolean
 *   Util.isValidEmailShape(email)       → boolean
 *   Util.newCorrelationId()             → string
 *   Util.findValueByLabel(sheet, label) → * | null
 */

var Util = {};

var TRUTHY_VALUES = Object.freeze(new Set(['true', '1', 'yes']));

/**
 * Coerce a cell value to boolean. Recognizes native true, and the strings
 * "true" / "1" / "yes" (case-insensitive, trimmed). Everything else → false.
 */
Util.coerceTruthy = function(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;
  return TRUTHY_VALUES.has(String(value).trim().toLowerCase());
};

/**
 * Lightweight email shape validator. Catches blanks, missing @, missing TLD.
 * Not a full RFC 5322 validator — that's a different problem.
 */
Util.isValidEmailShape = function(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

/**
 * Generate a new correlation ID for tracing a request across the SDC stack.
 * Currently a UUID; centralized here so future changes (prefixes, traceparent
 * compatibility, alternate ID schemes) are a single-function update.
 */
Util.newCorrelationId = function() {
  return Utilities.getUuid();
};

/**
 * Search a sheet for a label string and return the first non-empty value
 * found in the up-to-three columns to its right.
 *
 * Designed for the 1_customer layout: labels in column B, values in C
 * (with D/E as fallbacks for two-column-wide value cells or merged cells).
 *
 * Treats 0 and false as valid values — only null, undefined, and '' are blank.
 *
 * @param {Sheet}  sheet
 * @param {string} label - Matched case-insensitively after trim.
 * @returns {*} Value or null.
 */
Util.findValueByLabel = function(sheet, label) {
  if (!sheet || !label) return null;

  var data   = sheet.getDataRange().getValues();
  var target = String(label).toLowerCase().trim();

  var notBlank = function(v) { return v !== null && v !== undefined && v !== ''; };

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    for (var j = 0; j < row.length; j++) {
      if (String(row[j]).toLowerCase().trim() === target) {
        var maxOffset = Math.min(3, row.length - j - 1);
        for (var k = 1; k <= maxOffset; k++) {
          if (notBlank(row[j + k])) return row[j + k];
        }
        return null;
      }
    }
  }
  return null;
};


/**
 * @file Preflight.gs (SDC library)
 * Common pre-execution checks for any flow that serializes config and
 * hands it to Workato.
 *
 * Public:
 *   Preflight.run(ss, config, options) → { customerSheet, integrationAccountEmail,
 *                                           [clientName, analystEmail,
 *                                            targetVms, separateWorkspace] }
 *
 * Throw-on-failure contract: every check raises a user-facing Error on
 * the first failure. Orchestrators wrap the call in a single try/catch
 * and own UI/logging.
 *
 * Checks (in order):
 *   1. Schema sanity — _developer_settings present, schema version compatible.
 *      (Already enforced by Config.build; preflight does not re-check.)
 *   2. All CONNECTOR_SHEETS present in the workbook.
 *   3. The customer sheet (per config.sheets.customer) is present.
 *   4. The supplied webhook URL is non-empty.
 *   5. config.sharing.integrationAccountEmail is present and email-shaped.
 *   6. (Optional) Customer name and analyst email populated in 1_customer.
 */

var Preflight = {};

/**
 * @param {Spreadsheet} ss
 * @param {Object}      config
 * @param {Object}      options
 * @param {string}      options.webhookUrl                  - The URL to validate (caller resolves
 *                                                            from config.webhook.* and passes in).
 * @param {string}      options.webhookLabel                - The _developer_settings key for error
 *                                                            messages (e.g. 'fileExportUrl').
 * @param {boolean}     [options.requireCustomerData=false] - When true, also pull and validate
 *                                                            customer fields from 1_customer.
 * @returns {Object} { customerSheet, integrationAccountEmail,
 *                     [clientName, analystEmail, targetVms, separateWorkspace] }
 * @throws  Error with a user-facing message on any check failure.
 */
Preflight.run = function(ss, config, options) {
  if (!ss)      throw new Error('Preflight.run: ss is required.');
  if (!config)  throw new Error('Preflight.run: config is required.');
  if (!options) throw new Error('Preflight.run: options is required.');

  // 1. All connector sheets present
  var missing = [];
  CONNECTOR_SHEETS_ORDER.forEach(function(name) {
    if (!ss.getSheetByName(name)) missing.push(name);
  });
  if (missing.length > 0) {
    throw new Error(
      'Missing required sheets: ' + missing.join(', ') + '. ' +
      'These sheets are part of the workbook schema (v' + config.schemaVersion + ') ' +
      'and must be present for the SDC platform to read the configuration.'
    );
  }

  // 2. Customer sheet present (defensive — already covered by check 1, but the
  //    error message here is more specific to the customer-data flow.)
  var customerSheet = ss.getSheetByName(config.sheets.customer);
  if (!customerSheet) {
    throw new Error(
      'Sheet "' + config.sheets.customer + '" not found. ' +
      'This is the workbook\'s customer-information tab; check that it has not been ' +
      'renamed and that _developer_settings → sheets.customer matches.'
    );
  }

  // 3. Webhook URL configured
  if (!options.webhookUrl) {
    throw new Error(
      'Webhook URL not configured. ' +
      'Check _developer_settings → webhook.' + options.webhookLabel + '.'
    );
  }

  // 4. Workato OAuth account email present and well-formed
  var integrationAccountEmail = config.sharing.integrationAccountEmail;
  if (!integrationAccountEmail || !Util.isValidEmailShape(integrationAccountEmail)) {
    throw new Error(
      'Workato OAuth account email is missing or malformed. ' +
      'Check _developer_settings → sharing.integrationAccountEmail. ' +
      'Workato cannot read the config file without this share.'
    );
  }

  // 5. Optional: customer data fields (provision path only)
  var customerData = {};
  if (options.requireCustomerData) {
    customerData = {
      clientName:        Util.findValueRightOfLabel(customerSheet, Labels.customerName),
      analystEmail:      Util.findValueRightOfLabel(customerSheet, Labels.analystEmail),
      targetVms:         Util.findValueRightOfLabel(customerSheet, Labels.targetVMS),
      separateWorkspace: Util.findValueRightOfLabel(customerSheet, Labels.separateWorkspace)
    };

    if (!customerData.clientName || !customerData.analystEmail) {
      throw new Error(
        'Customer name and analyst email are required in the ' +
        config.sheets.customer + ' tab. ' +
        'Both fields must be filled in before the configuration can be sent to Workato.'
      );
    }
  }

  return Object.assign({
    customerSheet:           customerSheet,
    integrationAccountEmail: integrationAccountEmail
  }, customerData);
};



/**
 * @file Schema.gs (SDC library)
 * Structural facts about the SDC workbook. Library-owned and immutable
 * within a major schema version. Workbook owners do NOT override these
 * via _developer_settings — that's the contract boundary established
 * for v1.0.
 *
 * Anything in this file changing means the schema_version must bump and
 * a corresponding entry must land in Migrations.
 *
 * Exports (all top-level for cross-file access within the library):
 *   CONNECTOR_SHEETS         - Set of sheet names the connector reads.
 *   CONNECTOR_SHEETS_ORDER   - Array of the same names in canonical order.
 *   FORM_LAYOUT              - 7_form sheet structural constants.
 *   PRIMARY_KEY_COLUMNS      - PK column definitions per sheet.
 *   Labels                   - Label strings used in 1_customer.
 *
 * Co-located here because they all answer the same question: "what is
 * the structural shape of an SDC workbook?" Splitting them across files
 * would obscure the fact that they version together.
 */

// --- Connector sheets ------------------------------------------------

/**
 * Sheets the SDC Platform Connector expects in the serialized JSON.
 * Everything else (START_HERE, .user_guide, .math_notation, .regex,
 * _script_logs, _developer_settings) is excluded.
 *
 * Membership is checked via Set.has() in preflight; serialization
 * iterates CONNECTOR_SHEETS_ORDER for stable JSON output.
 */
var CONNECTOR_SHEETS = Object.freeze(new Set([
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
]));

/**
 * Canonical iteration order for serialization. Producing JSON with
 * stable key order makes diffs across re-publishes meaningful and
 * removes "why did the JSON change when I didn't change anything"
 * surprises caused by user tab reordering.
 *
 * Must contain exactly the same names as CONNECTOR_SHEETS — guarded
 * at library load (see bottom of file).
 */
var CONNECTOR_SHEETS_ORDER = Object.freeze([
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

// --- 7_form layout ---------------------------------------------------

/**
 * 0-indexed row/column positions in the 7_form sheet. Used by
 * Drive._buildFieldVisibilityMap to extract the field-name → visible
 * map without inline magic numbers.
 *
 *   HEADER_ROW:  index of the header row containing
 *                "All fields | Data type | … | Visible?"
 *   DATA_START:  index of the first field row
 *   FIELD_COL:   column B — field name (cast from 4_fields)
 *   VISIBLE_COL: column G — checkbox boolean
 */
var FORM_LAYOUT = Object.freeze({
  HEADER_ROW:  4,
  DATA_START:  5,
  FIELD_COL:   1,
  VISIBLE_COL: 6
});

// --- Primary-key columns ---------------------------------------------

/**
 * Primary-key column definitions. Each entry: in this sheet, this
 * 0-indexed column gets a PK named this, and data starts at this row.
 *
 * Replaces the four parallel comma-separated arrays under the
 * primary_keys category in pre-v1.0 _developer_settings.
 *
 * Note: dataStartRow values are lifted from the original
 * _developer_settings.primary_keys.data_start_row — verify against
 * the source workbook before cutting v1.0.
 */
var PRIMARY_KEY_COLUMNS = Object.freeze([
  Object.freeze({ sheetName: '4_fields',   colIndex: 0, fieldName: 'field_id',         dataStartRow: 8 }),
  Object.freeze({ sheetName: '5_lookups',  colIndex: 0, fieldName: 'lookup_table_id',  dataStartRow: 8 }),
  Object.freeze({ sheetName: '6_variants', colIndex: 0, fieldName: 'variant_id',       dataStartRow: 8 }),
  Object.freeze({ sheetName: '3_users',    colIndex: 0, fieldName: 'user_id',          dataStartRow: 8 })
]);

// --- 1_customer labels -----------------------------------------------

/**
 * Label strings searched for in the 1_customer sheet via
 * Util.findValueRightOfLabel. Structural per the v1.0 contract:
 * the workbook template owns these strings and clients don't edit them.
 *
 * Renaming any of these is a major schema bump because every workbook
 * built against v1.x has the old text in cell B<n>, and Util.findValueRightOfLabel
 * matches case-insensitively but exactly otherwise.
 */
var Labels = Object.freeze({
  customerName:      'Customer name',
  analystEmail:      'Analyst email address',
  folderId:          'Where should we save the template (Google Drive folder ID)?',
  separateWorkspace: 'Is a separate Workato workspace required?',
  targetVMS:         'What is the target vendor management system (VMS)?'
});

// --- Load-time guards ------------------------------------------------

/**
 * Self-check: Set and ordered array must agree. Catches the case where
 * a sheet is added to one but not the other — a silent bug in
 * serialization or preflight that would otherwise only surface in
 * production output.
 */
(function() {
  if (CONNECTOR_SHEETS_ORDER.length !== CONNECTOR_SHEETS.size) {
    throw new Error(
      'SDC library Schema.gs: CONNECTOR_SHEETS (size ' + CONNECTOR_SHEETS.size +
      ') and CONNECTOR_SHEETS_ORDER (length ' + CONNECTOR_SHEETS_ORDER.length +
      ') are out of sync.'
    );
  }
  for (var i = 0; i < CONNECTOR_SHEETS_ORDER.length; i++) {
    var name = CONNECTOR_SHEETS_ORDER[i];
    if (!CONNECTOR_SHEETS.has(name)) {
      throw new Error(
        'SDC library Schema.gs: "' + name + '" is in CONNECTOR_SHEETS_ORDER ' +
        'but not in CONNECTOR_SHEETS. Add it to both, or remove from order.'
      );
    }
  }

  // PK columns: each must reference a known connector sheet.
  PRIMARY_KEY_COLUMNS.forEach(function(cfg) {
    if (!CONNECTOR_SHEETS.has(cfg.sheetName)) {
      throw new Error(
        'SDC library Schema.gs: PRIMARY_KEY_COLUMNS references "' + cfg.sheetName +
        '" which is not in CONNECTOR_SHEETS.'
      );
    }
  });
})();


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
