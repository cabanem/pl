/**
 * @file Validate.gs (SDC library)
 * Validate orchestrator — the "Validate configuration" flow.
 *
 * Pipeline (mirrors provision through serialization, then diverges):
 *   Config.build → Preflight.run(requireCustomerData: false) →
 *   PrimaryKey.backfill → Drive.serializeConfig('validate') →
 *   Variant.serializeAll('validate') → Drive.shareWithIntegrationAccount →
 *   Payload.validate → Webhook.call (returns parsed validation result)
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
 *   Validate.run(ss) → Result
 */

var Validate = {};

Validate.run = function(ss) {
  if (!ss) throw new Error('Validate.run: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = function(status, msg) { Log.append(ss, status, msg, correlationId); };

  log('INFO', 'Starting validation...');

  try {
    var config = Validate._stage('config', function() {
      return Config.build(ss);
    });

    var pf = Validate._stage('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.validateUrl,
        webhookLabel:        'validateUrl',
        requireCustomerData: false
      });
    });

    var pkResult = Validate._stage('primary-key-backfill', function() {
      return PrimaryKey.backfill(ss);
    });
    if (pkResult.totalStamped > 0) {
      log('INFO', 'Stamped ' + pkResult.totalStamped + ' new field IDs across ' +
                  Object.keys(pkResult.stamped).filter(function(k) {
                    return pkResult.stamped[k] > 0;
                  }).join(', ') + '.');
    }

    var baseResult = Validate._stage('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'validate' });
    });
    var configJsonFileId = baseResult.fileId;
    log('INFO', 'Validate config serialized. File ID: ' + configJsonFileId);

    var variantResult = Validate._stage('serialize-variants', function() {
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

    Validate._stage('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // Note: shareWithEditors deliberately skipped — validate files are
    // transient and don't need audit-share distribution.

    var requesterEmail = Util.getActiveUserEmail();

    var payload = Payload.validate({
      correlationId:    correlationId,
      configJsonFileId: configJsonFileId,
      requesterEmail:   requesterEmail
    });

    var response = Validate._stage('webhook', function() {
      return Webhook.call(config.webhook.validateUrl, payload);
    });

    if (!response.parsed) {
      var err = new Error('Validation webhook returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 200));
      err.stage = 'webhook-response';
      throw err;
    }

    log('SUCCESS', 'Validation complete. Returned: ' + JSON.stringify(response.parsed).substring(0, 200));

    return Validate._success(correlationId, configJsonFileId, pkResult, variantResult, response.parsed);
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Validation failed at ' + stage + ': ' + e.message);
    return Validate._failure(correlationId, stage, e);
  }
};

// --- Private helpers -------------------------------------------------

Validate._stage = function(stageName, fn) {
  try {
    return fn();
  } catch (e) {
    if (!e.stage) e.stage = stageName;
    throw e;
  }
};

Validate._success = function(correlationId, configJsonFileId, pkResult, variantResult, validationResult) {
  var notes = [];
  if (pkResult.totalStamped > 0) {
    notes.push(pkResult.totalStamped + ' unstamped field ID(s) were filled in as part of this check.');
  }
  if (variantResult.variantsGenerated > 0) {
    notes.push(variantResult.variantsGenerated + ' variant template(s) were generated.');
  }
  var noteBlock = notes.length ? '\n\nNote: ' + notes.join(' ') : '';

  return {
    ok:            true,
    flow:          'validate',
    correlationId: correlationId,
    message:       'Validation complete.' + noteBlock,
    data: {
      configJsonFileId:  configJsonFileId,
      templateFileIds:   variantResult.fileIds,
      variantsGenerated: variantResult.variantsGenerated,
      stampedRows:       pkResult.totalStamped,
      validationResult:  validationResult
    },
    error: null
  };
};

Validate._failure = function(correlationId, stage, error) {
  return {
    ok:            false,
    flow:          'validate',
    correlationId: correlationId,
    message:       'Validation failed at ' + stage + ':\n\n' + error.message,
    data:          null,
    error: {
      stage:   stage,
      message: error.message
    }
  };
};
