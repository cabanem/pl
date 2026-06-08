Write it as a sibling to `Log` — a library-owned sheet with a self-healing schema and a best-effort write — and call it from `Validate.run` after the verdict comes back. That keeps it consistent with how `_script_logs` already works and means a sheet-write failure can never sink a validation that already succeeded.

Two design decisions worth stating up front, because they shape the code:

**One row per finding, not per check.** A `fail`/`warn` check carries a `details[]` array (your four childless parents are four entries under one `cascade_parent_has_children` check). Flattening to one row per detail makes the sheet sortable and filterable — you can filter Severity = `warn` and read each issue on its own line. Checks with no details (the passes) get a single summary row.

**Replace, not append.** Validation is a preview of "what's wrong now," which you re-run after each fix; the audit trail already lives in `_script_logs`. So each run clears prior rows and writes the latest verdict. One constant flips it to append if you'd rather keep history.

New file — `000_ValidationReport.js`:

```javascript
/**
 * @file 000_ValidationReport.gs
 * Writes a validate-flow verdict to the workbook's _validation_results sheet.
 * Sibling to Log: library-owned sheet, self-healing schema, best-effort write.
 *
 * One row per finding:
 *   - a check WITH details (fail/warn) emits one row per detail
 *   - a check with NO details emits one summary row
 *
 * Replace semantics: each run clears prior data rows, then writes the latest
 * verdict. History lives in _script_logs; this answers "what's wrong now."
 * Flip VR_CLEAR_BEFORE_WRITE to false for append.
 *
 * Not in CONNECTOR_SHEETS, so it is never serialized to the config JSON.
 *
 * Public:
 *   ValidationReport.write(ss, parsed, correlationId) -> { ok, rowsWritten }
 *   ValidationReport.ensureSchema(ss)                 -> void
 */
var ValidationReport = {};

var VR_SHEET_NAME         = '_validation_results';
var VR_CLEAR_BEFORE_WRITE = true;

var VR_HEADERS = Object.freeze([
  'Run At', 'Correlation ID', 'Overall', 'Check', 'Severity',
  'Message', 'Entity', 'Name', 'Issue'
]);

ValidationReport.write = function(ss, parsed, correlationId) {
  try {
    if (!ss) return { ok: false, rowsWritten: 0 };

    var verdict = ValidationReport._extractVerdict(parsed);
    if (!verdict) return { ok: false, rowsWritten: 0 };

    ValidationReport.ensureSchema(ss);
    var sheet = ss.getSheetByName(VR_SHEET_NAME);
    if (!sheet) return { ok: false, rowsWritten: 0 };

    var rows = ValidationReport._toRows(verdict, correlationId);

    if (VR_CLEAR_BEFORE_WRITE) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        sheet.getRange(2, 1, lastRow - 1, VR_HEADERS.length).clearContent();
      }
    }
    if (rows.length > 0) {
      var startRow = VR_CLEAR_BEFORE_WRITE ? 2 : sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, rows.length, VR_HEADERS.length).setValues(rows);
    }
    return { ok: true, rowsWritten: rows.length };
  } catch (e) {
    console.warn('ValidationReport.write failed: ' + e.message);
    return { ok: false, rowsWritten: 0 };
  }
};

// The endpoint may nest the verdict under .verdict (preview/validate
// envelopes) or return it at the top level. Prefer nested when present.
ValidationReport._extractVerdict = function(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  var v = (parsed.verdict && typeof parsed.verdict === 'object') ? parsed.verdict : parsed;
  return Array.isArray(v.checks) ? v : null;
};

ValidationReport._toRows = function(verdict, correlationId) {
  var runAt   = new Date();
  var overall = String(verdict.status || '');
  var cid     = String(correlationId || '');
  var rows    = [];

  (verdict.checks || []).forEach(function(c) {
    var checkName = String(c.check_name || '');
    // Recipe remaps per-check status to c_status; fall back to status.
    var severity  = String(c.c_status || c.status || '');
    var message   = String(c.message || '');
    var details   = Array.isArray(c.details) ? c.details : [];

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

ValidationReport.ensureSchema = function(ss) {
  try {
    if (!ss) return;
    var sheet = ss.getSheetByName(VR_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(VR_SHEET_NAME);
      sheet.getRange(1, 1, 1, VR_HEADERS.length).setValues([VR_HEADERS.slice()]);
      sheet.setFrozenRows(1);
      return;  // left visible on purpose — the analyst is meant to read it
    }
    var needed  = VR_HEADERS.length;
    var lastCol = sheet.getLastColumn();
    if (lastCol < needed) sheet.insertColumnsAfter(Math.max(lastCol, 1), needed - lastCol);

    var headerRange = sheet.getRange(1, 1, 1, needed);
    var current = headerRange.getValues()[0].map(function(v) { return String(v).trim(); });
    var rewrite = false;
    for (var i = 0; i < needed; i++) { if (current[i] !== VR_HEADERS[i]) { rewrite = true; break; } }
    if (rewrite) headerRange.setValues([VR_HEADERS.slice()]);
  } catch (e) {
    console.warn('ValidationReport.ensureSchema failed: ' + e.message);
  }
};
```

Then in `007_Validate.js`, inside `Validate.run`, right after the `if (!response.parsed) { … throw }` block and before you build `notes`:

```javascript
    // Persist the verdict in-sheet so findings live in the workbook, not just
    // the modal. Best-effort: a write failure must not fail a validation that
    // already succeeded — surface it as a Result warning instead.
    var reportWarnings = [];
    var report = ValidationReport.write(ss, response.parsed, correlationId);
    if (report.ok) {
      log('INFO', 'Wrote ' + report.rowsWritten + ' finding(s) to ' + '_validation_results.');
    } else {
      reportWarnings.push('Could not write results to _validation_results; see _script_logs.');
      log('WARNING', 'ValidationReport.write did not complete.');
    }
```

and add the two fields to the existing `Result.ok({...})`:

```javascript
      message:       'Validation complete.' + noteBlock,
      warnings:      reportWarnings,
      data: {
        ...
        validationResult:  response.parsed,
        resultsWritten:    report.rowsWritten
      }
```

`validationResult: response.parsed` stays untouched, so your container renderer keeps working — the writer extracts its own copy defensively rather than forcing a shared shape, which is the surgical move here.

Three things to confirm against your live verdict, since the wire contract has churned before and the writer's correctness hinges on them:

The writer iterates `checks[]` only — that array already contains pass, fail, *and* warn entries, so it's complete. Don't also iterate the new `warnings[]` field you just added to the connector, or every warning lands in the sheet twice.

`_extractVerdict` handles the verdict living at the top level *or* under `.verdict`. Preview.run reads `p.verdict`, but `Validate.run` stores `response.parsed` whole — so I genuinely can't tell from the code which nesting the validate endpoint uses. The defensive lookup covers both; if you know which it is, you can drop the branch.

`severity` reads `c.c_status` first, falling back to `c.status`. The CFG-01 recipe remaps per-check `status` → `c_status` on the wire, so `c_status` is almost certainly what arrives — but if a wrapper recipe re-maps it back, the fallback catches it. Confirm which key is actually present in one real response and you can collapse it to a single read.
