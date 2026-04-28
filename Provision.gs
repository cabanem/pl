/**
 * @file Provision.gs (SDC library)
 * Provision orchestrator — the "Start supplier data collection" flow.
 *
 * Pipeline:
 *   Config.build → Preflight.run → PrimaryKey.backfill →
 *   Drive.serializeConfig('provision') → Variant.serializeAll →
 *   Drive.shareWithIntegrationAccount(base) → Drive.shareWithEditors →
 *   Payload.provision → Webhook.call
 *
 * Returns a Result; container handles UI. correlationId is generated
 * up-front so every log line and the eventual webhook payload share
 * one tracing ID, even if the flow fails mid-pipeline.
 *
 * Public:
 *   Provision.run(ss) → Result
 */

var Provision = {};

/**
 * Run the provision flow end-to-end.
 *
 * @param {Spreadsheet} ss
 * @returns {{ok: boolean, flow: string, correlationId: string, message: string,
 *            data: (Object|null), error: ({stage: string, message: string}|null)}}
 */
Provision.run = function(ss) {
  if (!ss) throw new Error('Provision.run: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = function(status, msg) { Log.append(ss, status, msg, correlationId); };

  log('INFO', 'Starting provision...');

  try {
    // 1. Build config (also runs schema compatibility check).
    var config = Provision._stage('config', function() {
      return Config.build(ss);
    });

    // 2. Preflight — connector sheets, customer data, integration account.
    var pf = Provision._stage('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.url,
        webhookLabel:        'fileExportUrl',
        requireCustomerData: true
      });
    });

    // 3. Stamp PKs in any new rows.
    var pkResult = Provision._stage('primary-key-backfill', function() {
      return PrimaryKey.backfill(ss);
    });
    if (pkResult.totalStamped > 0) {
      log('INFO', 'Stamped ' + pkResult.totalStamped + ' new field IDs across ' +
                  Object.keys(pkResult.stamped).filter(function(k) {
                    return pkResult.stamped[k] > 0;
                  }).join(', ') + '.');
    }

    // 4. Serialize base config to Drive.
    var baseResult = Provision._stage('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'provision' });
    });
    var configJsonFileId = baseResult.fileId;
    log('INFO', 'Config serialized to Drive. File ID: ' + configJsonFileId);

    // 4b. Serialize variant configs to Drive (one JSON per variant).
    //     Reuses baseResult.baseOutput so connector sheets are read exactly
    //     once across base + variants.
    var variantResult = Provision._stage('serialize-variants', function() {
      return Variant.serializeAll(ss, config, {
        purpose:                 'provision',
        integrationAccountEmail: pf.integrationAccountEmail,
        baseOutput:              baseResult.baseOutput
      });
    });
    if (variantResult.variantsGenerated > 0) {
      log('INFO', 'Generated ' + variantResult.variantsGenerated +
                  ' variant template(s): ' + variantResult.names.join(', ') + '.');
    }

    // 5. Share base file with Workato OAuth account (FATAL on failure —
    //    Workato cannot read the file otherwise). Variant files were
    //    already shared inside Variant.serializeAll.
    Provision._stage('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // 6. Share base with audit/visibility editors (NON-FATAL — collect
    //    outcomes, log warnings, continue).
    var shareResult = Drive.shareWithEditors(configJsonFileId, config.sharing.authorizedEditors);
    if (shareResult.failed.length > 0) {
      log('WARNING', 'Audit-share failures: ' + shareResult.failed.map(function(f) {
        return f.email + ' (' + f.error + ')';
      }).join('; '));
    }

    // 7. Build payload + fire webhook.
    var payload = Payload.provision({
      correlationId:     correlationId,
      clientName:        pf.clientName,
      analystEmail:      pf.analystEmail,
      targetVms:         pf.targetVms,
      separateWorkspace: pf.separateWorkspace,
      configFileId:      ss.getId(),
      configJsonFileId:  configJsonFileId,
      templateFileIds:   variantResult.fileIds
    });

    Provision._stage('webhook', function() {
      return Webhook.call(config.webhook.url, payload);
    });

    log('SUCCESS', 'Provision complete.');

    return Provision._success(correlationId, configJsonFileId, pkResult, variantResult, shareResult);
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Provision failed at ' + stage + ': ' + e.message);
    return Provision._failure(correlationId, stage, e);
  }
};

// --- Private helpers -------------------------------------------------

/**
 * Run a stage and tag any thrown error with the stage name. Library
 * functions that throw can also pre-tag (e.g. Preflight.run); pre-tagged
 * errors keep their tag — the inner stage wins. This lets the orchestrator
 * tag at the call site without overriding more specific tags from below.
 */
Provision._stage = function(stageName, fn) {
  try {
    return fn();
  } catch (e) {
    if (!e.stage) e.stage = stageName;
    throw e;
  }
};

Provision._success = function(correlationId, configJsonFileId, pkResult, variantResult, shareResult) {
  var auditNote = '';
  if (shareResult.failed.length > 0) {
    auditNote = ' Audit-share warnings: ' + shareResult.failed.length +
                ' email(s) failed (see _script_logs).';
  }

  return {
    ok:            true,
    flow:          'provision',
    correlationId: correlationId,
    message:       'Configuration sent to Workato.\n\nCorrelation ID: ' + correlationId +
                   '.' + auditNote,
    data: {
      configJsonFileId:  configJsonFileId,
      templateFileIds:   variantResult.fileIds,
      variantsGenerated: variantResult.variantsGenerated,
      stampedRows:       pkResult.totalStamped,
      auditShareGranted: shareResult.granted.length,
      auditShareFailed:  shareResult.failed.length
    },
    error: null
  };
};

Provision._failure = function(correlationId, stage, error) {
  return {
    ok:            false,
    flow:          'provision',
    correlationId: correlationId,
    message:       'Provision failed at ' + stage + ':\n\n' + error.message,
    data:          null,
    error: {
      stage:   stage,
      message: error.message
    }
  };
};
