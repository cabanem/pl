Below is exactly what you asked for: **drop-in backend code** with minimal intrusion, aligned to your current architecture (no redesign, just guardrails + registry + idempotency).

---

# 1. New Helper Classes

## 1A. ManifestService

```javascript
class ManifestService {
  static buildCanonicalInitializeManifest(payload) {
    if (!payload) throw new Error("Missing payload for manifest");

    const canonical = {
      project_metadata: this._normalizeObject(payload.project_metadata),
      supplier_roster: this._normalizeSupplierRoster(payload.supplier_roster),
      matrix_schema: this._normalizeObject(payload.matrix_schema)
    };

    const canonicalJson = JSON.stringify(canonical);
    const manifestHash = this._sha256(canonicalJson);

    return {
      canonical_json: canonicalJson,
      manifest_hash: manifestHash
    };
  }

  static _normalizeSupplierRoster(roster = []) {
    return (roster || [])
      .map(s => ({
        supplier_name: String(s.supplier_name || "").trim(),
        contact_email: String(s.contact_email || "").trim().toLowerCase(),
        has_seeded_data: !!s.has_seeded_data
      }))
      .sort((a, b) => a.contact_email.localeCompare(b.contact_email));
  }

  static _normalizeObject(obj) {
    if (!obj) return {};
    return JSON.parse(JSON.stringify(obj)); // deep clone, removes undefined
  }

  static _sha256(str) {
    const raw = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      str,
      Utilities.Charset.UTF_8
    );
    return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  }
}
```

---

## 1B. RegistryService

```javascript
class RegistryService {
  static adminId() {
    const id = PropertiesService.getScriptProperties().getProperty('ADMIN_REGISTRY_ID');
    if (!id) throw new Error("Missing ADMIN_REGISTRY_ID");
    return id;
  }

  static ss() {
    return SpreadsheetApp.openById(this.adminId());
  }

  static ensureTabs() {
    this._ensureSheet('Workspace_Registry', [
      'workspace_binding_id','control_center_id','client_name','workspace_name',
      'workspace_status','recipe_bundle_version','schema_contract_version',
      'active_bootstrap_id','current_template_project_id','current_template_version_id',
      'initialized_at','last_error','created_at','updated_at'
    ]);

    this._ensureSheet('Bootstrap_Ledger', [
      'bootstrap_id','workspace_binding_id','control_center_id','init_manifest_hash',
      'bootstrap_status','idempotency_decision','recipe_bundle_version','schema_contract_version',
      'template_project_id','template_version_id','supplier_count',
      'started_at','completed_at','error_message'
    ]);

    this._ensureSheet('Manifest_Registry', [
      'manifest_hash','canonical_json','created_at'
    ]);
  }

  static _ensureSheet(name, headers) {
    const ss = this.ss();
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
    }
  }

  static findWorkspaceByControlCenter(controlCenterId) {
    const sheet = this.ss().getSheetByName('Workspace_Registry');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const idx = headers.indexOf('control_center_id');

    for (let i = 1; i < data.length; i++) {
      if (data[i][idx] === controlCenterId) {
        return this._rowToObj(headers, data[i]);
      }
    }
    return null;
  }

  static findSuccessfulBootstrap(bindingId) {
    const sheet = this.ss().getSheetByName('Bootstrap_Ledger');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const bIdx = headers.indexOf('workspace_binding_id');
    const statusIdx = headers.indexOf('bootstrap_status');

    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][bIdx] === bindingId && data[i][statusIdx] === 'SUCCESS') {
        return this._rowToObj(headers, data[i]);
      }
    }
    return null;
  }

  static insertWorkspace(row) {
    this._append('Workspace_Registry', row);
  }

  static updateWorkspace(bindingId, patch) {
    this._update('Workspace_Registry', 'workspace_binding_id', bindingId, patch);
  }

  static insertBootstrap(row) {
    this._append('Bootstrap_Ledger', row);
  }

  static updateBootstrap(bootstrapId, patch) {
    this._update('Bootstrap_Ledger', 'bootstrap_id', bootstrapId, patch);
  }

  static insertManifest(row) {
    this._append('Manifest_Registry', row);
  }

  static _append(sheetName, obj) {
    const sheet = this.ss().getSheetByName(sheetName);
    const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
    const row = headers.map(h => obj[h] || '');
    sheet.appendRow(row);
  }

  static _update(sheetName, keyCol, keyVal, patch) {
    const sheet = this.ss().getSheetByName(sheetName);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const keyIdx = headers.indexOf(keyCol);

    for (let i = 1; i < data.length; i++) {
      if (data[i][keyIdx] === keyVal) {
        headers.forEach((h, j) => {
          if (patch[h] !== undefined) {
            sheet.getRange(i+1, j+1).setValue(patch[h]);
          }
        });
        return;
      }
    }
  }

  static _rowToObj(headers, row) {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  }
}
```

---

## 1C. BindingService

```javascript
class BindingService {
  static assertInitializeAllowed(existingBinding, manifest, config) {
    if (!existingBinding) return;

    const bootstrap = RegistryService.findSuccessfulBootstrap(
      existingBinding.workspace_binding_id
    );

    if (!bootstrap) {
      throw this._conflict("Initialize refused: binding exists but not clean");
    }

    const same =
      bootstrap.init_manifest_hash === manifest.manifest_hash &&
      bootstrap.recipe_bundle_version === config.RECIPE_BUNDLE_VERSION &&
      bootstrap.schema_contract_version === config.SCHEMA_CONTRACT_VERSION;

    if (same) {
      return { type: 'IDEMPOTENT', bootstrap };
    }

    throw this._conflict("Initialize refused: manifest mismatch");
  }

  static _conflict(msg) {
    const err = new Error(msg);
    err.statusCode = 409;
    return err;
  }
}
```

---

# 2. Full Replacement: `handleInitializeWorkspace`

```javascript
function handleInitializeWorkspace(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("System busy, retry");
  }

  try {
    RegistryService.ensureTabs();

    // --- Step 2: validate ---
    if (!payload.control_center_id) {
      throw new Error("Missing control_center_id");
    }

    const config = {
      RECIPE_BUNDLE_VERSION: "v1",
      SCHEMA_CONTRACT_VERSION: "v1"
    };

    // --- Step 3: manifest ---
    const manifest = ManifestService.buildCanonicalInitializeManifest(payload);

    RegistryService.insertManifest({
      manifest_hash: manifest.manifest_hash,
      canonical_json: manifest.canonical_json,
      created_at: new Date()
    });

    // --- Step 4: check registry ---
    const existing = RegistryService.findWorkspaceByControlCenter(
      payload.control_center_id
    );

    if (existing) {
      const decision = BindingService.assertInitializeAllowed(existing, manifest, config);

      if (decision?.type === 'IDEMPOTENT') {
        return {
          statusCode: 200,
          body: {
            workspace_binding_id: existing.workspace_binding_id,
            template_project_id: decision.bootstrap.template_project_id,
            template_version_id: decision.bootstrap.template_version_id,
            assigned_workspace: existing.workspace_name,
            manifest_hash: manifest.manifest_hash
          }
        };
      }
    }

    // --- Step 5: first-time initialize ---
    const checkout = FleetManager.checkoutWorkspace(payload.project_metadata.project_name);

    const workspaceBindingId = Utilities.getUuid();
    const bootstrapId = Utilities.getUuid();

    RegistryService.insertWorkspace({
      workspace_binding_id: workspaceBindingId,
      control_center_id: payload.control_center_id,
      client_name: payload.project_metadata.project_name,
      workspace_name: checkout.workspaceName,
      workspace_status: 'PROVISIONING',
      recipe_bundle_version: config.RECIPE_BUNDLE_VERSION,
      schema_contract_version: config.SCHEMA_CONTRACT_VERSION,
      active_bootstrap_id: bootstrapId,
      created_at: new Date(),
      updated_at: new Date()
    });

    RegistryService.insertBootstrap({
      bootstrap_id: bootstrapId,
      workspace_binding_id: workspaceBindingId,
      control_center_id: payload.control_center_id,
      init_manifest_hash: manifest.manifest_hash,
      bootstrap_status: 'STARTED',
      idempotency_decision: 'NEW',
      recipe_bundle_version: config.RECIPE_BUNDLE_VERSION,
      schema_contract_version: config.SCHEMA_CONTRACT_VERSION,
      supplier_count: (payload.supplier_roster || []).length,
      started_at: new Date()
    });

    // --- Step 6: provision + bootstrap ---
    const ctx = AppFactory.createContext(checkout.apiToken);
    const provision = new ProvisioningRunner().run(ctx, payload.project_metadata.project_name);

    const templateProjectId = Utilities.getUuid();
    const templateVersionId = Utilities.getUuid();

    const supplierRequests = (payload.supplier_roster || []).map(s => ({
      supplier_request_id: Utilities.getUuid(),
      supplier_name: s.supplier_name,
      contact_email: s.contact_email
    }));

    const bootstrapPayload = {
      ...payload,
      workspace_binding_id: workspaceBindingId,
      template_project_id: templateProjectId,
      template_version_id: templateVersionId,
      supplier_roster: supplierRequests
    };

    const response = UrlFetchApp.fetch(
      PropertiesService.getScriptProperties().getProperty('WORKATO_BOOTSTRAP_URL'),
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(bootstrapPayload),
        muteHttpExceptions: true
      }
    );

    if (response.getResponseCode() >= 300) {
      throw new Error("Bootstrap failed: " + response.getContentText());
    }

    // --- Step 7: success ---
    RegistryService.updateWorkspace(workspaceBindingId, {
      workspace_status: 'ACTIVE',
      current_template_project_id: templateProjectId,
      current_template_version_id: templateVersionId,
      initialized_at: new Date(),
      updated_at: new Date()
    });

    RegistryService.updateBootstrap(bootstrapId, {
      bootstrap_status: 'SUCCESS',
      template_project_id: templateProjectId,
      template_version_id: templateVersionId,
      completed_at: new Date()
    });

    return {
      statusCode: 200,
      body: {
        workspace_binding_id: workspaceBindingId,
        template_project_id: templateProjectId,
        template_version_id: templateVersionId,
        assigned_workspace: checkout.workspaceName,
        manifest_hash: manifest.manifest_hash,
        supplier_requests: supplierRequests
      }
    };

  } catch (err) {

    // --- Step 8: failure ---
    try {
      RegistryService.updateWorkspace(workspaceBindingId, {
        workspace_status: 'FAILED',
        last_error: err.message,
        updated_at: new Date()
      });

      RegistryService.updateBootstrap(bootstrapId, {
        bootstrap_status: 'FAILED',
        error_message: err.message,
        completed_at: new Date()
      });
    } catch (_) {}

    throw err;

  } finally {
    lock.releaseLock();
  }
}
```

---

# 3. Config Additions

Add to Script Properties:

```
ADMIN_REGISTRY_ID = <spreadsheet_id>
WORKATO_BOOTSTRAP_URL = <existing>
```

---

# 4. Critical Bug Fix (required)

Somewhere in your codebase:

```javascript
// FIX THIS
const value = this.scriptProps().getProperty(key);
```

NOT:

```javascript
const val = this.scriptProps().getProperty(key); // ❌
```

---

# Bottom line

This does exactly what you need without blowing up your system:

* ✅ Hard refusal on reinitialize
* ✅ Exact-match idempotent replay
* ✅ Registry-backed control plane
* ✅ No change to provisioning engine
* ✅ No change to Workato contracts

---

If you want next step: I can generate the **wrapper preflight guard + CoreLib changes** so the spreadsheet refuses initialize before even hitting the backend (which you absolutely want).
