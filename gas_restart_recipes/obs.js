/**
 * @file SDC Watchdog — Observer (Step 2, read-only)
 * @description Scheduled corpus observer. Snapshots recipe state, derives the
 *              call graph, detects drift, logs one row per run, alerts on
 *              anomalies. WRITES NOTHING to Workato — the client is
 *              constructed with dryRun:true as a belt-and-suspenders guarantee
 *              even though no write method is ever called.
 *
 * Host-script dependencies (attach as GAS Libraries, or co-locate files):
 *   WorkatoLib       - newClient(token, baseUrl, options)
 *   WorkatoGraphLib  - newAnalyzer(client, config)   [patched: STRICT, child_ref, primeCache]
 *   WorkatoOrderLib  - newOrderer(options)
 *
 * Setup:
 *   1. Script Properties: WORKATO_TOKEN, SDC_ROOT_FOLDER_ID, ALERT_EMAIL,
 *      WATCHDOG_SHEET_ID (a blank spreadsheet's ID; tabs auto-created).
 *   2. Run observeOnce() manually once — authorizes scopes, creates tabs,
 *      seeds the manifest tab, writes the first baseline row.
 *   3. Trigger: time-driven, hourly, on observeOnce.
 *
 * Sheet tabs (auto-created):
 *   Runs      - one row per observation (the audit trail)
 *   Stopped   - one row per stopped-recipe sighting (the incident log)
 *   Findings  - one row per graph finding per run
 *   Manifest  - seeded from the corpus; add curation columns for Step 3
 *   State     - previous run's edge list + fingerprint (observer's only memory)
 */

// -------------------------------------------------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------------------------------------------------

var CFG = (function () {
  var p = PropertiesService.getScriptProperties();
  return {
    token:        p.getProperty('WORKATO_TOKEN'),
    baseUrl:      'https://app.eu.workato.com/api',
    rootFolderId: p.getProperty('SDC_ROOT_FOLDER_ID'),
    alertEmail:   p.getProperty('ALERT_EMAIL'),
    sheetId:      p.getProperty('WATCHDOG_SHEET_ID'),
    expectedCount: Number(p.getProperty('EXPECTED_RECIPE_COUNT') || 0) // 0 = don't assert
  };
})();

// -------------------------------------------------------------------------------------------------------
// ENTRY POINT (bind the hourly trigger to this)
// -------------------------------------------------------------------------------------------------------

function observeOnce() {
  var startedAt = new Date();
  var ss = SpreadsheetApp.openById(CFG.sheetId);

  try {
    // ---- 1. Pull the corpus (recursive folder walk, dedup) ----
    var client = WorkatoLib.newClient(CFG.token, CFG.baseUrl, { dryRun: true });
    var corpus = fetchCorpus_(client, CFG.rootFolderId);

    // ---- 2. State snapshot (from the list payload; zero extra calls) ----
    var snapshot = corpus.recipes.map(function (r) {
      return {
        id: String(r.id), name: r.name || '',
        running: !!r.running,
        stop_cause: r.stop_cause || '',
        version: r.version_no || r.version || '',
        last_run_at: r.last_run_at || ''
      };
    });
    var stopped = snapshot.filter(function (s) { return !s.running; });

    // ---- 3. Graph + fingerprint ----
    var analyzer = WorkatoGraphLib.newAnalyzer(client, { STRICT: true });
    analyzer.primeCache(corpus.recipes);
    var manifest = snapshot.map(function (s) { return { id: s.id, name: s.name }; });
    var orderer = WorkatoOrderLib.newOrderer({ strict: true });
    var graph = orderer.buildCorpusGraph(analyzer, manifest);
    var fingerprint = orderer.fingerprint(graph.edges);

    // Prove orderability every run, even though we act on nothing yet:
    // a cycle should be discovered by the observer, not by Step 3's first restart.
    orderer.topoSort(graph.nodes, graph.edges);

    // ---- 4. Compare with previous run ----
    var prev = readState_(ss);
    var drift = orderer.diffEdges(prev.edges, graph.edges);
    var newlyStopped = stopped.filter(function (s) {
      return prev.runningIds.length === 0 ? false : prev.runningIds.indexOf(s.id) !== -1;
    });

    // ---- 5. Log ----
    var nameById = {};
    snapshot.forEach(function (s) { nameById[s.id] = s.name; });
    var edgeNames = function (pair) {
      var a = pair.split('->');
      return (nameById[a[0]] || a[0]) + ' -> ' + (nameById[a[1]] || a[1]);
    };

    appendRow_(ss, 'Runs', RUNS_HEADER, [
      startedAt, 'ok',
      snapshot.length, snapshot.length - stopped.length, stopped.length,
      stopped.map(function (s) { return s.name + (s.stop_cause ? ' [' + s.stop_cause + ']' : ''); }).join('; '),
      fingerprint, (fingerprint !== prev.fingerprint && prev.fingerprint) ? 'DRIFT' : '',
      drift.added.map(edgeNames).join('; '),
      drift.removed.map(edgeNames).join('; '),
      graph.findings.length, ''
    ]);

    stopped.forEach(function (s) {
      appendRow_(ss, 'Stopped', STOPPED_HEADER,
        [startedAt, s.id, s.name, s.stop_cause, s.version, s.last_run_at,
         newlyStopped.some(function (n) { return n.id === s.id; }) ? 'NEW' : 'ongoing']);
    });

    graph.findings.forEach(function (f) {
      appendRow_(ss, 'Findings', FINDINGS_HEADER, [startedAt, f.level, f.code, f.detail]);
    });

    seedManifestIfEmpty_(ss, snapshot);
    writeState_(ss, fingerprint, graph.edges, snapshot);

    // ---- 6. Alert conditions ----
    var alerts = [];
    if (newlyStopped.length) {
      alerts.push('NEWLY STOPPED (' + newlyStopped.length + '):\n' + newlyStopped.map(function (s) {
        return '  ' + s.name + (s.stop_cause ? '  [' + s.stop_cause + ']' : '');
      }).join('\n'));
    }
    if (prev.fingerprint && fingerprint !== prev.fingerprint) {
      alerts.push('CALL-GRAPH DRIFT:\n  added:   ' + (drift.added.map(edgeNames).join('; ') || '-') +
                  '\n  removed: ' + (drift.removed.map(edgeNames).join('; ') || '-'));
    }
    if (CFG.expectedCount && snapshot.length !== CFG.expectedCount) {
      alerts.push('CORPUS COUNT ' + snapshot.length + ' != expected ' + CFG.expectedCount +
                  ' — recipe added/removed or folder scope changed.');
    }
    var errFindings = graph.findings.filter(function (f) { return f.level === 'error'; });
    if (errFindings.length) {
      alerts.push('GRAPH ERRORS:\n' + errFindings.map(function (f) {
        return '  [' + f.code + '] ' + f.detail; }).join('\n'));
    }
    if (alerts.length) {
      sendAlert_('SDC Watchdog: ' + alerts.length + ' condition(s)', alerts.join('\n\n') +
        '\n\nLog: ' + ss.getUrl());
    }

  } catch (e) {
    // The observer must never fail silently — that would be a watchdog
    // with the same disease as its patients.
    appendRow_(ss, 'Runs', RUNS_HEADER,
      [startedAt, 'ERROR', '', '', '', '', '', '', '', '', '', String(e && e.message || e)]);
    sendAlert_('SDC Watchdog: observer run FAILED', String(e && e.stack || e));
    throw e; // surface in GAS execution log / trigger failure notices too
  }
}

// -------------------------------------------------------------------------------------------------------
// CORPUS FETCH
// -------------------------------------------------------------------------------------------------------

/** Recursive folder walk + deduped recipe union. */
function fetchCorpus_(client, rootFolderId) {
  var folderIds = [String(rootFolderId)];
  var queue = [String(rootFolderId)];
  while (queue.length) {
    var parent = queue.shift();
    client.fetchPaginated('folders?parent_id=' + parent).forEach(function (f) {
      folderIds.push(String(f.id));
      queue.push(String(f.id));
    });
  }
  var recipes = [];
  var seen = {};
  folderIds.forEach(function (fid) {
    client.fetchPaginated('recipes?folder_id=' + fid).forEach(function (r) {
      var k = String(r.id);
      if (!seen[k]) { seen[k] = true; recipes.push(r); }
    });
  });
  return { folderIds: folderIds, recipes: recipes };
}

// -------------------------------------------------------------------------------------------------------
// SHEET PLUMBING
// -------------------------------------------------------------------------------------------------------

var RUNS_HEADER = ['run_at', 'status', 'recipes', 'running', 'stopped',
  'stopped_detail', 'fingerprint', 'drift', 'edges_added', 'edges_removed',
  'findings', 'error'];
var STOPPED_HEADER = ['seen_at', 'recipe_id', 'name', 'stop_cause', 'version',
  'last_run_at', 'novelty'];
var FINDINGS_HEADER = ['run_at', 'level', 'code', 'detail'];
var MANIFEST_HEADER = ['recipe_id', 'name', 'manage', 'after', 'notes'];

function getSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  return sh;
}

function appendRow_(ss, name, header, row) {
  getSheet_(ss, name, header).appendRow(row);
}

/**
 * Seeds the Manifest tab from the live corpus — once. Curation columns
 * (manage/after/notes) are yours to edit; the observer never overwrites them.
 * Step 3 reads this tab; until then it's just accumulating your judgment.
 */
function seedManifestIfEmpty_(ss, snapshot) {
  var sh = getSheet_(ss, 'Manifest', MANIFEST_HEADER);
  if (sh.getLastRow() > 1) return; // already seeded; hands off
  var rows = snapshot.map(function (s) { return [s.id, s.name, 'TRUE', '', '']; });
  sh.getRange(2, 1, rows.length, MANIFEST_HEADER.length).setValues(rows);
}

// ----- State tab: the observer's only memory (previous edges + fingerprint) -----

function readState_(ss) {
  var sh = getSheet_(ss, 'State', ['key', 'value']);
  var out = { fingerprint: '', edges: [], runningIds: [] };
  var last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    if (r[0] === 'fingerprint') out.fingerprint = String(r[1] || '');
    if (r[0] === 'edges')       out.edges = safeParse_(r[1], []);
    if (r[0] === 'running_ids') out.runningIds = safeParse_(r[1], []);
  });
  return out;
}

function writeState_(ss, fingerprint, edges, snapshot) {
  var sh = getSheet_(ss, 'State', ['key', 'value']);
  var runningIds = snapshot.filter(function (s) { return s.running; })
                           .map(function (s) { return s.id; });
  var rows = [
    ['fingerprint', fingerprint],
    ['edges', JSON.stringify(edges)],
    ['running_ids', JSON.stringify(runningIds)],
    ['updated_at', new Date().toISOString()]
  ];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
}

function safeParse_(v, fallback) {
  try { var p = JSON.parse(String(v)); return p === null ? fallback : p; }
  catch (e) { return fallback; }
}

// -------------------------------------------------------------------------------------------------------
// ALERTING
// -------------------------------------------------------------------------------------------------------

function sendAlert_(subject, body) {
  if (!CFG.alertEmail) { console.warn('No ALERT_EMAIL configured; alert suppressed: ' + subject); return; }
  MailApp.sendEmail(CFG.alertEmail, subject, body);
}
