Right — that closes Path A and the decision collapses to group-swap. Good outcome in a way, because group-swap is genuinely the cleaner architecture for "no stable key, full-refresh semantics, item IDs are disposable." You're not settling for it; it's the right fit for the actual constraints.

Let me give you the complete, production-ready group-swap implementation. This pulls together the ingest helpers I wrote earlier with the group-management functions and ties everything to your existing config and audit infrastructure. One file's worth of additions.

## Config keys

In the Configuration tab:

| Key | Value | Notes |
|---|---|---|
| `monday_api_version_ingest` | `2026-07` | Pin the RC version for ingest only |
| `ingest_match_column_id` | any indexed column ID (e.g. `name`) | Required by the API, behaviorally a no-op since target is empty |
| `writeback_group_prefix` | `writeback_` | The convention that distinguishes script-created groups from human ones |
| `writeback_group_keep_days` | `14` | Reaper threshold |

The `writeback_match_column_id` honestly defaults safely to `"name"` since every board has it and it's always indexed. You could even hardcode it and skip the config key. I left it configurable in case Monday ever changes which columns are eligible.

## The main function

```javascript
// --- GROUP-SWAP WRITEBACK ----------------------------------------------------
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
    sendAlertEmail_(config, 'Group-swap writeback FAILED', 'Missing monday_board_id.');
    lock.releaseLock();
    return;
  }

  try {
    logToAuditSheet('INFO', `Starting group-swap writeback.`, tag);

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
    // (We snapshot first so the new group doesn't accidentally land in the "to archive" list.)
    const oldGroupIds = listWritebackGroupIds_(config, boardId, tag);
    logToAuditSheet('INFO', `Found ${oldGroupIds.length} existing writeback group(s) to archive after success.`, tag);

    // --- Step 3: Create the new group ---
    const newGroupTitle = buildWritebackGroupTitle_(config);
    newGroupId = createGroup_(config, boardId, newGroupTitle, tag);
    logToAuditSheet('INFO', `Created new group "${newGroupTitle}" → ${newGroupId}`, tag);

    // --- Step 4: Build CSV and start ingest ---
    const csv = buildIngestCsv_(data, validation.mapping, mondaySchema);
    logToAuditSheet('INFO', `CSV built: ${data.length - 1} rows, ${csv.length} bytes.`, tag);

    // Match column is required by API but behaviorally a no-op since target group is empty.
    // SKIP is the honest choice here: we want pure insert, no surprises if anything matches.
    const matchColId = config.ingest_match_column_id || 'name';
    const jobInfo = startIngestJob_(config, boardId, newGroupId, 'SKIP', matchColId, tag);
    logToAuditSheet('INFO', `Ingest job started: ${jobInfo.job_id}`, tag);

    // --- Step 5: Upload CSV (10-minute window) ---
    uploadIngestCsv_(jobInfo.upload_url, csv, tag);
    logToAuditSheet('INFO', `CSV uploaded. Polling for completion.`, tag);

    // --- Step 6: Poll until terminal state ---
    const finalStatus = pollIngestJob_(config, jobInfo.job_id, tag);

    // --- Step 7: Branch on outcome ---
    if (finalStatus.state === 'COMPLETED' || finalStatus.state === 'SUCCESS') {
      // Success: archive (NOT delete) old groups. Trash gives 30-day undo regardless.
      let archived = 0;
      let archiveFailures = 0;
      for (const oldId of oldGroupIds) {
        try {
          archiveGroup_(config, boardId, oldId, tag);
          archived++;
        } catch (e) {
          archiveFailures++;
          logToAuditSheet('WARN', `Failed to archive old group ${oldId}: ${e.message}`, tag);
        }
      }
      logToAuditSheet('SUCCESS',
        `Group-swap complete. New: ${newGroupId} ("${newGroupTitle}"). Archived ${archived}/${oldGroupIds.length} old group(s).`,
        tag, true);
      sendAlertEmail_(config, 'Group-swap writeback completed',
        `Board: ${boardId}\nNew group: ${newGroupTitle} (${newGroupId})\nRows: ${data.length - 1}\n` +
        `Archived: ${archived}/${oldGroupIds.length}\n` +
        (archiveFailures > 0 ? `Archive failures: ${archiveFailures} (see audit log)\n` : '') +
        `\nFinal job status:\n${JSON.stringify(finalStatus, null, 2)}`);
      newGroupId = null; // success: clear the cleanup flag

    } else if (finalStatus.state === 'TIMEOUT_POLLING') {
      // Job continues on Monday's side. Don't archive old groups — we don't know if ingest succeeded.
      // Persist enough state for a recovery function to resume.
      PropertiesService.getScriptProperties().setProperty('PENDING_GROUP_SWAP', JSON.stringify({
        jobId: jobInfo.job_id,
        newGroupId: newGroupId,
        oldGroupIds: oldGroupIds,
        boardId: boardId,
        startedAt: new Date().toISOString()
      }));
      logToAuditSheet('WARN',
        `Polling timed out. Job ${jobInfo.job_id} may still be running. State preserved for resume.`,
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
        logToAuditSheet('WARN', `Cleanup of new group ${newGroupId} failed: ${cleanupErr.message}. Manual cleanup may be needed.`, tag, true);
      }
    }

    sendAlertEmail_(config, 'Group-swap writeback FAILED',
      `Execution ID: ${EXECUTION_ID}\nError: ${e.message}\nStack: ${e.stack || '(none)'}`);
  } finally {
    flushAuditLogs();
    lock.releaseLock();
  }
}
```

## Group management helpers

```javascript
// --- GROUP MANAGEMENT --------------------------------------------------------
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
```

## Updated `startIngestJob_`

Replace the earlier version with this one — it now takes `behaviour` and `matchColId` as explicit parameters rather than reading them from config, which keeps the call site honest about what's being requested:

```javascript
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
```

(The earlier `buildIngestCsv_`, `uploadIngestCsv_`, and `pollIngestJob_` stay exactly as I wrote them in the previous ingest message — no changes needed.)

## The polling-timeout recovery

This handles the case where Apps Script ran out of budget but Monday's job kept going. The `runWritebackGroupSwap` already stashed the state; this function resumes:

```javascript
// --- GROUP-SWAP: RECOVERY ----------------------------------------------------
function resumePendingGroupSwap() {
  const raw = PropertiesService.getScriptProperties().getProperty('PENDING_GROUP_SWAP');
  if (!raw) {
    SpreadsheetApp.getUi().alert('No pending group-swap.');
    return;
  }
  const pending = JSON.parse(raw);
  const config = getAppConfig_();
  const tag = `Resume:${pending.jobId}`;

  logToAuditSheet('INFO', `Resuming pending group-swap. job=${pending.jobId} newGroup=${pending.newGroupId}`, tag);

  try {
    const finalStatus = pollIngestJob_(config, pending.jobId, tag);

    if (finalStatus.state === 'COMPLETED' || finalStatus.state === 'SUCCESS') {
      // Ingest succeeded after all — finish the swap by archiving old groups.
      let archived = 0;
      for (const oldId of pending.oldGroupIds) {
        try { archiveGroup_(config, pending.boardId, oldId, tag); archived++; }
        catch (e) { logToAuditSheet('WARN', `Archive of ${oldId} failed: ${e.message}`, tag); }
      }
      PropertiesService.getScriptProperties().deleteProperty('PENDING_GROUP_SWAP');
      logToAuditSheet('SUCCESS', `Resumed group-swap completed. Archived ${archived}/${pending.oldGroupIds.length}.`, tag, true);
      SpreadsheetApp.getUi().alert(`Resumed and completed. Archived ${archived} old group(s).`);

    } else if (finalStatus.state === 'TIMEOUT_POLLING') {
      logToAuditSheet('INFO', `Resume still timing out. State preserved.`, tag, true);
      SpreadsheetApp.getUi().alert(`Job ${pending.jobId} still running. Try again later.`);

    } else {
      // Ingest failed. Delete the new group; leave old groups alone.
      try { deleteGroup_(config, pending.boardId, pending.newGroupId, tag); }
      catch (e) { logToAuditSheet('WARN', `Cleanup of ${pending.newGroupId} failed: ${e.message}`, tag); }
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
```

## The reaper

Runs on its own schedule, completely independent of the writeback. Hard-deletes archived writeback groups older than the keep threshold:

```javascript
// --- GROUP-SWAP: REAPER (runs on its own weekly schedule) --------------------
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
    // Fallback: fetch all groups, filter on archived flag client-side
    logToAuditSheet('INFO', `Archived-only query failed (${e.message}); falling back to full fetch.`, tag);
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
      logToAuditSheet('WARN', `Archived group "${g.title}" matches prefix but has no parseable date. Skipping.`, tag);
      skipped++;
      continue;
    }
    const groupDate = new Date(match[1]);
    if (groupDate < cutoff) {
      try {
        deleteGroup_(config, boardId, g.id, tag);
        logToAuditSheet('INFO', `Reaped: ${g.title} (${g.id})`, tag);
        reaped++;
      } catch (e) {
        logToAuditSheet('WARN', `Failed to reap ${g.id}: ${e.message}`, tag);
      }
    } else {
      skipped++;
    }
  }

  logToAuditSheet('INFO', `Reaper complete. Reaped ${reaped}, skipped ${skipped}.`, tag, true);
  flushAuditLogs();
}
```

## Menu wiring

```javascript
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Sheets to Monday Writeback')
      .addItem('1. Run Dry Run (Validate & Preview)', 'runDryRun')
      .addSeparator()
      .addItem('2. Run Writeback (Group-swap, recommended)', 'runWritebackGroupSwap')
      .addItem('Resume pending group-swap', 'resumePendingGroupSwap')
      .addSeparator()
      .addItem('Reap archived writeback groups now', 'reapArchivedWritebackGroups')
      .addSeparator()
      .addItem('— Legacy —', 'noop_')
      .addItem('Run Writeback (Manual — single-pass)', 'runWriteback')
      .addItem('Run Writeback (Resumable — large jobs)', 'runWritebackResumable')
      .addItem('Show job status', 'showJobStatus')
      .addItem('Abort current job', 'abortJob')
      .addToUi();
  } catch (_) {}
}

function noop_() {}
```

## Schedule installation

Update `installSchedule` to add the reaper:

```javascript
function installSchedule() {
  // Writeback handler — point at the new group-swap function
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runWritebackScheduled')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runWritebackScheduled')
    .timeBased().everyDays(1).atHour(6).create();

  // Canary (unchanged)
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'canaryCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('canaryCheck')
    .timeBased().everyDays(1).atHour(9).create();

  // Reaper — weekly is plenty; daily would also be fine but unnecessary
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'reapArchivedWritebackGroups')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('reapArchivedWritebackGroups')
    .timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();

  logToAuditSheet('INFO', 'Schedule installed: writeback daily 6am, canary daily 9am, reaper Sunday 3am.', 'installSchedule', true);
}
```

And update `runWritebackScheduled` to call the group-swap version:

```javascript
function runWritebackScheduled() {
  logToAuditSheet('INFO', `Scheduled trigger fired.`, 'runWritebackScheduled');
  try {
    runWritebackGroupSwap();
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

---

## A few things worth knowing about this design before you ship it

**The naming convention is load-bearing.** `listWritebackGroupIds_` and the reaper both decide what to touch based on the title prefix. If a human renames a `writeback_*` group to something else, the script will never archive or reap it — it'll just sit there forever. Conversely, if a human *creates* a group starting with `writeback_`, the script will eventually archive it. Worth a comment on the board itself, or in the handoff doc: "Groups starting with `writeback_` are managed by an automated script — do not rename or create groups with this prefix manually."

**The cleanup branch in the main function is the most important error-handling code in the whole file.** If ingest fails after the new group was created, the new group has to be deleted or you've polluted the board with an empty (or worse, half-populated) group. The `newGroupId = null` assignments after success and after timeout-with-recovery are doing real work — they tell the catch block "don't clean this up, we either succeeded or we're handing it off." If you ever refactor this, that signaling has to stay correct.

**The timeout case is fundamentally different from the failure case.** On timeout, we don't know whether ingest succeeded — Monday is still working. So we *don't* archive old groups (no premature swap) and we *don't* delete the new group (it might be a perfectly good fresh dataset). We just stash state and wait. That's why the timeout branch sets `newGroupId = null` (so the catch doesn't auto-delete it) and writes to `PENDING_GROUP_SWAP` (so the recovery function can finish the job). Three distinct outcomes — success, timeout, hard failure — get three distinct behaviors. None of them collapse into the others without consequences.

**The reaper has a subtle interaction with the writeback.** If a writeback runs while the reaper is mid-flight, and they touch overlapping groups, you could get weird states. The lock service in `runWritebackGroupSwap` doesn't protect the reaper because they don't share a lock. Easiest fix if you're paranoid: have the reaper also acquire the same script lock. Probably overkill for weekly+daily on different hours, but worth knowing.

**One thing I'd recommend testing before trusting this in production:** run it twice in a row against a small test board, confirming that the *second* run successfully archives the first run's group. The `listWritebackGroupIds_` → create new → archive old flow is the whole story, and bugs in it are easy to write and hard to spot in a single-run test. Two consecutive runs prove the lifecycle works.

This is the cleanest version of the architecture I can produce given the constraints. I'd encourage running it end-to-end on a test board first, verifying the timeout-recovery path manually (set `POLL_TIMEOUT_MS` low and watch it stash state, then run `resumePendingGroupSwap`), and then pointing the daily schedule at it once you've watched a real-volume run succeed.
