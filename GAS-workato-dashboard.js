// ─── Config ────────────────────────────────────────────────
const API_BASE = 'https://apim.workato.com/your-domain/data-tables/v1';  // verify your endpoint
const TABLE_IDS = {
  home_requests: 'xxxx-xxxx-xxxx-xxxx',      // HOME_Requests
  ver_template_version: 'xxxx-xxxx-...',     // VER_TemplateVersion
  wfa_supplier_request: 'xxxx-xxxx-...',     // WFA_SupplierRequest
  wfa_template_project: 'xxxx-xxxx-...',     // WFA_TemplateProject
};
const TAB_NAMES = {
  requests: 'Requests',
  versions: 'Published Versions',
  suppliers: 'Suppliers',
  failures: 'Recent Failures',
};

// ─── Entry point (called by time-based trigger) ────────────
function refreshMonitor() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('WORKATO_API_KEY');
  if (!apiKey) {
    throw new Error('WORKATO_API_KEY not set in Script Properties');
  }
  
  // Fetch once, use everywhere
  const requests = fetchTable_(TABLE_IDS.home_requests, apiKey, {limit: 50, order: 'created_at desc'});
  const versions = fetchTable_(TABLE_IDS.ver_template_version, apiKey, {limit: 100});
  const suppliers = fetchTable_(TABLE_IDS.wfa_supplier_request, apiKey, {limit: 500});
  const projects = fetchTable_(TABLE_IDS.wfa_template_project, apiKey, {limit: 100});
  
  // Build project_id -> client_name lookup
  const projectToClient = {};
  projects.forEach(p => {
    if (p.template_project_id) {
      projectToClient[p.template_project_id] = p.client_name || '?';
    }
  });
  
  // Render each tab
  writeGrid_(TAB_NAMES.requests, buildRequestsGrid_(requests));
  writeGrid_(TAB_NAMES.versions, buildVersionsGrid_(versions, projectToClient));
  writeGrid_(TAB_NAMES.suppliers, buildSuppliersGrid_(suppliers, projectToClient));
  writeGrid_(TAB_NAMES.failures, buildFailuresGrid_(requests));
}

// ─── API call ──────────────────────────────────────────────
function fetchTable_(tableId, apiKey, opts) {
  const url = `${API_BASE}/tables/${tableId}/records?limit=${opts.limit || 100}`;
  const response = UrlFetchApp.fetch(url, {
    headers: {Authorization: `Bearer ${apiKey}`},
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    console.error(`Failed to fetch ${tableId}: ${response.getContentText()}`);
    return [];
  }
  const body = JSON.parse(response.getContentText());
  return body.records || body.data || [];  // depends on actual API shape
}

// ─── Grid builders ─────────────────────────────────────────
function buildRequestsGrid_(requests) {
  const rows = [['When', 'Client', 'Status', 'Error', 'Correlation ID', 'Analyst', 'Config file']];
  requests.forEach(r => {
    rows.push([
      fmtTs_(r.created_at),
      r.client_name || '',
      r.status || '',
      (r.error_message || '').substring(0, 200),
      r.correlation_id || '',
      r.analyst_email || '',
      r.config_drive_file_id || '',
    ]);
  });
  return rows;
}

function buildVersionsGrid_(versions, projectToClient) {
  const rows = [['Client', 'Version', 'Status', 'Published', 'Project ID']];
  versions.forEach(v => {
    rows.push([
      projectToClient[v.template_project_id] || '?',
      v.version_number || '',
      v.status || '',
      fmtTs_(v.published_at),
      v.template_project_id || '',
    ]);
  });
  return rows;
}

function buildSuppliersGrid_(suppliers, projectToClient) {
  const rows = [['Client', 'Supplier', 'Status', 'Version', 'Updated']];
  suppliers.forEach(s => {
    rows.push([
      projectToClient[s.template_project_id] || '?',
      s.supplier_name || '',
      s.status || '',
      (s.assigned_version_id || '').substring(0, 8),
      fmtTs_(s.updated_at),
    ]);
  });
  return rows;
}

function buildFailuresGrid_(requests) {
  const rows = [['When', 'Client', 'Status', 'Error', 'Correlation ID']];
  const now = new Date();
  requests.forEach(r => {
    if (r.status === 'FAILED') {
      rows.push([
        fmtTs_(r.created_at),
        r.client_name || '',
        'FAILED',
        (r.error_message || '').substring(0, 300),
        r.correlation_id || '',
      ]);
    } else if (r.status === 'PROVISIONING' && r.created_at) {
      const age = (now - new Date(r.created_at)) / 1000;
      if (age > 600) {
        rows.push([
          fmtTs_(r.created_at),
          r.client_name || '',
          'STUCK? (>10min)',
          '',
          r.correlation_id || '',
        ]);
      }
    }
  });
  return rows;
}

// ─── Sheet writer ──────────────────────────────────────────
function writeGrid_(tabName, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    console.error(`Tab not found: ${tabName}`);
    return;
  }
  // Clear existing content below headers (or all, since we write headers too)
  sheet.clearContents();
  // Write the full grid
  if (rows.length > 0) {
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

// ─── Helpers ───────────────────────────────────────────────
function fmtTs_(ts) {
  if (!ts) return '';
  return ts.substring(0, 16).replace('T', ' ');
}
