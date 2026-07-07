It is a sibling — same shape as `View_Seams`: a focused, formula-driven list plus a summary count. Let me anchor the edits to your *current* file rather than my older copies, since we've seen how fast these drift. Let me confirm the exact spots to hook into.All anchors confirmed and the structure matches. Let me apply the wiring to a working copy and validate it before handing you the snippets.Anchors and structure all confirmed. Let me wire it into a working copy and syntax-check.Wired and the whole app parses clean with it in. Because you're in separate clasp files, here are the edits located by class — same footprint as `View_Seams`.

## `SchemaDef` (config, `01`)

Add to `SHEETS`, right after the `SEAMS` line:
```js
UNUSED:         "View_Unused",
```

Add to `HEADERS`, right after the `SEAMS` header line:
```js
UNUSED: [ "Recipe ID", "Name", "Status", "Last run at", "Project", "Why" ],
```

## `DashboardService` (`30`)

In `ensureAll`, after `this._ensureSeamsView_(ss, ctx);`:
```js
this._ensureUnusedView_(ss, ctx);
```

In `_applyTabColors_`, extend the primary line:
```js
DASHBOARD_HOME: C.primary, VIEW_RECIPES: C.primary, SEAMS: C.primary, UNUSED: C.primary,
```

In `applyVisibility`, after `cfg.SHEETS.SEAMS,` in the `visibleInBasic` set:
```js
cfg.SHEETS.UNUSED,
```

In `_ensureDashboardHome_`, the counts array — give the `Cross-project seams` row a trailing comma and add after it:
```js
["Likely-dead recipes", `=IFERROR(SUMPRODUCT((${cfg.SHEETS.VIEW_RECIPES}!A2:A<>"")*(${cfg.SHEETS.VIEW_RECIPES}!I2:I="Standalone")*(((${cfg.SHEETS.VIEW_RECIPES}!C2:C="STOPPED")+(${cfg.SHEETS.VIEW_RECIPES}!F2:F="NEVER"))>0)),0)`],
```

And the quick links, after the `D13` seams link:
```js
DashboardService._setSheetLink_(sh, ss, "D14", cfg.SHEETS.UNUSED, "Go to View_Unused");
```

Finally, the new method — paste it next to `_ensureSeamsView_`:

```js
// ---------------------------------------------------------------------------------------
// View_Unused (likely-dead recipes: orphaned + idle)
// ---------------------------------------------------------------------------------------
static _ensureUnusedView_(ss, ctx) {
  const cfg = ctx.config;
  const name = cfg.SHEETS.UNUSED || "View_Unused";
  const sh = ctx.sheetService.getOrCreateByName(name);

  if (cfg.DASHBOARD.OVERWRITE_VIEWS) {
    sh.clear();
  }

  // Reuse the Role column already computed on View_Recipes: "Standalone" means
  // zero in- and out-degree (an orphan), so we don't recompute the graph here.
  const vr = cfg.SHEETS.VIEW_RECIPES;

  // Title + one-line summary count.
  sh.getRange("A1").setValue("Likely-dead recipes").setFontWeight("bold").setFontSize(13);
  sh.getRange("A2")
    .setValue("Orphaned (no call edges in or out) AND idle (stopped, or never run). An empty list is good. Note: a running, self-triggered orphan is healthy and will not appear here.")
    .setFontColor("#666666");
  sh.getRange("A3").setValue("Likely-dead recipes:").setFontWeight("bold");
  sh.getRange("B3").setFormula(
    `=IFERROR(SUMPRODUCT((${vr}!A2:A<>"")*(${vr}!I2:I="Standalone")*(((${vr}!C2:C="STOPPED")+(${vr}!F2:F="NEVER"))>0)),0)`
  );

  // Header row (row 5).
  const headers = cfg.HEADERS.UNUSED || [
    "Recipe ID", "Name", "Status", "Last run at", "Project", "Why"
  ];
  sh.getRange(5, 1, 1, headers.length).setValues([headers]);
  sh.getRange(5, 1, 1, headers.length).setFontWeight("bold").setBackground("#d9d9d9");
  sh.setFrozenRows(5);

  // The list: Standalone recipes that are stopped or never-run.
  sh.getRange("A6").setFormula(
    `=IFERROR(FILTER(` +
    `{${vr}!A2:A,${vr}!B2:B,${vr}!C2:C,${vr}!F2:F,${vr}!D2:D,ARRAYFORMULA(IF(${vr}!F2:F="NEVER","orphan + never run","orphan + stopped"))},` +
    `${vr}!A2:A<>"",` +
    `${vr}!I2:I="Standalone",` +
    `((${vr}!C2:C="STOPPED")+(${vr}!F2:F="NEVER"))>0),` +
    `"No orphaned + idle recipes - nothing looks dead.")`
  );

  try { sh.autoResizeColumns(1, headers.length); } catch (e) {}
}
```

The one design choice worth calling out, because it's the elegant-over-thorough fork: **it reads from `View_Recipes`, not from `Inventory_Recipes` + `Analysis_Call_Edges` directly.** The orphan test is already computed and named there — `Role = "Standalone"` *is* "zero in- and out-degree." So rather than re-deriving degree with a second pair of `COUNTIF`s, the view (and the dashboard count) just reuse the label. It's lighter, it can't drift from what `View_Recipes` shows, and the whole thing collapses to one `FILTER`. The **Why** column then only has to split the two idle reasons ("never run" vs "stopped"), since orphan-ness is already guaranteed by the filter.

Two things to keep in mind, both familiar:

- **This is deliberately the intersection, not "no incoming calls."** A stopped-or-never-run orphan is the dead candidate; a *running* orphan is a healthy self-triggered entry point and is correctly excluded. That runtime axis is what keeps your scheduled recipes out of the list.
- **Same 100-recipe caveat as criticality and seams.** Orphan-ness rides on the call-edge slice (`RECIPE_LIMIT_DEBUG`), so beyond the first 100 recipes treat an entry as a *candidate* to eyeball, not a verdict. At or under 100 recipes it's exact.

It'll show up as a green, Basic-visible tab with its count on the dashboard — and, like Seams, an empty list is the good outcome.
