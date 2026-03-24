/**
 * @file 099_Dev_Tools.gs
 * @description Development and testing utilities. Not part of the production webhook path.
 *
 * CHANGES FROM PREVIOUS VERSION:
 *  - RUN_diagnoseDataTableEndpoints: data table probe URLs now use
 *    'https://www.workato.com/api' (DATA_TABLES_BASE_URL) instead of
 *    config.API.BASE_URL. The regional URL (e.g. app.eu.workato.com) returns
 *    401 for data table endpoints regardless of token validity. Only the
 *    token identity probe (/api/users/me) continues to use the regional URL.
 *  - TEST_confirmToken: added alongside TEST_rawScriptProperty as the first
 *    diagnostic to run when troubleshooting auth issues.
 */

// Data table management endpoints always use www.workato.com regardless of
// data center. Defined here to mirror the constant in WorkatoClient and keep
// diagnostic probes consistent with production code.
const DATA_TABLES_BASE_URL = 'https://www.workato.com/api';

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
