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
const SOURCES_MARKER    = '\n\n=== SOURCES ===\n'; // distinctive, so peeling is exact

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

    // Decide output columns. Field mode (output_fields set) writes one column per
    // field; otherwise the single output_column. Sources gets its own column when
    // grounding is on. ensureColumn_ creates any that don't yet exist.
    const fieldMode = cfg.output_fields.length > 0;
    const outCols = outputNames_(cfg).map(function (n) {
      return { name: n, col: ensureColumn_(dataSheet, headers, n) };
    });
    const sentinelCol = outCols[0].col;   // a filled first column == row already done

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
      const existing = row[sentinelCol - 1];
      if (cfg.skip_if_filled && existing !== '' && existing != null) { skipped++; continue; }

      const rowMap = rowToMap_(headers, row);
      let prompt = renderTemplate_(cfg.prompt_template, rowMap);
      if (fieldMode) prompt += fieldInstruction_(cfg.output_fields);

      let result;
      try {
        result = callGemini_(cfg, prompt);
      } catch (err) {
        result = 'ERROR: ' + (err && err.message ? err.message : err);
        failed++;
      }

      // Write results, then flush so a hard timeout never loses completed work.
      if (fieldMode) {
        const parsed = parseResult_(result, cfg.output_fields, cfg.grounding);
        outCols.forEach(function (oc) {
          dataSheet.getRange(rowNum, oc.col).setValue(parsed[oc.name] != null ? parsed[oc.name] : '');
        });
      } else {
        dataSheet.getRange(rowNum, sentinelCol).setValue(result);
      }
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
  return sources ? (text + SOURCES_MARKER + sources) : text;
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

// ---- Field mode -----------------------------------------------------------

/**
 * The instruction appended to the prompt that makes the response parseable.
 * Each field's content is wrapped between [[Label]] markers, which the parser
 * then splits on. (Native JSON/schema mode can't be used alongside grounding.)
 */
function fieldInstruction_(fields) {
  const labels = fields.map(function (f) { return '[[' + f + ']]'; }).join('\n');
  return '\n\n---\nFormat your entire response as labeled sections. Begin each ' +
         'section with its label on its own line, exactly as written below ' +
         '(double square brackets), followed by that section\'s content. Use these ' +
         'labels, in this order:\n' + labels +
         '\n\nDo not use the [[ ]] notation anywhere except as these section labels.';
}

/**
 * Split a response into { field => content }. Peels the grounding source block
 * first (so it lands in its own Sources column rather than the last field), then
 * slices the body between [[Label]] markers. Tolerant of surrounding markdown.
 */
function parseResult_(text, fields, expectSources) {
  let body = String(text), sources = '';

  const sIdx = body.lastIndexOf(SOURCES_MARKER);   // exact marker → no false hits
  if (sIdx !== -1) {
    sources = body.slice(sIdx + SOURCES_MARKER.length).trim();
    body = body.slice(0, sIdx);
  }

  // Find each marker's position; markers may appear in any order in the text.
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
  fields.forEach(function (f) { if (!(f in out)) out[f] = ''; });        // missing → blank

  // Safety net: if no markers matched, don't lose the text — dump it in field 1.
  if (hits.length === 0 && fields.length) out[fields[0]] = body.trim();

  if (expectSources) out['Sources'] = sources;
  return out;
}

function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    output_fields:      parseList_(raw.output_fields),
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

/** One field per line (or comma-separated) in a single config cell. */
function parseList_(v) {
  if (!isFilled_(v)) return [];
  return String(v).split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
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

/** The output column name(s) for the current config (single or field mode). */
function outputNames_(cfg) {
  if (cfg.output_fields.length) {
    const names = cfg.output_fields.slice();
    if (cfg.grounding && names.indexOf('Sources') === -1) names.push('Sources');
    return names;
  }
  return [cfg.output_column];
}

/** Clear all output column(s) so the next Run reprocesses every row. */
function resetOutput() {
  const ss    = SpreadsheetApp.getActive();
  const cfg   = readConfig_(ss);
  const sheet = ss.getSheetByName(cfg.data_sheet);
  if (!sheet) return;

  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  let cleared = 0;
  outputNames_(cfg).forEach(function (name) {
    const col = headers.indexOf(name) + 1;
    if (col >= 1) { sheet.getRange(2, col, lastRow - 1, 1).clearContent(); cleared++; }
  });
  ss.toast('Cleared ' + cleared + ' output column(s).', 'Gemini Runner', 5);
}
