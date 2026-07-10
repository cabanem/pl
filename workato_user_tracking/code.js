/**
 * user_task_snapshot.gs — v6
 * Portal users × requests table × activity feed snapshot (standalone testing tool)
 * Paired contract: API-006 "Fetch activity history", contract v2.1 (option B + requests search)
 *
 * Change from v5: the bundle gains the REQUESTS TABLE (search_requests), which
 * closes the two gaps the event feed left open:
 *   1. ATTRIBUTION — active_task.assigned_user carries the assignee the
 *      task.created event hides in prose. Per-user open assignments are now
 *      computable. Caveats enforced here: it is the ACTIVE task only (assignment
 *      evidence disappears when work completes — completion evidence remains
 *      task.completed events; the two sources are complementary), and
 *      group-assigned tasks attribute to no individual (flagged, not guessed).
 *   2. VERIFICATION — the table's stage is authoritative; the event fold is a
 *      claim. The Records tab is now a reconciliation with three anomalies:
 *        STAGE_DRIFT   both sides present, stages disagree (fold bug or lost events)
 *        EVENTS_MISSING table row with zero events (predates project_start_date —
 *                       detectable because the requests search is UNWINDOWED)
 *        DERIVED_ONLY  events but no table row (deleted request?)
 *
 * Same option-B pagination discipline, now with three streams:
 *   - continuation_token: EVENTS cursor only, round-tripped in the body
 *   - users:    complete every page, taken from page 1; users_truncated_token
 *               (>500) aborts the run
 *   - requests: complete every page, taken from page 1; requests_truncated_token
 *               (>200 — this action's max is 200, not 500) aborts the run
 *
 * Context columns: whatever keys the recipe maps into requests[].context are
 * spread into Records-tab columns dynamically — no script change per column.
 *
 * Script Properties:
 *   WFA_API_TOKEN         required  API-platform key for the collection
 *   API006_ENDPOINT       required  POST endpoint of API-006
 *   PROJECT_START_DATE    required  sent on every request (endpoint requires it)
 *   OUTPUT_SPREADSHEET_ID optional  omit if container-bound
 *
 * Output tabs:
 *   Join    — one row per email: role, bucket, evidence, open assignments
 *   Records — one row per record_id: reconciliation (anomalies sort first)
 *   Summary — run meta, bucket counts by role, anomaly counts, kind/stage inventories
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
// independent of STS-01. Verify expected names against the stage inventory on
// the Summary tab after the first run.
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

// Record reconciliation anomalies (Records tab), in triage order.
var ANOMALY_ORDER = ['STAGE_DRIFT', 'EVENTS_MISSING', 'DERIVED_ONLY', ''];

var JOIN_HEADERS = [
  'email', 'role', 'bucket', 'flags',
  'portal_user_id', 'portal_status', 'portal_name', 'portal_groups',
  'open_assignments', 'activity_events', 'completions', 'kinds_seen',
  'first_activity_at', 'last_activity_at', 'activity_status',
  'snapshot_at', 'run_id'
];

// Records headers are built at write time: fixed columns + dynamic context keys.
var RECORD_FIXED_HEADERS = [
  'record_id', 'anomaly', 'table_stage', 'derived_stage', 'stage_class',
  'task_name', 'task_status', 'task_due', 'task_overdue',
  'assignee_email', 'assigned_group',
  'created_at', 'updated_at',
  'events_total', 'first_event_at', 'last_event_at', 'performers',
  'run_id'
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function runUserTaskSnapshot() {
  var runId = new Date().toISOString();
  log_('run start ' + runId);

  var bundle = fetchBundle_(); // { users, requests, events, fetchedAt }

  // Pure derivations.
  var byUser   = aggregateByUser_(bundle.events);
  var byRecord = aggregateByRecord_(bundle.events);
  var recon    = reconcileRecords_(bundle.requests, byRecord); // table x fold
  var kinds    = countBy_(bundle.events, function (e) { return e.kind; });
  var stages   = countBy_(recon, function (r) { return r.table_stage || r.derived_stage || '(blank)'; });

  var recs = buildUserJoin_(bundle, byUser, runId);
  recs.forEach(function (r) {
    r.bucket = classify_(r);
    // The hottest chase cases: open work assigned to someone who is silent.
    if (r.open_assignments > 0 && (r.bucket === 'NEVER_LOGGED_IN' || r.bucket === 'NO_ACTIVITY')) {
      r.flags.push('has_open_assignment');
    }
  });

  writeSheets_(recs, recon, kinds, stages, runId, bundle);

  log_('run complete: ' + recs.length + ' users, ' + recon.length + ' records');
  return recs.length;
}

// ---------------------------------------------------------------------------
// The single impure stage: POST API-006, loop the events cursor.
// Users and requests come complete on every page; page 1's copies are kept.
// Truncation sentinels abort loudly — partial roster/table poisons everything.
// ---------------------------------------------------------------------------

function fetchBundle_() {
  var endpoint  = cfg_('API006_ENDPOINT', true);
  var token     = cfg_('WFA_API_TOKEN', true);
  var startDate = cfg_('PROJECT_START_DATE', true);

  var rawUsers = null;
  var rawRequests = null;
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
    // Wire body is the schema fields directly; accept the test-harness wrapping too.
    var r = (body && body.response && typeof body.response === 'object' && 'ok' in body.response)
      ? body.response : body;

    if (r.ok !== true) {
      throw new Error('API-006 reported not-ok: ' + (r.error_message || JSON.stringify(r).slice(0, 300)));
    }
    if (r.users_truncated_token) {
      throw new Error('ROSTER TRUNCATED: >500 portal users (users_truncated_token set). ' +
                      'Aborting — split users into a paginated endpoint (option A).');
    }
    if (r.requests_truncated_token) {
      throw new Error('REQUESTS TRUNCATED: >200 requests (requests_truncated_token set — ' +
                      'search_requests max page is 200). Aborting — the reconciliation would ' +
                      'misreport table-missing records as DERIVED_ONLY.');
    }
    if (!('activity_records' in r)) {
      throw new Error('Contract mismatch: no "activity_records" key. Keys: ' + Object.keys(r).join(', '));
    }
    if (rawUsers === null) {
      if (!('users' in r)) {
        throw new Error('Contract mismatch: no "users" key on first page. Keys: ' + Object.keys(r).join(', '));
      }
      rawUsers = r.users || [];
      rawRequests = r.requests || []; // same page-1 semantics
    }

    Array.prototype.push.apply(rawEvents, r.activity_records || []);
    pageToken = r.continuation_token || null;
    pages++;
    if (pages > 50) throw new Error('Pagination runaway: >50 pages; aborting.');
  } while (pageToken);

  // Normalize the roster.
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

  // Normalize the requests table.
  var requests = rawRequests
    .filter(function (q) { return q && q.record_id; })
    .map(function (q) {
      var t = q.active_task && (q.active_task.task_id || q.active_task.task_name) ? q.active_task : null;
      var au = t && t.assigned_user && t.assigned_user.user_email ? t.assigned_user : null;
      var ag = t && t.assigned_group && t.assigned_group.group_name ? t.assigned_group : null;
      return {
        record_id:  String(q.record_id),
        created_at: asIso_(q.created_at),
        updated_at: asIso_(q.updated_at),
        stage:      String(q.stage_name || '').trim(),
        task: t ? {
          name:   t.task_name || null,
          status: t.status || null,
          due:    asIso_(t.due_date),
          assignee_email: au ? normEmail_(au.user_email) : null,
          group_name:     ag ? ag.group_name : null
        } : null,
        context: q.context && typeof q.context === 'object' ? q.context : {}
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
        email:        email || null, // null => system/unattributed event
        user_status:  email ? String(pb.status || '').toLowerCase() : null,
        groupNames:   email ? (pb.groups || []).map(function (g) { return g.group_name; }) : [],
        stage:        e.workflow_stage ? String(e.workflow_stage.workflow_stage_name || '').trim() : ''
      };
    });

  log_('bundle: ' + users.length + ' users, ' + requests.length + ' requests, ' +
       events.length + ' events, ' + pages + ' page(s)');
  return { users: users, requests: requests, events: events, fetchedAt: new Date().toISOString() };
}

// Boundary normalizers.
function asIso_(v) {
  if (v instanceof Date) return v.toISOString();
  if (!v) return null;
  var s = String(v).replace(/\.(\d{3})\d+/, '.$1');
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

function aggregateByUser_(events) {
  var byUser = {};
  events.forEach(function (e) {
    if (!e.email) return;
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
      if (!a.lastAt || e.performed_at >= a.lastAt) {
        a.lastStatus = e.user_status;
        a.lastGroups = e.groupNames;
        a.lastAt = e.performed_at;
      }
    }
  });
  return byUser;
}

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
// Reconciliation: requests table (authoritative) x event fold (derived).
// One row per record_id, union of both sides, anomaly assigned per row.
// ---------------------------------------------------------------------------

function reconcileRecords_(requests, byRecord) {
  var tableById = {};
  requests.forEach(function (q) { tableById[q.record_id] = q; });

  var ids = {};
  requests.forEach(function (q) { ids[q.record_id] = true; });
  Object.keys(byRecord).forEach(function (k) { ids[k] = true; });

  var nowIso = new Date().toISOString();

  return Object.keys(ids).sort().map(function (id) {
    var q = tableById[id] || null;   // authoritative
    var d = byRecord[id] || null;    // derived

    var anomaly = '';
    if (q && !d) anomaly = 'EVENTS_MISSING';
    else if (!q && d) anomaly = 'DERIVED_ONLY';
    else if (q && d && d.stage && q.stage && q.stage !== d.stage) anomaly = 'STAGE_DRIFT';

    var stageForClass = q ? q.stage : (d ? d.stage : '');
    var overdue = !!(q && q.task && q.task.due && q.task.due < nowIso);

    return {
      record_id: id,
      anomaly: anomaly,
      table_stage:   q ? q.stage : '',
      derived_stage: d ? d.stage : '',
      stage_class: STAGE_CLASS[stageForClass] || 'unknown',
      task_name:   q && q.task ? q.task.name : '',
      task_status: q && q.task ? q.task.status : '',
      task_due:    q && q.task ? q.task.due : '',
      task_overdue: overdue ? 'TRUE' : '',
      assignee_email: q && q.task ? (q.task.assignee_email || '') : '',
      assigned_group: q && q.task ? (q.task.group_name || '') : '',
      created_at: q ? q.created_at : '',
      updated_at: q ? q.updated_at : '',
      events_total:   d ? d.events : 0,
      first_event_at: d ? d.first : '',
      last_event_at:  d ? d.last : '',
      performers: d ? Object.keys(d.performers).sort().join('; ') : '',
      context: q ? q.context : {}
    };
  });
}

// ---------------------------------------------------------------------------
// Pure stage: roster x activity x assignments join. One row per email.
// ---------------------------------------------------------------------------

function buildUserJoin_(bundle, byUser, runId) {
  var rosterByEmail = {};
  var dupEmails = {};
  bundle.users.forEach(function (u) {
    if (!u.email) return;
    if (rosterByEmail[u.email]) { dupEmails[u.email] = true; return; }
    rosterByEmail[u.email] = u;
  });

  // Open assignments per email, from the requests table's active tasks.
  var assignedCount = {};
  bundle.requests.forEach(function (q) {
    if (q.task && q.task.assignee_email) {
      assignedCount[q.task.assignee_email] = (assignedCount[q.task.assignee_email] || 0) + 1;
    }
  });

  var keys = {};
  Object.keys(rosterByEmail).forEach(function (k) { keys[k] = true; });
  Object.keys(byUser).forEach(function (k) { keys[k] = true; });
  Object.keys(assignedCount).forEach(function (k) { keys[k] = true; }); // assignee unknown to both sides => still a row

  return Object.keys(keys).sort().map(function (email) {
    var u = rosterByEmail[email] || null;
    var a = byUser[email] || null;
    var flags = [];

    if (dupEmails[email]) flags.push('duplicate_portal_email');
    if (u && a && a.lastStatus && u.status && a.lastStatus !== u.status) {
      flags.push('status_mismatch:roster=' + u.status + ',activity=' + a.lastStatus);
    }

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

      open_assignments: assignedCount[email] || 0,
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
// Classification. Ordered, first match wins, total. Buckets stay stable across
// versions (comparable between runs); assignment pressure surfaces via the
// open_assignments column and the has_open_assignment flag, not new buckets.
// ---------------------------------------------------------------------------

function classify_(r) {
  var hasRoster   = r.portal_user_id !== null || r.portal_status !== null;
  var hasActivity = r.activity_events > 0;

  if (!hasRoster && hasActivity) return 'GHOST_PERFORMER';
  if (hasRoster && !hasActivity) {
    return r.portal_status === 'invited' ? 'NEVER_LOGGED_IN' : 'NO_ACTIVITY';
  }
  if (!hasRoster && !hasActivity) return 'GHOST_PERFORMER'; // assignment-only rows: assignee unknown to roster AND feed
  if (r.completions > 0) {
    if (r.portal_status === 'invited') r.flags.push('completed_while_invited');
    return 'COMPLETED';
  }
  return 'ACTIVE_NO_COMPLETION';
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

function outputSpreadsheet_() {
  var id = cfg_('OUTPUT_SPREADSHEET_ID', false);
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (active) return active;
  throw new Error('No output target: set OUTPUT_SPREADSHEET_ID or bind the script to a spreadsheet.');
}

function writeSheets_(recs, recon, kinds, stages, runId, bundle) {
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
      r.open_assignments, r.activity_events, r.completions, r.kinds_seen,
      r.first_activity_at, r.last_activity_at, r.activity_status,
      r.snapshot_at, r.run_id
    ];
  }));
  join.getRange(1, 1, joinRows.length, JOIN_HEADERS.length).setValues(joinRows);
  join.setFrozenRows(1);

  // --- Records tab (reconciliation) ---
  var recSheet = ss.getSheetByName('Records') || ss.insertSheet('Records');
  recSheet.clearContents();

  // Dynamic context columns: union of keys across all rows, stable order.
  var ctxKeys = {};
  recon.forEach(function (r) {
    Object.keys(r.context || {}).forEach(function (k) { ctxKeys[k] = true; });
  });
  var ctxCols = Object.keys(ctxKeys).sort();
  var headers = RECORD_FIXED_HEADERS.slice(0, RECORD_FIXED_HEADERS.length - 1)
    .concat(ctxCols.map(function (k) { return 'ctx_' + k; }))
    .concat(['run_id']);

  var anomalyOrder = {};
  ANOMALY_ORDER.forEach(function (a, i) { anomalyOrder[a] = i; });
  recon.sort(function (a, b) { // anomalies first, then non-terminal, then most recent
    var d = (anomalyOrder[a.anomaly] !== undefined ? anomalyOrder[a.anomaly] : 99) -
            (anomalyOrder[b.anomaly] !== undefined ? anomalyOrder[b.anomaly] : 99);
    if (d !== 0) return d;
    var ta = a.stage_class.indexOf('terminal') === 0 ? 1 : 0;
    var tb = b.stage_class.indexOf('terminal') === 0 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return (b.last_event_at || b.updated_at || '') < (a.last_event_at || a.updated_at || '') ? -1 : 1;
  });

  var recordRows = [headers].concat(recon.map(function (r) {
    var fixed = [
      r.record_id, r.anomaly, r.table_stage, r.derived_stage, r.stage_class,
      r.task_name, r.task_status, r.task_due, r.task_overdue,
      r.assignee_email, r.assigned_group,
      r.created_at, r.updated_at,
      r.events_total, r.first_event_at, r.last_event_at, r.performers
    ];
    var ctx = ctxCols.map(function (k) {
      var v = (r.context || {})[k];
      return v === null || v === undefined ? '' :
             (typeof v === 'object' ? JSON.stringify(v) : v);
    });
    return fixed.concat(ctx).concat([runId]);
  }));
  recSheet.getRange(1, 1, recordRows.length, headers.length).setValues(recordRows);
  recSheet.setFrozenRows(1);

  // --- Summary tab ---
  var sum = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sum.clearContents();

  var rows = [
    ['run_id',               runId, ''],
    ['snapshot_at',          bundle.fetchedAt, ''],
    ['project_start_date',   cfg_('PROJECT_START_DATE', true), ''],
    ['users_total',          bundle.users.length, ''],
    ['requests_total',       bundle.requests.length, ''],
    ['activity_events_total', bundle.events.length, ''],
    ['records_reconciled',   recon.length, ''],
    ['join_records_total',   recs.length, ''],
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
  rows.push(['record anomaly', 'count', '']);
  ['STAGE_DRIFT', 'EVENTS_MISSING', 'DERIVED_ONLY'].forEach(function (a) {
    rows.push([a, '=COUNTIF(Records!$B:$B,"' + a + '")', '']);
  });
  rows.push(['task_overdue', '=COUNTIF(Records!$I:$I,"TRUE")', '']);

  rows.push(['', '', '']);
  rows.push(['kind (inventory — tune COMPLETION_KINDS from this)', 'count', '']);
  Object.keys(kinds).sort().forEach(function (k) { rows.push([k, kinds[k], '']); });

  rows.push(['', '', '']);
  rows.push(['stage (inventory — tune STAGE_CLASS from this)', 'records', '']);
  Object.keys(stages).sort().forEach(function (s) { rows.push([s, stages[s], '']); });

  sum.getRange(1, 1, rows.length, 3).setValues(rows);
}

// ---------------------------------------------------------------------------
// One-time setup: conditional formatting — Join bucket column (C) and
// Records anomaly column (B). Run once by hand.
// ---------------------------------------------------------------------------

function setupJoinFormatting() {
  var ss = outputSpreadsheet_();

  var join = ss.getSheetByName('Join') || ss.insertSheet('Join');
  var bucketColors = {
    'GHOST_PERFORMER':      '#f4cccc',
    'NEVER_LOGGED_IN':      '#f4cccc',
    'NO_ACTIVITY':          '#fce5cd',
    'ACTIVE_NO_COMPLETION': '#fce5cd',
    'COMPLETED':            '#d9ead3'
  };
  join.setConditionalFormatRules(Object.keys(bucketColors).map(function (b) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(b).setBackground(bucketColors[b])
      .setRanges([join.getRange('C2:C')]).build();
  }));

  var recSheet = ss.getSheetByName('Records') || ss.insertSheet('Records');
  var anomalyColors = {
    'STAGE_DRIFT':    '#f4cccc',
    'EVENTS_MISSING': '#fce5cd',
    'DERIVED_ONLY':   '#fce5cd'
  };
  recSheet.setConditionalFormatRules(Object.keys(anomalyColors).map(function (a) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(a).setBackground(anomalyColors[a])
      .setRanges([recSheet.getRange('B2:B')]).build();
  }));
}
