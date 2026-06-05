function showValidationResults_(validationResult) {
  var vr       = validationResult || {};
  var errors   = Array.isArray(vr.template_errors) ? vr.template_errors : [];
  var warnings = Array.isArray(vr.slot_warnings)   ? vr.slot_warnings   : [];

  var html = HtmlService.createHtmlOutput(validationResultsHtml_(errors, warnings))
    .setWidth(720)
    .setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}

/** Escape text before putting it in HTML (replaces the template's <?= ?> escaping). */
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validationResultsHtml_(errors, warnings) {
  var nE = errors.length, nW = warnings.length;
  var parts = [];

  parts.push(
    '<style>' +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;color:#202124;padding:16px 20px 20px;margin:0;line-height:1.5;}" +
    'h3{margin:20px 0 10px;font-size:14px;font-weight:600;color:#3c4043;}' +
    '.summary{padding:12px 14px;margin-bottom:16px;border-radius:6px;font-weight:500;}' +
    '.summary.pass{background:#e6f4ea;color:#137333;border-left:4px solid #34a853;}' +
    '.summary.fail{background:#fce8e6;color:#c5221f;border-left:4px solid #ea4335;}' +
    '.summary.warn{background:#fef7e0;color:#b06000;border-left:4px solid #fbbc04;}' +
    '.count-badge{display:inline-block;padding:2px 8px;background:rgba(0,0,0,0.08);border-radius:10px;font-size:11px;margin-left:6px;}' +
    'table{border-collapse:collapse;width:100%;font-size:12px;background:white;}' +
    'th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #e8eaed;vertical-align:top;}' +
    'th{background:#f8f9fa;font-weight:600;color:#5f6368;text-transform:uppercase;font-size:11px;border-bottom:2px solid #e8eaed;}' +
    '.error-type{white-space:nowrap;font-weight:600;color:#c5221f;width:1%;}' +
    '.warning-item{padding:6px 0;border-bottom:1px solid #f1f3f4;}' +
    '.warning-item:last-child{border-bottom:none;}' +
    '</style>'
  );

  if (nE === 0 && nW === 0) {
    parts.push('<div class="summary pass">\u2713 Validation passed. Configuration is ready to submit.</div>');
  } else if (nE === 0) {
    parts.push('<div class="summary warn">Validation passed with ' + nW + ' warning' +
      (nW === 1 ? '' : 's') + '. Configuration can be submitted; warnings are informational.</div>');
  } else {
    parts.push('<div class="summary fail">Found ' + nE + ' error' +
      (nE === 1 ? '' : 's') + ' that must be resolved before submitting.</div>');
  }

  if (nE > 0) {
    parts.push('<h3>Errors <span class="count-badge">' + nE + '</span></h3>');
    parts.push('<table><thead><tr><th>Type</th><th>Detail</th></tr></thead><tbody>');
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i] || {};
      parts.push('<tr><td class="error-type">' + esc_(e.error_type || 'Unknown') +
        '</td><td>' + esc_(e.details || '') + '</td></tr>');
    }
    parts.push('</tbody></table>');
  }

  if (nW > 0) {
    parts.push('<h3>Warnings <span class="count-badge">' + nW + '</span></h3><div>');
    for (var j = 0; j < warnings.length; j++) {
      parts.push('<div class="warning-item">' + esc_(warnings[j]) + '</div>');
    }
    parts.push('</div>');
  }

  return parts.join('\n');
}
