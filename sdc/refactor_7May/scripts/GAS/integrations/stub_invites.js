function sendAllInvitations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var confirm = ui.alert(
    'Send invitations',
    'Send invitations to all pending suppliers? You will not see per-supplier results.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  ss.toast('Sending invitations request...', 'Status');
  UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ analyst_email: Session.getActiveUser().getEmail() }),
    muteHttpExceptions: true
  });
  ss.toast('');

  ui.alert(
    'Sent',
    'Invitations have been requested. Workato is processing them in the background. ' +
    'Check supplier statuses by clicking "Refresh suppliers" in a few minutes.',
    ui.ButtonSet.OK
  );
}
