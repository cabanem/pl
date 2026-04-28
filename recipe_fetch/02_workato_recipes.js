/**
 * Workato API client — structured recipe retrieval.
 *
 * The list endpoint returns metadata only. The detail endpoint returns
 * `code` and `config` as JSON-encoded strings, which we parse a second
 * time to expose them as real objects.
 */


/**
 * @param {Object} [opts]
 * @param {number}  [opts.folderId]
 * @param {boolean} [opts.runningOnly]
 * @param {boolean} [opts.includeCode]   - 1 extra API call per recipe
 * @returns {Array<Object>}
 */
function getStructuredRecipes(opts) {
  opts = opts || {};

  const props    = PropertiesService.getScriptProperties();
  const apiToken = props.getProperty('WORKATO_API_TOKEN');
  const baseUrl  = (props.getProperty('WORKATO_BASE_URL') || 'https://app.eu.workato.com')
                     .replace(/\/$/, '');

  const fetchOpts = {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json'
    }
  };

  // 1. Page through the list endpoint.
  const recipes = [];
  const perPage = 100;
  let   page    = 1;

  while (true) {
    const params = [`page=${page}`, `per_page=${perPage}`];
    if (opts.folderId)    params.push(`folder_id=${encodeURIComponent(opts.folderId)}`);
    if (opts.runningOnly) params.push('running=true');

    const url   = `${baseUrl}/api/recipes?${params.join('&')}`;
    const json  = fetchJson_(url, fetchOpts, 'List recipes');
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
      const detail = fetchJson_(
        `${baseUrl}/api/recipes/${r.id}`,
        fetchOpts,
        `Recipe ${r.id} detail`
      );
      out.code   = safeParseJson_(detail.code);
      out.config = safeParseJson_(detail.config);
    }

    return out;
  });
}


/**
 * Standalone replication of the original table-discovery function. Used
 * by the data-tables ops report to build a (table_id → table_name) index.
 */
function replicateTableDiscovery() {
  const props    = PropertiesService.getScriptProperties();
  const apiToken = props.getProperty('WORKATO_API_TOKEN');
  const baseUrl  = (props.getProperty('WORKATO_BASE_URL') || 'https://app.eu.workato.com')
                     .replace(/\/$/, '');

  let page = 1;
  const perPage = 100;
  let allTables = [];

  const options = {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json'
    }
  };

  while (true) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/data_tables?page=${page}&per_page=${perPage}`;
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code < 200 || code >= 300) {
      throw new Error(`API Error ${code}: ${response.getContentText()}`);
    }

    const json = JSON.parse(response.getContentText());
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


/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function fetchJson_(url, options, label) {
  const response = UrlFetchApp.fetch(url, options);
  const code     = response.getResponseCode();
  const text     = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`${label} failed (HTTP ${code}): ${text}`);
  }
  return JSON.parse(text);
}


function safeParseJson_(value) {
  if (value == null)              return null;
  if (typeof value === 'object')  return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return value;
  }
}
