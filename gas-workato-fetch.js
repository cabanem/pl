/**
 * Fetches structured recipe data from the Workato Platform API.
 *
 * The list endpoint (/api/recipes) returns metadata only.
 * The detail endpoint (/api/recipes/{id}) returns the full recipe,
 * including `code` (the trigger + steps tree) and `config` (connection
 * bindings). Both are JSON-encoded *strings* inside the JSON response,
 * so they must be parsed a second time to be usable as structured data.
 *
 * @param {Object} [opts]
 * @param {number}  [opts.folderId]    - Restrict to a single folder
 * @param {boolean} [opts.runningOnly] - Only running recipes
 * @param {boolean} [opts.includeCode] - Fetch detail for each recipe
 *                                       (1 extra API call per recipe)
 * @returns {Array<Object>} Structured recipes
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

  // ---- 1. Page through the list endpoint -----------------------------------
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

  // ---- 2. Shape each recipe into a clean structured record -----------------
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
      // `code` and `config` come back as JSON strings — parse them.
      out.code   = safeParseJson_(detail.code);   // Trigger + steps tree
      out.config = safeParseJson_(detail.config); // Connection bindings
    }

    return out;
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Fetch + JSON parse with consistent error reporting. */
function fetchJson_(url, options, label) {
  const response = UrlFetchApp.fetch(url, options);
  const code     = response.getResponseCode();
  const text     = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`${label} failed (HTTP ${code}): ${text}`);
  }
  return JSON.parse(text);
}

/**
 * Workato returns recipe `code` and `config` as JSON-encoded strings.
 * Parse defensively: tolerate already-parsed objects and non-JSON values.
 */
function safeParseJson_(value) {
  if (value == null)              return null;
  if (typeof value === 'object')  return value; // already parsed
  try {
    return JSON.parse(value);
  } catch (_e) {
    return value; // not JSON — return raw
  }
}

/* -------------------------------------------------------------------------- */
/* Example callers                                                            */
/* -------------------------------------------------------------------------- */

/** Just metadata for every recipe in the workspace. */
function listAllRecipesMetadata() {
  const recipes = getStructuredRecipes();
  Logger.log(`Retrieved ${recipes.length} recipes (metadata only).`);
  return recipes;
}

/** Full structured payload for one folder — useful when iterating on a project. */
function getFolderRecipesWithCode(folderId) {
  const recipes = getStructuredRecipes({
    folderId: folderId,
    includeCode: true
  });
  Logger.log(`Retrieved ${recipes.length} recipes with parsed code/config.`);
  return recipes;
}
