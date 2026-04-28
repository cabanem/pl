/**
 * Trim measurement — Sheet writer + Drive snapshot persistence.
 *
 * Three sheets, three concerns:
 *   - "Trim Latest"     : per-recipe detail of the most recent run
 *   - "Trim Snapshots"  : append-only history log
 *   - "Trim Comparison" : output of the most recent comparison
 *
 * Full reports (with every per-recipe measurement) go to Drive as
 * canonical JSON, keyed by file id from the snapshots log.
 *
 * Depends on: trim_measurement.js, canonical_hash.js, recipe_sync.js
 */


const TRIM_LATEST_SHEET     = 'Trim Latest';
const TRIM_SNAPSHOTS_SHEET  = 'Trim Snapshots';
const TRIM_COMPARISON_SHEET = 'Trim Comparison';

const TRIM_LATEST_HEADERS = [
  'id', 'name', 'bytes_before', 'bytes_after',
  'reduction_pct', 'flag', 'trimmed_hash', 'profile_version'
];

const TRIM_SNAPSHOTS_HEADERS = [
  'run_at', 'profile_version', 'profile_hash', 'recipe_count',
  'bytes_before_total', 'bytes_after_total',
  'median_pct', 'p90_pct', 'p95_pct',
  'low_count', 'normal_count', 'high_count',
  'snapshot_file_id', 'snapshot_file'
];


/* -------------------------------------------------------------------------- */
/* Public entry points (wired in recipe_sync.js onOpen)                       */
/* -------------------------------------------------------------------------- */

/**
 * Refetches recipes from Workato API. Use only when fresh data is needed.
 * For routine tuning, use measureTrimFromDrive (defined in recipe_drive_cache.js).
 */
function measureTrimAndWrite() {
  const recipes = getStructuredRecipes({ includeCode: true });
  const report  = measureTrimDistribution(recipes);

  const file = saveTrimReportToDrive_(report);
  writeTrimLatestSheet_(report);
  appendTrimSnapshotRow_(report, file);

  SpreadsheetApp.getActive().toast(
    `Measured ${report.recipe_count} recipes — median ${report.reduction_pct.median}%`,
    'Trim measurement', 5
  );
}


function compareLastTwoTrimSnapshots() {
  const ids = readRecentSnapshotFileIds_(2);
  if (ids.length < 2) {
    SpreadsheetApp.getActive().toast(
      'Need at least two snapshots to compare. Run "Measure trim" twice.',
      'Trim comparison', 5
    );
    return;
  }

  const reportB = readTrimReportFromDrive_(ids[0]);   // most recent (after)
  const reportA = readTrimReportFromDrive_(ids[1]);   // older (before)
  const comparison = compareTrimReports(reportA, reportB);

  writeTrimComparisonSheet_(comparison);

  SpreadsheetApp.getActive().toast(
    `${reportA.profile_version} → ${reportB.profile_version}: ${comparison.recipes_changed.length} changed`,
    'Trim comparison', 5
  );
}


/* -------------------------------------------------------------------------- */
/* Sheet writers                                                              */
/* -------------------------------------------------------------------------- */

function writeTrimLatestSheet_(report) {
  const sheet = getOrCreateSheet_(TRIM_LATEST_SHEET);
  sheet.clear();
  sheet.getRange(1, 1, 1, TRIM_LATEST_HEADERS.length)
       .setValues([TRIM_LATEST_HEADERS])
       .setFontWeight('bold');

  const rows = report.measurements.map(function (m) {
    return [
      m.id, m.name, m.bytes_before, m.bytes_after,
      m.reduction_pct, m.flag, m.trimmed_hash, m.profile_version
    ];
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, TRIM_LATEST_HEADERS.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, TRIM_LATEST_HEADERS.length);
}


function appendTrimSnapshotRow_(report, file) {
  const sheet = getOrCreateSheet_(TRIM_SNAPSHOTS_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, TRIM_SNAPSHOTS_HEADERS.length)
         .setValues([TRIM_SNAPSHOTS_HEADERS])
         .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  sheet.appendRow([
    report.measured_at,
    report.profile_version,
    report.profile_hash,
    report.recipe_count,
    report.bytes_before_total,
    report.bytes_after_total,
    report.reduction_pct.median,
    report.reduction_pct.p90,
    report.reduction_pct.p95,
    report.flag_counts.low_reduction,
    report.flag_counts.normal,
    report.flag_counts.high_reduction,
    file.getId(),
    `=HYPERLINK("${file.getUrl()}","${file.getName()}")`
  ]);
}


function writeTrimComparisonSheet_(comparison) {
  const sheet = getOrCreateSheet_(TRIM_COMPARISON_SHEET);
  sheet.clear();

  let row = 1;

  sheet.getRange(row, 1)
       .setValue(`Comparison: ${comparison.profile_a} → ${comparison.profile_b}`)
       .setFontWeight('bold').setFontSize(14);
  row += 2;

  sheet.getRange(row, 1).setValue('Distribution delta').setFontWeight('bold');
  row++;
  sheet.getRange(row, 1, 3, 2).setValues([
    ['median', comparison.distribution_delta.median],
    ['p90',    comparison.distribution_delta.p90],
    ['p95',    comparison.distribution_delta.p95]
  ]);
  row += 4;

  sheet.getRange(row, 1).setValue('Flag count delta').setFontWeight('bold');
  row++;
  sheet.getRange(row, 1, 3, 2).setValues([
    ['low_reduction',  comparison.flag_count_delta.low_reduction],
    ['normal',         comparison.flag_count_delta.normal],
    ['high_reduction', comparison.flag_count_delta.high_reduction]
  ]);
  row += 4;

  sheet.getRange(row, 1)
       .setValue(`Recipes changed (${comparison.recipes_changed.length})`)
       .setFontWeight('bold');
  row++;
  const changedHeaders = [
    'id', 'name', 'reduction_before', 'reduction_after',
    'reduction_delta', 'flag_before', 'flag_after'
  ];
  sheet.getRange(row, 1, 1, changedHeaders.length)
       .setValues([changedHeaders]).setFontWeight('bold');
  row++;
  if (comparison.recipes_changed.length) {
    const changedRows = comparison.recipes_changed.map(function (c) {
      return [c.id, c.name, c.reduction_before, c.reduction_after,
              c.reduction_delta, c.flag_before, c.flag_after];
    });
    sheet.getRange(row, 1, changedRows.length, changedHeaders.length)
         .setValues(changedRows);
    row += changedRows.length;
  }
  row += 1;

  if (comparison.recipes_added.length) {
    sheet.getRange(row, 1)
         .setValue(`Recipes added (${comparison.recipes_added.length})`)
         .setFontWeight('bold');
    row++;
    const addedRows = comparison.recipes_added.map(function (r) { return [r.id, r.name]; });
    sheet.getRange(row, 1, addedRows.length, 2).setValues(addedRows);
    row += addedRows.length + 1;
  }

  if (comparison.recipes_removed.length) {
    sheet.getRange(row, 1)
         .setValue(`Recipes removed (${comparison.recipes_removed.length})`)
         .setFontWeight('bold');
    row++;
    const removedRows = comparison.recipes_removed.map(function (r) { return [r.id, r.name]; });
    sheet.getRange(row, 1, removedRows.length, 2).setValues(removedRows);
  }

  sheet.autoResizeColumns(1, changedHeaders.length);
}


/* -------------------------------------------------------------------------- */
/* Drive persistence                                                          */
/* -------------------------------------------------------------------------- */

function saveTrimReportToDrive_(report) {
  const folder   = getTrimDriveFolder_();
  const safeTs   = report.measured_at.replace(/[:.]/g, '-');
  const filename = `trim_snapshot_v${report.profile_version}_${safeTs}.json`;
  return folder.createFile(filename, canonicalJson(report), MimeType.PLAIN_TEXT);
}

function readTrimReportFromDrive_(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob().getDataAsString();
  return JSON.parse(blob);
}

function readRecentSnapshotFileIds_(n) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TRIM_SNAPSHOTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const fileIdCol = TRIM_SNAPSHOTS_HEADERS.indexOf('snapshot_file_id') + 1;
  const lastRow   = sheet.getLastRow();
  const startRow  = Math.max(2, lastRow - n + 1);
  const numRows   = lastRow - startRow + 1;

  const ids = sheet.getRange(startRow, fileIdCol, numRows, 1).getValues()
                   .map(function (r) { return r[0]; })
                   .filter(function (v) { return !!v; });
  return ids.reverse();
}


/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getTrimDriveFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TRIM_DRIVE_FOLDER_ID')
          || props.getProperty('RECIPE_DRIVE_FOLDER_ID');
  if (!id) {
    throw new Error('Set TRIM_DRIVE_FOLDER_ID or RECIPE_DRIVE_FOLDER_ID in Script Properties.');
  }
  return DriveApp.getFolderById(id);
}

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
