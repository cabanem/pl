/**
 * Preview endpoint smoke test — STANDALONE.
 * Tests the "Test GAS <==> Workato" API Platform endpoint directly. Does NOT
 * depend on the SDC library, so you can validate the recipe before wiring up
 * Preview.run.
 *
 * Two ways to run:
 *   1. Editor: Run > runPreviewTest, then View > Logs.
 *   2. Deploy as Web app, open the URL in a browser (doGet).
 */

// --- Configure these ---------------------------------------------------------

// The API Platform endpoint URL for the preview recipe.
var PREVIEW_ENDPOINT_URL = 'https://PASTE_YOUR_ENDPOINT_URL_HERE';

// Drive file ID of a config JSON the recipe will parse. For the full pipeline
// (parse -> validate -> build) this must be a real config file that the WORKATO
// INTEGRATION ACCOUNT can read — share it the same way the real flow does.
// Leave '' for a transport-only smoke test (expect ok:false / a parse failure,
// but still HTTP 200 once you've made the 400 -> 200 fix).
var TEST_CONFIG_FILE_ID = '';

// Only if your API endpoint requires auth. '' = send no auth header (matches how
// Webhook.call sends today). Adjust the header NAME below to whatever your API
// client expects (Authorization: Bearer ..., api-token, x-api-key, etc.).
var PREVIEW_API_KEY = '';

// -----------------------------------------------------------------------------

/** Run from the editor; result also goes to the Logs. */
function runPreviewTest() {
  var result = callPreviewEndpoint_();
  Logger.log(formatTestResult_(result));
  return result;
}

/** Web-app entry point — deploy and open the URL to see the same summary. */
function doGet() {
  var result = callPreviewEndpoint_();
  return ContentService
    .createTextOutput(formatTestResult_(result))
    .setMimeType(ContentService.MimeType.TEXT);
}

/** Build a sample payload, POST it, capture status + parsed body. */
function callPreviewEndpoint_() {
  var payload = {
    correlation_id:      'test-' + Date.now(),
    config_json_file_id: TEST_CONFIG_FILE_ID,
    requester_email:     Session.getActiveUser().getEmail() || 'test@example.com',
    variant_id:          '',
    timestamp:           new Date().toISOString(),
    payload_version:     'test'
  };

  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true   // so we SEE 4xx/5xx instead of throwing
  };
  if (PREVIEW_API_KEY) {
    options.headers = { 'Authorization': 'Bearer ' + PREVIEW_API_KEY };
  }

  var resp   = UrlFetchApp.fetch(PREVIEW_ENDPOINT_URL, options);
  var body   = resp.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) {}

  return {
    sentPayload: payload,
    statusCode:  resp.getResponseCode(),
    rawBody:     body,
    parsed:      parsed
  };
}

/** Readable summary — reports the file's presence/size, not 60KB of base64. */
function formatTestResult_(r) {
  var lines = [];
  lines.push('HTTP status : ' + r.statusCode);   // expect 200 on BOTH paths

  var p = r.parsed;
  if (!p) {
    lines.push('Body was not JSON. First 500 chars:');
    lines.push((r.rawBody || '').substring(0, 500));
    return lines.join('\n');
  }

  lines.push('ok          : ' + p.ok);
  lines.push('verdict     : ' + JSON.stringify(p.verdict));
  if (p.suggested_filename) lines.push('filename    : ' + p.suggested_filename);
  if (p.metadata)           lines.push('metadata    : ' + JSON.stringify(p.metadata));

  if (p.file_content) {
    var kb = Math.round(p.file_content.length * 3 / 4 / 1024);
    lines.push('file_content: present, ' + p.file_content.length +
               ' base64 chars (~' + kb + ' KB decoded)');
  } else {
    lines.push('file_content: (none)');
  }
  return lines.join('\n');
}

/**
 * OPTIONAL — decode the returned file to Drive so you can open it and confirm
 * it's a real, valid XLSX (the true payoff of the test). Call it manually after
 * a successful run, e.g.  saveTestPreview_(runPreviewTest().parsed);
 */
function saveTestPreview_(parsed) {
  if (!parsed || !parsed.file_content) {
    Logger.log('No file_content to save.');
    return;
  }
  var bytes = Utilities.base64Decode(parsed.file_content);
  var blob  = Utilities.newBlob(
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parsed.suggested_filename || 'preview_test.xlsx'
  );
  var file = DriveApp.createFile(blob);   // lands in My Drive root; move as you like
  Logger.log('Saved: ' + file.getUrl());
}
