Let me build the shared module and syntax-check it before handing it over.Here's the migration. One new file plus a set of surgical edits — I kept every change to the smallest diff that removes duplication, and I syntax-checked the new module (`node --check` passed) so you won't be hunting a stray brace after pasting.

The order below matches the renamed file numbering, so you can work top to bottom. **Do step 1 first** — the rewritten functions call into the new library, so it has to exist before they run.

## 1. Create the new library (load-bearing)

Create a new script file named `00_workato_lib` and paste in the attached file's contents. That's the foundation; everything else either calls into it or deletes a now-redundant copy.

## 2. `02_workato_recipes`

**Replace** `getStructuredRecipes` entirely:

```js
function getStructuredRecipes(opts) {
  opts = opts || {};

  const baseUrl = getWorkatoConfig_().baseUrl;

  // 1. Page through the list endpoint.
  const recipes = [];
  const perPage = 100;
  let   page    = 1;

  while (true) {
    const params = [`page=${page}`, `per_page=${perPage}`];
    if (opts.folderId)    params.push(`folder_id=${encodeURIComponent(opts.folderId)}`);
    if (opts.runningOnly) params.push('running=true');

    const url   = `${baseUrl}/api/recipes?${params.join('&')}`;
    const json  = workatoGet_(url, 'List recipes');
    const batch = Array.isArray(json.items) ? json.items
                : Array.isArray(json)        ? json
                : [];

    recipes.push.apply(recipes, batch);
    if (batch.length < perPage) break;
    page++;
  }

  // 2. Shape each recipe.
  return recipes.map(function (r) {
    const out = {
      id:                   r.id,
      name:                 r.name,
      folder_id:            r.folder_id,
      running:              r.running,
      description:          r.description || '',
      trigger_application:  r.trigger_application || null,
      action_applications:  r.action_applications  || [],
      job_succeeded_count:  r.job_succeeded_count  || 0,
      job_failed_count:     r.job_failed_count     || 0,
      created_at:           r.created_at,
      updated_at:           r.updated_at,
      last_run_at:          r.last_run_at || null
    };

    if (opts.includeCode) {
      const detail = workatoGet_(`${baseUrl}/api/recipes/${r.id}`, `Recipe ${r.id} detail`);
      out.code   = safeParseJson_(detail.code);
      out.config = safeParseJson_(detail.config);
    }

    return out;
  });
}
```

**Replace** `replicateTableDiscovery` entirely:

```js
function replicateTableDiscovery() {
  const baseUrl = getWorkatoConfig_().baseUrl;

  let page = 1;
  const perPage = 100;
  let allTables = [];

  while (true) {
    const url   = `${baseUrl}/api/data_tables?page=${page}&per_page=${perPage}`;
    const json  = workatoGet_(url, 'List data tables');
    const batch = Array.isArray(json.data)    ? json.data
                : Array.isArray(json.records) ? json.records
                : Array.isArray(json)         ? json
                : [];

    allTables = allTables.concat(batch);
    if (batch.length < perPage) break;
    page++;
  }

  return allTables;
}
```

**Delete** the entire `getSimplifiedDataTables` function (the unused near-duplicate).

**Delete** the entire `fetchJson_` function under `// --- INTERNALS ---`. Leave `safeParseJson_` exactly as it is — it stays.

## 3. `06_recipe_sync`

In `writeSheet_`, two line-level swaps. **Replace:**

```js
  const sheet = ss.getSheetByName(RECIPE_SHEET_NAME) || ss.insertSheet(RECIPE_SHEET_NAME);
  const baseUrl = (PropertiesService.getScriptProperties().getProperty('WORKATO_BASE_URL')
                   || 'https://app.eu.workato.com').replace(/\/$/, '');
```

**with:**

```js
  const sheet   = getOrCreateSheet_(RECIPE_SHEET_NAME);
  const baseUrl = getWorkatoConfig_().baseUrl;
```

(Keep the `const ss = SpreadsheetApp.getActive();` line above it — `ss` is still used for the `toast` at the end.)

## 4. `07_recipe_drive_cache`

**Replace** `getOrCreateTrimmedSubfolder_` with the slim version:

```js
function getOrCreateTrimmedSubfolder_() {
  return getOrCreateSubfolder_(getOrThrowDriveFolder_(), 'trimmed');
}
```

## 5. `08_trim_measurement_sheet`

**Delete** the entire `getOrCreateSheet_` function here — the library now owns it. Its callers in this file (`writeTrimLatestSheet_`, `appendTrimSnapshotRow_`, `writeTrimComparisonSheet_`) keep working unchanged; they'll just resolve to the library copy.

## 6. `09_data_table_ops_report`

In `writeDataTableOpsSheet_`, **replace:**

```js
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DT_OPS_SHEET) || ss.insertSheet(DT_OPS_SHEET);
```

**with:**

```js
  const sheet = getOrCreateSheet_(DT_OPS_SHEET);
```

## 7. `10_recipe_inspector`

In `inspectConnectorUsage`, **replace:**

```js
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('Connector Usage') || ss.insertSheet('Connector Usage');
```

**with:**

```js
  const sheet = getOrCreateSheet_('Connector Usage');
```

## 8. `12_data_table_records` (after rename)

**Replace** the `fetchDataTableRecords` JSDoc block *and* the function together — this also fixes the two contract bugs (the `timeZoneOffsetSecs` casing in the doc, and the limit cap contradicting its own doc), and pulls the page-size cap out into a named constant:

```js
const DT_MAX_PAGE_SIZE = 200;   // Workato Data Tables query page cap. Raise only if the API docs confirm a higher limit.

/**
 * Fetch records from a data table, paginated.
 *
 * @param {string}        tableId
 * @param {Array}         [opts.select]              Column names to return
 * @param {Object}        [opts.where]               Filter hash
 * @param {string|Object} [opts.order]               Field name, or { by, order, case_sensitive }
 * @param {number}        [opts.limit]               Page size (default and cap 200; use maxRecords for totals)
 * @param {number}        [opts.maxRecords]          Stop early after this many records
 * @param {number}        [opts.timezoneOffsetSecs]  Required when comparing date-time to date
 * @param {boolean}       [opts.returnRaw]           Return positional response pages instead of records
 * @returns {Array<Object>} Records keyed by field name, or raw response pages if returnRaw
 */
function fetchDataTableRecords(tableId, opts) {
  opts = opts || {};
  const pageSize   = Math.min(opts.limit || DT_MAX_PAGE_SIZE, DT_MAX_PAGE_SIZE);
  const maxRecords = opts.maxRecords || Infinity;
  const returnRaw  = !!opts.returnRaw;

  const recordsHost = getWorkatoConfig_().recordsHost;
  const url         = `${recordsHost}/api/v1/tables/${tableId}/query`;

  const allRecords = [];
  const rawPages   = [];
  let continuationToken = null;
  let pages = 0;

  while (allRecords.length < maxRecords) {
    const body = { limit: pageSize };
    if (opts.select)                     body.select               = opts.select;
    if (opts.where)                      body.where                = opts.where;
    if (opts.order)                      body.order                = opts.order;
    if (opts.timezoneOffsetSecs != null) body.timezone_offset_secs = opts.timezoneOffsetSecs;
    if (continuationToken)               body.continuation_token   = continuationToken;

    const json = workatoPost_(url, body, `Records query on table ${tableId}`);
    rawPages.push(json);

    const records   = transformResponseRecords_(json);
    const remaining  = maxRecords - allRecords.length;
    allRecords.push.apply(
      allRecords,
      records.length > remaining ? records.slice(0, remaining) : records
    );

    continuationToken = json.continuation_token || null;
    pages++;

    if (!continuationToken)              break;
    if (allRecords.length >= maxRecords) break;
    if (pages > 100) {
      Logger.log(`Pagination safety limit reached on table ${tableId}.`);
      break;
    }
  }

  return returnRaw ? rawPages : allRecords;
}
```

I deliberately left the cap at its current value of 200 rather than raising it — that's behavior, not cleanup, and I didn't want to silently change what your queries do. The doc now matches the code. If you confirm in the current Data Tables query docs that your region/tier allows a larger page (I believe the documented ceiling is higher), bump the one `DT_MAX_PAGE_SIZE` constant and you're done.

**Delete** the entire `getRecordsHost_` function — it's folded into `getWorkatoConfig_().recordsHost` now, and `fetchDataTableRecords` was its only caller.

In `writeLogRecordsToSheet`, **replace:**

```js
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
```

**with:**

```js
  const sheet = getOrCreateSheet_(sheetName);
```

## 9. `14_recipe_manifest_runner` (after rename)

**Replace** `getOrCreateManifestsSubfolder_` with the slim version:

```js
function getOrCreateManifestsSubfolder_() {
  return getOrCreateSubfolder_(getOrThrowDriveFolder_(), 'manifests');
}
```

## File renames

The last four files have no numeric prefix. Renaming is purely organizational — nothing in the code references a file name, all functions share one global namespace, and your top-level `const`s don't call across files at load time, so order can't bite you. Rename:

- `data_table_query_runner` → `11_data_table_query_runner`
- `data_table_records` → `12_data_table_records`
- `recipe_manifest` → `13_recipe_manifest`
- `recipe_manifest_runner` → `14_recipe_manifest_runner`

**In the Apps Script web editor:** in the left Files panel, click the ⋮ next to each file → *Rename* → type the new base name (no extension; the `.gs`/`.js` suffix is cosmetic and the editor manages it).

**If you manage this via clasp** (likely, given your Cloud Source Repo workflow): rename the local files and `clasp push`. Keep the `.js` extension — clasp maps `.js`/`.gs` to script files either way. A `git mv` keeps the history clean:

```bash
git mv data_table_query_runner.js 11_data_table_query_runner.js
git mv data_table_records.js      12_data_table_records.js
git mv recipe_manifest.js         13_recipe_manifest.js
git mv recipe_manifest_runner.js  14_recipe_manifest_runner.js
clasp push
```

## Quick checklist

1. Create `00_workato_lib` (paste the attached file).
2. `02`: replace two functions, delete `getSimplifiedDataTables` and `fetchJson_`.
3. `06`, `09`, `10`, `12`: swap the sheet-acquisition lines (and in `06`, the baseUrl line).
4. `07` and `14`: slim the two subfolder helpers.
5. `08`: delete the local `getOrCreateSheet_`.
6. `12`: replace `fetchDataTableRecords` + JSDoc, add `DT_MAX_PAGE_SIZE`, delete `getRecordsHost_`.
7. Rename the four files to `11`–`14`.

After this, every Workato call routes through `workatoGet_`/`workatoPost_` and inherits the 429/5xx backoff for free, there's one config accessor, one HTTP transport, one sheet helper, and one subfolder helper. The four hand-rolled fetch loops and the two dead duplicates are gone.

```javascript
/**
 * Shared Workato + Apps Script plumbing.
 *
 * Single home for the things that were copy-pasted across modules:
 *   - getWorkatoConfig_()         credentials + base/records hosts, resolved once
 *   - httpJson_()                 one HTTP transport: status check + retry on 429/5xx
 *   - workatoGet_ / workatoPost_  auth-stamped GET/POST over httpJson_
 *   - getOrCreateSheet_()         idempotent sheet accessor
 *   - getOrCreateSubfolder_()     idempotent Drive subfolder accessor
 *
 * Load order is irrelevant (these are functions, hoisted), but the 00_ prefix
 * marks this as the foundation the other modules call into. No business logic
 * lives here — pure plumbing.
 */


// --- CONFIG --------------------------------------------------------------------------
/**
 * Workato credentials and hosts, resolved from Script Properties.
 *
 *   WORKATO_API_TOKEN    required
 *   WORKATO_BASE_URL     optional, defaults to the EU platform host
 *   WORKATO_RECORDS_URL  optional, overrides the derived data-tables host
 *
 * The records host is derived from the platform host by swapping the `app.`
 * prefix for `data-tables.` (app.eu.workato.com -> data-tables.eu.workato.com),
 * unless WORKATO_RECORDS_URL is set explicitly.
 *
 * @returns {{ apiToken: string, baseUrl: string, recordsHost: string }}
 */
function getWorkatoConfig_() {
  const props    = PropertiesService.getScriptProperties();
  const apiToken = props.getProperty('WORKATO_API_TOKEN');
  const baseUrl  = (props.getProperty('WORKATO_BASE_URL') || 'https://app.eu.workato.com')
                     .replace(/\/$/, '');

  const explicitRecords = props.getProperty('WORKATO_RECORDS_URL');
  const recordsHost = explicitRecords
    ? explicitRecords.replace(/\/$/, '')
    : baseUrl.replace(/^https?:\/\/app\./, 'https://data-tables.');

  return { apiToken: apiToken, baseUrl: baseUrl, recordsHost: recordsHost };
}


// --- HTTP TRANSPORT ------------------------------------------------------------------
/**
 * Fetch a URL and parse JSON. Throws on any non-2xx once retries are exhausted.
 * Retries 429 and 5xx with exponential backoff; everything else fails fast.
 *
 * @param {string} url
 * @param {Object} options  UrlFetchApp options (method, headers, payload, ...)
 * @param {string} [label]  Context string used in the error message
 * @returns {Object|Array|null} Parsed JSON, or null on an empty 2xx body
 */
function httpJson_(url, options, label) {
  options = Object.assign({ muteHttpExceptions: true }, options || {});
  const delays = [1000, 2000, 4000];

  for (let attempt = 0; ; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const code     = response.getResponseCode();
    const text     = response.getContentText();

    if (code >= 200 && code < 300) {
      return text ? JSON.parse(text) : null;
    }

    const transient = code === 429 || (code >= 500 && code <= 599);
    if (transient && attempt < delays.length) {
      Utilities.sleep(delays[attempt]);
      continue;
    }
    throw new Error(`${label || 'HTTP request'} failed (HTTP ${code}): ${text}`);
  }
}
/** Auth-stamped GET against the Workato platform API. */
function workatoGet_(url, label) {
  const cfg = getWorkatoConfig_();
  return httpJson_(url, {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${cfg.apiToken}`,
      'Accept': 'application/json'
    }
  }, label);
}
/** Auth-stamped POST (JSON body) against the Workato API. */
function workatoPost_(url, body, label) {
  const cfg = getWorkatoConfig_();
  return httpJson_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { 'Authorization': `Bearer ${cfg.apiToken}` }
  }, label);
}


// --- SHEET / DRIVE HELPERS -----------------------------------------------------------
/** Return the named sheet in the active spreadsheet, creating it if absent. */
function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
/** Return the named subfolder under `parent`, creating it if absent. */
function getOrCreateSubfolder_(parent, name) {
  const existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}
```
