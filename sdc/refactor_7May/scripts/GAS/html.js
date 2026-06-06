function showValidationResults_(validationResult) {
  var vr     = validationResult || {};
  var checks = Array.isArray(vr.checks) ? vr.checks : [];

  var html = HtmlService.createHtmlOutput(validationResultsHtml_(checks))
    .setWidth(720).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validationResultsHtml_(checks) {
  var fails = [], warns = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i] || {};
    if (c.c_status === 'fail')      fails.push(c);
    else if (c.c_status === 'warn') warns.push(c);
  }

  var parts = [
    '<style>' +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;color:#202124;padding:16px 20px;margin:0;line-height:1.5;}" +
    'h3{margin:16px 0 8px;font-size:14px;font-weight:600;color:#3c4043;}' +
    'h3:first-child{margin-top:0;}' +
    '.count-badge{display:inline-block;padding:2px 8px;background:rgba(0,0,0,0.08);border-radius:10px;font-size:11px;margin-left:6px;}' +
    '.check{padding:8px 0;border-bottom:1px solid #f1f3f4;}' +
    '.check:last-child{border-bottom:none;}' +
    '.check-msg{font-weight:500;}' +
    '.check-name{color:#5f6368;font-size:11px;text-transform:uppercase;letter-spacing:.3px;margin-top:2px;}' +
    '.detail-list{margin:6px 0 0;padding-left:18px;} .detail-list li{margin:2px 0;}' +
    '.ok{color:#137333;}' +
    '</style>'
  ];

  if (fails.length === 0 && warns.length === 0) {
    parts.push('<p class="ok">\u2713 Validation passed. No errors or warnings.</p>');
    return parts.join('\n');
  }

  if (fails.length > 0) {
    parts.push('<h3>Errors <span class="count-badge">' + fails.length + '</span></h3>');
    parts.push(renderChecks_(fails));
  }
  if (warns.length > 0) {
    parts.push('<h3>Warnings <span class="count-badge">' + warns.length + '</span></h3>');
    parts.push(renderChecks_(warns));
  }
  return parts.join('\n');
}

function renderChecks_(checks) {
  var out = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i] || {};
    out.push('<div class="check">');
    out.push('<div class="check-msg">' + esc_(c.message || c.check_name || '(no message)') + '</div>');
    if (c.check_name && c.message) {
      out.push('<div class="check-name">' + esc_(c.check_name) + '</div>');
    }
    var details = Array.isArray(c.details) ? c.details : [];
    if (details.length > 0) {
      out.push('<ul class="detail-list">');
      for (var j = 0; j < details.length; j++) {
        var d = details[j] || {};
        var label = [d.entity, d.name].filter(function(x){ return x != null && x !== ''; }).join(' ');
        var issue = esc_(d.issue || '');
        out.push('<li>' + (label ? esc_(label) + ' - ' + issue : issue) + '</li>');
      }
      out.push('</ul>');
    }
    out.push('</div>');
  }
  return out.join('\n');
}
