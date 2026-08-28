/**
 * @file 53_Tests_Corpus.js
 * @description
 *   Test coverage for Corpus Q&A (13_Feature_CorpusQa, the GeminiService.answerFromCorpus surface,
 *   the QA_LOG persistence, and the cron/config wiring). Same two-tier scheme as 50/52:
 *
 *   TIER 1 — HERMETIC  (registerCorpusHermeticTests)
 *     Pure logic in THIS project: digest assembly and block order, fingerprint determinism, the
 *     unchanged-skips-write gate, the oversize refusal, the recent-changes window, answer-contract
 *     content, response shaping, QA_LOG schema + row shaping + history ordering, freshness
 *     status + entity feed, the O12 folder-path resolver (***UPDATED***), config + cron wiring.
 *     Sheet reads/appends ride the withLedgerBackend_ in-memory backend; Drive and
 *     ConfigStore are prototype/seam-patched. No real tabs, no network.
 *
 *   TIER 2 — INTEGRATION  (registerCorpusIntegrationTests)
 *     Crosses into GeminiLib via GeminiService with a canned answerFromCorpus — ask() end-to-end
 *     (shape, as-of chip, audit row, persisted QA_LOG row), the refusal trap path, and the corpus
 *     prompt carrying the contract verbatim. Skips cleanly when the library isn't bound.
 *
 *   LIVE EVAL  (runLiveGoldenEval — MANUAL ONLY, real Gemini calls, real digest; never part of
 *     runAllTests*). Golden questions with must-cite / must-refuse expectations, printed as a
 *     scorecard. This is the calibration harness for the answer contract.
 *
 *   ENTRY POINTS (run from the editor)
 *     runCorpusTests()          — both tiers, this file only
 *     runCorpusHermeticTests()  — Tier 1 only (always green, instant)
 *     runAllTestsWithCorpus()   — the ENTIRE suite: 50_Tests tiers + 52's + these
 *
 *   NOTE: Assert is already bound once, at the top of 52_Tests_ChangeLedger.js (L4). Do not rebind.
 */

// ---------------------------------------------------------------------------------------
// FIXTURES (corpus-specific; complements Fixtures in 50 and LedgerFixtures in 52)
// ---------------------------------------------------------------------------------------

/** FakeSheetService that also captures audit rows, which the base fake doesn't model. */
class CorpusFakeSheetService extends FakeSheetService {
  constructor() {
    super();
    this.debugRows = [];
  }
  appendDebugRows(rows) { (rows || []).forEach(r => this.debugRows.push(r)); }
}

class CorpusFixtures {
  /** A 16-wide AI_ANALYSIS row in schema order, with step-cited defaults. */
  static analysisRow(id, name, fields = {}) {
    const r = Array(16).fill("");
    r[0] = String(id);
    r[1] = name;
    r[2] = fields.objective || `Coordinates the ${name} workflow`;
    r[3] = fields.trigger || "Scheduled";
    r[4] = fields.flow || "1. Fetch supplier rows (step 1)\n2. Write results (step 2)";
    r[5] = fields.hotspots || "";
    r[6] = fields.externalApps || "gmail";
    r[7] = fields.calledRecipes || "";
    r[8] = fields.risks || "None noted (step 2)";
    return r;
  }

  /**
   * A three-recipe estate seeded the way production sheets would hold it (header + rows),
   * ready for withLedgerBackend_. One CHANGE_LOG entry sits deliberately outside the
   * 14-day window and must never reach the digest.
   */
  static seededSheets() {
    const fake = new CorpusFakeSheetService();
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

    fake.writtenData["RECIPES"] = [SchemaDef.HEADERS.RECIPES,
    ["100", "PRV-01 Root", "active", "ProjA", "FoldA", iso(1), "3", iso(2), "10", "0", "42", "gmail"],
    ["200", "INV-01 Escalation", "active", "ProjA", "FoldA", iso(1), "1", iso(9), "5", "0", "7", ""],
    ["300", "INV-02 Triage", "stopped", "ProjA", "FoldB", "", "1", "", "", "", "", ""]];

    fake.writtenData["AI_ANALYSIS"] = [SchemaDef.HEADERS.AI_ANALYSIS,
    CorpusFixtures.analysisRow("100", "PRV-01 Root", { calledRecipes: "INV-01 Escalation\nINV-02 Triage" }),
    CorpusFixtures.analysisRow("200", "INV-01 Escalation")];

    fake.writtenData["EDGE_STATE"] = [SchemaDef.HEADERS.EDGE_STATE,
    ["100", "200"],
    ["100", "300"]];

    fake.writtenData["CHANGE_LOG"] = [SchemaDef.HEADERS.CHANGE_LOG,
    [iso(2), "recipe", "modified", "PRV-01 Root", "100"],
    [iso(40), "recipe", "added", "INV-02 Triage", "300"]];   // outside the window — must not appear

    fake.writtenData["AMBIGUITY"] = [SchemaDef.HEADERS.AMBIGUITY,
    [iso(1), "warn", "EXTERNAL_CALLEE", "callee 500 not in corpus"]];

    // ***UPDATED*** Entity-browser feed: two real tables (one nameless — must fall back to its
    // id) plus a blank-id ghost that must never surface. The digest never reads TABLES, so
    // every existing digest assertion is untouched by this seed.
    fake.writtenData["TABLES"] = [SchemaDef.HEADERS.TABLES,
    ["T-20", "Suppliers", "Master supplier list", "id,name", "42", iso(3)],
    ["T-10", "", "", "", "", ""],
    ["", "ghost — no id", "", "", "", ""]];

    // ***UPDATED*** O12 folder nesting. Inventory_Folders carries [id, name, parent NAME, project];
    // Workato's project is itself a folder, so ProjA's root appears with parent "Workspace Root
    // (Home)". FoldB nests under FoldA, so recipe 300's path must show what its own row cannot.
    // The digest never reads FOLDERS, so every digest assertion is untouched by this seed.
    fake.writtenData["FOLDERS"] = [SchemaDef.HEADERS.FOLDERS,
    ["F-1", "ProjA", "Workspace Root (Home)", "ProjA"],
    ["F-2", "FoldA", "ProjA", "ProjA"],
    ["F-3", "FoldB", "FoldA", "ProjA"]];

    return fake;
  }

  /** The ADR why-layer, as readDecisions_ would return it from a configured folder. */
  static decisionDocs() {
    return {
      configured: true,
      docs: [{
        name: "ADR-002-scope-suffix.md",
        text: "# ADR-002 — Cascade scope suffix\nStatus: accepted\nLookup values carry a ~scope suffix as both value uniqueness and the cascade join key."
      }]
    };
  }

  /** Minimal ctx for corpus tests — deliberately NOT makeFakeCtx_, which constructs library-bound services. */
  static minimalCtx(fakeSheets) {
    return { config: AppConfig.get(), sheetService: fakeSheets, logger: AppLog };
  }
}

/**
 * Standard corpus test setup: ledger backend serving the seeded sheets, decisions patched to the
 * fixture ADR, one builder and one gathered dataset handed to fn(builder, data, fakeSheets).
 */
function withCorpusFixtures_(fn) {
  const fake = CorpusFixtures.seededSheets();
  return withLedgerBackend_(fake, () =>
    withPatched_(CorpusDigestBuilder.prototype, "readDecisions_", () => CorpusFixtures.decisionDocs(), () => {
      const b = new CorpusDigestBuilder();
      const data = b.gather_(CorpusFixtures.minimalCtx(fake));
      return fn(b, data, fake);
    }));
}

// ---------------------------------------------------------------------------------------
// TIER 1 — HERMETIC
// ---------------------------------------------------------------------------------------
function registerCorpusHermeticTests(runner) {

  // --- digest assembly ------------------------------------------------------------------
  runner.add("[hermetic] digest body renders the six content blocks in order, names resolved, window applied", () => {
    withCorpusFixtures_((b, data) => {
      const body = b.buildBody_(data);
      const order = ["## BLOCK: RECIPES", "## BLOCK: ANALYSES", "## BLOCK: EDGES",
        "## BLOCK: RECENT_CHANGES", "## BLOCK: AMBIGUITY", "## BLOCK: DECISIONS"];
      let last = -1;
      order.forEach(marker => {
        const i = body.indexOf(marker);
        Assert.ok(i > last, `${marker} present and in order`);
        last = i;
      });
      Assert.contains(body, "- 100 | PRV-01 Root | status: active", "recipe line rendered");
      Assert.contains(body, "PRV-01 Root (100) -> INV-01 Escalation (200)", "edge rendered with resolved names");
      Assert.contains(body, "recipe modified: PRV-01 Root", "in-window change included");
      Assert.ok(body.indexOf("recipe added: INV-02 Triage") === -1, "out-of-window change excluded");
      Assert.contains(body, "EXTERNAL_CALLEE", "ambiguity finding verbatim");
      Assert.contains(body, "ADR-002", "decision record content included");
    });
  });

  runner.add("[hermetic] full digest opens with the HEADER block carrying fp and content-derived counts", () => {
    withCorpusFixtures_((b, data) => {
      const body = b.buildBody_(data);
      const fp = ChangeLedgerRunner.sha256_(body);
      const text = b.assembleText_(body, data, fp, "2026-08-26T00:00:00Z");
      Assert.equal(text.indexOf("## BLOCK: HEADER"), 0, "HEADER opens the document");
      Assert.equal((text.match(/## BLOCK: /g) || []).length, 7, "seven blocks, no more, no fewer");
      Assert.contains(text, `corpus_fp: ${fp}`, "full fingerprint recorded in the header");
      Assert.contains(text,
        "counts: recipes=3 analyses=2 edges=2 recent_changes=1 findings=1 decisions=1",
        "counts derived from content");
    });
  });

  // --- fingerprint gate -----------------------------------------------------------------
  runner.add("[hermetic] corpus fingerprint is deterministic and timestamp-independent", () => {
    withCorpusFixtures_((b, data) => {
      const b1 = b.buildBody_(data);
      const b2 = b.buildBody_(data);
      Assert.equal(b1, b2, "same data, byte-identical body");
      Assert.equal(ChangeLedgerRunner.sha256_(b1), ChangeLedgerRunner.sha256_(b2), "…so the same fingerprint");
      Assert.ok(b1.indexOf("generated_at") === -1, "the body carries no timestamp — that lives in the excluded header");
    });
  });

  runner.add("[hermetic] unchanged content skips the write; changed content writes, then stores fp + at", () => {
    withCorpusFixtures_((b, data, fake) => {
      const fp = ChangeLedgerRunner.sha256_(b.buildBody_(data));

      // Quiet night: stored fp already matches — nothing may be written or stored.
      const quietStores = {};
      withPatched_(CorpusStore, "get", (k) => (k === CORPUS_KEYS.FP ? fp : ""), () =>
        withPatched_(CorpusStore, "set", (k, v) => { quietStores[k] = v; }, () =>
          withPatched_(CorpusDigestBuilder.prototype, "writeDigest_", () => { throw new Error("must not write on a quiet night"); }, () => {
            const res = b.run(CorpusFixtures.minimalCtx(fake));
            Assert.equal(res.changed, false, "quiet night reports unchanged");
            Assert.equal(res.fp12, fp.slice(0, 12), "…while still returning the current fp12");
            Assert.equal(Object.keys(quietStores).length, 0, "no store writes on a quiet night");
          })));

      // Changed content: writes the file, then stores fp and generated_at (in that order).
      const stores = {};
      withPatched_(CorpusStore, "get", () => "", () =>
        withPatched_(CorpusStore, "set", (k, v) => { stores[k] = v; }, () =>
          withPatched_(CorpusDigestBuilder.prototype, "writeDigest_", () => "fake-file-id", () => {
            const res = b.run(CorpusFixtures.minimalCtx(fake));
            Assert.equal(res.changed, true, "new content writes");
            Assert.equal(res.fileId, "fake-file-id", "writer's file id surfaced");
            Assert.equal(stores[CORPUS_KEYS.FP], fp, "fingerprint stored only after a successful write");
            Assert.contains(String(stores[CORPUS_KEYS.AT] || ""), "T", "generated_at stored as ISO");
          })));
    });
  });

  runner.add("[hermetic] oversize body refuses loudly instead of truncating", () => {
    withCorpusFixtures_((b, data, fake) => {
      withTestConfig({ QA: { DIGEST_MAX_CHARS: 10 } }, () => {
        let threw = false, msg = "";
        try { b.run(CorpusFixtures.minimalCtx(fake)); }
        catch (e) { threw = true; msg = String((e && e.message) || e); }
        Assert.ok(threw, "run refuses rather than writing a clipped corpus");
        Assert.contains(msg, "DIGEST_MAX_CHARS", "refusal names the tripwire");
      });
    });
  });

  // --- recent-changes window ------------------------------------------------------------
  runner.add("[hermetic] filterRecent_ keeps in-window rows only, tolerating junk dates", () => {
    const now = Date.now();
    const iso = ago => new Date(now - ago * 24 * 60 * 60 * 1000).toISOString();
    const rows = [
      [iso(1), "recipe", "modified", "A", "100"],
      [iso(20), "recipe", "added", "B", "200"],     // outside a 14-day window
      ["not-a-date", "x", "y", "z", ""]
    ];
    const kept = CorpusDigestBuilder.filterRecent_(rows, 14, now);
    Assert.equal(kept.length, 1, "only the in-window row survives");
    Assert.equal(kept[0][4], "100", "…and it is the recent one");
  });

  // --- the answer contract --------------------------------------------------------------
  runner.add("[hermetic] answer contract carries the citation forms, the exact escape phrase, and the JSON directive", () => {
    Assert.contains(CORPUS_ANSWER_CONTRACT, "[PRV-01, step 3.2]", "recipe/step citation example");
    Assert.contains(CORPUS_ANSWER_CONTRACT, "[ADR-002]", "decision citation example");
    Assert.contains(CORPUS_ANSWER_CONTRACT, "[CHANGE_LOG 2026-08-25]", "change-entry citation example");
    Assert.contains(CORPUS_ANSWER_CONTRACT, "not determinable from the corpus", "the exact escape phrase");
    Assert.contains(CORPUS_ANSWER_CONTRACT, "never use outside knowledge", "outside-knowledge ban");
    Assert.contains(CORPUS_ANSWER_CONTRACT, "Return ONLY valid JSON", "structured-output directive");
  });

  // --- response shaping -----------------------------------------------------------------
  runner.add("[hermetic] response shaping tolerates null, junk citations, and missing fields", () => {
    const asOf = { generated_at: "2026-08-26T09:00:00Z", corpus_fp12: "abcdef123456" };

    const dead = CorpusQaService._shapeAnswer_(null, "q", asOf);
    Assert.contains(dead.answer, "unparseable", "null parse -> graceful message, no throw");
    Assert.deepEqual(dead.citations, [], "…with empty citations");
    Assert.equal(dead.not_in_corpus, false, "…and no false refusal");

    const messy = CorpusQaService._shapeAnswer_(
      { answer: 42, citations: [{ ref: "PRV-01, step 3.2" }, "junk", { kind: "adr" }], not_in_corpus: "yes" },
      "q", asOf);
    Assert.equal(messy.answer, "42", "answer coerced to string");
    Assert.equal(messy.citations.length, 1, "only ref-bearing citation objects kept");
    Assert.equal(messy.citations[0].kind, "", "missing kind defaults to empty, never undefined");
    Assert.equal(messy.not_in_corpus, false, "non-boolean refusal flag treated as false");
    Assert.equal(messy.as_of.corpus_fp12, "abcdef123456", "as-of chip passed through");
  });

  // --- QA_LOG persistence ---------------------------------------------------------------
  runner.add("[hermetic] QA_LOG schema present: key resolves, ten columns, flags where the code expects them", () => {
    Assert.equal(SchemaDef.SHEETS.QA_LOG, "Output_QA_Log", "key -> tab name");
    const h = SchemaDef.HEADERS.QA_LOG;
    // Web-app round: Duration ms + Status appended; indexes 0-7 unchanged on purpose
    Assert.equal(h.length, 10, "ten columns");
    Assert.equal(h[2], "Question", "question in column C");
    Assert.equal(h[3], "Answer", "answer in column D");
    Assert.equal(h[5], "Refused", "refusal flag in column F — recent() reads this index");
    Assert.equal(h[6], "Corpus FP12", "provenance chip in column G");
    Assert.equal(h[8], "Duration ms", "duration in column I -- the ticket-lane decision reads real p95 here");
    Assert.equal(h[9], "Status", "status in column J -- O7: failed asks persist as visible rows");
  });

  runner.add("[hermetic] _qaLogRow_ shapes in header order, truncates loudly at the cell cap, maps the refusal flag", () => {
    const asOf = { generated_at: "2026-08-26T09:00:00Z", corpus_fp12: "abcdef123456" };
    const res = {
      question: "q?", answer: "A".repeat(100),
      citations: [{ ref: "PRV-01, step 1", kind: "recipe" }, { ref: "ADR-002", kind: "" }],
      not_in_corpus: false, as_of: asOf
    };
    const row = CorpusQaService._qaLogRow_(res, "who@example.com", "NOW", 40);
    Assert.equal(row.length, SchemaDef.HEADERS.QA_LOG.length, "row width matches the header");
    Assert.ok(row[3].length <= 40, "answer capped at the cell limit");
    Assert.contains(row[3], "…(truncated)", "truncation is loud, never silent");
    Assert.equal(row[4], "PRV-01, step 1 (recipe)\nADR-002", "citations joined; kind shown only when present");
    Assert.equal(row[5], "", "answered -> empty Refused cell");
    Assert.equal(row[6], "abcdef123456", "fp12 carried into the log");

    const refused = CorpusQaService._qaLogRow_({ ...res, answer: "short", not_in_corpus: true }, "w", "NOW", 48000);
    Assert.equal(refused[5], "yes", "refusal flagged");
    Assert.equal(refused[3], "short", "short answers pass through untouched");

    // ***UPDATED*** the appended columns
    Assert.equal(row[8], "", "legacy call shape (no meta) -> empty duration cell");
    Assert.equal(row[9], "ok", "…and status defaults to ok");
    const timed = CorpusQaService._qaLogRow_(res, "w", "NOW", 48000, { durationMs: 12345, status: "ok" });
    Assert.equal(timed[8], 12345, "duration lands in column I as a number");
    const failedRow = CorpusQaService._qaLogRow_({ ...res, answer: "ASK FAILED: boom" }, "w", "NOW", 48000, { durationMs: 7, status: "error" });
    Assert.equal(failedRow[9], "error", "status carries the failure");
    Assert.equal(failedRow[8], 7, "…with its duration -- error rows are the loudest latency signal");
  });

  runner.add("[hermetic] recent() returns newest-first, caps the window, and maps refusal/duration/status", () => {
    const fake = new CorpusFakeSheetService();
    // Three legacy 8-wide rows (pre-migration) plus one 10-wide row -- recent() must
    // read both shapes forever, because the migration widens the header, never the old rows.
    fake.writtenData["QA_LOG"] = [SchemaDef.HEADERS.QA_LOG,
    ["2026-08-26T01:00:00Z", "a", "q1", "ans1", "", "", "fp1", "G"],
    ["2026-08-26T02:00:00Z", "b", "q2", "ans2", "", "yes", "fp2", "G"],
    ["2026-08-26T03:00:00Z", "c", "q3", "ans3", "", "", "fp3", "G"],
    ["2026-08-26T04:00:00Z", "d", "q4", "ASK FAILED: quota", "", "", "fp4", "G", 61000, "error"]];
    withLedgerBackend_(fake, () => {
      const out = CorpusQaService.recent(2);
      Assert.equal(out.length, 2, "cap respected");
      Assert.equal(out[0].question, "q4", "newest first");
      Assert.equal(out[0].status, "error", "status mapped through");
      Assert.equal(out[0].duration_ms, 61000, "duration mapped as a number");
      Assert.equal(out[1].question, "q3", "…then the one before it");
      Assert.equal(out[1].status, "ok", "pre-migration rows read back as ok");
      Assert.equal(out[1].duration_ms, 0, "…with zero duration, never NaN");
      const all = CorpusQaService.recent(50);
      Assert.equal(all.length, 4, "asking for more than exists returns all");
      Assert.equal(all[2].refused, true, "'yes' string mapped to a boolean");
      Assert.equal(all[3].refused, false, "empty string mapped to false");
    });
  });

  // --- web app front door ---------------------------------------------------------------
  // doGet is the whole server side of 14_WebApp; the sentinels below encode the
  // sidebar lesson: both server calls wired, and a history error must render itself visibly,
  // never impersonate an empty log.
  runner.add("[hermetic] doGet serves the Q&A page with all four server calls wired", () => {
    const out = doGet();
    Assert.equal(out.getTitle(), "SDC Corpus Q&A", "page title set");
    const html = out.getContent();
    Assert.contains(html, "askCorpus", "ask path wired");
    Assert.contains(html, "getRecentQa", "history path wired");
    Assert.contains(html, "history-unavailable", "history errors render visibly");
    // ***UPDATED*** freshness + entity-browser sentinels
    Assert.contains(html, "getCorpusStatus", "freshness/starters path wired");
    Assert.contains(html, "getCorpusEntities", "entity-browser path wired");
    Assert.contains(html, "entities-unavailable", "entity errors render visibly — never an empty estate");
    // ***UPDATED*** O12 sentinel: the path-labeled folder groups. Missing = the HTML wasn't pasted.
    Assert.contains(html, "entpath", "O12 folder groups present in the served page");
  });

  // --- freshness status + entity feed ---------------------------------------------------
  // ***UPDATED*** Two endpoints, OPPOSITE error laws (both recorded in the handoff):
  // status() is ambient and NEVER throws; entities() is content and throws LOUDLY.
  runner.add("[hermetic] getCorpusStatus reports as-of state, live recipe count, capped starters — and never throws", () => {
    const fake = CorpusFixtures.seededSheets();
    const store = {
      CORPUS_DIGEST_FILE_ID: "file-1",
      CORPUS_DIGEST_FP: "a".repeat(64),
      CORPUS_DIGEST_AT: "2026-08-27T09:00:00Z"
    };
    const real = AppConfig.get();
    const eight = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    withLedgerBackend_(fake, () =>
      withPatched_(CorpusStore, "get", k => store[k] || "", () =>
        withPatched_(AppConfig, "get", () => ({ ...real, QA: { ...real.QA, STARTER_QUESTIONS: eight } }), () => {
          const s = getCorpusStatus();
          Assert.equal(s.built, true, "digest file id present -> built");
          Assert.equal(s.corpus_fp12, "a".repeat(12), "fp12 from the store");
          Assert.equal(s.generated_at, "2026-08-27T09:00:00Z", "as-of timestamp carried");
          Assert.equal(s.recipes, 3, "LIVE recipe count through the ledger seam");
          Assert.equal(s.starters.length, 6, "starters capped at six");
          Assert.equal(s.starters[0], "s1", "…in config order");
        })));

    // Every leg on fire -> still a well-shaped object. The chip is ambient; absence claims nothing.
    withPatched_(CorpusStore, "get", () => { throw new Error("store down"); }, () =>
      withPatched_(ChangeLedgerRunner.prototype, "readRows_", () => { throw new Error("sheets down"); }, () =>
        withPatched_(AppConfig, "get", () => { throw new Error("config down"); }, () => {
          const s = getCorpusStatus();
          Assert.equal(s.built, false, "degrades to not-built");
          Assert.equal(s.recipes, 0, "degrades to zero recipes");
          Assert.equal(s.starters.length, 0, "degrades to no starters");
          Assert.equal(s.corpus_fp12, "", "…and to an empty fp — a well-shaped nothing, never a throw");
        })));
  });

  runner.add("[hermetic] getCorpusEntities serves sorted id+name pairs from RECIPES and TABLES through the ledger seam", () => {
    const fake = CorpusFixtures.seededSheets();
    withLedgerBackend_(fake, () => {
      const e = getCorpusEntities();
      Assert.equal(e.recipes.map(r => r.id).join(","), "200,300,100", "recipes sorted by name, case-insensitive");
      Assert.equal(e.recipes[2].name, "PRV-01 Root", "id+name carried");
      Assert.equal(e.tables.length, 2, "the blank-id ghost never surfaces");
      Assert.equal(e.tables[0].name, "Suppliers", "tables sorted by name too");
      Assert.equal(e.tables[1].id, "T-10", "…and a nameless table…");
      Assert.equal(e.tables[1].name, "T-10", "…falls back to its id");
      // ***UPDATED*** O12 field-level asserts (the shape may grow; these never break on growth):
      // project and leaf folder straight from the recipe row, path resolved through FOLDERS.
      Assert.equal(e.recipes[2].project, "ProjA", "project carried from the recipe row");
      Assert.equal(e.recipes[2].folder, "FoldA", "leaf folder name carried from the recipe row");
      Assert.equal(e.recipes[2].path, "ProjA / FoldA", "path resolved through Inventory_Folders");
      Assert.equal(e.recipes[1].path, "ProjA / FoldA / FoldB", "…including the nesting the recipe row alone cannot show");
      Assert.equal(Object.keys(e.tables[0]).sort().join(","), "id,name", "tables stay id+name — no folder facts to resolve");
    });
  });

  // ***UPDATED*** O12: the pure resolver, no backend needed. Rows are Inventory_Folders shape:
  // [id, name, parent NAME, project]. The join is by name, so every honest fallback is
  // "project / leaf" — the two facts the recipe row itself carries — never a guess.
  runner.add("[hermetic] folder path resolver: full paths from Inventory_Folders; root collapse; ambiguity, cycle, and runaway depth fall back to project / leaf", () => {
    const rows = [
      ["F-1", "ProjA", "Workspace Root (Home)", "ProjA"],   // the project's own root folder
      ["F-2", "Parent", "ProjA", "ProjA"],
      ["F-3", "Sub", "Parent", "ProjA"],
      ["F-4", "Loose", "TOP LEVEL", "ProjA"],
      ["F-5", "Twin", "Parent", "ProjA"],
      ["F-6", "Twin", "Loose", "ProjA"],                    // same name, same project, different parents -> ambiguous
      ["F-7", "Deep", "Twin", "ProjA"],                     // its ancestor is the ambiguous one
      ["F-8", "Ouro", "Boros", "ProjB"],
      ["F-9", "Boros", "Ouro", "ProjB"],                    // a cycle
      ["F-10", "Parent", "ProjB", "ProjB"],                 // same name as ProjA's Parent — a different project, no collision
      ["", "", "", ""]                                      // a blank row is tolerated
    ];
    // ProjC: d0 -> d1 -> … -> d11 -> TOP LEVEL, deeper than the cap.
    for (let i = 0; i < 12; i++) rows.push([`D-${i}`, `d${i}`, i < 11 ? `d${i + 1}` : "TOP LEVEL", "ProjC"]);

    const resolve = CorpusQaService.folderPathResolver_(rows);
    Assert.equal(resolve("ProjA", "Sub"), "ProjA / Parent / Sub", "walks upward to the full path");
    Assert.equal(resolve("ProjA", "Parent"), "ProjA / Parent", "one level");
    Assert.equal(resolve("ProjA", "ProjA"), "ProjA", "a recipe at the project root collapses to the project — never ProjA / ProjA");
    Assert.equal(resolve("ProjA", "Loose"), "ProjA / Loose", "TOP LEVEL terminates the walk");
    Assert.equal(resolve("ProjA", "Twin"), "ProjA / Twin", "an ambiguous name falls back to project / leaf");
    Assert.equal(resolve("ProjA", "Deep"), "ProjA / Deep", "…and so does a folder whose ancestor is ambiguous");
    Assert.equal(resolve("ProjB", "Ouro"), "ProjB / Ouro", "a cycle falls back the same way");
    Assert.equal(resolve("ProjB", "Parent"), "ProjB / Parent", "names are scoped per project");
    Assert.equal(resolve("ProjC", "d9"), "ProjC / d11 / d10 / d9", "a chain within the cap resolves fully");
    Assert.equal(resolve("ProjC", "d0"), "ProjC / d0", "a chain past the cap falls back rather than render a truncated path");
    Assert.equal(resolve("ProjA", "Unknown"), "ProjA / Unknown", "a folder missing from the inventory keeps what the recipe row says");
    Assert.equal(resolve("ProjA", "-"), "ProjA", "no folder on the row -> the project alone");
    Assert.equal(resolve("", ""), "", "nothing known -> an empty path (the client labels it)");

    const bare = CorpusQaService.folderPathResolver_([]);
    Assert.equal(bare("ProjA", "Sub"), "ProjA / Sub", "no Inventory_Folders tab at all -> project / leaf, and the browser still renders");
  });

  runner.add("[hermetic] getCorpusEntities: an empty inventory is a state; a failed read throws loudly", () => {
    withLedgerBackend_(new CorpusFakeSheetService(), () => {
      const e = getCorpusEntities();
      Assert.equal(e.recipes.length, 0, "empty estate -> empty recipes — a real state, honestly reported");
      Assert.equal(e.tables.length, 0, "…and empty tables, never null");
    });
    let threw = false;
    withPatched_(ChangeLedgerRunner.prototype, "readRows_", () => { throw new Error("sheets down"); }, () => {
      try { getCorpusEntities(); }
      catch (e) { threw = true; Assert.contains(String((e && e.message) || e), "sheets down", "the cause surfaces to the failure handler"); }
    });
    Assert.ok(threw, "a failed read throws — the panel renders it; an error never impersonates an empty estate");
  });

  // --- config + cron wiring -------------------------------------------------------------
  runner.add("[hermetic] QA config block and cron_digest wiring are present and collision-free", () => {
    const cfg = AppConfig.get();
    Assert.ok(cfg.QA, "QA block present");
    Assert.ok(Number(cfg.QA.RECENT_CHANGES_DAYS) > 0, "RECENT_CHANGES_DAYS is a positive number");
    Assert.ok(Number(cfg.QA.DIGEST_MAX_CHARS) >= 100000, "DIGEST_MAX_CHARS is a real ceiling");
    Assert.ok("DECISIONS_FOLDER_ID" in cfg.INTEGRATION, "DECISIONS_FOLDER_ID key present (may be empty until configured)");

    const digestCron = CRON_NIGHTLY.find(c => c.handler === "cron_digest");
    Assert.ok(digestCron, "cron_digest scheduled nightly");
    Assert.equal(digestCron.hour, 9, "…at hour 9 (after cron_ai at 7)");
    const hours = CRON_NIGHTLY.map(c => c.hour);
    Assert.equal(new Set(hours).size, hours.length, "no shared hours — the lock skips colliding runs, it doesn't queue them");
    Assert.ok(hours.indexOf(8) === -1, "hour 8 stays reserved for Monday's cron_docs_weekly");
  });
}

// ---------------------------------------------------------------------------------------
// TIER 2 — INTEGRATION (GeminiLib via GeminiService with a canned answer; SKIP if unbound)
// ---------------------------------------------------------------------------------------
function registerCorpusIntegrationTests(runner) {

  runner.add("[integration] ask() end-to-end: shape, as-of chip, one audit row, one persisted QA_LOG row", () => {
    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      try { if (!GeminiLib) return Assert.skip("GeminiLib not bound."); }
      catch (e) { return Assert.skip("GeminiLib not bound in this project."); }

      const fake = new CorpusFakeSheetService();
      const ctx = CorpusFixtures.minimalCtx(fake);
      const canned = {
        answer: "INV-01 is called by PRV-01 [PRV-01, step 3.2].",
        citations: [{ ref: "PRV-01, step 3.2", kind: "recipe" }],
        not_in_corpus: false
      };

      withLedgerBackend_(fake, (journal) =>
        withPatched_(CorpusStore, "get",
          (k) => (k === CORPUS_KEYS.FP ? "abcdef123456ffff" : (k === CORPUS_KEYS.AT ? "2026-08-26T09:00:00Z" : "")), () =>
          withPatched_(CorpusQaService, "loadContext_", () => "## BLOCK: HEADER\n(test digest)", () =>
            withPatched_(GeminiService.prototype, "answerFromCorpus", () => canned, () => {
              const res = CorpusQaService.ask("Which recipes call INV-01?", ctx);
              Assert.equal(res.question, "Which recipes call INV-01?", "question echoed");
              Assert.contains(res.answer, "[PRV-01, step 3.2]", "cited answer surfaced");
              Assert.equal(res.citations.length, 1, "citations shaped");
              Assert.equal(res.not_in_corpus, false, "no refusal flag");
              Assert.equal(res.as_of.corpus_fp12, "abcdef123456", "as-of chip = first 12 chars of the stored fp");
              Assert.equal(res.as_of.generated_at, "2026-08-26T09:00:00Z", "as-of timestamp from the store");

              Assert.equal(fake.debugRows.length, 1, "exactly one audit row per ask");
              const audit = fake.debugRows[0];
              Assert.equal(audit[2], "Corpus Q&A", "audit source label");
              Assert.equal(audit[3], "Which recipes call INV-01?", "audit records the question");
              Assert.equal(audit[4], "abcdef123456", "audit records the corpus fp12");

              const persisted = journal["QA_LOG"] || [];
              Assert.equal(persisted.length, 1, "exactly one QA_LOG row per ask");
              Assert.equal(persisted[0].length, SchemaDef.HEADERS.QA_LOG.length, "persisted row matches the header width");
              Assert.equal(persisted[0][2], "Which recipes call INV-01?", "log records the question");
              Assert.contains(persisted[0][3], "[PRV-01, step 3.2]", "log records the full cited answer");
              Assert.equal(persisted[0][5], "", "answered -> empty Refused cell");
              Assert.equal(persisted[0][6], "abcdef123456", "log carries the corpus fp12");
              // ***UPDATED*** the appended columns on the healthy path
              Assert.ok(typeof persisted[0][8] === "number" && persisted[0][8] >= 0, "duration persisted in ms");
              Assert.equal(persisted[0][9], "ok", "healthy ask -> status ok");
            }))));
    });
  });

  runner.add("[integration] trap path: refusal surfaces the escape phrase, persists flagged, no throw", () => {
    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      try { if (!GeminiLib) return Assert.skip("GeminiLib not bound."); }
      catch (e) { return Assert.skip("GeminiLib not bound in this project."); }

      const fake = new CorpusFakeSheetService();
      const ctx = CorpusFixtures.minimalCtx(fake);
      const canned = { answer: "not determinable from the corpus", citations: [], not_in_corpus: true };

      withLedgerBackend_(fake, (journal) =>
        withPatched_(CorpusStore, "get", () => "", () =>
          withPatched_(CorpusQaService, "loadContext_", () => "(test digest)", () =>
            withPatched_(GeminiService.prototype, "answerFromCorpus", () => canned, () => {
              const res = CorpusQaService.ask("What is the supplier onboarding SLA?", ctx);
              Assert.equal(res.not_in_corpus, true, "refusal flag surfaced");
              Assert.contains(res.answer, "not determinable from the corpus", "the exact escape phrase");
              Assert.deepEqual(res.citations, [], "no citations invented for a refusal");
              Assert.equal(fake.debugRows.length, 1, "refusals audit too");
              const persisted = journal["QA_LOG"] || [];
              Assert.equal(persisted.length, 1, "refusals persist too — the escape hatch is a first-class outcome");
              Assert.equal(persisted[0][5], "yes", "…flagged in the Refused column");
            }))));
    });
  });

  // A throwing Gemini call must leave a durable, flagged trace and
  // STILL throw -- the log keeps the truth, the client's failure handler keeps the presentation.
  runner.add("[integration] failure path: Gemini throw persists an error row with duration, then rethrows", () => {
    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      try { if (!GeminiLib) return Assert.skip("GeminiLib not bound."); }
      catch (e) { return Assert.skip("GeminiLib not bound in this project."); }

      const fake = new CorpusFakeSheetService();
      const ctx = CorpusFixtures.minimalCtx(fake);

      withLedgerBackend_(fake, (journal) =>
        withPatched_(CorpusStore, "get", () => "", () =>
          withPatched_(CorpusQaService, "loadContext_", () => "(test digest)", () =>
            withPatched_(GeminiService.prototype, "answerFromCorpus", () => { throw new Error("VERTEX_QUOTA boom"); }, () => {
              let thrown = null;
              try { CorpusQaService.ask("Which recipes call INV-01?", ctx); }
              catch (e) { thrown = e; }
              Assert.ok(thrown && String(thrown.message).indexOf("VERTEX_QUOTA boom") !== -1,
                "the original error still reaches the caller -- failure handlers own presentation");
              const persisted = journal["QA_LOG"] || [];
              Assert.equal(persisted.length, 1, "O7: the failed ask persists as a visible row");
              Assert.contains(persisted[0][3], "ASK FAILED", "the Answer cell says what happened");
              Assert.contains(persisted[0][3], "VERTEX_QUOTA boom", "…and names the cause");
              Assert.equal(persisted[0][9], "error", "flagged in the Status column");
              Assert.ok(typeof persisted[0][8] === "number" && persisted[0][8] >= 0, "duration still measured");
              Assert.equal(fake.debugRows.length, 1, "failures audit too");
            }))));
    });
  });

  runner.add("[integration] corpus prompt embeds the contract verbatim, before the digest and the question", () => {
    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      let svc;
      try { svc = new GeminiService(); }
      catch (e) {
        if (_isMissingLibrary_(e)) return Assert.skip("GeminiLib not bound in this project.");
        throw e;
      }
      const prompt = svc._buildCorpusPrompt("## BLOCK: HEADER\nDIGEST_SENTINEL", "QUESTION_SENTINEL");
      Assert.contains(prompt, CORPUS_ANSWER_CONTRACT, "contract embedded verbatim");
      Assert.contains(prompt, "DIGEST_SENTINEL", "digest included");
      Assert.contains(prompt, "QUESTION_SENTINEL", "question included");
      Assert.ok(prompt.indexOf(CORPUS_ANSWER_CONTRACT) < prompt.indexOf("DIGEST_SENTINEL"), "contract precedes the corpus");
      Assert.ok(prompt.indexOf("DIGEST_SENTINEL") < prompt.indexOf("QUESTION_SENTINEL"), "corpus precedes the question");
    });
  });
}

// ---------------------------------------------------------------------------------------
// LIVE EVAL — MANUAL ONLY. Real Gemini, real digest, real config. Never wired into runAllTests*.
// ---------------------------------------------------------------------------------------

/**
 * Golden questions: mustCite tokens must each appear in the answer or its citation refs;
 * mustRefuse means not_in_corpus (or the exact escape phrase) is required.
 * Seeded from the handoff; grow this list as the team finds real questions.
 */
const GOLDEN_QUESTIONS = [
  { question: "Which recipes call INV-01?", mustCite: ["INV-01"], mustRefuse: false },
  { question: "Why do lookup values carry a ~scope suffix?", mustCite: ["ADR"], mustRefuse: false },
  { question: "What changed this week?", mustCite: ["CHANGE_LOG"], mustRefuse: false },
  { question: "What is the supplier onboarding SLA?", mustCite: [], mustRefuse: true }
];

/** Runs the golden set against the real service and prints a scorecard. Costs one Gemini call per question. */
function runLiveGoldenEval() {
  const ctx = AppFactory.createContext();
  const lines = [];
  let pass = 0;

  GOLDEN_QUESTIONS.forEach(g => {
    const verdict = [];
    let ok = true;
    try {
      const res = CorpusQaService.ask(g.question, ctx);
      const haystack = `${res.answer} ${res.citations.map(c => c.ref).join(" ")}`;
      const refused = res.not_in_corpus === true || res.answer.indexOf("not determinable from the corpus") !== -1;

      if (g.mustRefuse) {
        ok = refused;
        verdict.push(refused ? "refused as required" : "VIOLATION: answered a question the corpus cannot support");
      } else {
        if (refused) { ok = false; verdict.push("VIOLATION: refused a supported question"); }
        (g.mustCite || []).forEach(tok => {
          const hit = haystack.indexOf(tok) !== -1;
          if (!hit) ok = false;
          verdict.push(hit ? `cited "${tok}"` : `VIOLATION: no "${tok}" citation`);
        });
      }
      verdict.push(`as_of ${res.as_of.generated_at} fp ${res.as_of.corpus_fp12}`);
    } catch (e) {
      ok = false;
      verdict.push(`ERROR: ${String((e && e.message) || e)}`);
    }
    if (ok) pass++;
    lines.push(`${ok ? "PASS" : "FAIL"}  ${g.question}\n      ${verdict.join("; ")}`);
  });

  lines.push(`\nScorecard: ${pass}/${GOLDEN_QUESTIONS.length} clean.`);
  const report = lines.join("\n");
  console.log(report);
  return report;
}

// ---------------------------------------------------------------------------------------
// ENTRY POINTS
// ---------------------------------------------------------------------------------------

/** Both tiers from this file only. Safe to run anytime: no real tabs, no live network. */
function runCorpusTests() {
  const runner = Toolkit.newTestRunner();
  registerCorpusHermeticTests(runner);
  registerCorpusIntegrationTests(runner);
  runner.run({ writeToSheet: false });
}

/** Tier 1 only — instant, always green. */
function runCorpusHermeticTests() {
  const runner = Toolkit.newTestRunner();
  registerCorpusHermeticTests(runner);
  runner.run({ writeToSheet: false });
}

/** The whole estate in one report: 50_Tests tiers + 52's ledger tiers + these. */
function runAllTestsWithCorpus() {
  const runner = Toolkit.newTestRunner();
  registerHermeticTests(runner);
  registerIntegrationTests(runner);
  registerLedgerHermeticTests(runner);
  registerLedgerIntegrationTests(runner);
  registerCorpusHermeticTests(runner);
  registerCorpusIntegrationTests(runner);
  runner.run({ writeToSheet: false });
}
