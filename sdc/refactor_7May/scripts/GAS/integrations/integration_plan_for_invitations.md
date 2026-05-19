# SDC — Invitations Webhook Integration Plan (Apps Script side)

## Status

Build-ready specification for the Apps Script changes needed to integrate the new `R1 — Issue Invitation` webhook. Companion to the v2 Dashboard Recipe Builder Guide; covers steps 5 of the dashboard build order (GAS-side send invitations + Stage 4 verification) from the Apps Script angle specifically.

The pattern follows the three flows already established in the library: Provision, Validate, Portal. Invitations becomes the fourth flow in the same shape — same orchestrator layout, same Result-and-Webhook plumbing, same container shim convention.

This plan does **not** cover:

- The `R1` webhook recipe on the Workato side (covered by v2 dashboard guide).
- The `_suppliers` tab structure or its initial population (DASH-01 / PRV-05, already specified).
- The `refreshSuppliers()` GAS function or the `onOpen` menu install for the dashboard (separate task).
- HMAC verification — see "Deferred decisions" at the end.

---

## Scope at a glance

**Library changes (`as_lib.txt`):**

| # | File | Change | Lines (approx) |
|---|---|---|---|
| L1 | 000_Config.gs | Add `webhook.invitationsUrl` to Config.build return shape | +1 |
| L2 | 003_Payload.gs | Add `Payload.invitations(args)` builder | +35 |
| L3 | New file: 004_Invitations.gs | New `Invitations` namespace with `.run(ss, opts)` | +120 |
| L4 | 000_Util.gs (optional) | Add `Util.newBatchId()` helper, or reuse `Util.newCorrelationId()` | +0–8 |
| L5 | 008_Version.gs | Decide whether to bump `SDC_PAYLOAD_VERSION` | 0 or 1 |

**Container changes (`as_container.txt`):**

| # | Change | Lines (approx) |
|---|---|---|
| C1 | Add `Send invitations` menu item to `onOpen` | +1 |
| C2 | Add `sendInvitations()` flow shim | +15 |
| C3 | Add `readSelectedSupplierRequestIds_()` private helper | +30 |
| C4 | Update `flowTitle_` switch with `'invitations'` case | +1 |
| C5 | Update `showsCorrelationId_` to include `'invitations'` | +1 |
| C6 | Add `showInvitationResults_()` and HTML template | +60 |

**New file:** `validate_results.html` exists in the container today (referenced from `showValidationResults_`); a parallel `invitation_results.html` joins it.

---

## Library changes

### L1 — Config.build: add `webhook.invitationsUrl`

**File:** `000_Config.gs` (Config namespace, ~line 22)

**Where:** Inside `Config.build`'s return value, in the `webhook` block (~line 62):

```js
webhook: {
  url:             get('webhook', 'fileExportUrl'),
  portalInviteUrl: get('webhook', 'portalInviteUrl'),
  validateUrl:     get('webhook', 'validateUrl'),
  invitationsUrl:  get('webhook', 'invitationsUrl')   // NEW
},
```

**Companion workbook change:** every workbook's `_developer_settings` tab needs a new row:

| category | key | value |
|---|---|---|
| webhook | invitationsUrl | `https://...webhook URL...` |

This is the equivalent of how `portalInviteUrl` and `validateUrl` are configured. Workbooks deployed before R1 lands will need this row added; the migration system in `Migrations.gs` may be the right place to do it automatically — see "Migration consideration" below.

**Test:** Open a workbook with the new row populated, call `SDC.Config.build(ss)`, inspect `config.webhook.invitationsUrl`. Should match the configured value.

---

### L2 — Payload.invitations builder

**File:** `003_Payload.gs` (Payload namespace, after `Payload.portalInvite` around line 1306)

The builder follows the existing pattern at lines 1258 (`Payload.provision`), 1289 (`Payload.validate`), and 1306 (`Payload.portalInvite`).

```js
// --- Invitations -----------------------------------------------------

/**
 * Build the invitations webhook payload (R1 — Issue Invitation contract).
 *
 * Wire format:
 *   batch_id              — UUID minted client-side, propagated to every
 *                            invitation_sent event for batch correlation.
 *                            Distinct from correlation_id (which is per-recipe-run
 *                            on the Workato side).
 *   supplier_request_ids  — array of UUIDs identifying the SUP_SupplierRequest
 *                            rows to invite. Order is preserved; R1 returns
 *                            per-supplier results in the same order.
 *   analyst_email         — the analyst initiating the batch.
 *
 * @param {Object} args
 * @param {string}        args.batchId              - UUID; the batch identifier.
 * @param {Array<string>} args.supplierRequestIds   - Non-empty list of UUID strings.
 * @param {string}        args.analystEmail         - The analyst initiating.
 * @returns {Object} wire-format payload
 */
Payload.invitations = function(args) {
  Payload._requireArgs(args, ['batchId', 'supplierRequestIds', 'analystEmail'],
                       'invitations');

  if (!Array.isArray(args.supplierRequestIds) || args.supplierRequestIds.length === 0) {
    throw new Error('Payload.invitations: "supplierRequestIds" must be a non-empty array.');
  }

  return {
    batch_id:             args.batchId,
    supplier_request_ids: args.supplierRequestIds,
    analyst_email:        args.analystEmail,
    timestamp:            new Date().toISOString()
  };
};
```

**Why not reuse `correlationId`:** the existing builders use `correlation_id` for cross-system correlation of one recipe execution. R1 is one batch driving N INV-01 executions; `batch_id` is the right name and means the right thing (the batch, not any single INV-01 run). The Workato side stamps `batch_id` into each `invitation_sent` event's `details_json` for downstream queryability.

**The required-args check** uses the existing `Payload._requireArgs` helper, which treats `null`/`undefined`/blank string as missing but accepts `false` and `0`. Good for booleans; here we additionally need the array-type-and-non-empty check, hence the second guard.

**Test:** Call `Payload.invitations({batchId: 'x', supplierRequestIds: ['a', 'b'], analystEmail: 'a@b.com'})`, confirm output shape. Call with missing fields, confirm it throws the expected error.

---

### L3 — Invitations namespace (new file)

**File:** New `004_Invitations.gs`

This is the bulk of the work. Mirrors `004_Portal.gs` in structure — same orchestrator pattern, same try/catch with stage tagging, same Result composition. Differences from Portal:

- Takes a payload-shaping opts argument (`supplierRequestIds`), where Portal derives its inputs purely from `ss`.
- Mints a new batch_id; doesn't recover one from logs.
- Parses a richer response shape (summary + per-supplier results) before returning Result.
- Carries that response shape through to the container in `Result.data` for HTML modal rendering.

Full body:

```js
/**
 * @file 004_Invitations.gs
 * Invitations orchestrator — the "Send invitations" flow.
 *
 * Pipeline:
 *   Config.build → Invitations._preflight →
 *   Payload.invitations → Webhook.call →
 *   Result with summary+results in data
 *
 * Returns a canonical Result; container handles UI. batch_id is generated
 * up-front so every log line and the eventual webhook payload share one
 * tracing ID, even if the flow fails mid-pipeline.
 *
 * Public:
 *   Invitations.run(ss, opts) → Result
 */

var Invitations = {};

/**
 * @param {Spreadsheet} ss
 * @param {Object}      opts
 * @param {Array<string>} opts.supplierRequestIds  - Required; non-empty array
 *                                                     of UUID strings, sourced
 *                                                     from the GAS menu selection
 *                                                     on _suppliers.
 * @returns {Object} canonical Result
 */
Invitations.run = function(ss, opts) {
  if (!ss) throw new Error('Invitations.run: ss is required.');
  if (!opts || !Array.isArray(opts.supplierRequestIds) || opts.supplierRequestIds.length === 0) {
    throw new Error('Invitations.run: opts.supplierRequestIds is required and must be a non-empty array.');
  }

  // Mint batch_id up-front so log lines and the payload share it,
  // even if the flow fails mid-pipeline. See Provision/Portal for the
  // same pattern (those use correlationId).
  var batchId = Util.newCorrelationId();   // UUID; reuse existing generator
  var log = Log.forCorrelation(ss, batchId);

  log('INFO', 'Starting invitations batch (batch_id: ' + batchId +
              ', count: ' + opts.supplierRequestIds.length + ')...');

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
        'Could not resolve your email address. Ensure you are signed in with a Google account.'
      );
      emailErr.stage = 'identity';
      throw emailErr;
    }

    var payload = Payload.invitations({
      batchId:             batchId,
      supplierRequestIds:  opts.supplierRequestIds,
      analystEmail:        analystEmail
    });

    var webhookResponse = Stage.run('webhook', function() {
      return Webhook.call(config.webhook.invitationsUrl, payload);
    });

    // Parse the structured response. R1 returns:
    //   { ok, batch_id, started_at, completed_at, summary, results }
    var parsed = webhookResponse.parsed;
    if (!parsed) {
      var parseErr = new Error(
        'Invitations webhook returned a non-JSON body. ' +
        'Cannot render per-supplier results.'
      );
      parseErr.stage = 'response-parse';
      throw parseErr;
    }
    if (parsed.ok === false) {
      var rejErr = new Error(parsed.error || 'Invitations webhook rejected the batch.');
      rejErr.stage = 'webhook-rejected';
      throw rejErr;
    }

    var summary = parsed.summary || {};
    log('INFO',
      'Invitations batch complete: ' +
      (summary.invited || 0) + ' invited, ' +
      (summary.partial || 0) + ' partial, ' +
      (summary.already_invited || 0) + ' already invited, ' +
      (summary.skipped_no_primary || 0) + ' skipped (no primary), ' +
      (summary.assignee_failed || 0) + ' failed.'
    );

    return Result.ok({
      flow:          'invitations',
      correlationId: batchId,
      message:       Invitations._formatSummary(summary),
      data: {
        summary: summary,
        results: parsed.results || [],
        startedAt:   parsed.started_at,
        completedAt: parsed.completed_at
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Invitations failed at ' + stage + ': ' + e.message);

    return Result.fail({
      flow:          'invitations',
      correlationId: batchId,
      message:       'Invitations failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------

/**
 * Ad-hoc preflight for the invitations flow. Lighter than Preflight.run
 * because we are not serializing config or sharing files — we just need
 * the invitations webhook URL configured.
 *
 * Throws on first failure with a stage-tagged Error.
 */
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

/**
 * Compose the short message that goes in Result.message. The HTML modal
 * shows the full per-supplier breakdown; this is the one-sentence summary.
 */
Invitations._formatSummary = function(summary) {
  var parts = [];
  if (summary.invited)            parts.push(summary.invited + ' invited');
  if (summary.partial)            parts.push(summary.partial + ' with partial failures');
  if (summary.already_invited)    parts.push(summary.already_invited + ' already invited');
  if (summary.skipped_no_primary) parts.push(summary.skipped_no_primary + ' skipped (no primary)');
  if (summary.skipped_state)      parts.push(summary.skipped_state + ' skipped (state)');
  if (summary.assignee_failed)    parts.push(summary.assignee_failed + ' failed');
  if (summary.system_errored)     parts.push(summary.system_errored + ' errored');

  if (parts.length === 0) {
    return 'No invitations processed.';
  }
  return parts.join(', ') + '.';
};
```

**Notes on design choices:**

- **`batchId` is generated with `Util.newCorrelationId()`.** Both are UUIDs; the type is the same, the name is what differs by context. Avoiding a new `Util.newBatchId` keeps the code surface minimal. The log line and the payload field name both use "batch_id" so the abstraction stays clear at the surface even though the underlying generator is shared.
- **The parsed-response check is defensive.** A non-JSON body or `ok: false` from R1 is treated as a flow failure. The catch path surfaces the error and the batch_id (which by then has already been logged at INFO level), so the analyst can correlate.
- **`Result.data.summary` and `Result.data.results`** carry the full response shape through to the container. The container's `showInvitationResults_` (C6) reads from these. The compact `Result.message` is the headline for `showResult_` callers if HTML rendering isn't available.

**Test:** Wire to a stub webhook returning a known response, call `Invitations.run(ss, {supplierRequestIds: ['fake-uuid']})`, confirm Result shape. Wire to a 4xx response, confirm `recipe_failed` flow.

---

### L4 — Util.newBatchId (optional; skip per above)

If you'd prefer the name `batchId` to look distinct from `correlationId` at the call site, add a thin wrapper:

```js
Util.newBatchId = function() {
  return Util.newCorrelationId();
};
```

Otherwise skip. Above plan calls `Util.newCorrelationId()` directly.

---

### L5 — Version: payload version decision

**File:** `008_Version.gs`

Question: does adding a new webhook endpoint warrant a `SDC_PAYLOAD_VERSION` bump?

The existing version bumps in the codebase (per the Payload.provision comments at line 1199) were format changes on existing endpoints — renames, additions to existing payload shapes. A new endpoint with its own payload shape doesn't change any existing endpoint's contract, so existing workbooks talking to existing webhooks still work fine.

**Lean: no bump.** New endpoint, additive change. Existing workbooks that don't have the invitations webhook configured simply can't trigger the new flow; everything else stays the same.

If you do bump it later because of a downstream change, update the doc comment on `Webhook.call` to reflect what the new version adds.

---

## Container changes

### C1 — Menu item

**File:** `as_container.txt`, `onOpen()`, the `menu.createMenu(...)` chain (~line 30):

Insert one line:

```js
var menu = ui.createMenu('Supplier data collection')
  .addItem('Start supplier data collection', 'initializeWorkspace')
  .addItem('Update configuration',           'updateWorkspace')
  .addSeparator()
  .addItem('Validate configuration',         'validateConfiguration')
  .addSeparator()
  .addItem('Request portal access',          'requestPortalAccess')
  .addItem('Send invitations',               'sendInvitations')   // NEW
  .addSeparator()
  .addItem('Set up field IDs',               'setupPrimaryKeyColumns');
```

Positioned next to "Request portal access" because both are outward-facing analyst-initiated workflows.

### C2 — sendInvitations shim

Add after `requestPortalAccess` (~line 90):

```js
/**
 * Invitations flow. Reads selected rows from _suppliers, posts the
 * supplier_request_ids to R1, renders the response summary in a modal.
 */
function sendInvitations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var supplierRequestIds = readSelectedSupplierRequestIds_();
  if (supplierRequestIds.length === 0) {
    SpreadsheetApp.getUi().alert(
      'No suppliers selected',
      'Switch to the _suppliers tab and select one or more rows ' +
      'before clicking Send invitations.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }

  ss.toast('Sending ' + supplierRequestIds.length + ' invitation(s)...', 'Status');
  var r = SDC.Invitations.run(ss, { supplierRequestIds: supplierRequestIds });
  ss.toast('');

  // Rich modal when structured data is present; fall back to standard alert.
  if (r.ok && r.data && r.data.results) {
    showInvitationResults_(r);
  } else {
    showResult_(r);
  }
}
```

### C3 — Selection-reading helper

The selection-reading logic is a UI concern (interacts with the active range, the active sheet, knows about column positions) and belongs in the container, not the library. The library only sees the resulting array.

Add to the container's helper section (near `flowTitle_`):

```js
/**
 * Read supplier_request_id values from the analyst's current selection
 * on the _suppliers tab. Defends against:
 *   - wrong sheet active
 *   - empty selection
 *   - header row in selection
 *   - non-UUID values in the action column
 *   - duplicate rows in the selection
 *
 * @returns {Array<string>} UUID strings; may be empty.
 */
function readSelectedSupplierRequestIds_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== '_suppliers') {
    return [];   // caller surfaces the "no rows" message
  }

  var range = sheet.getActiveRange();
  if (!range) return [];

  var startRow = range.getRow();
  var numRows  = range.getNumRows();

  // Action ID column. Matches the hidden column G we render in DASH-01.
  // If the column layout in _suppliers changes, this constant moves with it.
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

**Note on `ACTION_ID_COL`:** column 7 (column G) is the hidden action-ID column from the dashboard guide's `_suppliers` layout. If that layout changes, this constant moves. Keeping it in the container next to its use is fine; if it ever becomes referenced in multiple places, promote to a shared constants block.

### C4 — flowTitle_ update

Add the case to the existing switch (~line 215):

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
```

### C5 — showsCorrelationId_ update

Add `'invitations'` to the truthy list (~line 230):

```js
function showsCorrelationId_(flow) {
  return flow === 'provision' || flow === 'validate'
      || flow === 'portalInvite' || flow === 'invitations';   // NEW
}
```

Invitations is a Workato-talking flow with a meaningful correlation ID (the batch_id), so the analyst should see it in the result alert when the rich modal isn't shown.

### C6 — showInvitationResults_ and HTML template

Mirrors `showValidationResults_` (~line 197) in the same shape — `HtmlService.createTemplateFromFile`, set width/height, show modal:

```js
/**
 * Render invitations summary + per-supplier results in a modal dialog.
 * Template lives in the container so workbooks can rebrand without
 * library changes.
 */
function showInvitationResults_(result) {
  var template = HtmlService.createTemplateFromFile('invitation_results');
  template.summary    = result.data.summary;
  template.results    = result.data.results;
  template.batchId    = result.correlationId;
  template.startedAt  = result.data.startedAt;
  template.completedAt= result.data.completedAt;

  var html = template.evaluate()
    .setWidth(720)
    .setHeight(520);

  SpreadsheetApp.getUi().showModalDialog(html, 'Invitation results');
}
```

**HTML template (`invitation_results.html`):** new file in the container. Conceptually:

- Header: "Invitation results — batch <code><?= batchId ?></code>"
- Summary block: the seven counters as a row of pill-shaped indicators (green/amber/red by category)
- Table: one row per result, columns Supplier | Status | Email | Note (error_message)
- Footer: started_at → completed_at timing

About 60 lines of HTML/CSS, modeled on whatever `validate_results.html` looks like today. Worth co-designing with the validation modal so the two have a coherent visual language.

---

## Migration consideration

Workbooks deployed before this work landed don't have `webhook.invitationsUrl` in their `_developer_settings`. Three options for handling this:

**A. Manual.** Document the new row in the rollout notes; analysts add it to existing workbooks one at a time. Simplest, but slow if there are many workbooks.

**B. Library migration.** Add a migration step to `Migrations.gs` that, when run, ensures the `webhook.invitationsUrl` row exists in `_developer_settings` and is populated from a known-good value stored elsewhere (script property? hardcoded constant?). The migration menu already exists in `as_container.txt` (the conditional "Migrate workbook schema..." item); this would be a new step in the migration chain.

**C. Lazy.** `Invitations._preflight` already fails with a friendly message ("Invitations URL not configured. Check _developer_settings → webhook.invitationsUrl.") when the URL is missing. Analysts who try to use the new menu item on an old workbook see the message and add the row. No upfront work; the gap surfaces only when needed.

**Lean: C (lazy) for now, with the analyst-facing message being the migration prompt.** A is too manual for any nontrivial deployment; B is the right answer when you have several workbooks and a known good URL to migrate them to, but until then the lazy approach surfaces the problem cleanly without bulk migration logic.

If you do go with B eventually, it slots cleanly into the existing `Migrations` namespace.

---

## Build order

Five steps. Each is independently testable.

### Step 1: Library — Config.build extension + Payload.invitations

Land L1 (Config.build) and L2 (Payload.invitations). These have no dependencies and can ship in any order. Verify in isolation:

- `Config.build(ss)` returns `webhook.invitationsUrl` correctly when the row is present, returns `null` when absent.
- `Payload.invitations({...})` returns the correct wire shape for valid args, throws for missing/empty args.

No integration with R1 needed yet — these are pure-data changes.

### Step 2: Library — Invitations.run

Land L3 (the new file). Wire to a stub webhook that returns a hardcoded R1-shaped response. Verify:

- Happy path: `Invitations.run(ss, {supplierRequestIds: ['fake-uuid']})` returns `Result.ok` with the expected shape, including `data.summary` and `data.results`.
- Missing URL: with `webhook.invitationsUrl` blank, returns `Result.fail` with the preflight error message.
- Webhook rejection: with the stub returning `{ok: false, error: 'test'}`, returns `Result.fail` with the rejection message.
- Webhook 5xx: with the stub returning 500, the existing `Webhook.call` retry machinery exercises; eventually returns `Result.fail` after exhausting retries.

### Step 3: Container — selection helper + sendInvitations shim + menu

Land C1, C2, C3, C4, C5. The selection logic is testable in isolation by manually setting up rows on `_suppliers` and calling `readSelectedSupplierRequestIds_()` from the script editor. The shim is testable end-to-end against the stub webhook from step 2.

### Step 4: Container — HTML modal

Land C6 and the `invitation_results.html` template. The modal renders any pre-canned `Result.data.summary` / `Result.data.results` shape; can be tested by hardcoding sample data into a one-off test function.

### Step 5: Integrate against real R1

Switch the webhook URL from the stub to real R1. Run the five pre-positioned tests from the v2 dashboard guide:

1. Happy path, single supplier.
2. Multi-user supplier (one primary, two secondaries).
3. Assignee failure with secondary success.
4. Idempotency double-click.
5. Re-invite refusal.

After all five pass, the Stage 4 verification milestone fires.

---

## Deferred decisions

Three items the plan deliberately doesn't settle:

### HMAC verification

The v2 dashboard guide called for HMAC signing on the GAS → R1 webhook call. The existing `Webhook.call` doesn't sign. Three paths:

- **Skip HMAC for v1.** The other GAS → Workato webhooks (Provision, Validate, Portal) don't sign; they authenticate by URL secrecy alone. Invitations matches the existing posture. Lowest cost, lowest security delta.
- **Add HMAC to Webhook.call as an opt-in.** New `opts.signWith` parameter; the helper hashes the body and adds a header. Used only by Invitations for now.
- **Add HMAC for all flows.** Bigger change. Probably overkill for the marginal security gain over URL secrecy in this environment.

**Recommend:** option 1 (skip for v1), revisit if security review pushes back. Document the decision so it's not silently lost.

### Migration handling

Covered above — lean is lazy (option C). Revisit if multi-workbook deployments make it painful.

### Webhook timeout for large batches

Workato webhook response timeouts (typically 30s) cap the practical batch size. INV-01 averages ~2s per call (platform actions + STS-01 + DASH-01 refresh at the end), so batches over ~12-15 risk timing out. For Stage 4 verification with small batches this is fine. If real engagements push past it, the answer is async-with-polling — R1 returns 202 immediately and writes summary to a polled status table. Defer until observed.

---

## Open documentation work

Two doc updates to land alongside the code:

- **Dashboard recipe builder guide v2:** update step 5 of the build order with a forward reference to this plan ("GAS-side wiring detail in `as_invitations_integration_plan.md`").
- **The Apps Script library README** (wherever it lives, may not exist): describe the four flows (Provision, Validate, Portal, Invitations) at a glance, with one paragraph each on what they do and when they fire. Helps future-you (or whoever picks this up).

---

## Files modified, files added

| File | Modified | Added |
|---|---|---|
| `as_lib.txt: 000_Config.gs` | yes | |
| `as_lib.txt: 003_Payload.gs` | yes | |
| `as_lib.txt: 004_Invitations.gs` | | yes |
| `as_container.txt` | yes | |
| `invitation_results.html` (container) | | yes |
| Every workbook's `_developer_settings` | yes (one row) | |

About 260 lines of new code across 2 files, plus ~60 lines of HTML. The lift is small because the architecture already had the pattern; this is mostly wiring.
