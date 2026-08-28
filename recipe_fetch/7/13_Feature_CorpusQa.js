/**
 * @file 13_Feature_CorpusQa.gs
 * @description Corpus Q&A: the "agent piece" of the docs platform, v1.
 *
 *   Two capabilities, one philosophy:
 *     CorpusDigestBuilder -- nightly (cron_digest, hour 9) assembles the WHOLE estate's knowledge into a
 *       single markdown artifact in Drive, rebuilt only when content actually changed (fingerprint-gated,
 *       same philosophy as AiGate). The fingerprint covers the body only -- never the timestamped header --
 *       so a quiet night is byte-for-byte reproducible and writes nothing.
 *     CorpusQaService -- loads that digest, makes ONE Gemini call under the answer contract
 *       (CORPUS_ANSWER_CONTRACT), returns { question, answer, citations, not_in_corpus, as_of },
 *       and persists every exchange to the QA_LOG tab (Output_QA_Log). System_Logs stays audit-only --
 *       it is pruned by Maintenance, so the durable record lives here. recent(limit) serves that
 *       history back, newest first, for the sidebar and the future web app.
 *
 *   Freshness + entity-browser slice adds two read-only endpoints with OPPOSITE error laws, both
 *   recorded in the handoff: status() feeds the web app's ambient freshness chip and starter chips
 *   (NEVER throws — an absent chip claims nothing), and entities() feeds the entity browser
 *   (THROWS — an error must never impersonate an empty estate).
 *
 *   ***UPDATED*** O12 (entity-browser display evolution): entities() now carries, for recipes and
 *   data tables alike, the project, leaf folder, and a full folder path resolved through
 *   Inventory_Folders by the pure folderPathResolver_ (name-joined, so ambiguity and cycles fall
 *   back to "project / leaf" rather than guess). TABLES gained Project + Folder columns for this
 *   (01/05/10, append-only). Also the never-throws fix in status(): its degradation log no longer
 *   depends on AppConfig, which was the one dependency that could make "never throws" false.
 *
 *   Deliberately NOT here (the architecture decision, settled): no RAG, no embeddings, no retrieval,
 *   no agent loop -- and no conversation state: one question, one cited answer, a browsable log. At
 *   ~58 recipes the whole estate fits one Gemini context; retrieval at this scale is a new way to be
 *   wrong. The single seam for the future is CorpusQaService.loadContext_() -- today it returns the
 *   whole digest, someday it may return selected blocks. The answerer never changes.
 *
 *   Runtime state lives in ConfigStore (script scope), via the CorpusStore seam below:
 *     CORPUS_DIGEST_FILE_ID -- Drive file id of the digest (survives moves between folders)
 *     CORPUS_DIGEST_FP      -- sha256 of the current digest BODY (header excluded)
 *     CORPUS_DIGEST_AT      -- ISO timestamp of the last rebuild (the as-of chip)
 *
 *   Provenance chain: sheet -> digest -> answer -> QA_LOG, unbroken. Every ask also leaves an
 *   audit row in System_Logs.
 */

// -------------------------------------------------------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------------------------------------------------------
/** ConfigStore keys for the digest's runtime state. */
const CORPUS_KEYS = {
  FILE_ID: "CORPUS_DIGEST_FILE_ID",
  FP: "CORPUS_DIGEST_FP",
  AT: "CORPUS_DIGEST_AT"
};

/**
 * The answer contract -- the system-instruction text sent verbatim on every ask (via
 * GeminiService._buildCorpusPrompt). Trust comes from this contract, not from retrieval:
 * every claim cites, every gap refuses with the exact escape phrase, every answer carries as-of.
 * Tests assert on this text; change it deliberately or not at all.
 */
const CORPUS_ANSWER_CONTRACT =
  'You are answering questions about a Workato integration estate using ONLY the corpus document provided. ' +
  'Rules: (1) Every factual claim must cite its source inline in square brackets -- a recipe and step like ' +
  '[PRV-01, step 3.2], a decision record like [ADR-002], a change entry like [CHANGE_LOG 2026-08-25], or ' +
  '[AMBIGUITY]. (2) If the corpus does not establish something, say exactly "not determinable from the corpus" ' +
  'for that part -- never infer, never use outside knowledge about Workato or integrations in place of the corpus. ' +
  '(3) Prefer the ANALYSES and DECISIONS blocks for "why" questions and the EDGES block for "what calls what" ' +
  'questions. (4) Answer in concise markdown. Return ONLY valid JSON: ' +
  '{"answer": "...markdown with inline [citations]...", "citations": [{"ref": "...", "kind": "recipe|adr|change|ambiguity"}], "not_in_corpus": false}';

/**
 * Seam over ConfigStore for the digest's runtime state. One patch point for tests
 * (withPatched_(CorpusStore, "get"/"set", …)) instead of stubbing ConfigStore globally,
 * which AppConfig.get() also depends on. Script scope on purpose: triggers and every
 * user must see the same digest state.
 */
const CorpusStore = {
  get(key) { return ConfigStore.get(key, { preferUser: false, defaultValue: "" }) || ""; },
  set(key, value) { ConfigStore.setScript(key, String(value)); }
};

// -------------------------------------------------------------------------------------------------------
// DIGEST BUILDER
// -------------------------------------------------------------------------------------------------------

/**
 * @class
 * @classdesc Assembles the estate's knowledge into one deterministic markdown artifact, and writes it
 * only when the content fingerprint changed. Reads sheets through ChangeLedgerRunner.readRows_ -- the
 * project's key-resolving read seam (never literal tab names), which the test harness already knows
 * how to back with in-memory data (withLedgerBackend_).
 */
class CorpusDigestBuilder {

  /**
   * Build (or skip) the digest. Throws on oversize -- runGuarded_ turns that into the alert email.
   * @param {AppContext} ctx
   * @returns {{changed:boolean, fp:string, fp12:string, fileId?:string, chars?:number}}
   */
  run(ctx) {
    const qa = (ctx.config && ctx.config.QA) || {};
    const data = this.gather_(ctx);
    const body = this.buildBody_(data);

    const maxChars = Number(qa.DIGEST_MAX_CHARS || 700000);
    if (body.length > maxChars) {
      // Deliberate refusal, never a silent truncation: a clipped corpus quietly breaks the evidence
      // contract (the model would answer confidently from the remainder). Oversize is the
      // "estate outgrew v1" tripwire -- the answer is the loadContext_() seam, not a bigger cap.
      throw new Error(
        `Corpus digest body is ${body.length} chars, over QA.DIGEST_MAX_CHARS (${maxChars}). ` +
        `Refusing to write a truncated digest -- time for the loadContext_() seam, not a bigger cap.`);
    }

    const fp = ChangeLedgerRunner.sha256_(body);
    if (fp === CorpusStore.get(CORPUS_KEYS.FP)) {
      ctx.logger.verbose(`Corpus digest unchanged (fp ${fp.slice(0, 12)}…); nothing written.`);
      return { changed: false, fp, fp12: fp.slice(0, 12) };
    }

    const generatedAt = new Date().toISOString();
    const text = this.assembleText_(body, data, fp, generatedAt);
    const fileId = this.writeDigest_(text);
    // fp/at stored only AFTER a successful write -- the recorded state must never outrun the file.
    CorpusStore.set(CORPUS_KEYS.FP, fp);
    CorpusStore.set(CORPUS_KEYS.AT, generatedAt);

    ctx.logger.notify(`Corpus digest rebuilt: ${text.length} chars, fp ${fp.slice(0, 12)}…`);
    return { changed: true, fp, fp12: fp.slice(0, 12), fileId, chars: text.length };
  }

  // --- GATHER ------------------------------------------------------------------------------------------

  /**
   * Read everything the digest needs, once. Sheet reads go through the ledger's key resolver;
   * decisions come from the ADR folder (O1: markdown files as source of truth).
   * @private
   */
  gather_(ctx) {
    const led = new ChangeLedgerRunner();
    const recipeRows = led.readRows_("RECIPES");
    const nameMap = new Map();
    recipeRows.forEach(r => { if (r[0]) nameMap.set(String(r[0]), String(r[1] || "")); });

    const days = Number(((ctx.config && ctx.config.QA) || {}).RECENT_CHANGES_DAYS || 14);
    return {
      recipeRows,
      analysisRows: led.readRows_("AI_ANALYSIS"),
      edgeRows: led.readRows_("EDGE_STATE"),
      changeRows: CorpusDigestBuilder.filterRecent_(led.readRows_("CHANGE_LOG"), days, Date.now()),
      ambiguityRows: led.readRows_("AMBIGUITY"),
      decisions: this.readDecisions_(),
      recentDays: days,
      nameMap
    };
  }

  /**
   * CHANGE_LOG rows inside the window. Same date semantics as ChangeLedgerRunner.changedRecipeIds.
   * Static and pure (nowMs injected) so the window logic tests hermetically.
   */
  static filterRecent_(rows, days, nowMs) {
    const cutoff = Number(nowMs) - Number(days || 14) * 24 * 60 * 60 * 1000;
    return (rows || []).filter(r => {
      const when = Date.parse(String((r && r[0]) || ""));
      return !isNaN(when) && when >= cutoff;
    });
  }

  /**
   * ADR "why layer": .md files from INTEGRATION.DECISIONS_FOLDER_ID. Unset folder degrades
   * gracefully -- the block says so, and everything else still works.
   * Sorted by name: Drive iteration order is not guaranteed, and an unstable order would
   * churn the fingerprint on quiet nights.
   * @private
   * @returns {{configured:boolean, docs:Array<{name:string,text:string}>}}
   */
  readDecisions_() {
    const folderId = String(AppConfig.get().INTEGRATION.DECISIONS_FOLDER_ID || "");
    if (!folderId) return { configured: false, docs: [] };

    const docs = [];
    const files = DriveApp.getFolderById(folderId).getFiles();
    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      if (!/\.md$/i.test(name)) continue;
      docs.push({ name, text: f.getBlob().getDataAsString() });
    }
    docs.sort((a, b) => a.name.localeCompare(b.name));
    return { configured: true, docs };
  }

  // --- ASSEMBLY ----------------------------------------------------------------------------------------

  /**
   * The fingerprinted body: blocks RECIPES → DECISIONS, in order, each under a "## BLOCK:" header
   * so the model and humans can navigate. Pure -- same data, byte-identical output. The HEADER
   * block (timestamped) is assembled separately and excluded from the fingerprint.
   * @private
   */
  buildBody_(data) {
    const name = id => data.nameMap.get(String(id)) || String(id);
    const s = v => String(v == null ? "" : v);
    const out = [];

    out.push("## BLOCK: RECIPES");
    out.push("One line per recipe: id | name | status | project/folder | last run.");
    const recipes = data.recipeRows.filter(r => r[0]);
    if (!recipes.length) out.push("(inventory is empty -- run inventory.sync)");
    recipes.forEach(r => {
      out.push(`- ${s(r[0])} | ${s(r[1])} | status: ${s(r[2])} | ${s(r[3])}/${s(r[4])} | last run: ${s(r[5]) || "never"}`);
    });

    out.push("");
    out.push("## BLOCK: ANALYSES");
    out.push("Per-recipe structured analysis. Behavioral claims cite steps inline as (step N).");
    const analyses = data.analysisRows.filter(r => r[0]);
    if (!analyses.length) out.push("(no analyses yet -- run ai.analyze)");
    analyses.forEach(r => {
      out.push(`### ${s(r[1]) && s(r[1]) !== "Error" ? s(r[1]) : name(r[0])} (${s(r[0])})`);
      if (s(r[1]) === "Error") {
        // An error row means no trustworthy analysis exists; including the raw error would invite
        // the model to cite garbage. Say what is true instead.
        out.push("(analysis unavailable -- last generation failed; regenerates on next change or manual run)");
        out.push("");
        return;
      }
      out.push(`Objective: ${s(r[2])}`);
      out.push(`Trigger: ${s(r[3])}`);
      out.push("Flow:");
      out.push(s(r[4]) || "(none)");
      out.push("Hotspots:");
      out.push(s(r[5]) || "(none)");
      out.push(`External apps: ${s(r[6]).replace(/\n/g, ", ") || "(none)"}`);
      out.push(`Called recipes: ${s(r[7]).replace(/\n/g, ", ") || "(none)"}`);
      out.push("Risks & notes:");
      out.push(s(r[8]) || "(none)");
      out.push("");
    });

    out.push("## BLOCK: EDGES");
    out.push("Strong recipe-call edges (caller -> callee). Weak or ambiguous references live in AMBIGUITY, never here.");
    const edges = data.edgeRows.filter(r => r[0] && r[1]);
    if (!edges.length) out.push("(no strong call edges recorded)");
    edges.forEach(r => {
      out.push(`- ${name(r[0])} (${s(r[0])}) -> ${name(r[1])} (${s(r[1])})`);
    });

    out.push("");
    out.push("## BLOCK: RECENT_CHANGES");
    out.push(`Window: last ${data.recentDays} days, from CHANGE_LOG. Cite entries as [CHANGE_LOG <date>].`);
    if (!data.changeRows.length) out.push("(no changes in the window)");
    data.changeRows.forEach(r => {
      out.push(`- ${s(r[0])} ${s(r[1])} ${s(r[2])}: ${s(r[3])}${s(r[4]) ? ` (${s(r[4])})` : ""}`);
    });

    out.push("");
    out.push("## BLOCK: AMBIGUITY");
    out.push("Current findings from the ledger's corpus scan, verbatim. Cite as [AMBIGUITY].");
    const findings = data.ambiguityRows.filter(r => r[0]);
    if (!findings.length) out.push("(no current findings -- a clean report is a real state)");
    findings.forEach(r => {
      out.push(`- [${s(r[1])}] ${s(r[2])}: ${s(r[3])} (as of ${s(r[0])})`);
    });

    out.push("");
    out.push("## BLOCK: DECISIONS");
    out.push("Decision records (ADRs) -- the why layer. Cite as [ADR-…] by file name.");
    if (!data.decisions.configured) {
      out.push("(no decision records configured -- set INTEGRATION.DECISIONS_FOLDER_ID to a Drive folder of ADR .md files)");
    } else if (!data.decisions.docs.length) {
      out.push("(decisions folder is configured but holds no .md files yet)");
    } else {
      data.decisions.docs.forEach(d => {
        out.push(`### ${d.name}`);
        out.push(s(d.text).trim());
        out.push("");
      });
    }

    return out.join("\n");
  }

  /**
   * Full digest text: the timestamped HEADER block (excluded from the fingerprint) plus the body.
   * @private
   */
  assembleText_(body, data, fp, generatedAt) {
    const c = {
      recipes: data.recipeRows.filter(r => r[0]).length,
      analyses: data.analysisRows.filter(r => r[0]).length,
      edges: data.edgeRows.filter(r => r[0] && r[1]).length,
      recent_changes: data.changeRows.length,
      findings: data.ambiguityRows.filter(r => r[0]).length,
      decisions: data.decisions.docs.length
    };
    return [
      "## BLOCK: HEADER",
      "# SDC Corpus Digest",
      `generated_at: ${generatedAt}`,
      `corpus_fp: ${fp}`,
      `counts: recipes=${c.recipes} analyses=${c.analyses} edges=${c.edges} recent_changes=${c.recent_changes} findings=${c.findings} decisions=${c.decisions}`,
      "This document is the sole source of truth for corpus Q&A. The fingerprint covers everything below this header.",
      "",
      body
    ].join("\n");
  }

  // --- STORAGE -----------------------------------------------------------------------------------------

  /**
   * Create-or-update the single digest file. Deliberately NOT DriveService -- that seam is wired to the
   * DEBUG folder and gated on LOG_TO_DRIVE. Plain text/markdown: human-readable, one-call loadable,
   * no new OAuth scope. The cached id survives moves, so the file can live in any private folder (O3:
   * the owner's Drive, not the team publish folder -- it concentrates the whole estate's logic).
   * @private
   * @returns {string} the Drive file id
   */
  writeDigest_(text) {
    const cached = CorpusStore.get(CORPUS_KEYS.FILE_ID);
    if (cached) {
      try {
        const f = DriveApp.getFileById(cached);
        if (f.isTrashed()) throw new Error("cached digest file is in the trash");
        f.setContent(text);
        return cached;
      } catch (e) {
        AppLog.verbose(`Corpus digest file ${cached} unavailable (${(e && e.message) || e}); creating a new one.`);
      }
    }
    const file = DriveApp.createFile("SDC_Corpus_Digest.md", text, MimeType.PLAIN_TEXT);
    CorpusStore.set(CORPUS_KEYS.FILE_ID, file.getId());
    return file.getId();
  }
}

// -------------------------------------------------------------------------------------------------------
// Q&A SERVICE
// -------------------------------------------------------------------------------------------------------

/**
 * @class
 * @classdesc One question in, one cited answer out. One Gemini call per ask (10–30s -- never a
 * per-recipe loop on a synchronous path). GeminiService stays the only Gemini touchpoint.
 */
class CorpusQaService {

  /**
   * @param {string} question
   * @param {AppContext} [ctx] built if absent (Commands.run supplies one on the command path)
   * @returns {{question:string, answer:string, citations:Array<{ref:string,kind:string}>,
   *            not_in_corpus:boolean, as_of:{generated_at:string, corpus_fp12:string}}}
   */
  static ask(question, ctx = null) {
    const q = String(question || "").trim();
    const context = ctx || AppFactory.createContext();
    const asOf = CorpusQaService.asOf_();

    if (!q) {
      return { question: q, answer: "Please enter a question.", citations: [], not_in_corpus: false, as_of: asOf };
    }

    const digest = CorpusQaService.loadContext_();               // throws with guidance if never built

    // Duration: time the Gemini call so the sync-vs-ticket decision is made by the real p95, not a guess.
    // A failed call still persists below -- error rows are the loudest latency signal.
    // Limit: a hard platform kill (~6 min) runs no code after it,
    // so THAT case can never write its own row; this covers every throwing failure.
    const t0 = Date.now();
    let parsed = null, askError = null;
    try {
      parsed = new GeminiService().answerFromCorpus(digest, q);
    } catch (e) {
      askError = e;
    }
    const durationMs = Date.now() - t0;

    const result = askError
      ? {
        question: q, answer: `ASK FAILED: ${String((askError && askError.message) || askError)}`,
        citations: [], not_in_corpus: false, as_of: asOf
      }
      : CorpusQaService._shapeAnswer_(parsed, q, asOf);

    // Audit trail: who asked what, against which corpus state. Matters even more later under
    // USER_DEPLOYING, where all web-app execution audits as the deployer.
    let who = "(editor)";
    try { who = Session.getActiveUser().getEmail() || "(editor)"; } catch (e) { /* trigger/editor context */ }
    try {
      context.sheetService.appendDebugRows([
        [new Date().toISOString(), who, "Corpus Q&A", q, asOf.corpus_fp12]
      ]);
    } catch (e) {
      AppLog.verbose(`Corpus Q&A audit append failed: ${(e && e.message) || e}`);
    }

    // Durable Q&A record. System_Logs is audit-only AND pruned (Maintenance keeps the
    // last 500 rows), so the content record lives in its own tab. Same borrowed append seam as the
    // digest's reads -- which also means the same in-memory test backend for free.
    try {
      const cap = Number(((context.config && context.config.CONSTANTS) || {}).CELL_CHAR_LIMIT || 48000);
      const row = CorpusQaService._qaLogRow_(result, who, new Date().toISOString(), cap,
        { durationMs, status: askError ? "error" : "ok" });   // ***UPDATED***
      new ChangeLedgerRunner().appendRows_("QA_LOG", context.config.HEADERS.QA_LOG, [row]);
    } catch (e) {
      AppLog.verbose(`Corpus Q&A log append failed: ${(e && e.message) || e}`);
    }

    // The row above is the durable trace; the throw keeps the client contract --
    // failure handlers own presentation, and an error must never impersonate an answer.
    if (askError) throw askError;
    return result;
  }

  /**
   * Newest-first Q&A history from the QA_LOG tab, shaped for the sidebar and the
   * future web app. Reads through the ledger's key resolver, so tests back it in-memory.
   * @param {number} [limit] 1–50, default 10
   * @returns {Array<{asked_at:string, who:string, question:string, answer:string,
   *           citations:string, refused:boolean, corpus_fp12:string, generated_at:string,
   *           duration_ms:number, status:string}>}
   */
  static recent(limit) {
    const n = Math.max(1, Math.min(Number(limit) || 10, 50));
    const rows = new ChangeLedgerRunner().readRows_("QA_LOG").filter(r => r && r[0]);
    return rows.slice(-n).reverse().map(r => ({
      asked_at: String(r[0] || ""),
      who: String(r[1] || ""),
      question: String(r[2] || ""),
      answer: String(r[3] || ""),
      citations: String(r[4] || ""),
      refused: String(r[5] || "") === "yes",
      corpus_fp12: String(r[6] || ""),
      generated_at: String(r[7] || ""),
      duration_ms: Number(r[8]) || 0,                       // ***UPDATED*** pre-migration rows -> 0, never NaN
      status: String(r[9] || "").trim() || "ok"             // ***UPDATED*** pre-migration rows -> "ok"
    }));
  }

  /**
   * ***UPDATED*** Freshness slice. Ambient as-of state for the web app: whether a digest exists,
   * when it was generated, its fp12, the LIVE recipe count (through the ledger read seam, so it
   * can disagree with the digest — that disagreement is exactly what the chip is for), and the
   * starter questions (AppConfig QA.STARTER_QUESTIONS, capped at six).
   *
   * NEVER throws — each leg degrades independently to its zero value and says so in the verbose
   * log. The chip is ambient: an absent chip claims nothing, so silent degradation is honest here
   * (the complement of the loud-history-errors law).
   * @returns {{built:boolean, generated_at:string, corpus_fp12:string, recipes:number, starters:string[]}}
   */
  static status() {
    const out = { built: false, generated_at: "", corpus_fp12: "", recipes: 0, starters: [] };
    // ***UPDATED*** never-throws fix: AppLog.verbose reads AppConfig.get().VERBOSE, so a
    // config-down failure would re-throw from inside the very catch that is degrading it.
    // Degradation must not depend on the thing that is degrading; the log is best-effort.
    const degraded = (leg, e) => {
      try { AppLog.verbose(`Corpus status: ${leg} leg degraded: ${(e && e.message) || e}`); } catch (_) { /* silent */ }
    };
    try {
      out.built = !!CorpusStore.get(CORPUS_KEYS.FILE_ID);
      const asOf = CorpusQaService.asOf_();
      out.generated_at = asOf.generated_at;
      out.corpus_fp12 = asOf.corpus_fp12;
    } catch (e) { degraded("store", e); }
    try {
      out.recipes = new ChangeLedgerRunner().readRows_("RECIPES").filter(r => r && r[0]).length;
    } catch (e) { degraded("recipe-count", e); }
    try {
      const qa = (AppConfig.get() || {}).QA || {};
      out.starters = (Array.isArray(qa.STARTER_QUESTIONS) ? qa.STARTER_QUESTIONS : [])
        .map(s => String(s == null ? "" : s).trim()).filter(Boolean).slice(0, 6);
    } catch (e) { degraded("starters", e); }
    return out;
  }

  /**
   * Entity-browser feed through the ledger's key-resolving read seam — the vocabulary users need
   * before they can ask about things they can't name. Sorted by name (case-insensitive), blank-id
   * rows dropped, a nameless row falls back to its id. Read-only, no new scopes.
   *
   * ***UPDATED*** O12: recipes AND data tables carry their project, leaf folder (both straight
   * from their inventory row — TABLES gained the same two columns recipes have) and a full folder
   * PATH resolved through Inventory_Folders — one extra read on the same seam, resolved by
   * folderPathResolver_. The client groups both sections project → folder path. A pre-migration
   * TABLES row (six wide) simply has no project/folder yet: it reads as "no folder" until the next
   * sync, which is the truth of the sheet.
   *
   * THROWS on a failed read, on purpose: the browser is content the user acts on, so the client
   * renders the cause (class "entities-unavailable") — an error must never impersonate an empty
   * estate. A genuinely empty estate returns empty arrays: that is a state, not an error. A
   * missing FOLDERS tab is not a failure — the seam returns no rows and every path is simply
   * "project / leaf".
   * @returns {{recipes:Array<{id:string,name:string,project:string,folder:string,path:string}>,
   *            tables:Array<{id:string,name:string,project:string,folder:string,path:string}>}}
   */
  static entities() {
    const led = new ChangeLedgerRunner();
    const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    const live = rows => (rows || []).filter(r => r && r[0]);

    const recipeRows = live(led.readRows_("RECIPES"));
    const tableRows = live(led.readRows_("TABLES"));
    const resolve = CorpusQaService.folderPathResolver_(led.readRows_("FOLDERS"));

    // One shape for both kinds: id, name (id if nameless), project + folder from the row's own
    // columns (RECIPES 3/4, TABLES 6/7), path through the resolver.
    const entity = (r, projectCol, folderCol) => {
      const id = String(r[0]);
      const project = CorpusQaService.cell_(r[projectCol]);
      const folder = CorpusQaService.cell_(r[folderCol]);
      return { id, name: CorpusQaService.cell_(r[1]) || id, project, folder, path: resolve(project, folder) };
    };
    return {
      recipes: recipeRows.map(r => entity(r, 3, 4)).sort(byName),
      tables: tableRows.map(r => entity(r, 6, 7)).sort(byName)
    };
  }

  /**
   * ***UPDATED*** O12: pure folder-path resolver. Input is Inventory_Folders rows —
   * [Folder ID, Name, Parent Folder, Project], where Parent Folder is a resolved NAME with the
   * terminators "TOP LEVEL" and "Workspace Root (Home)" (05_DataMapper.mapFoldersToRows). Builds
   * a (project, name) -> parent-name map once and returns resolve(project, leaf) -> "A / B / C".
   *
   * The join is by NAME, because the recipe row carries only its leaf folder's name. So:
   *   - a name that appears twice in one project with different parents is ambiguous. It is
   *     marked at build time (one verbose line each) and any walk that touches it falls back to
   *     "project / leaf" — the two facts the recipe row itself carries — rather than guess;
   *   - a cycle, or a chain deeper than the cap, falls back the same way (a truncated path would
   *     be a quiet lie);
   *   - a folder missing from the inventory keeps what the row says ("project / leaf");
   *   - Workato's project is itself a folder, so a recipe at the project root carries the project
   *     name as its leaf; that collapses to the project alone, never "ProjA / ProjA".
   * This is UI grouping, not corpus evidence: it never writes an AMBIGUITY row.
   * @param {Array<Array<*>>} folderRows
   * @returns {function(string, string): string}
   */
  static folderPathResolver_(folderRows) {
    const TERMINATORS = new Set(["", "TOP LEVEL", "Workspace Root (Home)"]);
    const MAX_DEPTH = 10;
    const key = (project, name) => `${project}\u241F${name}`;
    const parents = new Map();   // key -> parent name; null once the name is ambiguous
    (folderRows || []).forEach(r => {
      if (!r) return;
      const name = CorpusQaService.cell_(r[1]);
      if (!name) return;
      const parent = CorpusQaService.cell_(r[2]);
      const project = CorpusQaService.cell_(r[3]);
      const k = key(project, name);
      if (!parents.has(k)) { parents.set(k, parent); return; }
      if (parents.get(k) !== null && parents.get(k) !== parent) {
        parents.set(k, null);
        AppLog.verbose(`Folder paths: "${name}" appears more than once in project "${project}" with different parents; ` +
          `recipes under it show project / leaf only.`);
      }
    });

    return (project, leaf) => {
      const proj = CorpusQaService.cell_(project);
      const leafName = CorpusQaService.cell_(leaf);
      const fallback = [proj, leafName].filter(Boolean).join(" / ");
      if (!leafName) return proj;
      const chain = [leafName];
      const seen = new Set([leafName]);
      let cur = leafName;
      for (let depth = 0; ; depth++) {
        const k = key(proj, cur);
        if (!parents.has(k)) break;                                   // unknown folder: keep what the row says
        const parent = parents.get(k);
        if (parent === null) return fallback;                         // ambiguous name — never guess
        if (TERMINATORS.has(parent)) break;
        if (seen.has(parent) || depth >= MAX_DEPTH) return fallback;  // cycle / runaway chain
        chain.push(parent); seen.add(parent); cur = parent;
      }
      if (chain[chain.length - 1] === proj) chain.pop();              // the project's own root folder
      return [proj].concat(chain.reverse()).filter(Boolean).join(" / ");
    };
  }

  /**
   * ***UPDATED*** O12: one cell as a trimmed string, with the inventory's "none" marker ("-",
   * from DataMapper._safeLookup) read as empty. @private
   */
  static cell_(v) {
    const s = String(v == null ? "" : v).trim();
    return s === "-" ? "" : s;
  }

  /**
   * The whole digest, one Drive read (~instant at 58 recipes -- a CacheService layer
   * was considered and skipped as complexity without payoff at this scale). If the estate ever
   * outgrows the context window, this method becomes block selection. The answerer never changes.
   * @private
   */
  static loadContext_() {
    const id = CorpusStore.get(CORPUS_KEYS.FILE_ID);
    if (!id) {
      throw new Error("Corpus digest not built yet -- run cron_digest, the menu's 'Rebuild corpus digest', or rebuildCorpusDigest() first.");
    }
    return DriveApp.getFileById(id).getBlob().getDataAsString();
  }

  /** As-of provenance straight from ConfigStore -- no digest parse needed. @private */
  static asOf_() {
    const fp = CorpusStore.get(CORPUS_KEYS.FP);
    return {
      generated_at: CorpusStore.get(CORPUS_KEYS.AT),
      corpus_fp12: fp ? fp.slice(0, 12) : ""
    };
  }

  /**
   * Normalize the model's JSON into the response contract. Tolerates null (lib parse failure),
   * junk citation entries, and missing fields -- the UI gets a well-shaped object, always.
   * @private
   */
  static _shapeAnswer_(parsed, question, asOf) {
    if (!parsed || typeof parsed !== "object") {
      return {
        question,
        answer: "The model returned an unparseable answer -- try rephrasing the question.",
        citations: [],
        not_in_corpus: false,
        as_of: asOf
      };
    }
    const citations = (Array.isArray(parsed.citations) ? parsed.citations : [])
      .filter(c => c && typeof c === "object" && c.ref)
      .map(c => ({ ref: String(c.ref), kind: String(c.kind || "") }));
    return {
      question,
      answer: String(parsed.answer || ""),
      citations,
      not_in_corpus: parsed.not_in_corpus === true,
      as_of: asOf
    };
  }

  /**
   * One QA_LOG row in HEADERS.QA_LOG order, pure and hermetically testable.
   * Answers are capped at the sheet cell limit with a loud suffix.
   * Meta carries the two appended columns: { durationMs, status } -- ms of the Gemini
   * call and "ok" | "error". Omitted (legacy call shape) -> empty duration cell, status "ok".
   * @private
   */
  static _qaLogRow_(result, who, nowIso, charLimit, meta) {
    const m = meta || {};
    const cap = Number(charLimit) > 0 ? Number(charLimit) : 48000;
    let answer = String(result.answer || "");
    if (answer.length > cap) answer = answer.slice(0, Math.max(0, cap - 15)) + "…(truncated)";
    const citations = (result.citations || [])
      .map(c => (c.kind ? `${c.ref} (${c.kind})` : String(c.ref)))
      .join("\n");
    return [
      String(nowIso || ""),
      String(who || ""),
      String(result.question || ""),
      answer,
      citations,
      result.not_in_corpus === true ? "yes" : "",
      (result.as_of && result.as_of.corpus_fp12) || "",
      (result.as_of && result.as_of.generated_at) || "",
      Number(m.durationMs) >= 0 ? Number(m.durationMs) : "",
      String(m.status || "ok")
    ];
  }
}

// -------------------------------------------------------------------------------------------------------
// GLOBAL ENTRY POINTS
// -------------------------------------------------------------------------------------------------------

/**
 * The future web app's google.script.run target (and anyone else's front door).
 * Delegates through Commands so the ask always runs with a real AppContext.
 * @param {string} question
 */
function askCorpus(question) {
  return Commands.run("corpus.ask", { question });
}

/**
 * History source for the sidebar (and the future web app): the newest `limit`
 * QA_LOG entries, newest first, as plain objects (google.script.run-serializable).
 * @param {number} [limit]
 */
function getRecentQa(limit) {
  return CorpusQaService.recent(limit);
}

/**
 * Editor probe for the history read path -- the deterministic bisect step whenever a
 * UI shows an empty history that shouldn't be. Run from the editor, read the log line: rows here
 * plus nothing in a client means the fault is client/transport, not the server.
 */
function debugRecentQa() {
  const out = CorpusQaService.recent(3);
  console.log(`getRecentQa probe: ${out.length} row(s): ${JSON.stringify(out)}`);
  return out;
}

/**
 * ***UPDATED*** Ambient freshness for the web app's chip and starter chips. Never throws;
 * the client shows the chip only when there is something true to show.
 */
function getCorpusStatus() {
  return CorpusQaService.status();
}

/**
 * The entity browser's feed: recipes and data tables, each as {id, name, project, folder, path}
 * (***UPDATED*** O12). Throws on a failed read so google.script.run failure handlers render the
 * cause — loudly, by design.
 */
function getCorpusEntities() {
  return CorpusQaService.entities();
}
