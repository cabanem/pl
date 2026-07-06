Proceeding. Two deliverables below: the pre-flight bugfix (commit 0), then Phase 1's probe pair, ready to paste. Before the probe code, one piece of mechanism worth having in your head, because it's the *why* behind the whole probe design and it'll serve you in every future library decision:

**Apps Script services split into two families.** *Script-identity* services answer the question "which script project is this code?" — `PropertiesService`, `CacheService`, `LockService`, `ScriptApp.getScriptId()`. For library code, the answer is *the library*, no matter who called it. *Execution-context* services answer "who is running, on what document?" — `SpreadsheetApp.getActiveSpreadsheet()`, `DriveApp`, `Session` — and the answer is the same for library and consumer, because they share one execution. This single distinction is why `ConfigStore` needs injected handles while `SheetService` and `DriveService` can keep calling `SpreadsheetApp`/`DriveApp` directly after the lift. It's also a standing guardrail: if the toolkit ever grows caching or locking, those are script-identity services and get the same injection treatment. The probe exists to confirm this taxonomy empirically rather than trust my recollection of it.

## Commit 0 — repoint the orphaned `Logger.notify` calls

Seven identical one-word edits in `99_EntryPoints.js`. The pattern, shown once:

```javascript
// before
Logger.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
// after
AppLog.notify("Select rows (or ID cells) in a sheet with recipe IDs first.", true);
```

The seven sites, all in the no-selection guard: `fetchRecipeLogicSelected`, `fetchRecipeAnalysisSelected`, `generateProcessMapsSelected`, `generateProcessMapsSelectedCalls`, `generateProcessMapsSelectedFull`, `generateCompanionDocSelected`, `generateSystemDocSelected`.

Verification (thirty seconds): open the spreadsheet, click an empty cell below the data in `View_Recipes`, run "Recipe step breakdown → sheet" from the menu. You should see a red "Error" toast with the select-rows message — the *intended* behavior, restored — instead of a `TypeError: Logger.notify is not a function` dialog. Suggested commit message: `fix: repoint 7 orphaned Logger.notify calls to AppLog (99_EntryPoints)`.

## Phase 1 — the boundary probe

### Library side

Create the toolkit project now — this is the *permanent* project; only the probe file is throwaway. `script.new`, name it (e.g., `GasToolkit`), paste this as its only file. If you want it in version control from day one, `clasp clone <scriptId>` into a fresh directory; you'll delete `00_Probe.js` at the end of this phase.

```javascript
/**
 * @file 00_Probe.js  — DELETE after Phase 1.
 * Boundary probe: each function answers exactly one question the toolkit
 * API design depends on. The consumer-side runner interprets the answers.
 */

// Q1: do factory-returned objects cross the boundary with callable methods?
class ProbeThing_ {
  constructor(tag) { this.tag = tag; }
  hello() { return 'hello from ' + this.tag; }
}
function newProbeThing(tag) { return new ProbeThing_(tag); }

// Q2 (observational): does a bare top-level class cross at all, and how far?
class ProbeBareClass {
  static ping() { return 'static ping'; }
  pong() { return 'instance pong'; }
}

// Q3: whose property stores does library code see when it asks directly?
function probeOwnProps() {
  return {
    script: PropertiesService.getScriptProperties().getProperty('PROBE_KEY'),
    user:   PropertiesService.getUserProperties().getProperty('PROBE_KEY')
  };
}

// Q4: do handles injected BY the consumer read the CONSUMER's stores?
function probeInjectedProps(userStore, scriptStore) {
  return {
    user:   userStore.getProperty('PROBE_KEY'),
    script: scriptStore.getProperty('PROBE_KEY')
  };
}

// Q5: does library code see the consumer's active spreadsheet?
function probeActiveSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss ? ss.getName() : null;
}

// Q6: do function values cross the boundary and execute intact?
function probeCallback(fn) { return fn() === true; }

// Q7: does a thrown sentinel object keep its shape across boundary frames?
function probeSkipSentinel() { throw { __skip: true, message: 'skip probe' }; }
```

### Consumer side

Make (or reuse) a throwaway Google Sheet — it must be a sheet-bound script, because Q5 needs an active spreadsheet to see. Don't discard it after the probe: a consumer that *isn't* the app is exactly what you want in Phase 3 for sanity-checking the API from a clean context.

```javascript
/**
 * Scratch consumer for the Phase 1 boundary probe.
 * Bind the toolkit as "Toolkit" (HEAD / development mode), run this,
 * read the execution log.
 */
function runBoundaryProbe() {
  const results = [];
  const check = (name, ok) => results.push({ name, ok });

  // Q1 — the factory idiom
  check('Q1 factory object crosses; methods callable',
        Toolkit.newProbeThing('lib').hello() === 'hello from lib');

  // Q2 — bare class: OBSERVED, not pass/fail (see interpretation notes)
  const bare = typeof Toolkit.ProbeBareClass;
  let bareStatic = 'n/a', bareNew = 'n/a';
  if (bare !== 'undefined') {
    try { bareStatic = Toolkit.ProbeBareClass.ping(); }        catch (e) { bareStatic = 'threw: ' + e.message; }
    try { bareNew = new Toolkit.ProbeBareClass().pong(); }     catch (e) { bareNew = 'threw: ' + e.message; }
  }
  console.log(`Q2 OBSERVE bare class — typeof: ${bare}, static call: ${bareStatic}, new+method: ${bareNew}`);

  // Q3/Q4 — property scoping: plant a marker in the CONSUMER's stores
  PropertiesService.getScriptProperties().setProperty('PROBE_KEY', 'consumer');
  PropertiesService.getUserProperties().setProperty('PROBE_KEY', 'consumer');

  const own = Toolkit.probeOwnProps();
  check('Q3 lib direct read does NOT see consumer script props', own.script !== 'consumer');
  check('Q3 lib direct read does NOT see consumer user props',   own.user   !== 'consumer');

  const inj = Toolkit.probeInjectedProps(
    PropertiesService.getUserProperties(),
    PropertiesService.getScriptProperties()
  );
  check('Q4 injected handles DO see consumer props',
        inj.user === 'consumer' && inj.script === 'consumer');

  // Q5 — execution-context services
  check('Q5 lib sees consumer active spreadsheet',
        Toolkit.probeActiveSpreadsheet() !== null);

  // Q6 — callbacks across the boundary
  check('Q6 function args cross intact',
        Toolkit.probeCallback(() => true) === true);

  // Q7 — sentinel throw
  let sentinelOk = false;
  try { Toolkit.probeSkipSentinel(); }
  catch (e) { sentinelOk = !!(e && e.__skip === true && e.message === 'skip probe'); }
  check('Q7 thrown sentinel keeps shape', sentinelOk);

  // Cleanup + report
  PropertiesService.getScriptProperties().deleteProperty('PROBE_KEY');
  PropertiesService.getUserProperties().deleteProperty('PROBE_KEY');

  results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`));
  const fails = results.filter(r => !r.ok).length;
  console.log(fails === 0 ? 'BOUNDARY PROBE GREEN' : `BOUNDARY PROBE: ${fails} unexpected result(s)`);
}
```

### Setup

1. In the toolkit project: Project Settings (gear icon) → copy the **Script ID**.
2. In the scratch sheet's script: Libraries **+** → paste the ID → Look up → Version: **HEAD (Development mode)** → Identifier: **Toolkit** → Add.
3. Paste the runner, run `runBoundaryProbe`, authorize (properties + spreadsheet scopes, auto-detected), read the execution log.

Development mode is the important choice: HEAD binding means the consumer always executes the library's latest *saved* code, so throughout Phases 2–3 you edit the toolkit and re-run without publishing anything. Dev mode is only offered to editors of the library — you own it, so it's there. Version pinning happens once, at Phase 5, when the surface is proven.

### Reading the results

**Q1** should pass with near-certainty, and here's why it's in the probe anyway: your app is *already living proof* — `WorkatoLib.newClient`, `WorkatoGraphLib.newAnalyzer`, and `GeminiLib.newClient` cross this exact boundary every run. Q1 is a sanity anchor; if it fails, something is wrong with the binding, not the design.

**Q2** is deliberately observational rather than pass/fail, and this is a small epistemics point worth making explicit: we don't actually know which way it goes on the current V8 runtime, and folklore differs. Whatever it reports, the design doesn't change — the factory API stays, for consistency with your three existing libraries and because JSDoc-driven autocomplete follows functions cleanly. But now you'll *know* what your runtime does with bare classes, instead of believing something. Log it in the toolkit README as an observed fact with a date.

**Q3** failing — the library seeing consumer properties — would be *good news*, oddly: `newConfigStore` could drop injection and get simpler. I'd bet heavily against it. The expected result (both PASSes, meaning isolation) confirms Finding 1 and locks the injected-handles signature.

**Q4** is the load-bearing check. If injection somehow *doesn't* work, `ConfigStore` can't be lifted at all and stays app-side — the toolkit would ship without it. That contingency shrinks the library rather than breaking anything, which is the right failure mode to have.

**Q5** failing would mean `newSheets` needs a mandatory spreadsheet parameter and `notify`'s toast needs an injected spreadsheet too. Expected: pass, per the two-families taxonomy above.

**Q6** protects something subtler than it looks — not the `verbose` option (we chose boolean-only, so that's moot) but the **test kit's core mechanic**: `runner.add(name, fn)` passes *app-defined test functions* into library code, which invokes them. If callbacks didn't cross, the whole `TestRunner` extraction dies. They will cross — same V8 heap — but this is the assumption the test kit stands on, so it gets a check.

**Q7** validates the SKIP protocol end-to-end as it will actually run post-extraction: `Assert.skip` throws in a library frame, the throw propagates *through your app's test-function frames*, and `TestRunner.run` catches it back in a library frame, checking `e.__skip`. If the sentinel lost its shape, we'd switch to a marker created and checked by library functions on both ends — but a plain object in a shared heap won't lose properties.

Run it and paste me the log. On green (my expectation: 7 PASS + the Q2 observation), the API from my first message is locked as proposed, and I'll produce the Phase 2 diff — the `ConfigStore_` implementation for the toolkit and the exact shim replacing the class body in `01_Core_Config.js` — for your review before anything moves.
