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
