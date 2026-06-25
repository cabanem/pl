/**
 * Sheet-Driven Gemini Runner
 * --------------------------------------------------------------------------
 * A config-driven framework: the user edits two tabs, never the code.
 *
 *   Config  (key / value) -> defines the model, prompt template, and settings
 *   Data    (table)       -> one row per Gemini call; columns supply the values
 *
 * The prompt_template in Config contains {{Header}} placeholders. For each row
 * in the data sheet, the engine binds {{Header}} to that row's cell under the
 * matching column header, renders the prompt, calls Gemini, and writes the
 * result into the output column.
 *
 * Resumable by design: rows that already have output are skipped, so a re-run
 * (manual, or via a time trigger you add later) continues where a previous run
 * stopped. This matters because one Apps Script execution is capped at ~6 min.
 */

// ---- Settings you rarely change -------------------------------------------

const CONFIG_SHEET_NAME = 'Config';        // tab holding key/value settings
const TIME_BUDGET_MS    = 5 * 60 * 1000;   // stop before the ~6 min hard limit

// ---- Menu -----------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Gemini Runner')
    .addItem('Run', 'runGeminiJob')
    .addSeparator()
    .addItem('Reset output column', 'resetOutput')
    .addToUi();
}

// ---- Entry point ----------------------------------------------------------

function runGeminiJob() {
  // Prevent two overlapping runs from clobbering the same cells / burning quota.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.getActive().toast('A run is already in progress.', 'Gemini Runner', 5);
    return;
  }

  try {
    const ss  = SpreadsheetApp.getActive();
    const cfg = readConfig_(ss);

    const dataSheet = ss.getSheetByName(cfg.data_sheet);
    if (!dataSheet) throw new Error('Data sheet not found: "' + cfg.data_sheet + '"');

    const headers     = getHeaders_(dataSheet);
    const headerIndex = indexByName_(headers);          // header -> 1-based column

    validateTemplate_(cfg.prompt_template, headerIndex); // fail fast on bad tokens

    // Find or create the output column (zero setup for the user).
    const outCol = ensureColumn_(dataSheet, headers, cfg.output_column);

    const lastRow = dataSheet.getLastRow();
    if (lastRow < 2) { ss.toast('No data rows to process.', 'Gemini Runner', 5); return; }

    // One bulk read is far cheaper than reading row by row.
    const numCols = headers.length;
    const values  = dataSheet.getRange(2, 1, lastRow - 1, numCols).getValues();

    const start = Date.now();
    let processed = 0, skipped = 0, failed = 0, stoppedEarly = false;

    for (let i = 0; i < values.length; i++) {
      if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break; }

      const rowNum = i + 2;
      const row    = values[i];

      if (isBlankRow_(row)) continue;

      // Resumability: skip rows that already carry a result.
      const existing = row[outCol - 1];
      if (cfg.skip_if_filled && existing !== '' && existing != null) { skipped++; continue; }

      const rowMap = rowToMap_(headers, row);
      const prompt = renderTemplate_(cfg.prompt_template, rowMap);

      let result;
      try {
        result = callGemini_(cfg, prompt);
      } catch (err) {
        result = 'ERROR: ' + (err && err.message ? err.message : err);
        failed++;
      }

      // Write immediately + flush so a hard timeout never loses completed work.
      dataSheet.getRange(rowNum, outCol).setValue(result);
      SpreadsheetApp.flush();
      processed++;
    }

    ss.toast(
      'Done. Processed ' + processed + ', skipped ' + skipped + ', failed ' + failed +
      (stoppedEarly ? '  (time budget hit \u2014 re-run to continue)' : ''),
      'Gemini Runner', 8
    );

  } finally {
    lock.releaseLock();
  }
}

// ---- The integration seam -------------------------------------------------

/**
 * The one Gemini seam. Self-contained Vertex call so we can (a) attach the
 * Google Search grounding tool and (b) capture the grounding sources, which a
 * plain text-only parser would throw away. Auth uses the running user's OAuth
 * token, so appsscript.json must list the cloud-platform scope (see notes).
 *
 * Grounded vs. not is controlled entirely from the Config tab (grounding key).
 */
function callGemini_(cfg, prompt) {
  const project  = cfg.project_id;
  const location = cfg.location || 'global';
  const model    = cfg.model || 'gemini-2.5-pro';
  if (!project) throw new Error('Config missing "project_id" (required for grounded calls).');

  // 'global' uses the bare host; a regional location prefixes the host.
  const host = (location === 'global')
    ? 'aiplatform.googleapis.com'
    : location + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + project +
              '/locations/' + location + '/publishers/google/models/' +
              model + ':generateContent';

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:     (cfg.temperature == null ? 0.2 : cfg.temperature),
      maxOutputTokens: (cfg.max_tokens  == null ? 8192 : cfg.max_tokens)
    }
  };
  if (cfg.system_instruction) {
    body.systemInstruction = { parts: [{ text: cfg.system_instruction }] };
  }
  if (cfg.grounding) {
    body.tools = [{ googleSearch: {} }];   // Gemini 2.x Search grounding
  }

  const resp = UrlFetchApp.fetch(url, {
    method:           'post',
    contentType:      'application/json',
    headers:          { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload:          JSON.stringify(body),
    muteHttpExceptions: true
  });

  const json = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200) {
    throw new Error('Vertex ' + resp.getResponseCode() + ': ' +
      ((json.error && json.error.message) || resp.getContentText()));
  }

  const cand = json.candidates && json.candidates[0];
  if (!cand) return 'No response (no candidates returned).';
  if (cand.finishReason === 'SAFETY')     return 'Blocked by safety settings.';
  if (cand.finishReason === 'RECITATION') return 'Blocked (recitation / too close to source).';

  const text = ((cand.content && cand.content.parts) || [])
    .map(function (p) { return p.text || ''; }).join('').trim();

  const sources = extractSources_(cand.groundingMetadata);
  return sources ? (text + '\n\nSOURCES:\n' + sources) : text;
}

/** Flatten groundingMetadata into a readable, de-duplicated source list. */
function extractSources_(meta) {
  if (!meta || !meta.groundingChunks) return '';
  const seen = {}, lines = [];
  meta.groundingChunks.forEach(function (c) {
    const w = c.web || c.retrievedContext;   // web = Search; retrievedContext = data store
    if (!w || !w.uri || seen[w.uri]) return;
    seen[w.uri] = true;
    lines.push('- ' + (w.title || w.uri) + ' (' + w.uri + ')');
  });
  return lines.join('\n');
}

// ---- Templating -----------------------------------------------------------

/** Replace every {{Header}} with the row's value for that header. */
function renderTemplate_(template, rowMap) {
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (_, name) {
    const v = rowMap[name];
    return (v == null) ? '' : String(v);
  });
}

/** Fail fast if the template references a column the data sheet doesn't have. */
function validateTemplate_(template, headerIndex) {
  const tokens = {};
  String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (_, name) {
    tokens[name] = true; return '';
  });
  const missing = Object.keys(tokens).filter(function (t) { return !(t in headerIndex); });
  if (missing.length) {
    throw new Error('prompt_template references unknown column(s): ' + missing.join(', '));
  }
}

// ---- Config ---------------------------------------------------------------

function readConfig_(ss) {
  const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + CONFIG_SHEET_NAME + '" sheet.');

  const raw = {};
  sheet.getDataRange().getValues().forEach(function (r) {
    const key = String(r[0] || '').trim();
    if (key) raw[key] = r[1];
  });

  ['data_sheet', 'prompt_template'].forEach(function (k) {
    if (!String(raw[k] || '').trim()) throw new Error('Config missing required key: ' + k);
  });

  return {
    data_sheet:         String(raw.data_sheet).trim(),
    prompt_template:    String(raw.prompt_template),
    system_instruction: raw.system_instruction ? String(raw.system_instruction) : '',
    model:              raw.model ? String(raw.model).trim() : '',
    output_column:      raw.output_column ? String(raw.output_column).trim() : 'AI_Result',
    temperature:        isFilled_(raw.temperature) ? Number(raw.temperature) : undefined,
    max_tokens:         isFilled_(raw.max_tokens)  ? Number(raw.max_tokens)  : undefined,
    skip_if_filled:     isFilled_(raw.skip_if_filled) ? asBool_(raw.skip_if_filled) : true,
    project_id:         raw.project_id ? String(raw.project_id).trim() : '',
    location:           raw.location ? String(raw.location).trim() : 'global',
    grounding:          isFilled_(raw.grounding) ? asBool_(raw.grounding) : false
  };
}

function isFilled_(v) { return v !== '' && v != null; }

function asBool_(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1'].indexOf(String(v).trim().toLowerCase()) !== -1;
}

// ---- Sheet helpers --------------------------------------------------------

function getHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

function indexByName_(headers) {
  const map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i + 1; });
  return map;
}

function rowToMap_(headers, row) {
  const map = {};
  headers.forEach(function (h, i) { if (h) map[h] = row[i]; });
  return map;
}

/** Returns the 1-based index of `name`, appending it as a new header if absent. */
function ensureColumn_(sheet, headers, name) {
  const idx = headers.indexOf(name);
  if (idx !== -1) return idx + 1;
  const col = headers.length + 1;
  sheet.getRange(1, col).setValue(name);
  headers.push(name);   // keep the in-memory header list in sync
  return col;
}

function isBlankRow_(row) {
  return row.every(function (c) { return c === '' || c == null; });
}

// ---- Utility --------------------------------------------------------------

/** Clear the output column so the next Run reprocesses every row. */
function resetOutput() {
  const ss    = SpreadsheetApp.getActive();
  const cfg   = readConfig_(ss);
  const sheet = ss.getSheetByName(cfg.data_sheet);
  if (!sheet) return;

  const col = getHeaders_(sheet).indexOf(cfg.output_column) + 1;
  if (col < 1) return;

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, col, lastRow - 1, 1).clearContent();
  ss.toast('Cleared "' + cfg.output_column + '".', 'Gemini Runner', 5);
}
