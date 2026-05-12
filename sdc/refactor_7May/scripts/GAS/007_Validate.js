/**
 * @file Validate.gs
 * Validate orchestrator â€” the "Validate configuration" flow.
 *
 * Pipeline (mirrors provision through serialization, then diverges):
 *   Config.build â†’ Preflight.run(requireCustomerData: false) â†’
 *   PrimaryKey.backfill â†’ Drive.serializeConfig('validate') â†’
 *   Variant.serializeAll('validate') â†’ Drive.shareWithIntegrationAccount â†’
 *   Payload.validate â†’ Webhook.call (returns parsed validation result)
 *
 * Differs from provision in three ways:
 *   1. Customer-data preflight is skipped (validation does not require
 *      a complete 1_customer; it can sanity-check a partial config).
 *   2. Audit-share to authorizedEditors is skipped (validate files are
 *      transient debug artifacts, not the production source of truth).
 *   3. The webhook returns a parsed JSON body which is surfaced via
 *      Result.data so the container can render it in the modal dialog.
 *
 * Note: this flow stamps PKs into the workbook (PrimaryKey.backfill
 * writes to the sheet). That mutation is documented in the success
 * message so users running validate know any unstamped IDs were filled
 * in as part of the check.
 *
 * Public:
 *   Validate.run(ss) â†’ Result
 */

var Validate = {};

Validate.run = function(ss) {
  if (!ss) throw new Error('Validate.run: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  log('INFO', 'Starting validation...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    var pf = Stage.run('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.validateUrl,
        webhookLabel:        'validateUrl',
        requireCustomerData: false
      });
    });

    var pkResult = Stage.run('primary-key-backfill', function() {
      return PrimaryKey.backfill(ss);
    });
    if (pkResult.totalStamped > 0) {
      log('INFO', 'Stamped ' + pkResult.totalStamped + ' new field IDs across ' +
                  Object.keys(pkResult.stamped).filter(function(k) {
                    return pkResult.stamped[k] > 0;
                  }).join(', ') + '.');
    }

    var baseResult = Stage.run('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'validate' });
    });
    var configJsonFileId = baseResult.fileId;
    log('INFO', 'Validate config serialized. File ID: ' + configJsonFileId);

    var variantResult = Stage.run('serialize-variants', function() {
      return Variant.serializeAll(ss, config, {
        purpose:                 'validate',
        integrationAccountEmail: pf.integrationAccountEmail,
        baseOutput:              baseResult.baseOutput
      });
    });
    if (variantResult.variantsGenerated > 0) {
      log('INFO', 'Generated ' + variantResult.variantsGenerated +
                  ' variant template(s) for validation.');
    }

    Stage.run('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // Note: shareWithEditors deliberately skipped â€” validate files are
    // transient and don't need audit-share distribution.

    var requesterEmail = Util.getActiveUserEmail();

    var payload = Payload.validate({
      correlationId:    correlationId,
      configJsonFileId: configJsonFileId,
      requesterEmail:   requesterEmail
    });

    var response = Stage.run('webhook', function() {
      return Webhook.call(config.webhook.validateUrl, payload);
    });

    if (!response.parsed) {
      var err = new Error('Validation webhook returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 200));
      err.stage = 'webhook-response';
      throw err;
    }

    log('SUCCESS', 'Validation complete. Returned: ' +
                   JSON.stringify(response.parsed).substring(0, 200));

    // Build the success message. PK-stamping and variant-generation notes
    // were previously appended via prose; keep them here because they're
    // narrative side-effects of validation, not warnings about a problem.
    var notes = [];
    if (pkResult.totalStamped > 0) {
      notes.push(pkResult.totalStamped +
                 ' unstamped field ID(s) were filled in as part of this check.');
    }
    if (variantResult.variantsGenerated > 0) {
      notes.push(variantResult.variantsGenerated +
                 ' variant template(s) were generated.');
    }
    var noteBlock = notes.length ? '\n\nNote: ' + notes.join(' ') : '';

    return Result.ok({
      flow:          'validate',
      correlationId: correlationId,
      message:       'Validation complete.' + noteBlock,
      data: {
        configJsonFileId:  configJsonFileId,
        templateFileIds:   variantResult.fileIds,
        variantsGenerated: variantResult.variantsGenerated,
        stampedRows:       pkResult.totalStamped,
        validationResult:  response.parsed
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Validation failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow:          'validate',
      correlationId: correlationId,
      message:       'Validation failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------
//
// Stage handling is now in Stage.gs (Stage.run). Validate no longer
// has a private _stage helper.
