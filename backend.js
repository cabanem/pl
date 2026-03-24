/**
 * @file 000_Core.gs
 * @description DI container, command runner, configuration, logging, and secrets.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * {@link https://docs.google.com/document/d/18cSIDzA65aZzq7fDIki-IBVYhb7SSrKe-qvWHmNholo/edit|internal_technical_documentation}
 *
 * CHANGES FROM ORIGINAL:
 *  - Removed AppFactory (one-liner wrapper around new AppContext — no added value)
 *  - Removed ConfigStore (never called anywhere in the codebase)
 *  - Replaced Commands class with runCommand() function (3 commands don't justify
 *    a lazy-init registry with a __init guard)
 *  - Fixed SecretStore.getOptional: typo 'val' → 'value' caused all optional
 *    secrets to always return defaultValue, silently breaking AppConfig
 */

// ---------------------------------------------------------------------------
// DEPENDENCY INJECTION
// ---------------------------------------------------------------------------

/**
 * Central dependency container for a single run invocation.
 * Constructs all service instances in one place so features don't new() everything.
 */
class AppContext {
  constructor(apiTokenOverride = null) {
    this.config = AppConfig.get();
    this.client = new WorkatoClient(apiTokenOverride);
    this.inventoryService = new InventoryService(this.client);
    this.logger = AppLogger;
  }
}

// ---------------------------------------------------------------------------
// COMMAND RUNNER
// ---------------------------------------------------------------------------

/**
 * Runs a named command with an optional args object and optional pre-built context.
 * @param {string} name
 * @param {Object} [args]
 * @param {AppContext} [ctx]
 * @returns {*}
 */
function runCommand(name, args = {}, ctx = null) {
  const registry = {
    'provision.workspace':             (c, a) => new ProvisioningRunner().run(c, a?.projectName ?? null),
    'diagnostics.detectDrift':         (c)    => new DiagnosticsRunner().detectDrift(c),
    'diagnostics.validateEnvironment': (_c, a) => validateBackendEnvironment(a?.requiredKeys ?? null)
  };

  const fn = registry[name];
  if (!fn) throw new Error(`Unknown command: ${name}`);
  return fn(ctx || new AppContext(), args);
}

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AppConfigObject
 * @property {Object} API - API connection settings.
 * @property {boolean} VERBOSE - Toggle for detailed logging.
 */

/**
 * Static configuration container. Reads from SecretStore on first call, then caches.
 */
class AppConfig {
  static get() {
    if (this._cache) return this._cache;

    const apiToken  = SecretStore.getOptional('WORKATO_API_TOKEN', '');
    const baseUrl   = SecretStore.getOptional('WORKATO_BASE_URL', 'https://app.eu.workato.com/api');
    const registryId = SecretStore.getOptional(
      'FLEET_REGISTRY_ID',
      '1-RzymJsEA-YWxaxk37QR5aiD3rlBAzdC1b5_4bKocKw'
    );

    this._cache = {
      API: {
        TOKEN:            apiToken,
        BASE_URL:         (baseUrl || 'https://app.eu.workato.com/api').replace(/\/$/, ''),
        PER_PAGE:         100,
        MAX_CALLS:        500,
        THROTTLE_MS:      100,
        MAX_RETRIES:      3,
        FLEET_REGISTRY_ID: registryId
      },
      VERBOSE: true
    };

    return this._cache;
  }

  static resetCache() {
    this._cache = null;
  }
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------

/**
 * Static logging utility. Writes to console and optionally to Lib_Logging_Technical.
 */
class AppLogger {
  static verbose(msg) {
    if (AppConfig.get().VERBOSE) console.log(`[VERBOSE] ${msg}`);
  }

  static notify(msg, isError = false) {
    if (isError) {
      console.error(msg);
      try {
        Lib_Logging_Technical.logEvent(
          msg,
          '1_backend_provisioning',
          'AppLogger.notify',
          Lib_Logging_Technical.Severity.ERROR
        );
      } catch (e) {
        console.error('Failed to reach Logger (technical) API');
      }
    } else {
      console.log(msg);
    }
  }

  static log(msg) {
    console.log(msg);
  }
}

// ---------------------------------------------------------------------------
// SECRETS
// ---------------------------------------------------------------------------

/**
 * Centralized access to Script Properties.
 */
class SecretStore {
  static scriptProps() {
    return PropertiesService.getScriptProperties();
  }

  static getRequired(key) {
    const value = this.scriptProps().getProperty(key);
    if (value === null || value === undefined || String(value).trim() === '') {
      throw new Error(`Missing required script property: ${key}`);
    }
    return String(value);
  }

  /**
   * @param {string} key
   * @param {string|null} [defaultValue]
   * @returns {string|null}
   */
  static getOptional(key, defaultValue = null) {
    const value = this.scriptProps().getProperty(key);
    // FIXED: original used undefined variable 'val' here — always returned defaultValue
    return (value === null || value === undefined || String(value).trim() === '')
      ? defaultValue
      : String(value);
  }

  static has(key) {
    const value = this.scriptProps().getProperty(key);
    return !(value === null || value === undefined || String(value).trim() === '');
  }

  static getEnv() {
    return String(this.getOptional('APP_ENV', 'dev')).toLowerCase();
  }

  static describePresence(keys) {
    return keys.map(key => ({ key, present: this.has(key) }));
  }
}

/**
 * @file 001_Workato_Client.gs
 * @description Resilient HTTP client and Workato resource service layer.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - No logic changes. Extracted from 03_Workato_Services.gs into its own file.
 *  - Added NOTE comment on getDataTableDetails endpoint spelling ('data_dtables')
 *    — verify against live API before changing.
 */

// ---------------------------------------------------------------------------
// HTTP CLIENT
// ---------------------------------------------------------------------------

/**
 * Resilient HTTP wrapper for Workato API calls.
 * Delegates GET and paginated requests to Lib_WorkatoClient.
 * Implements its own exponential backoff for POST / PUT / PATCH.
 */
class WorkatoClient {
  constructor(apiTokenOverride = null, deps = {}) {
    const apiConfig = AppConfig.get().API;
    const verbose   = AppConfig.get().VERBOSE;

    this.baseUrl    = apiConfig.BASE_URL;
    this.token      = apiTokenOverride || apiConfig.TOKEN;
    this.maxRetries = apiConfig.MAX_RETRIES || 5;
    this.fetchFn    = deps.fetchFn || UrlFetchApp.fetch;

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

  get(endpoint)              { return this.client.get(endpoint); }
  fetchPaginated(resourcePath) { return this.client.fetchPaginated(resourcePath); }

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

  /** @returns {Array<Object>} */
  getLookupTables() { return this._fetchPaginatedNormalized_('lookup_tables'); }

  /** @returns {Array<Object>} */
  getDataTables()   { return this._fetchPaginatedNormalized_('data_tables'); }

  /**
   * @param {number|string} tableId
   * @returns {Object}
   *
   * NOTE: The endpoint 'data_dtables' may be a typo of 'data_tables'.
   * Verify against the live Workato API before changing — the detail endpoint
   * may intentionally differ from the list endpoint.
   */
  getDataTableDetails(tableId) {
    return this.client.get(`data_dtables/${tableId}`);
  }

  /**
   * Fetches the deployed schema for a specific Workato Data Table by name.
   * @param {string} tableName
   * @returns {{ tableName: string, columns: Array<Object> }|null}
   */
  getDeployedTableSchema(tableName) {
    try {
      const allTables = this.getDataTables();
      const tableDef  = allTables.find(t => t.name === tableName);
      if (!tableDef) return null;

      const tableDetails = this.getDataTableDetails(tableDef.id);
      return {
        tableName: tableDetails.name,
        columns:   tableDetails.columns || tableDetails.schema || []
      };
    } catch (e) {
      console.error(`Error fetching schema for ${tableName}: ${e.message}`);
      return null;
    }
  }

  /**
   * @param {string} name
   * @param {number} folderId
   * @param {Array<Object>} schema
   * @returns {Object}
   */
  createDataTable(name, folderId, schema) {
    return this.client.post('data_tables', { name, folder_id: folderId, schema });
  }

  /**
   * @param {number|string} tableId
   * @param {Array<Object>} schema
   * @returns {Object}
   */
  updateDataTable(tableId, schema) {
    return this.client.put(`data_tables/${tableId}`, { schema });
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
    let allFolders  = [];
    let queue       = [];
    let qIndex      = 0;
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
      let page = 1;
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

  /** @private */
  _fetchPaginatedNormalized_(resourcePath) {
    try {
      const res = this.client.fetchPaginated(resourcePath);
      const arr = this._normalizeListResponse_(res);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      // fall through to manual paging
    }

    const out     = [];
    const perPage  = Number(this.config.API.PER_PAGE || 100);
    const maxCalls = Number(this.config.API.MAX_CALLS || 500);
    let page = 1;
    let safety = 0;

    while (safety < maxCalls) {
      try {
        const json  = this.client.get(`${resourcePath}?page=${page}&per_page=${perPage}`);
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
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json.data))   return json.data;
    if (Array.isArray(json.items))  return json.items;
    if (Array.isArray(json.result)) return json.result;
    return [];
  }
}

/**
 * @file 002_Provisioning.gs
 * @description Schema definitions, drift detection, and IaC provisioning runner.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - Fixed class name: DiagnosticRunner → DiagnosticsRunner (was mismatched
 *    with the command key registered in runCommand and the instantiation site)
 *  - No logic changes to ProvisioningConfig or ProvisioningRunner
 */

// ---------------------------------------------------------------------------
// PROVISIONING CONFIG
// ---------------------------------------------------------------------------

/**
 * Static config container. Source of truth for:
 *  - TARGET_FOLDER_NAME: the Workato folder to create/find inside each project
 *  - ENV_PROPERTIES: workspace environment properties to upsert on provisioning
 *  - TABLE_SCHEMA: the complete data model (10 tables)
 */
class ProvisioningConfig {
  static get TARGET_FOLDER_NAME() {
    return SecretStore.getOptional('WORKATO_TARGET_FOLDER_NAME', 'Supplier Data Collection');
  }

  static get ENV_PROPERTIES() {
    return [
      { name: 'ENV_CLIENT_NAME',           defaultValue: 'DefaultClientName' },
      { name: 'ENV_TARGET_VMS',            defaultValue: 'DefaultVMS' },
      { name: 'ENV_FILE_STORAGE_ROOT_ID',  defaultValue: 'fs-f-1a2b3c4d5e6f' },
      { name: 'ENV_SUPPLIER_PORTAL_URL',   defaultValue: 'https://app.workato.com/' },
      { name: 'ENV_ADMIN_ALERT_EMAIL',     defaultValue: 'Default@Randstad.com' }
    ];
  }

  static get TABLE_SCHEMA() {
    return [
      {
        name: 'WFA_TemplateProject',
        columns: [
          { name: 'id',               type: 'string',    optional: false },
          { name: 'project_name',     type: 'string',    optional: false },
          { name: 'target_vms',       type: 'string',    optional: false },
          { name: 'analyst_email',    type: 'string',    optional: false },
          { name: 'created_at',       type: 'date_time', optional: false },
          { name: '_correlation_id',  type: 'string',    optional: true }
        ]
      },
      {
        name: 'VER_TemplateVersion',
        columns: [
          { name: 'id',                      type: 'string',    optional: false, hint: 'Unique identifier for portability.' },
          { name: 'template_project_id',     type: 'string',    optional: false, hint: 'FK → WFA_TemplateProject.id' },
          { name: 'version_number',          type: 'integer',   optional: false },
          { name: 'status',                  type: 'string',    optional: true },
          { name: 'master_template_file_id', type: 'string',    optional: true },
          { name: 'published_at',            type: 'date_time', optional: false },
          { name: 'version_label',           type: 'string',    optional: true }
        ]
      },
      {
        name: 'WFA_SupplierRequest',
        columns: [
          { name: 'id',                          type: 'string',    optional: false },
          { name: 'current_template_version_id', type: 'string',    optional: false, hint: 'FK → VER_TemplateVersion.id' },
          { name: 'supplier_name',               type: 'string',    optional: false },
          { name: 'supplier_contact_name',       type: 'string',    optional: true },
          { name: 'assignee_email',              type: 'string',    optional: false },
          { name: 'has_seeded_data',             type: 'boolean',   optional: false },
          { name: 'seeded_data_file_id',         type: 'string',    optional: true },
          { name: 'status',                      type: 'string',    optional: false },
          { name: 'last_updated_at',             type: 'date_time', optional: false },
          { name: 'version_ui_link',             type: 'link',      target_table: 'VER_TemplateVersion', optional: true },
          { name: 'file_template',               type: 'file',      optional: true },
          { name: 'file_template_seeded',        type: 'file',      optional: true },
          { name: 'file_upload',                 type: 'file',      optional: true },
          { name: 'seeded_template_file_id',     type: 'string',    optional: true },
          { name: '_correlation_id',             type: 'string',    optional: true }
        ]
      },
      {
        name: 'CFG_Field',
        columns: [
          { name: 'id',                  type: 'string',  optional: false },
          { name: 'template_version_id', type: 'string',  optional: false, hint: 'FK → VER_TemplateVersion.id' },
          { name: 'field_name',          type: 'string',  optional: false },
          { name: 'description',         type: 'string',  optional: true },
          { name: 'data_type',           type: 'string',  optional: false },
          { name: 'required',            type: 'boolean', optional: false },
          { name: 'must_be_empty',       type: 'boolean', optional: false },
          { name: 'column_unique',       type: 'boolean', optional: false },
          { name: 'data_cleaning_flags', type: 'string',  optional: true },
          { name: 'position',            type: 'integer', optional: false },
          { name: 'lookup_name',         type: 'string',  optional: true }
        ]
      },
      {
        name: 'CFG_ErrorTranslation',
        columns: [
          { name: 'id',                    type: 'string', optional: false },
          { name: 'template_version_id',   type: 'string', optional: false, hint: 'FK → VER_TemplateVersion.id' },
          { name: 'sql_error_code',        type: 'string', optional: false },
          { name: 'human_readable_message',type: 'string', optional: false }
        ]
      },
      {
        name: 'CFG_Rule',
        columns: [
          { name: 'id',                  type: 'string',  optional: false },
          { name: 'field_id',            type: 'string',  optional: false },
          { name: 'rule_type',           type: 'string',  optional: false },
          { name: 'condition_field',     type: 'string',  optional: true },
          { name: 'condition_operator',  type: 'string',  optional: true },
          { name: 'condition_value',     type: 'string',  optional: true },
          { name: 'parameter_1',         type: 'string',  optional: true },
          { name: 'parameter_2',         type: 'string',  optional: true },
          { name: 'error_message',       type: 'string',  optional: false },
          { name: 'strict_enforcement',  type: 'boolean', optional: false },
          { name: 'template_version_id', type: 'string',  optional: true, hint: 'FK → VER_TemplateVersion.id' },
          { name: 'field_name',          type: 'link',    target_table: 'CFG_Field', optional: true }
        ]
      },
      {
        name: 'CFG_Lookup',
        columns: [
          { name: 'id',                  type: 'string', optional: false },
          { name: 'template_version_id', type: 'string', optional: false },
          { name: 'lookup_name',         type: 'string', optional: false },
          { name: 'valid_values',        type: 'string', optional: false }
        ]
      },
      {
        name: 'RUN_Upload',
        columns: [
          { name: 'id',                        type: 'string',    optional: false },
          { name: 'supplier_request_id',       type: 'string',    optional: false },
          { name: 'submitted_file_id',         type: 'string',    optional: true },
          { name: 'extracted_file_version_id', type: 'string',    optional: true },
          { name: 'valid_payload',             type: 'string',    optional: true },
          { name: 'status',                    type: 'string',    optional: false },
          { name: 'submitted_at',              type: 'date_time', optional: false },
          { name: 'submitted_at_str',          type: 'string',    optional: true }
        ]
      },
      {
        name: 'RUN_ValidationResult',
        columns: [
          { name: 'id',                type: 'string',    optional: false },
          { name: 'upload_id',         type: 'string',    optional: false },
          { name: 'status',            type: 'string',    optional: false },
          { name: 'valid_rows',        type: 'integer',   optional: true },
          { name: 'invalid_rows',      type: 'integer',   optional: true },
          { name: 'completed_at',      type: 'date_time', optional: false },
          { name: 'submitted_at_str',  type: 'link',      target_table: 'RUN_Upload', optional: true }
        ]
      },
      {
        name: 'RUN_FieldError',
        columns: [
          { name: 'id',                   type: 'string',  optional: false },
          { name: 'validation_result_id', type: 'string',  optional: false, hint: 'FK → RUN_ValidationResult.id' },
          { name: 'field_id',             type: 'string',  optional: false },
          { name: 'row_number',           type: 'integer', optional: false },
          { name: 'submitted_value',      type: 'string',  optional: true },
          { name: 'error_message',        type: 'string',  optional: false },
          { name: 'field_name',           type: 'link',    target_table: 'CFG_Field', optional: true }
        ]
      }
    ];
  }
}

// ---------------------------------------------------------------------------
// DIAGNOSTICS
// ---------------------------------------------------------------------------

/**
 * Schema drift detection.
 * Compares ProvisioningConfig.TABLE_SCHEMA against the live Workato workspace.
 *
 * FIXED: class was named DiagnosticRunner (missing 's') — mismatched with the
 * 'diagnostics.detectDrift' command registration in runCommand().
 */
class DiagnosticsRunner {
  /**
   * @param {AppContext} ctx
   * @returns {boolean} true if no drift found
   */
  detectDrift(ctx) {
    const sourceOfTruthTables = ProvisioningConfig.TABLE_SCHEMA;
    let driftFound = false;

    ctx.logger.log('Starting Schema Drift Detection...');

    sourceOfTruthTables.forEach(sotTable => {
      const deployedTable = ctx.inventoryService.getDeployedTableSchema(sotTable.name);

      if (!deployedTable) {
        ctx.logger.log(`[DRIFT] Entire table missing in Workato: ${sotTable.name}`);
        driftFound = true;
        return;
      }

      const deployedColsMap = {};
      deployedTable.columns.forEach(col => { deployedColsMap[col.name] = col; });

      sotTable.columns.forEach(sotCol => {
        const liveCol = deployedColsMap[sotCol.name];
        if (!liveCol) {
          ctx.logger.log(`[DRIFT] Missing column → Table: ${sotTable.name} | Column: ${sotCol.name}`);
          driftFound = true;
        } else if (liveCol.type !== sotCol.type) {
          ctx.logger.log(`[DRIFT] Type mismatch → Table: ${sotTable.name} | Column: ${sotCol.name} (Code: ${sotCol.type}, Deployed: ${liveCol.type})`);
          driftFound = true;
        }
      });
    });

    if (!driftFound) {
      ctx.logger.log('✅ No configuration drift detected. Workspace matches source of truth.');
    } else {
      ctx.logger.log('🚨 Configuration drift detected. Run the provisioning update script.');
    }

    return !driftFound;
  }
}

// ---------------------------------------------------------------------------
// PROVISIONING RUNNER
// ---------------------------------------------------------------------------

/**
 * IaC orchestrator. Idempotently provisions a Workato workspace:
 * creates/finds the project, creates/finds the target subfolder,
 * upserts environment properties, and creates or schema-updates all data tables.
 */
class ProvisioningRunner {
  /**
   * @param {AppContext} ctx
   * @param {string|null} projectName
   * @returns {{ success: boolean, targetFolderId: number, parentProjectId: number }}
   */
  run(ctx, projectName) {
    const logger     = ctx.logger;
    const invService = ctx.inventoryService;

    logger.notify('Starting Workspace provisioning...');

    try {
      logger.verbose(`Mapping workspace surface for project: "${projectName}"...`);
      const parentId = this._resolveDynamicParentId(invService, projectName);
      logger.verbose(`Resolved Parent Project (ID: ${parentId}).`);

      logger.verbose(`Checking for target subfolder: "${ProvisioningConfig.TARGET_FOLDER_NAME}"...`);
      const folderId = this._getOrCreateFolder(invService, ProvisioningConfig.TARGET_FOLDER_NAME, parentId);
      logger.verbose(`Target subfolder resolved (ID: ${folderId}).`);

      logger.notify('Provisioning Environment Properties...');
      invService.upsertProperties(ProvisioningConfig.ENV_PROPERTIES);

      logger.notify('Provisioning Data Tables...');
      const existingTables     = invService.getDataTables();
      const existingTableNames = new Set((existingTables || []).map(t => t.name));
      const tableIdMap         = {};
      (existingTables || []).forEach(t => { tableIdMap[t.name] = t.id; });

      ProvisioningConfig.TABLE_SCHEMA.forEach(tableDef => {
        if (existingTableNames.has(tableDef.name)) {
          const existingTableObj = existingTables.find(t => t.name === tableDef.name);
          this._updateTableSchemaIfChanged(invService, logger, existingTableObj, tableDef, tableIdMap);
        } else {
          logger.verbose(`[CREATE] Provisioning table "${tableDef.name}"...`);

          const columnsForApi = tableDef.columns.map(col => {
            if (col.type === 'link' && col.target_table) {
              const targetId = tableIdMap[col.target_table];
              if (!targetId) throw new Error(`Cannot map relation: parent table ${col.target_table} has no ID yet.`);
              return { name: col.name, type: col.type, target_table_id: targetId, optional: col.optional };
            }
            return col;
          });

          const newTable = invService.createDataTable(tableDef.name, folderId, columnsForApi);
          existingTableNames.add(tableDef.name);
          if (newTable && newTable.id) tableIdMap[tableDef.name] = newTable.id;
        }
      });

      logger.notify('Workspace provisioning complete.');
      return { success: true, targetFolderId: folderId, parentProjectId: parentId };

    } catch (error) {
      logger.notify(`[CRITICAL ERROR] Provisioning halted: ${error.message}`, true);
      try {
        Lib_Logging_Technical.logEvent(
          error,
          '1_backend_provisioning',
          'ProvisioningRunner.run',
          Lib_Logging_Technical.Severity.ERROR
        );
      } catch (err) {
        console.error('Failed to log to technical tracker: ' + err.message);
      }
      throw error;
    }
  }

  /** @private */
  _resolveDynamicParentId(invService, projectName) {
    if (!projectName) throw new Error('Project name is required for dynamic routing.');
    const projects       = invService.getProjects();
    const existingProject = projects.find(p => p.name === projectName);
    if (existingProject) return existingProject.id;
    const newProject = invService.createFolder(projectName);
    return newProject.id;
  }

  /** @private */
  _getOrCreateFolder(invService, folderName, parentId) {
    const endpoint       = parentId ? `folders?parent_id=${parentId}` : 'folders';
    const foldersResponse = invService.client.get(endpoint);
    const allFolders     = invService._normalizeListResponse_(foldersResponse);
    const existing       = allFolders.find(f => f.name === folderName);
    if (existing && existing.id) return existing.id;

    const newFolder = invService.createFolder(folderName, parentId);
    if (!newFolder || !newFolder.id) throw new Error('Failed to create nested target folder via API.');
    return newFolder.id;
  }

  /** @private */
  _updateTableSchemaIfChanged(invService, logger, existingTable, desiredDef, tableIdMap) {
    let needsUpdate = false;

    const existingTableDetails = invService.getDataTableDetails(existingTable.id);
    const existingColumns      = (existingTableDetails && (existingTableDetails.columns || existingTableDetails.schema)) || [];
    const existingColMap       = {};
    existingColumns.forEach(c => { existingColMap[c.name] = c; });

    if (existingColumns.length !== desiredDef.columns.length) needsUpdate = true;

    const targetColumnsForApi = desiredDef.columns.map(col => {
      const targetCol = { name: col.name, type: col.type, optional: col.optional === true };

      if (col.type === 'link' && col.target_table) {
        const targetId = tableIdMap[col.target_table];
        if (!targetId) throw new Error(`Link error: ${col.target_table} ID not found.`);
        targetCol.target_table_id = targetId;
      }

      const existingCol = existingColMap[col.name];
      if (!existingCol) {
        needsUpdate = true;
      } else {
        const typeChanged = existingCol.type !== targetCol.type;
        const linkChanged = targetCol.type === 'link' &&
          String(existingCol.target_table_id || '') !== String(targetCol.target_table_id || '');
        const optChanged  = Boolean(existingCol.optional) !== Boolean(targetCol.optional);
        if (typeChanged || linkChanged || optChanged) needsUpdate = true;
      }

      return targetCol;
    });

    if (needsUpdate) {
      logger.verbose(`[UPDATE] Schema changes detected for "${desiredDef.name}".`);
      invService.updateDataTable(existingTable.id, targetColumnsForApi);
    } else {
      logger.verbose(`[SKIP] Table "${desiredDef.name}" is up to date.`);
    }
  }
}

/**
 * @file 003_Fleet.gs
 * @description Workspace fleet management, manifest hashing, and registry services.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - Removed BindingService class. Its one public method (assertInitializeAllowed)
 *    and one private helper (_conflict) are now inlined directly into
 *    _checkIdempotency_() in 004_Webhook.gs, which was the only caller.
 *    A class with one method and one private helper is not a service.
 *  - No logic changes to FleetManager, ManifestService, or RegistryService.
 */

// ---------------------------------------------------------------------------
// FLEET MANAGER
// ---------------------------------------------------------------------------

/**
 * Checks out an available Workato workspace from a central Google Sheet registry.
 * Uses LockService to prevent race conditions when multiple callers run concurrently.
 */
class FleetManager {
  static get REGISTRY_SHEET_ID() {
    return AppConfig.get().API.FLEET_REGISTRY_ID;
  }

  /**
   * Finds the first AVAILABLE workspace row, marks it IN_USE, and returns its token.
   * @param {string} clientName
   * @param {Object} [deps]
   * @returns {{ workspaceName: string, apiToken: string }|null}
   */
  static checkoutWorkspace(clientName, deps = {}) {
    const lock = LockService.getScriptLock();
    const openSpreadsheetById = deps.openSpreadsheetById || SpreadsheetApp.openById;

    if (!lock.tryLock(30000)) {
      throw new Error('System is currently busy assigning another workspace. Please try again in a few seconds.');
    }

    try {
      const ss    = openSpreadsheetById(this.REGISTRY_SHEET_ID);
      const sheet = ss.getSheetByName('Registry');
      if (!sheet) throw new Error("Could not find 'Registry' tab in the Fleet Manager sheet.");

      const data = sheet.getDataRange().getValues();

      for (let i = 1; i < data.length; i++) {
        const status = String(data[i][2]).trim().toUpperCase();
        if (status !== 'AVAILABLE') continue;

        const workspaceName = String(data[i][0]).trim();
        const apiToken      = String(data[i][1]).trim();

        sheet.getRange(i + 1, 3).setValue('IN_USE');
        sheet.getRange(i + 1, 4).setValue(clientName);
        sheet.getRange(i + 1, 5).setValue(new Date());
        SpreadsheetApp.flush();

        return { workspaceName, apiToken };
      }

      return null;

    } finally {
      lock.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// MANIFEST SERVICE
// ---------------------------------------------------------------------------

/**
 * Builds a canonical SHA-256 manifest from an initialize-workspace payload.
 * Used for idempotency checking — identical payloads produce identical hashes.
 */
class ManifestService {
  /**
   * @param {Object} payload
   * @returns {{ canonical_json: string, manifest_hash: string }}
   */
  static buildCanonicalInitializeManifest(payload) {
    if (!payload) throw new Error('Missing payload for manifest');

    const canonical = {
      project_metadata: this._normalizeObject(payload.project_metadata),
      supplier_roster:  this._normalizeSupplierRoster(payload.supplier_roster),
      matrix_schema:    this._normalizeObject(payload.matrix_schema)
    };

    const canonicalJson  = JSON.stringify(canonical);
    const manifestHash   = this._sha256(canonicalJson);

    return { canonical_json: canonicalJson, manifest_hash: manifestHash };
  }

  /** @private */
  static _normalizeSupplierRoster(roster = []) {
    return (roster || [])
      .map(s => ({
        supplier_name: String(s.supplier_name || '').trim(),
        contact_email: String(s.contact_email || '').trim().toLowerCase(),
        has_seeded_data: !!s.has_seeded_data
      }))
      .sort((a, b) => a.contact_email.localeCompare(b.contact_email));
  }

  /** @private */
  static _normalizeObject(obj) {
    if (!obj) return {};
    return JSON.parse(JSON.stringify(obj));
  }

  /** @private */
  static _sha256(str) {
    const raw = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      str,
      Utilities.Charset.UTF_8
    );
    return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  }
}

// ---------------------------------------------------------------------------
// REGISTRY SERVICE
// ---------------------------------------------------------------------------

/**
 * Google Sheets-backed registry for workspace lifecycle tracking.
 * Manages three tabs:
 *  - Workspace_Registry: one row per provisioned workspace
 *  - Bootstrap_Ledger:   one row per initialization attempt
 *  - Manifest_Registry:  content-addressed manifest store
 */
class RegistryService {
  static adminId() {
    const id = PropertiesService.getScriptProperties().getProperty('ADMIN_REGISTRY_ID');
    if (!id) throw new Error('Missing ADMIN_REGISTRY_ID');
    return id;
  }

  static ss() {
    return SpreadsheetApp.openById(this.adminId());
  }

  static ensureTabs() {
    this._ensureSheet('Workspace_Registry', [
      'workspace_binding_id', 'control_center_id', 'client_name', 'workspace_name',
      'workspace_status', 'recipe_bundle_version', 'schema_contract_version',
      'active_bootstrap_id', 'current_template_project_id', 'current_template_version_id',
      'initialized_at', 'last_error', 'created_at', 'updated_at'
    ]);
    this._ensureSheet('Bootstrap_Ledger', [
      'bootstrap_id', 'workspace_binding_id', 'control_center_id', 'init_manifest_hash',
      'bootstrap_status', 'idempotency_decision', 'recipe_bundle_version', 'schema_contract_version',
      'template_project_id', 'template_version_id', 'supplier_count',
      'started_at', 'completed_at', 'error_message'
    ]);
    this._ensureSheet('Manifest_Registry', [
      'manifest_hash', 'canonical_json', 'created_at'
    ]);
  }

  static findWorkspaceByControlCenter(controlCenterId) {
    const sheet   = this.ss().getSheetByName('Workspace_Registry');
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx     = headers.indexOf('control_center_id');
    for (let i = 1; i < data.length; i++) {
      if (data[i][idx] === controlCenterId) return this._rowToObj(headers, data[i]);
    }
    return null;
  }

  static findSuccessfulBootstrap(bindingId) {
    const sheet    = this.ss().getSheetByName('Bootstrap_Ledger');
    const data     = sheet.getDataRange().getValues();
    const headers  = data[0];
    const bIdx     = headers.indexOf('workspace_binding_id');
    const statusIdx = headers.indexOf('bootstrap_status');
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][bIdx] === bindingId && data[i][statusIdx] === 'SUCCESS') {
        return this._rowToObj(headers, data[i]);
      }
    }
    return null;
  }

  static insertWorkspace(row)               { this._append('Workspace_Registry', row); }
  static updateWorkspace(bindingId, patch)  { this._update('Workspace_Registry', 'workspace_binding_id', bindingId, patch); }
  static insertBootstrap(row)               { this._append('Bootstrap_Ledger', row); }
  static updateBootstrap(bootstrapId, patch){ this._update('Bootstrap_Ledger', 'bootstrap_id', bootstrapId, patch); }
  static insertManifest(row)                { this._append('Manifest_Registry', row); }

  // --- INTERNALS --------------------------------------------------------------

  /** @private */
  static _ensureSheet(name, headers) {
    const ss = this.ss();
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
    }
  }

  /** @private */
  static _append(sheetName, obj) {
    const sheet   = this.ss().getSheetByName(sheetName);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const row     = headers.map(h => obj[h] || '');
    sheet.appendRow(row);
  }

  /** @private */
  static _update(sheetName, keyCol, keyVal, patch) {
    const sheet   = this.ss().getSheetByName(sheetName);
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const keyIdx  = headers.indexOf(keyCol);
    for (let i = 1; i < data.length; i++) {
      if (data[i][keyIdx] === keyVal) {
        headers.forEach((h, j) => {
          if (patch[h] !== undefined) sheet.getRange(i + 1, j + 1).setValue(patch[h]);
        });
        return;
      }
    }
  }

  /** @private */
  static _rowToObj(headers, row) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  }
}

/**
 * @file 004_Webhook.gs
 * @description HTTP entry point, route handlers, and environment validation.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * ROUTES:
 *  POST ?path=/initialize-workspace  → handleInitializeWorkspace
 *  POST ?path=/inject-seed-data      → handleInjectSeedData
 *
 * CHANGES FROM ORIGINAL:
 *  - Fixed variable scope bug: workspaceBindingId and bootstrapId were declared
 *    with const inside the try block — the catch block couldn't reach them,
 *    throwing a ReferenceError on any provisioning failure and silently leaving
 *    the registry in a dirty PROVISIONING state.
 *  - Decomposed handleInitializeWorkspace into 6 named step helpers. The
 *    8 inline step comments were already the design — they're now functions.
 *  - Inlined BindingService (was a class with one public method and one
 *    private helper — its logic now lives in _checkIdempotency_).
 *  - Replaced AppFactory.createContext() with new AppContext() directly.
 *  - validateBackendEnvironment moved here from 011_Core_EnvValidator.gs
 *    (its only consumer is doPost).
 */

// ---------------------------------------------------------------------------
// ENVIRONMENT VALIDATION
// ---------------------------------------------------------------------------

/**
 * Validates that required Script Properties are present and well-formed.
 * @param {string[]|null} [requiredKeys] - Defaults to the standard set if omitted.
 * @returns {{ ok: boolean, env: string, requiredKeys: string[], errors: string[] }}
 */
function validateBackendEnvironment(requiredKeys = null) {
  const defaultKeys = [
    'WORKATO_API_TOKEN',
    'WORKATO_BASE_URL',
    'FLEET_REGISTRY_ID',
    'WEBHOOK_SECRET',
    'WORKATO_BOOTSTRAP_URL',
    'WORKATO_INJECT_SEED_URL'
  ];

  const keysToCheck = Array.isArray(requiredKeys) && requiredKeys.length > 0
    ? requiredKeys
    : defaultKeys;

  const errors = [];

  keysToCheck.forEach(key => {
    if (!SecretStore.has(key)) errors.push(`Missing script property: ${key}`);
  });

  if (keysToCheck.includes('WORKATO_BASE_URL')) {
    const baseUrl = SecretStore.getOptional('WORKATO_BASE_URL', '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      errors.push('WORKATO_BASE_URL must begin with http:// or https://');
    }
  }

  return {
    ok:           errors.length === 0,
    env:          SecretStore.getEnv(),
    requiredKeys: keysToCheck,
    errors
  };
}

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Main HTTP POST entry point for the GAS Web App.
 * External callers should include a query parameter for routing:
 *   https://script.google.com/macros/s/{script_id}/exec?path=/initialize-workspace
 *
 * @param {Object} e - GAS event object
 */
function doPost(e) {
  try {
    const incomingToken = e?.parameter?.token;
    const expectedToken = SecretStore.getOptional('WEBHOOK_SECRET', '');

    if (!expectedToken) {
      AppLogger.log('[FATAL] Missing WEBHOOK_SECRET.');
      return buildJsonResponse({ error: 'Backend misconfigured', details: ['Missing script property: WEBHOOK_SECRET'] }, 500);
    }

    if (incomingToken !== expectedToken) {
      AppLogger.log('[WARNING] Unauthorized webhook attempt.');
      return buildJsonResponse({ error: 'Unauthorized' }, 401);
    }

    const path = e?.parameter?.path || '/';

    const requiredKeys = (() => {
      switch (path) {
        case '/initialize-workspace': return ['WORKATO_API_TOKEN', 'WORKATO_BASE_URL', 'FLEET_REGISTRY_ID', 'WORKATO_BOOTSTRAP_URL'];
        case '/inject-seed-data':     return ['WORKATO_INJECT_SEED_URL'];
        default:                      return [];
      }
    })();

    const envCheck = validateBackendEnvironment(requiredKeys);
    if (!envCheck.ok) {
      AppLogger.log(`[FATAL] Invalid backend environment: ${envCheck.errors.join(' | ')}`);
      return buildJsonResponse({ error: 'Backend misconfigured', details: envCheck.errors }, 500);
    }

    let payload = {};
    if (e?.postData?.contents) {
      payload = JSON.parse(e.postData.contents);
    }

    switch (path) {
      case '/initialize-workspace': return handleInitializeWorkspace(payload);
      case '/inject-seed-data':     return handleInjectSeedData(payload);
      default:                      return buildJsonResponse({ error: `Route not found: '${path}'` }, 404);
    }

  } catch (error) {
    AppLogger.log(`[FATAL] Webhook error: ${error.message}`);
    try {
      Lib_Logging_Technical.logEvent(
        error,
        '1_backend_provisioning',
        'doPost',
        Lib_Logging_Technical.Severity.CRITICAL
      );
    } catch (_) {}
    return buildJsonResponse({ error: 'Internal Server Error', details: error.message }, 500);
  }
}

// ---------------------------------------------------------------------------
// ROUTE: /initialize-workspace
// ---------------------------------------------------------------------------

/**
 * Full workspace initialization lifecycle.
 * @param {Object} payload - InitializeWorkspaceRequest JSON
 */
function handleInitializeWorkspace(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('System busy, retry');

  // FIXED: declared with let before try so the catch block can reach them.
  // Original used const inside try — threw ReferenceError on any failure,
  // silently leaving registry rows in PROVISIONING state indefinitely.
  let workspaceBindingId = null;
  let bootstrapId        = null;

  try {
    RegistryService.ensureTabs();

    if (!payload.control_center_id) throw new Error('Missing control_center_id');

    const config = { RECIPE_BUNDLE_VERSION: 'v1', SCHEMA_CONTRACT_VERSION: 'v1' };

    const manifest = _buildAndStoreManifest_(payload);
    const existing = RegistryService.findWorkspaceByControlCenter(payload.control_center_id);

    if (existing) {
      const idempotentResponse = _checkIdempotency_(existing, manifest, config);
      if (idempotentResponse) return idempotentResponse;
    }

    const checkout         = FleetManager.checkoutWorkspace(payload.project_metadata.project_name);
    workspaceBindingId     = Utilities.getUuid();
    bootstrapId            = Utilities.getUuid();

    _createRegistryRecords_(workspaceBindingId, bootstrapId, checkout, payload, config, manifest);

    const ctx = new AppContext(checkout.apiToken);
    new ProvisioningRunner().run(ctx, payload.project_metadata.project_name);

    const templateProjectId  = Utilities.getUuid();
    const templateVersionId  = Utilities.getUuid();
    const supplierRequests   = _buildSupplierRequests_(payload.supplier_roster);

    _fireBootstrapWebhook_({
      ...payload,
      workspace_binding_id: workspaceBindingId,
      template_project_id:  templateProjectId,
      template_version_id:  templateVersionId,
      supplier_roster:      supplierRequests
    });

    _recordSuccess_(workspaceBindingId, bootstrapId, templateProjectId, templateVersionId);

    return buildJsonResponse({
      workspace_binding_id: workspaceBindingId,
      template_project_id:  templateProjectId,
      template_version_id:  templateVersionId,
      assigned_workspace:   checkout.workspaceName,
      manifest_hash:        manifest.manifest_hash,
      supplier_requests:    supplierRequests
    }, 200);

  } catch (err) {
    _recordFailure_(workspaceBindingId, bootstrapId, err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// --- Step helpers -----------------------------------------------------------

/**
 * Builds a canonical manifest from the payload and stores it in the registry.
 * @private
 */
function _buildAndStoreManifest_(payload) {
  const manifest = ManifestService.buildCanonicalInitializeManifest(payload);
  RegistryService.insertManifest({
    manifest_hash:  manifest.manifest_hash,
    canonical_json: manifest.canonical_json,
    created_at:     new Date()
  });
  return manifest;
}

/**
 * Checks whether re-initialization is allowed for an existing binding.
 * Returns a pre-built response if the request is an exact replay (IDEMPOTENT).
 * Throws a 409 for any other conflict.
 * @private
 * @returns {GoogleAppsScript.Content.TextOutput|null} Response if idempotent, null if this is a new binding.
 */
function _checkIdempotency_(existing, manifest, config) {
  const bootstrap = RegistryService.findSuccessfulBootstrap(existing.workspace_binding_id);

  if (!bootstrap) {
    const err = new Error('Initialize refused: binding exists but no successful bootstrap found');
    err.statusCode = 409;
    throw err;
  }

  const same =
    bootstrap.init_manifest_hash       === manifest.manifest_hash &&
    bootstrap.recipe_bundle_version    === config.RECIPE_BUNDLE_VERSION &&
    bootstrap.schema_contract_version  === config.SCHEMA_CONTRACT_VERSION;

  if (!same) {
    const err = new Error('Initialize refused: manifest or version mismatch on existing binding');
    err.statusCode = 409;
    throw err;
  }

  // Exact replay — return the previously committed IDs
  return buildJsonResponse({
    workspace_binding_id: existing.workspace_binding_id,
    template_project_id:  bootstrap.template_project_id,
    template_version_id:  bootstrap.template_version_id,
    assigned_workspace:   existing.workspace_name,
    manifest_hash:        manifest.manifest_hash
  }, 200);
}

/**
 * Inserts the initial Workspace_Registry and Bootstrap_Ledger rows.
 * @private
 */
function _createRegistryRecords_(workspaceBindingId, bootstrapId, checkout, payload, config, manifest) {
  const now = new Date();

  RegistryService.insertWorkspace({
    workspace_binding_id:   workspaceBindingId,
    control_center_id:      payload.control_center_id,
    client_name:            payload.project_metadata.project_name,
    workspace_name:         checkout.workspaceName,
    workspace_status:       'PROVISIONING',
    recipe_bundle_version:  config.RECIPE_BUNDLE_VERSION,
    schema_contract_version: config.SCHEMA_CONTRACT_VERSION,
    active_bootstrap_id:    bootstrapId,
    created_at:             now,
    updated_at:             now
  });

  RegistryService.insertBootstrap({
    bootstrap_id:            bootstrapId,
    workspace_binding_id:    workspaceBindingId,
    control_center_id:       payload.control_center_id,
    init_manifest_hash:      manifest.manifest_hash,
    bootstrap_status:        'STARTED',
    idempotency_decision:    'NEW',
    recipe_bundle_version:   config.RECIPE_BUNDLE_VERSION,
    schema_contract_version: config.SCHEMA_CONTRACT_VERSION,
    supplier_count:          (payload.supplier_roster || []).length,
    started_at:              now
  });
}

/**
 * Maps the supplier roster to request objects with fresh UUIDs.
 * @private
 */
function _buildSupplierRequests_(supplierRoster) {
  return (supplierRoster || []).map(s => ({
    supplier_request_id: Utilities.getUuid(),
    supplier_name:       s.supplier_name,
    contact_email:       s.contact_email
  }));
}

/**
 * POSTs the bootstrap payload to Workato.
 * @private
 */
function _fireBootstrapWebhook_(bootstrapPayload) {
  const url = PropertiesService.getScriptProperties().getProperty('WORKATO_BOOTSTRAP_URL');
  const response = UrlFetchApp.fetch(url, {
    method:      'post',
    contentType: 'application/json',
    payload:     JSON.stringify(bootstrapPayload),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 300) {
    throw new Error('Bootstrap failed: ' + response.getContentText());
  }
}

/**
 * Updates both registry rows to reflect a successful initialization.
 * @private
 */
function _recordSuccess_(workspaceBindingId, bootstrapId, templateProjectId, templateVersionId) {
  const now = new Date();
  RegistryService.updateWorkspace(workspaceBindingId, {
    workspace_status:              'ACTIVE',
    current_template_project_id:   templateProjectId,
    current_template_version_id:   templateVersionId,
    initialized_at:                now,
    updated_at:                    now
  });
  RegistryService.updateBootstrap(bootstrapId, {
    bootstrap_status:  'SUCCESS',
    template_project_id: templateProjectId,
    template_version_id: templateVersionId,
    completed_at:       now
  });
}

/**
 * Logs the failure and marks both registry rows FAILED (if they were created).
 * Guards against null IDs — they may never have been assigned if failure was early.
 * @private
 */
function _recordFailure_(workspaceBindingId, bootstrapId, err) {
  try {
    Lib_Logging_Technical.logEvent(
      err,
      '1_backend_provisioning',
      'handleInitializeWorkspace',
      Lib_Logging_Technical.Severity.ERROR
    );
  } catch (_) {}

  const now = new Date();
  try {
    if (workspaceBindingId) {
      RegistryService.updateWorkspace(workspaceBindingId, {
        workspace_status: 'FAILED',
        last_error:       err.message,
        updated_at:       now
      });
    }
    if (bootstrapId) {
      RegistryService.updateBootstrap(bootstrapId, {
        bootstrap_status: 'FAILED',
        error_message:    err.message,
        completed_at:     now
      });
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// ROUTE: /inject-seed-data
// ---------------------------------------------------------------------------

/**
 * Forwards a seed data payload to the Workato inject-seed-data webhook.
 * @param {Object} payload - InjectSeedDataRequest JSON
 */
function handleInjectSeedData(payload) {
  AppLogger.log('Received /inject-seed-data request.');

  if (!payload.supplier_request_id || !payload.seed_data_payload) {
    return buildJsonResponse({ error: 'Bad Request: Missing required parameters.' }, 400);
  }

  const webhookUrl = SecretStore.getOptional('WORKATO_INJECT_SEED_URL', '');
  if (!webhookUrl) {
    return buildJsonResponse({ error: 'Configuration error: WORKATO_INJECT_SEED_URL not set.' }, 500);
  }

  const response = UrlFetchApp.fetch(webhookUrl, {
    method:      'post',
    contentType: 'application/json',
    payload:     JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const responseCode = response.getResponseCode();
  if (responseCode >= 200 && responseCode < 300) {
    return buildJsonResponse({
      status:              'accepted',
      supplier_request_id: payload.supplier_request_id,
      row_count:           payload.seed_data_payload.length
    }, 200);
  }

  return buildJsonResponse({ error: 'Workato webhook failed', details: response.getContentText() }, 500);
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

/**
 * Wraps a response payload in the GAS envelope format.
 * GAS always returns HTTP 200; callers must read the embedded statusCode.
 * @param {Object} data
 * @param {number} [statusCode]
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function buildJsonResponse(data, statusCode = 200) {
  return ContentService
    .createTextOutput(JSON.stringify({ statusCode, body: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * @file 005_Repair.gs
 * @description Workspace version repair and verification tooling.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * Operational tool — not part of the provisioning webhook path.
 * Use to fix referential integrity violations in an already-provisioned workspace,
 * specifically current_version_id mismatches caused by Record IDs being stored
 * instead of business UUIDs.
 *
 * Tables covered: VER_TemplateVersion, WFA_SupplierRequest, RUN_Upload,
 *                 RUN_ValidationResult, CFG_Rule
 *
 * Core invariants:
 *  - WFA_SupplierRequest.current_version_id must hold VER_TemplateVersion.id
 *    (business UUID), not the Workato Record ID
 *  - RUN_Upload.template_version_id = WFA_SupplierRequest.current_version_id
 *  - RUN_ValidationResult.template_version_id = RUN_Upload.template_version_id
 *
 * CHANGES FROM ORIGINAL:
 *  - Extracted from the provisioning engine into its own file. Zero logic changes.
 *  - FIXED: TEMP_CONFIG.workspaceId cleared — was hardcoded with a production
 *    workspace ID. Use setDefaultWorkspaceRepairId() before running any repair.
 *    See resolveWorkspaceId_ for the full fallback chain.
 */

// ---------------------------------------------------------------------------
// LOCAL CONFIG
// ---------------------------------------------------------------------------

const TEMP_CONFIG = Object.freeze({
  workspaceId:    '',     // FIXED: set via setDefaultWorkspaceRepairId() or Script Properties
  debugEndpoints: false
});

const WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_ = 'WORKSPACE_REPAIR_DEFAULT_WORKSPACE_ID';

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINTS
// ---------------------------------------------------------------------------

function previewWorkspaceVersionRepair(workspaceId, options) {
  const opts = normalizeRepairOptions_(options || {});
  return WorkspaceVersionRepairRunner.preview(resolveWorkspaceId_(workspaceId, opts), opts);
}

function repairSupplierRequestVersions(workspaceId, options) {
  const opts = normalizeRepairOptions_(options || {});
  return WorkspaceVersionRepairRunner.repairSupplierRequestVersions(resolveWorkspaceId_(workspaceId, opts), opts);
}

function backfillUploadTemplateVersions(workspaceId, options) {
  const opts = normalizeRepairOptions_(options || {});
  return WorkspaceVersionRepairRunner.backfillUploadTemplateVersions(resolveWorkspaceId_(workspaceId, opts), opts);
}

function backfillValidationTemplateVersions(workspaceId, options) {
  const opts = normalizeRepairOptions_(options || {});
  return WorkspaceVersionRepairRunner.backfillValidationTemplateVersions(resolveWorkspaceId_(workspaceId, opts), opts);
}

function verifyWorkspaceVersionInvariants(workspaceId, options) {
  const opts = normalizeRepairOptions_(options || {});
  return WorkspaceVersionRepairRunner.verify(resolveWorkspaceId_(workspaceId, opts), opts);
}

/**
 * Convenience orchestrator: preview → repair requests → backfill uploads
 * → backfill validations → verify.
 */
function runWorkspaceVersionRepair(workspaceId, options) {
  const opts               = normalizeRepairOptions_(options || {});
  const resolvedWorkspaceId = resolveWorkspaceId_(workspaceId, opts);

  const results = {
    workspaceId:         resolvedWorkspaceId,
    preview:             null,
    requestRepair:       null,
    uploadBackfill:      null,
    validationBackfill:  null,
    verify:              null
  };

  results.preview = WorkspaceVersionRepairRunner.preview(resolvedWorkspaceId, opts);

  if (opts.previewOnly) {
    logRepairResult_('runWorkspaceVersionRepair.previewOnly', results);
    return results;
  }

  results.requestRepair      = WorkspaceVersionRepairRunner.repairSupplierRequestVersions(resolvedWorkspaceId, opts);
  results.uploadBackfill     = WorkspaceVersionRepairRunner.backfillUploadTemplateVersions(resolvedWorkspaceId, opts);
  results.validationBackfill = WorkspaceVersionRepairRunner.backfillValidationTemplateVersions(resolvedWorkspaceId, opts);
  results.verify             = WorkspaceVersionRepairRunner.verify(resolvedWorkspaceId, opts);

  logRepairResult_('runWorkspaceVersionRepair.complete', results);
  return results;
}

// ---------------------------------------------------------------------------
// RUNNER (IIFE MODULE)
// ---------------------------------------------------------------------------

const WorkspaceVersionRepairRunner = (() => {

  function preview(workspaceId, options) {
    const opts   = normalizeRepairOptions_(options || {});
    const client = createRepairClient_(workspaceId, opts);
    const scan   = scanWorkspaceState_(client, opts);

    const result = {
      mode:        'preview',
      workspaceId: workspaceId,
      scannedAt:   new Date().toISOString(),
      dryRun:      true,
      counts:      scan.counts,
      issues:      scan.issues,
      samples:     scan.samples
    };

    logRepairResult_('previewWorkspaceVersionRepair', result);
    return result;
  }

  function repairSupplierRequestVersions(workspaceId, options) {
    const opts   = normalizeRepairOptions_(options || {});
    const client = createRepairClient_(workspaceId, opts);

    const templateVersions  = client.listAll('VER_TemplateVersion');
    const requests          = client.listAll('WFA_SupplierRequest');
    const versionById       = indexBy_(templateVersions, 'id');
    const versionByRecordId = indexBy_(templateVersions, 'Record ID');

    let examined = 0, repaired = 0, skipped = 0, ambiguous = 0;
    const changes = [];

    requests.forEach(req => {
      examined += 1;
      const current  = safeString_(req.current_version_id);
      const decision = resolveCorrectRequestVersion_(req, { versionById, versionByRecordId, options: opts });

      if (decision.status === 'ok_no_change') { skipped += 1; return; }

      if (decision.status === 'ambiguous') {
        ambiguous += 1;
        changes.push({ supplier_request_id: req.id || '', supplier_name: req.supplier_name || '', current_version_id: current, action: 'manual_review', reason: decision.reason });
        return;
      }

      if (decision.status === 'repair') {
        changes.push({ supplier_request_id: req.id || '', supplier_name: req.supplier_name || '', current_version_id_old: current, current_version_id_new: decision.correctTemplateVersionId, action: opts.dryRun ? 'would_update' : 'updated', reason: decision.reason });
        if (!opts.dryRun) {
          client.updateByBusinessId('WFA_SupplierRequest', req.id, {
            current_version_id: decision.correctTemplateVersionId,
            last_updated_at:    new Date().toISOString()
          });
        }
        repaired += 1;
        return;
      }

      skipped += 1;
    });

    const result = { mode: 'repairSupplierRequestVersions', workspaceId, executedAt: new Date().toISOString(), dryRun: !!opts.dryRun, summary: { examined, repaired, skipped, ambiguous }, changes };
    logRepairResult_('repairSupplierRequestVersions', result);
    return result;
  }

  function backfillUploadTemplateVersions(workspaceId, options) {
    const opts      = normalizeRepairOptions_(options || {});
    const client    = createRepairClient_(workspaceId, opts);
    const requests  = client.listAll('WFA_SupplierRequest');
    const uploads   = client.listAll('RUN_Upload');
    const requestById = indexBy_(requests, 'id');

    let examined = 0, updated = 0, missingRequest = 0, missingRequestVersion = 0, alreadyCorrect = 0;
    const changes = [];

    uploads.forEach(upload => {
      examined += 1;
      const request = requestById[safeString_(upload.supplier_request_id)];

      if (!request) {
        missingRequest += 1;
        changes.push({ upload_id: upload.id || '', supplier_request_id: upload.supplier_request_id || '', action: 'manual_review', reason: 'supplier_request_not_found' });
        return;
      }

      const desired = safeString_(request.current_version_id);
      if (!desired) {
        missingRequestVersion += 1;
        changes.push({ upload_id: upload.id || '', supplier_request_id: upload.supplier_request_id || '', action: 'manual_review', reason: 'request_missing_current_version_id' });
        return;
      }

      const current = safeString_(upload.template_version_id);
      if (current === desired) { alreadyCorrect += 1; return; }

      changes.push({ upload_id: upload.id || '', supplier_request_id: upload.supplier_request_id || '', template_version_id_old: current, template_version_id_new: desired, action: opts.dryRun ? 'would_update' : 'updated' });
      if (!opts.dryRun) client.updateByBusinessId('RUN_Upload', upload.id, { template_version_id: desired });
      updated += 1;
    });

    const result = { mode: 'backfillUploadTemplateVersions', workspaceId, executedAt: new Date().toISOString(), dryRun: !!opts.dryRun, summary: { examined, updated, alreadyCorrect, missingRequest, missingRequestVersion }, changes };
    logRepairResult_('backfillUploadTemplateVersions', result);
    return result;
  }

  function backfillValidationTemplateVersions(workspaceId, options) {
    const opts       = normalizeRepairOptions_(options || {});
    const client     = createRepairClient_(workspaceId, opts);
    const uploads    = client.listAll('RUN_Upload');
    const validations = client.listAll('RUN_ValidationResult');
    const uploadById = indexBy_(uploads, 'id');

    let examined = 0, updated = 0, missingUpload = 0, missingUploadVersion = 0, alreadyCorrect = 0;
    const changes = [];

    validations.forEach(validation => {
      examined += 1;
      const upload = uploadById[safeString_(validation.upload_id)];

      if (!upload) {
        missingUpload += 1;
        changes.push({ validation_result_id: validation.id || '', upload_id: validation.upload_id || '', action: 'manual_review', reason: 'upload_not_found' });
        return;
      }

      const desired = safeString_(upload.template_version_id);
      if (!desired) {
        missingUploadVersion += 1;
        changes.push({ validation_result_id: validation.id || '', upload_id: validation.upload_id || '', action: 'manual_review', reason: 'upload_missing_template_version_id' });
        return;
      }

      const current = safeString_(validation.template_version_id);
      if (current === desired) { alreadyCorrect += 1; return; }

      changes.push({ validation_result_id: validation.id || '', upload_id: validation.upload_id || '', template_version_id_old: current, template_version_id_new: desired, action: opts.dryRun ? 'would_update' : 'updated' });
      if (!opts.dryRun) client.updateByBusinessId('RUN_ValidationResult', validation.id, { template_version_id: desired });
      updated += 1;
    });

    const result = { mode: 'backfillValidationTemplateVersions', workspaceId, executedAt: new Date().toISOString(), dryRun: !!opts.dryRun, summary: { examined, updated, alreadyCorrect, missingUpload, missingUploadVersion }, changes };
    logRepairResult_('backfillValidationTemplateVersions', result);
    return result;
  }

  function verify(workspaceId, options) {
    const opts   = normalizeRepairOptions_(options || {});
    const client = createRepairClient_(workspaceId, opts);
    const scan   = scanWorkspaceState_(client, opts);
    const failures = [];

    const checks = [
      ['requestVersionRecordIdMatches',       'request_current_version_id_must_not_be_record_id'],
      ['requestVersionUnknown',               'request_current_version_id_must_resolve_to_known_template_version'],
      ['uploadsMissingTemplateVersionId',     'uploads_must_have_template_version_id'],
      ['validationsMissingTemplateVersionId', 'validations_must_have_template_version_id'],
      ['uploadVersionMismatch',               'upload_template_version_id_must_match_request_current_version_id'],
      ['validationVersionMismatch',           'validation_template_version_id_must_match_upload_template_version_id'],
      ['cfgRulesMissingTemplateVersionId',    'cfg_rule_template_version_id_must_be_non_null'],
      ['badRequestStatuses',                  'request_status_must_not_contain_known_bad_literals']
    ];

    checks.forEach(([countKey, invariant]) => {
      if (scan.counts[countKey] > 0) failures.push({ invariant, count: scan.counts[countKey] });
    });

    const result = { mode: 'verifyWorkspaceVersionInvariants', workspaceId, executedAt: new Date().toISOString(), ok: failures.length === 0, failureCount: failures.length, failures, counts: scan.counts, samples: scan.samples };
    logRepairResult_('verifyWorkspaceVersionInvariants', result);

    if (!result.ok && opts.throwOnVerifyFailure) {
      throw new Error('Workspace version invariant verification failed: ' + JSON.stringify(failures));
    }

    return result;
  }

  return { preview, repairSupplierRequestVersions, backfillUploadTemplateVersions, backfillValidationTemplateVersions, verify };
})();

// ---------------------------------------------------------------------------
// SCANNER
// ---------------------------------------------------------------------------

function scanWorkspaceState_(client, options) {
  const templateVersions  = client.listAll('VER_TemplateVersion');
  const requests          = client.listAll('WFA_SupplierRequest');
  const uploads           = client.listAll('RUN_Upload');
  const validations       = client.listAll('RUN_ValidationResult');
  const cfgRules          = client.listAll('CFG_Rule');

  const versionById       = indexBy_(templateVersions, 'id');
  const versionByRecordId = indexBy_(templateVersions, 'Record ID');
  const requestById       = indexBy_(requests, 'id');
  const uploadById        = indexBy_(uploads, 'id');

  const counts = {
    templateVersions: templateVersions.length,
    requests: requests.length,
    uploads:  uploads.length,
    validations: validations.length,
    cfgRules: cfgRules.length,
    requestVersionMissing:             0,
    requestVersionRecordIdMatches:     0,
    requestVersionUnknown:             0,
    uploadsMissingTemplateVersionId:   0,
    uploadVersionMismatch:             0,
    validationsMissingTemplateVersionId: 0,
    validationVersionMismatch:         0,
    cfgRulesMissingTemplateVersionId:  0,
    badRequestStatuses:                0
  };

  const issues = {
    suspiciousRequests:      [],
    uploadsMissingVersion:   [],
    uploadVersionMismatch:   [],
    validationsMissingVersion: [],
    validationVersionMismatch: [],
    cfgRulesMissingVersion:  [],
    badRequestStatuses:      []
  };

  requests.forEach(req => {
    const v = safeString_(req.current_version_id);
    if (!v) {
      counts.requestVersionMissing += 1;
      issues.suspiciousRequests.push(minimalRequestIssue_(req, 'missing_current_version_id'));
      return;
    }
    if (versionByRecordId[v]) {
      counts.requestVersionRecordIdMatches += 1;
      issues.suspiciousRequests.push(minimalRequestIssue_(req, 'current_version_id_matches_record_id_not_business_id'));
      return;
    }
    if (!versionById[v]) {
      counts.requestVersionUnknown += 1;
      issues.suspiciousRequests.push(minimalRequestIssue_(req, 'current_version_id_not_found_in_template_versions'));
      return;
    }
    if (isBadSupplierStatus_(req.status)) {
      counts.badRequestStatuses += 1;
      issues.badRequestStatuses.push({ supplier_request_id: req.id || '', supplier_name: req.supplier_name || '', status: req.status || '' });
    }
  });

  uploads.forEach(upload => {
    const current = safeString_(upload.template_version_id);
    const req     = requestById[safeString_(upload.supplier_request_id)];
    if (!current) {
      counts.uploadsMissingTemplateVersionId += 1;
      issues.uploadsMissingVersion.push({ upload_id: upload.id || '', supplier_request_id: upload.supplier_request_id || '', current_template_version_id: current });
    }
    if (req) {
      const desired = safeString_(req.current_version_id);
      if (desired && current && desired !== current) {
        counts.uploadVersionMismatch += 1;
        issues.uploadVersionMismatch.push({ upload_id: upload.id || '', supplier_request_id: upload.supplier_request_id || '', request_current_version_id: desired, upload_template_version_id: current });
      }
    }
  });

  validations.forEach(validation => {
    const current = safeString_(validation.template_version_id);
    const upload  = uploadById[safeString_(validation.upload_id)];
    if (!current) {
      counts.validationsMissingTemplateVersionId += 1;
      issues.validationsMissingVersion.push({ validation_result_id: validation.id || '', upload_id: validation.upload_id || '', current_template_version_id: current });
    }
    if (upload) {
      const desired = safeString_(upload.template_version_id);
      if (desired && current && desired !== current) {
        counts.validationVersionMismatch += 1;
        issues.validationVersionMismatch.push({ validation_result_id: validation.id || '', upload_id: validation.upload_id || '', upload_template_version_id: desired, validation_template_version_id: current });
      }
    }
  });

  cfgRules.forEach(rule => {
    if (!safeString_(rule.template_version_id)) {
      counts.cfgRulesMissingTemplateVersionId += 1;
      issues.cfgRulesMissingVersion.push({ rule_id: rule.id || '', field_id: rule.field_id || '', rule_type: rule.rule_type || '' });
    }
  });

  return {
    counts,
    issues,
    samples: {
      suspiciousRequests:      issues.suspiciousRequests.slice(0, 25),
      uploadsMissingVersion:   issues.uploadsMissingVersion.slice(0, 25),
      uploadVersionMismatch:   issues.uploadVersionMismatch.slice(0, 25),
      validationsMissingVersion: issues.validationsMissingVersion.slice(0, 25),
      validationVersionMismatch: issues.validationVersionMismatch.slice(0, 25),
      cfgRulesMissingVersion:  issues.cfgRulesMissingVersion.slice(0, 25),
      badRequestStatuses:      issues.badRequestStatuses.slice(0, 25)
    }
  };
}

// ---------------------------------------------------------------------------
// DECISION LOGIC
// ---------------------------------------------------------------------------

function resolveCorrectRequestVersion_(requestRow, ctx) {
  const versionById       = ctx.versionById || {};
  const versionByRecordId = ctx.versionByRecordId || {};
  const opts              = ctx.options || {};
  const current           = safeString_(requestRow.current_version_id);

  if (!current) {
    if (opts.defaultTemplateVersionId) {
      return { status: 'repair', correctTemplateVersionId: opts.defaultTemplateVersionId, reason: 'missing_current_version_id_using_default' };
    }
    return { status: 'ambiguous', reason: 'missing_current_version_id_and_no_default' };
  }

  if (versionById[current])       return { status: 'ok_no_change', correctTemplateVersionId: current, reason: 'already_business_id' };
  if (versionByRecordId[current]) return { status: 'repair', correctTemplateVersionId: safeString_(versionByRecordId[current].id), reason: 'record_id_detected_mapped_to_business_id' };

  if (opts.defaultTemplateVersionId) {
    return { status: 'repair', correctTemplateVersionId: opts.defaultTemplateVersionId, reason: 'unknown_current_version_id_using_default' };
  }

  return { status: 'ambiguous', reason: 'unknown_current_version_id_no_safe_mapping' };
}

// ---------------------------------------------------------------------------
// CLIENT FACTORY
// ---------------------------------------------------------------------------

function createRepairClient_(workspaceId, options) {
  return new WorkatoRepairClient(getWorkspaceRepairConfig_(workspaceId, options));
}

function getWorkspaceRepairConfig_(workspaceId, options) {
  const opts                = options || {};
  const scriptProps         = PropertiesService.getScriptProperties();
  const resolvedWorkspaceId = resolveWorkspaceId_(workspaceId, opts);

  const managementBaseUrl = safeString_(
    opts.managementBaseUrl || 'https://app.eu.workato.com'
  ).replace(/\/$/, '');

  const recordsBaseUrl = safeString_(
    opts.recordsBaseUrl ||
    scriptProps.getProperty('WORKATO_DATA_TABLES_BASE_URL') ||
    'https://data-tables.workato.com'
  ).replace(/\/$/, '');

  const apiToken = safeString_(opts.apiToken || scriptProps.getProperty('WORKATO_API_TOKEN'));

  if (!resolvedWorkspaceId) throw new Error('Missing workspaceId');
  if (!apiToken)            throw new Error('Missing WORKATO_API_TOKEN');

  return {
    workspaceId:      resolvedWorkspaceId,
    managementBaseUrl,
    recordsBaseUrl,
    apiToken,
    pageSize:         Number(opts.pageSize || 100),
    debugEndpoints:   opts.debugEndpoints === true
  };
}

// ---------------------------------------------------------------------------
// WORKATO REPAIR CLIENT
// ---------------------------------------------------------------------------

/**
 * HTTP client scoped to a single managed workspace.
 * Uses two base URLs: management API (app.eu.workato.com) and
 * records API (data-tables.workato.com).
 */
class WorkatoRepairClient {
  constructor(config) {
    this.workspaceId      = safeString_(config.workspaceId);
    this.managementBaseUrl = safeString_(config.managementBaseUrl).replace(/\/$/, '');
    this.recordsBaseUrl   = safeString_(config.recordsBaseUrl).replace(/\/$/, '');
    this.apiToken         = safeString_(config.apiToken);
    this.pageSize         = Number(config.pageSize || 100);
    this.debugEndpoints   = config.debugEndpoints === true;
    this.tableCacheByName_ = null;
    this.tableCacheById_   = null;

    if (!this.workspaceId)       throw new Error('WorkatoRepairClient: workspaceId is required');
    if (!this.managementBaseUrl) throw new Error('WorkatoRepairClient: managementBaseUrl is required');
    if (!this.recordsBaseUrl)    throw new Error('WorkatoRepairClient: recordsBaseUrl is required');
    if (!this.apiToken)          throw new Error('WorkatoRepairClient: apiToken is required');
  }

  listAll(tableName) {
    const table = this.getTableByName_(tableName);
    let page = 1, rows = [];
    while (true) {
      const batch = this.listPageByTableId_(table.id, page, this.pageSize);
      rows = rows.concat(batch.records || []);
      if (!batch.hasMore) break;
      page += 1;
      if (page % 10 === 0) Utilities.sleep(50);
      if (page > 500) throw new Error(`Pagination safety limit reached for ${tableName}`);
    }
    return rows;
  }

  updateByBusinessId(tableName, businessId, fields) {
    if (!businessId) throw new Error(`updateByBusinessId: missing businessId for ${tableName}`);
    const record   = this.findOneByField_(tableName, 'id', businessId);
    if (!record)   throw new Error(`updateByBusinessId: row not found for ${tableName}.id=${businessId}`);
    const recordId = record['Record ID'];
    if (!recordId) throw new Error(`updateByBusinessId: row missing Record ID for ${tableName}.id=${businessId}`);
    return this.updateByRecordId_(tableName, recordId, fields);
  }

  findOneByField_(tableName, fieldName, value) {
    const results = this.queryByField_(tableName, fieldName, value, 2);
    if (!results.length) return null;
    if (results.length > 1) throw new Error(`Expected one ${tableName} row for ${fieldName}=${value}, found ${results.length}`);
    return results[0];
  }

  queryByField_(tableName, fieldName, value, limit) {
    const table    = this.getTableByName_(tableName);
    const payload  = { filters: [{ field: fieldName, operator: 'equals', value }], limit: Number(limit || 100) };
    const response = this.requestRecords_('post', this.buildQueryEndpointByTableId_(table.id), payload);
    return normalizeTableRecords_(response);
  }

  listPageByTableId_(tableId, page, pageSize) {
    const endpoint = this.buildListRecordsEndpointByTableId_(tableId, page, pageSize);
    const response = this.requestRecords_('get', endpoint, null);
    const records  = normalizeTableRecords_(response);
    return { records, hasMore: records.length >= pageSize };
  }

  updateByRecordId_(tableName, recordId, fields) {
    const table = this.getTableByName_(tableName);
    return this.requestRecords_('put', this.buildRecordEndpointByTableId_(table.id, recordId), { fields });
  }

  getTableByName_(tableName) {
    const name = safeString_(tableName);
    if (!name) throw new Error('Table name is required');
    if (!this.tableCacheByName_) this.loadTableCache_();
    const table = this.tableCacheByName_[name];
    if (!table) throw new Error(`Data table not found: ${name}. Available: ${Object.keys(this.tableCacheByName_).sort().join(', ')}`);
    return table;
  }

  loadTableCache_() {
    const rows = this.listAllTables_();
    this.tableCacheByName_ = {};
    this.tableCacheById_   = {};
    rows.forEach(row => {
      const id   = safeString_(row.id);
      const name = safeString_(row.name);
      if (id)   this.tableCacheById_[id]     = row;
      if (name) this.tableCacheByName_[name] = row;
    });
  }

  listAllTables_() {
    let page = 1, out = [];
    while (true) {
      const response = this.requestManagement_('get', this.buildListTablesEndpoint_(page, this.pageSize), null);
      const rows     = normalizeTableRecords_(response);
      out = out.concat(rows);
      if (rows.length < this.pageSize) break;
      page += 1;
      if (page % 10 === 0) Utilities.sleep(50);
      if (page > 500) throw new Error('Pagination safety limit reached while discovering data tables');
    }
    return out;
  }

  // Endpoint builders
  buildListTablesEndpoint_(page, pageSize) {
    return `/api/v2/managed_users/${encodeURIComponent(this.workspaceId)}/data_tables?page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(pageSize)}`;
  }
  buildListRecordsEndpointByTableId_(tableId, page, pageSize) {
    return `/api/v1/managed_users/${encodeURIComponent(this.workspaceId)}/tables/${encodeURIComponent(tableId)}/query?page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(pageSize)}`;
  }
  buildQueryEndpointByTableId_(tableId) {
    return `/api/v1/managed_users/${encodeURIComponent(this.workspaceId)}/tables/${encodeURIComponent(tableId)}/query`;
  }
  buildRecordEndpointByTableId_(tableId, recordId) {
    return `/api/v1/managed_users/${encodeURIComponent(this.workspaceId)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  }

  requestManagement_(method, endpoint, payload) { return this.requestRaw_(this.managementBaseUrl, method, endpoint, payload, 'management'); }
  requestRecords_(method, endpoint, payload)    { return this.requestRaw_(this.recordsBaseUrl,    method, endpoint, payload, 'records'); }

  requestRaw_(baseUrl, method, endpoint, payload, familyLabel) {
    const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url       = `${baseUrl}${cleanPath}`;

    if (this.debugEndpoints) {
      debugRepairEndpoint_(`${familyLabel}.request`, `${String(method).toUpperCase()} ${url}`);
      if (payload != null) debugRepairEndpoint_(`${familyLabel}.payload`, JSON.stringify(payload));
    }

    const options = {
      method:             String(method || 'get').toLowerCase(),
      muteHttpExceptions: true,
      headers: { Authorization: `Bearer ${this.apiToken}`, Accept: 'application/json' }
    };

    if (payload != null) {
      options.contentType = 'application/json';
      options.payload     = JSON.stringify(payload);
    }

    const res  = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const text = res.getContentText();

    if (this.debugEndpoints) debugRepairEndpoint_(`${familyLabel}.response`, `${code} ${text ? text.slice(0, 1000) : ''}`);
    if (code < 200 || code >= 300) throw new Error(`Workato API error ${code} ${String(method).toUpperCase()} ${url}: ${text}`);

    try {
      return text ? JSON.parse(text) : {};
    } catch (e) {
      return { raw_content: text };
    }
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function normalizeRepairOptions_(options) {
  const opts = options || {};
  return {
    dryRun:                   opts.dryRun !== false,
    previewOnly:              !!opts.previewOnly,
    defaultTemplateVersionId: safeString_(opts.defaultTemplateVersionId),
    defaultWorkspaceId:       safeString_(opts.defaultWorkspaceId),
    pageSize:                 Number(opts.pageSize || 100),
    managementBaseUrl:        safeString_(opts.managementBaseUrl),
    recordsBaseUrl:           safeString_(opts.recordsBaseUrl),
    apiToken:                 safeString_(opts.apiToken),
    throwOnVerifyFailure:     opts.throwOnVerifyFailure !== false,
    debugEndpoints:           opts.debugEndpoints === true
  };
}

function normalizeTableRecords_(response) {
  if (!response) return [];
  if (Array.isArray(response))          return response;
  if (Array.isArray(response.records))  return response.records;
  if (Array.isArray(response.data))     return response.data;
  if (Array.isArray(response.items))    return response.items;
  if (Array.isArray(response.result))   return response.result;
  return [];
}

function indexBy_(rows, key) {
  return (rows || []).reduce((acc, row) => {
    const v = safeString_(row && row[key]);
    if (v) acc[v] = row;
    return acc;
  }, {});
}

function safeString_(v) {
  return v == null ? '' : String(v).trim();
}

function isBadSupplierStatus_(status) {
  const s = safeString_(status).toLowerCase();
  return s === 'pending _supplier' || s === 'pending_supplier_typo';
}

function minimalRequestIssue_(req, reason) {
  return { supplier_request_id: req.id || '', supplier_name: req.supplier_name || '', current_version_id: req.current_version_id || '', reason };
}

function logRepairResult_(label, obj) {
  Logger.log('[workspace=%s] %s\n%s', obj && obj.workspaceId ? obj.workspaceId : 'unknown', label, JSON.stringify(obj, null, 2));
}

function debugRepairEndpoint_(label, value) {
  Logger.log('[repair-endpoint] %s: %s', label, value);
}

/**
 * Workspace ID resolution — 4-level fallback chain:
 * 1. Explicit argument
 * 2. options.defaultWorkspaceId
 * 3. TEMP_CONFIG.workspaceId (set to '' by default — must be configured)
 * 4. Script Property WORKSPACE_REPAIR_DEFAULT_WORKSPACE_ID
 */
function resolveWorkspaceId_(workspaceId, options) {
  const explicit    = safeString_(workspaceId);
  if (explicit)     return explicit;
  const fromOptions = safeString_(options && options.defaultWorkspaceId);
  if (fromOptions)  return fromOptions;
  const fromConfig  = safeString_(TEMP_CONFIG && TEMP_CONFIG.workspaceId);
  if (fromConfig)   return fromConfig;
  const fromScript  = safeString_(PropertiesService.getScriptProperties().getProperty(WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_));
  if (fromScript)   return fromScript;
  throw new Error(`No workspaceId provided. Call setDefaultWorkspaceRepairId() or set Script Property ${WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_}.`);
}

function setDefaultWorkspaceRepairId(workspaceId) {
  const value = safeString_(workspaceId);
  if (!value) throw new Error('workspaceId is required');
  PropertiesService.getScriptProperties().setProperty(WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_, value);
  Logger.log('Default workspace repair ID set: %s', value);
  return value;
}

function getDefaultWorkspaceRepairId() {
  return safeString_(PropertiesService.getScriptProperties().getProperty(WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_));
}

function clearDefaultWorkspaceRepairId() {
  PropertiesService.getScriptProperties().deleteProperty(WORKSPACE_REPAIR_DEFAULT_WORKSPACE_KEY_);
  Logger.log('Default workspace repair ID cleared');
}

function summarizeResponseShape_(response) {
  if (response == null)          return { kind: 'nullish' };
  if (Array.isArray(response))   return { kind: 'array', length: response.length, firstKeys: response.length ? Object.keys(response[0] || {}) : [] };

  const out = { kind: typeof response, keys: Object.keys(response || {}) };
  if (Array.isArray(response.records)) { out.recordsLength = response.records.length; out.recordsFirstKeys = response.records.length ? Object.keys(response.records[0] || {}) : []; }
  if (Array.isArray(response.data))    { out.dataLength    = response.data.length;    out.dataFirstKeys    = response.data.length    ? Object.keys(response.data[0]    || {}) : []; }
  if (Array.isArray(response.items))   { out.itemsLength   = response.items.length;   out.itemsFirstKeys   = response.items.length   ? Object.keys(response.items[0]   || {}) : []; }
  if (Array.isArray(response.result))  { out.resultLength  = response.result.length;  out.resultFirstKeys  = response.result.length  ? Object.keys(response.result[0]  || {}) : []; }
  return out;
}

function summarizeResponseSample_(response) {
  if (response == null)                return null;
  if (Array.isArray(response))         return response.slice(0, 2);
  if (Array.isArray(response.records)) return response.records.slice(0, 2);
  if (Array.isArray(response.data))    return response.data.slice(0, 2);
  if (Array.isArray(response.items))   return response.items.slice(0, 2);
  if (Array.isArray(response.result))  return response.result.slice(0, 2);
  return response;
}

/**
 * @file 099_Dev_Tools.gs
 * @description Development and testing utilities. Not part of the production webhook path.
 *
 * CHANGES FROM ORIGINAL:
 *  - Consolidated from 098_Test_Harness.js and setup.gs into a single file.
 *  - Removed detectConfigurationDrift() and getDeployedWorkatoTableSchema() —
 *    both were standalone duplicates of DiagnosticsRunner.detectDrift() and
 *    InventoryService.getDeployedTableSchema(). Use runCommand('diagnostics.detectDrift')
 *    via TEST_RunDriftDetection() instead.
 *  - Updated TEST_RunDriftDetection to call runCommand() instead of Commands.run().
 *  - TEMP_CONFIG is defined in 005_Repair.gs. All RUN_* and TEST_* functions
 *    that use it reference it from there.
 */

// ---------------------------------------------------------------------------
// TEST HARNESS
// ---------------------------------------------------------------------------

/**
 * Builds mock doPost event objects for testing route handlers directly.
 */
class TestHarness {
  static createMockEvent(path, payload, token = null) {
    return {
      parameter: { path, token },
      postData:  { contents: JSON.stringify(payload) }
    };
  }

  static getWebhookSecret_() {
    return SecretStore.getRequired('WEBHOOK_SECRET');
  }

  static logResponse(testName, textOutput) {
    Logger.log(`\n=== RESULTS: ${testName} ===`);
    if (!textOutput) {
      Logger.log('ERROR: No response returned from doPost.');
      return;
    }
    Logger.log(textOutput.getContent());
    Logger.log('====================================\n');
  }
}

// ---------------------------------------------------------------------------
// WEBHOOK ROUTE TESTS
// ---------------------------------------------------------------------------

function test_InitializeWorkspace() {
  Logger.log('Starting Test: Initialize Workspace...');

  const mockPayload = {
    control_center_id: 'cc_test_1234',
    project_metadata: {
      project_name:   'Acme Corp Q3 Intake',
      target_vms:     'Fieldglass',
      analyst_email:  'analyst@yourdomain.com'
    },
    supplier_roster: [
      { supplier_name: 'TechCorp', contact_email: 'vendor@techcorp.com' }
    ],
    matrix_schema: {
      fields: [
        { field_id: 'f-001', field_name: 'First Name', data_type: 'string', required: true, position: 1 },
        { field_id: 'f-002', field_name: 'Start Date', data_type: 'date',   required: true, position: 2 }
      ],
      rules: [], lookups: [], error_translations: []
    }
  };

  const mockEvent = TestHarness.createMockEvent('/initialize-workspace', mockPayload, TestHarness.getWebhookSecret_());
  TestHarness.logResponse('Initialize Workspace', doPost(mockEvent));
}

function test_InjectSeedData() {
  Logger.log('Starting Test: Inject Seed Data...');

  const mockPayload = {
    supplier_request_id: 'uuid-1234-5678-9012',
    seed_data_payload: [
      { row_number: 1, 'First Name': 'John', 'Start Date': '2024-01-01' },
      { row_number: 2, 'First Name': 'Jane', 'Start Date': '2024-02-15' }
    ]
  };

  const mockEvent = TestHarness.createMockEvent('/inject-seed-data', mockPayload, TestHarness.getWebhookSecret_());
  TestHarness.logResponse('Inject Seed Data', doPost(mockEvent));
}

function test_InvalidRoute() {
  Logger.log('Starting Test: Invalid Route...');
  const mockEvent = TestHarness.createMockEvent('/fake-endpoint-xyz', { test: 'data' }, TestHarness.getWebhookSecret_());
  TestHarness.logResponse('Invalid Route (Should 404)', doPost(mockEvent));
}

function test_UnauthorizedRoute() {
  Logger.log('Starting Test: Unauthorized Route...');
  const mockEvent = TestHarness.createMockEvent('/initialize-workspace', { test: 'data' }, 'bad-token');
  TestHarness.logResponse('Unauthorized Route (Should 401)', doPost(mockEvent));
}

function runAllTests() {
  test_InitializeWorkspace();
  test_InjectSeedData();
  test_InvalidRoute();
  test_UnauthorizedRoute();
}

// ---------------------------------------------------------------------------
// DIAGNOSTICS TESTS
// ---------------------------------------------------------------------------

function TEST_validateBackendEnvironment() {
  const result = validateBackendEnvironment();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Runs schema drift detection via the command runner.
 * Requires a valid WORKATO_API_TOKEN in Script Properties.
 */
function TEST_RunDriftDetection() {
  const ctx = new AppContext();
  runCommand('diagnostics.detectDrift', {}, ctx);
}

// ---------------------------------------------------------------------------
// MOCK PAYLOAD SENDERS
// ---------------------------------------------------------------------------

/** Sends the R-008 bootstrap payload to Workato for manual testing. */
function sendMockBootstrapPayloadToWorkato() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('WORKATO_BOOTSTRAP_URL')
    || 'https://webhooks.workato.com/webhooks/rest/YOUR_TOKEN_HERE';

  if (webhookUrl.includes('YOUR_TOKEN_HERE')) {
    Logger.log('ERROR: Set WORKATO_BOOTSTRAP_URL in Script Properties before running this.');
    return;
  }

  const mockPayload = {
    workspace_binding_id:    'wb_acme_001',
    control_center_id:       'cc_1xyz9876543210abcdefGHI',
    init_manifest_hash:      'mh_2026_03_21_acme_demo_v1',
    recipe_bundle_version:   'mvp-1',
    schema_contract_version: '2026-03-21',
    template_version_id:     'uuid-version-1222',
    template_project_id:     'uuid-version-1234',
    target_folder_id:        1234567,
    project_metadata: {
      project_name:  'Acme Corp Q3 Intake',
      target_vms:    'Fieldglass',
      analyst_email: 'analyst@yourdomain.com'
    },
    supplier_roster: [
      { supplier_request_id: 'uuid-supplier-1234', supplier_name: 'TechCorp',    supplier_contact_name: 'Firstname Lastname', contact_email: 'vendor@techcorp.com',    has_seeded_data: true, roster_index: 0 },
      { supplier_request_id: 'uuid-supplier-5678', supplier_name: 'SomeBusiness',supplier_contact_name: 'Firstname Lastname', contact_email: 'vendor@somebusiness.com',has_seeded_data: true, roster_index: 1 }
    ],
    matrix_schema: {
      fields: [{ field_id: 'f-001', template_version_id: 'uuid-version-1234', field_name: 'Start Date', description: 'The projected start date of the worker', data_type: 'date', required: true, must_be_empty: false, column_unique: false, data_cleaning_flags: 'trim', position: 1, lookup_name: 'US_States', strict_enforcement: true }],
      rules:  [{ rule_id: 'r-001', template_version_id: 'uuid-version-1234', field_id: 'f-001', rule_type: 'date_logic', condition_operator: 'greater_than', condition_value: 'TODAY', error_message: 'Start Date must be in the future.', strict_enforcement: true }],
      lookups:[{ lookup_id: 'l-001', template_version_id: 'uuid-version-1234', lookup_name: 'US_States', valid_values: '["CA", "NY", "TX"]' }],
      error_translations: [{ error_translation_id: 'e-001', template_version_id: 'uuid-version-1234', sql_error_code: 'TYPE_MISMATCH', human_readable_message: 'Please ensure this field is formatted correctly.' }]
    }
  };

  Logger.log('Sending mock bootstrap payload to Workato...');
  Logger.log(JSON.stringify(mockPayload, null, 2));

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(mockPayload), muteHttpExceptions: true
  });

  Logger.log(`Response code: ${response.getResponseCode()}`);
  Logger.log(`Response body: ${response.getContentText()}`);
  Logger.log(response.getResponseCode() < 300 ? 'SUCCESS!' : `FAILED: ${response.getResponseCode()}`);
}

/** Sends R-001a template registration payload. */
function sendMockTemplateRegistrationPayload() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('WORKATO_TEMPLATE_REG_URL');
  if (!webhookUrl) { Logger.log('ERROR: Set WORKATO_TEMPLATE_REG_URL in Script Properties.'); return; }

  const mockPayload = {
    event_type:          'template_generated',
    template_version_id: 'versionID',
    file_name:           'Acme Corp Q3 Intake_20240101_1200.xlsx',
    google_drive_file_id:  '1abc2def3ghi4jkl5mno6pqr',
    google_drive_file_url: 'https://docs.google.com/spreadsheets/d/1abc2def3ghi4jkl5mno6pqr/edit',
    config_spreadsheet_id: '1xyz9876543210abcdefGHI',
    customer_info: {
      'Analyst_email_address': 'analyst@yourdomain.com',
      'Customer_name': 'Acme Corp', 'Version': 1.0, 'Target_VMS': 'Fieldglass',
      'Has_incumbent_data?': true
    },
    timestamp: new Date().toISOString()
  };

  Logger.log('Sending R-001a mock payload...');
  const response = UrlFetchApp.fetch(webhookUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(mockPayload), muteHttpExceptions: true });
  Logger.log(response.getResponseCode() < 300 ? 'SUCCESS!' : `FAILED: ${response.getResponseCode()}`);
}

/** Sends R-004 supplier outreach payload. */
function sendMockSupplierOutreachPayload() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('WORKATO_OUTREACH_URL');
  if (!webhookUrl) { Logger.log('ERROR: Set WORKATO_OUTREACH_URL in Script Properties.'); return; }

  const mockPayload = {
    config_spreadsheet_id: '1xyz9876543210abcdefGHI',
    template_version_id:   'sdsdfds',
    customer_info: { 'Analyst_email_address': 'analyst@yourdomain.com', 'Customer_name': 'Acme Corp', 'Target_VMS': 'Fieldglass' },
    requests: [{ supplier_request_id: 'xxx', supplier_name: 'TechCorp Solutions', supplier_contact_email: 'vendor@techcorpsolutions.com', spreadsheet_row_number: 12, has_seeded_data: true, seed_data_location: '1seedDataFolderId' }]
  };

  Logger.log('Sending R-004 mock payload...');
  const response = UrlFetchApp.fetch(webhookUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(mockPayload), muteHttpExceptions: true });
  Logger.log(response.getResponseCode() < 300 ? 'SUCCESS!' : `FAILED: ${response.getResponseCode()}`);
}

/** Sends R-009b inject seed data payload. */
function sendMockInjectSeedDataPayload() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('WORKATO_INJECT_SEED_URL');
  if (!webhookUrl) { Logger.log('ERROR: Set WORKATO_INJECT_SEED_URL in Script Properties.'); return; }

  const mockPayload = {
    supplier_request_id: 'uuid-supplier-req-1234',
    seed_data_payload: [
      { row_number: 1, field_name: 'First Name', submitted_value: 'John' },
      { row_number: 1, field_name: 'Start Date', submitted_value: '2024-01-01' },
      { row_number: 2, field_name: 'First Name', submitted_value: 'Jane' },
      { row_number: 2, field_name: 'Start Date', submitted_value: '2024-02-15' }
    ]
  };

  Logger.log('Sending R-009b mock payload...');
  const response = UrlFetchApp.fetch(webhookUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(mockPayload), muteHttpExceptions: true });
  Logger.log(response.getResponseCode() < 300 ? 'SUCCESS!' : `FAILED: ${response.getResponseCode()}`);
}

// ---------------------------------------------------------------------------
// REPAIR RUNNER TEST ENTRY POINTS
// ---------------------------------------------------------------------------

function TEST_setDefaultWorkspaceRepairId()   { return setDefaultWorkspaceRepairId(TEMP_CONFIG.workspaceId); }
function TEST_getResolvedWorkspaceId()         { return resolveWorkspaceId_(null, {}); }

function TEST_repairRunner_discoverTables() {
  return createRepairClient_(TEMP_CONFIG.workspaceId, { debugEndpoints: TEMP_CONFIG.debugEndpoints }).listAllTables_();
}
function TEST_repairRunner_listTemplateVersions() {
  return createRepairClient_(TEMP_CONFIG.workspaceId, { debugEndpoints: TEMP_CONFIG.debugEndpoints }).listAll('VER_TemplateVersion');
}
function TEST_repairRunner_listSupplierRequests() {
  return createRepairClient_(TEMP_CONFIG.workspaceId, { debugEndpoints: TEMP_CONFIG.debugEndpoints }).listAll('WFA_SupplierRequest');
}
function TEST_previewWorkspaceVersionRepair() {
  return previewWorkspaceVersionRepair(TEMP_CONFIG.workspaceId, { dryRun: true, debugEndpoints: TEMP_CONFIG.debugEndpoints, defaultTemplateVersionId: '' });
}
function TEST_runWorkspaceVersionRepair_dryRun() {
  return runWorkspaceVersionRepair(TEMP_CONFIG.workspaceId, { dryRun: true, previewOnly: false, debugEndpoints: TEMP_CONFIG.debugEndpoints, defaultTemplateVersionId: '' });
}
function TEST_runWorkspaceVersionRepair_live() {
  return runWorkspaceVersionRepair(TEMP_CONFIG.workspaceId, { dryRun: false, previewOnly: false, debugEndpoints: TEMP_CONFIG.debugEndpoints, defaultTemplateVersionId: '', throwOnVerifyFailure: true });
}

// ---------------------------------------------------------------------------
// SCRIPT-EDITOR-FRIENDLY RUNNERS (for Apps Script IDE run button)
// ---------------------------------------------------------------------------

function RUN_previewWorkspaceVersionRepair() {
  return previewWorkspaceVersionRepair(TEMP_CONFIG.workspaceId, { dryRun: true, debugEndpoints: TEMP_CONFIG.debugEndpoints });
}
function RUN_runWorkspaceVersionRepair_dryRun() {
  return runWorkspaceVersionRepair(TEMP_CONFIG.workspaceId, { dryRun: true, previewOnly: false, debugEndpoints: TEMP_CONFIG.debugEndpoints, defaultTemplateVersionId: '' });
}
function RUN_runWorkspaceVersionRepair_live() {
  return runWorkspaceVersionRepair(TEMP_CONFIG.workspaceId, { dryRun: false, previewOnly: false, debugEndpoints: TEMP_CONFIG.debugEndpoints, defaultTemplateVersionId: '', throwOnVerifyFailure: true });
}
function RUN_verifyWorkspaceVersionInvariants() {
  return verifyWorkspaceVersionInvariants(TEMP_CONFIG.workspaceId, { throwOnVerifyFailure: true, debugEndpoints: TEMP_CONFIG.debugEndpoints });
}

function RUN_diagnoseRepairApi() {
  const cfg    = getWorkspaceRepairConfig_(TEMP_CONFIG.workspaceId, { debugEndpoints: true });
  const client = new WorkatoRepairClient(cfg);

  const report = { workspaceId: cfg.workspaceId, managementBaseUrl: cfg.managementBaseUrl, recordsBaseUrl: cfg.recordsBaseUrl, timestamp: new Date().toISOString(), probes: [] };

  const probe = {
    name:     'list_data_tables_root',
    family:   'management',
    method:   'get',
    endpoint: `/api/v2/managed_users/${encodeURIComponent(cfg.workspaceId)}/data_tables?page=1&per_page=20`
  };

  try {
    const response = client.requestManagement_(probe.method, probe.endpoint, null);
    report.probes.push({ name: probe.name, family: probe.family, ok: true, endpoint: probe.endpoint, responseShape: summarizeResponseShape_(response), sample: summarizeResponseSample_(response) });
  } catch (e) {
    report.probes.push({ name: probe.name, family: probe.family, ok: false, endpoint: probe.endpoint, error: String(e && e.message ? e.message : e) });
  }

  try {
    const discovered = client.listAllTables_();
    report.discoveredTables = discovered.map(r => ({ id: r.id || '', name: r.name || '', folder_id: r.folder_id || '' }));

    const verTable = discovered.find(r => safeString_(r.name) === 'VER_TemplateVersion');
    if (verTable && safeString_(verTable.id)) {
      const recordEndpoint = `/api/v1/managed_users/${encodeURIComponent(cfg.workspaceId)}/tables/${encodeURIComponent(verTable.id)}/query`;
      try {
        const response = client.requestRecords_('post', recordEndpoint, { limit: 2, filters: [] });
        report.probes.push({ name: 'query_ver_templateversion', family: 'records', ok: true, endpoint: recordEndpoint, responseShape: summarizeResponseShape_(response), sample: summarizeResponseSample_(response) });
      } catch (e) {
        report.probes.push({ name: 'query_ver_templateversion', family: 'records', ok: false, endpoint: recordEndpoint, error: String(e && e.message ? e.message : e) });
      }
    }
  } catch (e) {
    report.discoveryError = String(e && e.message ? e.message : e);
  }

  logRepairResult_('RUN_diagnoseRepairApi', report);
  return report;
}

function RUN_discoverWorkspaceTables() {
  const cfg    = getWorkspaceRepairConfig_(TEMP_CONFIG.workspaceId, { debugEndpoints: true });
  const client = new WorkatoRepairClient(cfg);
  const rows   = client.listAllTables_();
  const result = { workspaceId: cfg.workspaceId, discoveredCount: rows.length, discoveredTables: rows.map(r => ({ id: r.id || '', name: r.name || '', folder_id: r.folder_id || '' })) };
  logRepairResult_('RUN_discoverWorkspaceTables', result);
  return result;
}

function test_ProbeWorkflowAppAPI() {
  const ctx = new AppContext();
  ['workflow_apps', 'workflow_apps/pages', 'apps', 'portal/apps'].forEach(ep => {
    try {
      const result = ctx.client.get(ep);
      Logger.log(`${ep}: ${JSON.stringify(result).substring(0, 200)}`);
    } catch (e) {
      Logger.log(`${ep}: ${e.message}`);
    }
  });
}

function test_ExportWorkspaceZip() {
  const ctx = new AppContext();
  try {
    Logger.log(JSON.stringify(ctx.client.get('exports')));
  } catch (e) {
    Logger.log(e.message);
  }
}
