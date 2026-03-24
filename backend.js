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

// --- ENVIRONMENT VALIDATION ------------------------------------------------
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

// --- ENTRY POINT -----------------------------------------------------------
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

// --- ROUTE: /initialize-workspace ------------------------------------------
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
    const {targetFolderId} = new ProvisioningRunner().run(ctx, payload.project_metadata.project_name);

    const templateProjectId  = Utilities.getUuid();
    const templateVersionId  = Utilities.getUuid();
    const supplierRequests   = _buildSupplierRequests_(payload.supplier_roster);

    _fireBootstrapWebhook_({
      ...payload,
      workspace_binding_id:    workspaceBindingId,
      templateProjectId:       templateProjectId,       // camelCase — schema expects this
      templateVersionId:       templateVersionId,       // camelCase — schema expects this
      init_manifest_hash:      manifest.manifest_hash,  // was computed, never forwarded
      recipe_bundle_version:   config.RECIPE_BUNDLE_VERSION,
      schema_contract_version: config.SCHEMA_CONTRACT_VERSION,
      target_folder_id:        targetFolderId,           // from provisioning result above
      supplier_roster:         supplierRequests,
      matrix_schema:           _enrichMatrixSchema_(payload.matrix_schema, templateVersionId)
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
  return (supplierRoster || []).map((s, index) => ({
    supplier_request_id:   Utilities.getUuid(),
    supplier_name:         s.supplier_name          || '',
    supplier_contact_name: s.supplier_contact_name  || '',  // see library fix below
    contact_email:         s.contact_email          || '',
    has_seeded_data:       Boolean(s.has_seeded_data),
    seeded_data_file_id:   s.seeded_data_file_id    || '',
    seeded_data_range:     s.seeded_data_range       || '',
    roster_index:          index
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

// --- ROUTE: /inject-seed-data ----------------------------------------------
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

// --- UTILITIES -------------------------------------------------------------
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
 * Injects template_version_id into all four matrix schema item arrays.
 * The templateVersionId UUID is only known at bootstrap time — it can't be
 * populated upstream in the library.
 * @private
 */
function _enrichMatrixSchema_(schema, templateVersionId) {
  if (!schema) return { fields: [], rules: [], lookups: [], error_translations: [] };
  const tvid = String(templateVersionId || '');
  const stamp = items => (items || []).map(item => ({ ...item, template_version_id: tvid }));

  return {
    fields:             stamp(schema.fields),
    rules:              stamp(schema.rules),
    lookups:            stamp(schema.lookups),
    error_translations: stamp(schema.error_translations)
  };
}      { row_number: 2, 'First Name': 'Jane', 'Start Date': '2024-02-15' }
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
 * Confirms the token is present and readable via SecretStore.
 * Run this first when troubleshooting 401s.
 */
function TEST_confirmToken() {
  const token   = SecretStore.getOptional('WORKATO_API_TOKEN', 'NOT_FOUND');
  const baseUrl = SecretStore.getOptional('WORKATO_BASE_URL',  'NOT_FOUND');
  Logger.log('TOKEN present: ' + (token && token !== 'NOT_FOUND' && token.length > 0));
  Logger.log('TOKEN length:  ' + (token ? token.length : 0));
  Logger.log('BASE_URL:      ' + baseUrl);
}

/**
 * Reads the Script Property directly, bypassing SecretStore.
 * Use to confirm the property is set at all.
 */
function TEST_rawScriptProperty() {
  const raw = PropertiesService.getScriptProperties().getProperty('WORKATO_API_TOKEN');
  Logger.log('Raw value is null: ' + (raw === null));
  Logger.log('Raw value length:  ' + (raw ? raw.length : 0));
}

/**
 * Runs schema drift detection via the command runner.
 * Requires a valid WORKATO_API_TOKEN in Script Properties.
 */
function TEST_RunDriftDetection() {
  const ctx = new AppContext();
  runCommand('diagnostics.detectDrift', {}, ctx);
}

/**
 * Probes data table schema endpoints and returns full response details.
 * Run from the Apps Script editor to diagnose auth / endpoint issues.
 *
 * FIXED: data table probes now use DATA_TABLES_BASE_URL ('https://www.workato.com/api')
 * instead of the regional BASE_URL. The regional URL returns 401 for data table
 * endpoints regardless of token validity.
 *
 * @param {string} [tableName] - Optional name for the by-name detail lookup.
 */
function RUN_diagnoseDataTableEndpoints(tableName) {
  const config     = AppConfig.get();
  const token      = config.API.TOKEN;
  const regionalUrl = config.API.BASE_URL;
  const targetName  = tableName || 'VER_TemplateVersion';
  const results     = [];

  function probe(label, url) {
    try {
      const response = UrlFetchApp.fetch(url, {
        method:             'get',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json'
        },
        muteHttpExceptions: true
      });

      const code   = response.getResponseCode();
      const body   = response.getContentText();
      let   parsed = null;
      try { parsed = JSON.parse(body); } catch (_) {}

      const summary = parsed
        ? (Array.isArray(parsed.data)  ? `data[]: ${parsed.data.length} items`
         : Array.isArray(parsed)       ? `array: ${parsed.length} items`
         : typeof parsed === 'object'  ? `keys: ${Object.keys(parsed).join(', ')}`
         : String(parsed))
        : body.slice(0, 300);

      results.push({ label, url, status: code, summary });
    } catch (e) {
      results.push({ label, url, status: 'EXCEPTION', summary: e.message });
    }
  }

  // --- Data table probes: must use DATA_TABLES_BASE_URL, not regional BASE_URL
  probe(
    'list data_tables (www.workato.com)',
    `${DATA_TABLES_BASE_URL}/data_tables`
  );
  probe(
    'list data_tables?per_page=5 (www.workato.com)',
    `${DATA_TABLES_BASE_URL}/data_tables?per_page=5`
  );

  // --- Detail probe: fetch list first to get a real ID
  try {
    const ctx       = new AppContext();
    const allTables = ctx.inventoryService.getDataTables();
    const match     = allTables.find(t => t.name === targetName) || allTables[0];

    if (match) {
      probe(
        `detail data_tables/${match.id} (www.workato.com — corrected)`,
        `${DATA_TABLES_BASE_URL}/data_tables/${match.id}`
      );
      // Confirm the old misspelled endpoint still fails so we know the fix matters
      probe(
        `detail data_dtables/${match.id} (www.workato.com — original typo, expect non-200)`,
        `${DATA_TABLES_BASE_URL}/data_dtables/${match.id}`
      );
    } else {
      results.push({ label: 'detail probe', url: 'n/a', status: 'SKIP', summary: 'No tables found in list response' });
    }
  } catch (e) {
    results.push({ label: 'detail probe setup', url: 'n/a', status: 'EXCEPTION', summary: e.message });
  }

  // --- Token identity: uses regional URL — this is correct for users/me
  probe(
    'token identity /api/users/me (regional URL)',
    `${regionalUrl}/users/me`
  );

  Logger.log('\n=== DATA TABLE ENDPOINT DIAGNOSTICS ===\n' + JSON.stringify(results, null, 2));
  return results;
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
      { supplier_request_id: 'uuid-supplier-1234', supplier_name: 'TechCorp',     supplier_contact_name: 'Firstname Lastname', contact_email: 'vendor@techcorp.com',     has_seeded_data: true, roster_index: 0 },
      { supplier_request_id: 'uuid-supplier-5678', supplier_name: 'SomeBusiness', supplier_contact_name: 'Firstname Lastname', contact_email: 'vendor@somebusiness.com', has_seeded_data: true, roster_index: 1 }
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
    event_type:            'template_generated',
    template_version_id:   'versionID',
    file_name:             'Acme Corp Q3 Intake_20240101_1200.xlsx',
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
// SCRIPT-EDITOR-FRIENDLY RUNNERS
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

  const report = {
    workspaceId:      cfg.workspaceId,
    managementBaseUrl: cfg.managementBaseUrl,
    recordsBaseUrl:   cfg.recordsBaseUrl,
    timestamp:        new Date().toISOString(),
    probes:           []
  };

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
  const result = {
    workspaceId:      cfg.workspaceId,
    discoveredCount:  rows.length,
    discoveredTables: rows.map(r => ({ id: r.id || '', name: r.name || '', folder_id: r.folder_id || '' }))
  };
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


/**
 * @file 006_PayloadBuilders.gs
 * @description Pure payload construction helpers for webhook and workflow contracts.
 *   All functions are stateless — they receive data and return an object.
 *   No sheet reads or service calls should live here.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - Added buildTemplateGeneratedPayload. The original called this function from
 *    runTemplateGeneration but never defined it — a hard ReferenceError at runtime.
 *    Shape inferred from sendMockTemplateRegistrationPayload in the dev tools and
 *    from the R-001a webhook spec.
 *  - Removed the first definition of buildSupplierOutreachPayload. It was silently
 *    overwritten by the second definition below. The first had no templateVersionId
 *    parameter and was dead code.
 *  - Added controlCenterId parameter to buildInitializeWorkspacePayload. The backend
 *    handler (handleInitializeWorkspace) requires control_center_id in the payload
 *    and throws without it. The spreadsheet ID is the natural control center ID —
 *    ss.getId() is passed by runWorkspaceInitialization.
 */

// --- PROJECT METADATA ------------------------------------------------------
/**
 * Builds normalized project metadata from customer sheet data.
 *
 * @param {Object} customerRaw
 * @param {string} fallbackEmail
 * @returns {{ project_name: string, target_vms: string, analyst_email: string, has_incumbent_data: boolean }}
 */
function buildProjectMetadata(customerRaw, fallbackEmail) {
  const safe = customerRaw || {};
  return {
    project_name:       safe['Customer name']      || 'Unknown Project',
    target_vms:         safe['Target VMS']         || 'Unknown VMS',
    analyst_email:      safe['Analyst email address'] || fallbackEmail || '',
    project_has_seeded_data: String(safe['Has incumbent data?']).toUpperCase() === 'TRUE',
    seeded_data_file_id: ''
  };
}

// --- WORKSPACE INITIALIZATION ----------------------------------------------
/**
 * Builds the supplier roster for workspace initialization.
 *
 * @param {Array<Object>} pendingSuppliers
 * @param {Function} [uuidFn]
 * @returns {Array<{ supplier_id: string, supplier_name: string, contact_email: string, has_seeded_data: boolean }>}
 */
function buildSupplierRoster(pendingSuppliers, uuidFn) {
  const makeUuid = uuidFn || getUUID;
  return (pendingSuppliers || []).map(s => ({
    supplier_id:           makeUuid(),
    supplier_name:         s.name,
    supplier_contact_name: s.contact_name       || '',  // see getPendingSuppliers fix
    contact_email:         s.email,
    has_seeded_data:       Boolean(s.has_seeded_data),
    seeded_data_file_id:   s.seed_data_location || ''   // existing field, remapped
  }));
}
/**
 * Builds the /initialize-workspace payload.
 *
 * CHANGED: Added controlCenterId parameter. The backend handler requires
 * control_center_id in the payload — the spreadsheet ID (ss.getId()) is the
 * natural value and should be passed by the calling orchestrator.
 *
 * @param {string} controlCenterId - The spreadsheet ID (ss.getId()).
 * @param {Object} customerRaw
 * @param {Array<Object>} pendingSuppliers
 * @param {Object} matrixSchema
 * @param {string} fallbackEmail
 * @param {Function} [uuidFn]
 * @returns {Object}
 */
function buildInitializeWorkspacePayload(controlCenterId, customerRaw, pendingSuppliers, matrixSchema, fallbackEmail, uuidFn) {
  return {
    control_center_id: String(controlCenterId || ''),
    project_metadata:  buildProjectMetadata(customerRaw, fallbackEmail),
    supplier_roster:   buildSupplierRoster(pendingSuppliers, uuidFn),
    matrix_schema:     matrixSchema || { fields: [], rules: [], lookups: [], error_translations: [] }
  };
}

// --- TEMPLATE GENERATION ----------------------------------------------------
/**
 * Builds the template-generated webhook payload (R-001a).
 *
 * ADDED: This function was called by runTemplateGeneration but was never defined
 * in the original codebase. Shape inferred from sendMockTemplateRegistrationPayload
 * and the R-001a webhook contract.
 *
 * @param {{ id: string, url: string, name: string }} savedFileData - From exportSheetToExcel.
 * @param {string} spreadsheetId - The control center spreadsheet ID.
 * @param {Object} customerData - From getCustomerData.
 * @param {string} versionId - The template version ID from runtime state.
 * @returns {Object}
 */
function buildTemplateGeneratedPayload(savedFileData, spreadsheetId, customerData, versionId) {
  return {
    event_type:            'template_generated',
    template_version_id:   String(versionId || ''),
    file_name:             savedFileData.name || '',
    google_drive_file_id:  savedFileData.id   || '',
    google_drive_file_url: savedFileData.url  || '',
    config_spreadsheet_id: String(spreadsheetId || ''),
    customer_info:         customerData || {},
    timestamp:             new Date().toISOString()
  };
}

// --- SUPPLIER OUTREACH -----------------------------------------------------
/**
 * Builds the supplier outreach webhook payload.
 * Optionally includes template_version_id when provided.
 *
 * NOTE: The first definition of this function (without templateVersionId) was
 * removed — it was dead code silently overwritten by this definition.
 *
 * @param {string} spreadsheetId
 * @param {Object} customerData
 * @param {Array<Object>} resolvedRequests - Suppliers with resolved supplier_request_id.
 * @param {string} [templateVersionId]
 * @returns {Object}
 */
function buildSupplierOutreachPayload(spreadsheetId, customerData, resolvedRequests, templateVersionId = '') {
  const requestsPayload = (resolvedRequests || []).map(s => ({
    supplier_request_id:    s.supplier_request_id,
    name:                   s.name,
    email:                  s.email,
    spreadsheet_row_number: s.spreadsheet_row_number,
    has_seeded_data:        Boolean(s.has_seeded_data),
    seed_data_location:     s.seed_data_location || ''
  }));

  const out = {
    config_spreadsheet_id: spreadsheetId,
    customer_info:         customerData || {},
    requests:              requestsPayload
  };

  if (String(templateVersionId || '').trim()) {
    out.template_version_id = String(templateVersionId).trim();
  }

  return out;
}

// --- SEED DATA INJECTION ---------------------------------------------------
/**
 * Flattens 2D sheet data into the row/field/value format expected by the
 * /inject-seed-data route.
 *
 * @param {string[]} headers
 * @param {Array<Array<*>>} dataRows
 * @returns {Array<{ row_number: number, field_name: string, submitted_value: string }>}
 */
function buildSeedDataRows(headers, dataRows) {
  const safeHeaders = headers  || [];
  const safeRows    = dataRows || [];
  const result      = [];

  safeRows
    .filter(row => row.some(cell => cell !== ''))
    .forEach((row, rowIndex) => {
      safeHeaders.forEach((header, colIndex) => {
        if (header) {
          result.push({
            row_number:      rowIndex + 1,
            field_name:      String(header).trim(),
            submitted_value: String(row[colIndex] ?? '').trim()
          });
        }
      });
    });

  return result;
}
/**
 * Builds the /inject-seed-data payload.
 *
 * @param {string} supplierRequestId
 * @param {string[]} headers
 * @param {Array<Array<*>>} dataRows
 * @returns {{ supplier_request_id: string, seed_data_payload: Array }}
 */
function buildInjectSeedDataPayload(supplierRequestId, headers, dataRows) {
  return {
    supplier_request_id: String(supplierRequestId || '').trim(),
    seed_data_payload:   buildSeedDataRows(headers, dataRows)
  };
}


/**
 * @file 003_RepoSpreadsheet.gs
 * @description Data Access Layer. All direct grid reads and writes go here.
 * @author emily.cabaniss@randstadsourceright.com
 *
 * CHANGES FROM ORIGINAL:
 *  - No logic changes.
 *  - Added NOTE comments on hardcoded sheet names in getMappedRules_ and
 *    getMappedErrors_ — these should be moved to _developer_settings to be
 *    consistent with all other sheet name references.
 *  - Minor formatting cleanup.
 */

// --- CUSTOMER DATA ---------------------------------------------------------
/**
 * Reads the customer info sheet and returns a key→value map.
 * Keys are column B values (question/label); values are column D (answer).
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function getCustomerData(ss) {
  const CONFIG = getAppConfig(ss);
  const sheet  = ss.getSheetByName(CONFIG.sheets.customer);
  if (!sheet) return {};

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  const data      = sheet.getRange(1, 2, lastRow, 3).getValues();
  const customerObj = {};

  data.forEach(row => {
    const key   = String(row[0]).trim();
    const value = row[2];
    if (key && !key.startsWith('1.') && !key.startsWith('1A.') && !key.startsWith('1B.') && !key.startsWith('1C.')) {
      customerObj[key] = value;
    }
  });

  return customerObj;
}

// --- FIELD MATRIX ----------------------------------------------------------
/**
 * Reads the field matrix sheet and returns structured field definitions.
 * Used by runTemplateGeneration to build the template column headers and validations.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Array<Object>}
 */
function getFieldMatrix(ss) {
  const CONFIG         = getAppConfig(ss);
  const matrixSheetName = CONFIG.sheets.fieldMatrix1 || CONFIG.sheets.fieldMatrix;
  const sheet          = ss.getSheetByName(matrixSheetName);
  if (!sheet) throw new Error(`Matrix sheet not found: ${matrixSheetName}`);

  const lastRow  = sheet.getLastRow();
  const startRow = CONFIG.ui.matrixDataStart || 9;
  if (lastRow < startRow) return [];

  const data = sheet.getRange(startRow, 1, lastRow - (startRow - 1), 13).getValues();
  return data.filter(row => row[0]).map(row => ({
    fieldName:      row[0],
    description:    row[1],
    isRequired:     String(row[2]).toUpperCase() === 'TRUE',
    dataType:       String(row[5]).toLowerCase(),
    standardFormat: row[6],
    lookupName:     row[7],
    isUnique:       String(row[4]).toUpperCase() === 'TRUE'
  }));
}

// --- LOOKUPS ---------------------------------------------------------------
/**
 * Clears and rebuilds the hidden lookup sheet used for dropdown data validations.
 * Each column corresponds to one named lookup table.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function rebuildHiddenLookups(ss) {
  const CONFIG      = getAppConfig(ss);
  let   hiddenSheet = ss.getSheetByName(CONFIG.sheets.hiddenLookups);
  if (!hiddenSheet) hiddenSheet = ss.insertSheet(CONFIG.sheets.hiddenLookups);
  hiddenSheet.clear().hideSheet();

  const lookupDataSheet = ss.getSheetByName(CONFIG.sheets.lookupTables);
  if (!lookupDataSheet) return;

  const data      = lookupDataSheet.getDataRange().getValues();
  const lookupDict = {};

  for (let i = 1; i < data.length; i++) {
    const [tableName, value, , isActive] = data[i];
    if (String(isActive).toUpperCase() === 'TRUE' && tableName && value) {
      if (!lookupDict[tableName]) lookupDict[tableName] = [];
      lookupDict[tableName].push([value]);
    }
  }

  let col = 1;
  for (const [name, vals] of Object.entries(lookupDict)) {
    hiddenSheet.getRange(1, col).setValue(name);
    hiddenSheet.getRange(2, col, vals.length, 1).setValues(vals);
    col++;
  }
}

// --- SUPPLIERS -------------------------------------------------------------
/**
 * Reads the supplier sheet and returns rows where status is empty (pending).
 * Also returns the full allStatuses array for efficient batch write-back.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {{ pendingSuppliers: Array, allStatuses: Array, startRow: number, statusColIndex: number }}
 */
function getPendingSuppliers(ss) {
  const CONFIG = getAppConfig(ss);
  const sheet  = ss.getSheetByName(CONFIG.sheets.suppliers);
  if (!sheet) throw new Error(`Sheet "${CONFIG.sheets.suppliers}" not found.`);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const startRow = CONFIG.webhook.dataStartRow;

  if (lastRow < startRow) {
    return { pendingSuppliers: [], allStatuses: [], startRow, statusColIndex: -1 };
  }

  const dataRows = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
  const headers  = sheet.getRange(CONFIG.webhook.headerRow, 1, 1, lastCol).getValues()[0];

  const statusIndex      = headers.indexOf(CONFIG.webhook.statusColumnName);
  const supplierIndex    = headers.indexOf('Supplier');
  const contactNameIndex = headers.indexOf('Contact name');
  const emailIndex       = headers.indexOf('Contact email');
  const seededFlagIndex  = headers.indexOf('Has seeded data?');
  const seedLocationIndex = headers.indexOf('Location of seed data');

  if (statusIndex === -1 || supplierIndex === -1 || emailIndex === -1) {
    throw new Error('Required columns (Supplier, Contact email, or Status) not found.');
  }

  const pendingSuppliers = [];
  const allStatuses      = [];

  dataRows.forEach((row, index) => {
    const rowNum       = startRow + index;
    const supplierName = String(row[supplierIndex]).trim();
    const contactName  = String(row[contactName]).trim();
    const email        = String(row[emailIndex]).trim();
    const currentStatus = String(row[statusIndex]).trim();
    const hasSeededData = seededFlagIndex !== -1 ? String(row[seededFlagIndex]).toUpperCase() === 'TRUE' : false;
    const seedLocation  = seedLocationIndex !== -1 ? String(row[seedLocationIndex]).trim() : '';

    if (supplierName && email && currentStatus === '') {
      pendingSuppliers.push({
        name:                   supplierName,
        contact_name:           contactName,
        email:                  email,
        spreadsheet_row_number: rowNum,
        has_seeded_data:        hasSeededData,
        seed_data_location:     seedLocation,
        arrayIndex:             index
      });
      allStatuses.push(['']);
    } else {
      allStatuses.push([currentStatus]);
    }
  });

  return {
    pendingSuppliers,
    allStatuses,
    startRow,
    statusColIndex: statusIndex + 1  // +1: getRange uses 1-based indexing
  };
}
/**
 * Writes a 2D status array back to the supplier sheet in a single batch operation.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<Array<string>>} statusUpdates
 * @param {number} startRow
 * @param {number} statusColIndex
 */
function updateSupplierStatuses(ss, statusUpdates, startRow, statusColIndex) {
  const CONFIG = getAppConfig(ss);
  const sheet  = ss.getSheetByName(CONFIG.sheets.suppliers);
  if (!sheet) throw new Error(`Sheet "${CONFIG.sheets.suppliers}" not found.`);
  if (statusUpdates.length > 0) {
    sheet.getRange(startRow, statusColIndex, statusUpdates.length, 1).setValues(statusUpdates);
  }
}

// --- MATRIX SCHEMA ---------------------------------------------------------
/**
 * Compiles the full matrix schema from all four source sheets.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {{ fields: Array, rules: Array, lookups: Array, error_translations: Array }}
 */
function getFullMatrixSchema(ss) {
  const CONFIG = getAppConfig(ss);
  const fields = getMappedFields_(ss, CONFIG);

  // Build name -> field_id map for rule cross-referencing.
  const fieldIdByName = fields.reduc((acc, f) => {
    acc[f.field_name] = f.field_id;
    return acc;
  }, {});

  return {
    fields,
    rules:              getMappedRules_(ss, CONFIG, fieldIdByName),
    lookups:            getMappedLookups_(ss, CONFIG),
    error_translations: getMappedErrors_(ss, CONFIG)
  };
}

// --- Private schema parsers -------------------------------------------------
/** @private */
function getMappedFields_(ss, CONFIG) {
  const sheet = ss.getSheetByName(CONFIG.sheets.fieldMatrix2 || '3_field_matrix_v2');
  if (!sheet) return [];

  const data = sheet.getRange(9, 1, sheet.getLastRow() - 8, 13).getValues();
  return data.filter(row => row[0]).map((row, index) => ({
    field_id:            `field_${getUUID()}`,   // renamed: schema expects field_id
    field_name:          String(row[0]).trim(),
    description:         String(row[1]).trim(),
    required:            String(row[2]).toUpperCase() === 'TRUE',
    must_be_empty:       String(row[3]).toUpperCase() === 'TRUE',
    column_unique:       String(row[4]).toUpperCase() === 'TRUE',
    data_type:           String(row[5]).toLowerCase(),
    lookup_name:         String(row[7]).trim(),   // col 7 already in getFieldMatrix, was dropped here
    data_cleaning_flags: String(row[10]).trim(),
    strict_enforcement:  String(row[11]).toUpperCase() === 'TRUE',  // ⚠️ confirm column index
    position:            index + 1
  }));
}
/** @private */
function getMappedRules_(ss, CONFIG, fieldIdByName = {}) {
  const sheet = ss.getSheetByName('4_rule_matrix');
  if (!sheet) return [];

  const lastRow    = sheet.getLastRow();
  if (lastRow < 9) return [];

  const numRows    = lastRow - 8;
  const numCols    = 10;  // 9 existing + 1 for rule UUID
  const data       = sheet.getRange(9, 1, numRows, numCols).getValues();
  const uuidColIdx = 9;   // 0-based, column 10 in the sheet

  const rules      = [];
  const uuidWrites = []; // collect writes, flush once after the loop

  data.forEach((row, i) => {
    if (!row[0]) return; // skip blank rows

    // Resolve or generate the rule UUID
    let ruleId = String(row[uuidColIdx] || '').trim();
    if (!ruleId) {
      ruleId = `rule_${getUUID()}`;
      uuidWrites.push({ rowOffset: i, uuid: ruleId });
    }

    // Resolve field name strings to UUIDs via the map.
    // Fall back to the raw string so a bad lookup is visible in the payload
    // rather than silently becoming an empty field_id.
    const fieldId      = fieldIdByName[String(row[0]).trim()] || String(row[0]).trim();
    const conditionField = String(row[2]).trim()
      ? (fieldIdByName[String(row[2]).trim()] || String(row[2]).trim())
      : '';

    rules.push({
      rule_id:            ruleId,
      field_id:           fieldId,
      rule_type:          String(row[1]).trim(),
      condition_field:    conditionField,
      condition_operator: String(row[3]).trim(),
      condition_value:    String(row[4]).trim(),
      parameter_1:        String(row[5]).trim(),
      parameter_2:        String(row[6]).trim(),
      error_message:      String(row[7]).trim(),
      strict_enforcement: String(row[8]).toUpperCase() !== 'FALSE'
    });
  });

  // Write back any newly generated UUIDs in one pass
  if (uuidWrites.length > 0) {
    uuidWrites.forEach(({ rowOffset, uuid }) => {
      sheet.getRange(9 + rowOffset, uuidColIdx + 1).setValue(uuid); // getRange is 1-based
    });
    SpreadsheetApp.flush();
  }

  return rules;
}
/** @private */
function getMappedLookups_(ss, CONFIG) {
  const sheet = ss.getSheetByName(CONFIG.sheets.lookupTables);
  if (!sheet) return [];

  const data       = sheet.getDataRange().getValues();
  const lookupDict = {};

  for (let i = 1; i < data.length; i++) {
    const [tableName, value, , isActive] = data[i];
    if (String(isActive).toUpperCase() === 'TRUE' && tableName && value) {
      if (!lookupDict[tableName]) lookupDict[tableName] = [];
      lookupDict[tableName].push(String(value).trim());
    }
  }

  return Object.entries(lookupDict).map(([name, vals]) => ({
    lookup_id:           `lookup_${getUUID()}`,
    lookup_name:  name,
    valid_values: JSON.stringify(vals)
  }));
}
/** @private */
function getMappedErrors_(ss, CONFIG) {
  // NOTE: Sheet name '_error_translation' is hardcoded here.
  // Should be moved to CONFIG.sheets.errorTranslation in _developer_settings.
  const sheet = ss.getSheetByName('_error_translation');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  return data.filter((row, i) => i > 0 && row[0]).map(row => ({
    error_translation_id:   `err_${getUUID()}`,
    sql_error_code:         String(row[0]).trim(),
    human_readable_message: String(row[2]).trim()
  }));
}
