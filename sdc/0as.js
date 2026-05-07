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
  var log = function(status, msg) { Log.append(ss, status, msg, correlationId); };

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
  var log = function(status, msg) { Log.append(ss, status, msg, correlationId); };

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




/**
 * @file Portal.gs
 * Portal-invite orchestrator â€” the "Request portal access" flow.
 *
 * Slim by design. Does not serialize config or touch Drive. Recovers
 * the most recent SUCCESS correlation ID from _script_logs so the
 * invite can be tied back to its originating provision in Workato.
 *
 * Pipeline:
 *   Config.build â†’ Portal._preflight â†’ Log.getMostRecentCorrelationId â†’
 *   Payload.portalInvite â†’ Webhook.call
 *
 * Uses an ad-hoc preflight (Portal._preflight) instead of Preflight.run.
 * Preflight.run is "can I serialize and ship config?" â€” Portal isn't
 * doing that, and the checks differ in kind (no connector sheet
 * verification, no integration account share verification).
 *
 * Correlation ID handling:
 *   The invite carries the originating provision's correlation ID, not
 *   a fresh one â€” the whole point of the invite is to reference the
 *   provision it follows. When recovery FAILS (no prior provision in
 *   _script_logs), the flow generates a tracing-only correlation ID for
 *   THIS run's log lines and surfaces null on the Result â€” the user
 *   should see "no correlation ID" rather than a synthetic UUID that
 *   ties to nothing in Workato.
 *
 * Public:
 *   Portal.run(ss) â†’ Result
 */

var Portal = {};

Portal.run = function(ss) {
  if (!ss) throw new Error('Portal.run: ss is required.');

  // Recover the originating provision's correlation ID up-front. If
  // absent, we still need SOMETHING to thread through this run's log
  // lines so they correlate with each other. That tracing ID never
  // ends up on the Result â€” it dies with the failure log entry.
  var recoveredCorrelationId = Log.getMostRecentCorrelationId(ss);
  var traceCorrelationId     = recoveredCorrelationId || Util.newCorrelationId();
  var log = function(status, msg) { Log.append(ss, status, msg, traceCorrelationId); };

  log('INFO', recoveredCorrelationId
    ? 'Starting portal invite (correlation: ' + recoveredCorrelationId + ')...'
    : 'Starting portal invite (no prior provision found; using tracing-only ID)...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    Stage.run('preflight', function() {
      Portal._preflight(config);
    });

    if (!recoveredCorrelationId) {
      var err = new Error(
        'No completed workspace initialization found in _script_logs. ' +
        'Run "Start supplier data collection" first.'
      );
      err.stage = 'correlation-lookup';
      throw err;
    }

    var userEmail = Util.getActiveUserEmail('');
    if (!userEmail) {
      var emailErr = new Error(
        'Could not resolve your email address. Ensure you are signed in with a Google account.'
      );
      emailErr.stage = 'identity';
      throw emailErr;
    }

    var payload = Payload.portalInvite({
      correlationId: recoveredCorrelationId,
      userEmail:     userEmail,
      role:          'analyst'
    });

    Stage.run('webhook', function() {
      return Webhook.call(config.webhook.portalInviteUrl, payload);
    });

    log('INFO', 'Portal invite sent for: ' + userEmail);

    return Result.ok({
      flow:          'portalInvite',
      correlationId: recoveredCorrelationId,
      message:       'Portal access request sent for:\n' + userEmail,
      data: {
        userEmail: userEmail
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Portal invite failed at ' + stage + ': ' + e.message);

    // Result.correlationId reflects what's truthful: the recovered ID
    // when we have one, or the tracing ID when we don't. The caller can
    // still look up THIS run's log lines via the tracing ID even when
    // there's no upstream provision to correlate to. This is the
    // structural fix for the previous behavior, which surfaced a fresh
    // UUID on failure that pointed to nothing in Workato.
    return Result.fail({
      flow:          'portalInvite',
      correlationId: recoveredCorrelationId || traceCorrelationId,
      message:       'Portal invite failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------
/**
 * Ad-hoc preflight for the portal-invite flow. Lighter than Preflight.run
 * because we are not serializing config or sharing files â€” we just need
 * the portal-invite webhook URL configured.
 *
 * Throws on first failure with a stage-tagged Error.
 */
Portal._preflight = function(config) {
  if (!config.webhook.portalInviteUrl) {
    var err = new Error(
      'Portal invite URL not configured. ' +
      'Check _developer_settings â†’ webhook.portalInviteUrl.'
    );
    err.stage = 'preflight';
    throw err;
  }
};

// Stage handling is now in Stage.gs (Stage.run). Portal no longer
// has a private _stage helper.
