/**
 * @file 53_Tests_Corpus.js
 * @description
 *   Test coverage for Corpus Q&A (13_Feature_CorpusQa, the GeminiService.answerFromCorpus surface,
 *   and the cron/config wiring). Same two-tier scheme as 50/52:
 *
 *   TIER 1 — HERMETIC  (registerCorpusHermeticTests)
 *     Pure logic in THIS project: digest assembly and block order, fingerprint determinism, the
 *     unchanged-skips-write gate, the oversize refusal, the recent-changes window, answer-contract
 *     content, response shaping, config + cron wiring. Sheet reads ride the withLedgerBackend_
 *     in-memory backend; Drive and ConfigStore are prototype/seam-patched. No real tabs, no network.
 *
 *   TIER 2 — INTEGRATION  (registerCorpusIntegrationTests)
 *     Crosses into GeminiLib via GeminiService with a canned answerFromCorpus — ask() end-to-end
 *     (shape, as-of chip, audit row), the refusal trap path, and the corpus prompt carrying the
 *     contract verbatim. Skips cleanly when the library isn't bound, matching the 50/52 philosophy.
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

// =======================================================================================
// FIXTURES (corpus-specific; complements Fixtures in 50 and LedgerFixtures in 52)
// =======================================================================================

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

// =======================================================================================
// TIER 1 — HERMETIC
// =======================================================================================
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

// =======================================================================================
// TIER 2 — INTEGRATION (GeminiLib via GeminiService with a canned answer; SKIP if unbound)
// =======================================================================================
function registerCorpusIntegrationTests(runner) {

  runner.add("[integration] ask() end-to-end: shape, as-of chip from the store, one audit row", () => {
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
          })));
    });
  });

  runner.add("[integration] trap path: not_in_corpus surfaces the escape phrase, empty citations, no throw", () => {
    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      try { if (!GeminiLib) return Assert.skip("GeminiLib not bound."); }
      catch (e) { return Assert.skip("GeminiLib not bound in this project."); }

      const fake = new CorpusFakeSheetService();
      const ctx = CorpusFixtures.minimalCtx(fake);
      const canned = { answer: "not determinable from the corpus", citations: [], not_in_corpus: true };

      withPatched_(CorpusStore, "get", () => "", () =>
        withPatched_(CorpusQaService, "loadContext_", () => "(test digest)", () =>
          withPatched_(GeminiService.prototype, "answerFromCorpus", () => canned, () => {
            const res = CorpusQaService.ask("What is the supplier onboarding SLA?", ctx);
            Assert.equal(res.not_in_corpus, true, "refusal flag surfaced");
            Assert.contains(res.answer, "not determinable from the corpus", "the exact escape phrase");
            Assert.deepEqual(res.citations, [], "no citations invented for a refusal");
            Assert.equal(fake.debugRows.length, 1, "refusals audit too");
          })));
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

// =======================================================================================
// LIVE EVAL — MANUAL ONLY. Real Gemini, real digest, real config. Never wired into runAllTests*.
// =======================================================================================

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

// =======================================================================================
// ENTRY POINTS
// =======================================================================================

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
