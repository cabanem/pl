/**
 * @file SDC Watchdog — Restart Runner (Step 3, acts deliberately)
 * @description Human-initiated stop/start orchestration over the corpus. WorkatoOrderLib supplies the
 *              order, RestartExec executes it with verification. Three entry points, run in sequence
 *              from the Apps Script editor:
 *
 *                restartPlan()   - derive the graph from the curated Manifest tab, build the plan,
 *                                  write it to the Restart tab for a human read. Acts on nothing.
 *                restartStop()   - re-derive; refuse if the graph no longer matches the plan you read;
 *                                  otherwise stop callers-first and record what was transitioned.
 *                restartStart()  - re-derive AFTER your edits (call steps may have changed the graph),
 *                                  re-plan over targets + everything we stopped, start callees-first.
 *
 *              observeOnce() is untouched and remains read-only. Nothing in this file is wired to a
 *              trigger. Graph derivation rides the observer's dryRun WorkatoLib client; the ONLY
 *              write-capable client in the project is the executor's, constructed in execClient_().
 *
 * Uses RestartExec (co-located RestartExec.js, or attach later as library symbol WorkatoRestartExec —
 * the RX_() shim resolves either without code changes).
 *
 * Control surface (tabs auto-created on first run):
 *   Restart     - key/value. YOU edit:  targets  (recipe ids, comma/space/newline separated)
 *                                       scope    ('upstream' = quiesce transitive callers [default],
 *                                                 'targets'  = minimal; running callers will fail calls)
 *                 The runner writes:    phase, plan_*, stopped_ids, already_stopped.
 *   RestartLog  - one row per executed step: the deploy audit trail.
 *
 * Manifest tab is now load-bearing: manage=FALSE excludes a recipe from ordering; the 'after' column
 * adds constraint pins (recipe ids this row starts after). New recipes need a Manifest row before
 * they can be targeted — the observer seeds once and never overwrites your curation.
 *
 * Recipes found already stopped during restartStop() are LEFT AS FOUND by restartStart(): they were
 * down before this deploy, and bringing them up is a separate human decision (see the Stopped tab).
 */

// -------------------------------------------------------------------------------------------------------
// WIRING
// -------------------------------------------------------------------------------------------------------

var RESTART_HEADER    = ['key', 'value'];
var RESTARTLOG_HEADER = ['at', 'phase', 'recipe_id', 'name', 'action', 'ok', 'skipped', 'version', 'detail', 'ms'];

/** Resolve RestartExec whether co-located in this project or attached as a GAS library. */
function RX_() {
  if (typeof WorkatoRestartExec !== 'undefined') return WorkatoRestartExec;
  return { newExecutor: newExecutor, newWorkatoClient: newWorkatoClient };
}

/** The one write-capable client in this project. RestartExec prefixes /api itself. */
function execClient_() {
  return RX_().newWorkatoClient({
    token: CFG.token,
    base: String(CFG.baseUrl).replace(/\/api\/?$/, '')
  });
}

// -------------------------------------------------------------------------------------------------------
// ENTRY POINTS (run manually; nothing here is trigger-bound)
// -------------------------------------------------------------------------------------------------------

function restartPlan()  { return runRestartPhase_('plan'); }
function restartStop()  { return runRestartPhase_('stop'); }
function restartStart() { return runRestartPhase_('start'); }

/**
 * Optional bridge to automation — NOT wired to any trigger; wire deliberately if that day comes.
 * Starts every managed recipe currently stopped, callees-first, off a fresh plan. Recipes stopped
 * for quota/limit causes will simply stop again; read the Stopped tab before reaching for this.
 */
function recoverStopped() { return runRestartPhase_('recover'); }

// -------------------------------------------------------------------------------------------------------
// PHASES
// -------------------------------------------------------------------------------------------------------

/** Shared wrapper: derive fresh, dispatch, and never fail silently (mirrors observeOnce). */
function runRestartPhase_(which) {
  var ss = SpreadsheetApp.openById(CFG.sheetId);
  try {
    var ctx = deriveGraph_(ss);
    var kv = readRestartKV_(ss);
    if (which === 'plan')    return doPlan_(ss, ctx, kv);
    if (which === 'stop')    return doStop_(ss, ctx, kv);
    if (which === 'start')   return doStart_(ss, ctx, kv);
    if (which === 'recover') return doRecover_(ss, ctx);
    throw new Error('Unknown phase: ' + which);
  } catch (e) {
    var detail = String(e && e.message || e);
    if (e && e.findings && e.findings.length) {           // OrderingError carries findings — keep them
      detail += '\n' + e.findings.map(function (f) {
        return '[' + f.code + '] ' + f.detail; }).join('\n');
    }
    if (e && e.report && e.report.steps) logReport_(ss, e.report);  // ExecutionError carries the partial run
    appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
      [new Date(), which, '', '', 'ERROR', false, '', '', detail, '']);
    sendAlert_('SDC Watchdog: restart ' + which + ' FAILED', detail + '\n\nLog: ' + ss.getUrl());
    throw e;
  }
}

/** plan: build, display, act on nothing. */
function doPlan_(ss, ctx, kv) {
  var targets = splitIds_(kv.targets);
  if (!targets.length) {
    throw new Error("No targets. Put recipe id(s) in the Restart tab's 'targets' value cell, then rerun restartPlan().");
  }
  var scope = (kv.scope || 'upstream').trim().toLowerCase();

  var exec = RX_().newExecutor(execClient_());
  var plan = exec.makePlan(ctx.orderer, ctx.graph, targets, { scope: scope, manifest: ctx.manifest });
  var text = exec.describePlan(plan);

  writeRestartKV_(ss, {
    phase: 'planned',
    plan_targets: targets.join(','),
    plan_scope: plan.scope,
    plan_fingerprint: plan.fingerprint,
    plan_created_at: plan.createdAt,
    plan_text: text,
    stopped_ids: '[]',
    already_stopped: '[]'
  });
  appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
    [new Date(), 'plan', '', '', 'PLANNED', true, '', '',
     plan.startOrder.length + ' recipe(s) in scope; fingerprint ' + plan.fingerprint, '']);
  Logger.log(text);
  return plan;
}

/** stop: only ever executes the exact plan the human reviewed. */
function doStop_(ss, ctx, kv) {
  if (kv.phase !== 'planned') {
    throw new Error("Phase is '" + kv.phase + "'. Run restartPlan() and read the plan before restartStop().");
  }
  if (splitIds_(kv.targets).join(',') !== kv.plan_targets) {
    throw new Error('Targets changed since the plan was made. Run restartPlan() again.');
  }
  if (kv.plan_fingerprint !== ctx.fingerprint) {
    throw new Error('Call graph changed since the plan you reviewed (' + kv.plan_fingerprint +
                    ' -> ' + ctx.fingerprint + '). Run restartPlan() again.');
  }

  // Same edges (fingerprint), same targets, same scope: determinism makes this rebuild
  // byte-identical to the plan on the sheet.
  var exec = RX_().newExecutor(execClient_());
  var plan = exec.makePlan(ctx.orderer, ctx.graph, splitIds_(kv.plan_targets),
                           { scope: kv.plan_scope || 'upstream', manifest: ctx.manifest });

  var report = exec.executeStop(plan);
  logReport_(ss, report);

  var stoppedIds = report.steps
    .filter(function (s) { return s.ok && !s.skipped; })
    .map(function (s) { return s.id; });
  var alreadyStopped = report.steps
    .filter(function (s) { return s.skipped === 'already_stopped'; })
    .map(function (s) { return s.id; });

  writeRestartKV_(ss, {
    phase: 'stopped',
    stopped_ids: JSON.stringify(stoppedIds),
    already_stopped: JSON.stringify(alreadyStopped)
  });
  return report;
}

/** start: fresh graph (post-edit), fresh plan over targets + everything we stopped. */
function doStart_(ss, ctx, kv) {
  if (kv.phase !== 'stopped') {
    throw new Error("Phase is '" + kv.phase + "'. restartStart() follows a successful restartStop().");
  }

  var stoppedIds = safeParse_(kv.stopped_ids, []);
  var targets = dedupe_(splitIds_(kv.plan_targets).concat(stoppedIds));

  if (kv.plan_fingerprint && kv.plan_fingerprint !== ctx.fingerprint) {
    // Expected whenever the edit added/removed a call step; logged, not fatal — the plan below
    // is built from the fresh graph. The hourly observer will detail the drift on its next run.
    appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
      [new Date(), 'start', '', '', 'DRIFT', true, '', '',
       'graph changed during the window: ' + kv.plan_fingerprint + ' -> ' + ctx.fingerprint, '']);
  }

  var alreadyStopped = safeParse_(kv.already_stopped, []);
  if (alreadyStopped.length) {
    appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
      [new Date(), 'start', '', '', 'LEFT_AS_FOUND', true, '', '',
       'already stopped before this deploy, not started: ' + alreadyStopped.join(', '), '']);
  }

  var exec = RX_().newExecutor(execClient_());
  var plan = exec.makePlan(ctx.orderer, ctx.graph, targets,
                           { scope: kv.plan_scope || 'upstream', manifest: ctx.manifest });
  var report = exec.executeStart(plan, { currentFingerprint: ctx.fingerprint });
  logReport_(ss, report);

  writeRestartKV_(ss, { phase: 'completed' });
  return report;
}

/** recover: start whatever is down, callees-first. Manual, deliberate. */
function doRecover_(ss, ctx) {
  var nodeSet = {};
  ctx.graph.nodes.forEach(function (id) { nodeSet[id] = true; });
  var stopped = ctx.snapshot
    .filter(function (s) { return !s.running && nodeSet[s.id]; })
    .map(function (s) { return s.id; });

  if (!stopped.length) {
    appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
      [new Date(), 'recover', '', '', 'NOOP', true, '', '', 'nothing stopped among managed recipes', '']);
    return null;
  }

  var exec = RX_().newExecutor(execClient_());
  var plan = exec.makePlan(ctx.orderer, ctx.graph, stopped,
                           { scope: 'targets', manifest: ctx.manifest });
  Logger.log(exec.describePlan(plan));
  var report = exec.executeStart(plan, { currentFingerprint: ctx.fingerprint });
  logReport_(ss, report);
  return report;
}

// -------------------------------------------------------------------------------------------------------
// GRAPH DERIVATION (read path — same belt as the observer)
// -------------------------------------------------------------------------------------------------------

function deriveGraph_(ss) {
  var readClient = WorkatoLib.newClient(CFG.token, CFG.baseUrl, { dryRun: true });
  var corpus = fetchCorpus_(readClient, CFG.rootFolderId);

  var analyzer = WorkatoGraphLib.newAnalyzer(readClient, { STRICT: true });
  analyzer.primeCache(corpus.recipes);

  var snapshot = corpus.recipes.map(function (r) {
    return { id: String(r.id), name: r.name || '', running: !!r.running };
  });

  var manifest = readManifestTab_(ss, snapshot);
  var orderer = WorkatoOrderLib.newOrderer({ strict: true });
  var graph = orderer.buildCorpusGraph(analyzer, manifest);

  return {
    orderer: orderer,
    graph: graph,
    manifest: manifest,
    snapshot: snapshot,
    fingerprint: orderer.fingerprint(graph.edges)
  };
}

/** The curated Manifest tab, parsed. manage defaults true; 'after' = pinned predecessor ids. */
function readManifestTab_(ss, snapshot) {
  seedManifestIfEmpty_(ss, snapshot); // no-op once populated; observer may have seeded already
  var sh = getSheet_(ss, 'Manifest', MANIFEST_HEADER);
  var last = sh.getLastRow();
  if (last < 2) return snapshot.map(function (s) { return { id: s.id, name: s.name }; });

  return sh.getRange(2, 1, last - 1, MANIFEST_HEADER.length).getValues()
    .filter(function (r) { return r[0] !== '' && r[0] !== null; })
    .map(function (r) {
      return {
        id: String(r[0]),
        name: String(r[1] || ''),
        manage: !(r[2] === false || /^false$/i.test(String(r[2]).trim())),
        after: splitIds_(r[3])
      };
    });
}

// -------------------------------------------------------------------------------------------------------
// RESTART TAB + LOG PLUMBING
// -------------------------------------------------------------------------------------------------------

function readRestartKV_(ss) {
  var sh = getSheet_(ss, 'Restart', RESTART_HEADER);
  if (sh.getLastRow() < 2) {
    sh.getRange(2, 1, 3, 2).setValues([
      ['targets', ''], ['scope', 'upstream'], ['phase', 'idle']
    ]);
  }
  var out = { targets: '', scope: 'upstream', phase: 'idle' };
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (r[0]) out[String(r[0])] = (r[1] === null || r[1] === undefined) ? '' : String(r[1]);
  });
  return out;
}

/** Upsert key/value rows; never clears keys it doesn't touch (targets/scope stay yours). */
function writeRestartKV_(ss, patch) {
  patch.updated_at = new Date().toISOString();
  var sh = getSheet_(ss, 'Restart', RESTART_HEADER);
  var rowByKey = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) {
      if (r[0]) rowByKey[String(r[0])] = i + 2;
    });
  }
  Object.keys(patch).forEach(function (k) {
    if (rowByKey[k]) sh.getRange(rowByKey[k], 2).setValue(patch[k]);
    else sh.appendRow([k, patch[k]]);
  });
}

/** One row per executed step, then a phase summary row. */
function logReport_(ss, report) {
  report.steps.forEach(function (s) {
    appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
      [new Date(), report.phase, s.id, s.name, s.action, s.ok, s.skipped || '',
       (s.versionNo === null || s.versionNo === undefined) ? '' : s.versionNo,
       s.detail || '', s.ms]);
  });
  appendRow_(ss, 'RestartLog', RESTARTLOG_HEADER,
    [new Date(), report.phase, '', '', 'PHASE', report.ok, '', '',
     report.steps.length + ' step(s); ' + report.startedAt + ' -> ' + (report.finishedAt || ''), '']);
}

// -------------------------------------------------------------------------------------------------------
// SMALL UTILITIES
// -------------------------------------------------------------------------------------------------------

function splitIds_(v) {
  return String(v === null || v === undefined ? '' : v)
    .split(/[\s,;]+/).filter(function (x) { return x !== ''; });
}

function dedupe_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
  return out;
}
