# SDC — Invitations Webhook Integration Plan (v2, Apps Script + Workato)

## Status

Build-ready specification for the invitations workflow integration across Apps Script and Workato. Supersedes v1 of this plan.

**What changed from v1:**

- **Sync webhook response → fire-and-forget + polling.** The Workato workspace doesn't support synchronous webhook response bodies of substance; the design moved to a fire-and-forget POST + GAS-side polling of a Workato data table for results.
- **All-or-nothing → option 2 modulation.** Default behavior is "send to all invitable suppliers"; analyst-modulated behavior is "send to all invitable *except* the rows selected on `_suppliers`." Selection is an exclusion set.
- **`_suppliers` tab returns to v1 scope.** Required as the selection surface for exclusions. The `refreshSuppliers()` GAS function and tab creation logic, deferred in earlier iterations, are now part of v1.
- **DASH-01 and PRV-05 stay in v1 scope.** Both feed the `_suppliers` tab via `DASH_SuppliersStaging`.
- **New `INV_BatchResult` table** on the Workato side as the polling target.
- **No script property for "latest batch."** The latest batch is derived from `INV_BatchResult` filtered by `spreadsheet_id`. Survives workbook copy correctly.
- **Architecture: two tables, two purposes.** `DASH_SuppliersStaging` (state — current supplier state for the worklist view) and `INV_BatchResult` (events — per-supplier outcomes from a batch). Different shapes, different lifecycles, separate writers.

The Stage 4 verification milestone is unchanged: a real supplier user receives a real email with a working link, triggered by an analyst clicking a real menu item.

---

## Scope at a glance

**New Workato artifacts:**

| # | Artifact | Notes |
|---|---|---|
| W1 | `INV_BatchResult` data table | New table — polling target for batch results |
| W2 | `DASH_SuppliersStaging` data table | Per earlier design |
| W3 | `DASH-01` recipe | Single writer of `DASH_SuppliersStaging` |
| W4 | `PRV-05` recipe | Calls DASH-01 at end of provisioning |
| W5 | `R1` recipe (Issue invitation) | Webhook trigger, fire-and-forget, writes per-supplier rows to `INV_BatchResult` plus sentinel |
| W6 | PRV-04 wiring change | One async call to PRV-05 at end of E1 branch |

**Library changes (`as_lib.txt`):**

| # | File | Change |
|---|---|---|
| L1 | 000_Config.gs | Add `webhook.invitationsUrl` to Config.build |
| L2 | 003_Payload.gs | Add `Payload.invitations(args)` builder |
| L3 | New file: 004_Invitations.gs | New `Invitations` namespace with `sendBatch`, `pollBatch`, `checkLatestStatus`, `refreshSuppliers` |
| L4 | New file: 005_Dashboard.gs | Tab creation + render-from-staging helpers |

**Container changes (`as_container.txt`):**

| # | Change |
|---|---|
| C1 | Add `Send invitations`, `Check invitation status`, `Refresh suppliers` menu items |
| C2 | Add `sendInvitations()`, `checkInvitationStatus()`, `refreshSuppliers()` flow shims |
| C3 | Add `readSelectedSupplierRequestIds_()` (exclusion-set reader) |
| C4 | Update `flowTitle_` and `showsCorrelationId_` |
| C5 | Add `showInvitationResults_()` + HTML template |

**New file:** `invitation_results.html` (container).

---

## Architecture

### The two tables

| Table | Shape | Writer | Reader | Purpose |
|---|---|---|---|---|
| `DASH_SuppliersStaging` | State (one row per supplier, current state) | DASH-01 | GAS `refreshSuppliers()` | Pre-computed projection for the worklist view (`_suppliers` tab) |
| `INV_BatchResult` | Events (one row per supplier in a batch, plus sentinel) | R1 | GAS `pollBatch`, `checkLatestStatus` | Async batch result conveyance |

State and events are separated by design. Combining them creates a "denormalized cache that's also an audit trail" anti-pattern; the two cardinalities and lifecycles diverge over time.

### The flow

```
Analyst opens workbook
   → onOpen fires → refreshSuppliers() pulls from DASH_SuppliersStaging
                    → renders _suppliers tab

Analyst (optionally) selects rows to exclude, clicks "Send invitations"
   → GAS reads excluded supplier_request_ids from selected rows
   → GAS POSTs to R1: {batch_id, analyst_email, spreadsheet_id, exclude_supplier_request_ids}
   → R1 returns synchronous ack: {accepted: true, batch_id, candidate_count}
   → GAS shows progress dialog, enters polling loop

R1 (asynchronously)
   → Reads SUP_SupplierRequest for the engagement, filters to invitable
   → Removes excluded supplier_request_ids from the candidate list
   → Foreach candidates → INV-01
   → After each INV-01: writes one row to INV_BatchResult
   → After all done: calls DASH-01 to refresh DASH_SuppliersStaging
   → After staging refresh: writes sentinel row to INV_BatchResult

GAS polling loop
   → Every N seconds, queries INV_BatchResult by batch_id
   → If sentinel row present: pulls all rows for batch, renders modal
   → If timeout exceeded: surfaces "still processing, check later"

Analyst can later click "Check invitation status"
   → checkLatestStatus(ss) queries INV_BatchResult by spreadsheet_id, finds latest batch_id
   → Calls pollBatch(ss, batchId)
   → Renders modal if complete, "still processing" otherwise
```

### Why fire-and-forget + polling

Two reasons:

1. **Workspace constraint.** The Workato workspace does not support substantive synchronous webhook response bodies. Trying to return summary + per-supplier results synchronously was failing in environment testing.
2. **Honest modeling.** Even with synchronous response support, batches over ~15 suppliers risk webhook response timeout (typically 30s). Polling generalizes to any batch size without timeout concerns.

The cost is GAS-side polling complexity and the new `INV_BatchResult` table. Both are bounded and clean to implement.

---

## Workato side

### W1 — `INV_BatchResult` data table

New data table. Schema:

| Column | Type | Notes |
|---|---|---|
| `result_id` | UUID, PK | Workato standard |
| `batch_id` | string | Filter key for polling |
| `spreadsheet_id` | string | Filter key for "latest batch for this workbook" |
| `supplier_request_id` | string, nullable | The supplier this row reports on; null for sentinel |
| `supplier_name` | string, nullable | Denormalized for display; null for sentinel |
| `status` | string, nullable | Seven-value enum; null for sentinel |
| `assignee_email` | string, nullable | |
| `had_secondary_failures` | boolean, nullable | |
| `secondary_failure_count` | integer | Default 0 |
| `error_message` | string, nullable | |
| `is_sentinel` | boolean | True on the terminal row, false otherwise |
| `requested_count` | integer, nullable | On sentinel row: the total candidate count for this batch |
| `started_at` | datetime, nullable | On sentinel row: batch start time |
| `completed_at` | datetime, nullable | On sentinel row: batch end time |
| `created_at` | datetime | Row write time (for ordering) |

**Indexing.** Polling queries hit two patterns:
- `WHERE batch_id = ?` (during a single batch's polling)
- `WHERE spreadsheet_id = ? ORDER BY created_at DESC LIMIT 1` (finding the latest batch)

If Workato data tables support indexes, add them on `batch_id` and `(spreadsheet_id, created_at)`. If not, the polling frequency is bounded enough that table scans should remain acceptable for v1 volumes.

**Retention.** No automatic cleanup in v1. Volume is bounded (one row per supplier per batch; batches are infrequent). If the table grows past a comfortable size, a separate cleanup recipe can drop rows older than N days.

### W2 — `DASH_SuppliersStaging` data table

Per the v2 dashboard guide. Schema and substages unchanged. Recapping:

| Column | Type |
|---|---|
| `staging_row_id` | UUID, PK |
| `project_id` | string |
| `supplier_request_id` | string |
| `supplier_name` | string |
| `primary_user_email` | string, nullable |
| `primary_user_name` | string, nullable |
| `secondary_user_count` | integer |
| `supplier_display_status` | string |
| `current_state_entered_at` | datetime |
| `last_refreshed_at` | datetime |

### W3 — DASH-01 recipe

Per the v2 dashboard guide and the substage walkthrough we already did. Single input parameter (`template_version_id`), reads source tables, replaces all `DASH_SuppliersStaging` rows for the engagement.

No changes from the substage design we already settled.

### W4 — PRV-05 recipe

Per the substage walkthrough. Calls DASH-01 synchronously, emits `dashboard_initialized` on success or `recipe_failed` on failure.

No changes.

### W5 — R1 recipe (Issue invitation)

The substantive Workato build. Substage walkthrough revised for the async-write model.

#### Trigger

Webhook trigger. Payload schema:

```json
{
  "batch_id": "uuid",
  "analyst_email": "analyst@example.com",
  "spreadsheet_id": "1A2B3C...",
  "exclude_supplier_request_ids": ["uuid-1", "uuid-2"]
}
```

`exclude_supplier_request_ids` is required to be present but may be an empty array (the "send to all invitable" case).

Returns synchronous ack body:

```json
{
  "accepted": true,
  "batch_id": "uuid",
  "candidate_count": 17
}
```

`candidate_count` reflects the post-filter, post-exclusion count. This gives GAS a target for the progress display ("processing N of 17").

#### Substages

**1. Validate input.** Empty `batch_id`, empty `analyst_email`, empty `spreadsheet_id`, or malformed `exclude_supplier_request_ids` causes a 400 response with `accepted: false` and a reason. No HMAC in v1 (matches the existing Provision/Validate/Portal posture).

**2. Resolve project context.** Look up `Project` by `spreadsheet_id` (or by some other resolution — currently `Project` is a singleton in the workspace, so this is a single read). Capture `project_id`. Read the current published `CFG_TemplateVersion` for `template_version_id`.

**3. Build candidate list.** Read `SUP_SupplierRequest` filtered by `assigned_version_id = template_version_id`. Filter to invitable state (definition: `status = 'pending'` — adjust if your state model defines invitable differently). From this filtered list, remove the supplier_request_ids that appear in `exclude_supplier_request_ids`. The result is the candidate list.

**4. Return synchronous ack.** With `candidate_count = len(candidate_list)`. GAS now knows what to expect.

**5. Emit `invitation_triggered`** via OBS-01. Once, async. `details_json` carries `batch_id`, `analyst_email`, `candidate_count`, `excluded_count`.

**6. Foreach over candidate_list.**

For each supplier_request_id:

  - **6a. Call INV-01 (sync)** with `supplier_request_id`, `analyst_email`, `batch_id`.
  - **6b. Classify disposition.** Same Python step from earlier substage walkthrough — maps INV-01's return into one of the seven status values.
  - **6c. Create one row in `INV_BatchResult`** with the classification, `is_sentinel = false`, `batch_id`, `spreadsheet_id`, supplier details.

The foreach continues on per-supplier failure (per-supplier independence). If INV-01 throws (rather than returning a clean failure), the catch at the orchestrator level handles it — see substage 9.

**7. Resolve template_version_id for DASH-01.** Already captured in substage 2.

**8. Call DASH-01 (sync)** to refresh `DASH_SuppliersStaging`. By the time the sentinel is written, the worklist view reflects the post-batch state.

**9. Write the sentinel row to `INV_BatchResult`.** `is_sentinel = true`, `batch_id`, `spreadsheet_id`, `requested_count = candidate_count`, `started_at` and `completed_at` populated. All supplier-specific fields null.

The sentinel's presence is the single signal GAS uses to know the batch is fully done — both per-supplier results written AND DASH-01 staging refreshed.

**10. Emit per-supplier `invitation_sent` events.** This may already be happening inside INV-01; if not, R1 emits one per successful invitation here. Per-event surfacing is unchanged.

#### Error handling

If anything throws after substage 4 (after the synchronous ack is sent), R1 still needs to write a sentinel — GAS will be polling, and an absent sentinel means "still processing forever." The catch path:

```
[N] catch:
  [N+1] emit recipe_failed via OBS-01
  [N+2] write sentinel to INV_BatchResult with error context in details
        (sentinel still has is_sentinel=true; GAS can show a "batch failed midway" modal)
```

A failure sentinel lets GAS distinguish "batch completed cleanly" from "batch failed and stopped." The sentinel row gains optional `error_message` for this case.

### W6 — PRV-04 wiring change

One new block at the end of PRV-04's E1 branch: `call_recipe_async` to PRV-05 with the `template_version_id`. Per the earlier walkthrough.

E2 wiring is deferred per the earlier conversation.

---

## Library changes

### L1 — Config.build extension

**File:** `000_Config.gs`

In `Config.build`'s `webhook` block:

```js
webhook: {
  url:             get('webhook', 'fileExportUrl'),
  portalInviteUrl: get('webhook', 'portalInviteUrl'),
  validateUrl:     get('webhook', 'validateUrl'),
  invitationsUrl:  get('webhook', 'invitationsUrl')   // NEW
},
```

Companion workbook change: every workbook's `_developer_settings` tab needs a new row `webhook | invitationsUrl | <URL>`.

### L2 — Payload.invitations

**File:** `003_Payload.gs`, after `Payload.portalInvite`.

```js
/**
 * Build the invitations webhook payload (R1 — Issue Invitation).
 *
 * Wire format:
 *   batch_id                       — UUID; correlation across systems.
 *   analyst_email                  — The analyst initiating the batch.
 *   spreadsheet_id                 — The workbook's Google Sheets ID.
 *                                    Used for "latest batch for this workbook"
 *                                    queries downstream.
 *   exclude_supplier_request_ids   — Array of UUIDs to exclude from the
 *                                    invitable candidate list. May be empty
 *                                    (the "send to all invitable" case).
 *
 * @param {Object} args
 * @param {string}        args.batchId                      - UUID.
 * @param {string}        args.analystEmail                 - The analyst initiating.
 * @param {string}        args.spreadsheetId                - ss.getId().
 * @param {Array<string>} [args.excludeSupplierRequestIds]  - Optional; defaults to [].
 * @returns {Object} wire-format payload
 */
Payload.invitations = function(args) {
  Payload._requireArgs(args, ['batchId', 'analystEmail', 'spreadsheetId'], 'invitations');

  var excludeIds = Array.isArray(args.excludeSupplierRequestIds)
    ? args.excludeSupplierRequestIds
    : [];

  return {
    batch_id:                     args.batchId,
    analyst_email:                args.analystEmail,
    spreadsheet_id:               args.spreadsheetId,
    exclude_supplier_request_ids: excludeIds,
    timestamp:                    new Date().toISOString()
  };
};
```

### L3 — New file: 004_Invitations.gs

Four public functions. Each is small; the file as a whole is roughly 250 lines.

```js
/**
 * @file 004_Invitations.gs
 * Invitations orchestrator — the "Send invitations" flow.
 *
 * Two-phase architecture:
 *   Phase 1: sendBatch — POST to R1, get back the batch_id ack.
 *   Phase 2: pollBatch — query INV_BatchResult for the sentinel.
 *
 * Plus a convenience helper for "check latest batch for this workbook"
 * which derives the batch_id by querying INV_BatchResult by spreadsheet_id.
 *
 * Public:
 *   Invitations.sendBatch(ss, opts)         → Result (ack-shape)
 *   Invitations.pollBatch(ss, batchId)      → Result (in-progress or complete)
 *   Invitations.checkLatestStatus(ss)       → Result (same shape as pollBatch
 *                                              for the latest batch)
 *   Invitations.refreshSuppliers(ss)        → Result (pulls staging, renders _suppliers)
 */

var Invitations = {};

// --- Phase 1: send ---------------------------------------------------

/**
 * Send a batch invitation request. Returns quickly with an ack;
 * does NOT wait for batch completion.
 *
 * @param {Spreadsheet} ss
 * @param {Object}        opts
 * @param {Array<string>} [opts.excludeSupplierRequestIds]  - Optional exclusion list.
 * @returns {Object} Result with data: {batchId, candidateCount}
 */
Invitations.sendBatch = function(ss, opts) {
  if (!ss) throw new Error('Invitations.sendBatch: ss is required.');
  opts = opts || {};

  var batchId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, batchId);
  log('INFO', 'Starting invitations batch (batch_id: ' + batchId + ')...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    Stage.run('preflight', function() {
      Invitations._preflight(config);
    });

    var analystEmail = Util.getActiveUserEmail('');
    if (!analystEmail) {
      var emailErr = new Error(
        'Could not resolve your email address. Ensure you are signed in.'
      );
      emailErr.stage = 'identity';
      throw emailErr;
    }

    var payload = Payload.invitations({
      batchId:                   batchId,
      analystEmail:              analystEmail,
      spreadsheetId:             ss.getId(),
      excludeSupplierRequestIds: opts.excludeSupplierRequestIds || []
    });

    var webhookResponse = Stage.run('webhook', function() {
      return Webhook.call(config.webhook.invitationsUrl, payload);
    });

    var parsed = webhookResponse.parsed;
    if (!parsed || parsed.accepted !== true) {
      var rejErr = new Error(
        (parsed && parsed.error) || 'Invitations webhook did not accept the batch.'
      );
      rejErr.stage = 'webhook-rejected';
      throw rejErr;
    }

    var candidateCount = parsed.candidate_count || 0;
    log('INFO', 'Invitations batch accepted: ' + candidateCount + ' candidate(s).');

    return Result.ok({
      flow:          'invitations',
      correlationId: batchId,
      message:       'Batch accepted: processing ' + candidateCount + ' invitation(s).',
      data: {
        batchId:        batchId,
        candidateCount: candidateCount,
        phase:          'sent'
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Invitations sendBatch failed at ' + stage + ': ' + e.message);

    return Result.fail({
      flow:          'invitations',
      correlationId: batchId,
      message:       'Failed to send invitations at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Phase 2: poll ---------------------------------------------------

/**
 * Poll INV_BatchResult for a specific batch. Returns one of three shapes:
 *   - In progress (no sentinel yet): Result.ok with data.phase='processing'
 *                                     and data.processedCount
 *   - Complete (sentinel present):   Result.ok with data.phase='complete',
 *                                     data.summary, data.results
 *   - Not found (no rows):           Result.ok with data.phase='not_found'
 *
 * @param {Spreadsheet} ss
 * @param {string}      batchId
 * @returns {Object} Result
 */
Invitations.pollBatch = function(ss, batchId) {
  if (!ss)      throw new Error('Invitations.pollBatch: ss is required.');
  if (!batchId) throw new Error('Invitations.pollBatch: batchId is required.');

  try {
    var rows = fetchDataTableRecords(INV_BATCH_RESULT_TABLE_ID, {
      where: { batch_id: batchId },
      order: { by: '$created_at', order: 'asc' },
      limit: 1000
    });

    if (!rows || rows.length === 0) {
      return Result.ok({
        flow:          'invitations',
        correlationId: batchId,
        message:       'Batch not yet started — Workato has not written any rows.',
        data:          { batchId: batchId, phase: 'not_found' }
      });
    }

    var sentinel = rows.find(function(r) { return r.is_sentinel === true; });
    if (!sentinel) {
      // In progress
      return Result.ok({
        flow:          'invitations',
        correlationId: batchId,
        message:       'Processing... ' + rows.length + ' supplier(s) completed so far.',
        data: {
          batchId:        batchId,
          phase:          'processing',
          processedCount: rows.length
        }
      });
    }

    // Complete — compose summary and per-supplier results
    var perSupplier = rows.filter(function(r) { return !r.is_sentinel; });
    var summary     = Invitations._tally(perSupplier, sentinel);

    return Result.ok({
      flow:          'invitations',
      correlationId: batchId,
      message:       Invitations._formatSummaryMessage(summary),
      data: {
        batchId:     batchId,
        phase:       'complete',
        summary:     summary,
        results:     perSupplier,
        startedAt:   sentinel.started_at,
        completedAt: sentinel.completed_at,
        errored:     !!sentinel.error_message,
        errorContext: sentinel.error_message || null
      }
    });
  } catch (e) {
    return Result.fail({
      flow:          'invitations',
      correlationId: batchId,
      message:       'Failed to poll batch status: ' + e.message,
      error:         e
    });
  }
};

// --- Convenience: check latest batch for this workbook ---------------

/**
 * Find the most recent batch for the workbook and return its status.
 * Identifies the batch by querying INV_BatchResult filtered by
 * spreadsheet_id, ordered desc by created_at, limit 1.
 *
 * @param {Spreadsheet} ss
 * @returns {Object} Result — same shape as pollBatch when a batch exists;
 *                   Result with data.phase='no_batches' when none found.
 */
Invitations.checkLatestStatus = function(ss) {
  if (!ss) throw new Error('Invitations.checkLatestStatus: ss is required.');

  try {
    var latest = fetchDataTableRecords(INV_BATCH_RESULT_TABLE_ID, {
      where: { spreadsheet_id: ss.getId() },
      order: { by: '$created_at', order: 'desc' },
      limit: 1
    });

    if (!latest || latest.length === 0) {
      return Result.ok({
        flow:    'invitations',
        message: 'No invitation batches found for this workbook.',
        data:    { phase: 'no_batches' }
      });
    }

    return Invitations.pollBatch(ss, latest[0].batch_id);
  } catch (e) {
    return Result.fail({
      flow:    'invitations',
      message: 'Failed to check latest invitation status: ' + e.message,
      error:   e
    });
  }
};

// --- Suppliers tab refresh ------------------------------------------

/**
 * Pull DASH_SuppliersStaging for this workbook's project, render to
 * the _suppliers tab. Creates the tab if absent.
 *
 * The project_id is derived from the workbook's spreadsheet_id by
 * querying DASH_SuppliersStaging — every row carries project_id, so
 * we can find ours without an explicit script property.
 *
 * Note: if no rows exist (provisioning hasn't run yet, or the staging
 * table is empty), the function renders an empty tab with a friendly
 * message in row 2.
 *
 * @param {Spreadsheet} ss
 * @returns {Object} Result
 */
Invitations.refreshSuppliers = function(ss) {
  if (!ss) throw new Error('Invitations.refreshSuppliers: ss is required.');

  try {
    var spreadsheetId = ss.getId();

    // Step 1: find this workbook's project_id from any staging row that
    // carries our spreadsheet_id. This depends on PRV-05 having stamped
    // spreadsheet_id onto the staging rows it writes — see W3 note below.
    var sampleRows = fetchDataTableRecords(DASH_SUPPLIERS_STAGING_TABLE_ID, {
      where: { spreadsheet_id: spreadsheetId },
      limit: 1
    });

    if (!sampleRows || sampleRows.length === 0) {
      Dashboard.renderEmptyTab(ss);
      return Result.ok({
        flow:    'invitations',
        message: 'No suppliers staged yet. Run provisioning to populate the worklist.',
        data:    { phase: 'empty' }
      });
    }

    var projectId = sampleRows[0].project_id;

    // Step 2: pull all rows for this project, render to the tab
    var allRows = fetchDataTableRecords(DASH_SUPPLIERS_STAGING_TABLE_ID, {
      where: { project_id: projectId },
      order: { by: 'supplier_name', order: 'asc' },
      limit: 500
    });

    Dashboard.renderSuppliersTab(ss, allRows);

    return Result.ok({
      flow:    'invitations',
      message: 'Refreshed ' + allRows.length + ' supplier(s).',
      data:    { phase: 'refreshed', rowCount: allRows.length }
    });
  } catch (e) {
    return Result.fail({
      flow:    'invitations',
      message: 'Failed to refresh suppliers: ' + e.message,
      error:   e
    });
  }
};

// --- Private helpers -------------------------------------------------

Invitations._preflight = function(config) {
  if (!config.webhook.invitationsUrl) {
    var err = new Error(
      'Invitations URL not configured. ' +
      'Check _developer_settings → webhook.invitationsUrl.'
    );
    err.stage = 'preflight';
    throw err;
  }
};

Invitations._tally = function(perSupplier, sentinel) {
  var counts = {
    requested:          sentinel.requested_count || perSupplier.length,
    invited:            0,
    partial:            0,
    already_invited:    0,
    skipped_state:      0,
    skipped_no_primary: 0,
    assignee_failed:    0,
    system_errored:     0
  };

  perSupplier.forEach(function(r) {
    var s = r.status;
    if (s === 'invited')                              counts.invited++;
    else if (s === 'invited_with_partial_failures') { counts.invited++; counts.partial++; }
    else if (s === 'already_invited')                 counts.already_invited++;
    else if (s === 'skipped_state')                   counts.skipped_state++;
    else if (s === 'skipped_no_primary')              counts.skipped_no_primary++;
    else if (s === 'assignee_failed')                 counts.assignee_failed++;
    else                                              counts.system_errored++;
  });

  return counts;
};

Invitations._formatSummaryMessage = function(s) {
  var parts = [];
  if (s.invited)            parts.push(s.invited + ' invited');
  if (s.partial)            parts.push(s.partial + ' with partial failures');
  if (s.already_invited)    parts.push(s.already_invited + ' already invited');
  if (s.skipped_no_primary) parts.push(s.skipped_no_primary + ' skipped (no primary)');
  if (s.skipped_state)      parts.push(s.skipped_state + ' skipped (state)');
  if (s.assignee_failed)    parts.push(s.assignee_failed + ' failed');
  if (s.system_errored)     parts.push(s.system_errored + ' errored');
  if (parts.length === 0)   return 'No invitations processed.';
  return parts.join(', ') + '.';
};

// --- Constants -------------------------------------------------------

// These should ideally come from _developer_settings or a config block,
// not be hardcoded. Listed here for clarity during build; move to Config
// during integration.
var INV_BATCH_RESULT_TABLE_ID       = '<populate during build>';
var DASH_SUPPLIERS_STAGING_TABLE_ID = '<populate during build>';
```

**Note on table IDs:** these should be read from `_developer_settings`, not hardcoded. Lean: add a `tables` section to `Config.build`'s return shape alongside `webhook` and `sharing`, so per-workbook table IDs are configurable.

**Note on `spreadsheet_id` in `DASH_SuppliersStaging`:** the schema I sketched earlier didn't include `spreadsheet_id`. It needs to. Add one column to `DASH_SuppliersStaging` so `Invitations.refreshSuppliers` can find the workbook's rows without an explicit project_id lookup. DASH-01 stamps it on every row it writes.

### L4 — New file: 005_Dashboard.gs

Renders staging rows to the `_suppliers` tab. Lives in the library because the rendering logic is reusable (and matches the existing pattern of library-owned data manipulation, container-owned UI dialogs).

```js
/**
 * @file 005_Dashboard.gs
 * Renders DASH_SuppliersStaging rows to the _suppliers tab.
 * Creates the tab if absent. Hides the action-ID column.
 *
 * Public:
 *   Dashboard.renderSuppliersTab(ss, rows)
 *   Dashboard.renderEmptyTab(ss)
 *   Dashboard.ensureSuppliersTab(ss) → Sheet
 */

var Dashboard = {};

var SUPPLIERS_TAB_NAME = '_suppliers';
var SUPPLIERS_HEADERS = [
  'Supplier',
  'Primary contact email',
  'Primary contact name',
  'Other users',
  'Status',
  'State entered',
  'Action ID'  // last column, hidden after render
];
var ACTION_ID_COL_INDEX = 7;  // 1-based

Dashboard.ensureSuppliersTab = function(ss) {
  var sheet = ss.getSheetByName(SUPPLIERS_TAB_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(SUPPLIERS_TAB_NAME);
  sheet.getRange(1, 1, 1, SUPPLIERS_HEADERS.length)
       .setValues([SUPPLIERS_HEADERS])
       .setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.hideColumns(ACTION_ID_COL_INDEX);
  return sheet;
};

Dashboard.renderSuppliersTab = function(ss, rows) {
  var sheet = Dashboard.ensureSuppliersTab(ss);

  // Clear existing data rows (preserve header)
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, SUPPLIERS_HEADERS.length).clearContent();
  }

  if (!rows || rows.length === 0) {
    sheet.getRange(2, 1).setValue('(no suppliers staged)');
    return;
  }

  var data = rows.map(function(r) {
    return [
      r.supplier_name || '',
      r.primary_user_email || '',
      r.primary_user_name || '',
      Dashboard._formatSecondaryCount(r.secondary_user_count),
      r.supplier_display_status || '',
      Dashboard._formatStateEntered(r.supplier_display_status, r.current_state_entered_at),
      r.supplier_request_id || ''   // hidden column
    ];
  });

  sheet.getRange(2, 1, data.length, SUPPLIERS_HEADERS.length).setValues(data);
  sheet.autoResizeColumns(1, SUPPLIERS_HEADERS.length - 1);  // skip the hidden one
  sheet.hideColumns(ACTION_ID_COL_INDEX);  // re-hide in case it was un-hidden
};

Dashboard.renderEmptyTab = function(ss) {
  Dashboard.renderSuppliersTab(ss, []);
};

// --- Private helpers ------------------------------------------------

Dashboard._formatSecondaryCount = function(count) {
  if (!count || count === 0) return '—';
  if (count === 1) return 'and 1 other';
  return 'and ' + count + ' others';
};

Dashboard._formatStateEntered = function(status, isoString) {
  if (!isoString) return '';
  var date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  var label = status ? status + ' since ' : '';
  return label + Utilities.formatDate(date, Session.getScriptTimeZone(), 'M/d');
};
```

About 80 lines. Idempotent: `ensureSuppliersTab` is safe to call repeatedly; the rendering logic clears and rewrites cleanly.

---

## Container changes

### C1 — Menu items

In `onOpen`, replace the existing menu section with:

```js
var menu = ui.createMenu('Supplier data collection')
  .addItem('Start supplier data collection', 'initializeWorkspace')
  .addItem('Update configuration',           'updateWorkspace')
  .addSeparator()
  .addItem('Validate configuration',         'validateConfiguration')
  .addSeparator()
  .addItem('Refresh suppliers',              'refreshSuppliers')     // NEW
  .addItem('Send invitations',               'sendInvitations')      // NEW
  .addItem('Check invitation status',        'checkInvitationStatus') // NEW
  .addSeparator()
  .addItem('Request portal access',          'requestPortalAccess')
  .addSeparator()
  .addItem('Set up field IDs',               'setupPrimaryKeyColumns');
```

Plus auto-refresh on workbook open: at the end of `onOpen`, after the menu is added:

```js
// Auto-refresh _suppliers tab if it exists (no-op for workbooks
// where provisioning hasn't run yet)
try {
  SDC.Invitations.refreshSuppliers(ss);
} catch (e) {
  // Refresh failure should not block the menu installation
  // — analyst can manually click "Refresh suppliers"
  Log.recordSimple(ss, 'WARNING', 'Auto-refresh suppliers failed: ' + e.message);
}
```

### C2 — Flow shims

```js
/**
 * Manual refresh of the _suppliers tab. Also fires on onOpen.
 */
function refreshSuppliers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Refreshing suppliers...', 'Status');
  var r = SDC.Invitations.refreshSuppliers(ss);
  ss.toast('');
  showResult_(r);
}

/**
 * Invitations flow with polling. Two-phase: phase 1 sends, phase 2 polls
 * until the sentinel appears or polling times out.
 */
function sendInvitations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  // Read exclusion list from selection (empty if no rows selected)
  var excludeIds = readSelectedSupplierRequestIds_();

  // Confirmation
  var confirmMsg = excludeIds.length === 0
    ? 'Send invitations to all invitable suppliers?'
    : 'Send invitations to all invitable suppliers EXCEPT ' +
      excludeIds.length + ' selected? (Selected suppliers will be skipped.)';

  var confirm = ui.alert('Send invitations', confirmMsg, ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  // Phase 1: send
  ss.toast('Sending invitations request...', 'Status');
  var sendResult = SDC.Invitations.sendBatch(ss, {
    excludeSupplierRequestIds: excludeIds
  });

  if (!sendResult.ok) {
    ss.toast('');
    showResult_(sendResult);
    return;
  }

  var batchId = sendResult.data.batchId;
  var candidateCount = sendResult.data.candidateCount;

  if (candidateCount === 0) {
    ss.toast('');
    ui.alert('Nothing to do',
             'No invitable suppliers (none in pending state, or all were excluded).',
             ui.ButtonSet.OK);
    return;
  }

  // Phase 2: poll
  ss.toast('Processing ' + candidateCount + ' invitation(s)...', 'Status');
  var pollResult = pollBatchUntilComplete_(ss, batchId, candidateCount);
  ss.toast('');

  // Render
  if (pollResult.ok && pollResult.data && pollResult.data.phase === 'complete') {
    showInvitationResults_(pollResult);
  } else if (pollResult.ok && pollResult.data && pollResult.data.phase === 'processing') {
    // Timed out during polling
    ui.alert(
      'Still processing',
      'Invitations are still being processed in Workato.\n\n' +
      'Click "Check invitation status" in a few minutes to see results.\n\n' +
      'Batch ID: ' + batchId,
      ui.ButtonSet.OK
    );
  } else {
    showResult_(pollResult);
  }
}

/**
 * Check the latest invitation batch for this workbook.
 * Used when polling timed out, or the analyst is checking back later.
 */
function checkInvitationStatus() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Checking invitation status...', 'Status');
  var r = SDC.Invitations.checkLatestStatus(ss);
  ss.toast('');

  if (r.ok && r.data && r.data.phase === 'complete') {
    showInvitationResults_(r);
  } else {
    showResult_(r);
  }
}
```

### C3 — Helpers: polling loop and selection reader

```js
/**
 * Poll INV_BatchResult for the given batch until the sentinel appears
 * or the polling budget is exhausted. Caller (sendInvitations) handles
 * the rendering decision based on the returned phase.
 *
 * Polling schedule:
 *   - First 30 seconds: poll every 3 seconds
 *   - Next 4.5 minutes:  poll every 10 seconds
 *   - Total budget: 5 minutes (well inside Apps Script's 6-minute limit)
 *
 * @returns {Object} Result with data.phase = 'complete' | 'processing' | 'not_found'
 */
function pollBatchUntilComplete_(ss, batchId, expectedCount) {
  var FAST_INTERVAL_MS    = 3 * 1000;
  var SLOW_INTERVAL_MS    = 10 * 1000;
  var FAST_PHASE_BUDGET_MS = 30 * 1000;
  var TOTAL_BUDGET_MS     = 5 * 60 * 1000;

  var startTime = Date.now();
  var lastResult = null;

  while (Date.now() - startTime < TOTAL_BUDGET_MS) {
    lastResult = SDC.Invitations.pollBatch(ss, batchId);

    if (!lastResult.ok) return lastResult;
    if (lastResult.data && lastResult.data.phase === 'complete') return lastResult;

    var elapsed = Date.now() - startTime;
    var sleepMs = elapsed < FAST_PHASE_BUDGET_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;

    // Update toast for progress visibility
    if (lastResult.data && typeof lastResult.data.processedCount === 'number') {
      ss.toast(
        'Processing... ' + lastResult.data.processedCount + ' of ' + expectedCount + ' completed.',
        'Status'
      );
    }

    Utilities.sleep(sleepMs);
  }

  return lastResult || Result.fail({
    flow:    'invitations',
    message: 'Polling timed out with no response.'
  });
}

/**
 * Read supplier_request_id values from selected rows on _suppliers.
 * In option 2 semantics, these are EXCLUSIONS — suppliers the analyst
 * wants to skip in the batch. Empty array = "no exclusions".
 *
 * Defends against:
 *   - wrong active sheet (returns empty — caller treats as "no exclusions")
 *   - empty selection (returns empty)
 *   - header row in selection
 *   - non-UUID values
 */
function readSelectedSupplierRequestIds_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== '_suppliers') return [];

  var range = sheet.getActiveRange();
  if (!range) return [];

  var startRow = range.getRow();
  var numRows  = range.getNumRows();
  var ACTION_ID_COL = 7;

  var values = sheet.getRange(startRow, ACTION_ID_COL, numRows, 1).getValues();

  var uuidRe = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
  var seen = {};
  var out  = [];

  values.forEach(function(row) {
    var v = String(row[0] || '').trim();
    if (uuidRe.test(v) && !seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  });

  return out;
}
```

### C4 — flowTitle_ and showsCorrelationId_

```js
function flowTitle_(flow) {
  switch (flow) {
    case 'provision':       return 'Provision';
    case 'validate':        return 'Validation';
    case 'portalInvite':    return 'Portal invite';
    case 'invitations':     return 'Invitations';      // NEW
    case 'primaryKeySetup': return 'Field ID setup';
    case 'migration':       return 'Schema migration';
    default:                return 'Operation';
  }
}

function showsCorrelationId_(flow) {
  return flow === 'provision' || flow === 'validate'
      || flow === 'portalInvite' || flow === 'invitations';   // NEW
}
```

### C5 — Modal and HTML template

```js
function showInvitationResults_(result) {
  var template = HtmlService.createTemplateFromFile('invitation_results');
  template.summary     = result.data.summary;
  template.results     = result.data.results;
  template.batchId     = result.correlationId;
  template.startedAt   = result.data.startedAt;
  template.completedAt = result.data.completedAt;
  template.errored     = !!result.data.errored;
  template.errorContext= result.data.errorContext || null;

  var html = template.evaluate()
    .setWidth(720)
    .setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, 'Invitation results');
}
```

`invitation_results.html` (new file in container):

- Header: "Invitation results — batch <code><?= batchId ?></code>"
- If `errored`, a red banner: "Batch halted with error: <?= errorContext ?>"
- Summary block: seven counters as pill-shaped indicators (green/amber/red by category)
- Table: one row per `results` entry — columns Supplier | Status | Email | Note
- Footer: started_at → completed_at, formatted duration

Roughly 60 lines.

---

## Build order

1. **Workato tables (W1, W2).** Schema work, no behavior yet.
2. **Workato recipes — DASH-01 (W3), PRV-05 (W4), R1 (W5), PRV-04 wiring (W6).** Build in dependency order: DASH-01 first (no dependencies), then PRV-05 + PRV-04 wiring (E1 path works end-to-end), then R1 against test data.
3. **Library — L1 (Config), L2 (Payload).** Pure-data changes, testable in isolation.
4. **Library — L4 (Dashboard).** Tab rendering, testable manually.
5. **Library — L3 (Invitations).** All four functions; test each against the Workato side.
6. **Container — C1-C5.** Wire up menus, shims, modal.
7. **Integration testing.** Run the five pre-positioned tests:
   - Happy path, single supplier
   - Multi-user supplier
   - Assignee failure with secondary success
   - Idempotency double-click
   - Re-invite refusal
8. **Stage 4 verification.** Real supplier user receives real email with working link.

---

## Open items carried forward

- **HMAC signing for the invitations webhook.** Deferred per existing posture; revisit if security review pushes back.
- **Bulk insert API shape** for `INV_BatchResult`. R1 may want to batch-write multiple rows at once for efficiency. Discover during R1 build.
- **Workato data tables indexing.** If `INV_BatchResult` grows large and polling slows, add indexes on `batch_id` and `(spreadsheet_id, created_at)`. Defer until observed.
- **MARS RC dependent-dropdown remediation.** Tracked separately; not in this scope.
- **E2 (config update) provisioning path.** Deferred per the Stage 3 ADR-039/046 discussion. PRV-04's E2 branch needs supplier-staging work before PRV-05 can fire on E2.

---

## Files modified, files added

| File | Modified | Added |
|---|---|---|
| `as_lib.txt: 000_Config.gs` | yes | |
| `as_lib.txt: 003_Payload.gs` | yes | |
| `as_lib.txt: 004_Invitations.gs` | | yes |
| `as_lib.txt: 005_Dashboard.gs` | | yes |
| `as_container.txt` | yes | |
| `invitation_results.html` (container) | | yes |
| Workato: `INV_BatchResult` table | | yes |
| Workato: `DASH_SuppliersStaging` table | | yes |
| Workato: DASH-01 recipe | | yes |
| Workato: PRV-05 recipe | | yes |
| Workato: R1 recipe | | yes |
| Workato: PRV-04 recipe | yes (one block) | |
| Every workbook's `_developer_settings` | yes (one row + table IDs) | |

Approximately 400 lines of new GAS code, 60 lines of HTML, plus the Workato recipe and table work.
