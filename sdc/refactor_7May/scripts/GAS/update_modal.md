The messiness has a structural cause worth naming before reaching for CSS: you already have a clean, normalized representation of the verdict sitting right next to the modal, and the modal isn't using it. `ValidationReport._toRows` already does the hard part — it resolves the `warnings[]`-vs-inline-`details` ambiguity, picks the right severity (`c_status || status`), and flattens everything into a predictable shape for `_validation_results`. The modal, meanwhile, is almost certainly rendering off the raw nested `response.parsed` / `verdict` object ad hoc. So the same verdict gets normalized once for the sheet and re-interpreted, differently and more loosely, for the modal.

The elegant fix is the move you already made with `_extractVerdict`: one source of truth, two consumers. Lift the normalization out of `_toRows` into a presentation-neutral model, then let both the sheet writer and the modal render from it. The sheet wants it flat (one row per finding); the modal wants it grouped (a check, with its findings nested). So the neutral shape should be the grouped one, and `_toRows` flattens it.

## The shared model

Add this to `000_ValidationReport.js`:

```javascript
/**
 * Normalize a verdict into a presentation-neutral model. Single source of
 * truth for "what does this verdict actually say" — consumed by both the
 * in-sheet writer (_toRows flattens it) and the modal (renders it grouped),
 * so the two can never disagree about a finding.
 *
 * @param {Object} verdict - From ValidationReport._extractVerdict.
 * @returns {{overall: string,
 *            checks: Array<{checkName: string, severity: string, message: string,
 *                           details: Array<{entity: string, name: string, issue: string}>}>}}
 */
ValidationReport.toModel = function(verdict) {
  if (!verdict || typeof verdict !== 'object') return { overall: '', checks: [] };

  var detailed = {};
  (verdict.warnings || []).forEach(function(w) {
    detailed[String(w.check_name || '')] = w;
  });

  var checks = (verdict.checks || []).map(function(c) {
    var checkName = String(c.check_name || '');
    var severity  = String(c.c_status || c.status || '');
    var w         = detailed[checkName];

    // Same finding-source resolution _toRows used to own.
    var source     = Array.isArray(c.details) ? c
                   : (w && Array.isArray(w.details)) ? w
                   : c;
    var rawDetails = Array.isArray(source.details) ? source.details : [];
    var message    = String(source.message || c.message || '');

    return {
      checkName: checkName,
      severity:  severity,
      message:   message,
      details:   rawDetails.map(function(d) {
        return { entity: String(d.entity || ''),
                 name:   String(d.name   || ''),
                 issue:  String(d.issue  || '') };
      })
    };
  });

  return { overall: String(verdict.status || ''), checks: checks };
};
```

Then `_toRows` collapses to a thin flattener — behavior-identical for the sheet:

```javascript
ValidationReport._toRows = function(verdict, correlationId) {
  var model = ValidationReport.toModel(verdict);
  var runAt = new Date();
  var cid   = String(correlationId || '');
  var rows  = [];

  model.checks.forEach(function(c) {
    if (c.details.length === 0) {
      rows.push([runAt, cid, model.overall, c.checkName, c.severity, c.message, '', '', '']);
    } else {
      c.details.forEach(function(d) {
        rows.push([runAt, cid, model.overall, c.checkName, c.severity, c.message,
                   d.entity, d.name, d.issue]);
      });
    }
  });
  return rows;
};
```

The verdict already rides on `Result.data.validationResult`, so the container side calls `ValidationReport.toModel(r.data.validationResult)` and renders from the model rather than from raw JSON. That alone removes most of the mess, because the modal stops guessing at the structure.

## What "render from the model" should do

Three moves do the heavy lifting, in order of impact:

Lead with a summary banner: the overall status plus counts by severity. A reader should know "3 failures, 2 warnings" before scrolling. Then **sort checks by severity** so failures sit at the top and passing checks sink — right now a messy modal is usually one long undifferentiated list where the one broken check is buried among the green ones. Finally, **collapse passing checks** behind a toggle (or just a count) so the modal is about what's wrong, not a full audit log; the full record lives in `_validation_results` already.

Per check, a small card reads far better than inline JSON: the check name, a severity chip, the message, and — only when `details.length > 0` — a compact `entity / name / issue` table. Monospace the entity/name, let the issue text wrap.

A severity-ordering helper keeps the render dumb:

```javascript
// Client-side, in the modal's HTML/JS. Illustrative — adapt to your template.
var SEVERITY_RANK = { fail: 0, error: 0, warning: 1, warn: 1, info: 2, pass: 3, ok: 3 };

function orderedChecks(model) {
  return model.checks.slice().sort(function(a, b) {
    var ra = SEVERITY_RANK[a.severity.toLowerCase()] ?? 2;
    var rb = SEVERITY_RANK[b.severity.toLowerCase()] ?? 2;
    return ra - rb;
  });
}
```

I'm working from the verdict shape your `ValidationReport` code reveals, not from your actual `showValidationResults_` template — which I haven't seen. So the model refactor above is exact and drop-in; the modal-side rendering is a recommendation of structure rather than line edits to your HTML. If you paste the current `showValidationResults_` (and whatever HtmlService template it loads), I can turn the structural advice into the actual diff — that's the part where seeing your markup changes what I'd write.
