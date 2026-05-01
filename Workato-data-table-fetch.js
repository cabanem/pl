/**
 * Workato Data Tables — records API client.
 *
 * Aligned to the documented API:
 *   https://docs.workato.com/en/workato-api/data-tables.html#query-records
 *
 * Endpoint:  POST {records-host}/api/v1/tables/{id}/query
 * Hosts:
 *   US:    https://data-tables.workato.com
 *   EU:    https://data-tables.eu.workato.com
 *   JP:    https://data-tables.jp.workato.com
 *   SG:    https://data-tables.sg.workato.com
 *   AU:    https://data-tables.au.workato.com
 *   IL:    https://data-tables.il.workato.com
 *   Trial: https://data-tables.trial.workato.com
 *
 * The records-host is derived from WORKATO_BASE_URL (app.X → data-tables.X).
 * Override with the WORKATO_RECORDS_URL script property if needed.
 *
 * Request payload (per docs):
 *   {
 *     "select":              ["col1", "col2"],            // optional
 *     "where":               { field: { $op: value }, ... }, // optional
 *     "order":               "field" | { by, order, case_sensitive }, // optional
 *     "limit":               <int, max 200>,              // optional
 *     "continuation_token":  "...",                       // optional
 *     "timezone_offset_secs": <int>                       // required for date/datetime comparison
 *   }
 *
 * Response shape (per docs):
 *   {
 *     "schema": [ [meta_field_defs], [field_defs] ],
 *     "data":   [ [ [meta_values], [field_values] ], ... ],
 *     "count":  <int>,
 *     "limit":  <int>,
 *     "continuation_token": "..."  (when more pages exist)
 *   }
 *
 * This module transforms the positional response into key-value objects
 * by default (one parse at the boundary, so downstream code never sees
 * the positional form). Pass returnRaw: true to opt out.
 */


/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fetch records from a data table, paginated.
 *
 * @param {string} tableId
 * @param {Object} [opts]
 * @param {Array}  [opts.select]               Column names to return
 * @param {Object} [opts.where]                Filter hash, e.g. { Status: { $eq: "open" } }
 * @param {string|Object} [opts.order]         Field name, or { by, order, case_sensitive }
 * @param {number} [opts.limit]                Page size (max 200, default 200)
 * @param {number} [opts.maxRecords]           Stop after this many records total
 * @param {number} [opts.timezoneOffsetSecs]   Required when comparing date-time to date
 * @param {boolean}[opts.returnRaw]            Return positional response objects instead of records
 * @returns {Array<Object>} Records as objects keyed by field name (default)
 *                          or array of raw response pages (if returnRaw)
 */
function fetchDataTableRecords(tableId, opts) {
  opts = opts || {};
  const pageSize    = Math.min(opts.limit || 200, 200);
  const maxRecords  = opts.maxRecords || Infinity;
  const returnRaw   = !!opts.returnRaw;

  const recordsHost = getRecordsHost_();
  const apiToken    = PropertiesService.getScriptProperties().getProperty('WORKATO_API_TOKEN');
  const url         = `${recordsHost}/api/v1/tables/${tableId}/query`;

  const allRecords = [];
  const rawPages   = [];
  let continuationToken = null;
  let pages = 0;

  while (allRecords.length < maxRecords) {
    const body = { limit: pageSize };
    if (opts.select)              body.select               = opts.select;
    if (opts.where)               body.where                = opts.where;
    if (opts.order)               body.order                = opts.order;
    if (opts.timezoneOffsetSecs != null) body.timezone_offset_secs = opts.timezoneOffsetSecs;
    if (continuationToken)        body.continuation_token   = continuationToken;

    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: { 'Authorization': `Bearer ${apiToken}` },
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code < 200 || code >= 300) {
      throw new Error(`Records API error ${code} on table ${tableId}: ${text}`);
    }

    const json = JSON.parse(text);
    rawPages.push(json);

    const records   = transformResponseRecords_(json);
    const remaining = maxRecords - allRecords.length;
    allRecords.push.apply(
      allRecords,
      records.length > remaining ? records.slice(0, remaining) : records
    );

    continuationToken = json.continuation_token || null;
    pages++;

    if (!continuationToken)             break;
    if (allRecords.length >= maxRecords) break;
    if (pages > 100) {
      Logger.log(`Pagination safety limit reached on table ${tableId}.`);
      break;
    }
  }

  return returnRaw ? rawPages : allRecords;
}


/**
 * Convenience: fetch the most recent N records by a timestamp column.
 * Uses the API's $-prefixed operators and the documented order hash form.
 *
 * @param {string} tableId
 * @param {Object} opts
 * @param {string} opts.timestampField  Field to order by. Use a real column name,
 *                                       or one of the meta-fields: $record_id,
 *                                       $created_at, $updated_at.
 * @param {number} [opts.limit=100]
 * @param {Date}   [opts.since]         Only records with timestamp >= this date
 * @param {Array<string>} [opts.select] Column projection
 */
function fetchRecentLogEntries(tableId, opts) {
  if (!opts || !opts.timestampField) {
    throw new Error('fetchRecentLogEntries requires opts.timestampField');
  }

  const queryOpts = {
    limit: opts.limit || 100,
    order: { by: opts.timestampField, order: 'desc' }
  };

  if (opts.since instanceof Date) {
    queryOpts.where = {};
    queryOpts.where[opts.timestampField] = { $gte: opts.since.toISOString() };
    queryOpts.timezoneOffsetSecs = 0;   // ISO timestamps are UTC; offset = 0
  }

  if (opts.select) queryOpts.select = opts.select;

  queryOpts.maxRecords = queryOpts.limit;
  return fetchDataTableRecords(tableId, queryOpts);
}


/* -------------------------------------------------------------------------- */
/* Sheet writer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Render fetched records to a sheet. Records are objects keyed by field
 * name (the transformed shape), so the column union pattern works cleanly.
 *
 * Meta-fields ($record_id, $created_at, $updated_at) are surfaced as columns
 * unless explicitly excluded via the columnOrder argument.
 */
function writeLogRecordsToSheet(sheetName, records, columnOrder) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  sheet.clear();

  if (!records || records.length === 0) {
    sheet.getRange(1, 1).setValue('(no records)');
    return;
  }

  const headers = columnOrder && columnOrder.length
    ? columnOrder
    : unionKeys_(records);

  sheet.getRange(1, 1, 1, headers.length)
       .setValues([headers])
       .setFontWeight('bold');

  const rows = records.map(function (r) {
    return headers.map(function (h) {
      const v = r[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object')          return JSON.stringify(v);
      return v;
    });
  });

  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Convert the documented positional response into key-value objects.
 *
 * Input  shape: { schema: [[meta_defs], [field_defs]], data: [[[m...], [f...]], ...] }
 * Output shape: [{ $record_id, $created_at, $updated_at, <field>: <value>, ... }, ...]
 *
 * One parse at the boundary — downstream code never sees positional form.
 */
function transformResponseRecords_(json) {
  if (!json || !Array.isArray(json.data)) return [];

  const schema = Array.isArray(json.schema) ? json.schema : [[], []];
  const metaDefs  = Array.isArray(schema[0]) ? schema[0] : [];
  const fieldDefs = Array.isArray(schema[1]) ? schema[1] : [];

  return json.data.map(function (row) {
    const out = {};
    const metaVals  = Array.isArray(row[0]) ? row[0] : [];
    const fieldVals = Array.isArray(row[1]) ? row[1] : [];

    for (let i = 0; i < metaDefs.length; i++) {
      const def = metaDefs[i];
      if (def && def.name) out[def.name] = metaVals[i];
    }
    for (let i = 0; i < fieldDefs.length; i++) {
      const def = fieldDefs[i];
      if (def && def.name) out[def.name] = fieldVals[i];
    }
    return out;
  });
}


/**
 * Derive the records host from WORKATO_BASE_URL. Override via WORKATO_RECORDS_URL.
 * Pattern: app.eu.workato.com → data-tables.eu.workato.com
 */
function getRecordsHost_() {
  const explicit = PropertiesService.getScriptProperties().getProperty('WORKATO_RECORDS_URL');
  if (explicit) return explicit.replace(/\/$/, '');

  const baseUrl = (PropertiesService.getScriptProperties().getProperty('WORKATO_BASE_URL')
                   || 'https://app.eu.workato.com').replace(/\/$/, '');

  return baseUrl.replace(/^https?:\/\/app\./, 'https://data-tables.');
}


function unionKeys_(records) {
  const seen = {};
  const out  = [];
  records.forEach(function (r) {
    Object.keys(r || {}).forEach(function (k) {
      if (!seen[k]) { seen[k] = true; out.push(k); }
    });
  });
  return out;
}



// query runner
/**
 * Data Table Records — sheet-driven entry point (v2).
 *
 * Updated to match the actual Workato Data Tables query API. The queries
 * sheet schema changed:
 *
 *   removed: filter_json, order_field, order_direction
 *   added:   select_json, where_json, order_json
 *
 * If you have an existing DT Queries sheet from the previous version,
 * either:
 *   (a) rename and recreate (easiest — run initDataTableQueriesSheet
 *       after deleting the old sheet), or
 *   (b) hand-migrate by translating the old filter array into a where
 *       hash and the old order_field/order_direction pair into an order
 *       hash. Format examples are in the example seed row.
 *
 * Depends on: data_table_records.js (v2 — uses where/order/select shape)
 */


const DT_QUERIES_SHEET = 'DT Queries';
const DT_QUERIES_HEADERS = [
  'enabled',
  'name',
  'table_id',
  'output_sheet',
  'limit',
  'select_json',          // optional: ["col1","col2"]
  'where_json',           // optional: {"Status":{"$eq":"open"}}
  'order_json',           // optional: "$created_at" or {"by":"...","order":"desc"}
  'tz_offset_secs',       // optional: integer; required when comparing date-time to date
  'last_run_at',
  'last_run_count'
];

// Example values, written into the seed row for reference.
const DT_QUERIES_EXAMPLE_WHERE = JSON.stringify({
  $created_at: { $gte: '2026-04-24T00:00:00Z' }
});
const DT_QUERIES_EXAMPLE_ORDER = JSON.stringify({
  by: '$created_at',
  order: 'desc'
});


/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

function initDataTableQueriesSheet() {
  const ss = SpreadsheetApp.getActive();
  let   sheet   = ss.getSheetByName(DT_QUERIES_SHEET);
  const isFresh = !sheet;

  if (isFresh) {
    sheet = ss.insertSheet(DT_QUERIES_SHEET);
    sheet.getRange(1, 1, 1, DT_QUERIES_HEADERS.length)
         .setValues([DT_QUERIES_HEADERS])
         .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const enabledCol = DT_QUERIES_HEADERS.indexOf('enabled') + 1;
  sheet.getRange(2, enabledCol, sheet.getMaxRows() - 1, 1)
       .setDataValidation(SpreadsheetApp.newDataValidation()
                           .requireCheckbox().build());

  ['select_json', 'where_json', 'order_json'].forEach(function (col) {
    const colNum = DT_QUERIES_HEADERS.indexOf(col) + 1;
    sheet.getRange(2, colNum, sheet.getMaxRows() - 1, 1)
         .setNumberFormat('@');
  });

  if (sheet.getLastRow() < 2) {
    const seed = [[
      false,
      'Example: recent log entries',
      'paste-table-id-here',
      'Log Output',
      100,
      '',                                // select_json (empty = all columns)
      DT_QUERIES_EXAMPLE_WHERE,
      DT_QUERIES_EXAMPLE_ORDER,
      0,                                 // tz_offset_secs
      '',
      ''
    ]];
    sheet.getRange(2, 1, 1, DT_QUERIES_HEADERS.length).setValues(seed);
  }

  sheet.autoResizeColumns(1, DT_QUERIES_HEADERS.length);
  ss.toast(
    isFresh ? 'Created DT Queries sheet. Edit a row, then run.'
            : 'DT Queries sheet ready. Edit a row, then run.',
    'Initialize', 5
  );
}


function runDataTableQueryFromRow() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DT_QUERIES_SHEET);
  if (!sheet) {
    ss.toast('No DT Queries sheet. Run "Initialize DT Queries sheet" first.',
             'Data Tables', 6);
    return;
  }

  const activeSheet = ss.getActiveSheet();
  if (activeSheet.getName() !== DT_QUERIES_SHEET) {
    ss.toast('Switch to the DT Queries sheet, click a row, then re-run.',
             'Data Tables', 6);
    return;
  }

  const rowNum = activeSheet.getActiveRange().getRow();
  if (rowNum < 2) {
    ss.toast('Click a query row (not the header), then re-run.', 'Data Tables', 5);
    return;
  }

  runQueryRow_(sheet, rowNum);
}


function runAllEnabledDataTableQueries() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DT_QUERIES_SHEET);
  if (!sheet) {
    ss.toast('No DT Queries sheet. Run "Initialize DT Queries sheet" first.',
             'Data Tables', 6);
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    ss.toast('No queries defined.', 'Data Tables', 5);
    return;
  }

  const enabledCol = DT_QUERIES_HEADERS.indexOf('enabled') + 1;
  const enabledFlags = sheet.getRange(2, enabledCol, lastRow - 1, 1).getValues();

  let ran = 0, failed = 0;
  for (let i = 0; i < enabledFlags.length; i++) {
    if (enabledFlags[i][0] !== true) continue;
    try {
      runQueryRow_(sheet, i + 2);
      ran++;
    } catch (err) {
      failed++;
      Logger.log(`Query row ${i + 2} failed: ${err.message}`);
    }
  }

  ss.toast(`Ran ${ran} queries${failed ? `, ${failed} failed (see Logs)` : ''}.`,
           'Data Tables', 6);
}


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function runQueryRow_(sheet, rowNum) {
  const query = readQueryRow_(sheet, rowNum);
  validateQuery_(query);

  const opts = buildFetchOpts_(query);
  const records = fetchDataTableRecords(query.table_id, opts);

  writeLogRecordsToSheet(query.output_sheet, records, opts.select || null);

  stampQueryRow_(sheet, rowNum, records.length);

  SpreadsheetApp.getActive().toast(
    `${query.name || query.table_id}: ${records.length} records → "${query.output_sheet}"`,
    'Data Tables', 5
  );
}


function readQueryRow_(sheet, rowNum) {
  const values = sheet.getRange(rowNum, 1, 1, DT_QUERIES_HEADERS.length).getValues()[0];
  const row = {};
  DT_QUERIES_HEADERS.forEach(function (h, i) { row[h] = values[i]; });
  return row;
}


function validateQuery_(query) {
  if (!query.table_id || typeof query.table_id !== 'string'
      || query.table_id === 'paste-table-id-here') {
    throw new Error('table_id is required.');
  }
  if (!query.output_sheet || typeof query.output_sheet !== 'string') {
    throw new Error('output_sheet is required.');
  }

  ['select_json', 'where_json', 'order_json'].forEach(function (col) {
    if (query[col]) {
      try { JSON.parse(query[col]); }
      catch (e) { throw new Error(`${col} is not valid JSON: ${e.message}`); }
    }
  });
}


function buildFetchOpts_(query) {
  const opts = {};

  const limit = Number(query.limit);
  if (limit > 0) {
    opts.limit = limit;
    opts.maxRecords = limit;
  }

  const select = parseJsonOrDefault_(query.select_json, null);
  const where  = parseJsonOrDefault_(query.where_json,  null);
  const order  = parseJsonOrDefault_(query.order_json,  null);

  if (select) opts.select = select;
  if (where)  opts.where  = where;
  if (order)  opts.order  = order;   // string-or-hash, passed through verbatim

  const tzOffset = Number(query.tz_offset_secs);
  if (!isNaN(tzOffset) && query.tz_offset_secs !== '') {
    opts.timezoneOffsetSecs = tzOffset;
  }

  return opts;
}


function stampQueryRow_(sheet, rowNum, count) {
  const tsCol    = DT_QUERIES_HEADERS.indexOf('last_run_at')    + 1;
  const countCol = DT_QUERIES_HEADERS.indexOf('last_run_count') + 1;
  sheet.getRange(rowNum, tsCol).setValue(new Date());
  sheet.getRange(rowNum, countCol).setValue(count);
}


function parseJsonOrDefault_(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') {
    // A number cell (e.g. for select_json containing "1") would arrive non-string.
    // Bring it back to string before parsing.
    try { value = String(value); } catch (_) { return fallback; }
  }
  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}
