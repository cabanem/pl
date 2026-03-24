/**
 * @file 001_Workato_Client.gs
 * @description Resilient HTTP client and Workato resource service layer.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM PREVIOUS VERSION:
 *  - WorkatoClient: added dataTablesBaseUrl constant ('https://www.workato.com/api').
 *    Data table management endpoints always use www.workato.com regardless of data
 *    center — this is hardcoded in Workato's own documentation. Regional BASE_URL
 *    (e.g. app.eu.workato.com) is correct for recipes/folders/properties/users but
 *    returns 401 for data table calls.
 *  - WorkatoClient: added getRaw(fullUrl) — a GET that bypasses Lib_WorkatoClient
 *    (which has the regional URL baked in) and goes directly through _requestWithBackoff.
 *    Used by data table methods that must target www.workato.com.
 *  - InventoryService: all five data table methods (getLookupTables, getDataTables,
 *    getDataTableDetails, createDataTable, updateDataTable) now route through
 *    dataTablesBaseUrl via getRaw / post / put with full URLs.
 *  - InventoryService: _fetchPaginatedNormalized_ accepts an optional baseUrl param
 *    so the data table list calls use www.workato.com while all other paginated calls
 *    continue to use the regional BASE_URL via Lib_WorkatoClient.
 *  - InventoryService: getDeployedTableSchema no longer calls getDataTableDetails.
 *    The schema array is already present in the list response — the second call was
 *    redundant and was the source of the data_dtables typo issue.
 *  - InventoryService: getDataTableDetails endpoint corrected from 'data_dtables'
 *    to 'data_tables', and routed through dataTablesBaseUrl.
 */

// ---------------------------------------------------------------------------
// HTTP CLIENT
// ---------------------------------------------------------------------------

/**
 * Resilient HTTP wrapper for Workato API calls.
 * Delegates GET and paginated requests to Lib_WorkatoClient for the regional
 * workspace API. Exposes getRaw() for endpoints that require a different base URL.
 * Implements its own exponential backoff for all write operations.
 */
class WorkatoClient {
  constructor(apiTokenOverride = null, deps = {}) {
    const apiConfig = AppConfig.get().API;
    const verbose   = AppConfig.get().VERBOSE;

    this.baseUrl    = apiConfig.BASE_URL;
    this.token      = apiTokenOverride || apiConfig.TOKEN;
    this.maxRetries = apiConfig.MAX_RETRIES || 5;
    this.fetchFn    = deps.fetchFn || UrlFetchApp.fetch;

    // Data table management endpoints always use www.workato.com regardless of
    // data center. Do not substitute this with BASE_URL.
    // Reference: https://docs.workato.com/en/workato-api/data-tables.html
    this.dataTablesBaseUrl = 'https://www.workato.com/api';

    this.client = Lib_WorkatoClient.newClient(
      this.token,
      this.baseUrl,
      {
        verbose:    verbose,
        maxRetries: this.maxRetries,
        dryRun:     false,
        perPage:    apiConfig.PER_PAGE
      }
    );
  }

  // Delegates to Lib_WorkatoClient — uses regional BASE_URL
  get(endpoint)                { return this.client.get(endpoint); }
  fetchPaginated(resourcePath) { return this.client.fetchPaginated(resourcePath); }

  // Bypasses Lib_WorkatoClient — caller provides the full URL.
  // Used for endpoints that require a different base URL (e.g. data tables).
  getRaw(fullUrl) { return this._requestWithBackoff('get', fullUrl); }

  post(endpoint, payload)  { return this._requestWithBackoff('post',  endpoint, payload); }
  put(endpoint, payload)   { return this._requestWithBackoff('put',   endpoint, payload); }
  patch(endpoint, payload) { return this._requestWithBackoff('patch', endpoint, payload); }

  _requestWithBackoff(method, endpoint, payload = null) {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${this.baseUrl}/${endpoint.replace(/^\//, '')}`;

    const options = {
      method:          method.toLowerCase(),
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json'
      },
      muteHttpExceptions: true
    };

    if (payload) {
      options.payload = JSON.stringify(payload);
    }

    let backoffMs = 1000;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response;

      try {
        response = this.fetchFn(url, options);
      } catch (networkError) {
        if (attempt === this.maxRetries) {
          throw new Error(`Network error after ${this.maxRetries} retries: ${networkError.message}`);
        }
        Utilities.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 32000);
        continue;
      }

      const statusCode   = response.getResponseCode();
      const responseText = response.getContentText();

      if (statusCode >= 200 && statusCode < 300) {
        if (!responseText) return null;
        try {
          return JSON.parse(responseText);
        } catch (_parseErr) {
          return { raw_content: responseText };
        }
      }

      if (statusCode === 429 || statusCode >= 500) {
        if (attempt === this.maxRetries) {
          throw new Error(`API failed after ${this.maxRetries} retries. Status: ${statusCode} | URL: ${url} | Response: ${responseText}`);
        }
        Utilities.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 32000);
        continue;
      }

      throw new Error(`Non-retryable API error. Status: ${statusCode} | URL: ${url} | Response: ${responseText}`);
    }

    throw new Error(`Unexpected request failure for ${method.toUpperCase()} ${url}`);
  }
}

// ---------------------------------------------------------------------------
// INVENTORY SERVICE
// ---------------------------------------------------------------------------

/**
 * Fetches and manages Workato workspace resources:
 * projects, recipes, environment properties, data tables, folders, users.
 *
 * Note on base URLs:
 *  - recipes, folders, projects, properties, users → client.baseUrl (regional)
 *  - data tables (management API) → client.dataTablesBaseUrl (www.workato.com)
 *  - data table records API → data-tables.workato.com (handled by WorkatoRepairClient)
 */
class InventoryService {
  /**
   * @param {WorkatoClient} client
   */
  constructor(client) {
    this.client = client;
    this.config = AppConfig.get();
  }

  // --- PROJECTS ---------------------------------------------------------------

  /** @returns {Array<Object>} */
  getProjects() { return this.client.fetchPaginated('projects'); }

  // --- RECIPES ----------------------------------------------------------------

  /** @returns {Array<Object>} */
  getRecipes() { return this.client.fetchPaginated('recipes'); }

  // --- PROPERTIES -------------------------------------------------------------

  /**
   * Safely handles 403 if the caller lacks permissions.
   * @returns {Array<Object>}
   */
  getProperties() {
    try {
      return this.client.fetchPaginated('properties');
    } catch (e) {
      console.warn(`SKIPPING PROPERTIES: The API rejected the request (${e.message}).`);
      return [];
    }
  }

  /**
   * Bulk upserts workspace environment properties.
   * Workato expects: { "properties": { "Key1": "Value1" } }
   * @param {Array<{name: string, defaultValue: string}>} properties
   * @returns {Object}
   */
  upsertProperties(properties) {
    const propsMap = {};
    properties.forEach(prop => {
      propsMap[prop.name] = String(prop.defaultValue || '');
    });
    return this.client.post('properties', { properties: propsMap });
  }

  // --- TABLES -----------------------------------------------------------------

  /**
   * Fetches all lookup tables.
   * Uses regional BASE_URL — lookup tables are not subject to the data tables
   * base URL rule.
   * @returns {Array<Object>}
   */
  getLookupTables() {
    return this._fetchPaginatedNormalized_('lookup_tables');
  }

  /**
   * Fetches all data tables, including their full schema arrays.
   * Routes through dataTablesBaseUrl (www.workato.com) — required regardless
   * of data center.
   * @returns {Array<Object>}
   */
  getDataTables() {
    return this._fetchPaginatedNormalized_(
      'data_tables',
      this.client.dataTablesBaseUrl
    );
  }

  /**
   * Fetches full details for a single data table by ID.
   * Routes through dataTablesBaseUrl.
   * @param {number|string} tableId
   * @returns {Object}
   */
  getDataTableDetails(tableId) {
    // FIXED: was 'data_dtables' — correct endpoint is 'data_tables'.
    // FIXED: routed through dataTablesBaseUrl — was using regional BASE_URL.
    return this.client.getRaw(`${this.client.dataTablesBaseUrl}/data_tables/${tableId}`);
  }

  /**
   * Fetches the deployed schema for a specific data table by name.
   * Schema is already present in the list response — no detail call needed.
   *
   * @param {string} tableName
   * @returns {{ tableName: string, columns: Array<Object> }|null}
   */
  getDeployedTableSchema(tableName) {
    try {
      const allTables = this.getDataTables();
      const tableDef  = allTables.find(t => t.name === tableName);
      if (!tableDef) return null;

      // The list response already includes the full schema array.
      // No secondary detail call required.
      return {
        tableName: tableDef.name,
        columns:   tableDef.schema || tableDef.columns || []
      };
    } catch (e) {
      console.error(`Error fetching schema for ${tableName}: ${e.message}`);
      return null;
    }
  }

  /**
   * Creates a new data table.
   * Routes through dataTablesBaseUrl.
   * @param {string} name
   * @param {number} folderId
   * @param {Array<Object>} schema
   * @returns {Object}
   */
  createDataTable(name, folderId, schema) {
    return this.client.post(
      `${this.client.dataTablesBaseUrl}/data_tables`,
      { name, folder_id: folderId, schema }
    );
  }

  /**
   * Updates the schema for an existing data table.
   * Routes through dataTablesBaseUrl.
   * @param {number|string} tableId
   * @param {Array<Object>} schema
   * @returns {Object}
   */
  updateDataTable(tableId, schema) {
    return this.client.put(
      `${this.client.dataTablesBaseUrl}/data_tables/${tableId}`,
      { schema }
    );
  }

  // --- FOLDERS ----------------------------------------------------------------

  /**
   * Recursively fetches all folders using a 3-phase hybrid sync strategy:
   *  1. Scan project roots (folders?project_id=X)
   *  2. Scan workspace root (folders)
   *  3. BFS queue for children (folders?parent_id=Y)
   *
   * @param {Array<Object>} projects
   * @returns {Array<Object>}
   */
  getFoldersRecursive(projects) {
    let allFolders   = [];
    let queue        = [];
    let qIndex       = 0;
    let processedIds = new Set();
    const MAX_CALLS  = this.config.API.MAX_CALLS;

    AppLogger.verbose('Starting folder sync...');

    // Phase 1: project roots
    for (const project of projects) {
      try {
        const potentialRoots = this._fetchFolderBatch(`folders?project_id=${project.id}`);
        const rootFolder = potentialRoots.find(f => f.project_id === project.id && f.is_project === true);
        if (rootFolder && !processedIds.has(rootFolder.id)) {
          allFolders.push(rootFolder);
          processedIds.add(rootFolder.id);
          queue.push(rootFolder.id);
        }
      } catch (e) {
        console.warn(`Failed to fetch root for project ${project.id}: ${e.message}`);
      }
    }

    // Phase 2: home folders
    let globalFolders = [];
    try {
      globalFolders = this.client.fetchPaginated('folders');
    } catch (e) {
      globalFolders = this._fetchFolderBatch('folders');
    }
    globalFolders.forEach(f => {
      if (!processedIds.has(f.id)) {
        allFolders.push(f);
        processedIds.add(f.id);
        queue.push(f.id);
      }
    });

    // Phase 3: BFS recursion
    let safetyCounter = 0;
    while (qIndex < queue.length && safetyCounter < MAX_CALLS) {
      const parentId = queue[qIndex++];
      let page    = 1;
      let hasMore = true;

      while (hasMore) {
        const url   = `folders?parent_id=${parentId}&page=${page}&per_page=${this.config.API.PER_PAGE}`;
        const items = this._fetchFolderBatch(url);

        if (items.length > 0) {
          const newItems = items.filter(f => !processedIds.has(f.id));
          if (newItems.length > 0) {
            allFolders = allFolders.concat(newItems);
            newItems.forEach(f => {
              processedIds.add(f.id);
              queue.push(f.id);
            });
          }
          if (items.length < this.config.API.PER_PAGE) hasMore = false;
          else page++;
        } else {
          hasMore = false;
        }
        safetyCounter++;
      }

      if (safetyCounter % 20 === 0) Utilities.sleep(50);
    }

    console.log(`Sync complete. Found ${allFolders.length} total folders.`);
    return allFolders;
  }

  /**
   * @param {string} name
   * @param {number} [parentId]
   * @returns {Object}
   */
  createFolder(name, parentId = null) {
    const payload = { name };
    if (parentId) payload.parent_id = parentId;
    return this.client.post('folders', payload);
  }

  // --- USER -------------------------------------------------------------------

  /** @returns {Object|null} */
  getCurrentUser() {
    try {
      return this.client.get('users/me');
    } catch (e) {
      return null;
    }
  }

  // --- INTERNALS --------------------------------------------------------------

  /** @private */
  _fetchFolderBatch(endpoint) {
    try {
      const json = this.client.get(endpoint);
      return Array.isArray(json) ? json : (json.items || json.result || []);
    } catch (e) {
      AppLogger.notify(`Failed to fetch folders at endpoint ${endpoint}: ${e.message}`, true);
      throw new Error(`InventoryService error: Failed to fetch folder batch. ${e.message}`);
    }
  }

  /**
   * Fetches all pages of a resource, normalizing the response shape.
   *
   * @param {string} resourcePath - Path relative to baseUrl (e.g. 'data_tables').
   * @param {string|null} [baseUrl] - If provided, overrides the default regional
   *   BASE_URL. Pass client.dataTablesBaseUrl for data table endpoints.
   * @private
   */
  _fetchPaginatedNormalized_(resourcePath, baseUrl = null) {
    // If no baseUrl override, attempt the library's paginated fetch first
    // (only works against the regional URL it was constructed with)
    if (!baseUrl) {
      try {
        const res = this.client.fetchPaginated(resourcePath);
        const arr = this._normalizeListResponse_(res);
        if (Array.isArray(arr)) return arr;
      } catch (e) {
        // fall through to manual paging
      }
    }

    // Manual paging — used for any endpoint that needs a specific base URL,
    // or as fallback when the library call fails.
    const effectiveBase = (baseUrl || this.client.baseUrl).replace(/\/$/, '');
    const out           = [];
    const perPage       = Number(this.config.API.PER_PAGE || 100);
    const maxCalls      = Number(this.config.API.MAX_CALLS || 500);
    let   page          = 1;
    let   safety        = 0;

    while (safety < maxCalls) {
      try {
        const url   = `${effectiveBase}/${resourcePath}?page=${page}&per_page=${perPage}`;
        const json  = this.client.getRaw(url);
        const items = this._normalizeListResponse_(json);
        if (!items || items.length === 0) break;
        out.push(...items);
        if (items.length < perPage) break;
        page++;
        safety++;
        if (safety % 10 === 0) Utilities.sleep(50);
      } catch (e) {
        console.warn(`SKIPPING ${resourcePath.toUpperCase()}: ${e.message}`);
        break;
      }
    }

    return out;
  }

  /** @private */
  _normalizeListResponse_(json) {
    if (Array.isArray(json))          return json;
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json.data))     return json.data;
    if (Array.isArray(json.items))    return json.items;
    if (Array.isArray(json.result))   return json.result;
    return [];
  }
}
