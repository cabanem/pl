ValidationReport._toRows = function(verdict, correlationId) {
  var runAt   = new Date();
  var overall = String(verdict.status || '');
  var cid     = String(correlationId || '');
  var rows    = [];

  // Optional parallel warnings[] array, keyed by check_name. Some response
  // shapes attach per-finding details here; others attach them inline on the
  // check as checks[].details. The map is empty and harmless when absent.
  var detailed = {};
  (verdict.warnings || []).forEach(function(w) {
    detailed[String(w.check_name || '')] = w;
  });

  (verdict.checks || []).forEach(function(c) {
    var checkName = String(c.check_name || '');
    // Recipe remaps per-check status to c_status; fall back to status.
    var severity  = String(c.c_status || c.status || '');
    var w         = detailed[checkName];

    // Pick the object that actually carries findings: prefer details inline on
    // the check, else the matching warnings entry. Source the message from the
    // same object so a row's message and its detail rows describe one finding.
    var source  = Array.isArray(c.details) ? c
                : (w && Array.isArray(w.details)) ? w
                : c;
    var details = Array.isArray(source.details) ? source.details : [];
    var message = String(source.message || c.message || '');

    if (details.length === 0) {
      rows.push([runAt, cid, overall, checkName, severity, message, '', '', '']);
    } else {
      details.forEach(function(d) {
        rows.push([runAt, cid, overall, checkName, severity, message,
                   String(d.entity || ''), String(d.name || ''), String(d.issue || '')]);
      });
    }
  });
  return rows;
};
