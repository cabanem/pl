Found it. The chain snapped in a very specific place, and it's exactly the "one file kept the update, another lost it" pattern. Let me confirm the failure mode by checking the runner and the write path.The extraction itself is clean — that's worth saying first. Your library shim (`Toolkit.newSheets({ log: AppLog })`, and `SheetService.write` resolving the sheet name + header style from config before delegating) is *exactly* the config-tendril cut we talked about. That part is right. The seam break is unrelated to the library boundary. Let me confirm the last link, then I'll give you the precise diagnosis.Found it, and it's a textbook "one file kept the change, the others lost it" split. The library extraction is not the culprit — the seam substrate got half-reverted along the way. Here's the chain, with what survived and what didn't:

- **Link 1 — Config header (`CALL_EDGES`): kept the update.** 12 columns, with a Child-project column at position 12 (→ column L). ✓
- **Link 2 — Mapper (`mapCallEdgesToRows`, ~line 1091): reverted.** Old 5-parameter signature, emits **11** columns — no `recipeProjectMap`, no Child Project field. ✗
- **Link 3 — Runner (`InventorySyncRunner`, ~lines 1566/1608): reverted.** Never builds `recipeProjectMap` (it appears nowhere in the app), and calls the mapper with 5 args. ✗
- **Link 4 — Seams view (`_ensureSeamsView_`, ~line 2841): kept the update.** Reads column **C** (parent project) and column **L** (child project) and filters `C <> L`. ✓

So the header declares 12 columns but the mapper now produces 11. When the runner assembles `callEdgeRows = [12-col header, ...11-col data]` and hands it to `write`, the library computes `numCols = rows[0].length = 12` and calls `setValues` on a 12-wide range with 11-wide rows — which **throws** "The number of columns in the data does not match… values has 11 but the range has 12." The one case where it *doesn't* throw is a workspace with zero call edges in the first 100 recipes: then it's just the header, no error, but column L is empty forever, so the Seams view always reports "cleanly isolated." Either way, seams are dead because **column L never gets written.**

## The fix — restore links 2 and 3

**Mapper** (replace the current `mapCallEdgesToRows`):

```js
static mapCallEdgesToRows(recipe, edges, projectMap, folderMap, recipeNameMap, recipeProjectMap = null) {
  const projectName = DataMapper._safeLookup(projectMap, recipe.project_id);
  const folderName = DataMapper._safeLookup(folderMap, recipe.folder_id);

  return (edges || []).map(e => {
    const childProject = recipeProjectMap
      ? (recipeProjectMap[String(e.child_recipe_id || "")] || "")
      : "";
    return [
      String(e.parent_recipe_id || recipe.id || ""),
      String(e.parent_recipe_name || recipe.name || ""),
      projectName,
      folderName,
      String(e.step_path || ""),
      String(e.step_name || ""),
      String(e.branch_context || ""),
      String(e.provider || ""),
      String(e.child_recipe_id || ""),
      DataMapper._safeLookup(recipeNameMap, e.child_recipe_id),
      String(e.id_key || ""),
      childProject
    ];
  });
}
```

**Runner** — build the map after `const recipeNameMap = ...` (~line 1568):

```js
const recipeProjectMap = Object.fromEntries(
  (recipes || []).map(r => [String(r.id), projectMap[String(r.project_id)] || ""])
);
```

…and pass it as the 6th arg (~line 1608):

```js
DataMapper.mapCallEdgesToRows(recipe, callEdges, projectMap, folderMap, recipeNameMap, recipeProjectMap)
```

That realigns the data to 12 columns, so the write succeeds and column L fills in.

## Two small nits while you're in there

- **Config header, position 12** is `"Child project"` (lowercase *p*). Your `_applyHeaderNotes_` looks up `"Child Project"` (capital *P*), so `indexOf` returns −1 and that tooltip silently never applies. Capitalize it to `"Child Project"` to bring the tooltip back.
- **Config header, position 3** is still `"Project"`; the seam design renamed it `"Parent Project"` for clarity now that there are two project columns. Purely cosmetic — the view keys off column letters, not the name — but worth doing for readability.

## Confirming the fix

Run the hermetic test suite (`runAllTests`). The header-vs-mapper width check will currently be red — "CALL_EDGES: mapper emits 11 cols, header declares 12" — which is precisely this bug. After the mapper edit it goes green, which is your one-command confirmation before you even sync. That test existing is why this was a five-minute find rather than a spelunking session.

If you want, share how the other context handled the mapper during extraction and I can tell you whether it was dropped or overwritten from an older snapshot — but you don't need that to fix it; the four edits above are the whole repair.
