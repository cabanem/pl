/**
 * @file 11_Feature_ChangeLedger.gs
 * @description Nightly drift detection. FIngerprints the entire workspace, journals what has changed,
 *              publishes the ambiguity report. First consumer of OrderLib.
 *
 * Owns tabs: FINGERPRINTS, EDGE_STATE (state), CHANGE_LOG (journal), AMBIGUITY.
 */
class ChangeLedgerRunner {
  run(ctx) {
    try {
      const now = new Date().toISOString();

      // 1. Fetch full workspace 1x.
      const recipes = ctx.client.fetchPaginated('recipes');
      // ***UPDATED*** was `GraphLIb.newAnalyzer(ctx.client)` — typo (ReferenceError at runtime), and the
      // manifest binds the library as WorkatoGraphLib anyway. Reuse the app's injected analyzer instead:
      // RecipeAnalyzerService now delegates primeCache (see 03_WorkatoServices.js) and already delegates
      // getCallEdges, which is all OrderLib.buildCorpusGraph needs.
      ctx.analyzerService.primeCache(recipes);

      // 2. Generate corpus edges > findings via OrderLib.
      const orderer = OrderLib.newOrderer({ strict: false });
      const manifest = recipes.map(r => ({ id: r.id, name: r.name }));
      const graph = orderer.buildCorpusGraph(ctx.analyzerService, manifest); // ***UPDATED*** pass the service (duck-typed analyzer)

      // 3. Record per-recipe code fingerprints (current).
      const curr = new Map();
      recipes.forEach(r => {
        const code = (typeof r.code === 'string') ? r.code : JSON.stringify(r.code || {});
        curr.set(String(r.id), { name: r.name || '', fp: ChangeLedgerRunner.sha256_(code) });
      });

      // 4. Read yesterday's state.
      const prev = this.readFingerprints_();
      const prevEdges = this.readEdgeState_();
      // ***UPDATED*** (caught by 52_Tests) The first run must journal ONLY the baseline row.
      // Without this guard, an empty prev makes diffRecipes_ report every recipe as 'added'
      // alongside the baseline — the harness flagged 4 journal entries where the wiring guide's
      // three-run test promises exactly 1.
      const isBaseline = prev.size === 0;

      // 5. Diff both dimensions.
      const recipeRows = isBaseline ? [] : this.diffRecipes_(prev, curr, now);
      const edgeDiff = isBaseline ? { added: [], removed: [] } : orderer.diffEdges(prevEdges, graph.edges);
      const edgeRows = []
        .concat(edgeDiff.added.map(k => [now, 'edge', 'added', this.edgeLabel_(k, curr), k]))
        .concat(edgeDiff.removed.map(k => [now, 'edge', 'removed', this.edgeLabel_(k, curr), k]));

      // 6. Write to journal (append-only).
      const journal = recipeRows.concat(edgeRows);
      if (isBaseline) { // ***UPDATED***
        journal.push([now, 'system', 'baseline', `${recipes.length} recipes, ${graph.edges.length} edges fingerprinted`, '']);
      }
      if (journal.length) this.appendRows_('CHANGE_LOG',
        ['date_iso', 'kind', 'change', 'subject', 'detail'], journal);

      // 7. Write new state for tomorrow.
      this.writeState_(ctx, 'FINGERPRINTS', ['recipe_id', 'name', 'code_fp'],
        [...curr.entries()].map(([id, v]) => [id, v.name, v.fp]));
      this.writeState_(ctx, 'EDGE_STATE', ['caller_id', 'callee_id'], graph.edges);
      this.writeState_(ctx, 'AMBIGUITY', ['date_iso', 'level', 'code', 'detail'],
        graph.findings.map(f => [now, f.level, f.code, f.detail]));

      ctx.logger.notify(
        `Change ledger: ${journal.length} entry/entries; corpus fp ` +
        `${orderer.fingerprint(graph.edges).slice(0, 12)}...; ` +
        `${graph.findings.length} finding(s).`);


    } catch (e) {
      AppHelpers.handleError(e);
    }
  }


  // --- Sheet internals ------------------------------------------------
  /** Clear and write */
  writeState_(ctx, tab, header, rows) {
    ctx.sheetService.write(tab, [header].concat(rows));
  }
  // ***UPDATED*** resolve SchemaDef keys ('FINGERPRINTS') to configured tab names ('_Fingerprints').
  // Without this, SheetService writes land on the configured names while these direct readers look for
  // tabs literally named after the keys — so state never round-trips and every night looks like baseline.
  sheetName_(tabKey) {
    return AppConfig.get().SHEETS[tabKey] || tabKey;
  }
  /** Append to journal */
  appendRows_(tab, header, rows) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(this.sheetName_(tab)); // ***UPDATED*** key -> configured name
    if (!sh) { sh = ss.insertSheet(this.sheetName_(tab)); sh.appendRow(header); sh.setFrozenRows(1); } // ***UPDATED***
    if (sh.getLastRow() === 0) { sh.appendRow(header); sh.setFrozenRows(1); }
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }

  readFingerprints_() {
    const out = new Map();
    this.readRows_('FINGERPRINTS').forEach(r => {
      if (r[0]) out.set(String(r[0]), { name: String(r[1] || ''), fp: String(r[2] || '') });
    });
    return out;
  }

  readEdgeState_() {
    return this.readRows_('EDGE_STATE')
      .filter(r => r[0] && r[1])
      .map(r => [String(r[0]), String(r[1])]);
  }

  readRows_(tab) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(this.sheetName_(tab)); // ***UPDATED*** key -> configured name
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  }


  // --- DIFF LOGIC -----------------------------------------------------
  diffRecipes_(prev, curr, now) {
    const rows = [];
    curr.forEach((v, id) => {
      const p = prev.get(id);
      if (!p) rows.push([now, 'recipe', 'added', v.name, id]);
      else if (p.fp !== v.fp) rows.push([now, 'recipe', 'modified', v.name, id]);
    });
    prev.forEach((v, id) => {
      if (!curr.has(id)) rows.push([now, 'recipe', 'removed', v.name, id]);
    });
    return rows;
  }

  /** "1234->5678" → "PRV-01 … -> INV-03 …" where names are known. */
  edgeLabel_(key, curr) {
    const [a, b] = String(key).split('->');
    const n = id => (curr.get(id) || {}).name || id;
    return `${n(a)} -> ${n(b)}`;
  }

  // ***UPDATED*** (new) ids of recipes journaled as added/modified in the last `sinceDays` days.
  // Feeds cron_maps (regenerate maps only for what changed) and the weekly doc runners.
  static changedRecipeIds(sinceDays) {
    const cutoff = Date.now() - Number(sinceDays || 1) * 24 * 60 * 60 * 1000;
    const ids = new Set();
    new ChangeLedgerRunner().readRows_('CHANGE_LOG').forEach(r => {
      const when = Date.parse(String(r[0] || ''));
      if (isNaN(when) || when < cutoff) return;
      if (String(r[1]) !== 'recipe') return;
      const change = String(r[2] || '');
      if ((change === 'added' || change === 'modified') && r[4]) ids.add(String(r[4]));
    });
    return [...ids];
  }

  /** Same digest as OrderLib's default, local so the ledger has no reach into library internals. */
  static sha256_(str) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
    return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  }
}

// ENTRY POINT (MENU)
/** Menu / manual entry point, matching the app's command style. */
function runChangeLedger() {
  new ChangeLedgerRunner().run(AppFactory.createContext());
}
