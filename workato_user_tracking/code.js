/**
 * user_task_snapshot.gs — v5
 * Portal users × activity feed snapshot (standalone testing tool)
 * Paired contract: API-006 "Fetch activity history", contract v2.0 (option B)
 *
 * Change from v4: ONE endpoint, ONE fetch. API-006 now bundles the roster
 * (find_users, unpaginated) with the event log (lookup_events, paginated).
 * Contract decisions this script enforces:
 *   - continuation_token is the EVENTS cursor only, round-tripped in the body.
 *   - users arrive complete on every page; taken from page 1, later pages ignored.
 *   - users_truncated_token non-null means >500 portal users => the roster is
 *     incomplete and every bucket would be wrong. The run ABORTS loudly.
 *     (If that day comes, split users into their own paginated endpoint — option A.)
 *   - project_start_date is REQUIRED (per the trigger schema). Requests created
 *     before it will be missing or have partial history — scope-test accordingly.
 *
 * Role model: the platform has NO first-class role field. Role is DERIVED from
 * group membership via ANALYST_GROUPS below (analyst wins; default supplier).
 * Ghost performers (activity but no roster row) derive role from the groups
 * embedded in their latest event's performed_by.
 *
 * Event vocabulary (confirmed from the connector's own picklist):
 *   task.created ("Task assigned" — system event, EMPTY performed_by),
 *   task.approved, task.rejected, task.completed, task.reassigned, task.expired,
 *   request.created, stage.changed, request.commented, request.shared, request.unshared
 * Supplier completion evidence = task.completed. Analyst review activity =
 * task.approved / task.rejected. stage.changed makes the per-record stage fold
 * reliable for all records created after project_start_date.
 *
 * Script Properties:
 *   WFA_API_TOKEN         required  API-platform key for the collection
 *   API006_ENDPOINT       required  POST endpoint of API-006
 *   PROJECT_START_DATE    required  sent on every request (endpoint requires it)
 *   OUTPUT_SPREADSHEET_ID optional  omit if container-bound
 *
 * Output tabs:
 *   Join    — one row per email: role, bucket, roster × activity evidence
 *             (suppliers sort first — they are the population under test)
 *   Records — one row per record_id: derived current stage + event stats
 *   Summary — run meta, bucket counts split by role, kind + stage inventories
 *             (the inventories remain the tuning tool for the seam maps below)
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
// Vocabulary seams
// ---------------------------------------------------------------------------

// Groups whose members are analysts; everyone else is a supplier user.
var ANALYST_GROUPS = {
  'Implementation team': true,
  'Admin': true
};

// Event kinds that count as per-user completion evidence (confirmed vocabulary).
var COMPLETION_KINDS = {
  'task.completed': true
};

// WFA workflow-stage names -> abstract classes. This is the WFA Kanban machine,
// independent of STS-01 — do not import STS-01 names. Verify expected names
// against the stage inventory on the Summary tab after the first run.
var STAGE_CLASS = {
  'Pending assignment to supplier': 'open',            // observed
  'Assigned to supplier':           'open',            // observed
  'Data entry':                     'in_progress',     // expected — verify
  'Validating':                     'in_progress',     // expected — verify
  'Review':                         'in_progress',     // expected — verify
  'Complete':                       'terminal_success',// expected — verify
  'Canceled':                       'terminal_failure' // expected — verify
};

// Bucket precedence: sort order within each role block on the Join tab.
var BUCKET_ORDER = [
  'GHOST_PERFORMER',      // activity but no roster record — anomaly, investigate
  'NEVER_LOGGED_IN',      // roster invited, zero activity
  'NO_ACTIVITY',          // roster active (invite accepted => logged in), zero events
  'ACTIVE_NO_COMPLETION', // performed events, none of completion kind
  'COMPLETED'             // >=1 completion-kind event performed
];

var JOIN_HEADERS = [
  'email', 'role', 'bucket', 'flags',
  'portal_user_id', 'portal_status', 'portal_name', 'portal_groups',
  'activity_events', 'completions', 'kinds_seen',
  'first_activity_at', 'last_activity_at', 'activity_status',
  'snapshot_at', 'run_id'
];

var RECORD_HEADERS = [
  'record_id', 'current_stage', 'stage_class',
  'events_total', 'first_event_at', 'last_event_at', 'performers', 'run_id'
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function runUserTaskSnapshot() {
  var runId = new Date().toISOString();
  log_('run start ' + runId);

  var bundle = fetchBundle_(); // { users: [...], events: [...], fetchedAt } — one call chain

  // Pure derivations from the event log.
  var byUser   = aggregateByUser_(bundle.events);
  var byRecord = aggregateByRecord_(bundle.events);
  var kinds    = countBy_(bundle.events, function (e) { return e.kind; });
  var stages   = countBy_(Object.keys(byRecord).map(function (k) { return byRecord[k]; }),
                          function (r) { return r.stage || '(blank)'; });

  var recs = buildUserJoin_(bundle, byUser, runId);         // pure
  recs.forEach(function (r) { r.bucket = classify_(r); });  // pure, total

  writeSheets_(recs, byRecord, kinds, stages, runId, bundle);

  log_('run complete: ' + recs.length + ' users, ' + Object.keys(byRecord).length + ' records');
  return recs.length;
}

// ---------------------------------------------------------------------------
// The single impure stage: POST API-006, loop the events cursor.
// Users come complete on every page; page 1's copy is kept, later pages ignored.
// Both sides are normalized HERE so nothing downstream touches raw payloads.
// ---------------------------------------------------------------------------

function fetchBundle_() {
  var endpoint = cfg_('API006_ENDPOINT', true);
  var token    = cfg_('WFA_API_TOKEN', true);
  var startDate = cfg_('PROJECT_START_DATE', true); // required by the endpoint contract

  var rawUsers = null;
  var rawEvents = [];
  var pageToken = null;
  var pages = 0;

  do {
    var params = { project_start_date: startDate };
    if (pageToken) params.continuation_token = pageToken;

    var resp = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'api-token': token },
      payload: JSON.stringify(params),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('API-006 fetch failed: HTTP ' + resp.getResponseCode() +
                      ' — ' + resp.getContentText().slice(0, 500));
    }

    var body = JSON.parse(resp.getContentText());
    // The wire body is the schema fields directly. Test harnesses sometimes show
    // it wrapped as {http_status_code, response:{...}} — accept both, assert once.
    var r = (body && body.response && typeof body.response === 'object' && 'ok' in body.response)
      ? body.response : body;

    if (r.ok !== true) {
      throw new Error('API-006 reported not-ok: ' + (r.error_message || JSON.stringify(r).slice(0, 300)));
    }
    if (r.users_truncated_token) {
      throw new Error('ROSTER TRUNCATED: users_truncated_token is set (>500 portal users). ' +
                      'Every bucket would be computed against a partial roster — aborting. ' +
                      'Time to split users into their own paginated endpoint (option A).');
    }
    if (!('activity_records' in r)) {
      throw new Error('Contract mismatch: no "activity_records" key. Keys: ' + Object.keys(r).join(', '));
    }
    if (rawUsers === null) {
      if (!('users' in r)) {
        throw new Error('Contract mismatch: no "users" key on first page. Keys: ' + Object.keys(r).join(', '));
      }
      rawUsers = r.users || [];
    }

    Array.prototype.push.apply(rawEvents, r.activity_records || []);
    pageToken = r.continuation_token || null;
    pages++;
    if (pages > 50) throw new Error('Pagination runaway: >50 pages; aborting.');
  } while (pageToken);

  // Normalize the roster: one internal shape, one vocabulary.
  var users = rawUsers
    .filter(function (u) { return u && u.user_email; })
    .map(function (u) {
      return {
        user_id: u.user_id || null,
        name:    u.user_name || null,
        email:   normEmail_(u.user_email),
        status:  String(u.status || '').toLowerCase(),
        groupNames: (u.groups || []).map(function (g) { return g.group_name; })
      };
    });

  // Normalize events.
  var events = rawEvents
    .filter(function (e) { return e && e.record_id; })
    .map(function (e) {
      var pb = e.performed_by || {};
      var email = normEmail_(pb.user_email);
      return {
        record_id:    String(e.record_id),
        kind:         String(e.kind || '').trim(),
        performed_at: asIso_(e.performed_at),
        email:        email || null, // null => system/unattributed event (e.g. task.created)
        user_status:  email ? String(pb.status || '').toLowerCase() : null,
        groupNames:   email ? (pb.groups || []).map(function (g) { return g.group_name; }) : [],
        stage:        e.workflow_stage ? String(e.workflow_stage.workflow_stage_name || '').trim() : ''
      };
    });

  log_('bundle: ' + users.length + ' users, ' + events.length + ' events, ' + pages + ' page(s)');
  return { users: users, events: events, fetchedAt: new Date().toISOString() };
}

// Boundary normalizers.
function asIso_(v) {
  if (v instanceof Date) return v.toISOString();
  if (!v) return null;
  var s = String(v).replace(/\.(\d{3})\d+/, '.$1'); // trim microseconds for engine-safe parsing
  var d = new Date(s);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function normEmail_(e) {
  return String(e || '').trim().toLowerCase();
}

// Role derivation — the only place role logic lives. Analyst membership wins.
function roleOf_(groupNames) {
  for (var i = 0; i < (groupNames || []).length; i++) {
    if (ANALYST_GROUPS[groupNames[i]]) return 'analyst';
  }
  return 'supplier';
}

// ---------------------------------------------------------------------------
// Pure derivations from the event log.
// ---------------------------------------------------------------------------

// Per-user evidence: only events carrying a performer email attribute to a user.
function aggregateByUser_(events) {
  var byUser = {};
  events.forEach(function (e) {
    if (!e.email) return; // system/unattributed events carry no per-user evidence
    var a = byUser[e.email] || (byUser[e.email] = {
      events: 0, completions: 0, kinds: {},
      first: null, last: null,
      lastStatus: null, lastGroups: [], lastAt: null
    });
    a.events++;
    if (COMPLETION_KINDS[e.kind]) a.completions++;
    if (e.kind) a.kinds[e.kind] = true;
    if (e.performed_at) {
      if (!a.first || e.performed_at < a.first) a.first = e.performed_at;
      if (!a.last  || e.performed_at > a.last)  a.last  = e.performed_at;
      if (!a.lastAt || e.performed_at >= a.lastAt) { // embedded identity from latest event
        a.lastStatus = e.user_status;
        a.lastGroups = e.groupNames;
        a.lastAt = e.performed_at;
      }
    }
  });
  return byUser;
}

// Per-record derived state: ALL events count here, performer or not.
// Current stage = stage on the record's latest stage-bearing event.
function aggregateByRecord_(events) {
  var byRecord = {};
  events.forEach(function (e) {
    var r = byRecord[e.record_id] || (byRecord[e.record_id] = {
      record_id: e.record_id,
      events: 0, first: null, last: null,
      stage: '', stageAt: null,
      performers: {}
    });
    r.events++;
    if (e.performed_at) {
      if (!r.first || e.performed_at < r.first) r.first = e.performed_at;
      if (!r.last  || e.performed_at > r.last)  r.last  = e.performed_at;
      if (e.stage && (!r.stageAt || e.performed_at >= r.stageAt)) {
        r.stage = e.stage;
        r.stageAt = e.performed_at;
      }
    }
    if (e.email) r.performers[e.email] = true;
  });
  return byRecord;
}

function countBy_(list, keyFn) {
  var counts = {};
  list.forEach(function (x) {
    var k = keyFn(x) || '(blank)';
    counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// Pure stage: roster × activity join. One row per email; union of both sides.
// ---------------------------------------------------------------------------

function buildUserJoin_(bundle, byUser, runId) {
  var rosterByEmail = {};
  var dupEmails = {};
  bundle.users.forEach(function (u) {
    if (!u.email) return;
    if (rosterByEmail[u.email]) { dupEmails[u.email] = true; return; }
    rosterByEmail[u.email] = u;
  });

  var keys = {};
  Object.keys(rosterByEmail).forEach(function (k) { keys[k] = true; });
  Object.keys(byUser).forEach(function (k) { keys[k] = true; });

  return Object.keys(keys).sort().map(function (email) {
    var u = rosterByEmail[email] || null;
    var a = byUser[email] || null;
    var flags = [];

    if (dupEmails[email]) flags.push('duplicate_portal_email');

    // Cross-check roster status vs status embedded in the user's latest event.
    if (u && a && a.lastStatus && u.status && a.lastStatus !== u.status) {
      flags.push('status_mismatch:roster=' + u.status + ',activity=' + a.lastStatus);
    }

    // Role: roster groups when present; ghost performers fall back to the
    // groups embedded in their latest event.
    var role = u ? roleOf_(u.groupNames) : roleOf_(a ? a.lastGroups : []);

    return {
      email: email,
      role: role,
      bucket: null,
      flags: flags,

      portal_user_id: u ? u.user_id : null,
      portal_status:  u ? u.status : null,
      portal_name:    u ? u.name : null,
      portal_groups:  u ? u.groupNames.join(', ') : (a ? a.lastGroups.join(', ') : ''),

      activity_events: a ? a.events : 0,
      completions:     a ? a.completions : 0,
      kinds_seen:      a ? Object.keys(a.kinds).sort().join(', ') : '',
      first_activity_at: a ? a.first : null,
      last_activity_at:  a ? a.last : null,
      activity_status:   a ? a.lastStatus : null,

      snapshot_at: bundle.fetchedAt,
      run_id: runId
    };
  });
}

// ---------------------------------------------------------------------------
// Classification. Ordered, first match wins, total. Buckets are role-agnostic;
// role is a column, and the Summary splits counts by role. (Analysts will
// naturally live in ACTIVE_NO_COMPLETION — they approve/reject, not complete.)
// ---------------------------------------------------------------------------

function classify_(r) {
  var hasRoster   = r.portal_user_id !== null || r.portal_status !== null;
  var hasActivity = r.activity_events > 0;

  if (!hasRoster && hasActivity) return 'GHOST_PERFORMER';
  if (hasRoster && !hasActivity) {
    return r.portal_status === 'invited' ? 'NEVER_LOGGED_IN' : 'NO_ACTIVITY';
  }
  if (r.completions > 0) {
    if (r.portal_status === 'invited') r.flags.push('completed_while_invited');
    return 'COMPLETED';
  }
  return 'ACTIVE_NO_COMPLETION';
}

// ---------------------------------------------------------------------------
// Output. Join sorts suppliers first (the population under test), then bucket
// precedence, then email. Summary bucket counts are COUNTIFS split by role.
// ---------------------------------------------------------------------------

function outputSpreadsheet_() {
  var id = cfg_('OUTPUT_SPREADSHEET_ID', false);
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (active) return active;
  throw new Error('No output target: set OUTPUT_SPREADSHEET_ID or bind the script to a spreadsheet.');
}

function writeSheets_(recs, byRecord, kinds, stages, runId, bundle) {
  var ss = outputSpreadsheet_();

  // --- Join tab ---
  var join = ss.getSheetByName('Join') || ss.insertSheet('Join');
  join.clearContents();

  var order = {};
  BUCKET_ORDER.forEach(function (b, i) { order[b] = i; });
  recs.sort(function (a, b) {
    var ra = a.role === 'supplier' ? 0 : 1;
    var rb = b.role === 'supplier' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    var d = (order[a.bucket] || 99) - (order[b.bucket] || 99);
    return d !== 0 ? d : (a.email < b.email ? -1 : 1);
  });

  var joinRows = [JOIN_HEADERS].concat(recs.map(function (r) {
    return [
      r.email, r.role, r.bucket, r.flags.join(', '),
      r.portal_user_id, r.portal_status, r.portal_name, r.portal_groups,
      r.activity_events, r.completions, r.kinds_seen,
      r.first_activity_at, r.last_activity_at, r.activity_status,
      r.snapshot_at, r.run_id
    ];
  }));
  join.getRange(1, 1, joinRows.length, JOIN_HEADERS.length).setValues(joinRows);
  join.setFrozenRows(1);

  // --- Records tab ---
  var recSheet = ss.getSheetByName('Records') || ss.insertSheet('Records');
  recSheet.clearContents();

  var recordList = Object.keys(byRecord).map(function (k) { return byRecord[k]; });
  recordList.sort(function (a, b) { // non-terminal first, then most recently touched
    var ca = STAGE_CLASS[a.stage] || 'unknown';
    var cb = STAGE_CLASS[b.stage] || 'unknown';
    var ta = ca.indexOf('terminal') === 0 ? 1 : 0;
    var tb = cb.indexOf('terminal') === 0 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return (b.last || '') < (a.last || '') ? -1 : 1;
  });

  var recordRows = [RECORD_HEADERS].concat(recordList.map(function (r) {
    return [
      r.record_id, r.stage, STAGE_CLASS[r.stage] || 'unknown',
      r.events, r.first, r.last,
      Object.keys(r.performers).sort().join('; '),
      runId
    ];
  }));
  recSheet.getRange(1, 1, recordRows.length, RECORD_HEADERS.length).setValues(recordRows);
  recSheet.setFrozenRows(1);

  // --- Summary tab ---
  var sum = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sum.clearContents();

  var rows = [
    ['run_id',              runId, ''],
    ['snapshot_at',         bundle.fetchedAt, ''],
    ['project_start_date',  cfg_('PROJECT_START_DATE', true), ''],
    ['users_total',         bundle.users.length, ''],
    ['activity_events_total', bundle.events.length, ''],
    ['records_total',       Object.keys(byRecord).length, ''],
    ['join_records_total',  recs.length, ''],
    ['', '', ''],
    ['bucket', 'supplier', 'analyst']
  ];
  BUCKET_ORDER.forEach(function (b) {
    rows.push([
      b,
      '=COUNTIFS(Join!$C:$C,"' + b + '",Join!$B:$B,"supplier")',
      '=COUNTIFS(Join!$C:$C,"' + b + '",Join!$B:$B,"analyst")'
    ]);
  });

  rows.push(['', '', '']);
  rows.push(['kind (inventory — tune COMPLETION_KINDS from this)', 'count', '']);
  Object.keys(kinds).sort().forEach(function (k) { rows.push([k, kinds[k], '']); });

  rows.push(['', '', '']);
  rows.push(['current stage (inventory — tune STAGE_CLASS from this)', 'records', '']);
  Object.keys(stages).sort().forEach(function (s) { rows.push([s, stages[s], '']); });

  sum.getRange(1, 1, rows.length, 3).setValues(rows);
}

// ---------------------------------------------------------------------------
// One-time setup: conditional formatting on the Join bucket column (now C).
// Run once by hand; not part of the snapshot pipeline.
// ---------------------------------------------------------------------------

function setupJoinFormatting() {
  var ss = outputSpreadsheet_();
  var join = ss.getSheetByName('Join') || ss.insertSheet('Join');
  var range = join.getRange('C2:C');

  var colors = {
    'GHOST_PERFORMER':      '#f4cccc', // red — anomaly, investigate
    'NEVER_LOGGED_IN':      '#f4cccc', // red — invite never accepted
    'NO_ACTIVITY':          '#fce5cd', // amber — in, but silent
    'ACTIVE_NO_COMPLETION': '#fce5cd', // amber — moving, not done
    'COMPLETED':            '#d9ead3'  // green
  };

  var rules = Object.keys(colors).map(function (bucket) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(bucket)
      .setBackground(colors[bucket])
      .setRanges([range])
      .build();
  });
  join.setConditionalFormatRules(rules);
} *
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
// Generic paginated fetch against an API-platform endpoint.
//
// opts:
//   method  'get' (default) | 'post'
//   params  object of request parameters, sent every page:
//           GET  -> query string;  POST -> JSON body (contentType application/json)
// The continuation token is merged into params as `page_token` on each pass, so
// pagination works identically for both transports.
//
// Asserts the list key exists — a missing key means a contract mismatch, and
// silently treating it as an empty page would report every user as taskless.
// ---------------------------------------------------------------------------

function fetchPaged_(endpointUrl, listKey, opts) {
  opts = opts || {};
  var method = (opts.method || 'get').toLowerCase();
  var token = cfg_('WFA_API_TOKEN', true);
  var items = [];
  var pageToken = null;
  var pages = 0;

  do {
    // Rebuild params each pass: base params + current page token.
    var params = {};
    var base = opts.params || {};
    for (var k in base) {
      if (base.hasOwnProperty(k) && base[k] !== null && base[k] !== undefined && base[k] !== '') {
        params[k] = base[k];
      }
    }
    if (pageToken) params.page_token = pageToken;

    var url = endpointUrl;
    var fetchOpts = {
      method: method,
      headers: { 'api-token': token },
      muteHttpExceptions: true
    };

    if (method === 'get') {
      var qs = Object.keys(params).map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      }).join('&');
      if (qs) url += '?' + qs;
    } else {
      fetchOpts.contentType = 'application/json';
      fetchOpts.payload = JSON.stringify(params);
    }

    var resp = UrlFetchApp.fetch(url, fetchOpts);
    if (resp.getResponseCode() !== 200) {
      throw new Error('Fetch failed [' + method.toUpperCase() + ' ' + endpointUrl + ']: HTTP ' +
                      resp.getResponseCode() + ' — ' + resp.getContentText().slice(0, 500));
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
// Impure stage 1: portal users. Thin wrapper — GET, no extra params.
// ---------------------------------------------------------------------------

function fetchPortalUsers_() {
  var page = fetchPaged_(cfg_('WFA_USERS_ENDPOINT', true), 'users');
  return { users: page.items, fetchedAt: page.fetchedAt };
}

// ---------------------------------------------------------------------------
// Impure stage 2: task state. POST with JSON body {project_start_date?, page_token?}.
// Normalizes each task row at the boundary so everything downstream sees exactly
// {email, status, updated_at, supplier_id} regardless of incidental extras.
// ---------------------------------------------------------------------------

function fetchTaskState_() {
  var page = fetchPaged_(cfg_('TASK_STATE_ENDPOINT', true), 'tasks', {
    method: 'post',
    params: {
      project_start_date: cfg_('PROJECT_START_DATE', false) // flip to `true` if the recipe requires it
    }
  });

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
    ['project_start_date', cfg_('PROJECT_START_DATE', false) || '(none)'],
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
    'IN_PROGRESS':     '#fce5cd', // amber
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
