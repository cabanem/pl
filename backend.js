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

/**
 * Probes data table schema endpoints and returns full response details.
 * Run this from the Apps Script editor to diagnose 401/404/endpoint issues.
 * 
 * @param {string} [tableName] - Optional: also attempt a by-name lookup.
 */
function RUN_diagnoseDataTableEndpoints(tableName) {
  const ctx        = new AppContext();
  const config     = AppConfig.get();
  const baseUrl    = config.API.BASE_URL;
  const token      = config.API.TOKEN;
  const targetName = tableName || 'VER_TemplateVersion';

  const results = [];

  // Helper: raw fetch with full response detail
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

      const code = response.getResponseCode();
      let   body = response.getContentText();
      let   parsed = null;

      try { parsed = JSON.parse(body); } catch (_) {}

      // Summarize rather than dump entire payload
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

  // --- Probe 1: list all tables (the path getDataTables uses)
  probe('list /api/data_tables',
    `${baseUrl}/data_tables`);

  // --- Probe 2: list with explicit per_page
  probe('list /api/data_tables?per_page=5',
    `${baseUrl}/data_tables?per_page=5`);

  // --- Probe 3: detail by ID — need a real ID, so fetch list first
  try {
    const allTables = ctx.inventoryService.getDataTables();
    const match     = allTables.find(t => t.name === targetName) || allTables[0];

    if (match) {
      // Probe the corrected endpoint (data_tables, not data_dtables)
      probe(`detail /api/data_tables/${match.id} (corrected)`,
        `${baseUrl}/data_tables/${match.id}`);

      // Probe the original misspelled endpoint so we can confirm the difference
      probe(`detail /api/data_dtables/${match.id} (original — expected to fail)`,
        `${baseUrl}/data_dtables/${match.id}`);
    } else {
      results.push({ label: 'detail probe', url: 'n/a', status: 'SKIP', summary: 'No tables found in list response' });
    }
  } catch (e) {
    results.push({ label: 'detail probe setup', url: 'n/a', status: 'EXCEPTION', summary: e.message });
  }

  // --- Probe 4: confirm token identity
  try {
    const me = ctx.inventoryService.getCurrentUser();
    results.push({
      label:   'token identity /api/users/me',
      url:     `${baseUrl}/users/me`,
      status:  me ? 200 : 'null response',
      summary: me ? `id: ${me.id}, email: ${me.email || me.name || '(no email in response)'}` : 'null'
    });
  } catch (e) {
    results.push({ label: 'token identity', url: 'n/a', status: 'EXCEPTION', summary: e.message });
  }

  Logger.log('\n=== DATA TABLE ENDPOINT DIAGNOSTICS ===\n' + JSON.stringify(results, null, 2));
  return results;
}
