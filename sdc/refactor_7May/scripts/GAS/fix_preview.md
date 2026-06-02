Here's the full change set, ordered so you can apply top to bottom and test once at the end. Three edits — one in each affected file. Two are the real fixes; the third is defense in depth. None require the raw log line, because I'm making them shape-tolerant so they're correct whether the recipe nests under `verdict` or surfaces flat.

## Step 1 — `010_Preview.js`: stop "no file" from masquerading as a pass

This is the root cause of the preview-shows-validation-modal symptom. Split the one overloaded branch into two.

**Find:**
```js
    var verdict = p.verdict || {};

    // Invalid config: hand back the verdict in Validate's shape. No file.
    if (p.ok === false || verdict.status === 'invalid' || verdict.status === 'fail' || !p.file_content) {
      log('INFO', 'Preview: config not yet valid; returning verdict.');
      return Result.ok({
        flow: 'preview', correlationId: correlationId,
        message: 'Configuration is not yet valid to build.',
        data: { validationResult: verdict }
      });
    }
```

**Replace with:**
```js
    var verdict = p.verdict || {};

    // Genuinely invalid config: hand back the verdict in Validate's shape. No file.
    if (p.ok === false || verdict.status === 'invalid' || verdict.status === 'fail') {
      log('INFO', 'Preview: config not yet valid; returning verdict.');
      return Result.ok({
        flow: 'preview', correlationId: correlationId,
        message: 'Configuration is not yet valid to build.',
        data: { validationResult: verdict }
      });
    }

    // Config accepted, but no file came back. This is a BUILD error, not a
    // validation problem — surface it as a failure so the container routes it
    // to showResult_ instead of rendering a (passing) validation modal.
    if (!p.file_content) {
      var be = new Error(
        'Preview endpoint accepted the config but returned no file_content. ' +
        'This is a build error, not a validation problem. See _script_logs ' +
        'for the raw endpoint response.'
      );
      be.stage = 'build';
      throw be;
    }
```

The only behavioral change: a result that used to slip through as `Result.ok` + passing verdict now throws into the existing `catch`, becomes `Result.fail`, and the container shows it via `showResult_` as "Template preview – failed at build." Your debug `log` lines above this still fire, so the raw response is still captured.

## Step 2 — `main.gs`: make `showValidationResults_` tolerant of nesting

This is the fix for the modal "always says passed / or doesn't appear." The template reads `data.template_errors` and `data.slot_warnings` at the top level; if you hand it an object that wraps those under `.verdict`, it silently renders "passed." Unwrap once.

**Find:**
```js
function showValidationResults_(validationResult) {
  var template  = HtmlService.createTemplateFromFile('validate_results');
  template.data = validationResult;

  var html = template.evaluate()
    .setWidth(720)
    .setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}
```

**Replace with:**
```js
function showValidationResults_(validationResult) {
  var vr = validationResult || {};

  // Tolerate both shapes: the verdict at the top level, or wrapped under
  // .verdict. The template reads template_errors / slot_warnings at the top,
  // so unwrap when they're one level down.
  if (vr.verdict &&
      vr.template_errors === undefined &&
      vr.slot_warnings === undefined) {
    vr = vr.verdict;
  }

  var template  = HtmlService.createTemplateFromFile('validate_results');
  template.data = vr;

  var html = template.evaluate()
    .setWidth(720)
    .setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}
```

## Step 3 — `main.gs`: tighten `previewTemplate` (defense in depth)

With Step 1 in place this branch is already correct, but this makes the container itself refuse to show a passing modal for an empty result — so if the library ever regresses, the symptom can't come back silently.

**Find:**
```js
  if (r.ok && r.data && r.data.fileContent) {
    showTemplatePreview_(r.data);                        // valid: saved-to-Drive notice
  } else if (r.ok && r.data && r.data.validationResult) {
    showValidationResults_(r.data.validationResult);     // invalid: reuse Validate's modal
  } else {
    showResult_(r);                                      // hard failure
  }
```

**Replace with:**
```js
  if (!r.ok) { showResult_(r); return; }

  var d = r.data || {};
  if (d.fileContent) {
    showTemplatePreview_(d);                             // valid: download modal
    return;
  }

  // Only show the validation modal when the verdict actually says invalid.
  // A missing file with a passing/absent verdict is a build error, not a
  // validation outcome.
  var verdict = d.validationResult || {};
  var status  = String(verdict.status || '').toLowerCase();
  if (status === 'invalid' || status === 'fail') {
    showValidationResults_(verdict);
  } else {
    showResult_(r);
  }
```

## Then test, in this order

First run **Validate configuration**. One of three things happens, and each tells you something specific:

- *Modal opens with the right errors/warnings* — validate's shape matches the template, you're done.
- *Plain alert "Validation – failed at endpoint/config…"* — the call itself is failing. The most likely cause given last session's rename is the `_developer_settings` row: confirm it's `apiPlatformToken`, not still `previewApiToken`. The alert text names the stage.
- *Modal opens but always says "passed"* even on config you know is broken — the recipe's field names aren't `template_errors`/`slot_warnings`. Step 2's unwrap handles *nesting* but not *renaming*; if it's renaming, that's the one remaining thing I'd need the actual field names for.

Then run **Preview template**. With the `veryhidden` build bug still outstanding you should now get the "failed at build" alert with a correlation ID — not a false "passed" modal. That's the correct behavior until the Workato-side `"veryHidden"` casing fix lands; once it does and a real file comes back, you'll get the download modal.

The reason I can give you concrete steps without the log is that Steps 1–3 are correct for *both* response shapes — the only case they don't cover is the recipe using entirely different field names than the template expects, which is the one thing the log would disambiguate. If you hit that third bullet above, grab the `Preview raw:` line from `_script_logs` and I'll give you the exact field-name mapping.
