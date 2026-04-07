/**
 * @file PortfolioSync.gs
 *
 * Single-pass sync: Monday.com → Google Sheets (staging) → Smartsheet.
 * Finds NEW projects in Monday and appends them to Smartsheet.
 *
 * Architecture:
 *   1. For each enabled target, fetch all items from its Monday board.
 *   2. Write the result to a local staging sheet (for visibility / debugging).
 *   3. Read the staging sheet + mapping sheet to build the Smartsheet payload.
 *   4. Fetch the Smartsheet index (existing primary keys).
 *   5. POST only the rows whose primary key doesn't already exist.
 *   6. Log everything to the audit sheet.
 *
 * Config lives in the "Sync_Targets" sheet. Column mappings live in
 * per-target mapping sheets (row 1 = Smartsheet headers, row 3 = Monday headers).
 * API keys are stored in Script or Document Properties.
 */


// ── CONFIG ──────────────────────────────────────────────────────────────────────

const APP = Object.freeze({
  SHEETS:   { AUDIT: '.audit_log', TARGETS: 'Sync_Targets' },
  RUNTIME:  { LOG_FLUSH_SIZE: 10, SMARTSHEET_BATCH_SIZE: 500, SMARTSHEET_INDEX_PAGE_SIZE: 500 },
  DEFAULTS: { MONDAY_URL: 'https://api.monday.com/v2', MONDAY_API_VERSION: '2025-10', SMARTSHEET_URL: 'https://api.smartsheet.com/2.0' }
});

const EXECUTION_ID = Utilities.getUuid();
const MEMORY = { logBuffer: [], mappingCache: {} };


// ── UI / ENTRY POINTS ───────────────────────────────────────────────────────────

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Portfolio Sync')
      .addItem('Run Full Sync',          'runFullSync')
      .addSeparator()
      .addItem('Dry Run (Mock Payload)',  'runMockSmartsheetPush')
      .addItem('Validate Configuration',  'validateConfiguration')
      .addToUi();
  } catch (_) { /* no UI context */ }
}

/**
 * Main entry point. Pulls every enabled target from Monday, stages locally,
 * then pushes new rows to Smartsheet — all in a single execution.
 */
function runFullSync() {
  const config = getAppConfig_();
  const targets = config.targets.filter(t => t.enabled);

  logToAuditSheet('INFO', `Starting full sync for ${targets.length} target(s).`, 'runFullSync');
  showToast(`Syncing ${targets.length} target(s)...`, 'Portfolio Sync');

  for (const target of targets) {
    try {
      // Phase 1 — Monday → Staging sheet (skip if no board ID)
      if (target.boardId) {
        fetchMondayBoard_(target.boardId, target.sheetName);
      }

      // Phase 2 — Staging sheet → Smartsheet (skip if no Smartsheet ID)
      if (target.smartsheetId && target.smartsheetId !== 'REPLACE_ME') {
        pushNewRowsToSmartsheet_(target, config);
      }
    } catch (e) {
      logToAuditSheet('ERROR', `Target "${target.region || target.sheetName}" failed: ${e}`, 'runFullSync', true);
    }
  }

  showToast('Sync complete.', 'Portfolio Sync', 8);
  logToAuditSheet('SUCCESS', 'Full sync completed.', 'runFullSync', true);
}


// ── PHASE 1: MONDAY → STAGING SHEET ─────────────────────────────────────────────

function fetchMondayBoard_(boardId, sheetName) {
  const safeName = sanitizeSheetName_(sheetName);
  const tag = `Monday:${safeName}`;
  showToast(`Fetching Monday board → ${safeName}...`, 'Monday');

  const firstPage = mondayRequest_(`query {
    boards (ids: ${boardId}) {
      columns { id title }
      items_page (limit: 500) {
        cursor
        items { id name column_values { id text } }
      }
    }
  }`, tag);

  const board = (firstPage.data?.boards || [])[0];
  if (!board?.items_page) {
    logToAuditSheet('WARN', `No data returned for board ${boardId}.`, tag, true);
    return;
  }

  // Paginate
  const allItems = [...(board.items_page.items || [])];
  let cursor = board.items_page.cursor;

  while (cursor) {
    const page = mondayRequest_(`query {
      next_items_page (limit: 500, cursor: "${cursor}") {
        cursor
        items { id name column_values { id text } }
      }
    }`, tag);

    const next = page.data?.next_items_page;
    if (!next?.items?.length) break;
    allItems.push(...next.items);
    cursor = next.cursor || null;
  }

  // Build rows
  const dynamicCols = (board.columns || []).filter(c => c.id !== 'name');
  const nameTitle = (board.columns || []).find(c => c.id === 'name')?.title || 'Item Name';
  const colOrder = ['id', 'name', ...dynamicCols.map(c => c.id)];
  const headerMap = { id: 'Item ID', name: nameTitle };
  dynamicCols.forEach(c => { headerMap[c.id] = c.title; });

  const rows = [colOrder.map(id => headerMap[id])];

  for (const item of allItems) {
    const vals = { id: item.id, name: item.name };
    (item.column_values || []).forEach(cv => { vals[cv.id] = cv.text; });
    rows.push(colOrder.map(id => vals[id] ?? ''));
  }

  writeTableToSheet_(safeName, rows);
  logToAuditSheet('SUCCESS', `Staged ${rows.length - 1} item(s) from Monday.`, tag, true);
}


// ── PHASE 2: STAGING SHEET → SMARTSHEET (NEW ROWS ONLY) ─────────────────────────

function pushNewRowsToSmartsheet_(target, config) {
  const tag = `Smartsheet:${target.region || target.sheetName}`;
  showToast(`Pushing new rows → Smartsheet (${target.region})...`, 'Smartsheet');

  // 1. Read staging sheet
  const sheet = getSpreadsheet_().getSheetByName(target.sheetName);
  if (!sheet) {
    logToAuditSheet('ERROR', `Staging sheet "${target.sheetName}" not found.`, tag, true);
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    logToAuditSheet('INFO', `No data rows in "${target.sheetName}".`, tag, true);
    return;
  }

  const headers = data[0];
  const rows = data.slice(1);

  // 2. Load column mapping (Monday header name → Smartsheet column ID)
  const columnMap = getSmartsheetMapping_(target.mappingSheet, target.smartsheetId);
  if (!Object.keys(columnMap).length) {
    logToAuditSheet('ERROR', `Mapping sheet "${target.mappingSheet}" returned no usable mappings.`, tag, true);
    return;
  }

  // 3. Resolve primary key column in the staging sheet
  const pkIndex = resolvePrimaryKeyIndex_(headers, target.sourcePrimaryKeyHeader);
  if (pkIndex === -1) {
    logToAuditSheet('ERROR', `Primary key header "${target.sourcePrimaryKeyHeader || 'Item ID'}" not found.`, tag, true);
    return;
  }

  // 4. Fetch existing Smartsheet PKs
  const existingPKs = getSmartsheetIndex_(target.smartsheetId, target.primaryKeyColumnId, config.smartsheetApiKey);

  // 5. Build payload — new rows only
  const newRows = [];

  for (const row of rows) {
    const pk = String(row[pkIndex] ?? '').trim();
    if (!pk || pk in existingPKs) continue;

    const cells = [];
    headers.forEach((header, i) => {
      if (header in columnMap) {
        cells.push({ columnId: columnMap[header], value: sanitizeCellValue_(row[i]) });
      }
    });

    if (cells.length) {
      newRows.push({ pk, requestRow: { toBottom: true, cells } });
    }
  }

  if (!newRows.length) {
    logToAuditSheet('INFO', `No new rows to add for ${target.region}.`, tag, true);
    return;
  }

  // 6. POST in batches
  const result = postSmartsheetRows_(target.smartsheetId, newRows, config.smartsheetApiKey, tag);
  const summary = `Added ${result.added}, failed ${result.failed} of ${newRows.length} new row(s).`;
  logToAuditSheet(result.failed ? 'WARN' : 'SUCCESS', summary, tag, true);
  showToast(summary, `Smartsheet: ${target.region}`, 8);
}


// ── SMARTSHEET HELPERS ──────────────────────────────────────────────────────────

/**
 * Fetches every existing primary-key value from a Smartsheet.
 * Returns a plain object where keys are stringified PKs and values are row IDs.
 */
function getSmartsheetIndex_(sheetId, keyColumnId, token) {
  const config = getAppConfig_();
  const index = Object.create(null);
  let page = 1;

  while (true) {
    const url = `${config.smartsheetUrl}/sheets/${sheetId}` +
      `?columnIds=${encodeURIComponent(String(keyColumnId))}` +
      `&page=${page}&pageSize=${APP.RUNTIME.SMARTSHEET_INDEX_PAGE_SIZE}`;

    const resp = fetchWithBackoff_(url, { method: 'get', headers: ssHeaders_(token) });
    if (resp.getResponseCode() !== 200) {
      throw new Error(`Smartsheet index fetch failed. HTTP ${resp.getResponseCode()}`);
    }

    const body = safeJsonParse_(resp.getContentText(), {});
    for (const row of (body.rows || [])) {
      const cell = (row.cells || []).find(c => Number(c.columnId) === Number(keyColumnId));
      if (cell?.value != null && cell.value !== '') {
        index[String(cell.value)] = row.id;
      }
    }

    if (page >= Number(body.totalPages || 1)) break;
    page++;
  }

  return index;
}

/**
 * POSTs new rows to Smartsheet in batches of 500, using allowPartialSuccess.
 */
function postSmartsheetRows_(sheetId, wrappedRows, token, tag) {
  const config = getAppConfig_();
  let added = 0, failed = 0;

  for (let i = 0; i < wrappedRows.length; i += APP.RUNTIME.SMARTSHEET_BATCH_SIZE) {
    const batch = wrappedRows.slice(i, i + APP.RUNTIME.SMARTSHEET_BATCH_SIZE);
    const url = `${config.smartsheetUrl}/sheets/${sheetId}/rows?allowPartialSuccess=true`;

    const resp = fetchWithBackoff_(url, {
      method: 'post',
      headers: ssHeaders_(token),
      payload: JSON.stringify(batch.map(w => w.requestRow))
    });

    const code = resp.getResponseCode();
    const body = safeJsonParse_(resp.getContentText(), {});

    if (code === 200 && (body.message === 'SUCCESS' || Number(body.resultCode) === 0)) {
      added += batch.length;
      continue;
    }

    if (code === 200 && (body.message === 'PARTIAL_SUCCESS' || Number(body.resultCode) === 3)) {
      const failures = Array.isArray(body.failedItems) ? body.failedItems : [];
      added += batch.length - failures.length;
      failed += failures.length;
      for (const f of failures) {
        const pk = batch[f.index]?.pk || '?';
        logToAuditSheet('ERROR', `Row PK "${pk}": ${f.error?.message || 'Unknown'}`, tag);
      }
      continue;
    }

    // Non-200 or unrecognized response — log and count entire batch as failed
    logToAuditSheet('ERROR', `Batch POST failed. HTTP ${code}: ${resp.getContentText().substring(0, 300)}`, tag);
    failed += batch.length;
  }

  return { added, failed };
}

function ssHeaders_(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}


// ── COLUMN MAPPING ──────────────────────────────────────────────────────────────

/**
 * Reads the crosswalk sheet (row 1 = Smartsheet names, row 3 = Monday names),
 * then resolves Smartsheet column IDs from the live API.
 * Returns { "Monday Header Name": smartsheetColumnId, ... }
 */
function getSmartsheetMapping_(mappingSheetName, smartsheetId) {
  if (MEMORY.mappingCache[mappingSheetName]) return MEMORY.mappingCache[mappingSheetName];

  const sheet = getSpreadsheet_().getSheetByName(mappingSheetName);
  if (!sheet) {
    logToAuditSheet('ERROR', `Mapping sheet "${mappingSheetName}" not found.`, 'getSmartsheetMapping_');
    return {};
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 3) return {};

  const ssHeaders = data[0].map(h => String(h || '').trim());
  const mondayHeaders = data[2].map(h => String(h || '').trim());

  // Fetch live Smartsheet column IDs
  const liveCols = getSmartsheetColumns_(smartsheetId);
  const liveIndex = Object.create(null);
  liveCols.forEach(c => { liveIndex[c.title.toLowerCase()] = c.id; });

  const mapping = {};
  for (let i = 0; i < mondayHeaders.length; i++) {
    const monday = mondayHeaders[i];
    const ss = ssHeaders[i];
    if (!monday || monday.toUpperCase() === 'N/A' || !ss || ss.toUpperCase() === 'N/A') continue;

    const colId = liveIndex[ss.toLowerCase()];
    if (colId) {
      mapping[monday] = colId;
    }
  }

  MEMORY.mappingCache[mappingSheetName] = mapping;
  return mapping;
}

function getSmartsheetColumns_(sheetId) {
  const config = getAppConfig_();
  const url = `${config.smartsheetUrl}/sheets/${encodeURIComponent(String(sheetId))}/columns?includeAll=true`;
  const resp = fetchWithBackoff_(url, { method: 'get', headers: ssHeaders_(config.smartsheetApiKey) });

  if (resp.getResponseCode() !== 200) {
    throw new Error(`Failed to fetch columns for sheet ${sheetId}. HTTP ${resp.getResponseCode()}`);
  }

  return (safeJsonParse_(resp.getContentText(), {}).data || [])
    .map(c => ({ id: Number(c.id), title: String(c.title || '').trim(), primary: Boolean(c.primary) }))
    .filter(c => c.title && !Number.isNaN(c.id));
}


// ── GENERIC HELPERS ─────────────────────────────────────────────────────────────

function mondayRequest_(query, tag) {
  const config = getAppConfig_();
  const resp = fetchWithBackoff_(config.mondayUrl, {
    method: 'post',
    headers: { Authorization: config.mondayApiKey, 'Content-Type': 'application/json', 'API-Version': config.mondayApiVersion },
    payload: JSON.stringify({ query })
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error(`Monday HTTP ${resp.getResponseCode()}: ${resp.getContentText()}`);
  }

  const body = safeJsonParse_(resp.getContentText(), {});
  if (body.errors?.length) {
    const msg = body.errors.map(e => e.message).join(' | ');
    throw new Error(`Monday GraphQL: ${msg}`);
  }
  return body;
}

function fetchWithBackoff_(url, options, maxRetries) {
  const retries = maxRetries ?? 4;
  const request = { ...options, muteHttpExceptions: true };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(url, request);
      const code = resp.getResponseCode();

      if (code < 400 || (code >= 400 && code < 500 && code !== 429)) return resp;
      if (attempt === retries) return resp;

      const retryAfter = Number(resp.getHeaders()?.['retry-after'] || resp.getHeaders()?.['Retry-After']);
      const delay = (!Number.isNaN(retryAfter) && retryAfter > 0)
        ? retryAfter * 1000
        : (2 ** (attempt + 1)) * 1000 + Math.floor(Math.random() * 1000);
      Utilities.sleep(delay);
    } catch (e) {
      if (attempt === retries) throw e;
      Utilities.sleep((2 ** (attempt + 1)) * 1000 + Math.floor(Math.random() * 1000));
    }
  }
  throw new Error(`Exhausted retries for ${url}`);
}

function writeTableToSheet_(sheetName, rows) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  const lastRow = Math.max(sheet.getLastRow(), rows.length);
  const lastCol = Math.max(sheet.getLastColumn(), rows[0]?.length || 1);
  if (lastRow > 0 && lastCol > 0) sheet.getRange(1, 1, lastRow, lastCol).clearContent();

  if (rows.length && rows[0].length) {
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

function sanitizeCellValue_(value) {
  if (value == null || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof value === 'string') return value.length > 3999 ? value.substring(0, 3999) : value;
  return value;
}

function sanitizeSheetName_(name) {
  return String(name || '').replace(/[\/\\?*\[\]]/g, '').substring(0, 100);
}

function resolvePrimaryKeyIndex_(headers, preferred) {
  const pref = String(preferred || '').trim().toLowerCase();
  if (pref) {
    const i = headers.findIndex(h => String(h || '').trim().toLowerCase() === pref);
    if (i !== -1) return i;
  }
  return headers.findIndex(h => {
    const n = String(h || '').trim().toLowerCase();
    return n === 'item id' || n === 'id';
  });
}

function safeJsonParse_(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function showToast(message, title, seconds) {
  try { SpreadsheetApp.getActiveSpreadsheet()?.toast(message, title || 'Sync', seconds || 5); } catch (_) {}
}


// ── AUDIT LOG ───────────────────────────────────────────────────────────────────

function logToAuditSheet(status, message, module, flushNow) {
  MEMORY.logBuffer.push([new Date(), EXECUTION_ID, module, status, message]);
  console.log(`[${status}] ${module}: ${message}`);
  if (flushNow || status === 'ERROR' || MEMORY.logBuffer.length >= APP.RUNTIME.LOG_FLUSH_SIZE) flushAuditLogs();
}

function flushAuditLogs() {
  if (!MEMORY.logBuffer.length) return;
  try {
    const ss = getSpreadsheet_();
    let sheet = ss.getSheetByName(APP.SHEETS.AUDIT);
    if (!sheet) {
      sheet = ss.insertSheet(APP.SHEETS.AUDIT);
      sheet.getRange(1, 1, 1, 5).setValues([['Timestamp', 'Execution ID', 'Module', 'Status', 'Message']]);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    const batch = MEMORY.logBuffer.splice(0).reverse();
    sheet.insertRowsAfter(1, batch.length);
    sheet.getRange(2, 1, batch.length, batch[0].length).setValues(batch);
  } catch (e) {
    console.error(`Audit flush failed: ${e}`);
  }
}


// ── CONFIG ──────────────────────────────────────────────────────────────────────

function getSpreadsheet_() {
  const store = PropertiesService.getDocumentProperties() || PropertiesService.getScriptProperties();
  let id = store.getProperty('SPREADSHEET_ID');
  if (!id) {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) throw new Error('Cannot resolve spreadsheet. Open it once or set SPREADSHEET_ID.');
    id = active.getId();
    store.setProperty('SPREADSHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}

function getAppConfig_() {
  const scriptProps  = (PropertiesService.getScriptProperties()?.getProperties()) || {};
  const docProps     = (PropertiesService.getDocumentProperties()?.getProperties()) || {};
  const props        = { ...scriptProps, ...docProps };

  return {
    mondayApiKey:     props.MONDAY_API_KEY || '',
    smartsheetApiKey: props.SMARTSHEET_API_KEY || '',
    mondayUrl:        props.MONDAY_URL || APP.DEFAULTS.MONDAY_URL,
    mondayApiVersion: props.MONDAY_API_VERSION || APP.DEFAULTS.MONDAY_API_VERSION,
    smartsheetUrl:    props.SMARTSHEET_URL || APP.DEFAULTS.SMARTSHEET_URL,
    targets:          loadTargets_()
  };
}

function loadTargets_() {
  const sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.TARGETS);
  if (!sheet) throw new Error(`"${APP.SHEETS.TARGETS}" sheet is missing.`);

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const headers = data[0].map(h => String(h || '').trim());
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  const required = ['Enabled', 'Local Sheet Name'];
  const missing = required.filter(h => !(h in idx));
  if (missing.length) throw new Error(`Sync_Targets is missing: ${missing.join(', ')}`);

  return data.slice(1)
    .filter(row => toBoolean_(row[idx['Enabled']], true))
    .map(row => ({
      enabled:                true,
      region:                 String(row[idx['Region']] || '').trim(),
      boardId:                String(row[idx['Monday Board ID']] || '').trim(),
      sheetName:              String(row[idx['Local Sheet Name']] || '').trim(),
      smartsheetId:           String(row[idx['Smartsheet ID']] || '').trim(),
      primaryKeyColumnId:     Number(row[idx['Smartsheet Primary Key Column ID']]),
      mappingSheet:           String(row[idx['Mapping Sheet']] || '').trim(),
      sourcePrimaryKeyHeader: String(row[idx['Source Primary Key Header']] || 'Item ID').trim()
    }))
    .filter(t => t.sheetName);
}

function toBoolean_(value, defaultValue) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(n)) return true;
    if (['false', 'no', 'n'].includes(n)) return false;
  }
  return defaultValue;
}


// ── VALIDATION ──────────────────────────────────────────────────────────────────

function validateConfiguration() {
  const issues = [];
  let config;

  try { config = getAppConfig_(); } catch (e) { issues.push(String(e)); }

  if (config) {
    if (!config.mondayApiKey)     issues.push('Missing MONDAY_API_KEY in Script Properties.');
    if (!config.smartsheetApiKey) issues.push('Missing SMARTSHEET_API_KEY in Script Properties.');

    const targets = config.targets;
    if (!targets.length) issues.push('No enabled targets found in Sync_Targets.');

    targets.forEach((t, i) => {
      const p = `Target ${i + 1} (${t.region || 'unnamed'})`;
      if (!t.boardId && !t.smartsheetId) issues.push(`${p}: needs at least a Monday Board ID or Smartsheet ID.`);
      if (t.smartsheetId && !t.mappingSheet) issues.push(`${p}: has a Smartsheet ID but no Mapping Sheet.`);
      if (t.mappingSheet && !getSpreadsheet_().getSheetByName(t.mappingSheet)) {
        issues.push(`${p}: mapping sheet "${t.mappingSheet}" not found.`);
      }
    });
  }

  const msg = issues.length
    ? `Found ${issues.length} issue(s):\n\n${issues.map(v => `• ${v}`).join('\n')}`
    : 'Configuration looks good.';

  logToAuditSheet(issues.length ? 'ERROR' : 'SUCCESS', msg.replace(/\n/g, ' | '), 'validateConfiguration', true);
  try { SpreadsheetApp.getUi().alert(msg); } catch (_) {}
}


// ── MOCK DRY RUN ────────────────────────────────────────────────────────────────

function runMockSmartsheetPush() {
  const config = getAppConfig_();
  const regions = config.targets
    .filter(t => t.enabled && t.region && t.smartsheetId)
    .map(t => t.region);

  if (!regions.length) {
    SpreadsheetApp.getUi().alert('No enabled targets with a Smartsheet ID found.');
    return;
  }

  const options = regions.map(r => `<option value="${r}">${r}</option>`).join('');
  const html = HtmlService
    .createHtmlOutput(`
      <style>
        body { font-family: Arial, sans-serif; padding: 12px; }
        select { width: 100%; padding: 6px; margin: 10px 0; font-size: 14px; }
        button { padding: 8px 16px; font-size: 14px; cursor: pointer; margin-right: 6px; }
      </style>
      <p>Select a region to mock:</p>
      <select id="region">${options}</select>
      <div style="margin-top: 12px; text-align: right;">
        <button onclick="google.script.host.close()">Cancel</button>
        <button onclick="run()">Run Dry Run</button>
      </div>
      <script>
        function run() {
          const region = document.getElementById('region').value;
          google.script.run
            .withSuccessHandler(function() { google.script.host.close(); })
            .runMockForRegion(region);
        }
      </script>
    `)
    .setWidth(300)
    .setHeight(160);

  SpreadsheetApp.getUi().showModalDialog(html, 'Mock Sync — Dry Run');
}

/**
 * Called by the dropdown dialog. Builds the mock payload for a single region.
 */
function runMockForRegion(regionName) {
  const config = getAppConfig_();
  const target = config.targets.find(t => t.region.toLowerCase() === regionName.trim().toLowerCase() && t.enabled);
  if (!target) throw new Error(`No enabled target found for "${regionName}".`);

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(target.sheetName);
  if (!sheet) throw new Error(`Sheet "${target.sheetName}" not found.`);

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) throw new Error('No data rows found.');

  ss.toast('Building mock payload...', 'Mock Sync', 10);

  const headers = data[0];
  const rows = data.slice(1);
  const columnMap = getSmartsheetMapping_(target.mappingSheet, target.smartsheetId);
  const liveColumns = getSmartsheetColumns_(target.smartsheetId);
  const reverseMap = {};
  liveColumns.forEach(c => { reverseMap[c.id] = c.title; });

  const existingPKs = getSmartsheetIndex_(target.smartsheetId, target.primaryKeyColumnId, config.smartsheetApiKey);
  const pkIndex = resolvePrimaryKeyIndex_(headers, target.sourcePrimaryKeyHeader);
  const nameIndex = headers.findIndex(h => String(h || '').trim().toLowerCase() === 'project name');

  // Build ordered list of mapped Smartsheet column names for the output header row.
  // Preserves the order columns appear in the Monday staging sheet.
  const mappedHeaders = [];    // Monday header names that have a mapping
  const ssColumnNames = [];    // Corresponding Smartsheet display names
  headers.forEach((header, i) => {
    if (header in columnMap) {
      mappedHeaders.push(header);
      ssColumnNames.push(reverseMap[columnMap[header]] || header);
    }
  });

  // Output: one row per project
  const outputHeaders = ['Action', 'Monday Item ID', 'Project Name', ...ssColumnNames];
  const outputRows = [];

  let addCount = 0;
  let skipCount = 0;

  for (const row of rows) {
    const pk = String(row[pkIndex] ?? '').trim();
    if (!pk) continue;

    const action = pk in existingPKs ? 'SKIP (exists)' : 'ADD NEW ROW';
    if (action === 'ADD NEW ROW') { addCount++; } else { skipCount++; }

    const name = nameIndex !== -1 ? row[nameIndex] : '';

    // Build one cell per mapped column, in the same order as the header row
    const cells = mappedHeaders.map(header => {
      const i = headers.indexOf(header);
      return sanitizeCellValue_(row[i]);
    });

    outputRows.push([action, pk, name, ...cells]);
  }

  const output = [outputHeaders, ...outputRows];

  const mockTab = `._mock_${target.sheetName}`;
  let mockSheet = ss.getSheetByName(mockTab);
  if (!mockSheet) mockSheet = ss.insertSheet(mockTab);

  mockSheet.clear();
  if (mockSheet.getFilter()) mockSheet.getFilter().remove();

  mockSheet.getRange(1, 1, output.length, output[0].length).setValues(output);
  mockSheet.getRange(1, 1, 1, output[0].length).setFontWeight('bold').setBackground('#d9ead3');
  mockSheet.setFrozenRows(1);
  mockSheet.autoResizeColumns(1, output[0].length);

  // Filter defaults to showing only new rows. Toggle the Action filter to see skipped rows.
  const filter = mockSheet.getRange(1, 1, output.length, output[0].length).createFilter();
  const criteria = SpreadsheetApp.newFilterCriteria().setHiddenValues(['SKIP (exists)']).build();
  filter.setColumnFilterCriteria(1, criteria); // Column A = Action

  showToast(`Done! ${addCount} new, ${skipCount} existing. Check "${mockTab}".`, 'Mock Sync', 10);
  try {
    SpreadsheetApp.getUi().alert(`Done! Check the "${mockTab}" tab.\n\n${addCount} new project(s) to add.\n${skipCount} existing project(s) filtered out — toggle the Action column to see them.`);
  } catch (_) {}
}
