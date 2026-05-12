# SDC Library Refactor — Handoff Document

> **How to resume this work:** Paste this entire document into a new Claude
> conversation and say: *"I'd like to resume the SDC library refactoring.
> Please read this document and pick up where we left off."*
>
> Claude will have the full plan, the locked decisions, the file inventory,
> and the open questions. You can resume mid-step or jump to any remaining
> step.

---

## 1. Project context

You're refactoring the SDC (Supplier Data Collection) Apps Script library for
**cohesion and consistency, utilizing shared patterns and resources**. The
library backs a multi-workbook system that serializes config to Drive and
sends it to Workato.

The refactor was triggered by a code review of `main.gs` (the container shim)
that surfaced ~10 findings, which in turn led to a full library review with
~30 findings organized into Tier 1 (likely to produce unexpected behavior),
Tier 2 (inconsistencies), and Tier 3 (style).

**Current state:** Steps 1–7 of a 12-step plan are complete. The test
harness was discussed and scoped but deferred — not yet built. Refactor
work is proceeding without it; harness can be added as a parallel
workstream when desired.

---

## 2. The 12-step plan

Done:
1. ✅ **Lock the canonical Result contract** (planning step)
2. ✅ **Add `Result.ok` / `Result.fail` factories** — new file `Result.gs`
3. ✅ **Conform the three orchestrators** to the factories (Provision, Validate, Portal)
4. ✅ **Conform `PrimaryKey.setupColumns` and `Migrations.run`** to canonical Result
5. ✅ **Update `main.gs` `showResult_`** to handle all five flows uniformly
6. ✅ **Lift `_stage` to a shared utility** — new file `Stage.gs` with `Stage.run(name, fn)`. Provision/Validate/Portal updated.
7. ✅ **Curried logger via `Log.forCorrelation(ss, correlationId)`** — Log.gs now has shared `_appendWithUser` primitive; both `Log.append` and `Log.forCorrelation` converge there. All five flows use the curried logger.

Pending:
8. ⏸ **`Stages` enum** (replaces scattered string literals like `'config'`, `'preflight'`, `'serialize-variants'`)
9. ⏸ **`DEV_SETTINGS_LAYOUT` and `CUSTOMER_LAYOUT` constants** in Schema.gs (replaces hardcoded `r[1]/r[2]/r[3]` and `'D6'`)
10. ⏸ **Tier 1 fixes** (see §6)
11. ⏸ **`Log.ensureSchema` decision** — *already done as part of step 2* (creates sheet when missing)
12. ⏸ **Tier 3 mechanical sweep** (`var`→`const`/`let`, `indexOf===0`→`startsWith`, JSDoc consistency, file-prefix renumbering)

**Test harness deferred.** Discussed but not built. Refactor work is proceeding
without it; harness can be added as a parallel workstream when desired.

---

## 3. Locked decisions

### 3.1 The canonical Result shape

```javascript
{
  ok:            boolean,
  flow:          string,         // 'provision' | 'validate' | 'portalInvite'
                                 //   | 'primaryKeySetup' | 'migration'
  correlationId: string,         // always present; flows generate at start
  message:       string,         // user-ready prose
  data:          Object | null,  // null on failure, object on success
  warnings:      string[],       // empty array on clean success
  error:         { stage: string, message: string } | null
}
```

Decisions made during contract locking:

- **`correlationId` is always a string, never null.** Setup and migration
  flows generate fresh UUIDs at flow start so log lines correlate within a
  run, even though those IDs have no Workato meaning.
- **`data` is `null` on failure**, object on success. Forces consumers to
  check `r.ok` before reading `r.data.something`.
- **`warnings` is a flat array of strings**, not structured objects. Promote
  to structured later if needed; flat is fine for v1.0.

### 3.2 `PrimaryKey.backfill` is exempt from the canonical Result shape

It's an *internal step result* consumed by Provision/Validate orchestrators,
not a flow returned to the container. It keeps its existing shape:
`{ ok, stamped: { sheetName: count }, totalStamped }`.

### 3.3 Setup and migration flows now log

Both `PrimaryKey.setupColumns` and `Migrations.run` now call `Log.append`.
This required `Log.ensureSchema` to create the `_script_logs` sheet when
absent (previously it no-op'd). The sheet is created hidden with frozen
header row.

### 3.4 Result factory uses named-argument objects

```javascript
Result.ok({ flow, correlationId, message, data, warnings });
Result.fail({ flow, correlationId, message, error, warnings });
```

Not positional. Validates required args at construction. `Result.fail`
accepts either an `Error` instance (preferred — picks up `.stage` and
`.message`) or a plain `{ stage, message }` object.

### 3.5 `showResult_` design (in `main.gs`)

- Title pattern: `<Flow label> — success` | `— success with warnings` | `— failed`
- Body: message → optional warnings block → optional correlation ID line
- Correlation ID is shown **only for** `provision`, `validate`, `portalInvite`
  (the Workato-talking flows). Setup/migration generate IDs for log
  correlation but the user has nothing to look up with them.
- Defensive: handles undefined Result with a clear "no result returned" alert.

### 3.6 Portal correlation ID handling

Portal recovers the originating provision's correlation ID from
`_script_logs`. When recovery fails:
- `recoveredCorrelationId` = null
- `traceCorrelationId` = freshly generated, used only for THIS run's log lines
- `Result.correlationId` = whichever exists (recovered preferred), so the
  user can find this run's log lines either way
- The startup log message and the failure message both make clear when
  there's no upstream provision to correlate to

This replaces the previous behavior of synthesizing a fresh UUID and
returning it on the Result, which produced IDs that pointed to nothing
in Workato.

---

## 4. Files written this session

All replace existing files at the same paths in your Apps Script library,
*except* `Result.gs` which is new.

| File | Path in library | Status |
|---|---|---|
| `000_Result.js` | New file at top of load order | Drop in |
| `000_Stage.js` | New file at top of load order | Drop in (step 6) |
| `000_Log.js` | Replace existing | Now has `Log.forCorrelation` + `_appendWithUser` (step 7) |
| `006_PrimaryKey.js` | Replace existing | Done; uses `Log.forCorrelation` |
| `002_Migrations.js` | Replace existing | Done; uses `Log.forCorrelation` |
| `005_Provision.js` | Replace existing | Done; uses `Stage.run` and `Log.forCorrelation` |
| `007_Validate.js` | Replace existing | Done; uses `Stage.run` and `Log.forCorrelation` |
| `004_Portal.js` | Replace existing | Done; uses `Stage.run` and `Log.forCorrelation` |
| `main.gs` (container) | Replace existing | Done |

### 4.1 The `Log.ensureSchema` change (full function body)

```javascript
Log.ensureSchema = function(ss) {
  try {
    if (!ss) return;

    var logSheet = ss.getSheetByName(LOG_SHEET_NAME);

    // Create the sheet if missing. Mutation is intentional and minimal:
    // a hidden tab with canonical headers. Idempotent on subsequent calls.
    if (!logSheet) {
      logSheet = ss.insertSheet(LOG_SHEET_NAME);
      logSheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS.slice()]);
      logSheet.setFrozenRows(1);
      logSheet.hideSheet();
      console.log('Log.ensureSchema: created ' + LOG_SHEET_NAME + ' sheet.');
      return;
    }

    var lastCol = logSheet.getLastColumn();
    var needed  = LOG_HEADERS.length;

    if (lastCol < needed) {
      var toAdd = needed - lastCol;
      logSheet.insertColumnsAfter(Math.max(lastCol, 1), toAdd);
    }

    var headerRange    = logSheet.getRange(1, 1, 1, needed);
    var currentHeaders = headerRange.getValues()[0].map(function(v) { return String(v).trim(); });

    var needsRewrite = false;
    for (var i = 0; i < needed; i++) {
      if (currentHeaders[i] !== LOG_HEADERS[i]) { needsRewrite = true; break; }
    }
    if (needsRewrite) {
      headerRange.setValues([LOG_HEADERS.slice()]);
      console.log('Log.ensureSchema: wrote canonical headers to ' + LOG_SHEET_NAME);
    }
  } catch (e) {
    console.warn('Log.ensureSchema failed: ' + e.message);
  }
};
```

---

## 5. Open questions (test harness)

These were posed at the pause point and not answered. Both need decisions
before harness work begins.

**Q1.** Where should the test harness live relative to library code?
- (a) `tests/` folder alongside the `.gs` files, `package.json` at the root.
- (b) Separate directory entirely (`sdc-tests/`).

Claude leans (a). User undecided.

**Q2.** Loader strategy for getting `.gs` files into Node?
- (a) `eval` file contents in a controlled scope.
- (b) Concatenate all `.gs` into one string, wrap in IIFE, evaluate.
- (c) Add explicit `module.exports` footers gated behind
  `typeof module !== 'undefined'` so they're harmless in Apps Script.

Claude leans (c) — adds two lines per file but is most explicit.

**Today's harness scope (when work resumes):**
- Loader shim + Jest config
- `Result.test.js` (the contract that everything assumes)
- A small `Util.test.js` (just `coerceTruthy` and `isValidEmailShape`) to
  validate the harness against two file shapes
- ~15 test cases total. Expand opportunistically as steps 6–10 land.

**Pure logic worth testing eventually** (~55 cases total across the library):

| Module | Pure functions | Approx. cases |
|---|---|---|
| Result.gs | `ok`, `fail`, `_requireArgs` | 6 |
| Util.gs | `coerceTruthy`, `isValidEmailShape`, `findValueRightOfLabel` | 10 |
| Payload.gs | All three builders + `_requireArgs` | 12 |
| Migrations.gs | `_planPath`, `_buildMessage` | 6 |
| Webhook.gs | `_backoffMs`, `_tryParseJson`, `_truncate` | 5 |
| Variant.gs | `_extractIncludedFields`, `_sheetsFromBaseOutput`, `_filter4Fields`, `_filter7Form`, `_buildVariantEnvelope` | 10 |
| Drive.gs | `normalizeDates`, `buildFieldVisibilityMap` | 5 |

---

## 6. Findings inventory

The original review produced ~30 findings. Status as of pause:

### Cross-cutting (drove the refactor strategy)

| ID | Description | Status |
|---|---|---|
| A | Result contract drift between orchestrators and non-orchestrator entries | ✅ Done (steps 1–4) |
| B | Three identical `_stage` helpers across orchestrators | ✅ Done (step 6) |
| C | Three nearly-identical Result builders (`_success`/`_failure`) | ✅ Done (step 2) |
| D | Per-orchestrator log-function rebuild + redundant `Session.getActiveUser()` calls | ✅ Done (step 7) |
| E | `_developer_settings` schema implicit and duplicated | ⏸ Step 9 |
| F | Stage names as scattered string literals | ⏸ Step 8 |
| G | Top-level constants leak into global namespace | Skipped — low impact |
| H | `var` and ES5 throughout (V8 has been default since 2020) | ⏸ Step 12 |

### Tier 1 — likely to produce unexpected behavior

| ID | Description | Status |
|---|---|---|
| 1 | `Drive.serializeConfig` cleans up *before* writing — risk of losing prior good file on write failure | ⏸ Step 10 (priority 3) |
| 2 | Filename collisions on same-second runs | ⏸ Step 10 (folded with #1) |
| 3 | `PrimaryKey._applyProtection` not idempotent — duplicate protections accumulate | ⏸ Step 10 (priority 1) |
| 4 | `PrimaryKey._ensureColumn` fragile against header rename — can create duplicate PK columns | ⏸ Step 10 (priority 2) |
| 5 | Portal synthesizes fake correlation ID for failure path | ✅ Done (step 3) |
| 6 | `Drive.shareWithIntegrationAccount` doesn't validate email before `addEditor('')` | ⏸ Step 10 (low priority) |
| 7 | `Webhook.call`'s "3xx is success" comment technically wrong | ⏸ Step 10 (low priority) |
| 8 | `Variant.serializeAll` shares files synchronously inside loop — partial state on Drive on failure | ⏸ Documentation issue |
| 9 | `Migrations.run` doesn't snapshot workbook before mutating | ⏸ Defer until v2.0 has real migrations |
| 10 | `Log.append` status coercion masks bugs silently | ⏸ Step 10 (priority 5) |

### Tier 1 fix priority order (when step 10 starts)

1. #3 — duplicate protections (highest probability of being hit)
2. #4 — header rename fragility (same family of bug, same file)
3. #1 — cleanup-before-write (low probability, catastrophic when hit)
4. #5 — Portal synthetic ID — ✅ already done
5. #10 — Log.append status coercion
6. #2 — same-second filename collisions (rolls in with #1)

### Tier 2 — inconsistencies

Mostly deferred. Two exceptions worth landing during cross-cutting work:

| ID | Description | Status |
|---|---|---|
| 11 | Hardcoded `'D6'` in `Variant._readVariantCount` | ⏸ Fold into step 9 |
| 12 | `Payload.*` builders include `timestamp`; `payload_version` is in `Webhook.call` | ⏸ Defer |
| 13 | `Preflight.run` couples to dev-settings keys via `webhookLabel` | ⏸ Defer |
| 14 | `Portal._preflight` exists alongside `Preflight.run` (could be a flag on Preflight.run) | ⏸ Defer |
| 15 | `Provision._success` builds `auditNote` in prose; doesn't expose structured warnings | ✅ Done (step 3 — now on `Result.warnings`) |
| 16 | `Config.build` does N linear scans of `devData` | ⏸ Defer (small data, acceptable for v1.0) |
| 17 | `Util.findValueRightOfLabel` does full-sheet scans | ⏸ Defer |
| 18 | `Drive.cleanupOldFiles` iterates all JSON files in destination folder | ⏸ Defer |
| 19 | `Log.ensureSchema` no-ops when sheet is missing | ✅ Done (step 2 — now creates) |
| 20 | `Migrations.isMigrationNeeded` swallows errors and returns false | ⏸ Defer |
| 21 | PK column placement assumes data column 1 OR 2 | ⏸ Defer |
| 22 | `Variant._buildVariantEnvelope` rebuilds visibility from filtered 7_form (subtle ordering) | ⏸ Defer (add sanity log) |
| 23 | `Webhook.call` doesn't include URL in error messages | ⏸ Defer |

### Tier 3 — style and modernization

| ID | Description | Status |
|---|---|---|
| 24 | `var` everywhere, ES5 function expressions | ⏸ Step 12 |
| 25 | `indexOf(prefix) === 0` instead of `startsWith` | ⏸ Step 12 |
| 26 | JSDoc inconsistency | ⏸ Step 12 |
| 27 | `FIELDS_LAYOUT` lacks comment block that other layouts have | ⏸ Step 12 |
| 28 | `MIGRATION_CHAIN` has explanatory commented-out code (move to JSDoc) | ⏸ Step 12 |
| 29 | Mixed dash usage (em vs en) | ⏸ Step 12 |
| 30 | Two files share `008_*` numeric prefix | ⏸ Step 12 |

### `main.gs` original findings

| ID | Description | Status |
|---|---|---|
| 1 | `onOpen` does real work and can fail silently | ⏸ Address before pasting (try/catch around `ensureSchema` and `isMigrationNeeded`) |
| 2 | No try/catch around any flow shim | ⏸ Defer (consider `runFlow_` wrapper) |
| 3 | Two menu items ("Start" + "Update configuration"), one function | ⏸ UX decision needed |
| 4 | Potential XSS in `showValidationResults_` if template uses `<?!= ?>` | ⏸ Audit `validate_results.html` |
| 5 | `setupPrimaryKeyColumns` and `migrateWorkbookSchema` bypass `showResult_` | ✅ Done (step 5) |
| 6 | `requestPortalAccess` has no toast | ✅ Done (step 5) |
| 7 | `showResult_` has no null guards | ✅ Done (step 5) |
| 8 | `migrateWorkbookSchema` doesn't guard version-fetch | ✅ Done (step 4 — now caught in `Migrations.run`) |
| 9 | Title set twice in `showValidationResults_` | ✅ Done (step 5) |
| 10 | `var` throughout (style) | ⏸ Step 12 |
| 11 | Cache `ui` in `setupPrimaryKeyColumns` | ⏸ Step 12 |
| 12 | `flowTitle_` uses magic strings | ⏸ Step 12 |
| 13 | Inconsistent em-dash style | ⏸ Step 12 |

---

## 6.5 Known external dependency: V-00 (Workato validation recipe)

The `Validate.run` orchestrator calls a Workato webhook (`config.webhook.validateUrl`)
expected to return parsed JSON validation results synchronously. That webhook
recipe is **V-00**, which has been designed but not built/deployed in Workato.

**Status:** V-00 is currently unbuilt. `Validate.run` will succeed through
serialization and share, but fail at the `webhook` stage (or `webhook-response`
stage if the webhook returns 200 with a non-JSON body like `status: ok`).

**Original design notes** (from earlier conversations, captured here so the
context isn't lost):

- V-00 is a callable Workato recipe with a webhook trigger.
- Calls C-01 in validate-only mode (`persist: false`).
- Original plan: return validation result JSON synchronously in webhook response.
- Discovered Workato webhook connector version available didn't support sync return — only emits `status: ok`.
- **Fallback design:** GAS mints `correlation_id`, fires webhook fire-and-forget. V-00 writes result to Drive at `{parent_folder}/validate_result_{correlation_id}.json`. GAS polls Drive on schedule (1s, 2s, 3s, 4.5s, 6s, 8s, 10s — ~10s total) until file appears, reads it, renders modal, trashes file.
- V-00's catch path also writes a result file with `status: "error"` so GAS doesn't poll forever.

**Implication for refactor:** `Validate.run` currently expects sync return.
If/when V-00 is built and the polling design is needed:
- `Webhook.call` becomes fire-and-forget for validate (or a new method added).
- A new utility (likely `Drive.pollForFile(folderId, fileName, schedule)`) is needed.
- `Validate.run` reshapes: fire webhook → poll Drive → read result → trash file.

**Not blocking the current refactor.** The library is being made more
cohesive; V-00 is a separate workstream.

---

## 7. Architectural notes worth carrying forward

These came up during the review and may inform future work:

- **Library/container seam:** Container is currently doing UI translation
  only. `flowTitle_` is in the container (rather than the library) so
  workbooks can rebrand without a library version bump. If you want the
  library to own this, move it to a `SDC.FlowTitles` export.

- **Schema versioning:** Three independent axes — `LIBRARY`, `PAYLOAD`,
  `SCHEMA`. Each bumps independently. Documented in `Version.gs`.

- **Logging contract:** "Best effort" — failures swallow to console.
  This is correct because the workflow must never fail because logging
  failed. But it means missing `_script_logs` = silent no-logs, which is
  why step 2 included the `ensureSchema` create-on-missing change.

- **Migration safety:** Migrations stop on first failure (partial
  migration is worse than no migration). When v2.0 lands a real migration
  step, finding #9 (snapshot before mutating) needs revisiting.

- **Variant cleanup is asymmetric by design:** `purpose='provision'` trashes
  prior config + variant + validate files. `purpose='validate'` trashes
  nothing. Documented in `Drive.serializeConfig` and `Variant.serializeAll`.

---

## 8. Quick reference: what each pending step touches

| Step | Files touched | Approx. complexity |
|---|---|---|
| 6 (shared `_stage`) | New `Stage.gs`; modify Provision, Validate, Portal | Small |
| 7 (curried logger) | Modify Log.gs, Provision, Validate, Portal, PrimaryKey, Migrations | Medium |
| 8 (Stages enum) | New `Stages` const in Schema.gs (or Stage.gs); modify all orchestrators | Small (mechanical) |
| 9 (DEV_SETTINGS_LAYOUT) | Schema.gs, Config.gs, Migrations.gs, Variant.gs (#11) | Small |
| 10 (Tier 1) | Mostly Drive.gs and PrimaryKey.gs | Per-fix variable |
| 12 (Tier 3) | Library-wide mechanical sweep | Time-consuming but low-risk |

---

## 9. Resuming the conversation

Recommended phrasing for a new chat:

> "I'd like to resume the SDC library refactoring. I have a handoff document
> from a previous session. Please read it and confirm you understand where
> we are, then we can pick up at [the test harness work / step 6 / wherever]."

If you've decided the test harness Q1 and Q2 in the meantime, include those
answers. Otherwise expect Claude to re-pose them.
