/**
 * user_task_snapshot.gs — Portal users × task state snapshot (standalone testing tool)
 *
 * Answers: which portal users have logged on, and which have completed their tasks.
 * Grain: one row per email. Snapshot semantics: full clear-and-rewrite, no diffing.
 *
 * Pipeline (frozen-snapshot model — fetches are the only impure stages):
 *   runUserTaskSnapshot()
 *     users = fetchPortalUsers_()       // impure: API recipe, paginated
 *     tasks = fetchTaskState_()         // impure: provider seam (sheet-backed default)
 *     recs  = buildJoin_(users, tasks)  // pure: normalize, merge, aggregate
 *     recs.forEach(classify_)           // pure, total: every record gets exactly one bucket
 *     writeSheets_(recs)                // idempotent rewrite: Join + Summary tabs
 *
 * Script Properties (File > Project properties > Script properties):
 *   WFA_USERS_API_TOKEN        required  API-platform key scoped to the portal-users collection
 *   WFA_USERS_ENDPOINT         required  e.g. https://apim.workato.com/<collection>/portal-users
 *   TASK_STATE_SPREADSHEET_ID  required* spreadsheet holding task state (see fetchTaskState_)
 *   TASK_STATE_RANGE           required* e.g. TaskState!A1:D  (header row: email,status,updated_at,supplier_id)
 *   OUTPUT_SPREADSHEET_ID      optional  omit if this script is container-bound to the output sheet
 *
 *   * required by the default sheet-backed provider only. Swapping fetchTaskState_ for a
 *     data-tables read or a second thin API recipe replaces these two keys with your own.
 *
 * GasToolkit note: cfg_() and log_() below are deliberate seams. To move onto the library,
 * rewire cfg_ -> ConfigStore and log_ -> AppLogger; nothing downstream changes.
 */

// ---------------------------------------------------------------------------
// Configuration seams
// ---------------------------------------------------------------------------

function cfg_(key, required) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) throw new Error('Missing Script Property: ' + key);
  return v;
}

function log_(msg) {
  console.log(msg); // seam: swap for AppLogger when this graduates onto GasToolkit
}

// ---------------------------------------------------------------------------
// Status vocabulary seam — the ONLY place STS-01 names appear.
// Classifier operates on abstract classes: open | in_progress | terminal_success | terminal_failure
// Edit this map when the schema bumps; classify_ never changes.
// ---------------------------------------------------------------------------

var STATUS_CLASS = {
  'pending_review':    'open',
  'awaiting_supplier': 'open',
  'in_validation':     'in_progress',
  'validated':         'terminal_success',
  'rejected':          'terminal_failure'
  // ...extend with your actual STS-01 set
};

// Bucket precedence: sort order for the Join tab (triage list, top = most actionable).
var BUCKET_ORDER = [
  'NOT_INVITED',
  'NEVER_LOGGED_IN',
  'ORPHAN_USER',
  'STALLED',
  'IN_PROGRESS',
  'COMPLETED'
];

var JOIN_HEADERS = [
  'email', 'bucket', 'flags',
  'portal_user_id', 'portal_status', 'portal_name', 'portal_groups',
  'tasks_total', 'tasks_open', 'tasks_completed', 'tasks_failed', 'task_last_update',
  'supplier_ids',
  'portal_snapshot_at', 'task_snapshot_at', 'run_id'
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function runUserTaskSnapshot() {
  var runId = new Date().toISOString();
  log_('run start ' + runId);

  var portal = fetchPortalUsers_();                 // { users: [...], fetchedAt: iso }
  var tasks  = fetchTaskState_();                   // { tasks: [...], fetchedAt: iso }

  var recs = buildJoin_(portal, tasks, runId);      // pure
  recs.forEach(function (r) { r.bucket = classify_(r); });  // pure, total

  writeSheets_(recs, runId, portal, tasks);

  log_('run complete: ' + recs.length + ' records');
  return recs.length;
}

// ---------------------------------------------------------------------------
// Impure stage 1: portal users via the API recipe (GET /portal-users)
// Contract v1.0: { users: [{user_id,name,email,status,groups:[{group_id,name}]}],
//                  continuation_token, fetched_at, ... }
// ---------------------------------------------------------------------------

function fetchPortalUsers_() {
  var token = cfg_('WFA_USERS_API_TOKEN', true);
  var base  = cfg_('WFA_USERS_ENDPOINT', true);
  var users = [];
  var pageToken = null;
  var pages = 0;

  do {
    var url = base + (pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '');
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'api-token': token },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Portal users fetch failed: HTTP ' + resp.getResponseCode() +
                      ' — ' + resp.getContentText().slice(0, 500));
    }
    var body = JSON.parse(resp.getContentText());
    Array.prototype.push.apply(users, body.users || []);
    pageToken = body.continuation_token || null;
    pages++;
    if (pages > 50) throw new Error('Pagination runaway: >50 pages; aborting.');
  } while (pageToken);

  log_('portal users: ' + users.length + ' across ' + pages + ' page(s)');
  return { users: users, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Impure stage 2: task state provider seam.
// Required yield per task: { email, status, updated_at, supplier_id? }
//
// Default implementation reads a sheet range (header row: email, status,
// updated_at, supplier_id — order-independent, matched by header name).
// To source from a data-tables export or a second thin API recipe instead,
// replace this function body; the yield contract is the only thing that matters.
// ---------------------------------------------------------------------------

function fetchTaskState_() {
  var ssId  = cfg_('TASK_STATE_SPREADSHEET_ID', true);
  var range = cfg_('TASK_STATE_RANGE', true);

  var values = SpreadsheetApp.openById(ssId).getRange(range).getValues();
  if (values.length < 2) {
    log_('task state: no data rows in ' + range);
    return { tasks: [], fetchedAt: new Date().toISOString() };
  }

  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var col = {
    email:       headers.indexOf('email'),
    status:      headers.indexOf('status'),
    updated_at:  headers.indexOf('updated_at'),
    supplier_id: headers.indexOf('supplier_id') // optional
  };
  if (col.email < 0 || col.status < 0) {
    throw new Error('Task state range must include "email" and "status" headers. Found: ' + headers.join(', '));
  }

  var tasks = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.email]) continue; // skip blanks
    tasks.push({
      email:       String(row[col.email]),
      status:      String(row[col.status]).trim(),
      updated_at:  col.updated_at >= 0 ? asIso_(row[col.updated_at]) : null,
      supplier_id: col.supplier_id >= 0 && row[col.supplier_id] !== '' ? String(row[col.supplier_id]) : null
    });
  }

  log_('task state: ' + tasks.length + ' task rows');
  return { tasks: tasks, fetchedAt: new Date().toISOString() };
}

function asIso_(v) {
  if (v instanceof Date) return v.toISOString();
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// ---------------------------------------------------------------------------
// Pure stage: join + aggregate. Emails normalized once, here, at the boundary.
// ---------------------------------------------------------------------------

function normEmail_(e) {
  return String(e || '').trim().toLowerCase();
}

function buildJoin_(portal, taskState, runId) {
  // Portal side: unique by email; duplicates keep-first + flag, never silently merge.
  var portalByEmail = {};
  var dupEmails = {};
  portal.users.forEach(function (u) {
    var key = normEmail_(u.email);
    if (!key) return;
    if (portalByEmail[key]) { dupEmails[key] = true; return; }
    portalByEmail[key] = u;
  });

  // Task side: aggregate per email.
  var aggByEmail = {};
  taskState.tasks.forEach(function (t) {
    var key = normEmail_(t.email);
    if (!key) return;
    var agg = aggByEmail[key] || (aggByEmail[key] = {
      total: 0, open: 0, completed: 0, failed: 0,
      lastUpdate: null, supplierIds: {}, unknownStatuses: {}
    });
    agg.total++;
    var cls = STATUS_CLASS[t.status];
    if (cls === 'terminal_success')      agg.completed++;
    else if (cls === 'terminal_failure') agg.failed++;
    else if (cls === 'open' || cls === 'in_progress') agg.open++;
    else { agg.open++; agg.unknownStatuses[t.status] = true; } // visible via flag, counted conservatively
    if (t.updated_at && (!agg.lastUpdate || t.updated_at > agg.lastUpdate)) agg.lastUpdate = t.updated_at;
    if (t.supplier_id) agg.supplierIds[t.supplier_id] = true;
  });

  // Union of keys -> records.
  var keys = {};
  Object.keys(portalByEmail).forEach(function (k) { keys[k] = true; });
  Object.keys(aggByEmail).forEach(function (k) { keys[k] = true; });

  return Object.keys(keys).sort().map(function (email) {
    var u = portalByEmail[email] || null;
    var a = aggByEmail[email] || null;
    var flags = [];

    if (dupEmails[email]) flags.push('duplicate_portal_email');
    if (a) {
      var unknown = Object.keys(a.unknownStatuses);
      unknown.forEach(function (s) { flags.push('unknown_task_status:' + s); });
      var sids = Object.keys(a.supplierIds);
      if (sids.length > 1) flags.push('multi_supplier_email');
    }

    return {
      email: email,
      bucket: null, // assigned by classify_
      flags: flags,

      portal_user_id: u ? (u.user_id || null) : null,
      portal_status:  u ? String(u.status || '').toLowerCase() : null,
      portal_name:    u ? (u.name || null) : null,
      portal_groups:  u && u.groups ? u.groups.map(function (g) { return g.name; }).join(', ') : '',

      tasks_total:     a ? a.total : 0,
      tasks_open:      a ? a.open : 0,
      tasks_completed: a ? a.completed : 0,
      tasks_failed:    a ? a.failed : 0,
      task_last_update: a ? a.lastUpdate : null,

      supplier_ids: a ? Object.keys(a.supplierIds).sort().join('; ') : '',

      portal_snapshot_at: portal.fetchedAt,
      task_snapshot_at:   taskState.fetchedAt,
      run_id: runId
    };
  });
}

// ---------------------------------------------------------------------------
// Pure stage: classification. Ordered, first match wins, total.
// Deliberate asymmetry: terminal task state outranks portal state (COMPLETED
// before NEVER_LOGGED_IN), with completed_without_login flag preserving the oddity.
// ---------------------------------------------------------------------------

function classify_(r) {
  var hasPortal = r.portal_user_id !== null || r.portal_status !== null;
  var hasTasks  = r.tasks_total > 0;
  var allCompleted = hasTasks && r.tasks_completed === r.tasks_total;
  var anyTerminal  = (r.tasks_completed + r.tasks_failed) > 0;

  if (!hasPortal && hasTasks) return 'NOT_INVITED';
  if (hasPortal && !hasTasks) return 'ORPHAN_USER';

  if (allCompleted) {
    if (r.portal_status === 'invited') r.flags.push('completed_without_login');
    return 'COMPLETED';
  }
  if (r.portal_status === 'invited') return 'NEVER_LOGGED_IN';
  if (hasTasks && !anyTerminal) return 'STALLED';
  return 'IN_PROGRESS';
}

// ---------------------------------------------------------------------------
// Output: Join (full rewrite, sorted as a triage list) + Summary (COUNTIF formulas).
// One writer per fact: the script writes Join rows and run metadata; counts are formulas.
// ---------------------------------------------------------------------------

function outputSpreadsheet_() {
  var id = cfg_('OUTPUT_SPREADSHEET_ID', false);
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (active) return active;
  throw new Error('No output target: set OUTPUT_SPREADSHEET_ID or bind the script to a spreadsheet.');
}

function writeSheets_(recs, runId, portal, taskState) {
  var ss = outputSpreadsheet_();

  // --- Join tab ---
  var join = ss.getSheetByName('Join') || ss.insertSheet('Join');
  join.clearContents();

  var order = {};
  BUCKET_ORDER.forEach(function (b, i) { order[b] = i; });
  recs.sort(function (a, b) {
    var d = (order[a.bucket] || 99) - (order[b.bucket] || 99);
    return d !== 0 ? d : (a.email < b.email ? -1 : 1);
  });

  var rows = [JOIN_HEADERS].concat(recs.map(function (r) {
    return [
      r.email, r.bucket, r.flags.join(', '),
      r.portal_user_id, r.portal_status, r.portal_name, r.portal_groups,
      r.tasks_total, r.tasks_open, r.tasks_completed, r.tasks_failed, r.task_last_update,
      r.supplier_ids,
      r.portal_snapshot_at, r.task_snapshot_at, r.run_id
    ];
  }));
  join.getRange(1, 1, rows.length, JOIN_HEADERS.length).setValues(rows);
  join.setFrozenRows(1);

  // --- Summary tab ---
  var sum = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sum.clearContents();

  var meta = [
    ['run_id',             runId],
    ['portal_snapshot_at', portal.fetchedAt],
    ['task_snapshot_at',   taskState.fetchedAt],
    ['portal_users_total', portal.users.length],
    ['task_rows_total',    taskState.tasks.length],
    ['join_records_total', recs.length],
    ['', ''],
    ['bucket', 'count']
  ];
  var formulas = BUCKET_ORDER.map(function (b) {
    return [b, '=COUNTIF(Join!$B:$B,"' + b + '")'];
  });
  var all = meta.concat(formulas);
  sum.getRange(1, 1, all.length, 2).setValues(all);
}

// ---------------------------------------------------------------------------
// One-time setup: conditional formatting on the Join bucket column.
// Run once by hand; not part of the snapshot pipeline.
// ---------------------------------------------------------------------------

function setupJoinFormatting() {
  var ss = outputSpreadsheet_();
  var join = ss.getSheetByName('Join') || ss.insertSheet('Join');
  var range = join.getRange('B2:B');

  var colors = {
    'NOT_INVITED':     '#f4cccc', // red — most actionable
    'NEVER_LOGGED_IN': '#f4cccc',
    'ORPHAN_USER':     '#efefef', // grey — hygiene
    'STALLED':         '#fce5cd', // amber
    'IN_PROGRESS':     '#fce5cd',
    'COMPLETED':       '#d9ead3'  // green
  };

  var rules = Object.keys(colors).map(function (bucket) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(bucket)
      .setBackground(colors[bucket])
      .setRanges([range])
      .build();
  });
  join.setConditionalFormatRules(rules);
}
