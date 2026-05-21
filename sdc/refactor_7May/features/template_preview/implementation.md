The endpoint working is great — but it changes the wiring in one important way, and I want to verify it against your actual code rather than hand you something that'll regress to a 401. The issue: your `Webhook.call` always POSTs JSON with no auth header, but the preview endpoint is a **GET** with query params and a required `API-TOKEN` header. So `Preview.run` can't just reuse `Webhook.call` the way `Validate.run` does — unless your other endpoints are also GETs and there's token machinery I haven't seen. Let me check how the existing flows actually authenticate and what method they use.No token or header machinery anywhere — so the existing flows don't authenticate with an API-TOKEN at all. That tells me your other endpoints (validate, etc.) are almost certainly plain webhook triggers (unauthenticated, POST), and **the preview endpoint is your first API-Platform endpoint** — which is exactly why it needed the GET + `API-TOKEN` you just discovered. Let me confirm how the URLs are stored and whether the token has a home, so I wire it in the way that fits your config pattern.Now I have everything I need to wire this faithfully. The config pattern is clear: `_developer_settings` is a `category | key | value` sheet read by `get(category, key, default)`. So both the preview URL and the API token belong there, read the same way.

The key correction to everything I sketched earlier: because this endpoint is a **GET with an `API-TOKEN` header**, `Preview.run` must **not** use `Webhook.call` (it POSTs JSON, no header). Preview needs its own small request — exactly the GET-with-query-and-header that your test stub just proved works. So the wiring is essentially "promote the working stub's request into `Preview.run`, read URL+token from config, and branch the result into the modal."

Here's how the three pieces fit together. First, two settings rows so nothing is hardcoded:

In `_developer_settings`, add `webhook | previewUrl | <endpoint URL>` and `webhook | previewApiToken | <API client token>`. (Token in a sheet isn't ideal secret-hygiene, but it matches exactly how everything else here lives, and the workbook is already access-controlled; if you want it out of the sheet later, `PropertiesService` is the upgrade — noting it, not doing it now.)

Then read both in `Config.build`'s webhook block:

```javascript
    webhook: {
      url:             get('webhook', 'fileExportUrl'),
      portalInviteUrl: get('webhook', 'portalInviteUrl'),
      validateUrl:     get('webhook', 'validateUrl'),
      invitationsUrl:  get('webhook', 'invitationsUrl'),
      previewUrl:      get('webhook', 'previewUrl'),        // <-- new
      previewApiToken: get('webhook', 'previewApiToken')    // <-- new
    },
```

Now `template_preview.gs`. This is the corrected `Preview.run` — same ingest as before (build config, preflight, serialize, share config so the integration account can read it), but the call is a GET, and the success branch writes the returned base64 to Drive. The build-blocking/synchronous behavior is fine since the endpoint returns the file directly.

```javascript
var Preview = {};

/**
 * Build a preview of the supplier XLSX from the current workbook config via the
 * preview API-Platform endpoint (GET, API-TOKEN header). On a valid config the
 * returned base64 is written to _previews; on an invalid config the verdict is
 * returned in Validate's shape so the container reuses showValidationResults_.
 */
Preview.run = function(ss, opts) {
  if (!ss) throw new Error('Preview.run: ss is required.');
  opts = opts || {};

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  log('INFO', 'Starting template preview...');

  try {
    var config = Stage.run('config', function() { return Config.build(ss); });

    if (!config.webhook.previewUrl) {
      var e0 = new Error('webhook.previewUrl is not set in _developer_settings.');
      e0.stage = 'config'; throw e0;
    }

    var pf = Stage.run('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.previewUrl,
        webhookLabel:        'previewUrl',
        requireCustomerData: false
      });
    });

    Stage.run('primary-key-backfill', function() { return PrimaryKey.backfill(ss); });

    var baseResult = Stage.run('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'validate' });
    });
    var configJsonFileId = baseResult.fileId;

    Stage.run('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // GET the endpoint. NOT Webhook.call (that POSTs JSON with no auth header).
    var response = Stage.run('endpoint', function() {
      return Preview._call(config.webhook.previewUrl, config.webhook.previewApiToken, {
        correlation_id:      correlationId,
        config_json_file_id: configJsonFileId,
        requester_email:     Util.getActiveUserEmail(),
        variant_id:          opts.variantId || '',
        timestamp:           new Date().toISOString(),
        payload_version:     String(SDC_PAYLOAD_VERSION)
      });
    });

    var p = response.parsed;
    if (!p) {
      var e1 = new Error('Preview endpoint returned a non-JSON body: ' +
                         String(response.body || '').substring(0, 200));
      e1.stage = 'endpoint-response'; throw e1;
    }

    var verdict = p.verdict || {};

    // Invalid config: hand back the verdict in Validate's shape. No file.
    if (p.ok === false || verdict.status !== 'success' || !p.file_content) {
      log('INFO', 'Preview: config not yet valid; returning verdict.');
      return Result.ok({
        flow: 'preview', correlationId: correlationId,
        message: 'Configuration is not yet valid to build.',
        data: { validationResult: verdict }
      });
    }

    // Valid: decode and write the XLSX to _previews.
    var saved = Stage.run('write-preview', function() {
      var bytes  = Utilities.base64Decode(p.file_content);
      var blob   = Utilities.newBlob(bytes,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        p.suggested_filename || 'preview.xlsx');
      var folder = Drive.resolvePreviewsFolder(ss, config);
      Drive.cleanupOldFiles(folder, ['preview_']);
      var file   = folder.createFile(blob);
      return { url: file.getUrl(), name: file.getName() };
    });

    log('SUCCESS', 'Preview saved: ' + saved.name);
    return Result.ok({
      flow: 'preview', correlationId: correlationId,
      message: 'Template preview saved to _previews.',
      data: {
        driveFileUrl:     saved.url,
        driveFileName:    saved.name,
        validationResult: verdict,
        metadata:         p.metadata || {}
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Preview failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow: 'preview', correlationId: correlationId,
      message: 'Preview failed at ' + stage + ':\n\n' + e.message, error: e
    });
  }
};

/**
 * GET the preview endpoint with query params + API-TOKEN header. Mirrors the
 * proven test stub. Treats any 2xx as success and returns the parsed body; lets
 * 4xx/5xx through as parsed bodies too (the recipe signals invalid config in the
 * body, not via status — see note on the 400/200 recipe change).
 */
Preview._call = function(url, apiToken, params) {
  if (!url)      throw new Error('Preview._call: previewUrl is empty.');
  if (!apiToken) throw new Error('Preview._call: previewApiToken is empty.');

  var qs = Object.keys(params).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');

  var resp = UrlFetchApp.fetch(url + '?' + qs, {
    method:             'get',
    headers:            { 'API-TOKEN': apiToken },
    muteHttpExceptions: true
  });

  var body = resp.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) {}
  return { statusCode: resp.getResponseCode(), body: body, parsed: parsed };
};
```

One thing that matters here and ties back to the recipe fix: notice `Preview._call` reads the verdict out of the **body** and `Preview.run` branches on `p.ok` / `verdict.status`, *not* on HTTP status. That only works if the recipe returns the invalid-config case as **200 with `ok:false`**. If you've left it at 400, then because I'm using `muteHttpExceptions: true` it won't throw — but you'll still get the body, so as long as the body carries `{ok:false, verdict}` the branch works regardless of status. That's actually more robust than `Webhook.call`'s status-based behavior; still, I'd make the recipe 200 so the spec and reality agree.

The container handler and HTML are the same as the final sketch — they don't care that the transport became a GET, because they only see the `Result`:

```javascript
function previewTemplate() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Building template preview...', 'Status');   // before the call; it blocks
  var r = SDC.Preview.run(ss);
  ss.toast('');

  if (r.ok && r.data && r.data.driveFileUrl) {
    showTemplatePreview_(r.data);                        // valid: saved-to-Drive notice
  } else if (r.ok && r.data && r.data.validationResult) {
    showValidationResults_(r.data.validationResult);     // invalid: reuse Validate's modal
  } else {
    showResult_(r);                                      // hard failure
  }
}

function showTemplatePreview_(data) {
  var t = HtmlService.createTemplateFromFile('preview_saved');
  t.fileName = data.driveFileName;
  t.fileUrl  = data.driveFileUrl;
  t.meta     = data.metadata || {};
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(480).setHeight(300), 'Template preview saved');
}
```

And `preview_saved.html` — now that `metadata` carries `sheet_names`/`field_count`/`row_count`, the modal can give a real gut-check before the analyst even opens the file:

```html
<!DOCTYPE html>
<html>
  <head>
    <base target="_top">
    <style>
      body { font: 13px/1.5 Arial, sans-serif; margin: 16px; color: #222; }
      a.file { font-weight: bold; }
      .meta { color: #555; margin: 8px 0 14px; }
      .note { margin-top: 14px; padding: 10px; background: #fef7e0; border-radius: 4px; color: #5f4b00; }
      button { font-size: 13px; padding: 8px 14px; cursor: pointer; margin-top: 14px; }
    </style>
  </head>
  <body>
    <? var m = meta || {};
       var sheets = (m.sheet_names || []).join(', ');
       var kb = m.byte_size ? (m.byte_size / 1024).toFixed(1) + ' KB' : null; ?>

    <div>Configuration is valid. Preview saved to <b>_previews</b>:</div>
    <div style="margin-top:8px">
      <a class="file" href="<?= fileUrl ?>" target="_blank"><?= fileName ?></a>
    </div>

    <? if (m.field_count || m.row_count || sheets) { ?>
    <div class="meta">
      <?= m.field_count || '?' ?> fields, <?= m.row_count || '?' ?> data rows<? if (kb) { ?>, <?= kb ?><? } ?><br>
      <? if (sheets) { ?>Sheets: <?= sheets ?><? } ?>
    </div>
    <? } ?>

    <div class="note">
      <b>Download</b> the file and open it in <b>Excel</b> to verify the dependent
      dropdowns. Opening it directly in Google Sheets re-imports it and won't
      reproduce the <code>INDIRECT</code> / named-range behavior a supplier sees.
    </div>

    <button onclick="google.script.host.close()">Close</button>
  </body>
</html>
```

So the wiring, in one line: two `_developer_settings` rows → two new `config.webhook` reads → `Preview.run` calls `Preview._call` (the GET helper, lifted from your working stub) instead of `Webhook.call` → success writes to Drive and returns `driveFileUrl`/`metadata` → the existing handler routes valid to `showTemplatePreview_` and invalid to `showValidationResults_`.

The one judgment call worth surfacing: `Preview._call` is a deliberate departure from `Webhook.call` because the transports genuinely differ (GET+header vs POST+JSON). I kept it as a small private method on `Preview` rather than generalizing `Webhook.call`, because bending the shared POST helper to also do GET-with-auth would complicate the path every other flow depends on, for one caller. If you later move more endpoints to the API Platform, that's the moment to extract a shared `Endpoint.get/post` helper — but doing it now would be over-building for a single consumer. Given your lean toward simple-and-elegant, I'd keep the two callers honestly separate until a third one justifies the abstraction.

Want me to fold this corrected GET-based `Preview.run` and the two helpers into the sketch doc so it's the version of record, replacing the `Webhook.call` version that's now stale?
