// --- PORTAL ACCESS --------------------------------------------------
/**
 * Fires a portal invite webhook for the active user.
 * Reads correlation_id from _script_logs (most recent SUCCESS entry)
 * so the invite can be tied back to the originating request in Workato.
 */
function requestPortalAccess() {
  const CONFIG = buildConfig();
  const ui     = SpreadsheetApp.getUi();

  const portalInviteUrl = CONFIG.webhook.portalInviteUrl;
  if (!portalInviteUrl) {
    ui.alert('Error', 'Portal invite URL not configured.\nCheck _developer_settings → webhook.portalInviteUrl.', ui.ButtonSet.OK);
    return;
  }

  const userEmail = Session.getActiveUser().getEmail();
  if (!userEmail) {
    ui.alert('Error', 'Could not resolve your email address. Ensure you are signed in with a Google account.', ui.ButtonSet.OK);
    return;
  }

  // Recover the correlation_id from the most recent successful run
  const correlationId = getMostRecentCorrelationId_();
  if (!correlationId) {
    ui.alert('Error', 'No completed workspace initialization found.\nRun "Start supplier data collection" first.', ui.ButtonSet.OK);
    return;
  }

  const payload = {
    correlation_id: correlationId,
    user_email:     userEmail,
    contact_name:   '',
    role:           'analyst'
  };

  try {
    sendWebhookNotification(portalInviteUrl, payload);
    appendLog('INFO', 'Portal invite sent for: ' + userEmail);
    ui.alert('Success', 'Portal access request sent for:\n' + userEmail, ui.ButtonSet.OK);
  } catch (e) {
    appendLog('ERROR', 'Portal invite failed: ' + e.message);
    ui.alert('Error', 'Portal invite failed:\n\n' + e.message, ui.ButtonSet.OK);
  }
}


/**
 * Scans _script_logs in reverse for the most recent correlation ID
 * logged on a SUCCESS entry. Returns null if none found.
 * @private
 */
function getMostRecentCorrelationId_() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName('_script_logs');
  if (!logSheet) return null;

  const data = logSheet.getDataRange().getValues();

  for (let i = data.length - 1; i >= 0; i--) {
    const status  = String(data[i][1]);
    const message = String(data[i][3]);

    if (status === 'SUCCESS' && message.includes('Correlation ID: ')) {
      return message.split('Correlation ID: ')[1].trim();
    }
  }

  return null;
}
