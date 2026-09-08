/**
 * @file Code.gs — DrivePicker library
 * @summary Let a visitor to an Apps Script web app pick files from THEIR Drive and hand the host the bytes.
 *
 * The library knows two things: how to put the Google Picker in a page, and how to turn a pick into a Blob using
 * the visitor's own access token. It knows nothing about the host's folders, logs, or business rules — the host
 * decides what to do with the Blob. That boundary is what makes it reusable.
 *
 * PUBLIC SURFACE (everything else ends in `_` and is invisible to consumers)
 *   VERSION              var, so it crosses the library boundary (const/let do not)
 *   clientHtml()         -> string  the <script> block that defines window.DrivePicker in the host page
 *   fetchPicked(pick, token, opts) -> Blob  download (or export) one picked file with the visitor's token
 *
 * WHY THE VISITOR'S TOKEN
 *   A web app deployed "Execute as: Me" has only the deployer's authority server-side, and the page in the browser
 *   has none. The Picker needs to show the VISITOR's Drive, so the page obtains a short-lived token for the visitor
 *   via Google Identity Services (scope drive.file), the Picker uses it to browse, and the host sends it back with
 *   the pick so fetchPicked() can download the file the visitor chose. UrlFetchApp runs under the host's
 *   authorization, but the Authorization header carries the visitor's token, so Drive answers for the visitor.
 *
 * HOST INTEGRATION (three lines, see README)
 *   appsscript.json  dependencies.libraries: [{ userSymbol: 'DrivePicker', libraryId: '<this script id>', version: 'N' }]
 *   template         <?!= DrivePicker.clientHtml() ?>
 *   server shim      function importPicked(p) { return stage_(DrivePicker.fetchPicked(p.pick, p.token)); }
 *   google.script.run cannot call library functions, hence the shim.
 */

/** @type {string} Library version. `var` on purpose: const/let are not visible to consuming projects. */
var VERSION = '1.0.0';

/** @type {string} Drive v3 files endpoint. */
var DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files/';

/** @type {string} Prefix shared by every native Google type (Docs, Sheets, Slides, Forms, ...). */
var GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/**
 * Native types that can be exported, and the format used when the host does not choose one.
 * Anything native and not listed here (Forms, Sites, Maps, ...) cannot be downloaded and is refused.
 * @type {Object.<string,string>}
 */
var DEFAULT_EXPORT = {
  'application/vnd.google-apps.document':     'application/pdf',
  'application/vnd.google-apps.spreadsheet':  'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing':      'application/pdf'
};

/** @type {Object.<string,string>} Export MIME -> file extension appended to the exported name. */
var EXPORT_EXT = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv'
};

// --- PUBLIC ---------------------------------------------------------------------------------

/**
 * The browser half of the library: a <script> block defining window.DrivePicker.mount(opts).
 * Inline it in the host's HtmlService TEMPLATE with a printing scriptlet:  <?!= DrivePicker.clientHtml() ?>
 * (createHtmlOutputFromFile here resolves against the LIBRARY's files, which is what lets a library ship UI.)
 * @return {string}
 */
function clientHtml() {
  return HtmlService.createHtmlOutputFromFile('Client').getContent().replace(/\{\{VERSION\}\}/g, VERSION);
}

/**
 * Download one picked file with the visitor's token and return it as a named Blob.
 *
 * Non-native files (PDF, Word, images, ...) are fetched as-is. Native Google files (Docs, Sheets, Slides) cannot
 * be downloaded and are EXPORTED instead — to PDF by default, or to `opts.exportMime` — and the exported name gets
 * the matching extension. Drive caps exports at 10 MB.
 *
 * @param {{id:string, name:string, mimeType:string}} pick One entry from DrivePicker.mount's onPicked(files).
 * @param {string} token The visitor's access token, as passed to onPicked.
 * @param {{exportMime:(string|undefined)}} [opts]
 * @return {GoogleAppsScript.Base.Blob}
 * @throws {Error} A plain-language message the host can show verbatim.
 */
function fetchPicked(pick, token, opts) {
  opts = opts || {};
  var plan = downloadPlan_(pick, opts.exportMime);
  if (!token) throw new Error('No access token was supplied for the Drive download.');

  var resp = UrlFetchApp.fetch(plan.url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error(describeDriveError_(code, resp.getContentText(), plan.name));

  var blob = resp.getBlob().setName(plan.name);
  if (plan.mimeType) blob.setContentType(plan.mimeType);
  return blob;
}

// --- PURE HELPERS (unit-tested in Tests.gs) -----------------------------------------------------

/**
 * Decide how a pick is fetched: media download for real files, export for native Google files.
 * @param {{id:string, name:string, mimeType:string}} pick
 * @param {string} [exportMime] Host's preferred export format for native files.
 * @return {{url:string, name:string, mimeType:?string, exported:boolean}}
 * @throws {Error} If nothing usable was picked or the native type cannot be exported.
 * @private
 */
function downloadPlan_(pick, exportMime) {
  if (!pick || !pick.id) throw new Error('Nothing was picked.');
  var id = String(pick.id);
  var mime = String(pick.mimeType || '');
  var name = String(pick.name || id).trim() || id;

  if (isGoogleNative_(mime)) {
    var target = exportMime || DEFAULT_EXPORT[mime];
    if (!target) {
      throw new Error('"' + name + '" is a Google ' + mime.slice(GOOGLE_NATIVE_PREFIX.length) +
        ' and cannot be downloaded or exported.');
    }
    return {
      url: DRIVE_FILES_API + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(target),
      name: withExt_(name, EXPORT_EXT[target]),
      mimeType: target,
      exported: true
    };
  }

  return {
    url: DRIVE_FILES_API + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true',
    name: name,
    mimeType: mime || null,
    exported: false
  };
}

/**
 * @param {string} mime
 * @return {boolean} Whether this is a native Google type (Docs, Sheets, Slides, Forms, ...).
 * @private
 */
function isGoogleNative_(mime) {
  return String(mime || '').indexOf(GOOGLE_NATIVE_PREFIX) === 0;
}

/**
 * Append an extension unless the name already ends with it.
 * @param {string} name
 * @param {string} [ext] Without the dot; falsy leaves the name alone.
 * @return {string}
 * @private
 */
function withExt_(name, ext) {
  if (!ext) return name;
  return name.toLowerCase().slice(-(ext.length + 1)) === '.' + ext.toLowerCase() ? name : name + '.' + ext;
}

/**
 * Turn a Drive API failure into a sentence a person can act on.
 * @param {number} code HTTP status.
 * @param {string} body Response body (JSON error from Drive, usually).
 * @param {string} name File name, for the message.
 * @return {string}
 * @private
 */
function describeDriveError_(code, body, name) {
  var reason = '';
  try {
    var j = JSON.parse(body);
    reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) ||
             (j.error && j.error.message) || '';
  } catch (e) { /* not JSON */ }

  if (code === 401) {
    return 'Drive rejected the sign-in token (expired or revoked). Try again to sign in afresh.';
  }
  if (code === 403) {
    if (/rateLimit|quota/i.test(reason)) return 'Drive is rate-limiting requests right now. Try again in a minute.';
    return 'Drive refused access to "' + name + '". With the drive.file scope the app can only read files chosen ' +
      'through the picker in this session — pick it again to grant access.' + (reason ? ' (' + reason + ')' : '');
  }
  if (code === 404) {
    return '"' + name + '" was not found in Drive, or is not shared with you.';
  }
  return 'Drive returned ' + code + (reason ? ': ' + reason : '') + ' for "' + name + '".';
}
