Two separate things, and only one of them is fixable from the code you pasted — so let me split them.

## The extra sheets: why they breed

The mechanism is in `SheetService.write()` and the `getOrCreate*` helpers — they all do `getSheetByName(name) || insertSheet(name)`, and `name` comes from `SchemaDef.SHEETS`. The lookup is purely by *name*. So the moment you change a value in `SchemaDef.SHEETS` — say `RECIPES` went from `"Recipes"` to `"Inventory_Recipes"` at some point — the next run can't find the old tab, creates a brand-new one under the new name, and the old tab just sits there orphaned forever. Your schema clearly went through a rename pass (the `Inventory_*` / `Analysis_*` / `Output_*` prefixes), so every rename left a ghost. Add `test_results` (written by the test runner) and you've got a pile.

Here's a non-destructive audit + safe archive. Drop it in a new file (`40_Diagnostics.gs`):

```js
/**
 * @file 40_Diagnostics.gs
 * @description Container hygiene: find tabs that aren't part of the current schema.
 */
class SheetAudit {
  /** Every tab name the app legitimately owns, derived from the live schema. */
  static knownNames_() {
    const known = new Set(Object.values(SchemaDef.SHEETS));
    known.add("test_results"); // written by TestRunner
    return known;
  }

  /** Non-destructive. Classifies every tab in the container. */
  static report() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const known = this.knownNames_();
    const result = { known: [], unknown: [] };

    ss.getSheets().forEach(s => {
      const name = s.getName();
      (known.has(name) ? result.known : result.unknown).push(name);
    });

    console.log("KNOWN (current schema):\n  " + result.known.join("\n  "));
    console.log("UNKNOWN (orphan candidates):\n  " + (result.unknown.join("\n  ") || "(none)"));
    ss.toast(`${result.unknown.length} orphan tab(s). See logs.`, "Sheet audit", 5);
    return result;
  }

  /** Safe cleanup: renames unknown tabs to "_ARCHIVE_..." and hides them. Nothing deleted. */
  static archiveUnknown() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const known = this.knownNames_();
    const archived = [];

    ss.getSheets().forEach(sh => {
      const name = sh.getName();
      if (known.has(name) || name.startsWith("_ARCHIVE_")) return;
      sh.setName(`_ARCHIVE_${name}`);
      sh.hideSheet();
      archived.push(name);
    });

    console.log(`Archived ${archived.length}: ${archived.join(", ") || "(none)"}`);
    return archived;
  }
}

function auditSheets()        { SheetAudit.report(); }
function archiveOrphanSheets() { SheetAudit.archiveUnknown(); }
```

Run `auditSheets()` first, read the logs, and you'll see exactly which tabs aren't in the current schema before you touch anything. If the unknown list looks right, run `archiveOrphanSheets()` — it renames + hides rather than deletes, so you confirm visually and remove by hand. The rename is the durable signal; the *hide* is cosmetic and worth knowing about: `DashboardService.applyVisibility` calls `sh.showSheet()` on **every** tab in advanced mode, so it'll un-hide the archived ones. The `_ARCHIVE_` prefix is what keeps them identifiable regardless.

One related bit of clutter while you're in here: `DataMapper.mapProcessNodesToRows` and `mapProcessEdgesToRows` are dead — there are no `PROCESS_NODES`/`PROCESS_EDGES` keys in `SchemaDef.SHEETS` and nothing calls them, even though `PROCESS_MAP_EXPORT_TABLES: true` sits in config implying they should. Safe to delete both methods and that config flag.

## The "two scripts": mostly a terminology trap

A Google Sheet (your container) can hold **at most one bound script project** — you can't actually attach two. So before cleaning anything, it's worth pinning down what you're seeing, because there are three different things people mean by this:

The three IDs in your headers (`WorkatoLib`, `WorkatoGraphLib`, `GeminiLib` → the `1sl2Zfkg…`, `1zQz8lK…`, `1mc_Jm9F…` projects) are **separate standalone library projects, by design.** They're supposed to be distinct. Leave them.

What *is* redundant inside your one bound project is the two test files: `test.js` (`runAllTests`, with the `TestRunner`/`Assert`/`Fixtures`/Fake-service framework) and `tests.js` (`runUnitTests`, with `SimpleTestRunner`). Two parallel test harnesses with overlapping DataMapper coverage. Keep `test.js` — it's the stronger one (test doubles, the integration test, the call-edge/graph logic that's the actually-hard part) — and fold in the one thing `tests.js` covers that it doesn't: the `mapDebugLogsToRows` chunking test. Then delete `tests.js`.

So before I go further: when you say two scripts "joined to the same container," do you mean two **files inside the one project** (the `test.js`/`tests.js` situation above), or two **separate project entries** showing up in your Apps Script dashboard at script.google.com? The second would point at a copied-project or leftover standalone script, which is a different cleanup entirely.
