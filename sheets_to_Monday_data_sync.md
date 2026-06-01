Here's the full ingest path, written so it works with the resumable scaffolding you already have. Since you haven't told me yet about the key column or upsert-vs-drop-and-swap decision, I've written this to be **configurable** — you set the behavior in the Configuration tab, the code reads it at runtime. That way you can experiment without rewriting.

I'll give you three new functions plus a small config addition and one menu wiring change. Everything else stays as-is.

## Config keys to add

In the Configuration tab, add these rows:

| Key | Value | Notes |
|---|---|---|
| `monday_group_id` | `topics` (or whatever) | Run `listBoardGroups` once to find valid IDs |
| `ingest_match_behaviour` | `UPSERT` or `INSERT_ONLY` | Verify exact enum values against current docs — these are the documented behaviours; if your account exposes others (e.g. `UPDATE_ONLY`), they go here |
| `ingest_match_column_id` | e.g. `text_mkj9abc` | The Monday column ID to match on; required only for UPSERT. Find via `getMondaySchema_` output or your mapping tab |
| `monday_api_version_ingest` | `2026-07` | Pinned for the ingest path only |

The version-per-path key matters: it lets you keep your existing pipeline on `2025-10` (stable) while pointing only the ingest mutation at `2026-07` (RC). One foot on each pier until 2026-07 promotes to current.

## Function 1: The main ingest writeback

```javascript
// --- INGEST WRITEBACK (uses 2026-07 ingest_items) ----------------------------
function runWritebackIngest() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    logToAuditSheet('WARN', 'Another writeback is already running. Aborting.', 'runWritebackIngest', true);
    return;
  }

  let config;
  try {
    config = getAppConfig_();
  } catch (e) {
    logToAuditSheet('ERROR', `Config load failed: ${e.message}`, 'runWritebackIngest', true);
    lock.releaseLock();
    return;
  }

  const boardId = config.monday_board_id;
  const groupId = config.monday_group_id;
  const tag = `Target:${boardId} (ingest)`;

  // Preflight: required config
  if (!boardId || !groupId) {
    const msg = `Missing required config: monday_board_id=${boardId}, monday_group_id=${groupId}`;
    logToAuditSheet('ERROR', msg, tag, true);
    sendAlertEmail_(config, 'Ingest writeback FAILED', msg);
    lock.releaseLock();
    return;
  }

  const behaviour = String(config.ingest_match_behaviour || 'INSERT_ONLY').toUpperCase();
  if (behaviour === 'UPSERT' && !config.ingest_match_column_id) {
    const msg = 'ingest_match_behaviour=UPSERT requires ingest_match_column_id in config.';
    logToAuditSheet('ERROR', msg, tag, true);
    sendAlertEmail_(config, 'Ingest writeback FAILED', msg);
    lock.releaseLock();
    return;
  }

  try {
    logToAuditSheet('INFO', `Starting ingest writeback. behaviour=${behaviour}`, tag);

    // --- Step 1: Fetch schema and validate ---
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

    // --- Step 2: Build CSV ---
    const csv = buildIngestCsv_(data, validation.mapping, mondaySchema);
    logToAuditSheet('INFO', `CSV built: ${data.length - 1} rows, ${csv.length} bytes.`, tag);

    // --- Step 3: Start ingest job ---
    const jobInfo = startIngestJob_(config, boardId, groupId, behaviour, tag);
    logToAuditSheet('INFO', `Ingest job started: job_id=${jobInfo.job_id}`, tag);

    // --- Step 4: Upload CSV to pre-signed URL (10-min window) ---
    uploadIngestCsv_(jobInfo.upload_url, csv, tag);
    logToAuditSheet('INFO', `CSV uploaded. Now polling for completion.`, tag);

    // --- Step 5: Poll until done ---
    const finalStatus = pollIngestJob_(config, jobInfo.job_id, tag);

    // --- Step 6: Report ---
    if (finalStatus.state === 'COMPLETED' || finalStatus.state === 'SUCCESS') {
      logToAuditSheet('SUCCESS', `Ingest complete. ${JSON.stringify(finalStatus)}`, tag, true);
      sendAlertEmail_(config, 'Ingest writeback completed',
        `Board: ${boardId}\nRows: ${data.length - 1}\nFinal status: ${JSON.stringify(finalStatus, null, 2)}`);
    } else if (finalStatus.state === 'TIMEOUT_POLLING') {
      // Job is still running on Monday's side; we just stopped watching
      logToAuditSheet('WARN', `Polling timed out. Job ${jobInfo.job_id} may still be running on Monday.`, tag, true);
      PropertiesService.getScriptProperties().setProperty('PENDING_INGEST_JOB', jobInfo.job_id);
      sendAlertEmail_(config, 'Ingest polling timeout',
        `Job ${jobInfo.job_id} did not complete within polling budget. Job continues on Monday's side. ` +
        `Use checkPendingIngestJob() to resume polling.`);
    } else {
      throw new Error(`Ingest job failed: ${JSON.stringify(finalStatus)}`);
    }

  } catch (e) {
    logToAuditSheet('ERROR', `Ingest writeback failed: ${e.message}\n${e.stack || ''}`, tag, true);
    sendAlertEmail_(config, 'Ingest writeback FAILED',
      `Execution ID: ${EXECUTION_ID}\nError: ${e.message}\nStack: ${e.stack || '(none)'}`);
  } finally {
    flushAuditLogs();
    lock.releaseLock();
  }
}
```

## Function 2: The four building blocks

These do the actual work. Each is small and single-purpose so you can test them in isolation.

```javascript
// --- INGEST: BUILD CSV -------------------------------------------------------
function buildIngestCsv_(data, mapping, mondaySchema) {
  const sheetHeaders = data[0];
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

// --- INGEST: START JOB -------------------------------------------------------
function startIngestJob_(config, boardId, groupId, behaviour, tag) {
  let mutation;
  if (behaviour === 'UPSERT') {
    mutation = `
      mutation {
        ingest_items(
          board_id: "${boardId}"
          group_id: "${groupId}"
          on_match: { behaviour: UPSERT, match_column_id: "${config.ingest_match_column_id}" }
        ) { job_id upload_url }
      }
    `;
  } else {
    // INSERT_ONLY or whatever the docs name "no match" — verify the exact enum
    mutation = `
      mutation {
        ingest_items(
          board_id: "${boardId}"
          group_id: "${groupId}"
          on_match: { behaviour: ${behaviour} }
        ) { job_id upload_url }
      }
    `;
  }

  // Use the pinned ingest API version, NOT the default
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

// --- INGEST: UPLOAD CSV ------------------------------------------------------
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

// --- INGEST: POLL JOB STATUS -------------------------------------------------
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
      logToAuditSheet('WARN', `Malformed poll response: ${JSON.stringify(body).substring(0, 300)}`, tag);
      delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
      continue;
    }

    logToAuditSheet('INFO', `Poll: state=${status.state}, processed=${status.rows_processed || '?'}, failed=${status.rows_failed || '?'}`, tag);

    // Terminal states — verify exact enum values against current Monday docs
    const terminal = ['COMPLETED', 'SUCCESS', 'FAILED', 'ERROR', 'CANCELLED'];
    if (terminal.includes(status.state)) {
      return status;
    }

    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
  }

  return { state: 'TIMEOUT_POLLING', message: 'Apps Script polling budget exhausted.' };
}
```

## Function 3: Recovery for the timeout case

```javascript
// --- INGEST: RESUME POLLING AFTER TIMEOUT ------------------------------------
function checkPendingIngestJob() {
  const config = getAppConfig_();
  const jobId = PropertiesService.getScriptProperties().getProperty('PENDING_INGEST_JOB');
  if (!jobId) {
    SpreadsheetApp.getUi().alert('No pending ingest job.');
    return;
  }

  const tag = `Pending:${jobId}`;
  logToAuditSheet('INFO', `Resuming polling for job ${jobId}.`, tag);

  try {
    const status = pollIngestJob_(config, jobId, tag);
    if (status.state === 'TIMEOUT_POLLING') {
      SpreadsheetApp.getUi().alert(`Job ${jobId} still running. Check again later.`);
    } else {
      PropertiesService.getScriptProperties().deleteProperty('PENDING_INGEST_JOB');
      logToAuditSheet('SUCCESS', `Pending job ${jobId} resolved: ${JSON.stringify(status)}`, tag, true);
      SpreadsheetApp.getUi().alert(`Job ${jobId} resolved.\n\n${JSON.stringify(status, null, 2)}`);
    }
  } catch (e) {
    logToAuditSheet('ERROR', `Resume polling failed: ${e.message}`, tag, true);
    SpreadsheetApp.getUi().alert(`Error: ${e.message}`);
  }
}
```

## Menu wiring

Add to `onOpen`:

```javascript
.addItem('Run Writeback (Ingest API — 2026-07 RC)', 'runWritebackIngest')
.addItem('Resume pending ingest job', 'checkPendingIngestJob')
```

## What this gets you, and what to watch

The whole write phase is now: build CSV (fast, local), one mutation (slot), one upload (one HTTP call), and a polling loop that respects exponential backoff. For 30k rows this should finish well inside a single execution. The resumable scaffolding becomes irrelevant for the *write* — if you're doing UPSERT you don't need the truncate phase either, and the entire job is essentially a single Apps Script execution again.

A few things to verify against current docs before relying on this in production:

The exact enum value for "insert without matching" — I used `INSERT_ONLY` as a placeholder. The docs example I saw only showed UPSERT explicitly. Probe with a small test board and try `INSERT_ONLY`, then `INSERT`, then look at what the schema introspection returns for the `OnMatchBehaviour` enum:

```javascript
function introspectOnMatchEnum() {
  const config = getAppConfig_();
  const query = `query { __type(name: "OnMatchBehaviour") { enumValues { name } } }`;
  // (the actual type name may differ; introspect Mutation.ingest_items first to find it)
  const resp = UrlFetchApp.fetch(config.mondayUrl, {
    method: 'post',
    headers: { Authorization: config.mondayApiKey, 'Content-Type': 'application/json', 'API-Version': '2026-07' },
    payload: JSON.stringify({ query }),
    muteHttpExceptions: true
  });
  console.log(resp.getContentText());
}
```

The terminal state names — I guessed `COMPLETED`, `SUCCESS`, `FAILED`, `ERROR`, `CANCELLED`. The actual enum might use a subset or different names. Same introspection pattern works on the job status type.

The `fetch_job_status` field selection — I asked for `state`, `error`, `rows_processed`, `rows_failed`. Some of those field names are educated guesses. If a field doesn't exist, the whole query 400s. Run one introspection on the job status type and update the selection to match what's actually exposed.

One small structural thing worth pointing out: I deliberately did not unify this with the existing job-state model from Pass 2. The ingest path's "job" lives on Monday's side and only needs a `job_id` string to resume; the resumable batched path's "job" lives in your Script Properties as a rich record with progress counters. Conflating them would add ceremony for no benefit. Two parallel paths, two parallel state mechanisms, each fit-for-purpose. If the ingest path proves itself over a few runs, you can eventually delete the resumable scaffolding entirely — but not before.

The cleanest test sequence: introspect the enums first to fix the guesses, run with a 10-row test sheet against a throwaway board to verify the happy path, then run against a real board with a few hundred rows before pointing the daily schedule at it. Don't switch the scheduled trigger from `runWritebackScheduled` → `runWritebackIngest` until you've watched a full real-volume run complete end-to-end.
