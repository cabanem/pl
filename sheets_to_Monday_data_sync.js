/**
 * @file SheetsToMondayWriteback.gs
 *
 * {@link https://docs.google.com/document/d/1RfAp0Z39UGlQ2odb9Osw9ZjljYqn5EZqDyhyd7qc6AI/edit?tab=t.vv5lu3a9s9fx README}
 *
 * Group-swap writeback: Google Sheets → Monday.com.
 *
 * On each run: stage source data, validate against the Monday board schema,
 * create a new timestamped group, ingest rows into it via the bulk ingest API,
 * then archive prior writeback groups on success. A weekly reaper hard-deletes
 * archived groups older than the configured retention window.
 *
 * Legacy single-execution truncate-and-rewrite (runWritebackLegacy) is preserved
 * for small-job manual runs only and is not on the scheduled path.
 *
 * Configured via the local "Configuration" tab; see README link above.
 */


// =============================================================================
// APP CONSTANTS
// =============================================================================

const APP = Object.freeze({
  SHEETS:   { AUDIT: '.audit_log' },
  RUNTIME:  { LOG_FLUSH_SIZE: 10 },
  DEFAULTS: { MONDAY_URL: 'https://api.monday.com/v2', MONDAY_API_VERSION: '2025-10' }
});

const EXECUTION_ID = Utilities.getUuid();
const MEMORY = { logBuffer: [] };


// =============================================================================
// MENU & SCHEDULING
// =============================================================================

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Sheets to Monday writeback')
      .addItem('Execute a dry run (validate and preview)', 'runDryRun')
      .addItem('Run writeback (group-swap)', 'runWritebackGroupSwap')
      .addItem('Resume pending group-swap', 'resumePendingGroupSwap')
      .addSeparator()
      .addItem('Run writeback (legacy — small jobs only)', 'runWritebackLegacy')
      .addToUi();
  } catch (_) {}
}

/**
 * Entry point for time-driven triggers. Do not call from the menu.
 * Wraps the production pipeline with headless-safe error handling.
 */
function runWritebackScheduled() {
  const startedAt = new Date();
  logToAuditSheet('INFO', `Scheduled run starting at ${startedAt.toISOString()}.`, 'runWritebackScheduled');

  try {
    runWritebackGroupSwap();
  } catch (e) {
    logToAuditSheet('ERROR', `Unhandled scheduled execution failure: ${e.message}`, 'runWritebackScheduled', true);
    try {
      const config = getAppConfig_();
      sendAlertEmail_(config, 'Scheduled writeback failed',
        `Execution ID: ${EXECUTION_ID}\nError: ${e.message}\nStack: ${e.stack || '(none)'}`);
    } catch (_) {
      MailApp.sendEmail({
        to: Session.getEffectiveUser().getEmail(),
        subject: '[Monday Sync] Scheduled run could not start.',
        body: `Error: ${e.message}`
      });
    }
  }
}

/**
 * Run manually from the editor to install (or re-install) the schedule.
 * Re-running is safe: existing triggers for the same handler are removed first.
 */
function installSchedule() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runWritebackScheduled')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const trigger_cadence = 'weekly';
  const trigger_day = 'Friday';
  const trigger_hour = 0;
  const trigger_tz = Session.getScriptTimeZone();

  ScriptApp.newTrigger('runWritebackScheduled')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(trigger_hour)
    .create();

  logToAuditSheet('INFO',
    `Schedule installed: ${trigger_cadence} on ${trigger_day} at ${trigger_hour}:00 (${trigger_tz}).`,
    'installSchedule', true);
}


// =============================================================================
// PRODUCTION PIPELINE (group-swap)
// =============================================================================

function runWritebackGroupSwap() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    logToAuditSheet('WARN', 'Another writeback is already running. Aborting.', 'runWritebackGroupSwap', true);
    return;
  }

  let config;
  let newGroupId = null; // tracked for cleanup on failure
  try {
    config = getAppConfig_();
  } catch (e) {
    logToAuditSheet('ERROR', `Config load failed: ${e.message}`, 'runWritebackGroupSwap', true);
    lock.releaseLock();
    return;
  }

  const boardId = config.monday_board_id;
  const tag = `Target:${boardId} (group-swap)`;

  if (!boardId) {
    logToAuditSheet('ERROR', 'Missing monday_board_id.', tag, true);
    sendAlertEmail_(config, 'Group-swap writeback failed', 'Missing monday_board_id.');
    lock.releaseLock();
    return;
  }

  try {
    logToAuditSheet('INFO', 'Starting group-swap writeback.', tag);

    // --- Step 1: Validate schema and stage data ---
    const mondaySchema = getMondaySchema_(boardId);
    const data = stageIncumbentData_(config);
    if (!data || data.length <= 1) {
      logToAuditSheet('WARN', 'No data in incumbent. Skipping.', tag, true);
      return;
    }

    const validation = validateHeaders_(data[0], mondaySchema, config, tag);
    if (validation.missing.length > 0) {
      const errorMsg = `Schema mismatch. Sheet columns missing in Monday:\n • ${validation.missing.join('\n • ')}`;
      sendAlertEmail_(config, 'Header validation failed', errorMsg);
      throw new Error(errorMsg);
    }

    // --- Step 2: Snapshot existing writeback groups BEFORE creating the new one ---
    // (Snapshot first so the new group doesn't accidentally land in the "to archive" list.)
    const oldGroupIds = listWritebackGroupIds_(config, boardId, tag);
    logToAuditSheet('INFO',
      `Snapshot found ${oldGroupIds.length} existing writeback group(s) to archive after success.`, tag);

    // --- Step 3: Create the new group ---
    const newGroupTitle = buildWritebackGroupTitle_(config);
    newGroupId = createGroup_(config, boardId, newGroupTitle, tag);
    logToAuditSheet('INFO', `Created new group "${newGroupTitle}" → ${newGroupId}`, tag);

    // --- Step 4: Build CSV and start ingest ---
    const csv = buildIngestCsv_(data, validation.mapping, mondaySchema);
    logToAuditSheet('INFO', `CSV built: ${data.length - 1} rows, ${csv.length} bytes.`, tag);

    // Match column is required by API but behaviorally a no-op since target group is empty.
    // SKIP is the honest choice here: pure insert, no surprises if anything matches.
    const matchColId = config.ingest_match_column_id || 'name';
    const jobInfo = startIngestJob_(config, boardId, newGroupId, 'SKIP', matchColId, tag);
    logToAuditSheet('INFO', `Ingest job started: ${jobInfo.job_id}`, tag);

    // --- Step 5: Upload CSV (10-minute window) ---
    uploadIngestCsv_(jobInfo.upload_url, csv, tag);
    logToAuditSheet('INFO', 'CSV uploaded. Polling for completion.', tag);

    // --- Step 6: Poll until terminal state ---
    const finalStatus = pollIngestJob_(config, jobInfo.job_id, tag);

    // --- Step 7: Branch on outcome ---
    if (finalStatus.state === 'COMPLETED' || finalStatus.state === 'SUCCESS') {
      // Success: archive (not delete) old groups. Trash gives 30-day undo regardless.
      let archived = 0;
      let archiveFailures = 0;
      for (const oldId of oldGroupIds) {
        try {
          archiveGroup_(config, boardId, oldId, tag);
          archived++;
        } catch (e) {
          archiveFailures++;
          logToAuditSheet('WARN', `Archive of old group ${oldId} failed: ${e.message}`, tag);
        }
      }
      logToAuditSheet('SUCCESS',
        `Group-swap complete: new=${newGroupId} ("${newGroupTitle}"), archived=${archived}/${oldGroupIds.length}.`,
        tag, true);
      sendAlertEmail_(config, 'Group-swap writeback completed',
        `Board: ${boardId}\nNew group: ${newGroupTitle} (${newGroupId})\nRows: ${data.length - 1}\n` +
        `Archived: ${archived}/${oldGroupIds.length}\n` +
        (archiveFailures > 0 ? `Archive failures: ${archiveFailures} (see audit log)\n` : '') +
        `\nFinal job status:\n${JSON.stringify(finalStatus, null, 2)}`);
      newGroupId = null; // success: clear the cleanup flag

    } else if (finalStatus.state === 'TIMEOUT_POLLING') {
      // Job continues on Monday's side. Don't archive old groups — we don't know if ingest succeeded.
      // Persist enough state for resumePendingGroupSwap to finish the swap.
      PropertiesService.getScriptProperties().setProperty('PENDING_GROUP_SWAP', JSON.stringify({
        jobId: jobInfo.job_id,
        newGroupId: newGroupId,
        oldGroupIds: oldGroupIds,
        boardId: boardId,
        startedAt: new Date().toISOString()
      }));
      logToAuditSheet('WARN',
        `Polling timed out: job ${jobInfo.job_id} may still be running. State preserved for resume.`,
        tag, true);
      sendAlertEmail_(config, 'Group-swap polling timeout',
        `Job ${jobInfo.job_id} did not complete within polling budget. ` +
        `New group ${newGroupId} exists; old groups not yet archived. ` +
        `Run resumePendingGroupSwap() to check status and finish the swap.`);
      newGroupId = null; // don't auto-delete on timeout — job may still succeed

    } else {
      throw new Error(`Ingest job failed with state ${finalStatus.state}: ${JSON.stringify(finalStatus)}`);
    }

  } catch (e) {
    logToAuditSheet('ERROR', `Group-swap writeback failed: ${e.message}\n${e.stack || ''}`, tag, true);

    // Cleanup: if we created a new group but didn't successfully ingest, delete it
    // so we don't leave half-populated junk behind.
    if (newGroupId) {
      try {
        deleteGroup_(config, boardId, newGroupId, tag);
        logToAuditSheet('INFO', `Cleaned up partially-populated group ${newGroupId}.`, tag);
      } catch (cleanupErr) {
        logToAuditSheet('WARN',
          `Cleanup of new group ${newGroupId} failed: ${cleanupErr.message}. Manual cleanup may be needed.`,
          tag, true);
      }
    }

    sendAlertEmail_(config, 'Group-swap writeback failed',
      `Execution ID: ${EXECUTION_ID}\nError: ${e.message}\nStack: ${e.stack || '(none)'}`);
  } finally {
    flushAuditLogs();
    lock.releaseLock();
  }
}

function resumePendingGroupSwap() {
  const raw = PropertiesService.getScriptProperties().getProperty('PENDING_GROUP_SWAP');
  if (!raw) {
    SpreadsheetApp.getUi().alert('No pending group-swap.');
    return;
  }
  const pending = JSON.parse(raw);
  const config = getAppConfig_();
  const tag = `Resume:${pending.jobId}`;

  logToAuditSheet('INFO',
    `Resuming pending group-swap: job=${pending.jobId} newGroup=${pending.newGroupId}.`, tag);

  try {
    const finalStatus = pollIngestJob_(config, pending.jobId, tag);

    if (finalStatus.state === 'COMPLETED' || finalStatus.state === 'SUCCESS') {
      // Ingest succeeded after all — finish the swap by archiving old groups.
      let archived = 0;
      for (const oldId of pending.oldGroupIds) {
        try {
          archiveGroup_(config, pending.boardId, oldId, tag);
          archived++;
        } catch (e) {
          logToAuditSheet('WARN', `Archive of ${oldId} failed: ${e.message}`, tag);
        }
      }
      PropertiesService.getScriptProperties().deleteProperty('PENDING_GROUP_SWAP');
      logToAuditSheet('SUCCESS',
        `Resumed group-swap complete: archived ${archived}/${pending.oldGroupIds.length}.`, tag, true);
      SpreadsheetApp.getUi().alert(`Resumed and completed. Archived ${archived} old group(s).`);

    } else if (finalStatus.state === 'TIMEOUT_POLLING') {
      logToAuditSheet('INFO', 'Resume still timing out. State preserved.', tag, true);
      SpreadsheetApp.getUi().alert(`Job ${pending.jobId} still running. Try again later.`);

    } else {
      // Ingest failed. Delete the new group; leave old groups alone.
      try {
        deleteGroup_(config, pending.boardId, pending.newGroupId, tag);
      } catch (e) {
        logToAuditSheet('WARN', `Cleanup of ${pending.newGroupId} failed: ${e.message}`, tag);
      }
      PropertiesService.getScriptProperties().deleteProperty('PENDING_GROUP_SWAP');
      throw new Error(`Resumed job failed: ${JSON.stringify(finalStatus)}`);
    }

  } catch (e) {
    logToAuditSheet('ERROR', `Resume failed: ${e.message}`, tag, true);
    SpreadsheetApp.getUi().alert(`Resume failed: ${e.message}`);
  } finally {
    flushAuditLogs();
  }
}

function reapArchivedWritebackGroups() {
  const config = getAppConfig_();
  const boardId = config.monday_board_id;
  const keepDays = Number(config.writeback_group_keep_days) || 14;
  const prefix = config.writeback_group_prefix || 'writeback_';
  const tag = `Reaper:${boardId}`;

  // Verify the exact argument name for filtering archived groups against current docs.
  // If state: archived isn't accepted, fall back to fetching all groups and filtering by g.archived.
  let groups;
  try {
    const query = `query { boards(ids: ${boardId}) { groups(state: archived) { id title } } }`;
    const res = mondayRequest_(query, tag);
    groups = res.data?.boards?.[0]?.groups || [];
  } catch (e) {
    logToAuditSheet('INFO',
      `Archived-only query failed (${e.message}); falling back to full fetch.`, tag);
    const query = `query { boards(ids: ${boardId}) { groups { id title archived } } }`;
    const res = mondayRequest_(query, tag);
    groups = (res.data?.boards?.[0]?.groups || []).filter(g => g.archived);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);

  let reaped = 0;
  let skipped = 0;
  for (const g of groups) {
    if (!String(g.title).startsWith(prefix)) {
      skipped++;
      continue;
    }
    // Parse date from title format: writeback_YYYY-MM-DD_HHMM
    const match = String(g.title).match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) {
      logToAuditSheet('WARN',
        `Archived group "${g.title}" matches prefix but has no parseable date. Skipping.`, tag);
      skipped++;
      continue;
    }
    const groupDate = new Date(match[1]);
    if (groupDate < cutoff) {
      try {
        deleteGroup_(config, boardId, g.id, tag);
        logToAuditSheet('INFO', `Reaped: ${g.title} (${g.id}).`, tag);
        reaped++;
      } catch (e) {
        logToAuditSheet('WARN', `Reap of ${g.id} failed: ${e.message}`, tag);
      }
    } else {
      skipped++;
    }
  }

  logToAuditSheet('INFO', `Reaper complete: reaped=${reaped}, skipped=${skipped}.`, tag, true);
  flushAuditLogs();
}


// =============================================================================
// DRY RUN
// =============================================================================

function runDryRun() {
  let config;
  try {
    config = getAppConfig_();
  } catch (e) {
    SpreadsheetApp.getUi().alert(`Configuration Error: ${e.message}`);
    return;
  }

  const boardId = config.monday_board_id;
  const tag = `Target:${boardId} (DRY RUN)`;

  if (!boardId) {
    SpreadsheetApp.getUi().alert('Configuration Error: Missing "monday_board_id" in Configuration sheet.');
    return;
  }

  logToAuditSheet('INFO', `Starting DRY RUN for board ${boardId}.`, 'runDryRun');
  showToast('Starting dry run...', 'Dry run');

  try {
    showToast('Fetching Monday schema...', 'Phase 1/3');
    const mondaySchema = getMondaySchema_(boardId);

    showToast('Staging incumbent data...', 'Phase 2/3');
    const data = stageIncumbentData_(config);

    if (!data || data.length <= 1) {
      logToAuditSheet('WARN', 'No data in external incumbent sheet. Skipping.', tag, true);
      return;
    }

    showToast('Validating schemas...', 'Phase 3/3');
    const validation = validateHeaders_(data[0], mondaySchema, config, tag);

    showToast('Generating mock payload...', 'Phase 3/3');
    generateMockPayloadSheet_(data, validation.mapping, mondaySchema, validation);

    const mapped = Object.keys(validation.mapping).length - 1;
    const dropped = validation.missing.length;
    const blanks = validation.unmatchedMonday.length;

    if (dropped > 0) {
      logToAuditSheet('WARN', 'Dry run completed with unmapped columns.', tag, true);
    } else {
      logToAuditSheet('SUCCESS', 'Dry run complete. Validation passed.', tag, true);
    }

    const summary =
      `Dry run complete. No data was changed in Monday.\n\n` +
      ` ${mapped} sheet column(s) mapped and will write\n` +
      ` ${dropped} sheet column(s) unmapped and will be dropped on writeback\n` +
      ` ${blanks} Monday column(s) unmatched and will be blank on writeback\n\n` +
      `See the mapping tab for column-by-column detail and the ".dry_run_payload" tab for the exact JSON sent per row.`;

    SpreadsheetApp.getUi().alert('Dry run complete', summary, SpreadsheetApp.getUi().ButtonSet.OK);

  } catch (e) {
    logToAuditSheet('ERROR', `Dry run failed: ${e.message}`, tag, true);
    SpreadsheetApp.getUi().alert(`Dry run failed:\n${e.message}`);
  }

  flushAuditLogs();
}

function generateMockPayloadSheet_(data, mapping, mondaySchema, validation) {
  const sheetHeaders = data[0];
  const rows = data.slice(1);

  const headerRow = ['Item Name'];
  const subHeaderRow = ['(built-in)'];
  const sheetColRenderOrder = [];

  // All sheet columns — mapped and unmapped
  sheetHeaders.forEach((header, idx) => {
    if (idx === mapping._nameIndex) return;
    if (!String(header).trim()) return;
    sheetColRenderOrder.push(idx);

    if (mapping[idx]) {
      const normKey = String(header).toLowerCase().trim();
      const mondayCol = mondaySchema[normKey];
      headerRow.push(`${mondayCol.title}\n[${mondayCol.type}]`);
      subHeaderRow.push(`Monday ID: ${mondayCol.id}\n← from "${header}"`);
    } else {
      headerRow.push(`⚠ ${header}`);
      subHeaderRow.push('DROPPED — no Monday match');
    }
  });

  // Monday columns with no sheet source
  validation.unmatchedMonday.forEach(col => {
    headerRow.push(`${col.title}\n[${col.type}]`);
    subHeaderRow.push(`Monday ID: ${col.id}\n⚠ BLANK — no sheet source`);
  });

  // The truth column: actual JSON sent to Monday
  headerRow.push('Actual JSON payload');
  subHeaderRow.push('(what column_values receives)');

  const outputData = [headerRow, subHeaderRow];

  for (const row of rows) {
    const outRow = [String(row[mapping._nameIndex] || 'Untitled Item')];

    sheetColRenderOrder.forEach(idx => {
      let value = row[idx];
      if (Object.prototype.toString.call(value) === '[object Date]') {
        value = !isNaN(value.getTime())
          ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : '';
      }
      outRow.push(value !== '' && value != null ? String(value) : '');
    });

    validation.unmatchedMonday.forEach(() => outRow.push('(blank)'));

    // Single source of truth — same call writeToMonday_ (legacy) uses
    outRow.push(JSON.stringify(buildColumnValues_(row, mapping)));
    outputData.push(outRow);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mockTabName = '.dry_run_payload';
  let mockSheet = ss.getSheetByName(mockTabName);
  if (!mockSheet) mockSheet = ss.insertSheet(mockTabName);
  mockSheet.clear();
  mockSheet.getRange(1, 1, outputData.length, outputData[0].length).setValues(outputData);

  mockSheet.getRange(1, 1, 1, outputData[0].length).setFontWeight('bold').setBackground('#fff2cc');
  mockSheet.getRange(2, 1, 1, outputData[0].length).setFontStyle('italic').setBackground('#fef7e0');

  // Color the problem columns so a glance is enough
  let col = 2;
  sheetColRenderOrder.forEach(idx => {
    if (!mapping[idx]) {
      mockSheet.getRange(1, col, outputData.length, 1).setBackground('#fce5cd'); // dropped
    }
    col++;
  });
  validation.unmatchedMonday.forEach(() => {
    mockSheet.getRange(1, col, outputData.length, 1).setBackground('#f4cccc'); // blank
    col++;
  });

  mockSheet.setFrozenRows(2);
  mockSheet.setFrozenColumns(1);
  mockSheet.autoResizeColumns(1, outputData[0].length);
  return mockSheet;
}


// =============================================================================
// SHARED PIPELINE STAGES (used by production and dry run)
// =============================================================================

function getMondaySchema_(boardId) {
  const query = `query { boards (ids: ${boardId}) { columns { id title type } } }`;
  const response = mondayRequest_(query, `Schema:${boardId}`);
  const columns = response.data?.boards?.[0]?.columns;
  if (!columns) throw new Error(`Could not fetch columns for board ${boardId}.`);

  const schema = {};
  columns.forEach(col => {
    schema[col.title.toLowerCase().trim()] = { id: col.id, type: col.type, title: col.title };
  });
  return schema;
}

function stageIncumbentData_(config) {
  if (!config.incumbent_file_id || !config.incumbent_tab_name) {
    throw new Error('Missing incumbent file ID or tab name in configuration.');
  }

  // 1-indexed row where headers live. Defaults to 1 for back-compat.
  // Set to 2 when row 1 is a banner/title and row 2 holds the actual headers.
  const headerRow = Number(config.incumbent_header_row) || 1;

  const sourceFile = SpreadsheetApp.openById(config.incumbent_file_id);
  const sourceSheet = sourceFile.getSheetByName(config.incumbent_tab_name);
  if (!sourceSheet) throw new Error(`Tab "${config.incumbent_tab_name}" not found in external Incumbent file.`);

  const raw = sourceSheet.getDataRange().getValues();

  if (raw.length < headerRow) {
    throw new Error(`Source has ${raw.length} row(s) but incumbent_header_row=${headerRow}. Nothing to read.`);
  }

  // Drop everything above the header row. After this, data[0] = headers, data[1+] = rows.
  const data = raw.slice(headerRow - 1);

  // Staging mirrors what the pipeline actually processes — not the raw source.
  // (For raw fidelity when debugging, open the source file directly.)
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stagingName = config.staging_new_tab_name || '.staging_incumbent';
  let stagingSheet = ss.getSheetByName(stagingName);
  if (!stagingSheet) stagingSheet = ss.insertSheet(stagingName);

  stagingSheet.clear();
  if (data.length > 0) {
    stagingSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
  }

  return data;
}

function validateHeaders_(sheetHeaders, mondaySchema, config, tag) {
  const mapping = {};
  const missingInMonday = [];
  const outputMap = [['Sheets Header', 'Monday Title', 'Monday Column ID', 'Monday Type', 'Status']];

  let nameIndex = sheetHeaders.findIndex(h => {
    const norm = String(h).toLowerCase().trim();
    return norm === 'name' || norm === 'item name';
  });
  if (nameIndex === -1) nameIndex = 0;
  mapping._nameIndex = nameIndex;

  const matchedMondayKeys = new Set();

  sheetHeaders.forEach((header, index) => {
    const normHeader = String(header).toLowerCase().trim();
    if (!normHeader) return;

    if (index === nameIndex) {
      outputMap.push([header, '(Item Name)', '—', 'name', '✓ Mapped to item name']);
      return;
    }

    const mondayCol = mondaySchema[normHeader];
    if (mondayCol) {
      mapping[index] = mondayCol.id; // flat shape keeps writeToMonday_ simple
      matchedMondayKeys.add(normHeader);
      outputMap.push([header, mondayCol.title, mondayCol.id, mondayCol.type, '✓ Mapped']);
    } else {
      missingInMonday.push(header);
      outputMap.push([header, '—', '—', '—', '❌ Sheet column has no match — DATA WILL BE DROPPED']);
    }
  });

  // Reverse pass: Monday columns with no sheet source.
  // These go blank after writeback with zero warning otherwise.
  const unmatchedMonday = [];
  Object.keys(mondaySchema).forEach(key => {
    if (matchedMondayKeys.has(key)) return;
    const col = mondaySchema[key];
    unmatchedMonday.push(col);
    outputMap.push(['—', col.title, col.id, col.type, '⚠ Monday column has no source — WILL BE BLANK AFTER WRITEBACK']);
  });

  let mapSheet;
  if (config.staging_mapping_tab_name) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    mapSheet = ss.getSheetByName(config.staging_mapping_tab_name);
    if (!mapSheet) mapSheet = ss.insertSheet(config.staging_mapping_tab_name);
    mapSheet.clear();
    mapSheet.getRange(1, 1, outputMap.length, outputMap[0].length).setValues(outputMap);
    mapSheet.getRange(1, 1, 1, outputMap[0].length).setFontWeight('bold').setBackground('#efefef');
    mapSheet.autoResizeColumns(1, outputMap[0].length);
  }

  return { mapping, missing: missingInMonday, unmatchedMonday, mapSheet };
}

function buildColumnValues_(row, mapping) {
  const columnValues = {};
  Object.keys(mapping).forEach(sheetIndex => {
    if (sheetIndex === '_nameIndex') return;
    const colId = mapping[sheetIndex];
    let value = row[sheetIndex];

    if (Object.prototype.toString.call(value) === '[object Date]') {
      value = !isNaN(value.getTime())
        ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : '';
    }

    if (value !== '' && value != null) {
      columnValues[colId] = String(value);
    }
  });
  return columnValues;
}


// =============================================================================
// INGEST API HELPERS
// =============================================================================

function buildIngestCsv_(data, mapping, mondaySchema) {
  const rows = data.slice(1);

  // Header row: "name" for item name column, Monday column IDs for the rest.
  // The ingest endpoint expects column IDs (not titles) as CSV headers.
  const csvHeaders = ['name'];
  const sourceIndexes = []; // sheet column indexes, in CSV output order

  Object.keys(mapping).forEach(sheetIndex => {
    if (sheetIndex === '_nameIndex') return;
    csvHeaders.push(mapping[sheetIndex]); // Monday column ID
    sourceIndexes.push(Number(sheetIndex));
  });

  const lines = [csvHeaders.map(csvEscape_).join(',')];

  for (const row of rows) {
    const itemName = String(row[mapping._nameIndex] || 'Untitled Item');
    const fields = [csvEscape_(itemName)];

    sourceIndexes.forEach(idx => {
      let value = row[idx];
      if (Object.prototype.toString.call(value) === '[object Date]') {
        value = !isNaN(value.getTime())
          ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : '';
      }
      fields.push(csvEscape_(value == null ? '' : String(value)));
    });

    lines.push(fields.join(','));
  }

  return lines.join('\n');
}

function csvEscape_(value) {
  const s = String(value);
  // RFC 4180: quote if value contains comma, quote, CR, or LF. Double internal quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function startIngestJob_(config, boardId, groupId, behaviour, matchColId, tag) {
  // Both UPSERT and SKIP require match_column_id syntactically.
  // For group-swap into an empty group, the match is behaviorally a no-op.
  const mutation = `
    mutation {
      ingest_items(
        board_id: "${boardId}"
        group_id: "${groupId}"
        on_match: { behaviour: ${behaviour}, match_column_id: "${matchColId}" }
      ) { job_id upload_url }
    }
  `;

  const apiVersion = config.monday_api_version_ingest || '2026-07';
  const resp = fetchWithBackoff_(config.mondayUrl, {
    method: 'post',
    headers: {
      Authorization: config.mondayApiKey,
      'Content-Type': 'application/json',
      'API-Version': apiVersion
    },
    payload: JSON.stringify({ query: mutation })
  });

  const body = safeJsonParse_(resp.getContentText(), {});
  if (body.errors?.length) {
    throw new Error(`ingest_items error: ${body.errors.map(e => e.message).join(' | ')}`);
  }
  const result = body.data?.ingest_items;
  if (!result?.job_id || !result?.upload_url) {
    throw new Error(`Malformed ingest_items response: ${JSON.stringify(body)}`);
  }
  return result;
}

function uploadIngestCsv_(uploadUrl, csv, tag) {
  // The pre-signed URL is authenticated by the signature in the query string.
  // Do NOT add Authorization headers — they'll cause AWS to reject the PUT.
  const resp = UrlFetchApp.fetch(uploadUrl, {
    method: 'put',
    contentType: 'text/csv',
    payload: csv,
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`CSV upload failed: HTTP ${code}. Body: ${resp.getContentText().substring(0, 500)}`);
  }
  logToAuditSheet('INFO', `Upload HTTP ${code}.`, tag);
}

function pollIngestJob_(config, jobId, tag) {
  const POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20-min cap, well under 30-min Apps Script wall
  const INITIAL_DELAY_MS = 5000;
  const MAX_DELAY_MS = 30000;
  const BACKOFF_FACTOR = 1.5;

  const startedAt = Date.now();
  let delay = INITIAL_DELAY_MS;

  const apiVersion = config.monday_api_version_ingest || '2026-07';

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    Utilities.sleep(delay);

    const query = `query { fetch_job_status(job_id: "${jobId}") { state error rows_processed rows_failed } }`;
    let body;
    try {
      const resp = fetchWithBackoff_(config.mondayUrl, {
        method: 'post',
        headers: {
          Authorization: config.mondayApiKey,
          'Content-Type': 'application/json',
          'API-Version': apiVersion
        },
        payload: JSON.stringify({ query })
      });
      body = safeJsonParse_(resp.getContentText(), {});
    } catch (e) {
      logToAuditSheet('WARN', `Poll attempt failed: ${e.message}. Retrying.`, tag);
      delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
      continue;
    }

    if (body.errors?.length) {
      throw new Error(`fetch_job_status error: ${body.errors.map(e => e.message).join(' | ')}`);
    }

    const status = body.data?.fetch_job_status;
    if (!status) {
      logToAuditSheet('WARN',
        `Malformed poll response: ${JSON.stringify(body).substring(0, 300)}`, tag);
      delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
      continue;
    }

    logToAuditSheet('INFO',
      `Poll: state=${status.state}, processed=${status.rows_processed || '?'}, failed=${status.rows_failed || '?'}.`,
      tag);

    // ::TODO:: Verify exact terminal enum values against current Monday docs.
    const terminal = ['COMPLETED', 'SUCCESS', 'FAILED', 'ERROR', 'CANCELLED'];
    if (terminal.includes(status.state)) {
      return status;
    }

    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
  }

  return { state: 'TIMEOUT_POLLING', message: 'Apps Script polling budget exhausted.' };
}


// =============================================================================
// GROUP API HELPERS
// =============================================================================

function buildWritebackGroupTitle_(config) {
  const prefix = config.writeback_group_prefix || 'writeback_';
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  return `${prefix}${stamp}`;
}

function listWritebackGroupIds_(config, boardId, tag) {
  // Returns IDs of LIVE (non-archived) groups matching our naming convention.
  // We deliberately do NOT include archived groups here — those are the reaper's job.
  const prefix = config.writeback_group_prefix || 'writeback_';
  const query = `query { boards(ids: ${boardId}) { groups { id title archived } } }`;
  const res = mondayRequest_(query, tag);
  const groups = res.data?.boards?.[0]?.groups || [];
  return groups
    .filter(g => !g.archived && String(g.title).startsWith(prefix))
    .map(g => g.id);
}

function createGroup_(config, boardId, title, tag) {
  const escaped = String(title).replace(/"/g, '\\"');
  const mutation = `mutation { create_group(board_id: ${boardId}, group_name: "${escaped}") { id } }`;
  const res = mondayRequest_(mutation, tag);
  const id = res.data?.create_group?.id;
  if (!id) throw new Error(`create_group returned no id: ${JSON.stringify(res)}`);
  return id;
}

function archiveGroup_(config, boardId, groupId, tag) {
  const mutation = `mutation { archive_group(board_id: ${boardId}, group_id: "${groupId}") { id archived } }`;
  const res = mondayRequest_(mutation, tag);
  if (!res.data?.archive_group?.archived) {
    throw new Error(`archive_group did not confirm archived=true: ${JSON.stringify(res)}`);
  }
}

function deleteGroup_(config, boardId, groupId, tag) {
  const mutation = `mutation { delete_group(board_id: ${boardId}, group_id: "${groupId}") { id deleted } }`;
  const res = mondayRequest_(mutation, tag);
  if (!res.data?.delete_group?.deleted) {
    throw new Error(`delete_group did not confirm deleted=true: ${JSON.stringify(res)}`);
  }
}


// =============================================================================
// TRANSPORT & INFRA
// =============================================================================

function mondayRequest_(query, tag) {
  const config = getAppConfig_();
  const resp = fetchWithBackoff_(config.mondayUrl, {
    method: 'post',
    headers: {
      Authorization: config.mondayApiKey,
      'Content-Type': 'application/json',
      'API-Version': config.mondayApiVersion
    },
    payload: JSON.stringify({ query })
  });

  const body = safeJsonParse_(resp.getContentText(), {});
  if (body.errors?.length) {
    const msg = body.errors.map(e => e.message).join(' | ');
    throw new Error(`Monday GraphQL Error: ${msg}`);
  }
  return body;
}

function fetchWithBackoff_(url, options, maxRetries = 4) {
  const request = { ...options, muteHttpExceptions: true };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(url, request);
      const code = resp.getResponseCode();
      if (code < 400 || (code >= 400 && code < 500 && code !== 429)) return resp;
      if (attempt === maxRetries) throw new Error(`HTTP ${code}: ${resp.getContentText()}`);

      const retryAfter = Number(resp.getHeaders()?.['retry-after'] || resp.getHeaders()?.['Retry-After']);
      const delay = (!Number.isNaN(retryAfter) && retryAfter > 0)
        ? retryAfter * 1000
        : (2 ** (attempt + 1)) * 1000 + Math.floor(Math.random() * 1000);
      Utilities.sleep(delay);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      Utilities.sleep((2 ** (attempt + 1)) * 1000 + Math.floor(Math.random() * 1000));
    }
  }
}

function safeJsonParse_(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function showToast(message, title, seconds) {
  try {
    SpreadsheetApp.getActiveSpreadsheet()?.toast(message, title || 'Writeback', seconds || 5);
  } catch (_) {}
}

function sendAlertEmail_(config, subject, body) {
  if (config && config.alert_email_address) {
    try {
      MailApp.sendEmail({
        to: config.alert_email_address,
        subject: `[Monday Sync Alert] ${subject}`,
        body: body
      });
    } catch (e) {
      console.warn(`Failed to send alert email: ${e.message}`);
    }
  }
}

function getAppConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configSheet = ss.getSheetByName('Configuration');

  if (!configSheet) {
    throw new Error('Configuration sheet not found. Please ensure a tab named "Configuration" exists.');
  }

  const data = configSheet.getDataRange().getValues();
  const config = {};

  for (let i = 3; i < data.length; i++) {
    const key = data[i][3];   // Column D
    const value = data[i][4]; // Column E

    if (key && String(key).trim() !== '') {
      config[String(key).trim()] = value !== '' ? value : null;
    }
  }

  const props = PropertiesService.getScriptProperties().getProperties();
  config.mondayApiKey = props.MONDAY_API_KEY || '';
  config.mondayUrl = props.MONDAY_URL || APP.DEFAULTS.MONDAY_URL;
  config.mondayApiVersion = props.MONDAY_API_VERSION || APP.DEFAULTS.MONDAY_API_VERSION;

  return config;
}

function logToAuditSheet(status, message, module, flushNow) {
  MEMORY.logBuffer.push([new Date(), EXECUTION_ID, module, status, message]);
  console.log(`[${status}] ${module}: ${message}`);
  if (flushNow || status === 'ERROR' || MEMORY.logBuffer.length >= APP.RUNTIME.LOG_FLUSH_SIZE) {
    flushAuditLogs();
  }
}

function flushAuditLogs() {
  if (!MEMORY.logBuffer.length) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(APP.SHEETS.AUDIT);
    if (!sheet) {
      sheet = ss.insertSheet(APP.SHEETS.AUDIT);
      sheet.getRange(1, 1, 1, 5)
        .setValues([['Timestamp', 'Execution ID', 'Module', 'Status', 'Message']])
        .setFontWeight('bold')
        .setBackground('#efefef');
      sheet.setFrozenRows(1);
    }

    const batch = MEMORY.logBuffer.splice(0);
    const startRow = sheet.getLastRow() + 1;
    const range = sheet.getRange(startRow, 1, batch.length, batch[0].length);

    range.setValues(batch);
    // Explicitly neutralize formatting in case the sheet was edited manually.
    range.setFontWeight('normal').setBackground(null).setFontStyle('normal');
  } catch (e) {
    console.warn(`Audit log flush failed: ${e.message}`);
  }
}


// =============================================================================
// LEGACY PIPELINE (truncate-and-rewrite — kept for small manual runs only)
// =============================================================================

function runWritebackLegacy() {
  let config;
  try {
    config = getAppConfig_();
  } catch (e) {
    SpreadsheetApp.getUi().alert(`Configuration Error: ${e.message}`);
    return;
  }

  const boardId = config.monday_board_id;
  const tag = `Target:${boardId} (legacy)`;

  if (!boardId) {
    SpreadsheetApp.getUi().alert('Configuration Error: Missing "monday_board_id" in Configuration sheet.');
    return;
  }

  logToAuditSheet('INFO', `Starting legacy writeback for board ${boardId}.`, 'runWritebackLegacy');
  showToast('Starting writeback...', 'Writeback');

  try {
    showToast('Fetching Monday schema...', 'Phase 1/4');
    const mondaySchema = getMondaySchema_(boardId);

    showToast('Staging incumbent data...', 'Phase 1/4');
    const data = stageIncumbentData_(config);

    if (!data || data.length <= 1) {
      logToAuditSheet('WARN', 'No data in external incumbent sheet. Skipping.', tag, true);
      return;
    }

    showToast('Validating schemas...', 'Phase 2/4');
    const validation = validateHeaders_(data[0], mondaySchema, config, tag);

    if (validation.missing.length > 0) {
      if (validation.mapSheet) SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(validation.mapSheet);
      const errorMsg = `Schema mismatch. The following columns exist in Sheets but not in Monday:\n\n • ${validation.missing.join('\n • ')}`;
      sendAlertEmail_(config, 'Header validation failed', errorMsg);
      throw new Error(errorMsg);
    }

    showToast('Truncating existing board data...', 'Phase 3/4');
    truncateMondayBoard_(boardId, tag);

    showToast('Writing fresh data to Monday...', 'Phase 4/4');
    writeToMonday_(boardId, data, validation.mapping, tag);

    logToAuditSheet('SUCCESS', `Legacy writeback complete for board ${boardId}.`, tag, true);
  } catch (e) {
    logToAuditSheet('ERROR', `Legacy writeback failed: ${e.message}`, tag, true);
    try { SpreadsheetApp.getUi().alert(`Sync failed:\n${e.message}`); } catch (_) {}
    sendAlertEmail_(config, 'Legacy writeback failed', `Error: ${e.message}`);
    throw e;
  }

  showToast('Writeback complete.', 'Success', 8);
  flushAuditLogs();
}

function truncateMondayBoard_(boardId, tag) {
  const itemIds = fetchAllItemIds_(boardId, tag);
  if (itemIds.length === 0) return 0;

  logToAuditSheet('INFO', `Found ${itemIds.length} items to delete. Truncating...`, tag);
  const deleted = deleteBatch_(itemIds, tag);
  logToAuditSheet('INFO', `Truncate complete: deleted=${deleted}/${itemIds.length}.`, tag);
  return deleted;
}

function fetchAllItemIds_(boardId, tag) {
  let cursor = null;
  const itemIds = [];

  do {
    const query = cursor
      ? `query { next_items_page (limit: 500, cursor: "${cursor}") { cursor items { id } } }`
      : `query { boards (ids: ${boardId}) { items_page (limit: 500) { cursor items { id } } } }`;

    const res = mondayRequest_(query, tag);
    const page = cursor ? res.data?.next_items_page : res.data?.boards[0]?.items_page;

    if (page?.items) page.items.forEach(i => itemIds.push(i.id));
    cursor = page?.cursor || null;
  } while (cursor);

  return itemIds;
}

function deleteBatch_(itemIds, tag) {
  // Alias multiple delete_item mutations into one request.
  // Tune BATCH_SIZE down if you see frequent failures (complexity budget exhaustion).
  const BATCH_SIZE = 50;
  let deleted = 0;

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const chunk = itemIds.slice(i, i + BATCH_SIZE);
    const aliased = chunk
      .map((id, idx) => `d${idx}: delete_item(item_id: ${id}) { id }`)
      .join('\n');
    const mutation = `mutation { ${aliased} }`;

    try {
      mondayRequest_(mutation, tag);
      deleted += chunk.length;
    } catch (e) {
      logToAuditSheet('ERROR', `Batch delete failed at offset ${i}: ${e.message}`, tag);
    }

    Utilities.sleep(200);
  }

  return deleted;
}

function writeToMonday_(boardId, data, mapping, tag) {
  const rows = data.slice(1);
  const BATCH_SIZE = 25; // create_item costs more complexity than delete_item

  let successCount = 0;
  let failedBatches = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);

    const aliased = chunk.map((row, idx) => {
      const itemName = String(row[mapping._nameIndex] || 'Untitled Item').replace(/"/g, '\\"');
      const columnValues = buildColumnValues_(row, mapping);
      const escapedColVals = JSON.stringify(JSON.stringify(columnValues));
      return `c${idx}: create_item(board_id: ${boardId}, item_name: "${itemName}", column_values: ${escapedColVals}) { id }`;
    }).join('\n');

    const mutation = `mutation { ${aliased} }`;

    try {
      mondayRequest_(mutation, tag);
      successCount += chunk.length;
    } catch (e) {
      failedBatches++;
      logToAuditSheet('ERROR',
        `Batch create failed at offset ${i} (${chunk.length} rows): ${e.message}`, tag);
      // Fall back to per-item writes so we don't lose 25 rows to one bad row
      for (const row of chunk) {
        try {
          const itemName = String(row[mapping._nameIndex] || 'Untitled Item').replace(/"/g, '\\"');
          const columnValues = buildColumnValues_(row, mapping);
          const escapedColVals = JSON.stringify(JSON.stringify(columnValues));
          const single = `mutation { create_item(board_id: ${boardId}, item_name: "${itemName}", column_values: ${escapedColVals}) { id } }`;
          mondayRequest_(single, tag);
          successCount++;
        } catch (innerE) {
          logToAuditSheet('ERROR', `Single-item fallback failed: ${innerE.message}`, tag);
        }
      }
    }

    Utilities.sleep(200);
  }

  logToAuditSheet('INFO',
    `Legacy write complete: wrote=${successCount}/${rows.length}, failedBatches=${failedBatches}.`, tag);
  return successCount;
}


// =============================================================================
// DIAGNOSTICS (run from the editor only)
// =============================================================================

// https://developer.monday.com/api-reference/reference/groups
function listBoardGroups() {
  const config = getAppConfig_();
  const query = `query { boards(ids: ${config.monday_board_id}) { groups { id title } } }`;
  const res = mondayRequest_(query, `Groups:${config.monday_board_id}`);
  const groups = res.data?.boards?.[0]?.groups || [];
  console.log(`Board ${config.monday_board_id} groups:`);
  groups.forEach(g => console.log(` Group ID: ${g.id} -> Title: "${g.title}"`));
  return groups;
}

// https://developer.monday.com/api-reference/docs/importing-items-in-bulk
function probeIngestItems() {
  const config = getAppConfig_();
  if (!config.monday_group_id) {
    console.error('Set monday_group_id in Configuration first. Run listBoardGroups() to find valid IDs.');
    return;
  }
  const query = `
    mutation {
      ingest_items(
        board_id: "${config.monday_board_id}"
        group_id: "${config.monday_group_id}"
        on_match: { behaviour: UPSERT, match_column_id: "name" }
      ) { job_id upload_url }
    }
  `;
  const resp = UrlFetchApp.fetch(config.mondayUrl, {
    method: 'post',
    headers: {
      Authorization: config.mondayApiKey,
      'Content-Type': 'application/json',
      'API-Version': '2026-07'
    },
    payload: JSON.stringify({ query }),
    muteHttpExceptions: true
  });
  console.log('Status:', resp.getResponseCode());
  console.log('Body:', resp.getContentText());
}

function run_getMondaySchema() {
  const config = getAppConfig_();
  const boardId = config.monday_board_id;

  try {
    const schema = getMondaySchema_(boardId);
    console.log(JSON.stringify(schema, null, 2));
  } catch (e) {
    console.log(`Error during schema fetch: ${e.message}`);
  }
}

// https://developer.monday.com/api-reference/docs/importing-items-in-bulk#supported-column-types
function auditColumnTypes() {
  const config = getAppConfig_();
  if (!config.monday_board_id) {
    console.error('Set monday_board_id in Configuration.');
    return;
  }

  const INGEST_SUPPORTED = new Set([
    'date', 'dropdown', 'email', 'link', 'long_text', 'number',
    'people', 'phone', 'text', 'status', 'timeline'
  ]);

  const query = `query { boards(ids: ${config.monday_board_id}) { columns { id title type } } }`;
  const res = mondayRequest_(query, `Audit:${config.monday_board_id}`);
  const columns = res.data?.boards?.[0]?.columns || [];

  const byType = {};
  columns.forEach(col => {
    if (!byType[col.type]) byType[col.type] = [];
    byType[col.type].push({ id: col.id, title: col.title });
  });

  const rows = [['Type', 'Count', 'Ingest supported?', 'Columns']];
  Object.keys(byType).sort().forEach(type => {
    const cols = byType[type];
    const supported = INGEST_SUPPORTED.has(type) ? '✓' : '⚠ not supported';
    const titles = cols.map(c => `${c.title} (${c.id})`).join('\n');
    rows.push([type, cols.length, supported, titles]);
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabName = '.col_type_audit';
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 4).setValues(rows);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#efefef');
  sheet.setFrozenRows(1);

  // Highlight unsupported rows
  for (let i = 2; i <= rows.length; i++) {
    if (String(rows[i - 1][2]).startsWith('⚠')) {
      sheet.getRange(i, 1, 1, 4).setBackground('#fce5cd');
    }
  }
  sheet.autoResizeColumns(1, 4);

  const unsupported = Object.keys(byType).filter(t => !INGEST_SUPPORTED.has(t));
  if (unsupported.length === 0) {
    console.log(`All ${columns.length} columns across ${Object.keys(byType).length} type(s) are ingest-supported.`);
  } else {
    console.log(`${unsupported.length} unsupported type(s): ${unsupported.join(', ')}`);
    console.log(`Total column(s) affected: ${unsupported.reduce((acc, t) => acc + byType[t].length, 0)}`);
  }
  return byType;
}

function introspectOnMatchEnum() {
  const config = getAppConfig_();
  const query = `query { __type(name: "OnMatchBehaviour") { enumValues { name } } }`;
  // The actual type name may differ; introspect Mutation.ingest_items first to confirm.
  const resp = UrlFetchApp.fetch(config.mondayUrl, {
    method: 'post',
    headers: {
      Authorization: config.mondayApiKey,
      'Content-Type': 'application/json',
      'API-Version': '2026-07'
    },
    payload: JSON.stringify({ query }),
    muteHttpExceptions: true
  });
  console.log(resp.getContentText());
}
