Green across the board — the taxonomy holds, injection works, callbacks and the sentinel cross intact. Two small bookkeeping notes before the diff: whenever convenient, jot the Q2 observation (whatever `typeof Toolkit.ProbeBareClass` reported) into the toolkit's README with today's date — that's now an empirical fact about your runtime rather than folklore. And you can delete `00_Probe.js` from the toolkit; the scratch consumer sheet stays alive for Phase 3.

Here's Phase 2, complete. It's deliberately tiny — one new library file, one class body swapped in the app, one manifest edit — because `ConfigStore` is the leaf and the whole point of doing it first is that if anything goes wrong, the blast radius is one component with five methods.

## Toolkit side — `01_ConfigStore.js`

The precedence and clean/trim logic transfers verbatim; the only change is *where the stores come from* — constructor injection instead of `PropertiesService` calls, per Q3/Q4:

```javascript
/**
 * @file 01_ConfigStore.js
 * @description Layered property storage with user-overrides-script precedence.
 *
 *   Stores are INJECTED, never read from PropertiesService directly:
 *   PropertiesService is script-identity scoped, so a direct read here would
 *   hit the TOOLKIT's stores — shared across every consumer — not the
 *   consumer's. (Verified by boundary probe Q3/Q4.)
 */

class ConfigStore_ {
  /**
   * @param {{user: GoogleAppsScript.Properties.Properties,
   *          script: GoogleAppsScript.Properties.Properties}} stores
   */
  constructor(stores) {
    if (!stores || !stores.user || !stores.script) {
      throw new Error("newConfigStore requires { user, script } property store handles.");
    }
    this.user_ = stores.user;
    this.script_ = stores.script;
  }

  /**
   * Layered read. Empty/whitespace values are treated as absent.
   * @param {string} key
   * @param {{preferUser?: boolean, defaultValue?: *}} [opts]
   */
  get(key, opts = {}) {
    const preferUser = (opts.preferUser !== undefined) ? Boolean(opts.preferUser) : true;
    const def = (opts.defaultValue !== undefined) ? opts.defaultValue : null;

    const clean = (v) => {
      const s = (v === null || v === undefined) ? "" : String(v).trim();
      return s === "" ? null : s;
    };

    const u = clean(this.user_.getProperty(key));
    const s = clean(this.script_.getProperty(key));

    return preferUser ? (u ?? s ?? def) : (s ?? u ?? def);
  }

  setUser(key, value)   { this.user_.setProperty(key, String(value ?? "")); }
  setScript(key, value) { this.script_.setProperty(key, String(value ?? "")); }
  deleteUser(key)       { this.user_.deleteProperty(key); }
  deleteScript(key)     { this.script_.deleteProperty(key); }
}

/**
 * Create a layered config store over the CALLER's property stores.
 * @param {{user: Properties, script: Properties}} stores
 *   Pass PropertiesService.getUserProperties() / getScriptProperties()
 *   from YOUR project.
 * @returns {ConfigStore_}
 */
function newConfigStore(stores) {
  return new ConfigStore_(stores);
}
```

The trailing underscore on `ConfigStore_` does double duty: it's the library-private marker at the boundary, and it means the class name can't collide with the app's `ConfigStore` shim if anyone ever reads both files side by side.

## App side — replace the `ConfigStore` class body in `01_Core_Config.js`

`SchemaDef` and `AppConfig` in that file are untouched. Only the `ConfigStore` class at the bottom changes:

```javascript
/**
 * @class
 * @classdesc Configuration store — thin seam over Toolkit.newConfigStore.
 *   The app passes its OWN property stores in (library code can't see them
 *   otherwise); the toolkit owns the precedence/clean logic. Lazily built so
 *   no code executes at load time.
 */
class ConfigStore {
  /** @private Lazy singleton, same idiom as Commands._registry_(). */
  static _store_() {
    if (!this.__store) {
      this.__store = Toolkit.newConfigStore({
        user: PropertiesService.getUserProperties(),
        script: PropertiesService.getScriptProperties()
      });
    }
    return this.__store;
  }

  static get(key, opts = {})    { return this._store_().get(key, opts); }
  static setUser(key, value)    { return this._store_().setUser(key, value); }
  static setScript(key, value)  { return this._store_().setScript(key, value); }
  static deleteUser(key)        { return this._store_().deleteUser(key); }
  static deleteScript(key)      { return this._store_().deleteScript(key); }
}
```

Every existing call site — `AppConfig.get()`, `UiMode`, `DriveService._getVerifiedFolder`, `DashboardService.postInventorySync`, `MaintenanceService._debugFolder_` — keeps working unchanged, because the five-method static surface is identical.

Two deliberate details worth a beat each, since they're the kind of thing you like to see the reasoning for:

**The old `userProps()` / `scriptProps()` statics are gone.** I grepped every file: they were called only from inside `ConfigStore.get/set/delete` themselves — `UserInterfaceService`, `dumpAllConfig`, `debugPropertyReport`, and the migration function all reach `PropertiesService` directly, not through `ConfigStore`. So dropping them removes zero external surface. If you want belt-and-suspenders, two one-line passthroughs restore them; I'd leave them out — dead surface is where the next tendril grows.

**No caching, on purpose.** `AppConfig.get()` calls `ConfigStore.get` on every invocation, which means every call is a live `PropertiesService` read — that was true before and stays true now. Caching the values would be faster but would change semantics (a token updated mid-run via the Configuration menu would go stale), and Phase 2 changes nothing but the seam. The library-boundary crossing itself adds effectively nothing; the milliseconds were always in the property reads.

## Binding the toolkit into the app — and the clasp gotcha

Bind exactly as you did for the scratch consumer: app project → Libraries **+** → toolkit's script ID → **HEAD (Development mode)** → identifier **Toolkit**.

Now the gotcha, and it's the one real hazard in this phase: **binding a library is a manifest edit.** The dependency lands in the app's `appsscript.json`:

```json
"dependencies": {
  "libraries": [{
    "userSymbol": "Toolkit",
    "libraryId": "YOUR_TOOLKIT_SCRIPT_ID",
    "developmentMode": true
  }]
}
```

Since you manage this project with clasp, your *local* manifest doesn't know about the binding you just made in the editor — and `clasp push` pushes the whole local state, manifest included. Push with a stale local manifest and the binding is silently removed; the next run dies with `Toolkit is not defined`. So the sequence is: bind in the editor → `clasp pull` (or hand-add the block above to your local `appsscript.json`) → *then* make the code edit locally and push. Alternatively, do it all locally: add the manifest block by hand, edit the class, one push. Either works; just don't let the editor and your working copy disagree about the manifest.

(Same applies to the merged `oauthScopes` if your manifest pins scopes explicitly — yours appears to use auto-detection, and ConfigStore introduces no scope the app doesn't already hold, so this should be a non-event.)

## Verification

The reads and writes to check, chosen because between them they exercise all five methods through the seam: open the spreadsheet and confirm the menu builds (`onOpen` → `UiMode.get_()` → `ConfigStore.get`); run **Show current config** and confirm token/URL/folder report exactly as before (layered reads with masking); run **Test connectivity** (proves `AppConfig.get()` still resolves the real token — the end-to-end read path); toggle **Switch to Advanced menu** and back (`setUser` through the seam, and the menu should visibly change); and run `runHermeticTests` for the cheap green baseline. If you want the delete path covered too, **Set base URL** → submit empty → confirm delete → **Show current config** should show the default EU URL again (`deleteUser` through the seam).

If all of that behaves, commit — suggested message: `refactor: ConfigStore delegates to Toolkit.newConfigStore (injected stores, lazy seam)` — and Phase 2 is done.

Then say the word and I'll produce the Phase 3 diff set: `newSheets`, `newDrive` (with `saveJson` and the app-side `saveLog` wrapper keeping the recipe-`code` massage), `newLog` (boolean verbose), `getSelectedIds`, and the test kit — plus the app-side seams for `02`, `04`, `22`, `50`, and `51`. That one's the big diff, so I'll structure it file by file for review.
