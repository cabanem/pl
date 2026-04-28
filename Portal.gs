/**
 * @file Portal.gs (SDC library)
 * Portal-invite orchestrator — the "Request portal access" flow.
 *
 * Slim by design. Does not serialize config or touch Drive. Recovers
 * the most recent SUCCESS correlation ID from _script_logs so the
 * invite can be tied back to its originating provision in Workato.
 *
 * Pipeline:
 *   Config.build → Portal._preflight → Log.getMostRecentCorrelationId →
 *   Payload.portalInvite → Webhook.call
 *
 * Uses an ad-hoc preflight (Portal._preflight) instead of Preflight.run.
 * Preflight.run is "can I serialize and ship config?" — Portal isn't
 * doing that, and the checks differ in kind (no connector sheet
 * verification, no integration account share verification).
 *
 * The correlation ID for THIS invite is reused from the originating
 * provision — invites carry the provision's correlation ID, not a
 * fresh one. That's intentional: the whole point of the invite is to
 * reference the provision it follows.
 *
 * Public:
 *   Portal.run(ss) → Result
 */

var Portal = {};

Portal.run = function(ss) {
  if (!ss) throw new Error('Portal.run: ss is required.');

  // Recover the originating provision's correlation ID up-front.
  // If absent, the rest of the flow is moot; fail fast with a clear message.
  var correlationId = Log.getMostRecentCorrelationId(ss);

  // We still need SOME ID for the failure log path (when correlationId
  // is null). Use a fresh one for that purpose only — it won't end up
  // in any payload because we'll fail before constructing one.
  var logCorrelationId = correlationId || Util.newCorrelationId();
  var log = function(status, msg) { Log.append(ss, status, msg, logCorrelationId); };

  log('INFO', 'Starting portal invite...');

  try {
    var config = Portal._stage('config', function() {
      return Config.build(ss);
    });

    Portal._stage('preflight', function() {
      Portal._preflight(config);
    });

    if (!correlationId) {
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
      correlationId: correlationId,   // reused from originating provision
      userEmail:     userEmail,
      role:          'analyst'
    });

    Portal._stage('webhook', function() {
      return Webhook.call(config.webhook.portalInviteUrl, payload);
    });

    log('INFO', 'Portal invite sent for: ' + userEmail);

    return Portal._success(correlationId, userEmail);
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Portal invite failed at ' + stage + ': ' + e.message);
    return Portal._failure(logCorrelationId, stage, e);
  }
};

// --- Private helpers -------------------------------------------------

/**
 * Ad-hoc preflight for the portal-invite flow. Lighter than Preflight.run
 * because we are not serializing config or sharing files — we just need
 * the portal-invite webhook URL configured.
 *
 * Throws on first failure with a stage-tagged Error.
 */
Portal._preflight = function(config) {
  if (!config.webhook.portalInviteUrl) {
    var err = new Error(
      'Portal invite URL not configured. ' +
      'Check _developer_settings → webhook.portalInviteUrl.'
    );
    err.stage = 'preflight';
    throw err;
  }
};

Portal._stage = function(stageName, fn) {
  try {
    return fn();
  } catch (e) {
    if (!e.stage) e.stage = stageName;
    throw e;
  }
};

Portal._success = function(correlationId, userEmail) {
  return {
    ok:            true,
    flow:          'portalInvite',
    correlationId: correlationId,
    message:       'Portal access request sent for:\n' + userEmail,
    data: {
      userEmail: userEmail
    },
    error: null
  };
};

Portal._failure = function(correlationId, stage, error) {
  return {
    ok:            false,
    flow:          'portalInvite',
    correlationId: correlationId,
    message:       'Portal invite failed at ' + stage + ':\n\n' + error.message,
    data:          null,
    error: {
      stage:   stage,
      message: error.message
    }
  };
};
