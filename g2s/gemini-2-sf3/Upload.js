/**
 * @file Upload.gs
 * @summary Drag-and-drop intake from the dashboard. The browser reads the dropped file, sends it as base64 through
 * google.script.run, and uploadContract() decodes it and creates it in the Intake folder. That is ALL it does. From
 * there the file enters the pipeline exactly as if someone had dropped it into the folder in Drive: same poller,
 * same review sheet, same Chat card, same log. No new path, no new state.
 *
 * @description Why it is built this way:
 *   1. The page has no Drive credentials. It runs in the visitor's browser inside HtmlService's iframe, with no OAuth
 *      token of its own. google.script.run is the only authenticated channel back to the project, and it carries
 *      JSON-serializable values only — so the file crosses as a base64 string and becomes a Blob again here, where
 *      the deployer's authority creates it in Drive.
 *   2. Base64 costs a third more bytes. The cap is INLINE_PDF_MAX_BYTES, the same limit callGemini_ enforces, so
 *      nothing is accepted here that extraction would reject five minutes later.
 *   3. The MIME type comes from the file EXTENSION, not the browser. Browsers report '' or application/octet-stream
 *      for .docx on some machines, and buildExtractionParts_ switches on the Drive MIME we set here.
 *   4. Identity. The web app executes as the deployer, so the file is created by (and owned as) the deployer. The
 *      visitor's email is available via Session.getActiveUser() because visitor and deployer share a Workspace
 *      domain; it is recorded in the log row and the file's Drive description so provenance survives. This needs
 *      the userinfo.email scope in appsscript.json.
 *   5. Access. Anyone who can open the dashboard can call uploadContract. If that is wider than "people who may
 *      submit contracts", set Config key upload_allowed_emails (comma/newline list); empty means everyone.
 */

/** @const {Object.<string,string>} Accepted extensions -> Drive MIME type. Google Docs are not files and cannot be uploaded. */
const UPLOAD_TYPES = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword'
};

/**
 * Receive one file from the dashboard and create it in the Intake folder.
 * @param {{name:string, size:number, base64:string}} file What the browser sent.
 * @return {{name:string, url:string}} Shown on the page as a link.
 * @throws {Error} With a plain-language reason; the page shows err.message verbatim.
 */
function uploadContract(file) {
  const cfg = readConfig_();
  const who = uploaderEmail_();
  assertUploadAllowed_(who, cfg.upload_allowed_emails);

  const v = validateUpload_(file, INLINE_PDF_MAX_BYTES);
  if (!v.ok) throw new Error(v.reason);

  const bytes = Utilities.base64Decode(file.base64);
  if (bytes.length > INLINE_PDF_MAX_BYTES) {                 // client size is advisory; this is the real check
    throw new Error('File is larger than ' + mb_(INLINE_PDF_MAX_BYTES) + ' MB.');
  }

  const blob = Utilities.newBlob(bytes, v.mimeType, v.name);
  const created = DriveApp.getFolderById(cfg.folder_id_ingestion).createFile(blob);
  created.setDescription('Uploaded via dashboard' + (who ? ' by ' + who : '') + ' at ' + new Date().toISOString());

  // Message carries the uploader; Details stays a bare URL so the dashboard renders it as a link.
  logInfo_('uploadContract', 'Uploaded ' + v.name + (who ? ' (' + who + ')' : ''), '', created.getUrl());
  return { name: v.name, url: created.getUrl() };
}

/**
 * Check the upload before touching Drive. Pure.
 * @param {{name:string, size:number, base64:string}} file
 * @param {number} maxBytes
 * @return {{ok:true, name:string, mimeType:string}|{ok:false, reason:string}}
 * @private
 */
function validateUpload_(file, maxBytes) {
  if (!file || typeof file.base64 !== 'string' || !file.base64) return { ok: false, reason: 'No file content received.' };
  const raw = String(file.name || '').replace(/[\\/]/g, '_').trim();
  if (!raw) return { ok: false, reason: 'The file has no name.' };
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : '';
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const name = stem.slice(0, 180) + (ext ? '.' + ext : '');   // cap the stem, never the extension
  const mimeType = UPLOAD_TYPES[ext];
  if (!mimeType) {
    return { ok: false, reason: 'Only PDF and Word (.docx, .doc) files can be uploaded here. A Google Doc can be moved into the Intake folder in Drive instead.' };
  }
  if (Number(file.size) > maxBytes) {
    return { ok: false, reason: '"' + name + '" is ' + mb_(file.size) + ' MB; the limit is ' + mb_(maxBytes) + ' MB.' };
  }
  return { ok: true, name: name, mimeType: mimeType };
}

/**
 * Enforce the optional upload allow-list. Pure.
 * @param {string} who Lower-cased visitor email ('' if unknown).
 * @param {string[]} allowed Lower-cased emails; empty list = anyone who can open the page.
 * @throws {Error} If a list is set and `who` is not on it.
 * @private
 */
function assertUploadAllowed_(who, allowed) {
  if (!allowed || !allowed.length) return;
  if (!who || allowed.indexOf(who) === -1) {
    throw new Error('Your account is not on the upload list for this tool.' + (who ? ' (' + who + ')' : ''));
  }
}

/**
 * The visitor's email, lower-cased, or '' when the platform withholds it (visitor outside the domain, or the
 * userinfo.email scope missing). Never throws: an unknown uploader is logged as unknown, not refused.
 * @return {string}
 * @private
 */
function uploaderEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); }
  catch (e) { return ''; }
}

/**
 * Bytes -> megabytes with one decimal, for messages. Pure.
 * @param {number} bytes
 * @return {string}
 * @private
 */
function mb_(bytes) { return (Number(bytes) / 1048576).toFixed(1).replace(/\.0$/, ''); }

/**
 * How many files sit in the Intake folder right now, i.e. uploaded/dropped but not yet read by processIngestion.
 * One folder listing; never opens a file. Returns null rather than throwing so a config problem cannot take the
 * dashboard down with it.
 * @return {?number}
 * @private
 */
function countIntakeFiles_() {
  try {
    const it = DriveApp.getFolderById(readConfig_().folder_id_ingestion).getFiles();
    let n = 0;
    while (it.hasNext()) { it.next(); n++; }
    return n;
  } catch (e) {
    return null;
  }
}
