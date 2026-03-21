Paste these into CoreLib.

### New helper functions

Paste into `005_RuntimeState.gs`, near the other runtime-state helpers. Current `_runtime_state` keys and initialize behavior are in the existing runtime helpers and `runWorkspaceInitialization(ss)`. 

```javascript
/**
 * Returns the current initialize-binding snapshot from _runtime_state.
 * Mirror only; used for initialize preflight refusal.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function getInitializeBindingSnapshot(ss) {
  return {
    workspace_binding_id: String(getRuntimeState(ss, 'workspace_binding_id', '') || '').trim(),
    assigned_workspace: String(getRuntimeState(ss, 'assigned_workspace', '') || '').trim(),
    template_project_id: String(getRuntimeState(ss, 'template_project_id', '') || '').trim(),
    template_version_id: String(getRuntimeState(ss, 'template_version_id', '') || '').trim(),
    supplier_request_map_json: String(getRuntimeState(ss, SUPPLIER_REQUEST_MAP_KEY, '') || '').trim()
  };
}

/**
 * Refuses initialize if the control center already appears initialized or partially bound.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object}
 */
function assertInitializeAllowed(ss) {
  const snapshot = getInitializeBindingSnapshot(ss);

  if (
    snapshot.workspace_binding_id ||
    snapshot.assigned_workspace ||
    snapshot.template_project_id ||
    snapshot.template_version_id ||
    snapshot.supplier_request_map_json
  ) {
    throw new Error('Initialize refused: control center already initialized or partially bound');
  }

  return snapshot;
}
```

### Modified `persistWorkflowIdentifiers`

Replace the existing function in `005_RuntimeState.gs`. The current version allows legacy keys including `current_template_version_id`; this version does not. 

```javascript
/**
 * Persists a controlled set of workflow/runtime identifiers.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Object} identifiers
 * @param {string} [sourceLabel]
 * @returns {Object} The normalized identifiers that were actually persisted.
 */
function persistWorkflowIdentifiers(ss, identifiers, sourceLabel = 'unknown') {
  const safeIdentifiers = identifiers || {};
  const normalized = {};
  const allowedKeys = [
    'workspace_binding_id',
    'template_project_id',
    'template_version_id',
    'assigned_workspace',
    'target_folder_id',
    'manifest_hash',
    'recipe_bundle_version',
    'workspace_initialized_at'
  ];

  allowedKeys.forEach(key => {
    const value = safeIdentifiers[key];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      normalized[key] = String(value).trim();
    }
  });

  if (Object.keys(normalized).length === 0) {
    return {};
  }

  normalized.last_identifier_sync_at = new Date().toISOString();
  normalized.last_identifier_sync_source = sourceLabel;

  setRuntimeStates(ss, normalized);
  return normalized;
}
```

### Modified `persistSupplierRequestMappings`

Replace the existing function in `005_RuntimeState.gs`. Current behavior merges; this version supports full replacement. 

```javascript
/**
 * Persists supplier request IDs returned by backend, keyed by spreadsheet row and email.
 * Assumes supplierRequestsFromBackend aligns to pendingSuppliers by roster_index / array order.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<Object>} pendingSuppliers
 * @param {Array<Object>} supplierRequestsFromBackend
 * @param {{replaceExisting?: boolean}} [options]
 * @returns {{by_row_number:Object, by_email:Object, items:Array}}
 */
function persistSupplierRequestMappings(ss, pendingSuppliers, supplierRequestsFromBackend, options = {}) {
  const replaceExisting = options.replaceExisting === true;
  const current = replaceExisting
    ? { by_row_number: {}, by_email: {}, items: [] }
    : getSupplierRequestMap(ss);

  const byRow = Object.assign({}, current.by_row_number || {});
  const byEmail = Object.assign({}, current.by_email || {});
  const items = Array.isArray(current.items) ? current.items.slice() : [];

  const roster = Array.isArray(supplierRequestsFromBackend) ? supplierRequestsFromBackend : [];
  const pending = Array.isArray(pendingSuppliers) ? pendingSuppliers : [];

  roster.forEach((backendItem, index) => {
    const rosterIndex = backendItem && backendItem.roster_index !== undefined
      ? Number(backendItem.roster_index)
      : index;

    const pendingSupplier = pending[rosterIndex];
    if (!pendingSupplier) return;

    const supplierRequestId = String(backendItem.supplier_request_id || '').trim();
    if (!supplierRequestId) return;

    const rowKey = String(pendingSupplier.spreadsheet_row_number || '').trim();
    const emailKey = String(
      pendingSupplier.email || backendItem.contact_email || ''
    ).trim().toLowerCase();

    const item = {
      supplier_request_id: supplierRequestId,
      supplier_name: backendItem.supplier_name || pendingSupplier.name || '',
      contact_email: backendItem.contact_email || pendingSupplier.email || '',
      spreadsheet_row_number: pendingSupplier.spreadsheet_row_number || '',
      roster_index: rosterIndex
    };

    if (rowKey) byRow[rowKey] = item;
    if (emailKey) byEmail[emailKey] = item;
    items.push(item);
  });

  const out = {
    by_row_number: byRow,
    by_email: byEmail,
    items: items
  };

  setSupplierRequestMap(ss, out);
  return out;
}
```

### Modified `buildInitializeWorkspacePayload`

Replace the existing function in `006_PayloadBuilders.gs`. Current payload only includes `project_metadata`, `supplier_roster`, and `matrix_schema`; this adds the three required initialize contract fields without changing roster/schema construction. 

```javascript
/**
 * Builds the initialize-workspace payload.
 * @param {Object} customerRaw
 * @param {Array<Object>} pendingSuppliers
 * @param {Object} matrixSchema
 * @param {string} fallbackEmail
 * @param {Function} [uuidFn]
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss]
 * @returns {Object}
 */
function buildInitializeWorkspacePayload(customerRaw, pendingSuppliers, matrixSchema, fallbackEmail, uuidFn, ss) {
  if (!ss) throw new Error('Critical: Spreadsheet context (ss) not passed to buildInitializeWorkspacePayload.');

  return {
    control_center_id: `cc_${ss.getId()}`,
    recipe_bundle_version: 'mvp-1',
    schema_contract_version: '2026-03-21',
    project_metadata: buildProjectMetadata(customerRaw, fallbackEmail),
    supplier_roster: buildSupplierRoster(pendingSuppliers, uuidFn),
    matrix_schema: matrixSchema || {
      fields: [],
      rules: [],
      lookups: [],
      error_translations: []
    }
  };
}
```

### Modified `runWorkspaceInitialization`

Replace the existing function in `004_Services.gs`. Current implementation writes legacy mirror fields and merges supplier mappings after initialize; this version acquires a document lock, preflights, persists mirror-only fields, and replaces supplier mappings.  

```javascript
/**
 * Gathers all configurations and sends the initialization payload to Workato/backend.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function runWorkspaceInitialization(ss) {
  const CONFIG = getAppConfig(ss);
  const lock = LockService.getDocumentLock();

  if (!lock.tryLock(30000)) {
    throw new Error('Initialization is already in progress. Please try again in a moment.');
  }

  try {
    assertInitializeAllowed(ss);
    writeLog('INFO', 'Gathering data for Workspace Initialization...', ss);

    const customerRaw = getCustomerData(ss);
    const fallbackEmail = Session.getActiveUser().getEmail();
    const projectMetadata = buildProjectMetadata(customerRaw, fallbackEmail);

    try {
      const scriptId = ScriptApp.getScriptId();
      const newScriptName = `Control Center - ${projectMetadata.project_name}`;
      renameBoundScript(scriptId, newScriptName);
      writeLog('INFO', `Dynamically renamed script project to: ${newScriptName}`, ss);
    } catch (renameErr) {
      writeLog('WARNING', `Could not rename script project: ${renameErr.message}`, ss);
    }

    const pendingSuppliers = getPendingSuppliers(ss).pendingSuppliers;
    const matrixSchema = getFullMatrixSchema(ss);

    const payload = buildInitializeWorkspacePayload(
      customerRaw,
      pendingSuppliers,
      matrixSchema,
      fallbackEmail,
      getUUID,
      ss
    );

    const webhookUrl = CONFIG.webhook.initializeWorkspaceUrl;
    if (!webhookUrl) throw new Error("Missing 'initializeWorkspaceUrl' in _developer_settings tab.");

    writeLog('INFO', 'Sending payload to provisioning webhook...', ss);
    const response = sendInitializeWorkspaceWebhook(payload, webhookUrl);
    const body = response && response.body ? response.body : {};

    const persisted = persistWorkflowIdentifiers(
      ss,
      {
        workspace_binding_id: body.workspace_binding_id || '',
        template_project_id: body.template_project_id || '',
        template_version_id: body.template_version_id || '',
        assigned_workspace: body.assigned_workspace || '',
        target_folder_id: body.target_folder_id || body._debug_folder_id || '',
        manifest_hash: body.manifest_hash || '',
        recipe_bundle_version: body.recipe_bundle_version || payload.recipe_bundle_version,
        workspace_initialized_at: body.workspace_initialized_at || new Date().toISOString()
      },
      'initialize_workspace_response'
    );

    let persistedSupplierCount = 0;
    if (Array.isArray(body.supplier_requests) && body.supplier_requests.length > 0) {
      const supplierMap = persistSupplierRequestMappings(
        ss,
        pendingSuppliers,
        body.supplier_requests,
        { replaceExisting: true }
      );
      persistedSupplierCount = Array.isArray(supplierMap.items) ? supplierMap.items.length : 0;
      writeLog('INFO', `Persisted ${persistedSupplierCount} supplier request mappings to runtime state.`, ss);
    } else {
      persistSupplierRequestMappings(ss, [], [], { replaceExisting: true });
      writeLog('WARNING', 'No supplier request mappings were returned by backend initialize response.', ss);
    }

    writeLog(
      'SUCCESS',
      `Workspace initialized successfully. Template Project ID: ${persisted.template_project_id || 'Unknown'} | Template Version ID: ${persisted.template_version_id || 'Unknown'} | Workspace: ${persisted.assigned_workspace || 'Unknown'}`,
      ss
    );

    SpreadsheetApp.getUi().alert(
      'Workspace Initialized!',
      `Data loaded successfully.\n\nTemplate Project ID: ${persisted.template_project_id || 'Unknown'}\nTemplate Version ID: ${persisted.template_version_id || 'Unknown'}\nAssigned Workspace: ${persisted.assigned_workspace || 'Unknown'}\nSupplier Requests Stored: ${persistedSupplierCount}`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );

  } catch (error) {
    writeLog('ERROR', `Workspace Initialization Failed: ${error.toString()}`, ss);
    SpreadsheetApp.getUi().alert('Initialization Error:\n\n' + error.toString());
  } finally {
    lock.releaseLock();
  }
}
```

### Short notes

Paste order:

1. `005_RuntimeState.gs`: add `getInitializeBindingSnapshot`, `assertInitializeAllowed`, then replace `persistWorkflowIdentifiers` and `persistSupplierRequestMappings`.
2. `006_PayloadBuilders.gs`: replace `buildInitializeWorkspacePayload`.
3. `004_Services.gs`: replace `runWorkspaceInitialization`.

These changes are aligned to the current CoreLib initialize flow and runtime-state structure.  
