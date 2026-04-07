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
      .addItem('Run Full Sync',              'runFullSync')
      .addItem('Fetch & Stage Only',         'runFetchAndStageOnly')
      .addSeparator()
      .addItem('Dry Run (Mock Payload)',      'runMockSmartsheetPush')
      .addItem('Generate Mapping Sheet',      'runGenerateMappingSheet')
      .addItem('Validate Configuration',      'validateConfiguration')
      .addToUi();
  } catch (_) { /* no UI context */ }
}

/**
 * Main entry point. Three phases:
 *   1. Fetch Monday boards (the Register).
 *   2. Filter the Register by region into staging sheets.
 *   3. Push each staging sheet to its Smartsheet.
 */
function runFullSync() {
  const config = getAppConfig_();
  const targets = config.targets.filter(t => t.enabled);

  logToAuditSheet('INFO', `Starting full sync for ${targets.length} target(s).`, 'runFullSync');
  showToast(`Syncing ${targets.length} target(s)...`, 'Portfolio Sync');

  // Phase 1 — Fetch from Monday (targets with a Board ID, e.g. the Register)
  const sourceTargets = targets.filter(t => t.boardId);
  for (const target of sourceTargets) {
    try {
      fetchMondayBoard_(target.boardId, target.sheetName);
    } catch (e) {
      logToAuditSheet('ERROR', `Monday fetch failed for "${target.sheetName}": ${e}`, 'runFullSync', true);
    }
  }

  // Phase 2 — Populate regional staging sheets from the Register
  // Regional targets have no Board ID but have a region and a Smartsheet ID.
  const registerTarget = sourceTargets[0];
  const regionalTargets = targets.filter(t => !t.boardId && t.region);

  if (registerTarget && regionalTargets.length) {
    try {
      populateRegionalStaging_(registerTarget.sheetName, regionalTargets);
    } catch (e) {
      logToAuditSheet('ERROR', `Regional staging failed: ${e}`, 'runFullSync', true);
    }
  }

  // Phase 3 — Push staging sheets to Smartsheet
  const pushTargets = targets.filter(t => t.smartsheetId && t.smartsheetId !== 'REPLACE_ME');
  for (const target of pushTargets) {
    try {
      pushNewRowsToSmartsheet_(target, config);
    } catch (e) {
      logToAuditSheet('ERROR', `Smartsheet push failed for "${target.region || target.sheetName}": ${e}`, 'runFullSync', true);
    }
  }

  showToast('Sync complete.', 'Portfolio Sync', 8);
  logToAuditSheet('SUCCESS', 'Full sync completed.', 'runFullSync', true);
  hideInternalSheets_();
}

/**
 * Reads the Register sheet and filters rows into regional staging sheets
 * based on the "Region" column. A target region like "EMEA/APAC" matches
 * rows where Region is "EMEA" or "APAC".
 */
function populateRegionalStaging_(registerSheetName, regionalTargets) {
  const ss = getSpreadsheet_();
  const registerSheet = ss.getSheetByName(registerSheetName);
  if (!registerSheet) {
    logToAuditSheet('ERROR', `Register sheet "${registerSheetName}" not found.`, 'populateRegionalStaging_', true);
    return;
  }

  const data = registerSheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const headers = data[0];
  const rows = data.slice(1);

  // Find the Region column
  const regionIndex = headers.findIndex(h => String(h || '').trim().toLowerCase() === 'region');
  if (regionIndex === -1) {
    logToAuditSheet('ERROR', 'Register sheet has no "Region" column. Cannot filter into staging sheets.', 'populateRegionalStaging_', true);
    return;
  }

  for (const target of regionalTargets) {
    // "EMEA/APAC" → ["emea", "apac"] so either value matches
    const regionKeys = target.region.split('/').map(r => r.trim().toLowerCase());

    const filtered = rows.filter(row => {
      const rowRegion = String(row[regionIndex] || '').trim().toLowerCase();
      return regionKeys.some(key => rowRegion === key || rowRegion.includes(key));
    });

    const output = [headers, ...filtered];
    const safeName = sanitizeSheetName_(target.sheetName);
    writeTableToSheet_(safeName, output);

    logToAuditSheet('SUCCESS', `Staged ${filtered.length} row(s) from Register (matched: ${regionKeys.join(', ')}).`, `Staging:${safeName}`, true);
  }
}

/**
 * Runs Phases 1 and 2 only (Monday fetch + regional staging).
 * No data is written to Smartsheet. Safe for first-time setup and previewing.
 */
function runFetchAndStageOnly() {
  const config = getAppConfig_();
  const targets = config.targets.filter(t => t.enabled);

  logToAuditSheet('INFO', 'Starting fetch & stage only (no Smartsheet push).', 'runFetchAndStageOnly');
  showToast('Fetching from Monday...', 'Fetch & Stage');

  const sourceTargets = targets.filter(t => t.boardId);
  for (const target of sourceTargets) {
    try {
      fetchMondayBoard_(target.boardId, target.sheetName);
    } catch (e) {
      logToAuditSheet('ERROR', `Monday fetch failed for "${target.sheetName}": ${e}`, 'runFetchAndStageOnly', true);
    }
  }

  const registerTarget = sourceTargets[0];
  const regionalTargets = targets.filter(t => !t.boardId && t.region);

  if (registerTarget && regionalTargets.length) {
    try {
      populateRegionalStaging_(registerTarget.sheetName, regionalTargets);
    } catch (e) {
      logToAuditSheet('ERROR', `Regional staging failed: ${e}`, 'runFetchAndStageOnly', true);
    }
  }

  showToast('Fetch & stage complete. No data was pushed to Smartsheet.', 'Fetch & Stage', 8);
  logToAuditSheet('SUCCESS', 'Fetch & stage complete. Smartsheet was not touched.', 'runFetchAndStageOnly', true);
}


// ── MAPPING SHEET GENERATOR ─────────────────────────────────────────────────────

/**
 * Dropdown launcher — shows enabled regional targets and generates a mapping sheet
 * by pulling live Smartsheet columns and matching them against Monday staging headers.
 */
function runGenerateMappingSheet() {
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
      <p>Select a region to generate a mapping sheet for:</p>
      <select id="region">${options}</select>
      <div style="margin-top: 12px; text-align: right;">
        <button onclick="google.script.host.close()">Cancel</button>
        <button onclick="run()">Generate</button>
      </div>
      <script>
        function run() {
          const region = document.getElementById('region').value;
          google.script.run
            .withSuccessHandler(function() { google.script.host.close(); })
            .generateMappingForRegion(region);
        }
      </script>
    `)
    .setWidth(320)
    .setHeight(160);

  SpreadsheetApp.getUi().showModalDialog(html, 'Generate Mapping Sheet');
}

/**
 * Generates (or overwrites) the mapping sheet for a region.
 *
 * Row 1: Smartsheet column headers (from the live API).
 * Row 2: Auto-match status — "✓ auto" or blank.
 * Row 3: Monday column headers — auto-matched where possible, blank where not.
 *
 * Auto-matching logic (applied in order, first match wins):
 *   1. Exact match (case-insensitive).
 *   2. One header contains the other (e.g. "PM" matches "Project Manager" won't,
 *      but "Request Overview" matches "Request Overview" will).
 *   3. Common synonyms (e.g. Monday "PM" ↔ Smartsheet "Project Manager").
 *
 * Unmatched columns are left blank in row 3 for manual review.
 */
function generateMappingForRegion(regionName) {
  const config = getAppConfig_();
  const target = config.targets.find(t => t.region.toLowerCase() === regionName.trim().toLowerCase() && t.enabled);
  if (!target) throw new Error(`No enabled target found for "${regionName}".`);

  const ss = getSpreadsheet_();

  // 1. Get Smartsheet column headers from the live API
  const ssCols = getSmartsheetColumns_(target.smartsheetId);
  const ssHeaders = ssCols.map(c => c.title);

  // 2. Get Monday headers from the staging sheet (or Register as fallback)
  const stagingSheet = ss.getSheetByName(target.sheetName);
  let mondayHeaders = [];

  if (stagingSheet && stagingSheet.getLastRow() > 0) {
    mondayHeaders = stagingSheet.getRange(1, 1, 1, stagingSheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  } else {
    // Fallback: try the Register sheet
    const registerTarget = config.targets.find(t => t.boardId);
    if (registerTarget) {
      const regSheet = ss.getSheetByName(registerTarget.sheetName);
      if (regSheet && regSheet.getLastRow() > 0) {
        mondayHeaders = regSheet.getRange(1, 1, 1, regSheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
      }
    }
  }

  if (!ssHeaders.length) throw new Error('No columns found in Smartsheet.');

  // 3. Auto-match Monday headers to Smartsheet headers
  const synonyms = {
    'pm':                'project manager',
    'review status':     'status',
    'status as of':      'status as of date',
    'status comment':    'status overview',
    'business benefit':  'potential business benefit',
    'opex pillar':       'primary classification',
    'opex category':     'category',
    'service line':      'lob',
    'request date':      'request date manual input',
    'is this a client-facing project or internal only?': 'internal or client',
    'links':             'link'
  };

  const usedMondayHeaders = new Set();
  const row3 = [];  // Monday matches
  const row2 = [];  // Status indicators

  for (const ssHeader of ssHeaders) {
    const ssNorm = ssHeader.toLowerCase().trim();
    let match = '';

    // Pass 1: exact match
    if (!match) {
      const exact = mondayHeaders.find(m => m.toLowerCase().trim() === ssNorm && !usedMondayHeaders.has(m));
      if (exact) match = exact;
    }

    // Pass 2: synonym match (Monday → Smartsheet direction)
    if (!match) {
      for (const mondayH of mondayHeaders) {
        if (usedMondayHeaders.has(mondayH)) continue;
        const mNorm = mondayH.toLowerCase().trim();
        if ((synonyms[mNorm] && synonyms[mNorm] === ssNorm) ||
            (synonyms[ssNorm] && synonyms[ssNorm] === mNorm)) {
          match = mondayH;
          break;
        }
      }
    }

    // Pass 3: substring containment (only for headers longer than 4 chars to avoid false positives)
    if (!match) {
      for (const mondayH of mondayHeaders) {
        if (usedMondayHeaders.has(mondayH)) continue;
        const mNorm = mondayH.toLowerCase().trim();
        if (mNorm.length > 4 && ssNorm.length > 4) {
          if (mNorm.includes(ssNorm) || ssNorm.includes(mNorm)) {
            match = mondayH;
            break;
          }
        }
      }
    }

    if (match) {
      usedMondayHeaders.add(match);
      row3.push(match);
      row2.push('✓ auto');
    } else {
      row3.push('');
      row2.push('');
    }
  }

  // 4. Write the mapping sheet
  const mappingName = target.mappingSheet || `.header_map_${target.region}`;
  let mapSheet = ss.getSheetByName(mappingName);
  if (!mapSheet) mapSheet = ss.insertSheet(mappingName);

  mapSheet.clear();
  if (mapSheet.getFilter()) mapSheet.getFilter().remove();

  const output = [ssHeaders, row2, row3];
  mapSheet.getRange(1, 1, 3, ssHeaders.length).setValues(output);
  mapSheet.getRange(1, 1, 1, ssHeaders.length).setFontWeight('bold').setBackground('#cfe2f3');  // Blue — Smartsheet
  mapSheet.getRange(2, 1, 1, ssHeaders.length).setFontColor('#666666').setFontStyle('italic');  // Status row
  mapSheet.getRange(3, 1, 1, ssHeaders.length).setFontWeight('bold').setBackground('#d9ead3');  // Green — Monday
  mapSheet.setFrozenRows(3);
  mapSheet.autoResizeColumns(1, ssHeaders.length);

  // Highlight unmatched columns
  for (let i = 0; i < row3.length; i++) {
    if (!row3[i]) {
      mapSheet.getRange(3, i + 1).setBackground('#f4cccc');  // Light red for unmatched
    }
  }

  const matched = row3.filter(v => v).length;
  const unmatched = row3.length - matched;
  const unmatchedMonday = mondayHeaders.filter(h => h && !usedMondayHeaders.has(h));

  let summary = `Mapping sheet "${mappingName}" generated.\n\n`;
  summary += `${matched} of ${ssHeaders.length} Smartsheet columns auto-matched.\n`;
  summary += `${unmatched} Smartsheet column(s) need manual mapping (highlighted red in row 3).\n`;
  if (unmatchedMonday.length) {
    summary += `\n${unmatchedMonday.length} Monday column(s) had no Smartsheet match:\n`;
    summary += unmatchedMonday.slice(0, 10).map(h => `  • ${h}`).join('\n');
    if (unmatchedMonday.length > 10) summary += `\n  ...and ${unmatchedMonday.length - 10} more.`;
  }

  showToast(`Mapping generated: ${matched} matched, ${unmatched} to review.`, 'Mapping Sheet', 10);
  try { SpreadsheetApp.getUi().alert(summary); } catch (_) {}
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

/**
 * Hides all sheets whose names start with "." (staging, audit, mapping, mock tabs).
 * Skips any sheet names in the exclude array so they stay visible.
 * Always ensures at least one sheet remains visible.
 */
function hideInternalSheets_(exclude) {
  const skip = (exclude || []).map(n => n.toLowerCase());
  const ss = getSpreadsheet_();
  const sheets = ss.getSheets();

  // Don't hide if it would leave zero visible sheets
  const visibleAfter = sheets.filter(s =>
    !s.getName().startsWith('.') || skip.includes(s.getName().toLowerCase())
  );
  if (!visibleAfter.length) return;

  for (const s of sheets) {
    const name = s.getName();
    if (name.startsWith('.') && !skip.includes(name.toLowerCase())) {
      s.hideSheet();
    }
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
        button:disabled { opacity: 0.5; cursor: wait; }
        #status { margin-top: 10px; font-size: 13px; color: #c00; }
      </style>
      <p>Select a region to mock:</p>
      <select id="region">${options}</select>
      <div style="margin-top: 12px; text-align: right;">
        <button id="cancelBtn" onclick="google.script.host.close()">Cancel</button>
        <button id="runBtn" onclick="run()">Run Dry Run</button>
      </div>
      <div id="status"></div>
      <script>
        function run() {
          document.getElementById('runBtn').disabled = true;
          document.getElementById('runBtn').textContent = 'Running...';
          document.getElementById('cancelBtn').disabled = true;
          document.getElementById('status').textContent = '';

          const region = document.getElementById('region').value;
          google.script.run
            .withSuccessHandler(function() { google.script.host.close(); })
            .withFailureHandler(function(err) {
              document.getElementById('status').textContent = 'Error: ' + err.message;
              document.getElementById('runBtn').disabled = false;
              document.getElementById('runBtn').textContent = 'Run Dry Run';
              document.getElementById('cancelBtn').disabled = false;
            })
            .runMockForRegion(region);
        }
      </script>
    `)
    .setWidth(300)
    .setHeight(180);

  SpreadsheetApp.getUi().showModalDialog(html, 'Mock Sync — Dry Run');
}

/**
 * Called by the dropdown dialog. Builds the mock payload for a single region.
 */
function runMockForRegion(regionName) {
  const config = getAppConfig_();
  const targets = config.targets.filter(t => t.enabled);
  const target = targets.find(t => t.region.toLowerCase() === regionName.trim().toLowerCase());
  if (!target) throw new Error(`No enabled target found for "${regionName}".`);

  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(target.sheetName);

  // If the staging sheet doesn't exist yet, hydrate it from the Register.
  if (!sheet) {
    ss.toast('Staging sheet not found — fetching from Monday...', 'Mock Sync', 10);

    const registerTarget = targets.find(t => t.boardId);
    if (!registerTarget) throw new Error('No target with a Monday Board ID found. Cannot populate staging.');

    // Fetch the Register from Monday if it hasn't been pulled yet
    if (!ss.getSheetByName(registerTarget.sheetName)) {
      fetchMondayBoard_(registerTarget.boardId, registerTarget.sheetName);
    }

    // Filter the Register into this region's staging sheet
    populateRegionalStaging_(registerTarget.sheetName, [target]);

    sheet = ss.getSheetByName(target.sheetName);
    if (!sheet) throw new Error(`Failed to create staging sheet "${target.sheetName}".`);
  }

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

  showToast(`Done! ${addCount} new, ${skipCount} existing. Check "${mockTab}".`, 'Mock Sync Complete', 10);
  hideInternalSheets_([mockTab]);
  ss.setActiveSheet(mockSheet);
}
