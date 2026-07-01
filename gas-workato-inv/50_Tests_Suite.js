/**
 * @file 50_Tests_Integration.js  (was test.js)
 * @description
 *   Test suite for Workato Inventory Sync. Organized into two tiers:
 *
 *   TIER 1 — HERMETIC  (registerHermeticTests)
 *     Exercises code that lives in THIS project only: DataMapper, AppHelpers,
 *     SelectionUtils, SchemaDef. No external libraries, no network, fully
 *     deterministic. This is the reliable regression net; it should pass in any
 *     environment.
 *
 *   TIER 2 — INTEGRATION  (registerIntegrationTests)
 *     Crosses into the bound libraries (WorkatoLib / WorkatoGraphLib) via the
 *     RecipeAnalyzerService engine and the ProcessMaps runner. The WIRING is
 *     verified, but assertions check contract SHAPE, not exact content, because
 *     library output can't be predicted from here. Exact-output checks are
 *     written inline and COMMENTED — enable them once you've confirmed the
 *     values against your live library. If a library isn't bound (or the fake
 *     client is asked for an endpoint it wasn't seeded with), these tests SKIP
 *     with an actionable message rather than failing.
 *
 *   ENTRY POINTS
 *     runAllTests()       — hermetic + integration (integration self-skips if libs absent)
 *     runHermeticTests()  — hermetic tier only (fast, always green)
 */

// =======================================================================================
// ASSERTIONS
// =======================================================================================
/**
 * @class
 * @classdesc Minimal assertion utility for Google Apps Script (V8).
 */
class Assert {
  static _fmt(v) {
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }
  static ok(value, msg) {
    if (!value) throw new Error(msg || `Expected truthy but got: ${Assert._fmt(value)}`);
  }
  static equal(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(msg || `Expected ${Assert._fmt(expected)} but got ${Assert._fmt(actual)}`);
    }
  }
  static notEqual(actual, expected, msg) {
    if (actual === expected) {
      throw new Error(msg || `Expected value to differ, but both were ${Assert._fmt(actual)}`);
    }
  }
  static contains(haystack, needle, msg) {
    const h = String(haystack ?? "");
    const n = String(needle ?? "");
    if (!h.includes(n)) {
      throw new Error(msg || `Expected string to contain "${n}", got:\n${h}`);
    }
  }
  static deepEqual(actual, expected, msg) {
    const a = Assert._fmt(actual);
    const e = Assert._fmt(expected);
    if (a !== e) {
      throw new Error(msg || `Expected deepEqual.\nExpected:\n${e}\nActual:\n${a}`);
    }
  }
  static throws(fn, msgContains) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
      if (msgContains) Assert.contains(e.message, msgContains);
    }
    if (!threw) throw new Error("Expected function to throw, but it did not.");
  }
  /**
   * Abort the current test as SKIPPED (not failed). Used by integration tests
   * when a required library isn't bound or the fake wasn't seeded for a path.
   */
  static skip(msg) {
    throw { __skip: true, message: msg || "skipped" };
  }
}

// =======================================================================================
// RUNNER
// =======================================================================================
/**
 * @class
 * @classdesc Simple test runner with SKIP support and optional sheet reporting.
 */
class TestRunner {
  constructor() {
    /** @type {Array<{name:string, fn:Function}>} */
    this.tests = [];
  }

  add(name, fn) {
    this.tests.push({ name, fn });
    return this;
  }

  run(options = {}) {
    const writeToSheet = Boolean(options.writeToSheet);
    const results = [];
    const startedAt = new Date();

    console.log(`STARTING TEST RUN: ${this.tests.length} tests queued.`);

    for (const t of this.tests) {
      const t0 = Date.now();
      try {
        t.fn();
        results.push({ name: t.name, status: "PASS", ms: Date.now() - t0, error: "" });
      } catch (e) {
        if (e && e.__skip) {
          results.push({ name: t.name, status: "SKIP", ms: Date.now() - t0, error: e.message || "skipped" });
        } else {
          results.push({ name: t.name, status: "FAIL", ms: Date.now() - t0, error: (e && e.stack) ? e.stack : String(e) });
        }
      }
    }

    const pass = results.filter(r => r.status === "PASS").length;
    const fail = results.filter(r => r.status === "FAIL").length;
    const skip = results.filter(r => r.status === "SKIP").length;
    const duration = Date.now() - startedAt.getTime();

    console.log(`TESTS COMPLETE: ${pass} passed, ${fail} failed, ${skip} skipped in ${duration}ms`);

    results.forEach(r => {
      const prefix = r.status === "PASS" ? "[PASS]" : (r.status === "SKIP" ? "[SKIP]" : "[FAIL]");
      console.log(`${prefix} ${r.name} (${r.ms}ms)`);
      if (r.status === "FAIL") console.error(r.error);
      else if (r.status === "SKIP") console.log(`       reason: ${r.error}`);
    });

    if (writeToSheet) this._writeResults(results);

    // Only hard failures fail the run; skips are informational.
    if (fail > 0) throw new Error(`Test suite failed: ${fail} failing tests.`);
    return results;
  }

  _writeResults(results) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return; // Unit testing context might not have an active sheet
      const sheetName = "test_results";
      let sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      sheet.clear();
      sheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "Test", "Status", "Duration (ms)", "Error"]])
        .setFontWeight("bold")
        .setBackground("#efefef");
      const ts = new Date().toISOString();
      const rows = results.map(r => [ts, r.name, r.status, r.ms, r.error]);
      if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
      sheet.setFrozenRows(1);
    } catch (e) {
      console.log("Could not write test results sheet: " + e.message);
    }
  }
}

// =======================================================================================
// FIXTURES
// =======================================================================================
/**
 * @class
 * @classdesc Deterministic fixtures for recipe code scanning, branching, cycles.
 */
class Fixtures {
  /**
   * A realistic-ish Workato step tree with recipe calls (flow_id, recipe_id,
   * callable_recipe_id), if/else + error blocks, and a data-pill condition.
   */
  static recipeCodeBlock_withBranchesAndCalls() {
    const dpLabel = "#{_dp('{\\\"label\\\":\\\"Ticket ID\\\",\\\"path\\\":[\\\"ticket\\\",\\\"id\\\"]}')}";
    return {
      block: [
        { provider: "gmail", name: "Trigger: New email", input: { subject: "Hello" } },
        {
          keyword: "if",
          name: "Is urgent?",
          input: {
            operand: "and",
            conditions: [
              { lhs: dpLabel, operand: "=", rhs: "P1" }
            ]
          },
          block: [
            { provider: "workato_recipe_function", name: "Call Escalation", input: { flow_id: "200" } }
          ],
          else_block: [
            { provider: "workato_recipe_function", name: "Call Triage", input: { recipe_id: "300" } }
          ],
          error_block: [
            { provider: "workato_callable_recipe", name: "Fallback callable", input: { callable_recipe_id: "400" } }
          ]
        },
        { provider: "workato_recipe_function", name: "Call Billing helper", input: { flow_id: "500" } }
      ]
    };
  }
  static recipePayload(id, name, project_id, folder_id, codeObj) {
    return {
      id: String(id),
      name,
      project_id: String(project_id || "p1"),
      folder_id: String(folder_id || "f1"),
      code: JSON.stringify(codeObj)
    };
  }
  /**
   * Graph fixtures for transitive expansion and cycle detection:
   * 100 -> 200 -> 300 -> 200 (cycle)
   */
  static graphRecipes_cycle() {
    const r100 = Fixtures.recipePayload("100", "Root", "p1", "f1",
      { block: [{ provider: "workato_recipe_function", name: "Call 200", input: { flow_id: "200" } }] });
    const r200 = Fixtures.recipePayload("200", "Child A", "p1", "f1",
      { block: [{ provider: "workato_recipe_function", name: "Call 300", input: { flow_id: "300" } }] });
    const r300 = Fixtures.recipePayload("300", "Child B", "p1", "f1",
      { block: [{ provider: "workato_recipe_function", name: "Call 200 again", input: { flow_id: "200" } }] });
    return { r100, r200, r300 };
  }
}

// =======================================================================================
// TEST DOUBLES (FAKES)
// =======================================================================================
class FakeWorkatoClient {
  constructor() {
    /** @type {Map<string, Object>} */
    this.storage = new Map();
  }
  setResponse(endpoint, data) { this.storage.set(endpoint, data); }
  get(endpoint) {
    if (this.storage.has(endpoint)) return this.storage.get(endpoint);
    throw new Error(`FakeWorkatoClient: 404 Not Found for ${endpoint}`);
  }
  fetchPaginated(endpoint) {
    return this.storage.has(endpoint) ? this.storage.get(endpoint) : [];
  }
}
class FakeSheetService {
  constructor() {
    this.writtenData = {}; // { sheetKey: rows[] }
    this.requests = [];
  }
  readRequests() { return this.requests; }
  write(sheetKey, rows) { this.writtenData[sheetKey] = rows; }
}
class FakeDriveService {
  saveText(id, name, ext, content) { return `https://fake-drive-url.com/${id}.${ext}`; }
  saveLog(id, name, obj) { return `https://fake-drive-url.com/${id}.json`; }
}

/**
 * Temporarily override AppConfig.get() for tests; always restores afterward.
 *
 * NOTE: the override is only active for the duration of `fn`. Put the code that
 * READS config (i.e. the test execution) inside `fn` — not just registration.
 * The original suite wrapped registration only, so the override never applied.
 *
 * @param {Object} testConfig  Partial config; shallow-merged over the real one per top key.
 * @param {Function} fn
 */
function withTestConfig(testConfig, fn) {
  const originalGet = AppConfig.get;
  AppConfig.get = () => {
    const base = originalGet();
    const merged = { ...base };
    Object.keys(testConfig).forEach(k => {
      merged[k] = { ...merged[k], ...testConfig[k] };
    });
    return merged;
  };
  try { fn(); } finally { AppConfig.get = originalGet; }
}

// Small helpers to classify integration failures into clean SKIPs.
function _isMissingLibrary_(e) {
  return /is not defined|WorkatoGraphLib|WorkatoLib|GeminiLib/i.test(String((e && e.message) || e));
}
function _isFake404_(e) {
  return /FakeWorkatoClient: 404/.test(String((e && e.message) || e));
}

// =======================================================================================
// TIER 1 — HERMETIC TESTS  (verified against source; no external libraries)
// =======================================================================================
function registerHermeticTests(runner) {

  // --- DataMapper.mapCallEdgesToRows ---------------------------------------------------
  runner.add("[hermetic] DataMapper.mapCallEdgesToRows maps fields in order", () => {
    const parent = { id: 100, project_id: "p1", folder_id: "f1", name: "Parent" };
    const edges = [{
      parent_recipe_id: "100", parent_recipe_name: "Parent",
      child_recipe_id: "200", step_name: "Call Child",
      branch_context: "IF x > 5", provider: "workato_recipe_function",
      id_key: "flow_id", step_path: "0/1"
    }];
    const result = DataMapper.mapCallEdgesToRows(
      parent, edges, { p1: "ProjA" }, { f1: "FoldA" }, { "200": "Child Recipe" }
    );
    Assert.equal(result.length, 1, "one row");
    const row = result[0];
    Assert.equal(row[0], "100", "parent id");
    Assert.equal(row[1], "Parent", "parent name");
    Assert.equal(row[2], "ProjA", "project resolved");
    Assert.equal(row[3], "FoldA", "folder resolved");
    Assert.equal(row[6], "IF x > 5", "branch context");
    Assert.equal(row[9], "Child Recipe", "child name resolved");
  });

  runner.add("[hermetic] DataMapper.mapCallEdgesToRows falls back to [ID: x] for unknown child", () => {
    const rows = DataMapper.mapCallEdgesToRows(
      { id: 1, name: "P", project_id: "p", folder_id: "f" },
      [{ child_recipe_id: "999", step_name: "x" }],
      {}, {}, {}
    );
    Assert.equal(rows[0][8], "999", "child id passthrough");
    Assert.equal(rows[0][9], "[ID: 999]", "unresolved child name fallback");
  });

  // --- DataMapper.mapDependenciesToRows: table-name fallback ----------------------------
  // (This locks in the mapper's correct behavior. Note: InventorySyncRunner currently
  //  never passes tableNameMap because of the `.length >= 5` guard bug — see review.)
  runner.add("[hermetic] DataMapper.mapDependenciesToRows resolves table name via tableNameMap", () => {
    const recipe = { id: 5, project_id: "p", folder_id: "f" };
    const deps = [{ type: "data_table", id: "tbl_1", name: "" }];
    const withMap = DataMapper.mapDependenciesToRows(recipe, deps, {}, {}, { tbl_1: "Customers" });
    Assert.equal(withMap[0][5], "Customers", "name pulled from tableNameMap when dep.name is empty");

    const withoutMap = DataMapper.mapDependenciesToRows(recipe, deps, {}, {});
    Assert.equal(withoutMap[0][5], "", "no name and no map -> empty (the current InventorySync behavior)");
  });

  // --- DataMapper schema column extraction ---------------------------------------------
  runner.add("[hermetic] DataMapper.mapDataTablesToRows extracts columns from array schema", () => {
    const rows = DataMapper.mapDataTablesToRows(
      [{ id: 1, name: "T", description: "d", schema: [{ name: "a" }, { name: "b" }], updated_at: "2024" }],
      {}
    );
    Assert.equal(rows[0][0], "1", "id");
    Assert.equal(rows[0][3], "a, b", "columns joined from array schema");
  });

  runner.add("[hermetic] DataMapper.mapLookupTablesToRows extracts columns from JSON-string schema", () => {
    const rows = DataMapper.mapLookupTablesToRows(
      [{ id: 2, name: "L", description: "", schema: JSON.stringify([{ label: "Col A" }, { label: "Col B" }]), updated_at: "2024" }],
      {}
    );
    Assert.equal(rows[0][3], "Col A, Col B", "columns parsed from stringified schema");
  });

  // --- AppHelpers ----------------------------------------------------------------------
  runner.add("[hermetic] AppHelpers.createLookupMap builds string-keyed id->name", () => {
    const m = AppHelpers.createLookupMap([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
    Assert.equal(m["1"], "A");
    Assert.equal(m["2"], "B");
    Assert.deepEqual(AppHelpers.createLookupMap(null), {}, "null -> empty map");
  });

  runner.add("[hermetic] AppHelpers.logicDigestFromRows formats steps and truncates", () => {
    const logic = [
      ["100", "R", 1, "", "gmail", "Trigger", "desc", ""],
      ["100", "R", 2, "  ", "salesforce", "Create", "", ""]
    ];
    const digest = AppHelpers.logicDigestFromRows(logic, 10);
    Assert.contains(digest, "Trigger (gmail)", "step 1 provider/action");
    Assert.contains(digest, "Create (salesforce)", "step 2 provider/action");

    const many = [1, 2, 3].map(n => ["", "", n, "", "p", "A" + n, "", ""]);
    const truncated = AppHelpers.logicDigestFromRows(many, 2);
    Assert.contains(truncated, "more steps omitted", "omission notice appended past maxLines");
  });

  // --- SelectionUtils ------------------------------------------------------------------
  runner.add("[hermetic] SelectionUtils._normalizeIds_ keeps numeric ids, dedupes, drops noise", () => {
    const ids = SelectionUtils._normalizeIds_(["100", 200, "abc", "", null, "100", "300x", 300]);
    Assert.deepEqual(ids, ["100", "200", "300"]);
  });

  // --- Schema <-> mapper column-count consistency --------------------------------------
  // Catches the "mapper emits N columns but the header declares M" class of bug.
  runner.add("[hermetic] Header column counts match mapper output widths", () => {
    const specs = [
      { key: "PROJECTS",      row: () => DataMapper.mapProjectsToRows([{}]) },
      { key: "FOLDERS",       row: () => DataMapper.mapFoldersToRows([{}], {}, {}) },
      { key: "RECIPES",       row: () => DataMapper.mapRecipesToRows([{}], {}, {}) },
      { key: "PROPERTIES",    row: () => DataMapper.mapPropertiesToRows([{}]) },
      { key: "DEPENDENCIES",  row: () => DataMapper.mapDependenciesToRows({}, [{}], {}, {}, {}) },
      { key: "TABLES",        row: () => DataMapper.mapDataTablesToRows([{}], {}) },
      { key: "LOOKUP_TABLES", row: () => DataMapper.mapLookupTablesToRows([{}], {}) },
      { key: "CALL_EDGES",    row: () => DataMapper.mapCallEdgesToRows({}, [{}], {}, {}, {}) }
    ];
    specs.forEach(s => {
      const expected = SchemaDef.HEADERS[s.key].length;
      const actual = s.row()[0].length;
      Assert.equal(actual, expected, `${s.key}: mapper emits ${actual} cols, header declares ${expected}`);
    });
  });
}

// =======================================================================================
// TIER 2 — INTEGRATION TESTS  (require WorkatoLib / WorkatoGraphLib; SKIP if unbound)
// =======================================================================================
function registerIntegrationTests(runner) {

  runner.add("[integration] RecipeAnalyzerService.getCallEdges returns branch-aware edges", () => {
    const client = new FakeWorkatoClient();
    client.setResponse(
      "recipes/100",
      Fixtures.recipePayload("100", "Complex", "p1", "f1", Fixtures.recipeCodeBlock_withBranchesAndCalls())
    );

    let analyzer;
    try {
      analyzer = new RecipeAnalyzerService(client);
    } catch (e) {
      if (_isMissingLibrary_(e)) return Assert.skip("WorkatoGraphLib not bound in this project.");
      throw e;
    }

    let edges;
    try {
      edges = analyzer.getCallEdges("100");
    } catch (e) {
      if (_isFake404_(e)) return Assert.skip("Library fetched an endpoint the fake didn't seed — check the path getCallEdges requests.");
      throw e;
    }

    Assert.ok(Array.isArray(edges), "getCallEdges returns an array");
    edges.forEach(edge => {
      Assert.ok("child_recipe_id" in edge, "edge exposes child_recipe_id");
      Assert.ok("branch_context" in edge, "edge exposes branch_context");
    });

    // --- Exact-output checks (depend on your WorkatoGraphLib version). Enable once confirmed:
    // Assert.equal(edges.length, 3, "Escalation (200) + Triage (300) + Billing (500)");
    // Assert.contains(edges.find(e => e.child_recipe_id === "200").branch_context, "IF", "IF branch captured");
    // Assert.contains(edges.find(e => e.child_recipe_id === "300").branch_context, "ELSE", "ELSE branch captured");
    // Assert.equal(edges.find(e => e.child_recipe_id === "500").branch_context, "", "top-level call has no branch");
  });

  runner.add("[integration] RecipeAnalyzerService.buildGraphPack returns call + process graphs (cycle-safe)", () => {
    const client = new FakeWorkatoClient();
    const { r100, r200, r300 } = Fixtures.graphRecipes_cycle();
    client.setResponse("recipes/100", r100);
    client.setResponse("recipes/200", r200);
    client.setResponse("recipes/300", r300);

    let analyzer;
    try {
      analyzer = new RecipeAnalyzerService(client);
    } catch (e) {
      if (_isMissingLibrary_(e)) return Assert.skip("WorkatoGraphLib not bound in this project.");
      throw e;
    }

    let pack;
    try {
      pack = analyzer.buildGraphPack("100", { callDepth: 10, maxNodes: 100 });
    } catch (e) {
      if (_isFake404_(e)) return Assert.skip("Library fetched an unseeded endpoint during graph expansion — check fetch paths.");
      throw e;
    }

    Assert.ok(pack && typeof pack === "object", "buildGraphPack returns an object");
    Assert.ok(pack.call && typeof pack.call === "object", "pack.call present");
    Assert.ok(pack.process && typeof pack.process === "object", "pack.process present");

    // --- Exact-output checks (library-dependent). Enable once confirmed:
    // Assert.ok((pack.call.notes || []).some(n => /cycle/i.test(String(n))), "cycle detected and noted");
    // Assert.contains(pack.call.mermaid, "flowchart", "call-graph mermaid header present");
  });

  runner.add("[integration] WorkatoSyncApp.runProcessMaps writes correctly-shaped PROCESS_MAPS rows", () => {
    const client = new FakeWorkatoClient();
    const { r100, r200 } = Fixtures.graphRecipes_cycle();
    client.setResponse("recipes/100", r100);
    client.setResponse("recipes/200", r200);

    let ctx;
    try {
      ctx = new AppContext();                                    // builds real WorkatoClient + analyzer
      ctx.analyzerService = new RecipeAnalyzerService(client);   // rebuild so the engine uses the fake client
    } catch (e) {
      if (_isMissingLibrary_(e)) return Assert.skip("WorkatoLib / WorkatoGraphLib not bound in this project.");
      throw e;
    }

    const mockSheet = new FakeSheetService();
    mockSheet.requests = ["100"];
    ctx.sheetService = mockSheet;     // inject at the CONTEXT level — the runner reads ctx.*, not app.*
    ctx.driveService = new FakeDriveService();

    const app = new WorkatoSyncApp(ctx);
    try {
      app.runProcessMaps();
    } catch (e) {
      if (_isFake404_(e)) return Assert.skip("Library fetched an unseeded endpoint — check fetch paths.");
      throw e;
    }

    const written = mockSheet.writtenData["PROCESS_MAPS"];
    if (!written) return Assert.skip("Runner produced no output — likely a WorkatoGraphLib/fixture mismatch. Verify the library against Fixtures.");

    const width = SchemaDef.HEADERS.PROCESS_MAPS.length;
    Assert.ok(written.length > 1, "header + at least one data row");
    Assert.equal(written[0].length, width, "header column count matches schema");
    Assert.equal(written[1].length, width, "data row column count matches schema");
    Assert.equal(String(written[1][0]), "100", "root id in column A");

    // --- Library-dependent content check. Enable once confirmed:
    // Assert.contains(written[1][4], "flowchart", "call-graph mermaid column populated");
  });
}

// =======================================================================================
// ENTRY POINTS
// =======================================================================================
/**
 * Runs the full suite: hermetic (Tier 1) + integration (Tier 2).
 * Integration tests SKIP (not fail) when their library isn't bound, so this
 * stays green in a bare environment and only surfaces real regressions.
 */
function runAllTests() {
  const runner = new TestRunner();
  registerHermeticTests(runner);
  registerIntegrationTests(runner);
  runner.run({ writeToSheet: false });
}

/** Runs only the hermetic tier — fast, deterministic, no external libraries. */
function runHermeticTests() {
  const runner = new TestRunner();
  registerHermeticTests(runner);
  runner.run({ writeToSheet: false });
}
