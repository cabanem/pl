/**
 * @file 52_Tests_ChangeLedger.js
 * @description
 *   Test coverage for the change-ledger wiring (11_Feature_ChangeLedger, AiGate,
 *   12_Cron, the AiAnalysisRunner merge/stamp changes, and the GeminiService
 *   evidence contract). Same two-tier scheme as 50_Tests_Integration:
 *
 *   TIER 1 — HERMETIC  (registerLedgerHermeticTests)
 *     Pure logic in THIS project: diff classification, fingerprinting, the
 *     change-window helper, gate math, schema-drift guards, cron wiring.
 *     Sheet-touching readers are prototype-patched to in-memory backends,
 *     so NOTHING here reads or writes a real tab. Deterministic, fast.
 *
 *   TIER 2 — INTEGRATION  (registerLedgerIntegrationTests)
 *     Crosses into the bound libraries (WorkatoGraphLib, OrderLib, GeminiLib)
 *     with FakeWorkatoClient seeds — the full ledger lifecycle (baseline →
 *     quiet night → code change → edge removal) and the gated AI runner's
 *     merge / Source FP stamping / error-row alignment. Skips cleanly when a
 *     library isn't bound, matching the 50_Tests philosophy. Still no real
 *     tabs and no live network: fakes all the way down.
 *
 *   ENTRY POINTS (run from the editor)
 *     runLedgerTests()          — both tiers, this file only
 *     runLedgerHermeticTests()  — Tier 1 only (always green, instant)
 *     runAllTestsWithLedger()   — the ENTIRE suite: 50_Tests tiers + these
 *
 *   To fold these into your existing runAllTests() permanently, add two lines
 *   inside it:
 *       registerLedgerHermeticTests(runner);
 *       registerLedgerIntegrationTests(runner);
 */

// ---------------------------------------------------------------------------------------
// HARNESS FIX: bind the Assert global.
// 50_Tests_Integration.js calls bare `Assert.*` throughout, but nothing in the
// project ever binds it — Toolkit.asserts() is the factory (per the toolkit
// README's boundary probe: "asserts() returns the class as a value"). Without
// this line the existing suite throws ReferenceError on its first assertion.
// If you later bind Assert elsewhere, delete this line.
// ---------------------------------------------------------------------------------------
var Assert = Toolkit.asserts();

// =======================================================================================
// FIXTURES (ledger-specific; complements Fixtures in 50_Tests_Integration)
// =======================================================================================
class LedgerFixtures {
  /** A recipe with no outbound calls — keeps graph packs trivial and warn-free. */
  static simpleRecipe(id, name) {
    return Fixtures.recipePayload(String(id), name, "p1", "f1", {
      block: [{ provider: "gmail", name: "Trigger: New email", input: { subject: "Hello" } }]
    });
  }

  /**
   * ***UPDATED*** Root recipe code with REAL Workato call-action names. The extractor grades an
   * edge STRONG only when provider ∈ RECIPE_PROVIDERS AND step.name ∈ CALL_ACTION_NAMES
   * ('call_recipe' / 'call_recipe_async') — friendly display names go in `as`. The 50-file fixture
   * uses friendly names as `name`, so ALL its edges are weak by design; fine for shape tests,
   * wrong for a corpus-ordering test. The last step is a deliberate weak decoy: an id-shaped key
   * on a non-call step, which must surface as a WEAK_EDGE finding and never as an edge.
   */
  static rootRecipeCode() {
    return {
      block: [
        { provider: "gmail", name: "Trigger: New email", input: { subject: "Hello" } },
        {
          keyword: "if",
          name: "Is urgent?",
          input: { operand: "and", conditions: [{ lhs: "sev", operand: "=", rhs: "P1" }] },
          block: [
            { provider: "workato_recipe_function", name: "call_recipe", as: "Call Escalation", input: { flow_id: "200" } }
          ],
          else_block: [
            { provider: "workato_recipe_function", name: "call_recipe", as: "Call Triage", input: { recipe_id: "300" } }
          ],
          error_block: [
            { provider: "workato_callable_recipe", name: "call_recipe", as: "Fallback callable", input: { callable_recipe_id: "400" } }
          ]
        },
        { provider: "workato_recipe_function", name: "call_recipe_async", as: "Call Billing helper", input: { flow_id: "500" } },
        { provider: "gmail", name: "Log reference", input: { note: { recipe_id: "999" } } }
      ]
    };
  }

  /**
   * A three-recipe corpus for the ledger lifecycle:
   *   100 -> 200 (IF branch), 100 -> 300 (ELSE branch),
   *   plus strong calls to 400 (error block) and 500 (top level), which are
   *   deliberately NOT in the corpus — they must surface as EXTERNAL_CALLEE
   *   findings in the AMBIGUITY report, never as edges — and one weak decoy (999).
   */
  static corpusRecipes() {
    return [
      Fixtures.recipePayload("100", "PRV-01 Root", "p1", "f1", LedgerFixtures.rootRecipeCode()),
      LedgerFixtures.simpleRecipe("200", "INV-01 Escalation"),
      LedgerFixtures.simpleRecipe("300", "INV-02 Triage")
    ];
  }

  /** Returns a copy of a recipe payload with one harmless character changed inside its code. */
  static withTouchedCode(recipe) {
    const code = JSON.parse(recipe.code);
    code.block[0].input.subject = String(code.block[0].input.subject || "") + "!";
    return { ...recipe, code: JSON.stringify(code) };
  }

  /** Returns a copy of the branches fixture recipe with its ELSE-branch call removed. */
  static withoutElseCall(recipe) {
    const code = JSON.parse(recipe.code);
    const ifStep = code.block.find(s => s.keyword === "if");
    if (ifStep) delete ifStep.else_block;
    return { ...recipe, code: JSON.stringify(code) };
  }
}

// =======================================================================================
// PATCH HELPERS — save / replace / restore prototype methods, always in finally.
// The ledger's direct-SpreadsheetApp readers get an in-memory backend so tests
// never touch real tabs; production code is untouched.
// =======================================================================================

/** Runs fn with obj[method] temporarily replaced; always restores. */
function withPatched_(obj, method, impl, fn) {
  const original = obj[method];
  obj[method] = impl;
  try { return fn(); } finally { obj[method] = original; }
}

/**
 * Installs an in-memory sheet backend on ChangeLedgerRunner for the duration of fn:
 *   - readRows_(key)  reads the journal store first (CHANGE_LOG), then whatever
 *     writeState_ last wrote into the FakeSheetService (minus its header row)
 *   - appendRows_(key, header, rows) appends into the journal store
 * writeState_ itself is NOT patched — it already goes through ctx.sheetService,
 * so the fake captures state writes exactly as production would.
 */
function withLedgerBackend_(fakeSheets, fn) {
  const journal = {};                                  // { key: rows[] } — no header
  const origRead = ChangeLedgerRunner.prototype.readRows_;
  const origAppend = ChangeLedgerRunner.prototype.appendRows_;

  ChangeLedgerRunner.prototype.readRows_ = function (key) {
    if (journal[key]) return journal[key].map(r => r.slice());
    const written = fakeSheets.writtenData[key];
    return written ? written.slice(1).map(r => r.slice()) : [];
  };
  ChangeLedgerRunner.prototype.appendRows_ = function (key, header, rows) {
    if (!journal[key]) journal[key] = [];
    rows.forEach(r => journal[key].push(r.slice()));
  };

  try { return fn(journal); }
  finally {
    ChangeLedgerRunner.prototype.readRows_ = origRead;
    ChangeLedgerRunner.prototype.appendRows_ = origAppend;
  }
}

/** Minimal ctx for ledger/runner tests — no real WorkatoClient, no real sheets. */
function makeFakeCtx_(fakeClient, fakeSheets) {
  return {
    config: AppConfig.get(),
    client: fakeClient,
    analyzerService: new RecipeAnalyzerService(fakeClient),
    sheetService: fakeSheets,
    driveService: new FakeDriveService(),
    inventoryService: null,
    logger: AppLog
  };
}

// =======================================================================================
// TIER 1 — HERMETIC
// =======================================================================================
function registerLedgerHermeticTests(runner) {

  // --- diff classification --------------------------------------------------------------
  runner.add("[hermetic] ledger.diffRecipes_ classifies added / modified / removed", () => {
    const led = new ChangeLedgerRunner();
    const prev = new Map([
      ["1", { name: "Same", fp: "aaa" }],
      ["2", { name: "Changed", fp: "bbb" }],
      ["3", { name: "Gone", fp: "ccc" }]
    ]);
    const curr = new Map([
      ["1", { name: "Same", fp: "aaa" }],
      ["2", { name: "Changed", fp: "b2b" }],
      ["4", { name: "New", fp: "ddd" }]
    ]);
    const rows = led.diffRecipes_(prev, curr, "2026-08-26T00:00:00Z");
    const byChange = c => rows.filter(r => r[2] === c);
    Assert.equal(rows.length, 3, "exactly three changes");
    Assert.equal(byChange("modified")[0][3], "Changed", "modified names the recipe");
    Assert.equal(byChange("added")[0][4], "4", "added carries the id in detail");
    Assert.equal(byChange("removed")[0][3], "Gone", "removed names the recipe");
  });

  runner.add("[hermetic] ledger.diffRecipes_ is silent on identical states", () => {
    const led = new ChangeLedgerRunner();
    const state = new Map([["1", { name: "A", fp: "x" }]]);
    Assert.deepEqual(led.diffRecipes_(state, new Map(state), "t"), [], "no rows on a quiet day");
  });

  // --- fingerprints ---------------------------------------------------------------------
  runner.add("[hermetic] ledger.sha256_ is 64-hex, deterministic, change-sensitive", () => {
    const a1 = ChangeLedgerRunner.sha256_("recipe-code");
    const a2 = ChangeLedgerRunner.sha256_("recipe-code");
    const b  = ChangeLedgerRunner.sha256_("recipe-code!");
    Assert.ok(/^[0-9a-f]{64}$/.test(a1), "64 lowercase hex chars");
    Assert.equal(a1, a2, "same input, same digest");
    Assert.notEqual(a1, b, "one changed character, different digest");
  });

  // --- edge labels ----------------------------------------------------------------------
  runner.add("[hermetic] ledger.edgeLabel_ resolves names and falls back to ids", () => {
    const led = new ChangeLedgerRunner();
    const curr = new Map([["100", { name: "PRV-01", fp: "" }]]);
    Assert.equal(led.edgeLabel_("100->999", curr), "PRV-01 -> 999", "known caller, unknown callee");
  });

  // --- change window helper (feeds cron_maps / weekly docs) -----------------------------
  runner.add("[hermetic] changedRecipeIds windows by days, filters kind/change, dedupes", () => {
    const day = 24 * 60 * 60 * 1000;
    const iso = (ago) => new Date(Date.now() - ago * day).toISOString();
    const rows = [
      [iso(0.5), "recipe", "modified", "A", "100"],
      [iso(3),   "recipe", "added",    "B", "200"],
      [iso(3),   "recipe", "modified", "A", "100"],   // duplicate id — must dedupe
      [iso(3),   "recipe", "removed",  "C", "300"],   // removed — excluded
      [iso(3),   "edge",   "added",    "A -> B", "100->200"], // wrong kind — excluded
      [iso(10),  "recipe", "modified", "D", "400"]    // outside window — excluded
    ];
    withPatched_(ChangeLedgerRunner.prototype, "readRows_", () => rows, () => {
      const ids = ChangeLedgerRunner.changedRecipeIds(7).sort();
      Assert.deepEqual(ids, ["100", "200"], "in-window added/modified recipe ids, deduped");
      Assert.deepEqual(ChangeLedgerRunner.changedRecipeIds(1), ["100"], "1-day window");
    });
  });

  // --- schema-drift guards: the gate's one hardcoded number ----------------------------
  runner.add("[hermetic] AI_ANALYSIS header agrees with AiGate.SOURCE_FP_COL", () => {
    const header = SchemaDef.HEADERS.AI_ANALYSIS;
    Assert.equal(header.length, 16, "16 columns");
    Assert.equal(header[AiGate.SOURCE_FP_COL], "Source FP", "gate column index points at Source FP");
    Assert.equal(header[AiGate.SOURCE_FP_COL + 1], "Timestamp", "Timestamp immediately after");
  });

  // --- gate math ------------------------------------------------------------------------
  runner.add("[hermetic] AiGate.staleIds: fp mismatch + missing row are stale; cap respected", () => {
    const FP = AiGate.SOURCE_FP_COL;
    const fingerprints = [
      ["100", "Fresh",   "fp-100"],
      ["200", "Stale",   "fp-200-new"],
      ["300", "NoRow",   "fp-300"]
    ];
    const analysisRow = (id, fp) => { const r = Array(16).fill(""); r[0] = id; r[FP] = fp; return r; };
    const analysis = [analysisRow("100", "fp-100"), analysisRow("200", "fp-200-old")];

    withPatched_(ChangeLedgerRunner.prototype, "readRows_", (key) =>
      key === "FINGERPRINTS" ? fingerprints : (key === "AI_ANALYSIS" ? analysis : []), () => {
      Assert.deepEqual(AiGate.staleIds(10).sort(), ["200", "300"], "mismatch + missing, fresh excluded");
      Assert.equal(AiGate.staleIds(1).length, 1, "cap limits candidates per run");
      Assert.equal(AiGate.fpMap().get("200"), "fp-200-new", "fpMap serves the ledger's current fp");
    });
  });

  runner.add("[hermetic] AiGate.staleIds is empty before the first ledger run", () => {
    withPatched_(ChangeLedgerRunner.prototype, "readRows_", () => [], () => {
      Assert.deepEqual(AiGate.staleIds(10), [], "no FINGERPRINTS -> nothing stale -> cron_ai no-ops");
    });
  });

  // --- state writes ---------------------------------------------------------------------
  runner.add("[hermetic] ledger.writeState_ writes header-only when there is nothing to report", () => {
    const fake = new FakeSheetService();
    new ChangeLedgerRunner().writeState_({ sheetService: fake }, "AMBIGUITY",
      ["date_iso", "level", "code", "detail"], []);
    Assert.equal(fake.writtenData["AMBIGUITY"].length, 1, "header row only — a clean report is a real state");
  });

  runner.add("[hermetic] ledger.sheetName_ resolves SchemaDef keys to configured tab names", () => {
    const led = new ChangeLedgerRunner();
    Assert.equal(led.sheetName_("FINGERPRINTS"), SchemaDef.SHEETS.FINGERPRINTS, "key -> configured name");
    Assert.equal(led.sheetName_("NOT_A_KEY"), "NOT_A_KEY", "unknown keys pass through");
  });

  // --- cron wiring ----------------------------------------------------------------------
  runner.add("[hermetic] every CRON_NIGHTLY handler exists as a function", () => {
    CRON_NIGHTLY.forEach(c =>
      Assert.equal(typeof globalThis[c.handler], "function", `${c.handler} is defined`));
    Assert.equal(typeof cron_docs_weekly, "function", "weekly handler is defined");
    Assert.equal(typeof runGuarded_, "function", "guard is defined");
  });

  runner.add("[hermetic] INTEGRATION config block carries the cron's knobs", () => {
    const integ = AppConfig.get().INTEGRATION;
    Assert.ok(integ, "INTEGRATION block present");
    Assert.ok(Number(integ.AI_MAX_PER_RUN) > 0, "AI_MAX_PER_RUN is a positive number");
    Assert.ok("ALERT_EMAIL" in integ, "ALERT_EMAIL key present (may be empty until configured)");
  });
}

// =======================================================================================
// TIER 2 — INTEGRATION (WorkatoGraphLib + OrderLib + GeminiLib via fakes; SKIP if unbound)
// =======================================================================================
function registerLedgerIntegrationTests(runner) {

  runner.add("[integration] ledger lifecycle: baseline -> quiet -> code change -> edge removal", () => {
    const fakeClient = new FakeWorkatoClient();
    const fakeSheets = new FakeSheetService();
    fakeClient.setResponse("recipes", LedgerFixtures.corpusRecipes());

    let ctx;
    try {
      ctx = makeFakeCtx_(fakeClient, fakeSheets);
      OrderLib.newOrderer({ strict: false });          // probe the binding early for a clean skip
    } catch (e) {
      if (_isMissingLibrary_(e)) return Assert.skip("WorkatoGraphLib / OrderLib not bound in this project.");
      throw e;
    }

    withLedgerBackend_(fakeSheets, (journal) => {
      const led = new ChangeLedgerRunner();

      // RUN 1 — baseline
      led.run(ctx);
      const log = () => journal["CHANGE_LOG"] || [];
      Assert.equal(log().length, 1, "baseline journals exactly one row");
      Assert.equal(log()[0][1], "system", "…of kind system");
      Assert.equal(fakeSheets.writtenData["FINGERPRINTS"].length, 4, "header + 3 recipe fingerprints");
      const edgeState = fakeSheets.writtenData["EDGE_STATE"].slice(1).map(r => r.join("->")).sort();
      Assert.deepEqual(edgeState, ["100->200", "100->300"], "strong call edges only — weak/external never ordered"); // ***UPDATED***
      const ambiguity = fakeSheets.writtenData["AMBIGUITY"].slice(1).map(r => r.join(" "));
      Assert.ok(ambiguity.some(s => s.includes("400")), "external callee 400 reported, not ordered");
      Assert.ok(ambiguity.some(s => s.includes("500")), "external callee 500 reported, not ordered");
      Assert.ok(ambiguity.some(s => s.includes("WEAK_EDGE") && s.includes("999")),
        "id-shaped key on a non-call step reported weak, never ordered"); // ***UPDATED*** the extractor's honesty, now covered

      // RUN 2 — quiet night: same estate, journal must not grow
      led.run(ctx);
      Assert.equal(log().length, 1, "a quiet night journals nothing");

      // RUN 3 — one character changed inside recipe 100's code
      const touched = LedgerFixtures.corpusRecipes();
      touched[0] = LedgerFixtures.withTouchedCode(touched[0]);
      fakeClient.setResponse("recipes", touched);
      ctx.analyzerService = new RecipeAnalyzerService(fakeClient);   // fresh engine cache for the new payloads
      led.run(ctx);
      const run3 = log().slice(1);
      Assert.equal(run3.length, 1, "exactly one new journal row");
      Assert.equal(run3[0][2], "modified", "…a recipe modification");
      Assert.contains(run3[0][3], "PRV-01", "…naming the touched recipe");

      // RUN 4 — remove the ELSE-branch call: recipe modified AND edge removed
      const pruned = LedgerFixtures.corpusRecipes();
      pruned[0] = LedgerFixtures.withoutElseCall(pruned[0]);
      fakeClient.setResponse("recipes", pruned);
      ctx.analyzerService = new RecipeAnalyzerService(fakeClient);
      led.run(ctx);
      const run4 = log().slice(2);
      const changes = run4.map(r => `${r[1]}:${r[2]}`).sort();
      Assert.deepEqual(changes, ["edge:removed", "recipe:modified"], "both dimensions journaled");
      const edgeRow = run4.find(r => r[1] === "edge");
      Assert.contains(edgeRow[4], "100->300", "the removed edge is the ELSE call");
      Assert.equal(fakeSheets.writtenData["EDGE_STATE"].length, 2, "state now header + one edge");
    });
  });

  runner.add("[integration] AiAnalysisRunner merges kept rows, stamps Source FP, aligns error rows", () => {
    let gemini;
    try {
      OrderLib.newOrderer({ strict: false });          // ledger readers are involved; probe bindings
      gemini = GeminiLib;                              // reference probes the binding
      if (!gemini) return Assert.skip("GeminiLib not bound.");
    } catch (e) {
      if (_isMissingLibrary_(e)) return Assert.skip("A required library is not bound in this project.");
      throw e;
    }

    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      const fakeClient = new FakeWorkatoClient();
      const fakeSheets = new FakeSheetService();
      fakeClient.setResponse("recipes/100", LedgerFixtures.simpleRecipe("100", "PRV-01 Root"));
      // note: recipe 77 is deliberately NOT seeded — it must travel the error path.

      const FP = AiGate.SOURCE_FP_COL;
      const legacyKept = Array(15).fill("");           // a pre-patch 15-wide row that must survive, padded
      legacyKept[0] = "900"; legacyKept[1] = "Keep Me"; legacyKept[14] = "2026-01-01T00:00:00Z";

      const fingerprints = [["100", "PRV-01 Root", "fp-100"], ["77", "Broken", "fp-77"], ["900", "Keep Me", "fp-900"]];

      withLedgerBackend_(fakeSheets, () => {
        // Seed the analysis "sheet" the way production would find it: header + legacy row.
        fakeSheets.writtenData["AI_ANALYSIS"] = [SchemaDef.HEADERS.AI_ANALYSIS, legacyKept];
        fakeSheets.writtenData["FINGERPRINTS"] = [SchemaDef.HEADERS.FINGERPRINTS, ...fingerprints];

        const canned = { objective: "Test objective", trigger: "Manual", high_level_flow: ["Does a thing (step 1)"],
                         hotspots: [], external_apps: [], called_recipes: [], risks_notes: [] };

        withPatched_(GeminiService.prototype, "explainRecipeStructured", () => canned, () => {
          let ctx;
          try { ctx = makeFakeCtx_(fakeClient, fakeSheets); }
          catch (e) {
            if (_isMissingLibrary_(e)) return Assert.skip("WorkatoGraphLib not bound.");
            throw e;
          }
          new AiAnalysisRunner().run(ctx, ["100", "77"]);
        });

        const written = fakeSheets.writtenData["AI_ANALYSIS"];
        Assert.equal(written.length, 4, "header + kept + success + error");
        written.forEach((r, i) => Assert.equal(r.length, 16, `row ${i} is 16 wide`));

        const kept = written.find(r => String(r[0]) === "900");
        Assert.ok(kept, "row for an id NOT in this run survived the write");
        Assert.equal(kept[15], "", "legacy row padded, not shifted");

        const success = written.find(r => String(r[0]) === "100");
        Assert.equal(success[FP], "fp-100", "Source FP stamped from the ledger");
        Assert.contains(success[FP + 1], "T", "Timestamp in its own column");
        Assert.equal(success[2], "Test objective", "structured fields landed");

        const err = written.find(r => String(r[0]) === "77");
        Assert.equal(err[1], "Error", "unseeded id travelled the error path");
        Assert.equal(err[FP], "fp-77", "error row carries current fp — re-runs on change, not nightly");
        Assert.contains(err[FP + 1], "T", "error timestamp in the Timestamp column");
      });
    });
  });

  runner.add("[integration] evidence contract present in the structured prompt", () => {
    withTestConfig({ VERTEX: { GOOGLE_CLOUD_PROJECT_ID: "test-project" } }, () => {
      let svc;
      try { svc = new GeminiService(); }
      catch (e) {
        if (_isMissingLibrary_(e)) return Assert.skip("GeminiLib not bound in this project.");
        throw e;
      }
      const prompt = svc._buildStructuredPrompt({ name: "R", description: "", trigger_app: "",
        connected_apps: [], logic_digest: "1. Trigger (gmail)", graphs: null });
      Assert.contains(prompt, "(step N)", "citation form required");
      Assert.contains(prompt, "not determinable from recipe code", "no-inference escape hatch required");
      Assert.contains(prompt, "Never speculate about intent", "intent guard present");
    });
  });
}

// =======================================================================================
// ENTRY POINTS
// =======================================================================================
/** Both tiers from this file only. Safe to run anytime: no real tabs, no live network. */
function runLedgerTests() {
  const runner = Toolkit.newTestRunner();
  registerLedgerHermeticTests(runner);
  registerLedgerIntegrationTests(runner);
  runner.run({ writeToSheet: false });
}

/** Tier 1 only — instant, always green. */
function runLedgerHermeticTests() {
  const runner = Toolkit.newTestRunner();
  registerLedgerHermeticTests(runner);
  runner.run({ writeToSheet: false });
}

/** The whole estate: 50_Tests tiers + the ledger tiers, one report. */
function runAllTestsWithLedger() {
  const runner = Toolkit.newTestRunner();
  registerHermeticTests(runner);
  registerIntegrationTests(runner);
  registerLedgerHermeticTests(runner);
  registerLedgerIntegrationTests(runner);
  runner.run({ writeToSheet: false });
}
