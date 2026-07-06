Phase 3, then. One sequencing rule before the files: **toolkit pushes first, app second.** With HEAD binding, the app sees library changes instantly — so the new `Toolkit.*` symbols must exist before any app edit references them. Toolkit directory: five new files. App directory: four files touched (`02`, `04`, `22`, `50`) — and a correction to my earlier preview: `51_Tests_Unit.js` needs **zero** edits, since `SimpleTestRunner` is self-contained and never touches `Assert`/`TestRunner`. Smaller diff than advertised.

And one genuine gotcha I found while preparing this, in the same family as the properties discovery: **advanced services are per-project, like `PropertiesService`.** The global `Drive` symbol exists only in projects whose *own* manifest enables the advanced service. `saveMarkdownAsDoc` is moving to the toolkit, so its `typeof Drive === "undefined"` check now asks the question in the *toolkit's* scope — and the answer today is "undefined," meaning every companion/system doc would silently degrade to the `.md` fallback. Graceful, but a behavior change, which is exactly what we promised not to have. Fix: enable Drive API v3 in the **toolkit's** manifest:

```json
"dependencies": {
  "enabledAdvancedServices": [
    { "userSymbol": "Drive", "version": "v3", "serviceId": "drive" }
  ]
}
```

(OAuth scopes need nothing: a library's scope requirements merge into the consumer's authorization, and the app already holds Drive scope via `DriveApp`.)

---

## Toolkit side

### `02_Log.js`

```javascript
/**
 * @file 02_Log.js — console + spreadsheet-toast logging.
 * `verbose` is a boolean frozen at construction (see toolkit README:
 * widening to boolean|function later is additive/non-breaking).
 */
class Log_ {
  constructor(opts = {}) { this.verbose_ = Boolean(opts.verbose); }

  verbose(msg) {
    if (this.verbose_) console.log(`[VERBOSE] ${msg}`);
  }

  notify(msg, isError = false) {
    if (isError) console.error(msg);
    else console.log(msg);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) ss.toast(msg, isError ? "Error" : "Success", 5);
    } catch (e) { /* headless run — toast skipped */ }
  }
}

/** @param {{verbose?: boolean}} [opts] */
function newLog(opts) { return new Log_(opts || {}); }
```

### `03_Sheets.js`

The `write` quirks — left-align, bold/middle header, frozen row, and the auto-resize-only-when-`1 < cols < 5` rule — transfer untouched, as documented behavior. Only the two tendrils are inverted: sheet *name* instead of key, `headerBackground` instead of the CONSTANTS read. The one verbose line the original emitted is preserved via an optional injected logger (anything with a `.verbose(msg)` — duck typing, so the app can pass `AppLog` itself).

```javascript
/**
 * @file 03_Sheets.js — generic Sheets I/O core.
 */
class Sheets_ {
  /** @param {{spreadsheet?: Spreadsheet, log?: {verbose: function}}} [opts] */
  constructor(opts = {}) {
    this.ss_ = opts.spreadsheet || null;   // resolved lazily → active spreadsheet
    this.log_ = opts.log || null;
  }

  getSpreadsheet() {
    return this.ss_ || SpreadsheetApp.getActiveSpreadsheet();
  }

  getOrCreateByName(sheetName) {
    const ss = this.getSpreadsheet();
    return ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  }

  /**
   * Clear-and-write a 2D array with header formatting.
   * @param {string} sheetName
   * @param {Array<Array<*>>} rows
   * @param {{headerBackground?: string}} [opts]
   */
  write(sheetName, rows, opts = {}) {
    const headerBg = opts.headerBackground || "#d9d9d9";
    if (this.log_) this.log_.verbose(`Writing ${rows.length} rows to ${sheetName}...`);

    const sheet = this.getOrCreateByName(sheetName);
    sheet.clear();

    if (rows.length > 0) {
      const numRows = rows.length;
      const numCols = rows[0].length;

      sheet.getRange(1, 1, numRows, numCols)
           .setValues(rows).setHorizontalAlignment("left");

      sheet.getRange(1, 1, 1, numCols)
           .setFontWeight("bold")
           .setBackground(headerBg)
           .setVerticalAlignment("middle");
      sheet.setFrozenRows(1);

      if (numCols > 1 && numCols < 5) {
        try { sheet.autoResizeColumns(1, numCols); } catch (e) {}
      }
    }
  }
}

/** @param {{spreadsheet?: Spreadsheet, log?: {verbose: function}}} [opts] */
function newSheets(opts) { return new Sheets_(opts || {}); }
```

### `04_Drive.js`

`saveJson` is `saveText` with a stringify — implementing it as exactly that delegation makes the equivalence structural rather than asserted, and byte-for-byte identical output to the old `saveLog`'s generic half. The `store` parameter is duck-typed to `{get, setUser}`, which means the app can pass its `ConfigStore` shim directly — the cached-id → search-by-name → create → recache dance is preserved verbatim, including the deliberate asymmetry that the cache *write* goes to user props.

```javascript
/**
 * @file 04_Drive.js — Drive save primitives (text / JSON / markdown-as-Doc).
 *
 * saveMarkdownAsDoc needs the Drive advanced service (v3) enabled in THIS
 * project's manifest — advanced services are per-project, so the consumer's
 * enablement doesn't reach us. Without it, degrades gracefully to a .md file.
 */
class Drive_ {
  /**
   * @param {{enabled?: boolean, folderName: string,
   *          store?: {get: function, setUser: function}, cacheKey?: string}} opts
   *   store+cacheKey enable cached folder-id resolution; omit both to
   *   resolve by name on every call.
   */
  constructor(opts = {}) {
    if (!opts.folderName) throw new Error("newDrive requires a folderName.");
    this.enabled_ = (opts.enabled !== undefined) ? Boolean(opts.enabled) : true;
    this.folderName_ = String(opts.folderName);
    this.store_ = opts.store || null;
    this.cacheKey_ = opts.cacheKey || null;
  }

  saveText(id, name, ext, content) {
    if (!this.enabled_) return null;
    try {
      const folder = this.getFolder();
      const file = folder.createFile(
        this._fileName_(id, name) + "." + (ext || "txt"),
        String(content || ""), MimeType.PLAIN_TEXT
      );
      return file.getUrl();
    } catch (e) {
      console.error(`Drive saveText error: ${e.message}`);
      return null;
    }
  }

  saveJson(id, name, obj) {
    return this.saveText(id, name, "json", JSON.stringify(obj, null, 2));
  }

  saveMarkdownAsDoc(id, name, markdownText) {
    if (!this.enabled_) return null;

    if (typeof Drive === "undefined") {
      console.warn("Toolkit Drive: advanced Drive service not enabled; saving .md text instead of a Google Doc.");
      return this.saveText(id, name, "md", markdownText);
    }

    try {
      const folder = this.getFolder();
      const docName = this._fileName_(id, name);
      const blob = Utilities.newBlob(String(markdownText || ""), "text/markdown", docName);
      const created = Drive.Files.create(
        { name: docName, mimeType: MimeType.GOOGLE_DOCS, parents: [folder.getId()] },
        blob,
        { supportsAllDrives: true }
      );
      return DriveApp.getFileById(created.id).getUrl();
    } catch (e) {
      console.error(`Drive saveMarkdownAsDoc error: ${e.message}`);
      return null;
    }
  }

  /** Cached-id → search-by-name → create → recache. Creates if absent. */
  getFolder() {
    if (this.store_ && this.cacheKey_) {
      const cachedId = this.store_.get(this.cacheKey_, { preferUser: true, defaultValue: "" });
      if (cachedId) {
        try { return DriveApp.getFolderById(cachedId); }
        catch (e) { console.warn("Cached folder ID invalid. Rediscovering..."); }
      }
    }
    const it = DriveApp.getFoldersByName(this.folderName_);
    const folder = it.hasNext() ? it.next() : DriveApp.createFolder(this.folderName_);
    if (this.store_ && this.cacheKey_) this.store_.setUser(this.cacheKey_, folder.getId());
    return folder;
  }

  /** @private timestamped, sanitized base name — shared by every save path. */
  _fileName_(id, name) {
    const safeName = (name || "Unknown").replace(/[^a-zA-Z0-9-_]/g, "_");
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm-ss");
    return `${timestamp}_ID-${id}_${safeName}`;
  }
}

function newDrive(opts) { return new Drive_(opts); }
```

### `05_Selection.js`

Verbatim lift, renamed, generic default. The two private helpers keep their underscore-suffix names inside the private class.

```javascript
/**
 * @file 05_Selection.js — extract IDs from the active selection.
 */
class Selection_ {
  static getSelectedIds(opts = {}) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getActiveSheet();
    const range = sheet.getActiveRange();
    if (!range) return [];

    const headerCandidates = (opts.headerCandidates && opts.headerCandidates.length)
      ? opts.headerCandidates
      : ["ID"];

    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return [];

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v || "").trim());
    const idCol = this._findHeaderColumn_(headers, headerCandidates);

    if (idCol > 0) {
      const selStartRow = range.getRow();
      const selEndRow = selStartRow + range.getNumRows() - 1;
      const startRow = Math.max(2, selStartRow);
      const endRow = Math.max(startRow, selEndRow);
      const numRows = Math.max(0, endRow - startRow + 1);
      if (numRows <= 0) return [];
      const values = sheet.getRange(startRow, idCol, numRows, 1).getValues().flat();
      return this._normalizeIds_(values);
    }

    return this._normalizeIds_(range.getValues().flat());
  }

  static _findHeaderColumn_(headers, candidates) {
    const norm = (s) => String(s || "").trim().toLowerCase();
    const candSet = new Set(candidates.map(norm));
    for (let i = 0; i < headers.length; i++) {
      if (candSet.has(norm(headers[i]))) return i + 1;
    }
    return 0;
  }

  static _normalizeIds_(values) {
    const out = [];
    const seen = new Set();
    values.forEach(v => {
      if (v === null || v === undefined || v === "") return;
      const s = String(v).trim();
      const isNumeric = (typeof v === "number") || /^[0-9]+$/.test(s);
      if (!isNumeric) return;
      const id = String(parseInt(s, 10));
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return out;
  }
}

/** @param {{headerCandidates?: string[]}} [opts] */
function getSelectedIds(opts) { return Selection_.getSelectedIds(opts || {}); }
```

### `06_TestKit.js`

`Assert_` and `TestRunner_` transfer verbatim (including the `__skip` sentinel protocol, which probe Q7 cleared). One design note: `asserts()` returns the class *as a value* — Q2's unreliability is about accessing bare class symbols on the library namespace, not about a class riding through a function return, which is just an object crossing per Q1. This keeps every `Assert.equal(...)` call site in the app's test file byte-identical after a one-line rebind. `run()` gains `sheetName` as an option, defaulting to the current `"test_results"`.

```javascript
/**
 * @file 06_TestKit.js — Assert + TestRunner.
 */
class Assert_ {
  static _fmt(v) {
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }
  static ok(value, msg) {
    if (!value) throw new Error(msg || `Expected truthy but got: ${Assert_._fmt(value)}`);
  }
  static equal(actual, expected, msg) {
    if (actual !== expected) throw new Error(msg || `Expected ${Assert_._fmt(expected)} but got ${Assert_._fmt(actual)}`);
  }
  static notEqual(actual, expected, msg) {
    if (actual === expected) throw new Error(msg || `Expected value to differ, but both were ${Assert_._fmt(actual)}`);
  }
  static contains(haystack, needle, msg) {
    const h = String(haystack ?? ""), n = String(needle ?? "");
    if (!h.includes(n)) throw new Error(msg || `Expected string to contain "${n}", got:\n${h}`);
  }
  static deepEqual(actual, expected, msg) {
    const a = Assert_._fmt(actual), e = Assert_._fmt(expected);
    if (a !== e) throw new Error(msg || `Expected deepEqual.\nExpected:\n${e}\nActual:\n${a}`);
  }
  static throws(fn, msgContains) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; if (msgContains) Assert_.contains(e.message, msgContains); }
    if (!threw) throw new Error("Expected function to throw, but it did not.");
  }
  static skip(msg) { throw { __skip: true, message: msg || "skipped" }; }
}

class TestRunner_ {
  constructor() { this.tests = []; }

  add(name, fn) { this.tests.push({ name, fn }); return this; }

  run(options = {}) {
    const writeToSheet = Boolean(options.writeToSheet);
    const sheetName = options.sheetName || "test_results";
    const results = [];
    const startedAt = new Date();

    console.log(`STARTING TEST RUN: ${this.tests.length} tests queued.`);

    for (const t of this.tests) {
      const t0 = Date.now();
      try {
        t.fn();
        results.push({ name: t.name, status: "PASS", ms: Date.now() - t0, error: "" });
      } catch (e) {
        if (e && e.__skip) results.push({ name: t.name, status: "SKIP", ms: Date.now() - t0, error: e.message || "skipped" });
        else results.push({ name: t.name, status: "FAIL", ms: Date.now() - t0, error: (e && e.stack) ? e.stack : String(e) });
      }
    }

    const pass = results.filter(r => r.status === "PASS").length;
    const fail = results.filter(r => r.status === "FAIL").length;
    const skip = results.filter(r => r.status === "SKIP").length;
    console.log(`TESTS COMPLETE: ${pass} passed, ${fail} failed, ${skip} skipped in ${Date.now() - startedAt.getTime()}ms`);

    results.forEach(r => {
      const prefix = r.status === "PASS" ? "[PASS]" : (r.status === "SKIP" ? "[SKIP]" : "[FAIL]");
      console.log(`${prefix} ${r.name} (${r.ms}ms)`);
      if (r.status === "FAIL") console.error(r.error);
      else if (r.status === "SKIP") console.log(`       reason: ${r.error}`);
    });

    if (writeToSheet) this._writeResults_(results, sheetName);
    if (fail > 0) throw new Error(`Test suite failed: ${fail} failing tests.`);
    return results;
  }

  _writeResults_(results, sheetName) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return;
      let sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      sheet.clear();
      sheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "Test", "Status", "Duration (ms)", "Error"]])
        .setFontWeight("bold").setBackground("#efefef");
      const ts = new Date().toISOString();
      const rows = results.map(r => [ts, r.name, r.status, r.ms, r.error]);
      if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
      sheet.setFrozenRows(1);
    } catch (e) {
      console.log("Could not write test results sheet: " + e.message);
    }
  }
}

function asserts() { return Assert_; }
function newTestRunner() { return new TestRunner_(); }
```

### `90_SelfTests.js`

The toolkit testing itself with its own kit — the reuse payoff made literal, and the new home of the `_normalizeIds_` test that can't stay in the app (its target is now library-private):

```javascript
/**
 * @file 90_SelfTests.js — the toolkit's own hermetic suite, run from the
 * toolkit editor. Doubles as a living demo of the test kit.
 */
function runToolkitSelfTests() {
  const runner = newTestRunner();
  const A = asserts();

  runner.add("[toolkit] Selection._normalizeIds_ keeps numeric ids, dedupes, drops noise", () => {
    const ids = Selection_._normalizeIds_(["100", 200, "abc", "", null, "100", "300x", 300]);
    A.deepEqual(ids, ["100", "200", "300"]);
  });

  runner.add("[toolkit] ConfigStore precedence: user over script, clean empties, defaults", () => {
    const fake = (obj) => ({
      getProperty: (k) => (k in obj ? obj[k] : null),
      setProperty: (k, v) => { obj[k] = v; },
      deleteProperty: (k) => { delete obj[k]; }
    });
    const u = {}, s = {};
    const store = newConfigStore({ user: fake(u), script: fake(s) });

    A.equal(store.get("K", { defaultValue: "def" }), "def", "absent -> default");
    s["K"] = "fromScript";
    A.equal(store.get("K"), "fromScript", "script fills when user absent");
    u["K"] = "fromUser";
    A.equal(store.get("K"), "fromUser", "user wins by default");
    A.equal(store.get("K", { preferUser: false }), "fromScript", "preferUser:false flips precedence");
    u["K"] = "   ";
    A.equal(store.get("K"), "fromScript", "whitespace-only user value treated as absent");
  });

  runner.add("[toolkit] Drive filename is timestamped and sanitized", () => {
    const d = new Drive_({ folderName: "x" });
    const name = d._fileName_("42", "My/Bad:Name!");
    A.contains(name, "_ID-42_My_Bad_Name_", "unsafe chars replaced");
    A.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/.test(name), "leads with timestamp");
  });

  runner.run({ writeToSheet: false });
}
```

Note what the ConfigStore test demonstrates in passing: injection made the store testable with fakes — no `PropertiesService` mocking, no live state. The inversion that Q3 forced on us for correctness turns out to buy hermetic testability for free. That's usually the sign a seam was cut in the right place.

---

## App side

### `02_CoreLogging.js` — `AppLog` becomes a seam

```javascript
/**
 * @file 02_Core_Logging.gs
 * @desc Seam over Toolkit.newLog. Still named AppLog (not Logger) so the
 *   built-in Logger stays reachable. VERBOSE is read from AppConfig once per
 *   execution at first use — indistinguishable from a live read while
 *   VERBOSE is a hardcoded constant, since each execution is a fresh scope.
 */
class AppLog {
  /** @private */
  static _log_() {
    if (!this.__log) this.__log = Toolkit.newLog({ verbose: AppConfig.get().VERBOSE });
    return this.__log;
  }
  static verbose(msg) { this._log_().verbose(msg); }
  static notify(msg, isError = false) { this._log_().notify(msg, isError); }
}
```

### `04_GoogleIO.js` — the domain-aware halves stay, the engines delegate

`readRequests` and `appendDebugRows` transfer **verbatim** — they're pasted below unchanged only so the file is complete for review; don't diff-read them. The interesting parts are the constructor (where `newSheets` gets `AppLog` as its logger — duck typing again, the static class satisfies `{verbose}`) and `write` (where key→name resolution and the CONSTANTS read now live, i.e., the tendril's stump stays app-side where it belongs). `DriveService.saveLog` keeps its early `LOG_TO_DRIVE` return so the code-massage doesn't even run when saving is disabled — matching the original's exact short-circuit order.

```javascript
/** @file 04_Google_IO.gs */
class SheetService {
  constructor() {
    this.config = AppConfig.get();
    this.core = Toolkit.newSheets({ log: AppLog });
  }

  /** Key-based write: resolve name + header style from config, delegate. */
  write(sheetKey, rows) {
    const sheetName = this.config.SHEETS[sheetKey];
    if (!sheetName) throw new Error(`Sheet key ${sheetKey} not found in config.`);
    this.core.write(sheetName, rows, {
      headerBackground: this.config.CONSTANTS.STYLE_HEADER_BG
    });
  }

  getSpreadsheet() { return this.core.getSpreadsheet(); }
  getOrCreateByName(sheetName) { return this.core.getOrCreateByName(sheetName); }

  getOrCreate(sheetKey) {
    const sheetName = this.config.SHEETS[sheetKey];
    if (!sheetName) throw new Error(`Sheet key ${sheetKey} not found in config.`);
    return this.core.getOrCreateByName(sheetName);
  }

  // --- Domain-aware methods: KEPT IN APP, verbatim from the original ------
  readRequests() {
    /* ... identical to current source ... */
  }
  appendDebugRows(rows) {
    /* ... identical to current source ... */
  }
}

class DriveService {
  constructor() {
    this.config = AppConfig.get().DEBUG;
    this.core = Toolkit.newDrive({
      enabled: this.config.LOG_TO_DRIVE,
      folderName: this.config.DRIVE_FOLDER_NAME,
      store: ConfigStore,            // duck-typed: static {get, setUser} qualifies
      cacheKey: "DEBUG_FOLDER_ID"
    });
  }

  /**
   * Domain wrapper: Workato recipe exports carry a stringified `code` field;
   * parse it for readable Drive files, then delegate to the generic saveJson.
   */
  saveLog(id, name, jsonObject) {
    if (!this.config.LOG_TO_DRIVE) return null;   // preserve original short-circuit

    let payloadToSave = { ...jsonObject };
    if (payloadToSave.code && typeof payloadToSave.code === "string") {
      try {
        payloadToSave.code = JSON.parse(payloadToSave.code);
      } catch (parseError) {
        console.warn(`DriveService: Could not parse 'code' string for recipe, ${id}. Saved as raw string.`);
      }
    }
    return this.core.saveJson(id, name, payloadToSave);
  }

  saveText(id, name, ext, content) { return this.core.saveText(id, name, ext, content); }
  saveMarkdownAsDoc(id, name, markdownText) { return this.core.saveMarkdownAsDoc(id, name, markdownText); }
}
```

### `22_UISelection.js` — the domain default's new home

```javascript
/** @file 22_UI_Selection.gs — seam over Toolkit.getSelectedIds. */
class SelectionUtils {
  /** The recipe-flavored header candidates live HERE, not in the toolkit. */
  static getSelectedRecipeIds(opts = {}) {
    const headerCandidates = (opts.headerCandidates && opts.headerCandidates.length)
      ? opts.headerCandidates
      : ["ID", "Recipe ID", "Root recipe ID", "Parent recipe ID", "Child recipe ID"];
    return Toolkit.getSelectedIds({ headerCandidates });
  }
}
```

All fourteen entry-point call sites in `99` are untouched — the seam's name and signature are identical.

### `50_Tests_Integration.js` — four edits

1. **Delete** the `Assert` and `TestRunner` class definitions (the whole ASSERTIONS and RUNNER sections).
2. **Delete** the `[hermetic] SelectionUtils._normalizeIds_...` test — its target is now library-private; it lives on in `90_SelfTests.js`.
3. First line inside **both** register functions (inside the function bodies, not file top-level — preserving the no-load-time-execution invariant):
   ```javascript
   function registerHermeticTests(runner) {
     const Assert = Toolkit.asserts();
     // ...unchanged tests
   ```
   The test closures capture the binding; every `Assert.equal(...)` line is byte-identical.
4. Entry points swap the constructor for the factory:
   ```javascript
   function runAllTests() {
     const runner = Toolkit.newTestRunner();
     registerHermeticTests(runner);
     registerIntegrationTests(runner);
     runner.run({ writeToSheet: false });
   }
   function runHermeticTests() {
     const runner = Toolkit.newTestRunner();
     registerHermeticTests(runner);
     runner.run({ writeToSheet: false });
   }
   ```

`Fixtures`, the fakes, `withTestConfig`, and the two skip-classifier helpers stay verbatim — they're domain code, per the handoff table.

---

## Untouched, for the record

Runners, `DataMapper`, `GeminiService`, `DashboardService`, `MaintenanceService`, `DiagramService`, `UiMode`, `UserInterfaceService`, `40_Diagnostics`, `51_Tests_Unit`, `99_EntryPoints` (post commit-0), and all of `00`/`01`/`05`. `DashboardService` and `MaintenanceService` call `ConfigStore` and `SheetService` through surfaces the seams preserve exactly.

## Phase 4 checklist, in dependency order

1. **Toolkit self-tests** — `runToolkitSelfTests` from the toolkit editor. Green before touching the app.
2. **App hermetic** — `runUnitTests` (untouched code, pure control) and `runHermeticTests` (proves the rebind + runner factory).
3. **`runAllTests`** — integration tier exercises `RecipeAnalyzerService` and the ProcessMaps runner through the seams.
4. **Live inventory sync** — the widest path: `write` through the seam for eight-plus sheets, dashboard rebuild on top.
5. **Logic debug on 1–2 recipes** — exercises `saveJson` via the `saveLog` wrapper (open the Drive file and confirm `code` is a parsed object, not a string — that's the massage surviving the move) plus `appendDebugRows`.
6. **Companion doc from selection** — `saveMarkdownAsDoc` end-to-end; confirm the output is a **Google Doc**, not a `.md` file. This is the specific check for the advanced-service gotcha.
7. **View diagram on a map row** — untouched code reading sheets the moved code wrote.

If all seven hold, that's the definition of done met, and Phase 5 is ceremony: delete the probe remnants, write the toolkit README (public API + the Q2 observation + the two per-project scoping facts — properties and advanced services), publish toolkit v1, flip the app's binding from HEAD to the pinned version, push the manifest change. Suggested commits: toolkit — `feat: toolkit v1 — log, sheets, drive, selection, test kit`; app — `refactor: sheet/drive/log/selection/test-kit delegate to Toolkit (behavior-preserving seams)`.

Report back with the Phase 4 results — including any step that *doesn't* behave — and we'll close it out.
