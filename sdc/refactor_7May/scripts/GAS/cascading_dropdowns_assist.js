/**
 * Track 2 — cascade authoring assist  (Tables-aware)
 * SDC dropdown / cascade redesign
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 *   1. Stamps a self-validating dropdown on the "Parent value" column of every
 *      cascade child block, sourced from the parent lookup's own values, with
 *      invalid entries hard-rejected.
 *   2. Stamps a dropdown on the "Depends on" column of 4_fields (the existing
 *      lookup-name cell), so the parent list can only be a real lookup name.
 *   3. Surfaces a completeness counter in a sidebar: mapped / total per cascade
 *      list, "fill parent first" for empty parents, and a readiness verdict.
 *
 * GOOGLE SHEETS TABLES
 *   If 5_lookups is a native Sheets *Table* and "Parent value" is a TYPED
 *   column, per-cell validation is refused ("This operation is not allowed on
 *   cells in typed columns"). A typed column is column-UNIFORM and therefore
 *   cannot hold the per-row parent dropdowns a cascade needs — so the type must
 *   come OFF that column. Two ways:
 *     - Manual (guaranteed): click the "Parent value" column in the table and
 *       set its type to None / plain text. One-time.
 *     - Programmatic (best-effort): run untypeParentValueColumn(). Requires the
 *       Google Sheets API advanced service (Apps Script editor > Services + >
 *       Google Sheets API). Verify the column-type behaviour against the current
 *       Table reference if Google changes it:
 *       https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets#table
 *   Run checkLookupTableTyping() first to see which columns are typed.
 *   The field-side "Depends on" column is column-uniform, so it MAY stay a
 *   native typed dropdown column; it does not have to be untyped.
 *
 * WHY IT CANNOT BREAK SERIALIZATION OR FIGHT sdc_lib
 *   - Validations, notes, the sidebar, and column TYPE are metadata / UI, not
 *     cell values. Drive.serializeConfig reads getValues() — none of this
 *     reaches the JSON the connector parses.
 *   - It reads / writes BY HEADER NAME (Track 1 helpers), never by index.
 *   - It defines NO reserved onOpen/onEdit; it installs its own *installable*
 *     triggers with unique names, so it coexists with sdc_lib's handlers.
 *
 * DEPENDENCY
 *   Reuses Track 1 (sdc_track1_lookup_migration.gs): SDC_MIG,
 *   buildFieldCascadeMap_, verifyLookupParents, findHeaderRow_, headerMap_, trim_.
 *   Both files must live in the same Apps Script project.
 *
 * SETUP (once)
 *   Run installSdcTrack2Triggers().  Or call sdcTrack2Menu() from sdc_lib's
 *   onOpen and sdcTrack2OnEdit(e) from sdc_lib's onEdit.
 */

function assertTrack1_() {
  if (typeof SDC_MIG === 'undefined' ||
      typeof buildFieldCascadeMap_ !== 'function' ||
      typeof verifyLookupParents !== 'function' ||
      typeof findHeaderRow_ !== 'function' ||
      typeof headerMap_ !== 'function' ||
      typeof trim_ !== 'function') {
    throw new Error('Track 2 needs the Track 1 file (sdc_track1_lookup_migration.gs) ' +
      'in the same Apps Script project — it reuses SDC_MIG, buildFieldCascadeMap_, ' +
      'verifyLookupParents, and the header helpers.');
  }
}

function assertSheetsAdvanced_() {
  if (typeof Sheets === 'undefined') {
    throw new Error('Enable the Google Sheets API advanced service: Apps Script editor > ' +
      'Services (+) > Google Sheets API > Add. Then re-run.');
  }
}

function isTypedColumnError_(err) {
  return String((err && err.message) || err).indexOf('typed columns') !== -1;
}

// --- Stamping ---------------------------------------------------------------

/** Public entry: stamp both the field-side and item-side dropdowns. */
function stampCascadeDropdowns(opts) {
  assertTrack1_();
  opts = opts || {};
  var ss = opts.ss || SpreadsheetApp.getActive();
  var item = stampParentDropdowns_(ss);
  var field = stampDependsOnDropdown_(ss);
  var summary = { parentDropdowns: item, dependsOnDropdown: field };
  Logger.log('stampCascadeDropdowns: ' + JSON.stringify(summary));
  try {
    var blockedN = Object.keys(item.blocked).length;
    ss.toast('Stamped ' + item.stamped + ' parent cells' +
      (blockedN ? ' (' + blockedN + ' list(s) blocked: fill parent first)' : ''),
      'SDC cascade', 5);
  } catch (e) {}
  return summary;
}

/** Item-side: dropdown on 5_lookups "Parent value", per cascade block. */
function stampParentDropdowns_(ss) {
  var childToParent = buildFieldCascadeMap_(ss).map;
  var sheet = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  if (!sheet) throw new Error('Sheet not found: ' + SDC_MIG.LOOKUPS_SHEET);

  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.table, H.value, H.parent]);
  if (hr === -1) throw new Error('Could not find the 5_lookups header row.');
  var hm = headerMap_(values[hr]);
  var cTable = hm[H.table], cValue = hm[H.value], cParent = hm[H.parent];

  var dataStart = hr + 1;
  var dataRows = values.length - dataStart;
  if (dataRows <= 0) return { stamped: 0, cleared: 0, blocked: {} };

  // ordered, de-duped value list per lookup (a parent's selectable values)
  var valueList = {}, seen = {};
  for (var r = dataStart; r < values.length; r++) {
    var ln = trim_(values[r][cTable]); if (!ln) continue;
    var v = trim_(values[r][cValue]); if (!v) continue;
    if (!valueList[ln]) { valueList[ln] = []; seen[ln] = {}; }
    if (!seen[ln][v]) { seen[ln][v] = true; valueList[ln].push(v); }
  }

  // one DataValidation per parent lookup, reused across that lookup's children
  var dvCache = {};
  function dvFor_(parentLookup) {
    if (parentLookup in dvCache) return dvCache[parentLookup];
    var list = valueList[parentLookup] || [];
    var dv = null;
    if (list.length > 0) {
      dv = SpreadsheetApp.newDataValidation()
        .requireValueInList(list, true)   // show the dropdown
        .setAllowInvalid(false)           // reject anything off-list (typed or pasted)
        .setHelpText('Pick a value from the "' + parentLookup + '" list.')
        .build();
    }
    dvCache[parentLookup] = dv;           // null = parent list still empty
    return dv;
  }

  var range = sheet.getRange(dataStart + 1, cParent + 1, dataRows, 1);
  var notes = range.getNotes();           // preserve notes on non-child cells
  var dvs = [];
  var stamped = 0, cleared = 0, blocked = {};

  for (var r2 = dataStart; r2 < values.length; r2++) {
    var i = r2 - dataStart;
    var ln2 = trim_(values[r2][cTable]);
    if (ln2 && childToParent[ln2]) {
      var pl = childToParent[ln2];
      var dv = dvFor_(pl);
      if (dv) {
        dvs.push([dv]); stamped++;
        notes[i][0] = '';                                 // clear stale hint
      } else {
        dvs.push([null]);                                 // empty parent: no dropdown
        notes[i][0] = 'Fill the "' + pl + '" list before mapping this row.';
        blocked[ln2] = pl;
      }
    } else {
      dvs.push([null]);                                   // root / flat: clear validation
      cleared++;                                          // leave its note untouched
    }
  }

  // Tables: a typed "Parent value" column refuses per-cell validation. Translate
  // the raw error into the actual fix instead of letting it bubble up opaque.
  try {
    range.setDataValidations(dvs);
  } catch (err) {
    if (isTypedColumnError_(err)) {
      throw new Error('"Parent value" is a typed Table column, so per-cell dropdowns are refused. ' +
        'Run untypeParentValueColumn() (or set the column type to None/Text in the table), then re-run. ' +
        'A typed column is column-uniform and cannot hold the per-row parent dropdowns a cascade needs.');
    }
    throw err;
  }
  // Notes may also be blocked on typed columns; the sidebar carries the same
  // "fill parent first" signal, so a note failure is non-fatal.
  try { range.setNotes(notes); } catch (e) {}

  return { stamped: stamped, cleared: cleared, blocked: blocked };
}

/** Field-side: dropdown on 4_fields "Depends on" = the set of lookup names. */
function stampDependsOnDropdown_(ss) {
  var fields = ss.getSheetByName(SDC_MIG.FIELDS_SHEET);
  if (!fields) throw new Error('Sheet not found: ' + SDC_MIG.FIELDS_SHEET);
  var fv = fields.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var fhr = findHeaderRow_(fv, [H.fieldLookup, H.fieldDependsOn]);
  if (fhr === -1) return { stamped: 0, reason: 'no 4_fields header' };
  var cDep = headerMap_(fv[fhr])[H.fieldDependsOn];

  var lk = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  var lv = lk.getDataRange().getValues();
  var lhr = findHeaderRow_(lv, [H.table, H.value, H.parent]);
  var cTable = headerMap_(lv[lhr])[H.table];

  var names = [], seen = {};
  for (var r = lhr + 1; r < lv.length; r++) {
    var n = trim_(lv[r][cTable]);
    if (n && !seen[n]) { seen[n] = true; names.push(n); }
  }
  if (!names.length) return { stamped: 0, reason: 'no lookup names' };

  var dv = SpreadsheetApp.newDataValidation()
    .requireValueInList(names, true)
    .setAllowInvalid(false)
    .setHelpText('Pick the parent list this field cascades from (blank = flat).')
    .build();

  var fStart = fhr + 1;
  var n2 = fv.length - fStart;
  if (n2 <= 0) return { stamped: 0 };
  var col = [];
  for (var i = 0; i < n2; i++) col.push([dv]);            // blank stays valid; off-list rejected

  try {
    fields.getRange(fStart + 1, cDep + 1, n2, 1).setDataValidations(col);
  } catch (err) {
    if (isTypedColumnError_(err)) {
      // "Depends on" is column-uniform: a native typed dropdown is acceptable here.
      return { stamped: 0, reason: '"Depends on" is a typed Table column. Either keep it as a native ' +
        'dropdown column (set its options in the table), or untype it: ' +
        'untypeTableColumn_("' + SDC_MIG.FIELDS_SHEET + '", "' + SDC_MIG.HEADERS.fieldDependsOn + '").' };
    }
    throw err;
  }
  return { stamped: n2 };
}

// --- Tables: diagnose + untype (Advanced Sheets Service) --------------------

/** Read-only: which columns on 5_lookups / 4_fields are typed Table columns. */
function checkLookupTableTyping() {
  assertTrack1_();
  assertSheetsAdvanced_();
  var ss = SpreadsheetApp.getActive();
  var meta = Sheets.Spreadsheets.get(ss.getId(), { fields: 'sheets.properties,sheets.tables' });

  var report = [];
  (meta.sheets || []).forEach(function (s) {
    var title = s.properties.title;
    if (title !== SDC_MIG.LOOKUPS_SHEET && title !== SDC_MIG.FIELDS_SHEET) return;
    if (!s.tables || !s.tables.length) {
      report.push({ sheet: title, table: null, note: 'plain range (no table) — per-cell validation OK' });
      return;
    }
    s.tables.forEach(function (t) {
      var cols = (t.columnProperties || []).map(function (c) {
        return { name: c.columnName, type: c.columnType || '(none)' };
      });
      report.push({ sheet: title, table: t.name, tableId: t.tableId, typedColumns: cols });
    });
  });

  var parentTyped = false;
  report.forEach(function (r) {
    (r.typedColumns || []).forEach(function (c) {
      if (r.sheet === SDC_MIG.LOOKUPS_SHEET &&
          c.name === SDC_MIG.HEADERS.parent && c.type !== '(none)') parentTyped = true;
    });
  });

  var out = { report: report, parentValueTyped: parentTyped };
  Logger.log('checkLookupTableTyping: ' + JSON.stringify(out, null, 2));
  try {
    ss.toast(parentTyped
      ? 'Parent value is a TYPED column — run untypeParentValueColumn().'
      : 'Parent value is not typed — stamping should work.', 'SDC cascade', 6);
  } catch (e) {}
  return out;
}

/** Remove the column type from 5_lookups "Parent value" so per-cell DV is allowed. */
function untypeParentValueColumn() {
  assertTrack1_();
  var r = untypeTableColumn_(SDC_MIG.LOOKUPS_SHEET, SDC_MIG.HEADERS.parent);
  Logger.log('untypeParentValueColumn: ' + JSON.stringify(r));
  try {
    SpreadsheetApp.getActive().toast(
      r.changed ? ('Removed type "' + r.removedType + '" from Parent value.') : r.reason,
      'SDC cascade', 6);
  } catch (e) {}
  return r;
}

/**
 * Best-effort: drop the type assignment for one column of a Sheets Table by
 * rewriting the table's columnProperties without that column's entry.
 * Requires the Sheets advanced service. If the API rejects this or the type
 * persists, use the manual route (set the column type to None/Text in the UI).
 */
function untypeTableColumn_(sheetName, headerName) {
  assertSheetsAdvanced_();
  var ss = SpreadsheetApp.getActive();
  var ssId = ss.getId();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  var sheetId = sheet.getSheetId();

  var meta = Sheets.Spreadsheets.get(ssId, { fields: 'sheets.properties,sheets.tables' });
  var table = null;
  (meta.sheets || []).forEach(function (s) {
    if (s.properties.sheetId === sheetId && s.tables) {
      s.tables.forEach(function (t) { if (!table) table = t; });   // assume one table on the sheet
    }
  });
  if (!table) return { changed: false, reason: 'no table on ' + sheetName + ' (plain range — nothing to untype)' };

  var props = table.columnProperties || [];
  var target = -1;
  for (var i = 0; i < props.length; i++) {
    if (trim_(props[i].columnName) === headerName) { target = i; break; }
  }
  if (target === -1) {
    return { changed: false, reason: '"' + headerName + '" carries no column type (already untyped)' };
  }
  if (!props[target].columnType || props[target].columnType === 'COLUMN_TYPE_UNSPECIFIED') {
    return { changed: false, reason: '"' + headerName + '" is already untyped' };
  }

  var removedType = props[target].columnType;
  var kept = props.filter(function (_, idx) { return idx !== target; });   // drop the typed entry

  Sheets.Spreadsheets.batchUpdate({
    requests: [{
      updateTable: {
        table: { tableId: table.tableId, columnProperties: kept },
        fields: 'columnProperties'
      }
    }]
  }, ssId);

  return { changed: true, sheet: sheetName, column: headerName, removedType: removedType };
}

// --- Completeness (the sidebar data) ----------------------------------------

/** Per-cascade mapped/total + parent-empty + readiness. Reuses verifyLookupParents. */
function getTrack2Status(opts) {
  assertTrack1_();
  opts = opts || {};
  var ss = opts.ss || SpreadsheetApp.getActive();

  var v = verifyLookupParents({ ss: ss });               // {perLookup, badParentValues, ready}
  var childToParent = buildFieldCascadeMap_(ss).map;

  var sheet = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.table, H.value, H.parent]);
  var hm = headerMap_(values[hr]);
  var cTable = hm[H.table], cValue = hm[H.value];
  var sizes = {};
  for (var r = hr + 1; r < values.length; r++) {
    var ln = trim_(values[r][cTable]); if (!ln) continue;
    if (trim_(values[r][cValue])) sizes[ln] = (sizes[ln] || 0) + 1;
  }

  var rows = [];
  Object.keys(childToParent).sort().forEach(function (ln) {
    var pl = childToParent[ln];
    var s = v.perLookup[ln] || { total: 0, mapped: 0, unmapped: 0 };
    rows.push({
      lookup: ln, parent: pl,
      total: s.total, mapped: s.mapped, unmapped: s.unmapped,
      parentEmpty: !(sizes[pl] > 0)
    });
  });

  var ready = v.ready && rows.every(function (x) { return !x.parentEmpty; });
  return { rows: rows, ready: ready, badParentValues: v.badParentValues || [] };
}

// --- Sidebar ----------------------------------------------------------------

function showTrack2Sidebar() {
  assertTrack1_();
  var html = HtmlService.createHtmlOutput(track2SidebarHtml_())
    .setTitle('Cascade completeness')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

function track2SidebarHtml_() {
  return [
'<!DOCTYPE html><html><head><base target="_top"><style>',
'  body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#202124;margin:0;padding:12px;}',
'  h3{font-size:14px;margin:0 0 8px;font-weight:500;}',
'  .banner{padding:8px 10px;border-radius:6px;margin-bottom:12px;font-size:13px;}',
'  .ok{background:#e6f4ea;color:#137333;} .warn{background:#fef7e0;color:#b06000;}',
'  .row{border:1px solid #e0e0e0;border-radius:6px;padding:8px 10px;margin-bottom:8px;}',
'  .name{font-weight:500;} .sub{color:#5f6368;font-size:12px;margin-top:2px;}',
'  .bar{height:6px;background:#e8eaed;border-radius:3px;margin-top:6px;overflow:hidden;}',
'  .fill{height:6px;background:#1a73e8;} .fill.full{background:#137333;}',
'  .flag{color:#b06000;font-size:12px;margin-top:4px;} .bad{color:#c5221f;font-size:12px;margin-top:4px;}',
'  button{font-size:13px;padding:6px 10px;border:1px solid #dadce0;background:#fff;border-radius:6px;cursor:pointer;margin-right:6px;}',
'  button:hover{background:#f1f3f4;} .muted{color:#5f6368;font-size:12px;}',
'</style></head><body>',
'  <h3>Cascade completeness</h3>',
'  <div id="banner" class="banner muted">Loading…</div>',
'  <div id="list"></div>',
'  <div style="margin-top:10px;">',
'    <button onclick="refresh()">Refresh</button>',
'    <button onclick="restamp()">Re-stamp dropdowns</button>',
'  </div>',
'<script>',
'  function refresh(){ document.getElementById("banner").textContent="Loading…";',
'    google.script.run.withSuccessHandler(render).withFailureHandler(fail).getTrack2Status(); }',
'  function restamp(){ document.getElementById("banner").textContent="Stamping…";',
'    google.script.run.withSuccessHandler(refresh).withFailureHandler(fail).stampCascadeDropdowns(); }',
'  function fail(e){ document.getElementById("banner").className="banner warn";',
'    document.getElementById("banner").textContent=String(e&&e.message||e); }',
'  function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}',
'  function render(st){',
'    var b=document.getElementById("banner");',
'    if(st.ready){ b.className="banner ok"; b.textContent="Ready to provision — every cascade is complete."; }',
'    else { b.className="banner warn"; b.textContent="Not ready — some cascades are incomplete."; }',
'    var html="";',
'    st.rows.forEach(function(r){',
'      var pct = r.total ? Math.round(100*r.mapped/r.total) : 0;',
'      html += "<div class=\\"row\\"><div class=\\"name\\">"+esc(r.lookup)+"</div>";',
'      html += "<div class=\\"sub\\">cascades from "+esc(r.parent)+" \\u00b7 "+r.mapped+" / "+r.total+" mapped</div>";',
'      if(r.parentEmpty){ html += "<div class=\\"flag\\">fill the \\""+esc(r.parent)+"\\" list first</div>"; }',
'      else { html += "<div class=\\"bar\\"><div class=\\"fill"+(pct===100?" full":"")+"\\" style=\\"width:"+pct+"%\\"></div></div>"; }',
'      if(r.unmapped>0 && !r.parentEmpty){ html += "<div class=\\"flag\\">"+r.unmapped+" row(s) without a parent</div>"; }',
'      html += "</div>";',
'    });',
'    if(st.badParentValues && st.badParentValues.length){',
'      html += "<div class=\\"row\\"><div class=\\"name\\">Off-list parent values</div>";',
'      st.badParentValues.slice(0,8).forEach(function(x){',
'        html += "<div class=\\"bad\\">"+esc(x.lookup)+" row "+x.row+": \\""+esc(x.value)+"\\" not in "+esc(x.parent)+"</div>"; });',
'      html += "</div>";',
'    }',
'    document.getElementById("list").innerHTML = html || "<div class=\\"muted\\">No cascades declared.</div>";',
'  }',
'  refresh();',
'</script></body></html>'
  ].join('\n');
}

// --- Menu + installable triggers (coexist with sdc_lib) ---------------------

function sdcTrack2Menu() {
  SpreadsheetApp.getUi()
    .createMenu('SDC cascade')
    .addItem('Stamp dropdowns', 'stampCascadeDropdowns')
    .addItem('Show completeness', 'showTrack2Sidebar')
    .addSeparator()
    .addItem('Check table typing', 'checkLookupTableTyping')
    .addItem('Remove Parent value column type', 'untypeParentValueColumn')
    .addToUi();
}

function sdcTrack2OnOpen(e) { sdcTrack2Menu(); }

function sdcTrack2OnEdit(e) {
  if (!e || !e.range) return;
  var name = e.range.getSheet().getName();
  if (name !== SDC_MIG.LOOKUPS_SHEET && name !== SDC_MIG.FIELDS_SHEET) return;
  // skip when the analyst is just picking a parent value (edit confined to that column)
  if (name === SDC_MIG.LOOKUPS_SHEET && isParentColumnEdit_(e)) return;
  stampCascadeDropdowns({ ss: e.source });
}

/** True if the edit is confined to the 5_lookups "Parent value" column. */
function isParentColumnEdit_(e) {
  try {
    var sheet = e.source.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
    var probe = sheet.getRange(1, 1, Math.min(12, sheet.getLastRow()), sheet.getLastColumn()).getValues();
    var hr = findHeaderRow_(probe, [SDC_MIG.HEADERS.table, SDC_MIG.HEADERS.value, SDC_MIG.HEADERS.parent]);
    if (hr === -1) return false;
    var cParent = headerMap_(probe[hr])[SDC_MIG.HEADERS.parent];   // 0-based
    var startCol = e.range.getColumn();
    var endCol = startCol + e.range.getNumColumns() - 1;
    return (startCol === cParent + 1 && endCol === cParent + 1);
  } catch (err) { return false; }
}

/** One-time setup. Idempotent — removes any prior Track 2 triggers first. */
function installSdcTrack2Triggers() {
  assertTrack1_();
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sdcTrack2OnOpen' || fn === 'sdcTrack2OnEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sdcTrack2OnOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('sdcTrack2OnEdit').forSpreadsheet(ss).onEdit().create();
  ss.toast('Track 2 triggers installed (onOpen + onEdit).', 'SDC cascade', 5);
}
