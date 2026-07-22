Found it — the failure is in the `1.4 → 1.5` entry of `MIGRATION_CHAIN`, and it's actually three defects stacked on top of each other, plus one latent bug that would bite *after* migration succeeds. No shims needed; this is entirely library-side.

## Why it's failing right now

`Migrations.run` executes each step via `step.run(ss)`. The 1.5 entry declares its function under the key **`mutate`**, not `run`. So `step.run` is `undefined`, the call throws `TypeError: step.run is not a function`, the loop's catch pushes it to `skipped`, and the chain stops. Your `_script_logs` should show exactly: `Migration v1.4 -> v1.5 failed: step.run is not a function`, and provision stays blocked by the `isMigrationNeeded` gate.

One reassuring mechanism detail: the throw happens *before any sheet write*, so 1.4 workbooks are untouched — schema stamp still reads 1.4, and re-running after the fix is clean.

Two more failures are hiding behind that one, so renaming `mutate` → `run` alone would just move the crash:

1. **Signature mismatch.** The step is written as `(ss, notes)` and pushes into `notes`, but the framework passes only `ss`. `notes` would be `undefined` → `Cannot read properties of undefined (reading 'push')`. The chain contract is: take `ss`, own your local `changed`/`notes` arrays, return `{ changed, notes }`.
2. **`findCellByText` doesn't exist.** The library helper is `Util.findLabelCell`. Because of `&&` short-circuiting, the ReferenceError fires precisely in the case the migration exists to handle — label absent — since `findValueRightOfLabel` returns `null` then, forcing evaluation of the second operand.

And the idempotency test itself is subtly wrong: `findValueRightOfLabel` returns `null` for both "label missing" and "label present but value blank," so it can't be the append trigger. Presence of the *label cell* is the correct test — mirror the 1.4 step's `newPresent` pattern.

## The latent bug: valueOffset disagreement

The migration installs the date validation in **column D** (offset 2 from the label in B), matching the `expectedDate` precedent from the 1.3 step. But the `CUSTOMER_FIELDS` registry declares `lastDayForSubmission` with **`valueOffset: 1`** (column C). The step also doesn't call `Customer.ensureNamedRanges`, so `cfg_last_day_for_submission` gets anchored lazily by heal-on-read — at `label.col + 1` = **C**.

Net effect after a "successful" migration: the analyst fills D (the only cell with the date picker), `Customer.read` reads C, gets blank, and preflight throws "Required customer fields missing: Last day for submission" while the analyst is staring at a filled-in date. That's the exact failure class your registry comment already warns about under ⚠ RECONCILIATION PENDING. Fix: pick one layout and make migration, registry, and the template agree. I'd go D + `valueOffset: 2` for consistency with `expectedDate`'s appended-row shape — but verify against the live template, since workbooks minted from an updated template (where the label already exists and the append is skipped) must also match.

## Corrected step

```javascript
// 1.4 ->> 1.5
{
  from: '1.4',
  to:   '1.5',
  run:  function(ss) {
    var changed = [];
    var notes   = [];
    var sheet   = ss.getSheetByName(DEFAULT_SHEETS.customer);
    if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.5.');

    // Idempotency: presence of the LABEL is the test — findValueRightOfLabel
    // cannot distinguish "label absent" from "label present, value blank".
    if (Util.findLabelCell(sheet, Labels.lastDayForSubmission)) {
      notes.push('"' + Labels.lastDayForSubmission + '" already present; append skipped (idempotent).');
    } else {
      var newRow = sheet.getLastRow() + 1;   // append below content — never at/above positional reads
      sheet.getRange(newRow, 2).setValue(Labels.lastDayForSubmission);   // label -> B

      var target = sheet.getRange(newRow, 4);                            // value -> D (offset 2)
      target.clearDataValidations();
      target.setDataValidation(
        SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
      );

      changed.push('Added field row "' + Labels.lastDayForSubmission + '" at row ' + newRow +
                   ' with date validation on D' + newRow + '.');
      notes.push('Last-day value is blank; the analyst must fill D' + newRow +
                 ' before the next provision (preflight will name the field).');
    }

    // Anchor the named range now (mirrors the 1.3->1.4 step) so the read
    // contract doesn't depend on heal-on-read deriving the offset later.
    var nr = Customer.ensureNamedRanges(ss, DEFAULT_SHEETS.customer);
    if (nr.created.length > 0)    changed.push('Created named range(s): ' + nr.created.join(', ') + '.');
    if (nr.unresolved.length > 0) notes.push('Could not anchor: ' + nr.unresolved.map(function(u) {
      return u.rangeName + ' ("' + u.label + '")'; }).join('; '));

    return { changed: changed, notes: notes };
  }
}
```

Plus the one-character registry change: `lastDayForSubmission` → `valueOffset: 2` in `CUSTOMER_FIELDS`. (Note `ensureNamedRanges` anchors from that offset on a label hit, which is exactly why the two must agree before this step runs.)

## The systemic fix

This bug class — a chain entry that doesn't honor the contract — is invisible to `dryRun` by design, since dry-run reports the path without executing steps. But you already have the right pattern in the library: the load-time integrity guards at the bottom of `003_Schema.gs`. Extend it to the chain:

```javascript
// --- Load-time guard: chain contract ---------------------------------
(function() {
  for (var i = 0; i < MIGRATION_CHAIN.length; i++) {
    var s = MIGRATION_CHAIN[i];
    if (!s.from || !s.to || typeof s.run !== 'function') {
      throw new Error('Migrations.gs: MIGRATION_CHAIN[' + i + '] (' +
        (s.from || '?') + ' -> ' + (s.to || '?') +
        ') must declare from, to, and run(ss). Found keys: [' + Object.keys(s).join(', ') + '].');
    }
    if (i > 0 && s.from !== MIGRATION_CHAIN[i - 1].to) {
      throw new Error('Migrations.gs: MIGRATION_CHAIN[' + i + '] from "' + s.from +
        '" does not continue from "' + MIGRATION_CHAIN[i - 1].to + '".');
    }
  }
})();
```

This would have converted today's runtime failure into a load-time explosion the moment the file saved. One caveat on scope: resist the temptation to also assert `last step's .to === SDC_SCHEMA_VERSION` in this IIFE — `008_Version.gs` evaluates after `002_Migrations.gs` in GAS file order, so that constant isn't assigned yet at guard time. If you want that check (it'd catch "bumped Version.js, forgot the migration step"), put it at the top of `Migrations.run` where everything's loaded.

Rollout order: fix the step, reconcile the offset, add the guard, save, then re-run "Migrate workbook schema" on a 1.4 workbook — it should stamp 1.5, report the appended row in `changed`, and unblock provision. Second run should report the idempotent skip. Two cosmetic nits while you're in there: the step uses the `'1_customer'` literal where siblings use `DEFAULT_SHEETS.customer`, and `const`/template literals against the library's otherwise-ES5 style — harmless in V8, just inconsistent.
