/**
 * callback.gs
 * ───────────────────────────────────────────────────
 * Inbound webhook receiver for Workato → GAS callbacks.
 * Deployed as: Web app ("Execute as me", "Anyone with the link")
 *
 * Routing: POST body must include { "action": "<handler_name>" }
 * Auth:    Stub token check via Script Properties → CALLBACK_TOKEN
 *
 * To register a new action, add an entry to ACTION_HANDLERS.
 */

// ─── Configuration ──────────────────────────────────

const CALLBACK_LOGS_SHEET = '_script_logs';

const ACTION_HANDLERS = {
  callback_log: _handleCallbackLog,
  // future actions register here
};

// ─── Entry Point ────────────────────────────────────

/**
 * doPost(e) — routes inbound POSTs by action field.
 * Returns JSON response to caller (Workato HTTP action).
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // ── Auth stub ──
    // Set CALLBACK_TOKEN in Script Properties to enable.
    // Workato sends: body field "token"
    const expectedToken = PropertiesService.getScriptProperties().getProperty('CALLBACK_TOKEN');
    if (expectedToken) {
      const inboundToken = payload.token || (e.parameter && e.parameter.token);
      if (inboundToken !== expectedToken) {
        return _jsonResponse(403, { status: 'error', message: 'Invalid token' });
      }
    }

    // ── Route ──
    const action = payload.action;
    if (!action || !ACTION_HANDLERS[action]) {
      return _jsonResponse(400, {
        status: 'error',
        message: 'Unknown or missing action: ' + (action || '(none)'),
        valid_actions: Object.keys(ACTION_HANDLERS),
      });
    }

    const result = ACTION_HANDLERS[action](payload);
    return _jsonResponse(200, { status: 'ok', action: action, result: result });

  } catch (err) {
    return _jsonResponse(500, { status: 'error', message: err.message });
  }
}

// ─── Action Handlers ────────────────────────────────

/**
 * _handleCallbackLog — appends a row to _script_logs.
 *
 * Unified schema (shared with appendLog in main.gs):
 *   timestamp | correlation_id | source | log_level | message | supplier_request_id
 *
 * Expected payload fields:
 *   correlation_id       (required)
 *   message              (required)
 *   log_level            (optional, default INFO)
 *   supplier_request_id  (optional)
 */
function _handleCallbackLog(payload) {
  const correlationId = payload.correlation_id;
  const message = payload.message;

  if (!correlationId || !message) {
    throw new Error('callback_log requires correlation_id and message');
  }

  const logLevel = payload.log_level || 'INFO';
  const supplierRequestId = payload.supplier_request_id || '';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CALLBACK_LOGS_SHEET);

  if (!sheet) {
    throw new Error('Sheet "' + CALLBACK_LOGS_SHEET + '" not found. Run initial setup first.');
  }

  const row = [
    new Date().toISOString(),
    correlationId,
    'WORKATO',
    logLevel,
    message,
    supplierRequestId,
  ];

  sheet.appendRow(row);

  return { logged: true, correlation_id: correlationId };
}

// ─── Utilities ──────────────────────────────────────

/**
 * Returns a ContentService JSON response.
 * Note: GAS web apps always return HTTP 200 to the caller.
 * Logical status is embedded in the body as _http_status.
 */
function _jsonResponse(statusCode, body) {
  body._http_status = statusCode;
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Appends a log entry to the _script_logs sheet.
 *
 * Unified schema (shared with callback.gs):
 *   timestamp | correlation_id | source | log_level | message | supplier_request_id
 *
 * For GAS-originated entries, correlation_id and supplier_request_id
 * default to empty strings. The source is always "GAS".
 *
 * @param {string} status  - INFO | SUCCESS | ERROR | WARNING
 * @param {string} message - Log message text.
 * @param {Object} [opts]  - Optional fields.
 * @param {string} [opts.correlationId]      - Links to a Workato request.
 * @param {string} [opts.supplierRequestId]  - Populated when available.
 */
function appendLog(status, message, opts) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName('_script_logs');
    if (!logSheet) return;

    const o = opts || {};

    logSheet.appendRow([
      new Date().toISOString(),
      o.correlationId || '',
      'GAS',
      status,
      message,
      o.supplierRequestId || '',
    ]);
  } catch (_) {
    // Logging should never break the workflow
    console.warn('Failed to write to _script_logs: ' + _.message);
  }
}
