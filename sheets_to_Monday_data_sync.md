## Pass 1: Batched API calls (biggest immediate win)

**What changes:** `truncateMondayBoard_` and `writeToMonday_` get replaced with batched versions. Adds one new helper `deleteBatch_`.

**Why first:** Single change, 20-40x throughput improvement, no architectural shift. If this gets you under 30 minutes at your row counts, you may not need Pass 2.

### Replace `truncateMondayBoard_`

```javascript
// --- PHASE 3: TRUNCATE -------------------------------------------------------
function truncateMondayBoard_(boardId, tag) {
  const itemIds = fetchAllItemIds_(boardId, tag);
  if (itemIds.length === 0) return 0;

  logToAuditSheet('INFO', `Found ${itemIds.length} items to delete. Truncating...`, tag);
  const deleted = deleteBatch_(itemIds, tag);
  logToAuditSheet('INFO', `Truncate complete: ${deleted}/${itemIds.length} deleted.`, tag);
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
      // Continue — partial progress is still progress
    }

    Utilities.sleep(200); // be a good citizen between batches
  }

  return deleted;
}
```

### Replace `writeToMonday_`

```javascript
// --- PHASE 4: WRITEBACK ------------------------------------------------------
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
      logToAuditSheet('ERROR', `Batch create failed at offset ${i} (${chunk.length} rows): ${e.message}`, tag);
      // Fall back to per-item writes for this batch so we don't lose 25 rows to one bad row
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

  logToAuditSheet('INFO', `Wrote ${successCount}/${rows.length} rows. Failed batches: ${failedBatches}.`, tag);
  return successCount;
}
```

The fallback-to-single pattern in `writeToMonday_` is worth its weight in gold. When a batch fails (one bad row poisons the whole alias), you don't lose 25 rows — you lose only the actual bad row.

---

## Pass 2: Resumable execution

**What changes:** Adds job state management, a new `runWritebackResumable` entry point, resumable phase functions, and self-scheduling continuation. `runWriteback` (manual menu version) stays unchanged for small ad-hoc runs.

**Why second:** Builds on the batched calls. Without batching, resumption is masking a fundamental throughput problem. With batching, resumption is the right tool for the residual problem (boards that just don't fit in 30 minutes).

### Add new constants

Add to the `APP` config block at the top:

```javascript
const APP = Object.freeze({
  SHEETS:   { AUDIT: '.audit_log' },
  RUNTIME:  {
    LOG_FLUSH_SIZE: 10,
    SOFT_DEADLINE_MS: 25 * 60 * 1000,   // bail at 25min, leave 5min headroom
    CONTINUATION_DELAY_MS: 60 * 1000,   // ~1min between continuations
    JOB_KEY: 'CURRENT_JOB'
  },
  DEFAULTS: { MONDAY_URL: 'https://api.monday.com/v2', MONDAY_API_VERSION: '2025-10' }
});
```

### Add job state helpers

Add anywhere in the file (suggest near `getAppConfig_`):

```javascript
// --- JOB STATE ---------------------------------------------------------------
function loadJob_() {
  const raw = PropertiesService.getScriptProperties().getProperty(APP.RUNTIME.JOB_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveJob_(job) {
  PropertiesService.getScriptProperties().setProperty(APP.RUNTIME.JOB_KEY, JSON.stringify(job));
}

function clearJob_() {
  PropertiesService.getScriptProperties().deleteProperty(APP.RUNTIME.JOB_KEY);
}

function abortJob() {
  const ui = SpreadsheetApp.getUi();
  const job = loadJob_();
  if (!job) {
    ui.alert('No job in progress.');
    return;
  }
  const resp = ui.alert(
    'Abort current job?',
    `This will clear job state but will NOT undo deletes or writes already applied to Monday.\n\n` +
    `Current state:\n${JSON.stringify(job, null, 2)}`,
    ui.ButtonSet.YES_NO
  );
  if (resp === ui.Button.YES) {
    clearJob_();
    cancelContinuationTriggers_();
    logToAuditSheet('WARN', `Job aborted by user. Last state: ${JSON.stringify(job)}`, 'abortJob', true);
    ui.alert('Job state cleared.');
  }
}

function showJobStatus() {
  const job = loadJob_();
  const msg = job
    ? `Current job:\n\n${JSON.stringify(job, null, 2)}`
    : 'No job in progress.';
  SpreadsheetApp.getUi().alert(msg);
}
```

### Add continuation helpers

```javascript
// --- CONTINUATION ------------------------------------------------------------
function scheduleContinuation_() {
  ScriptApp.newTrigger('runWritebackResumable')
    .timeBased()
    .after(APP.RUNTIME.CONTINUATION_DELAY_MS)
    .create();
  logToAuditSheet('INFO', 'Continuation trigger scheduled.', 'scheduleContinuation_');
}

function cancelContinuationTriggers_() {
  // Removes only one-shot continuation triggers, not the recurring schedule.
  // We identify continuations by handler name + the fact that recurring triggers
  // are created via installSchedule() which uses .everyDays(), while continuations
  // use .after(). Both have the same handler, so we can't distinguish perfectly
  // from the trigger object alone — safest is to delete all 'runWritebackResumable'
  // triggers and have installSchedule re-create the recurring one if needed.
  // Pragmatic alternative: only delete if we just cleared a job (operator intent).
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runWritebackResumable')
    .forEach(t => {
      try { ScriptApp.deleteTrigger(t); } catch (_) {}
    });
}
```

A note on `cancelContinuationTriggers_`: Apps Script doesn't expose enough metadata to distinguish a one-shot `.after()` trigger from a recurring `.everyDays()` trigger after creation. The safest pattern is to *only* call this when aborting a job (where you want everything stopped), and have `installSchedule` be the canonical re-creator of the recurring trigger. If you call `cancelContinuationTriggers_` during normal operation, you'd need to re-run `installSchedule` to restore the daily schedule.

### Add the resumable entry point

```javascript
// --- RESUMABLE PIPELINE ------------------------------------------------------
function runWritebackResumable() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    logToAuditSheet('WARN', 'Another writeback is already running. Aborting.', 'runWritebackResumable', true);
    return;
  }

  const executionStart = Date.now();
  const overBudget = () => (Date.now() - executionStart) > APP.RUNTIME.SOFT_DEADLINE_MS;

  let config;
  try {
    config = getAppConfig_();
  } catch (e) {
    logToAuditSheet('ERROR', `Config load failed: ${e.message}`, 'runWritebackResumable', true);
    lock.releaseLock();
    return;
  }

  try {
    let job = loadJob_();

    // --- INITIALIZE FRESH JOB ---
    if (!job) {
      job = initializeJob_(config);
      if (!job) {
        // Initialization decided not to proceed (no data, validation failed, etc.)
        lock.releaseLock();
        return;
      }
      saveJob_(job);
    }

    logToAuditSheet('INFO', `Resuming job. Phase=${job.phase}, deleted=${job.deletedSoFar}/${job.totalToDelete}, written=${job.writtenSoFar}/${job.totalToWrite}.`, 'runWritebackResumable');

    // --- PHASE: TRUNCATE ---
    if (job.phase === 'truncating') {
      job = resumeTruncate_(job, overBudget);
      saveJob_(job);
      if (job.phase === 'truncating') {
        scheduleContinuation_();
        logToAuditSheet('INFO', `Truncate paused at ${job.deletedSoFar}/${job.totalToDelete}. Continuation scheduled.`, 'runWritebackResumable', true);
        lock.releaseLock();
        return;
      }
    }

    // --- PHASE: WRITE ---
    if (job.phase === 'writing') {
      job = resumeWrite_(job, overBudget);
      saveJob_(job);
      if (job.phase === 'writing') {
        scheduleContinuation_();
        logToAuditSheet('INFO', `Write paused at ${job.writtenSoFar}/${job.totalToWrite}. Continuation scheduled.`, 'runWritebackResumable', true);
        lock.releaseLock();
        return;
      }
    }

    // --- PHASE: DONE ---
    logToAuditSheet('SUCCESS',
      `Job complete. Deleted ${job.deletedSoFar}/${job.totalToDelete}, wrote ${job.writtenSoFar}/${job.totalToWrite}.`,
      'runWritebackResumable', true);
    sendAlertEmail_(config, 'Writeback completed',
      `Board: ${job.boardId}\nDeleted: ${job.deletedSoFar}\nWritten: ${job.writtenSoFar}\nElapsed since job start: ${Math.round((Date.now() - new Date(job.startedAt).getTime()) / 60000)} min`);
    clearJob_();

  } catch (e) {
    logToAuditSheet('ERROR', `Resumable run failed: ${e.message}\n${e.stack || ''}`, 'runWritebackResumable', true);
    sendAlertEmail_(config, 'Writeback FAILED',
      `Execution ID: ${EXECUTION_ID}\nError: ${e.message}\nStack: ${e.stack || '(none)'}\n\nJob state preserved. Inspect before resuming or aborting.`);
    // Do not clear job — operator inspects and decides
  } finally {
    flushAuditLogs();
    lock.releaseLock();
  }
}

function initializeJob_(config) {
  const boardId = config.monday_board_id;
  const tag = `Target:${boardId}`;

  if (!boardId) {
    logToAuditSheet('ERROR', 'Missing monday_board_id.', 'initializeJob_', true);
    return null;
  }

  logToAuditSheet('INFO', `Initializing new job for board ${boardId}.`, 'initializeJob_');

  // Schema + stage + validate
  const mondaySchema = getMondaySchema_(boardId);
  const data = stageIncumbentData_(config);

  if (!data || data.length <= 1) {
    logToAuditSheet('WARN', 'No data in incumbent. Skipping job.', tag, true);
    return null;
  }

  const validation = validateHeaders_(data[0], mondaySchema, config, tag);
  if (validation.missing.length > 0) {
    const errorMsg = `Schema mismatch. Sheet columns missing in Monday:\n • ${validation.missing.join('\n • ')}`;
    sendAlertEmail_(config, 'Header Validation Failed (Scheduled)', errorMsg);
    logToAuditSheet('ERROR', errorMsg, tag, true);
    return null;
  }

  // Snapshot item IDs to delete NOW — board state can drift across executions
  const itemIds = fetchAllItemIds_(boardId, tag);
  const deleteQueueTab = '.staging_delete_queue';
  writeQueueToSheet_(deleteQueueTab, itemIds);

  // Mapping is small JSON — fits in job state
  return {
    executionId: EXECUTION_ID,
    boardId: boardId,
    phase: 'truncating',
    startedAt: new Date().toISOString(),
    totalToDelete: itemIds.length,
    deletedSoFar: 0,
    totalToWrite: data.length - 1,
    writtenSoFar: 0,
    stagedRowsTabName: config.staging_new_tab_name || '.staging_incumbent',
    deleteQueueTabName: deleteQueueTab,
    mapping: validation.mapping
  };
}

function resumeTruncate_(job, overBudget) {
  const tag = `Target:${job.boardId} (resume-truncate)`;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(job.deleteQueueTabName);
  if (!sheet) throw new Error(`Delete queue tab missing: ${job.deleteQueueTabName}`);

  const BATCH_SIZE = 50;
  const lastRow = sheet.getLastRow();

  while (job.deletedSoFar < job.totalToDelete) {
    if (overBudget()) {
      logToAuditSheet('INFO', `Truncate over budget. Pausing at ${job.deletedSoFar}/${job.totalToDelete}.`, tag);
      return job;
    }

    const startRow = job.deletedSoFar + 1; // 1-indexed
    const remaining = job.totalToDelete - job.deletedSoFar;
    const take = Math.min(BATCH_SIZE, remaining);
    const ids = sheet.getRange(startRow, 1, take, 1).getValues().map(r => r[0]);

    const aliased = ids
      .map((id, idx) => `d${idx}: delete_item(item_id: ${id}) { id }`)
      .join('\n');

    try {
      mondayRequest_(`mutation { ${aliased} }`, tag);
      job.deletedSoFar += take;
    } catch (e) {
      logToAuditSheet('ERROR', `Truncate batch failed at ${job.deletedSoFar}: ${e.message}`, tag);
      job.deletedSoFar += take; // skip past it — partial progress is progress
    }

    Utilities.sleep(200);
  }

  job.phase = 'writing';
  logToAuditSheet('INFO', `Truncate phase complete. Advancing to write phase.`, tag);
  return job;
}

function resumeWrite_(job, overBudget) {
  const tag = `Target:${job.boardId} (resume-write)`;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(job.stagedRowsTabName);
  if (!sheet) throw new Error(`Staging tab missing: ${job.stagedRowsTabName}`);

  // Read headers once
  const lastCol = sheet.getLastColumn();
  // (Headers are row 1 of staging; data starts row 2. writtenSoFar=0 means start at row 2.)

  const BATCH_SIZE = 25;

  while (job.writtenSoFar < job.totalToWrite) {
    if (overBudget()) {
      logToAuditSheet('INFO', `Write over budget. Pausing at ${job.writtenSoFar}/${job.totalToWrite}.`, tag);
      return job;
    }

    const startRow = job.writtenSoFar + 2; // row 1 = headers, data starts row 2
    const remaining = job.totalToWrite - job.writtenSoFar;
    const take = Math.min(BATCH_SIZE, remaining);
    const chunk = sheet.getRange(startRow, 1, take, lastCol).getValues();

    const aliased = chunk.map((row, idx) => {
      const itemName = String(row[job.mapping._nameIndex] || 'Untitled Item').replace(/"/g, '\\"');
      const columnValues = buildColumnValues_(row, job.mapping);
      const escapedColVals = JSON.stringify(JSON.stringify(columnValues));
      return `c${idx}: create_item(board_id: ${job.boardId}, item_name: "${itemName}", column_values: ${escapedColVals}) { id }`;
    }).join('\n');

    try {
      mondayRequest_(`mutation { ${aliased} }`, tag);
      job.writtenSoFar += take;
    } catch (e) {
      logToAuditSheet('ERROR', `Write batch failed at ${job.writtenSoFar}: ${e.message}. Falling back to single writes.`, tag);
      // Single-item fallback
      for (const row of chunk) {
        try {
          const itemName = String(row[job.mapping._nameIndex] || 'Untitled Item').replace(/"/g, '\\"');
          const columnValues = buildColumnValues_(row, job.mapping);
          const escapedColVals = JSON.stringify(JSON.stringify(columnValues));
          mondayRequest_(`mutation { create_item(board_id: ${job.boardId}, item_name: "${itemName}", column_values: ${escapedColVals}) { id } }`, tag);
          job.writtenSoFar += 1;
        } catch (innerE) {
          logToAuditSheet('ERROR', `Single-write fallback failed at row ${job.writtenSoFar}: ${innerE.message}`, tag);
          job.writtenSoFar += 1; // skip
        }
        if (overBudget()) return job;
      }
    }

    Utilities.sleep(200);
  }

  job.phase = 'done';
  logToAuditSheet('INFO', `Write phase complete.`, tag);
  return job;
}

function writeQueueToSheet_(tabName, ids) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);
  sheet.clear();
  if (ids.length > 0) {
    sheet.getRange(1, 1, ids.length, 1).setValues(ids.map(id => [id]));
  }
  return sheet;
}
```

### Update `runWritebackScheduled` to call the resumable version

```javascript
function runWritebackScheduled() {
  logToAuditSheet('INFO', `Scheduled trigger fired.`, 'runWritebackScheduled');
  try {
    runWritebackResumable();
  } catch (e) {
    logToAuditSheet('ERROR', `Unhandled scheduled failure: ${e.message}`, 'runWritebackScheduled', true);
    try {
      sendAlertEmail_(getAppConfig_(), 'Scheduled writeback FAILED',
        `Execution ID: ${EXECUTION_ID}\nError: ${e.message}\nStack: ${e.stack || '(none)'}`);
    } catch (_) {
      MailApp.sendEmail({
        to: Session.getEffectiveUser().getEmail(),
        subject: '[Monday Sync] Scheduled run could not even start',
        body: `Error: ${e.message}`
      });
    }
  }
}
```

### Update `onOpen` menu

```javascript
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Sheets to Monday Writeback')
      .addItem('1. Run Dry Run (Validate & Preview)', 'runDryRun')
      .addSeparator()
      .addItem('2. Run Writeback (Manual — small jobs)', 'runWriteback')
      .addItem('3. Run Writeback (Resumable — large jobs)', 'runWritebackResumable')
      .addSeparator()
      .addItem('Show job status', 'showJobStatus')
      .addItem('Abort current job', 'abortJob')
      .addToUi();
  } catch (_) {}
}
```

---

## Pass 3: Canary + schedule installation

**What changes:** Adds `installSchedule` (one-shot, run from editor) and `canaryCheck` (separate recurring trigger).

### Schedule installer

```javascript
// --- SCHEDULE INSTALLATION (run once from editor) ----------------------------
function installSchedule() {
  // Remove any existing recurring trigger for the scheduled handler
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runWritebackScheduled')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runWritebackScheduled')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  // Also install canary check (runs daily, separate from writeback)
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'canaryCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('canaryCheck')
    .timeBased()
    .everyDays(1)
    .atHour(9) // a few hours after expected completion
    .create();

  logToAuditSheet('INFO', 'Schedule installed: writeback 6am, canary 9am.', 'installSchedule', true);
}

function canaryCheck() {
  const job = loadJob_();
  if (!job) return; // nothing in flight is fine

  const ageMs = Date.now() - new Date(job.startedAt).getTime();
  const ageMin = Math.round(ageMs / 60000);

  if (ageMs > 2 * 60 * 60 * 1000 && job.phase !== 'done') {
    try {
      sendAlertEmail_(getAppConfig_(), 'Writeback job appears stuck',
        `A job has been in phase "${job.phase}" for ${ageMin} minutes.\n\n` +
        `Progress:\n${JSON.stringify(job, null, 2)}\n\n` +
        `Action: open the spreadsheet menu → Show job status → decide whether to resume or abort.`);
      logToAuditSheet('WARN', `Canary: job stuck in ${job.phase} for ${ageMin}min.`, 'canaryCheck', true);
    } catch (e) {
      logToAuditSheet('ERROR', `Canary alert failed: ${e.message}`, 'canaryCheck', true);
    }
  }
}
```

---

## What you do NOT change

These existing functions stay exactly as-is — they're already correct and the new code calls them:

- `buildColumnValues_` (single source of truth, unchanged)
- `validateHeaders_` (bidirectional version from earlier)
- `getMondaySchema_` (returns id/type/title per column)
- `stageIncumbentData_` (with the `incumbent_header_row` offset)
- `runDryRun` and `generateMockPayloadSheet_`
- `mondayRequest_`, `fetchWithBackoff_`, `safeJsonParse_`
- `flushAuditLogs` (append-at-bottom version)
- `getAppConfig_`, `sendAlertEmail_`, `showToast`, `logToAuditSheet`
- The original `runWriteback` — keep it for small manual ad-hoc runs

---

## Operator runbook (paste into a tab or doc)

**Daily operation:** Nothing. The 6 AM trigger fires `runWritebackScheduled` → `runWritebackResumable`. If it doesn't finish in 25 minutes, it self-schedules continuations every ~1 minute until done. Success and failure both send email.

**Initial setup:** Open the Apps Script editor, select `installSchedule` from the function dropdown, click Run. Approve permissions. Verify two triggers in the Triggers panel: `runWritebackScheduled` daily at 6 AM, `canaryCheck` daily at 9 AM.

**If you see "job appears stuck" email:** Open the sheet → menu → *Show job status*. Compare `deletedSoFar` / `writtenSoFar` against totals to see where it stopped. Decide:
- *Continuation trigger died but job is still valid* → menu → *Run Writeback (Resumable)* to manually resume.
- *Something is fundamentally wrong* → menu → *Abort current job*. Investigate, fix, wait for tomorrow's schedule or run manually.

**If schema validation fails (email subject "Header Validation Failed"):** No deletes have happened. Open the mapping tab to see which sheet columns have no Monday match. Fix the source sheet or add the Monday columns, then wait for tomorrow.

**Manually running a small job:** Menu → *Run Writeback (Manual — small jobs)*. This uses the original non-resumable path, faster startup, no job state. Use for testing or small ad-hoc loads.

**Manually running a large job off-schedule:** Menu → *Run Writeback (Resumable — large jobs)*. Same code as scheduled runs.

**The script runs as whoever ran `installSchedule`.** If that account is deactivated, the schedule dies silently. The canary will not save you here — it would also be dead. Document who owns this, and re-run `installSchedule` from a service account or shared account if continuity matters.

---

## Sequencing recommendation

Apply Pass 1 alone first. Run a dry run, then a real run against a test board. Measure: how long does a 30k-row run actually take? If it fits in 30 minutes, stop here — Pass 2 is dead weight you don't need.

If Pass 1 alone doesn't fit, apply Pass 2. Test with a small board first (force the soft deadline low — set `SOFT_DEADLINE_MS` to 30 seconds temporarily — to verify continuations actually fire and resume correctly without needing to wait for a real 25-minute run).

Apply Pass 3 last. It's pure operational hardening; nothing in Passes 1 or 2 depends on it.

One last thing worth saying out loud: at 30k rows, the dry run becomes important in a new way. Before, it caught schema mismatches that would cost you a bad write. Now it also catches them *before* you've committed to a 2-hour delete-and-rewrite cycle that can't be undone. Push your colleague to actually run the dry run every time, not just the first time.



```javascript
SpreadsheetApp.getUi().alert(
  '⚠️ Dry run complete — review required',
  `${validation.missing.length} sheet column(s) have no match in Monday and will be DROPPED if you proceed:\n` +
  `  • ${validation.missing.join('\n  • ')}\n\n` +
  `${validation.unmatchedMonday.length > 0
    ? `${validation.unmatchedMonday.length} Monday column(s) have no source in the sheet and will be BLANK after writeback.\n\n`
    : ''}` +
  `No data was changed in Monday.\n\n` +
  `Next step: review the mapping tab (now open) and either fix the sheet headers or accept the drops before running the writeback.`,
  SpreadsheetApp.getUi().ButtonSet.OK
);
```

```javascript
const unmatched = validation.unmatchedMonday.length;
SpreadsheetApp.getUi().alert(
  unmatched > 0 ? '✅ Dry run complete — minor warnings' : '✅ Dry run complete',
  `All ${Object.keys(validation.mapping).length - 1} mapped sheet column(s) will write successfully.\n\n` +
  `${unmatched > 0
    ? `Note: ${unmatched} Monday column(s) have no sheet source and will be BLANK after writeback. This is expected if those columns are managed in Monday directly.\n\n`
    : ''}` +
  `No data was changed in Monday.\n\n` +
  `The ".dry_run_payload" tab (now open) shows the exact JSON each row will send.`,
  SpreadsheetApp.getUi().ButtonSet.OK
);
```
