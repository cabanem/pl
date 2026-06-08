Found it — and it was hiding in the code, not the wire. The updated `_extractVerdict` you sent has the throw built into it:

```js
var v = (parsed.verdict && parsed.response.validate_summary) ||
         parsed.verdict || parsed;
```

The `&&` short-circuit is the bug. When `parsed.verdict` is truthy, JS proceeds to evaluate `parsed.response.validate_summary` — but if `parsed.response` is `undefined`, reading `.validate_summary` off it throws `Cannot read properties of undefined (reading 'validate_summary')`. That's your exact error, verbatim. `write`'s own try/catch swallows it and returns `{ok:false}`, which is why you see the non-fatal warning.

Two things that error proves about the failing response: `parsed.verdict` exists and is truthy, and `parsed.response` does **not** exist. So wherever the verdict actually lives, it is *not* at `parsed.response.validate_summary` — that path can only ever throw.

**The part you may not have noticed: the modal is currently lying.** In `Validate.run`, `verdict` is declared three times now, and the live one (the third, just before the return) is `response.parsed.response.validate_summary || {}` → evaluates to `{}`. The container does `if (r.data.validationResult) showValidationResults_(...)`, and `{}` is truthy, so it renders the modal — which finds no `checks` and prints "Validation passed. No errors or warnings." On a config with real errors you'd get a green modal and never see the write warning (warnings only render on the `showResult_` branch). So the in-sheet write failing and the modal showing a false pass are the *same* root cause: both point at a `validate_summary` location that isn't there.

I still don't have the raw response body (the `Validate parsed full:` line), so I'm not going to bet on a single location. Instead the fix resolves the verdict through an ordered search of the known candidate locations and accepts the first that actually looks like a verdict (carries a `checks` array). It can't throw, and it can't false-green — if nothing matches, it returns null and the caller degrades honestly.

**Patch A — `000_ValidationReport.js`.** Replace the whole `_extractVerdict`:

```js
// The verdict object (status + checks[] + warnings[]) has been seen at
// several wire locations depending on how the endpoint's response schema
// is shaped. Try each known location and accept the first that looks like
// a verdict (carries a checks array). Returning the SAME object the modal
// reads keeps the in-sheet report and showValidationResults_ in agreement.
// If none match, return null — the caller surfaces that as a warning rather
// than writing a misleading empty/zero-row result.
ValidationReport._extractVerdict = function(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  var r = parsed.response || {};            // guard: parsed.response may be absent
  var candidates = [
    parsed.verdict,            // Preview + original Validate contract
    r.validate_summary,        // Validate "response" envelope
    parsed.validate_summary,   // top-level validate_summary
    parsed                     // fully flat
  ];

  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (v && typeof v === 'object' && Array.isArray(v.checks)) return v;
  }
  return null;
};
```

The single substantive change vs. yours: `parsed.response.validate_summary` (throws when `parsed.response` is absent) becomes `r.validate_summary` with `r = parsed.response || {}`, and it's an ordered search instead of an `||` chain that conflated *whether `verdict` exists* with *where the data lives*.

**Patch B — `007_Validate.js`.** Two edits. First, replace the guard-plus-triple-`verdict` block:

```js
    if (!response.parsed) {
      var err = new Error('Validate endpoint returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 1000));
      err.stage = 'endpoint-response';
      throw err;
    }

    // Resolve the verdict ONCE, through the same function the in-sheet writer
    // uses, so the modal (showValidationResults_) and _validation_results read
    // the identical object. May be null when no recognizable verdict is found;
    // the container's `if (r.data.validationResult)` guard then falls back to
    // the plain success alert instead of rendering a misleading empty modal.
    var verdict = ValidationReport._extractVerdict(response.parsed);

    // Persist the verdict in-sheet so findings live in the workbook, not just the modal.
    // A write failure must not fail a validation that already succeeded (surface it as a Result warning instead)
    var reportWarnings  = [];
    var report          = ValidationReport.write(ss, response.parsed, correlationId);
```

Then delete the leftover third declaration further down — replace:

```js
    var noteBlock = notes.length ? '\n\nNote: ' + notes.join(' ') : '';
    var verdict   = (response.parsed && response.parsed.response && response.parsed.response.validate_summary) || {};

    return Result.ok({
```

with:

```js
    var noteBlock = notes.length ? '\n\nNote: ' + notes.join(' ') : '';

    return Result.ok({
```

After both edits `verdict` is declared exactly once, the modal and the sheet read the same object, and `data.validationResult` is either a real verdict or `null` (which routes cleanly to `showResult_`).

Two forward notes, since you like knowing the mechanism rather than just the green light:

The candidate list is a stopgap for not knowing the wire shape. Drop one untruncated line — `log('INFO', 'Validate parsed full: ' + JSON.stringify(response.parsed));` — right after the new `var verdict = …`, run once, and the `keys=` will tell you the true location. Then you can collapse the resolver to that single path and delete the rest, which is the elegant end state.

Second: once findings start writing, check the detail rows. Your new `_toRows` sources details from a separate `verdict.warnings[]` array keyed by `check_name`, with `checks[]` carrying only status. If the actual verdict instead carries details inline on `checks[].details`, you'll get summary rows with empty Entity/Name/Issue columns — that's a one-line adjustment in `_toRows`, but it's downstream of getting extraction right, so confirm the write succeeds first.
