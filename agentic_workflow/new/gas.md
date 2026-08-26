# SDC Documentation — GAS Wiring Guide

The GCP build guide had seven phases because seven things didn't exist. Here, four things don't exist — and none of them is a platform. The total: **two new script files, two modified classes, four new sheet tabs, zero new infrastructure.** Everything else in the twelve-part design is already running under your account.

Build order (≠ the gap numbers from our conversation, because dependencies):

| Step | Gap | What it adds | Size |
|---|---|---|---|
| 0 | prep | library binding, config keys, schema registration | ½ hr |
| 1 | Gap 2 — memory of yesterday | `ChangeLedgerRunner`: fingerprints, diff journal, ambiguity report | the main event, ~1 file |
| 2 | Gap 3 — the gate | fingerprint-gated AI regeneration + evidence contract | surgical edit |
| 3 | Gap 1 — the clock | time triggers + lock + email-on-failure | 1 small file |
| 4 | Gap 4 — the front door | shared folder + dashboard (v1); web app (v2, optional) | mostly configuration |

Verification discipline carries over from the runbook: every step ends with a proof. The proofs here are cheaper — no IAM, no propagation delays — but the habit is the same.

---

# Step 0 — Preparation (½ hour)

## 0.1 Bind OrderLib into WorkatoSyncApp

The grep finding that started this: the app never references the Orderer. Add the restart-ordering script project as a library to the WorkatoSyncApp project (Editor → Libraries → +), identifier **`OrderLib`**. GraphLib should already be bound (RecipeAnalyzerService depends on it) — confirm its identifier while you're in the dialog; this guide assumes **`GraphLib`**.

Per your own toolkit boundary probe: call through the factories (`OrderLib.newOrderer()`, `GraphLib.newAnalyzer()`) — factory-returned objects cross the library boundary with callable methods; bare class symbols don't. Your README documented the contract; this guide just obeys it.

**Verify:** in the script editor run a scratch function:

```javascript
function probe_orderlib() {
  const o = OrderLib.newOrderer({ strict: false });
  console.log(o.fingerprint([['1','2'],['2','3']]));  // 64-char hex
}
```

## 0.2 Register the four new tabs in SchemaDef

`SheetAudit.archiveUnknown()` archives tabs it doesn't recognize — so if the new sheets aren't registered in `SchemaDef` **before** they first appear, your own maintenance tooling will eat them. Register now:

| Tab | Kind | Columns |
|---|---|---|
| `FINGERPRINTS` | state (overwritten nightly) | recipe_id, name, code_fp |
| `EDGE_STATE` | state (overwritten nightly) | caller_id, callee_id |
| `CHANGE_LOG` | **journal (append-only)** | date_iso, kind, change, subject, detail |
| `AMBIGUITY` | state (overwritten nightly) | date_iso, level, code, detail |

**Verify:** run `auditSheets()` after creating them in Step 1 — all four should report as known.

## 0.3 Config keys

Through `ConfigStore`, the same way existing keys flow:

- `ALERT_EMAIL` — where failure emails go (you, for now)
- `AI_MAX_PER_RUN` — cap on Gemini regenerations per execution (start: `10`)
- `PUBLISH_FOLDER_ID` — the shared Drive folder for generated docs (Step 4)

**Verify:** `dumpAllConfig()` shows all three.

---

# Step 1 — The change ledger (Gap 2: memory of yesterday)

One new file. This is the feature the whole project exists for — *the docs notice changes by themselves* — and it's assembled almost entirely from calls into code you already wrote: `fetchPaginated` → `primeCache` → `buildCorpusGraph` → `fingerprint` / `diffEdges`. The runner adds sheet plumbing and a hash.

Design notes before the code:

- **History-as-diffs, not history-as-snapshots.** `FINGERPRINTS` and `EDGE_STATE` hold only *yesterday*; `CHANGE_LOG` accumulates forever. Sheets-appropriate, and it's the philosophy your Orderer header already states: store the fingerprint, log the diff, make drift an observable event.
- **Hashes only, never code, in sheets.** Recipe code can exceed the 50k-cell limit; the ledger stores 64 hex chars per recipe and nothing else.
- **`buildCorpusGraph` does triple duty**: resolves symbolic refs, dedupes strong edges (feeding `diffEdges`), and emits `findings` — which become the `AMBIGUITY` sheet for free. `strict:false` so ambiguity is reported, not fatal: for documentation, "couldn't resolve" is a fact worth publishing, not a reason to abort.
- **Fingerprint caveat, stated honestly:** the per-recipe hash is over the raw `code` string as the API returns it. If Workato's serialization ever reorders keys without a real change, you'll get a false "modified" — noisy, never silent. If it happens in practice, add a stable-stringify before hashing; don't build it preemptively.
- The fetch duplicates InventorySyncRunner's fetch. At estate scale that's seconds and a rounding error of quota — independence between runners is worth more than the dedup.

## 1.1 The runner — new file `11_Feature_ChangeLedger.gs`

```javascript
/**
 * @file 11_Feature_ChangeLedger.gs
 * @description Nightly drift detection. Fingerprints the estate, journals what
 *              changed, publishes the ambiguity report. First consumer of OrderLib
 *              inside the app.
 * Owns tabs: FINGERPRINTS, EDGE_STATE (state), CHANGE_LOG (journal), AMBIGUITY.
 */
class ChangeLedgerRunner {
  run(ctx) {
    try {
      const now = new Date().toISOString();

      // 1. Fetch the estate once; prime the analyzer so edge extraction is cache-hits.
      //    (primeCache's own contract assumes list payloads carry `code` — the
      //    assumption is yours already; the ledger just inherits it.)
      const recipes = ctx.client.fetchPaginated('recipes');
      const analyzer = GraphLib.newAnalyzer(ctx.client);
      analyzer.primeCache(recipes);

      // 2. Corpus edges + findings via OrderLib.
      const orderer = OrderLib.newOrderer({ strict: false });
      const manifest = recipes.map(r => ({ id: r.id, name: r.name }));
      const graph = orderer.buildCorpusGraph(analyzer, manifest);

      // 3. Per-recipe code fingerprints (current).
      const curr = new Map();
      recipes.forEach(r => {
        const code = (typeof r.code === 'string') ? r.code : JSON.stringify(r.code || {});
        curr.set(String(r.id), { name: r.name || '', fp: ChangeLedgerRunner.sha256_(code) });
      });

      // 4. Yesterday's state.
      const prev = this.readFingerprints_();     // Map<id, {name, fp}>
      const prevEdges = this.readEdgeState_();   // Array<[caller, callee]>

      // 5. Diff both dimensions.
      const recipeRows = this.diffRecipes_(prev, curr, now);
      const edgeDiff = orderer.diffEdges(prevEdges, graph.edges);
      const edgeRows = []
        .concat(edgeDiff.added.map(k =>   [now, 'edge', 'added',   this.edgeLabel_(k, curr), k]))
        .concat(edgeDiff.removed.map(k => [now, 'edge', 'removed', this.edgeLabel_(k, curr), k]));

      // 6. Journal — append-only, and journal BEFORE overwriting state.
      const journal = recipeRows.concat(edgeRows);
      if (prev.size === 0) {
        journal.push([now, 'system', 'baseline',
          `${recipes.length} recipes, ${graph.edges.length} edges fingerprinted`, '']);
      }
      if (journal.length) this.appendRows_('CHANGE_LOG',
        ['date_iso', 'kind', 'change', 'subject', 'detail'], journal);

      // 7. New state for tomorrow.
      this.writeState_(ctx, 'FINGERPRINTS', ['recipe_id', 'name', 'code_fp'],
        [...curr.entries()].map(([id, v]) => [id, v.name, v.fp]));
      this.writeState_(ctx, 'EDGE_STATE', ['caller_id', 'callee_id'], graph.edges);
      this.writeState_(ctx, 'AMBIGUITY', ['date_iso', 'level', 'code', 'detail'],
        graph.findings.map(f => [now, f.level, f.code, f.detail]));

      ctx.logger.notify(
        `Change ledger: ${journal.length} entrie(s); corpus fp ` +
        `${orderer.fingerprint(graph.edges).slice(0, 12)}…; ` +
        `${graph.findings.length} finding(s).`);
    } catch (e) {
      AppHelpers.handleError(e);
    }
  }

  // ----- Sheet plumbing ---------------------------------------------------

  /** Clear-and-write via the service everyone else uses (the contract seam). */
  writeState_(ctx, tab, header, rows) {
    ctx.sheetService.write(tab, [header].concat(rows));
  }

  /** Append-only journal. Same shape as SheetService.appendDebugRows — if you
   *  generalize that method to appendRows(tab, rows), delete this and call it. */
  appendRows_(tab, header, rows) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(tab);
    if (!sh) { sh = ss.insertSheet(tab); sh.appendRow(header); sh.setFrozenRows(1); }
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
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  }

  // ----- Diff logic -------------------------------------------------------

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

  /** Same digest as OrderLib's default, local so the ledger has no reach into
   *  library internals. */
  static sha256_(str) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
    return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  }
}

/** Menu / manual entry point, matching the app's command style. */
function runChangeLedger() {
  new ChangeLedgerRunner().run(AppFactory.createContext());
}
```

## 1.2 Prove it — the three-run test

1. **Run 1 (baseline):** `runChangeLedger()`. Verify: four tabs exist; `CHANGE_LOG` has one `system | baseline` row; `FINGERPRINTS` has one row per recipe; `AMBIGUITY` lists whatever the extractor honestly couldn't resolve (read it — it's your estate's first ambiguity report, and `EXTERNAL_CALLEE` rows are usually real discoveries).
2. **Run 2 (quiet day):** run again immediately. Verify: `CHANGE_LOG` gained **nothing**. A ledger that logs on quiet days is noise; this one doesn't.
3. **Run 3 (real change):** make one trivial edit to any recipe in Workato, run again. Verify: exactly one `recipe | modified` row naming it — and if your edit touched a call step, the matching `edge` rows. **This is the moment the original problem closes**: a stakeholder change just announced itself.

Then `auditSheets()` — the four tabs are known, not archive candidates.

---

# Step 2 — The gate (Gap 3: regenerate only what changed)

`AiAnalysisRunner` currently rewrites the whole `AI_ANALYSIS` sheet every run. The gate makes it regenerate only recipes whose fingerprint moved — which solves cost, output churn, and the 6-minute ceiling with one mechanism. This is a surgical edit to your class, so it's expressed as the pattern plus the two things to confirm, not a rewrite.

**Confirm first (one minute in the sheet):** which column of `AI_ANALYSIS` holds the recipe id (assumed `0` below), and the current row width (the gate appends two columns after it: `source_fp`, `generated_at` — extend the header row and any `SchemaDef` entry accordingly).

Add the helper (same file as the runner or alongside it):

```javascript
/** Gate for fingerprint-driven regeneration. Reads FINGERPRINTS (the ledger's
 *  output) and the existing AI_ANALYSIS rows; splits the estate into
 *  {regen, keep}. idsOverride always forces regeneration for those ids —
 *  the manual path stays manual. */
class AiGate {
  static plan(recipes, idsOverride, opts = {}) {
    const ID_COL = opts.idCol ?? 0;
    const FP_COL = opts.fpCol;             // index of source_fp in AI_ANALYSIS
    const cap = Number(opts.maxPerRun || 10);

    const fp = new Map();                  // id -> current code_fp
    new ChangeLedgerRunner().readFingerprints_()
      .forEach((v, id) => fp.set(id, v.fp));

    const existing = new Map();            // id -> full existing row
    new ChangeLedgerRunner().readRows_('AI_ANALYSIS')
      .forEach(r => { if (r[ID_COL]) existing.set(String(r[ID_COL]), r); });

    const forced = new Set((idsOverride || []).map(String));
    const regen = [], keep = [];
    recipes.forEach(r => {
      const id = String(r.id);
      const row = existing.get(id);
      const stale = !row || String(row[FP_COL] || '') !== String(fp.get(id) || '');
      if (forced.has(id) || stale) regen.push(r);
      else keep.push(row);
    });

    return {
      regen: regen.slice(0, cap),
      deferred: Math.max(0, regen.length - cap),
      keep,
      fpOf: id => fp.get(String(id)) || ''
    };
  }
}
```

Then, inside `AiAnalysisRunner.run`, the shape of the change:

```javascript
const cfg = /* your ConfigStore read */;
const plan = AiGate.plan(recipes, idsOverride,
  { idCol: 0, fpCol: /* confirmed index */, maxPerRun: cfg.AI_MAX_PER_RUN });

// Loop over plan.regen instead of all recipes; on each generated row, set
// row[fpCol] = plan.fpOf(recipe.id) and row[fpCol + 1] = new Date().toISOString().
// Final write: ctx.sheetService.write('AI_ANALYSIS', [header]
//   .concat(plan.keep).concat(newRows));
if (plan.deferred) ctx.logger.notify(`AI gate: ${plan.deferred} deferred to next run.`);
```

**The evidence contract** goes into `GeminiService`'s system instruction (append verbatim):

> Base your analysis ONLY on the recipe facts provided in this prompt. Cite the step number for every behavioral claim, in the form (step 3.1). If the provided facts do not establish something, write "not determinable from recipe code" rather than inferring. Do not speculate about intent.

**Prove it:** run AI analysis once — it processes at most `AI_MAX_PER_RUN` (first run after wiring: everything is stale, so it chews through the backlog ten per run and converges within a week of nightly runs — no special backfill needed). Run it again immediately: **zero candidates**, sheet unchanged. Edit one recipe, run the ledger, run AI: exactly one row regenerates, and its prose now carries step citations. Unchanged rows are byte-identical — churn is gone from the diff.

`ProcessMapsRunner` can take the identical gate later if map regeneration ever feels heavy; at current scale it doesn't need it — one mechanism, adopted where it pays.

---

# Step 3 — The clock (Gap 1: unattended, with a lock and an alarm)

One new file. Handlers wrap your existing runners; a script lock stops a manual menu run and a trigger from colliding; failures email you — the GAS-native equivalent of the runbook's "a failed execution is visible without going looking."

## 3.1 New file `12_Cron.gs`

```javascript
/**
 * @file 12_Cron.gs
 * @description Unattended schedule. Handlers wrap existing runners with a
 *              script lock and email-on-failure. Install once via
 *              installNightlyTriggers(); idempotent.
 *
 * Ordering matters two places:
 *  - ledger BEFORE ai: the gate reads FINGERPRINTS written the same night.
 *  - hours, not minutes, between jobs: time triggers fire within a ±15 min
 *    window of the hour, so adjacent hours are the real spacing unit.
 */
const CRON_NIGHTLY = [
  { handler: 'cron_ledger',    hour: 4 },   // fingerprints + change log + ambiguity
  { handler: 'cron_inventory', hour: 5 },   // existing InventorySyncRunner
  { handler: 'cron_maps',      hour: 6 },   // existing ProcessMapsRunner
  { handler: 'cron_ai',        hour: 7 },   // gated AiAnalysisRunner
];

function installNightlyTriggers() {
  uninstallNightlyTriggers();
  CRON_NIGHTLY.forEach(c =>
    ScriptApp.newTrigger(c.handler).timeBased().everyDays(1).atHour(c.hour).create());
  ScriptApp.newTrigger('cron_docs_weekly')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  console.log(`Installed ${CRON_NIGHTLY.length + 1} triggers.`);
}

function uninstallNightlyTriggers() {
  const names = new Set(CRON_NIGHTLY.map(c => c.handler).concat(['cron_docs_weekly']));
  ScriptApp.getProjectTriggers().forEach(t => {
    if (names.has(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
}

function cron_ledger()      { runGuarded_('ChangeLedger',  ctx => new ChangeLedgerRunner().run(ctx)); }
function cron_inventory()   { runGuarded_('InventorySync', ctx => new InventorySyncRunner().run(ctx)); }
function cron_maps()        { runGuarded_('ProcessMaps',   ctx => new ProcessMapsRunner().run(ctx)); }
function cron_ai()          { runGuarded_('AiAnalysis',    ctx => new AiAnalysisRunner().run(ctx)); }
function cron_docs_weekly() {
  runGuarded_('CompanionDoc', ctx => new CompanionDocRunner().run(ctx));
  runGuarded_('SystemDoc',    ctx => new SystemDocRunner().run(ctx));
}

/** Lock + build ctx + run + alert on failure. */
function runGuarded_(label, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn(`${label}: another run holds the lock; skipping this window.`);
    return;
  }
  try {
    fn(AppFactory.createContext());
  } catch (e) {
    console.error(`${label} failed: ${e && e.stack ? e.stack : e}`);
    const to = /* ALERT_EMAIL via your ConfigStore */ '';
    if (to) MailApp.sendEmail(to, `[SDC docs] ${label} failed`,
      String((e && e.stack) || e));
  } finally {
    lock.releaseLock();
  }
}
```

Wire `ALERT_EMAIL` through `ConfigStore` the same way existing keys flow — the guard only needs a string.

## 3.2 Prove it

1. Run each `cron_*` handler **manually from the editor once**, in order — same code path the trigger will take, including the first-time authorization prompt (triggers can't answer OAuth consent screens; a handler that's never run interactively will silently fail its first scheduled run).
2. `installNightlyTriggers()` → Triggers page shows five.
3. Force a failure to test the alarm: temporarily point `WORKATO_API_BASE`-equivalent config at garbage, run `cron_ledger`, confirm the email arrives, restore config.
4. Next morning: Executions page (left rail, clock icon) shows four green runs between 4 and 8 a.m., `CHANGE_LOG` grew only if something actually changed, and nobody did anything.

The 6-minute ceiling never binds at current scale: the ledger is one paginated fetch plus arithmetic; maps and gated AI each touch ~58 or ~10 items respectively. The design headroom is that each stage is *already* its own execution — a bigger estate shards by folder inside a stage before it ever needs new architecture.

---

# Step 4 — The front door (Gap 4: mostly sharing settings)

## 4.1 v1 — ship this week; almost zero code

The insight from the pivot: **Drive is the site.** One shared folder is the publication surface, and domain sharing is the IAP.

1. Create the folder (e.g. *SDC Platform Documentation*), copy its id into `PUBLISH_FOLDER_ID`, and point `DriveService` / the toolkit's `newDrive` at it so `CompanionDocRunner` and `SystemDocRunner` land their Docs there.
2. Share: folder → team group, **Commenter** (comments on generated docs become your feedback channel — and on ADRs, your review layer until GitLab). Spreadsheet → team group, **Viewer**.
3. Make the change feed visible: unhide `CHANGE_LOG` and `AMBIGUITY` (check `applySheetVisibility()` / UiMode rules so basic mode shows them), and give the dashboard a *What changed — last 7 days* section — `DashboardService` already rebuilds from tabs, so this is one more source range, plus a "Facts as of: <timestamp>" cell the ledger writes.
4. Seed the why-layer: three ADR Docs in a `decisions/` subfolder using the template from the build guide (context / decision / consequences). Same seed list as before — the `~<scope>` suffix convention, one-WFA-per-workspace, the Python file-handling invariant — plus a new ADR-001 for *this* system: "state sheets + append-only journal; renderers read tabs, never the API."

**Prove it:** open folder and spreadsheet as a teammate (or incognito with a colleague's help): docs readable, commentable, dashboard shows the change feed, nothing editable that shouldn't be.

## 4.2 v2 — the web app, when polish is worth an afternoon

`DiagramService` already builds pan/zoom HTML; it's just behind a modal. A `doGet` that composes dashboard summary + links into `PUBLISH_FOLDER_ID` + the diagram viewer gives the team one URL. Deploy → Web app → **Execute as: Me** → **Access: Anyone within <domain>**; the `/exec` URL is stable, and code changes need a *New version* on the deployment to go live — the one GAS deployment quirk worth writing on a sticky note. Nothing in v1 blocks or changes for v2, which is exactly why v1 ships first.

---

# Carried over for free

- **The census** — it's a pivot table now: LOGIC sheet, rows = provider, values = count. Your edge-rule vocabulary check, no code.
- **Honesty made visible** — `AMBIGUITY` is live from Step 1. The optional polish: in `renderMermaidCallGraph`, style non-strong edges (`-.->` dashed for weak, dotted+label for dynamic) so the maps show what ordering refuses to act on.
- **The contract seam** — now a one-line house rule: *runners and renderers read tabs (and `ChangeLedgerRunner.readRows_`), never the API directly, except at ingestion.* That sentence is what keeps BigQuery reachable: if permissions ever arrive, storage swaps behind the same reads and nothing above notices. The GCP guide doesn't get deleted; it gets filed as the migration plan.
- **Version control** — the local git repo from the runbook still stands; `clasp pull`/`push` binds these script files to it. The two new files land as commits, not just saves.

# Definition of done

- [ ] Five triggers installed; a forced failure produced an email; a real morning produced four green executions untouched.
- [ ] Three-run ledger test passed: baseline → silent quiet day → one real edit journaled by name.
- [ ] AI gate test passed: immediate rerun = zero candidates; regenerated prose carries step citations; unchanged rows byte-identical.
- [ ] `AMBIGUITY` reviewed once by a human (you) — external callees and dynamic calls triaged into "expected" or "fix".
- [ ] Team group can open the folder and dashboard; a teammate has successfully commented on a generated doc.
- [ ] Three ADRs exist in `decisions/`, including ADR-001 documenting this system's own storage decision.
- [ ] Four tabs registered in `SchemaDef`; `auditSheets()` clean; new files committed via clasp.

# What this cost, and what it bought

Two files, two edits, four tabs, five triggers, one shared folder. No new platform, no new identity, no provisioning request. The same twelve-part design as the GCP build — extractor, parser, edge rules, fact store, contract, renderers, narrator, publisher, front door, clock, identity — with ten of twelve parts reused from code that already carried your name, and the system's defining property intact: **you edit recipes; the docs notice. You make decisions; you write them down. Nothing else requires remembering to document anything.**
