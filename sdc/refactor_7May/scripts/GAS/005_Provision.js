/**
 * @file Provision.gs
 * Provision orchestrator â€” the "Start supplier data collection" flow.
 *
 * Pipeline:
 *   Config.build â†’ Preflight.run â†’ PrimaryKey.backfill â†’
 *   Drive.serializeConfig('provision') â†’ Variant.serializeAll â†’
 *   Drive.shareWithIntegrationAccount(base) â†’ Drive.shareWithEditors â†’
 *   Payload.provision â†’ Webhook.call
 *
 * Returns a canonical Result; container handles UI. correlationId is
 * generated up-front so every log line and the eventual webhook payload
 * share one tracing ID, even if the flow fails mid-pipeline.
 *
 * Public:
 *   Provision.run(ss) â†’ Result
 */

var Provision = {};

/**
 * Run the provision flow end-to-end.
 *
 * @param {Spreadsheet} ss
 * @returns {Object} canonical Result
 */
Provision.run = function(ss) {
  if (!ss) throw new Error('Provision.run: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  log('INFO', 'Starting provision...');

  try {
    // 1. Build config (also runs schema compatibility check).
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    // 2. Preflight â€” connector sheets, customer data, integration account.
    var pf = Stage.run('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.url,
        webhookLabel:        'fileExportUrl',
        requireCustomerData: true
      });
    });

    // 3. Stamp PKs in any new rows.
    var pkResult = Stage.run('primary-key-backfill', function() {
      return PrimaryKey.backfill(ss);
    });
    if (pkResult.totalStamped > 0) {
      log('INFO', 'Stamped ' + pkResult.totalStamped + ' new field IDs across ' +
                  Object.keys(pkResult.stamped).filter(function(k) {
                    return pkResult.stamped[k] > 0;
                  }).join(', ') + '.');
    }

    // 4. Serialize base config to Drive.
    var baseResult = Stage.run('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'provision' });
    });
    var configJsonFileId = baseResult.fileId;
    log('INFO', 'Config serialized to Drive. File ID: ' + configJsonFileId);

    // 4b. Serialize variant configs to Drive (one JSON per variant).
    //     Reuses baseResult.baseOutput so connector sheets are read exactly once across base + variants.
    var variantResult = Stage.run('serialize-variants', function() {
      return Variant.serializeAll(ss, config, {
        purpose:                 'provision',
        integrationAccountEmail: pf.integrationAccountEmail,
        baseOutput:              baseResult.baseOutput
      });
    });
    if (variantResult.variantsGenerated > 0) {
      log('INFO', 'Generated ' + variantResult.variantsGenerated + ' variant template(s): ' +
                  variantResult.names.join(', ') + '.');
    }

    // 5. Share base file with Workato OAuth account (FATAL on failure).
    Stage.run('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // 6. Share base with audit/visibility editors (NON-FATAL).
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

    Stage.run('webhook', function() {
      return Webhook.call(config.webhook.url, payload);
    });

    log('SUCCESS', 'Provision complete.');

    // Build the success Result. Audit-share failures become structured
    // warnings on Result.warnings instead of being prose-appended to
    // the message, so the container can render them consistently.
    var warnings = shareResult.failed.map(function(f) {
      return 'Audit-share failed for ' + f.email + ': ' + f.error;
    });

    return Result.ok({
      flow:          'provision',
      correlationId: correlationId,
      message:       'Configuration sent to Workato.\n\nCorrelation ID: ' + correlationId + '.',
      warnings:      warnings,
      data: {
        configJsonFileId:  configJsonFileId,
        templateFileIds:   variantResult.fileIds,
        variantsGenerated: variantResult.variantsGenerated,
        stampedRows:       pkResult.totalStamped,
        auditShareGranted: shareResult.granted.length,
        auditShareFailed:  shareResult.failed.length
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Provision failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow:          'provision',
      correlationId: correlationId,
      message:       'Provision failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------
//
// Stage handling is now in Stage.gs (Stage.run). Provision no longer
// has a private _stage helper.
