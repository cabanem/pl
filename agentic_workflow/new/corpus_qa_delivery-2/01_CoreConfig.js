/**
 * @file 01_Core_Config.gs
 */
// -------------------------------------------------------------------------------------------------------
// CONFIGURATION
// -------------------------------------------------------------------------------------------------------
/**
 * @typedef {Object} APIConfig
 * @property {string} TOKEN - The Workato API bearer token.
 * @property {string} BASE_URL - The Workato API endpoint.
 * @property {number} PER_PAGE - Records per request.
 * @property {number} MAX_CALLS - Safety limit for recursive API calls.
 * @property {number} THROTTLE_MS - Delay (ms) between heavy processing loops.
 * @property {number} RECIPE_LIMIT_DEBUG - Limit on how many recipes to process.
 */

/**
 * @typedef {Object} AppConfigObject
 * @property {APIConfig} API - API connection settings.
 * @property {Object.<string, string>} SHEETS - Mapping of resource types to sheet names.
 * @property {Object.<string, string[]>} HEADERS - Definitions of column headers.
 * @property {Object} CONSTANTS - Internal constants for parsing logic and styling.
 * @property {boolean} VERBOSE - Toggle for detailed logging.
 */

/**
 * @class
 * @classdesc Static container for application schema definitions.
 */
class SchemaDef {
  /**
   * Defines the user-facing names of the Google Sheets tabs.
   * Keys correspond to internal reference IDs used in AppConfig.
   */
  static get SHEETS() {
    return {
      DASHBOARD_HOME: "Dashboard_Home",
      VIEW_RECIPES: "View_Recipes",
      SEAMS: "View_Seams",
      UNUSED: "View_Unused",

      PROJECTS: "Inventory_Projects",
      FOLDERS: "Inventory_Folders",
      RECIPES: "Inventory_Recipes",
      PROPERTIES: "Inventory_Properties",
      TABLES: "Inventory_Data_Tables",
      LOOKUP_TABLES: "Inventory_Lookup_Tables",
      DEPENDENCIES: "Analysis_Dependencies",
      CALL_EDGES: "Analysis_Call_Edges",
      LOGIC: "Debug_Recipe_Logic",
      DEBUG: "System_Logs",

      LOGIC_INPUT: "Input_Requests",
      CHANGE_LOG: "Input_Journal",

      FINGERPRINTS: "_Fingerprints",
      EDGE_STATE: "_Edge_State",
      AMBIGUITY: "_Ambiguity",

      AI_ANALYSIS: "Output_AI_Analysis",
      PROCESS_MAPS: "Output_Process_Maps",
      SYSTEM_DOCS: "Output_System_Docs",
      QA_LOG: "Output_QA_Log" // ***UPDATED*** durable Q&A record — System_Logs is audit-only and pruned by Maintenance
    };
  }
  /**
   * Defines the column headers for every sheet type.
   * ORDER MATTERS: These must match the order of elements produced in DataMapper.
   */
  static get HEADERS() {
    return {
      // ViewRecipes
      VIEW_RECIPES: ["Recipe ID", "Name", "Status", "Project", "Folder", "Last run at", "Times called", "Calls out", "Role", "# Dependencies", "Jobs Failed", "Has AI?", "Has maps?"],
      SEAMS: ["From recipe ID", "From recipe", "From project", "To recipe ID", "To recipe", "To project", "Step", "Branch"],
      UNUSED: ["Recipe ID", "Name", "Status", "Last run at", "Project", "Why"],

      // InventoryService -> DataMapper.mapProjectsToRows
      PROJECTS: ["Project ID", "Name", "Description", "Created At"],

      // InventoryService -> DataMapper.mapFoldersToRows
      FOLDERS: ["Folder ID", "Name", "Parent Folder", "Project"],

      // InventoryService -> DataMapper.mapRecipesToRows
      // Columns 7+ come straight from the List recipes endpoint (same fields as Get recipe details).
      RECIPES: ["Recipe ID", "Name", "Status", "Project", "Folder", "Last Run At", "Version",
        "Updated At", "Jobs Succeeded", "Jobs Failed", "Lifetime Tasks", "Applications"],

      // InventoryService -> DataMapper.mapPropertiesToRows
      PROPERTIES: ["Property ID", "Name", "Value", "Created At", "Updated At"],

      // AnalyzerService -> DataMapper.mapDependenciesToRows
      DEPENDENCIES: ["Parent Recipe ID", "Project", "Folder", "Dependency Type", "Dependency ID", "Dependency Name"],
      TABLES: ["Table ID", "Name", "Description", "Columns", "Record count", "Updated at"],
      LOOKUP_TABLES: ["Table ID", "Name", "Description", "Columns", "Record count", "Updated at"],

      // AnalyzerService -> DataMapper.mapCallEdgesToRows
      CALL_EDGES: ["Parent Recipe ID", "Parent Recipe Name", "Project", "Folder", "Step Path", "Step Name", "Branch Context",
        "Provider", "Child Recipe ID", "Child Recipe Name", "ID Key", "Child project"],

      // AnalyzerService -> DataMapper via parseLogicRows
      LOGIC: ["Recipe ID", "Recipe Name", "Step #", "Indentation", "Provider", "Action", "Description", "Details/Code"],

      // SheetService.readRequests uses index 0 of this array for validation
      LOGIC_INPUT: ["Recipe ID (Input List)"],

      CHANGE_LOG: ["date_iso", "kind", "change", "subject", "detail"],

      // SheetService.appendDebugRows -> DataMapper.mapDebugLogsToRows
      DEBUG: ["Timestamp", "Recipe ID", "Recipe Name", "Status", "Drive Link", "JSON Payload"],

      FINGERPRINTS: ["recipe_id", "name", "code_fp"],
      EDGE_STATE: ["caller_id", "callee_id"],
      AMBIGUITY: ["date_iso", "level", "code", "detail"],

      // GeminiService -> WorkatoSyncApp.runAiAnalysis
      AI_ANALYSIS: ["Recipe ID", "Recipe Name", "Objective", "Trigger", "High Level Flow", "Hotspots", "External Apps", "Called Recipes",
        "Risks & Notes", "Structured Preview", "Graph Metrics", "Link: AI Analysis", "Link: Call Graph", "Link: Full Graph", "Source FP", "Timestamp"],

      // WorkatoSyncApp.runProcessMaps
      PROCESS_MAPS: ["Root Recipe ID", "Root Name", "Mode", "Depth", "Call Graph (Mermaid)", "Process Graph (Mermaid)",
        "Generation Notes", "Link: Call Graph", "Link: Full Graph", "Timestamp"],

      // Documentation Output
      SYSTEM_DOCS: ["Timestamp", "Document Type", "Target IDs", "Status", "Drive Link"],

      // ***UPDATED*** CorpusQaService._qaLogRow_ writes in this order; recent() reads by these indices
      QA_LOG: ["Timestamp", "Asked By", "Question", "Answer", "Citations", "Refused", "Corpus FP12", "Corpus Generated At"]
    };
  }
  /**
   * System-wide constants used for styling, limits, and parsing configuration.
   */
  static get CONSTANTS() {
    return {
      STYLE_HEADER_BG: "#d9d9d9",
      MERMAID_LABEL_MAX: 60,
      CELL_CHAR_LIMIT: 48000
    };
  }
}

/**
 * @class
 * @classdesc Static configuration container.
 * * Centralizes all settings, constants, and API parameters.
 */
class AppConfig {
  static get() {
    return {
      API: {
        TOKEN: ConfigStore.get('WORKATO_TOKEN', { preferUser: true, defaultValue: "" }),
        BASE_URL: (ConfigStore.get('WORKATO_BASE_URL', {
          preferUser: true,
          defaultValue: 'https://app.eu.workato.com/api'
        }) || 'https://app.eu.workato.com/api').replace(/\/$/, ''),
        PER_PAGE: 100,
        MAX_CALLS: 500,
        THROTTLE_MS: 100,
        RECIPE_LIMIT_DEBUG: 200,
        PROCESS_MAP_DEPTH: 3,
        PROCESS_MAP_MODE_DEFAULT: "calls+full",
        PROCESS_MAP_MAX_NODES: 250,
        PROCESS_MAP_EXPORT_TABLES: true,
        MAX_RETRIES: 3
      },
      SHEETS: SchemaDef.SHEETS,
      HEADERS: SchemaDef.HEADERS,
      CONSTANTS: SchemaDef.CONSTANTS,
      DEBUG: {
        ENABLE_LOGGING: true,
        LOG_TO_SHEET: true,
        LOG_TO_DRIVE: true,
        DRIVE_FOLDER_NAME: "workato_workspace_debug_logs"
      },
      VERTEX: {
        GOOGLE_CLOUD_PROJECT_ID: ConfigStore.get('GOOGLE_CLOUD_PROJECT_ID', { preferUser: false, defaultValue: "" }),
        MODEL_ID: 'gemini-3.1-pro',
        LOCATION: 'global',
        GENERATION_CONFIG: {
          TEMPERATURE: 0.2,
          MAX_OUTPUT_TOKENS: 10000
        },
        PROMPT_MAX_CHARS: 60000,
        MERMAID_PROMPT_MAX_CHARS: 120000,
        LOGIC_DIGEST_MAX_LINES: 220,
        MAX_RETRIES: 3
      },
      DASHBOARD: {
        ENABLE: true,
        OVERWRITE_VIEWS: true,
        HIDE_BACKEND_IN_BASIC: true,
        PROTECT_BACKEND_WARNING_ONLY: true,
        SHOW_OUTPUT_SHEETS_IN_BASIC: false,
        // URL opened by "Help / usage guide". Defaults to the project README doc; override in props.
        HELP_DOC_URL: ConfigStore.get('HELP_DOC_URL', {
          preferUser: true,
          defaultValue: 'https://docs.google.com/document/d/18mk8sphXwC7bTRrDj09rnL4FNVuiBNS1oVeM3zuyUcg/edit'
        })
      },
      INTEGRATION: {
        ALERT_EMAIL: ConfigStore.get('ALERT_EMAIL', { preferUser: false, defaultValue: "" }),
        AI_MAX_PER_RUN: 10, // limit Gemini regenerations per execution
        PUBLISH_FOLDER_ID: ConfigStore.get('PUBLISH_FOLDER_ID', { preferUser: false, defaultValue: "" }), // shared Drive folder ID for shared docs
        // ***UPDATED*** Corpus Q&A: Drive folder of ADR .md files — the digest's DECISIONS why-layer. Empty = block degrades gracefully.
        DECISIONS_FOLDER_ID: ConfigStore.get('DECISIONS_FOLDER_ID', { preferUser: false, defaultValue: "" })
      },
      // ***UPDATED*** Corpus Q&A knobs. Runtime state (digest file id / fp / generated_at) lives in ConfigStore, not here.
      QA: {
        RECENT_CHANGES_DAYS: 14,   // CHANGE_LOG window folded into the digest
        DIGEST_MAX_CHARS: 700000   // estate-outgrew-v1 tripwire — the builder refuses, never truncates
      },
      VERBOSE: true
    };
  }
}

/**
 * @class
 * @classdesc Configuration store — thin seam over Toolkit.newConfigStore.
 *   The app passes its OWN property stores in (library code can't see them otherwise); the toolkit owns
 *   the precedence/clean logic. Lazily built so no code executes at load time.
 */
class ConfigStore {
  /** @private Lazy singleton, same idiom as Commands._registry_(). */
  static _store_() {
    if (!this.__store) {
      this.__store = Toolkit.newConfigStore({
        user: PropertiesService.getUserProperties(),
        script: PropertiesService.getScriptProperties()
      });
    }
    return this.__store;
  }

  static get(key, opts = {}) { return this._store_().get(key, opts); }
  static setUser(key, value) { return this._store_().setUser(key, value); }
  static setScript(key, value) { return this._store_().setScript(key, value); }
  static deleteUser(key) { return this._store_().deleteUser(key); }
  static deleteScript(key) { return this._store_().deleteScript(key); }
}
