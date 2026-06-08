Both are pure relocations/additions — no logic rewrites.

## Patch 1 — `007_Validate.js`

Declare `verdict` from the parsed body. Find this guard block:

```js
    if (!response.parsed) {
      var err = new Error('Validate endpoint returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 200));
      err.stage = 'endpoint-response';
      throw err;
    }

    // Persist the verdict in-sheet so findings live in the workbook, not just the modal.
```

Replace it with (adds the `verdict` declaration after the guard):

```js
    if (!response.parsed) {
      var err = new Error('Validate endpoint returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 200));
      err.stage = 'endpoint-response';
      throw err;
    }

    // Verdict may arrive nested under .verdict (preview/validate envelope) or at
    // the top level. Mirrors ValidationReport._extractVerdict's nesting logic so
    // the modal (showValidationResults_) and the in-sheet report agree on shape.
    var verdict = (response.parsed.verdict && typeof response.parsed.verdict === 'object')
      ? response.parsed.verdict
      : response.parsed;

    // Persist the verdict in-sheet so findings live in the workbook, not just the modal.
```

The existing `validationResult: verdict` in the `data` object now resolves. `ValidationReport.write` still takes `response.parsed` — it extracts the verdict internally, so nothing else changes.

## Patch 2 — `010_Preview.js`

Move the null guard above the debug block. Find:

```js
    log('INFO', 'Endpoint returned HTTP ' + response.statusCode);
    var p = response.parsed;

    // ############## DEBUGGING START ####################################################################
    log('INFO', 'Preview raw: ok=' + p.ok + ' status=' + (p.verdict && p.verdict.status) + ' has_file=' + !!p.file_content + ' fields=' + JSON.stringify(Object.keys(p)));
    log('INFO', 'Preview raw: ' + JSON.stringify(p));
    log('INFO', 'Preview http: ' + response.statusCode);
    // ############## DEBUGGING END ######################################################################

    if (!p) {
      var e1 = new Error('Preview endpoint returned a non-JSON body: ' +
                         String(response.body || '').substring(0, 200));
      e1.stage = 'endpoint-response'; throw e1;
    }
```

Replace with (guard first, then debug):

```js
    log('INFO', 'Endpoint returned HTTP ' + response.statusCode);
    var p = response.parsed;

    if (!p) {
      var e1 = new Error('Preview endpoint returned a non-JSON body: ' +
                         String(response.body || '').substring(0, 200));
      e1.stage = 'endpoint-response'; throw e1;
    }

    // ############## DEBUGGING START ####################################################################
    log('INFO', 'Preview raw: ok=' + p.ok + ' status=' + (p.verdict && p.verdict.status) + ' has_file=' + !!p.file_content + ' fields=' + JSON.stringify(Object.keys(p)));
    log('INFO', 'Preview raw: ' + JSON.stringify(p));
    log('INFO', 'Preview http: ' + response.statusCode);
    // ############## DEBUGGING END ######################################################################
```

The debug lines keep their visibility but now only run when there's a parsed body. On an empty/non-JSON response you'll get your intended "returned a non-JSON body" error (with the `response.body` substring) instead of a `TypeError`.

To confirm Patch 1 landed: re-run Validate against a config you know is well-formed. It should now reach the success Result and render the modal rather than failing at `unknown`. If validation still fails with a body-related message after this, that's the Workato side, not the script.
