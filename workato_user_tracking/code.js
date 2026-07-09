/**
 * user_task_snapshot.gs — v2
 * Portal users × task state snapshot (standalone testing tool)
 *
 * Change from v1: task state now comes from the /task-state API recipe instead of a
 * spreadsheet. Both fetches are now twins over one generic paginated caller (fetchPaged_).
 * No new storage, no second writer — both endpoints read live state at run time.
 *
 * Pipeline (frozen-snapshot model — fetches are the only impure stages):
 *   runUserTaskSnapshot()
 *     users = fetchPortalUsers_()       // impure: GET /portal-users, paginated
 *     tasks = fetchTaskState_()         // impure: GET /task-state, paginated
 *     recs  = buildJoin_(users, tasks)  // pure: normalize, merge, aggregate
 *     recs.forEach(classify_)           // pure, total: every record gets exactly one bucket
 *     writeSheets_(recs)                // idempotent rewrite: Join + Summary tabs
 *
 * Script Properties:
 *   WFA_API_TOKEN         required  one API-platform key scoped to the collection holding BOTH endpoints
 *   WFA_USERS_ENDPOINT    required  e.g. https://apim.workato.com/<collection>/portal-users
 *   TASK_STATE_ENDPOINT   required  e.g. https://apim.workato.com/<collection>/task-state
 *   OUTPUT_SPREADSHEET_ID optional  omit if this script is container-bound to the output sheet
 *
 * Expected response contracts (both endpoints, same envelope shape):
 *   /portal-users: { users: [{user_id,name,email,status,groups:[{group_id,name}]}], continuation_token, ... }
 *   /task-state:   { tasks: [{email,status,updated_at,supplier_id}],               continuation_token, ... }
 *   Grain of /task-state: one row per user × request (fan-out is intentional).
 *   If your recipe uses a different list key or field names, the ONLY places to touch
 *   are the two thin wrappers fetchPortalUsers_ / fetchTaskState_.
 *
 * GasToolkit note: cfg_() and log_() are deliberate seams. To move onto the library,
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
// Generic paginated GET against an API-platform endpoint.
// Contract: response body carries the list under `listKey` and a nullable
// `continuation_token`; token round-trips as the `page_token` query param.
// Asserts the list key exists — a missing key means a contract mismatch, and
// silently treating it as an empty page would report every user as taskless.
// ---------------------------------------------------------------------------

function fetchPaged_(endpointUrl, listKey) {
  var token = cfg_('WFA_API_TOKEN', true);
  var items = [];
  var pageToken = null;
  var pages = 0;

  do {
    var url = endpointUrl + (pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '');
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'api-token': token },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Fetch failed [' + endpointUrl + ']: HTTP ' + resp.getResponseCode() +
                      ' — ' + resp.getContentText().slice(0, 500));
    }
    var body = JSON.parse(resp.getContentText());
    if (!(listKey in body)) {
      throw new Error('Contract mismatch [' + endpointUrl + ']: response has no "' + listKey +
                      '" key. Top-level keys: ' + Object.keys(body).join(', '));
    }
    Array.prototype.push.apply(items, body[listKey] || []);
    pageToken = body.continuation_token || null;
    pages++;
    if (pages > 50) throw new Error('Pagination runaway [' + endpointUrl + ']: >50 pages; aborting.');
  } while (pageToken);

  log_(listKey + ': ' + items.length + ' across ' + pages + ' page(s)');
  return { items: items, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Impure stage 1: portal users. Thin wrapper — endpoint + list key + passthrough.
// ---------------------------------------------------------------------------

function fetchPortalUsers_() {
  var page = fetchPaged_(cfg_('WFA_USERS_ENDPOINT', true), 'users');
  return { users: page.items, fetchedAt: page.fetchedAt };
}

// ---------------------------------------------------------------------------
// Impure stage 2: task state. Thin wrapper — normalizes each task row at the
// boundary so everything downstream sees exactly {email, status, updated_at,
// supplier_id} regardless of incidental extras the recipe emits.
// ---------------------------------------------------------------------------

function fetchTaskState_() {
  var page = fetchPaged_(cfg_('TASK_STATE_ENDPOINT', true), 'tasks');

  var tasks = page.items
    .filter(function (t) { return t && t.email; })
    .map(function (t) {
      return {
        email:       String(t.email),
        status:      String(t.status || '').trim(),
        updated_at:  asIso_(t.updated_at),
        supplier_id: t.supplier_id != null && t.supplier_id !== '' ? String(t.supplier_id) : null
      };
    });

  return { tasks: tasks, fetchedAt: page.fetchedAt };
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
      Object.keys(a.unknownStatuses).forEach(function (s) {
        flags.push('unknown_task_status:' + s);
      });
      if (Object.keys(a.supplierIds).length > 1) flags.push('multi_supplier_email');
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
