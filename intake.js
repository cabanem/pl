/**
 * ContractIntake.gs
 * -----------------------------------------------------------------------------
 * Config-driven contract intake: Drive ingestion -> Gemini extraction ->
 * per-contract review Sheet (the stand-alone artifact) -> human correction ->
 * Workato webhook push -> Salesforce.
 *
 * ARCHITECTURE (two time-driven loops, one project, nothing embedded in artifacts)
 *   processIngestion()   polls the ingestion folder, extracts, writes a review
 *                        Sheet into the pending folder, pings Chat.
 *   processApprovals()   polls the pending folder, and for any sheet whose
 *                        "Approved?" box is ticked, builds a payload from the
 *                        APPROVED column and POSTs it to Workato.
 *
 * The review Sheet is a plain spreadsheet with no bound code and no auth of its
 * own. The reviewer reads it, corrects the Approved column, ticks the box. The
 * central poller does the rest. This is what keeps approval a *value* the human
 * sets rather than code that runs inside each artifact.
 *
 * SOURCE OF TRUTH
 *   The Approved column is the truth that gets pushed. The Extracted column is
 *   frozen at extraction time and never edited, so the delta between the two is
 *   a free audit trail and travels in the payload as provenance.
 *
 * DELIVERY GUARANTEE (stated honestly)
 *   Extraction is at-least-once. The only duplicate window is a crash between
 *   "review sheet created" and "original moved out of ingestion" -- rare, and it
 *   produces a visible duplicate review sheet a human can delete. The push is
 *   effectively exactly-once: a correlation_id minted at sheet creation rides
 *   every attempt, so Workato/Salesforce can upsert on it. If you ever need
 *   exactly-once extraction, tag each review sheet with the source fileId via
 *   the Advanced Drive Service appProperties and check before create. Not built.
 *
 * BINDING / SCOPES
 *   Bind this project to the Config spreadsheet (Extensions > Apps Script from
 *   that sheet), or set Script Property CONFIG_SHEET_ID and switch
 *   getConfigSpreadsheet_() to openById. appsscript.json must include:
 *     https://www.googleapis.com/auth/cloud-platform        (Vertex)
 *     https://www.googleapis.com/auth/spreadsheets
 *     https://www.googleapis.com/auth/drive
 *     https://www.googleapis.com/auth/documents             (Word -> text)
 *     https://www.googleapis.com/auth/script.external_request
 *   The Advanced Drive Service is required ONLY if you ingest .docx/.doc.
 *
 * SETUP
 *   Run setupTriggers() once to install both time-driven loops.
 * -----------------------------------------------------------------------------
 */

// ===== CONSTANTS (defined here so the project is fully self-contained) ========
const CONFIG_SHEET_NAME = 'Config';
const REVIEW_SHEET_TAB   = 'Review';

// Review-sheet metadata labels (column A). Reads are label-scanned, not by row
// index, so light hand-edits to the sheet don't break the approval reader.
const META = {
  ORIGINAL:    'Original File',
  SOURCE_ID:   'Source File ID',
  SOURCE_NAME: 'Source File Name',
  CORRELATION: 'Correlation ID',
  EXTRACTED:   'Extracted At',
  MODEL:       'Model',
  STATUS:      'Status',
  APPROVED:    'Approved?',
  PUSHED_AT:   'Pushed At',
  ERROR:       'Last Error',
  SOURCES:     'Grounding Sources'
};
const GRID_HEADER = ['Field', 'Extracted', 'Approved'];

// PDFs go to Gemini inline as base64. Inline requests are capped (~20MB total,
// and base64 inflates ~33%), so guard the raw bytes and route big files to GCS
// (not built in v1).
const INLINE_PDF_MAX_BYTES = 15 * 1024 * 1024;


// ===== ENTRY POINTS (no underscore -> selectable in the Triggers UI) ==========

/** Time-driven. Ingest -> extract -> write review sheet -> notify. */
function processIngestion() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;            // a run is already in flight; skip
  try {
    const cfg  = readConfig_();
    const chat = new ChatNotifier(cfg.chat_webhook_url);

    const ingestion = DriveApp.getFolderById(cfg.folder_id_ingestion);
    const processed = DriveApp.getFolderById(cfg.folder_id_processed);
    const failed    = DriveApp.getFolderById(cfg.folder_id_failed);
    const pending   = DriveApp.getFolderById(cfg.folder_id_pending);

    const files = ingestion.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName();
      try {
        const sheet = extractOneFile_(file, cfg, pending);   // create review sheet first
        moveFile_(file, processed);                          // then claim the original
        notifyReview_(chat, sheet.url, name);
      } catch (err) {
        console.error('Ingest failed for ' + name + ': ' + err.message);
        try { moveFile_(file, failed); } catch (e) { /* leave in ingestion to retry */ }
        chat.text('Contract extraction FAILED for *' + name + '*: ' + err.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** Time-driven. Push any approved review sheet to Workato. */
function processApprovals() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    const cfg  = readConfig_();
    const chat = new ChatNotifier(cfg.chat_webhook_url);

    const pending = DriveApp.getFolderById(cfg.folder_id_pending);
    const pushed  = DriveApp.getFolderById(cfg.folder_id_pushed);

    const sheets = pending.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (sheets.hasNext()) {
      const driveFile = sheets.next();
      try {
        const ss       = SpreadsheetApp.openById(driveFile.getId());
        const approval = readApproval_(ss);
        if (!approval.approved) continue;

        pushToWorkato_(approval, cfg);                       // throws on non-2xx
        markPushed_(ss);
        moveFile_(driveFile, pushed);                        // remove from the queue
      } catch (err) {
        console.error('Push failed for ' + driveFile.getName() + ': ' + err.message);
        try { markError_(SpreadsheetApp.openById(driveFile.getId()), err.message); } catch (e) {}
        chat.text('Push FAILED for *' + driveFile.getName() + '*: ' + err.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}


// ===== EXTRACTION =============================================================

/** Extract one file, parse fields, and write the review sheet into `pending`. */
function extractOneFile_(file, cfg, pendingFolder) {
  const parts  = buildExtractionParts_(file);              // [{text}] or [{inlineData}]
  const prompt = cfg.prompt_template + fieldInstruction_(cfg.output_fields);

  const result     = callGemini_(cfg, prompt, parts);      // {text, sources, debug}
  const parsedData = parseResult_(result.text, cfg.output_fields);

  return createReviewSheet_(parsedData, file, result.sources, cfg, pendingFolder);
}

/**
 * Turn a Drive file into Gemini content parts.
 *   PDF        -> inline base64 (native document understanding; keeps tables)
 *   Google Doc -> plain text (cheap, lossless)
 *   Word        -> converted to a temp Google Doc, text extracted, temp trashed
 * No OCR step: PDFs go to the model whole; Word conversion is a format change,
 * not OCR.
 */
function buildExtractionParts_(file) {
  const mime = file.getMimeType();

  if (mime === MimeType.GOOGLE_DOCS) {
    return [{ text: DocumentApp.openById(file.getId()).getBody().getText() }];
  }

  if (mime === MimeType.PDF) {
    const bytes = file.getBlob().getBytes();
    if (bytes.length > INLINE_PDF_MAX_BYTES) {
      throw new Error('PDF too large for inline extraction (' +
        Math.round(bytes.length / 1048576) + 'MB). Route via GCS fileData.');
    }
    return [{ inlineData: { mimeType: 'application/pdf', data: Utilities.base64Encode(bytes) } }];
  }

  if (mime === MimeType.MICROSOFT_WORD || mime === 'application/msword') {
    return [{ text: wordToText_(file) }];
  }

  throw new Error('Unsupported file type (' + mime + ') for ' + file.getName());
}

/** Convert .docx/.doc to text via a throwaway Google Doc. Requires Advanced Drive. */
function wordToText_(file) {
  let tempId = null;
  try {
    const created = Drive.Files.create(
      { name: file.getName() + ' (temp)', mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob()
    );
    tempId = created.id;
    return DocumentApp.openById(tempId).getBody().getText();
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); }
      catch (e) { console.warn('Temp doc not trashed: ' + tempId); }
    }
  }
}

/**
 * The one Vertex seam. Self-contained so we can attach Google Search grounding
 * and capture its sources. Returns structured {text, sources, debug} rather than
 * a marker-concatenated string -- the row-processor's marker hack isn't needed
 * here because we control the single call site.
 */
function callGemini_(cfg, promptText, contentParts) {
  if (!cfg.project_id) throw new Error('Config missing "project_id".');
  const location = cfg.location || 'global';
  const model    = cfg.model || 'gemini-2.5-pro';
  const host     = (location === 'global')
    ? 'aiplatform.googleapis.com'
    : location + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + cfg.project_id +
              '/locations/' + location + '/publishers/google/models/' +
              model + ':generateContent';

  const body = {
    contents: [{ role: 'user', parts: [{ text: promptText }].concat(contentParts) }],
    generationConfig: {
      temperature:     (cfg.temperature == null ? 0.2 : cfg.temperature),
      maxOutputTokens: (cfg.max_tokens  == null ? 8192 : cfg.max_tokens)
    }
  };
  if (cfg.system_instruction) body.systemInstruction = { parts: [{ text: cfg.system_instruction }] };
  if (cfg.grounding)          body.tools = [{ googleSearch: {} }];

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const json = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200) {
    throw new Error('Vertex ' + resp.getResponseCode() + ': ' +
      ((json.error && json.error.message) || resp.getContentText()));
  }

  const cand = json.candidates && json.candidates[0];
  // Throw on non-text outcomes so the file is NOT silently staged as a clean
  // extraction. (The row processor could return these as cell text; here a
  // poison success would move the file and ping a human as if it were good.)
  if (!cand) throw new Error('Gemini returned no candidates.');
  if (cand.finishReason === 'SAFETY')     throw new Error('Gemini blocked: safety.');
  if (cand.finishReason === 'RECITATION') throw new Error('Gemini blocked: recitation.');

  const text = ((cand.content && cand.content.parts) || [])
    .map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');

  const debug = cfg.grounding_debug
    ? (cand.groundingMetadata
        ? 'keys=' + JSON.stringify(Object.keys(cand.groundingMetadata))
        : '(no groundingMetadata)')
    : '';
  return { text: text, sources: extractSources_(cand.groundingMetadata), debug: debug };
}

/** Flatten grounding chunks to "title — uri" lines. Empty string if ungrounded. */
function extractSources_(meta) {
  const chunks = meta && meta.groundingChunks;
  if (!chunks || !chunks.length) return '';
  const seen = {};
  const lines = [];
  chunks.forEach(function (c) {
    const w = c && c.web;
    if (w && w.uri && !seen[w.uri]) {
      seen[w.uri] = true;
      lines.push((w.title || w.uri) + ' — ' + w.uri);
    }
  });
  return lines.join('\n');
}

/** Instruction appended to the prompt that makes the response field-parseable. */
function fieldInstruction_(fields) {
  const labels = fields.map(function (f) { return '[[' + f + ']]'; }).join('\n');
  return '\n\n---\nFormat your entire response as labeled sections. Begin each ' +
         "section with its label on its own line, exactly as written below " +
         '(double square brackets), then that section\'s content. Use these ' +
         'labels, in this order:\n' + labels +
         '\n\nDo not use the [[ ]] notation anywhere except as these labels. ' +
         'If a field is not present in the contract, leave its section empty.';
}

/** Split a [[Label]]-delimited response into { field => content }. */
function parseResult_(text, fields) {
  const body = String(text);
  const hits = [];
  fields.forEach(function (f) {
    const re = new RegExp('(?:^|\\n)[ \\t>*#-]*\\[\\[\\s*' + escapeRegex_(f) + '\\s*\\]\\][ \\t:*]*', 'i');
    const m = re.exec(body);
    if (m) hits.push({ field: f, start: m.index, contentStart: m.index + m[0].length });
  });
  hits.sort(function (a, b) { return a.start - b.start; });

  const out = {};
  hits.forEach(function (h, i) {
    const end = (i + 1 < hits.length) ? hits[i + 1].start : body.length;
    out[h.field] = body.slice(h.contentStart, end).trim();
  });
  fields.forEach(function (f) { if (!(f in out)) out[f] = ''; });   // missing -> blank
  if (hits.length === 0 && fields.length) out[fields[0]] = body.trim();  // never lose text
  return out;
}

function escapeRegex_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }


// ===== REVIEW SHEET (the artifact) ============================================

/**
 * Build the per-contract review Sheet in `pending`. Fields are written in CONFIG
 * order (not parse order) so the reviewer always sees the same layout.
 */
function createReviewSheet_(parsedData, file, sources, cfg, pendingFolder) {
  const ss    = SpreadsheetApp.create('Contract Review: ' + file.getName());
  const sheet = ss.getSheets()[0].setName(REVIEW_SHEET_TAB);

  const corr = Utilities.getUuid();
  const meta = [
    [META.ORIGINAL,    '=HYPERLINK("' + file.getUrl() + '","' + file.getName().replace(/"/g, "'") + '")'],
    [META.SOURCE_ID,   file.getId()],
    [META.SOURCE_NAME, file.getName()],
    [META.CORRELATION, corr],
    [META.EXTRACTED,   new Date().toISOString()],
    [META.MODEL,       cfg.model || 'gemini-2.5-pro'],
    [META.STATUS,      'Pending Review'],
    [META.APPROVED,    false]
  ];
  meta.forEach(function (pair, i) {
    sheet.getRange(i + 1, 1).setValue(pair[0]).setFontWeight('bold');
    const cell = sheet.getRange(i + 1, 2);
    if (pair[0] === META.ORIGINAL) cell.setFormula(pair[1]);
    else                           cell.setValue(pair[1]);
  });
  // Make "Approved?" a real checkbox.
  sheet.getRange(meta.length, 2).insertCheckboxes();

  // Field grid: Field | Extracted | Approved (Approved seeded from Extracted).
  const headerRow = meta.length + 2;
  sheet.getRange(headerRow, 1, 1, 3).setValues([GRID_HEADER]).setFontWeight('bold');
  const rows = cfg.output_fields.map(function (f) {
    const v = parsedData[f] || '';
    return [f, v, v];
  });
  if (rows.length) sheet.getRange(headerRow + 1, 1, rows.length, 3).setValues(rows);

  // Sources block below the grid (provenance, read-only by convention).
  const srcRow = headerRow + rows.length + 2;
  sheet.getRange(srcRow, 1).setValue(META.SOURCES).setFontWeight('bold');
  sheet.getRange(srcRow, 2).setValue(sources || '(none)');

  sheet.setColumnWidth(1, 220).setColumnWidth(2, 420).setColumnWidth(3, 420);
  sheet.setFrozenRows(headerRow);
  SpreadsheetApp.flush();

  moveFile_(DriveApp.getFileById(ss.getId()), pendingFolder);
  return { id: ss.getId(), url: ss.getUrl(), correlationId: corr };
}

/** Read approval state and the human-approved values from a review sheet. */
function readApproval_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];

  const approved = readMeta_(sheet, META.APPROVED) === true;
  const corr     = readMeta_(sheet, META.CORRELATION);
  const fileId   = readMeta_(sheet, META.SOURCE_ID);
  const fileName = readMeta_(sheet, META.SOURCE_NAME);
  const model    = readMeta_(sheet, META.MODEL);
  const extAt    = readMeta_(sheet, META.EXTRACTED);

  // Locate the Field/Extracted/Approved grid by its header.
  const values = sheet.getDataRange().getValues();
  let h = -1;
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim() === GRID_HEADER[0] &&
        String(values[r][1]).trim() === GRID_HEADER[1]) { h = r; break; }
  }
  const approvedFields = {};
  const extractedFields = {};
  if (h !== -1) {
    for (let r = h + 1; r < values.length; r++) {
      const label = String(values[r][0]).trim();
      if (!label || label === META.SOURCES) break;       // grid ends
      extractedFields[label] = values[r][1];
      approvedFields[label]  = values[r][2];
    }
  }
  return {
    approved: approved, correlationId: corr, fileId: fileId, fileName: fileName,
    model: model, extractedAt: extAt, fields: approvedFields, extracted: extractedFields
  };
}

/** Find a metadata value by its label in column A. */
function readMeta_(sheet, label) {
  const col = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 30), 2).getValues();
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() === label) return col[i][1];
  }
  return '';
}

function markPushed_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Pushed');
  setMeta_(sheet, META.PUSHED_AT, new Date().toISOString());
}

function markError_(ss, msg) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Error');
  setMeta_(sheet, META.ERROR, String(msg).slice(0, 500));
}

/** Set (or append) a metadata key/value pair in the A/B columns. */
function setMeta_(sheet, label, value) {
  const last = Math.min(sheet.getLastRow(), 30);
  const col  = sheet.getRange(1, 1, last, 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() === label) { sheet.getRange(i + 1, 2).setValue(value); return; }
  }
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1).setValue(label).setFontWeight('bold');
  sheet.getRange(row, 2).setValue(value);
}


// ===== PUSH ===================================================================

/** POST the approved payload to Workato. Throws on any non-2xx. */
function pushToWorkato_(approval, cfg) {
  const payload = buildPayload_(approval, cfg);
  const headers = { 'X-Correlation-Id': approval.correlationId };
  if (cfg.workato_shared_secret) headers['X-Webhook-Secret'] = cfg.workato_shared_secret;

  const resp = UrlFetchApp.fetch(cfg.workato_webhook_url, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Workato ' + code + ': ' + resp.getContentText().slice(0, 300));
  }
}

/**
 * Payload contract. `fields` carries the approved truth; `provenance.extracted`
 * carries the pre-review values so the correction delta is auditable downstream.
 */
function buildPayload_(approval, cfg) {
  return {
    correlation_id: approval.correlationId,
    source: {
      file_id:   approval.fileId,
      file_name: approval.fileName,
      drive_url: 'https://drive.google.com/file/d/' + approval.fileId + '/view'
    },
    extracted_at: approval.extractedAt,
    model:        approval.model,
    fields:       approval.fields,                 // <- pushed to Salesforce
    provenance:   { extracted: approval.extracted } // <- original, for audit
  };
}


// ===== CONFIG =================================================================

/** Active config spreadsheet. Swap to openById(...) for a standalone deploy. */
function getConfigSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Read the Config tab into a typed object. Returns EVERY key this flow uses --
 * no fixed whitelist that silently drops folder/webhook keys.
 */
function readConfig_() {
  const ss    = getConfigSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + CONFIG_SHEET_NAME + '" sheet.');

  const raw = {};
  sheet.getDataRange().getValues().forEach(function (r) {
    const k = String(r[0] || '').trim();
    if (k) raw[k] = r[1];
  });

  const cfg = {
    folder_id_ingestion:  str_(raw.folder_id_ingestion),
    folder_id_processed:  str_(raw.folder_id_processed),
    folder_id_failed:     str_(raw.folder_id_failed),
    folder_id_pending:    str_(raw.folder_id_pending),
    folder_id_pushed:     str_(raw.folder_id_pushed),

    prompt_template:      String(raw.prompt_template || ''),
    output_fields:        parseList_(raw.output_fields),
    system_instruction:   str_(raw.system_instruction),

    project_id:           str_(raw.project_id),
    location:             str_(raw.location) || 'global',
    model:                str_(raw.model),
    temperature:          isFilled_(raw.temperature) ? Number(raw.temperature) : undefined,
    max_tokens:           isFilled_(raw.max_tokens)  ? Number(raw.max_tokens)  : undefined,
    grounding:            isFilled_(raw.grounding)       ? asBool_(raw.grounding)       : false,
    grounding_debug:      isFilled_(raw.grounding_debug) ? asBool_(raw.grounding_debug) : false,

    workato_webhook_url:  str_(raw.workato_webhook_url),
    workato_shared_secret: str_(raw.workato_shared_secret),
    chat_webhook_url:     str_(raw.chat_webhook_url)
  };

  const required = ['folder_id_ingestion', 'folder_id_processed', 'folder_id_failed',
                    'folder_id_pending', 'folder_id_pushed', 'prompt_template',
                    'project_id', 'workato_webhook_url'];
  required.forEach(function (k) { if (!cfg[k]) throw new Error('Config missing required key: ' + k); });
  if (!cfg.output_fields.length) throw new Error('Config missing required key: output_fields');
  return cfg;
}

function str_(v)      { return v == null ? '' : String(v).trim(); }
function isFilled_(v) { return v !== '' && v != null; }
function asBool_(v)   {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1'].indexOf(String(v).trim().toLowerCase()) !== -1;
}
function parseList_(v) {
  if (!isFilled_(v)) return [];
  return String(v).split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}


// ===== CHAT ===================================================================

/** Google Chat webhook notifier. Always sends a JSON object, never a bare string. */
class ChatNotifier {
  constructor(webhookUrl) { this.url = webhookUrl; }
  send(message) {
    if (!this.url) { Logger.log('chat_webhook_url not set'); return; }
    const res = UrlFetchApp.fetch(this.url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(message), muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 400) Logger.log('Chat error: ' + res.getContentText());
  }
  text(s) { this.send({ text: s }); }
}

/** cardsV2 notification with a button that opens the review sheet. */
function notifyReview_(notifier, sheetUrl, fileName) {
  notifier.send({
    cardsV2: [{
      cardId: 'contractReview',
      card: {
        header: { title: 'Contract staged for review', subtitle: fileName },
        sections: [{
          widgets: [
            { textParagraph: { text: 'Open the sheet, correct the <b>Approved</b> column, then tick <b>Approved?</b>.' } },
            { buttonList: { buttons: [{ text: 'Open review sheet', onClick: { openLink: { url: sheetUrl } } }] } }
          ]
        }]
      }
    }]
  });
}


// ===== DRIVE HELPER ===========================================================

function moveFile_(file, folder) { file.moveTo(folder); }


// ===== SETUP ==================================================================

/** Run once to install both polling triggers (clears any prior copies first). */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'processIngestion' || fn === 'processApprovals') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processIngestion').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('processApprovals').timeBased().everyMinutes(5).create();
}

/** Optional: validate config without processing anything. */
function validateConfig() {
  const cfg = readConfig_();
  Logger.log('Config OK. Fields: ' + cfg.output_fields.join(', '));
  return cfg;
}
