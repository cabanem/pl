Here's the complete set. The rename is `previewApiToken` → `apiPlatformToken` across three files, plus the validate-endpoint conversion in `007_Validate.js`. I'll show each edit with its before/after so you can apply them as surgical patches.

## 1. `000_Config.js` — rename the config key

The third argument to `get()` is the `_developer_settings` row key, so it changes too.

**Before:**
```js
      previewUrl:      get('webhook', 'previewUrl'),
      previewApiToken: get('webhook', 'previewApiToken') 
    },
```

**After:**
```js
      previewUrl:       get('webhook', 'previewUrl'),
      apiPlatformToken: get('webhook', 'apiPlatformToken')  // shared by preview + validate
    },
```

## 2. `010_Preview.js` — update the read site

This is the only place preview currently reads the token.

**Before:**
```js
      return Preview._call(config.webhook.previewUrl, config.webhook.previewApiToken, {
```

**After:**
```js
      return Preview._call(config.webhook.previewUrl, config.webhook.apiPlatformToken, {
```

## 3. `007_Validate.js` — swap the call block

Replace the `Payload.validate` + `Webhook.call` + guard section with the GET path.

**Before:**
```js
    var requesterEmail = Util.getActiveUserEmail();

    var payload = Payload.validate({
      correlationId:    correlationId,
      configJsonFileId: configJsonFileId,
      requesterEmail:   requesterEmail
    });

    var response = Stage.run('webhook', function() {
      return Webhook.call(config.webhook.validateUrl, payload);
    });

    if (!response.parsed) {
      var err = new Error('Validation webhook returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 200));
      err.stage = 'webhook-response';
      throw err;
    }
```

**After:**
```js
    // GET the endpoint with API-TOKEN header. NOT Webhook.call (that POSTs
    // JSON with no auth header). Mirrors Preview.run.
    var response = Stage.run('endpoint', function() {
      return Validate._call(config.webhook.validateUrl, config.webhook.apiPlatformToken, {
        correlation_id:      correlationId,
        config_json_file_id: configJsonFileId,
        requester_email:     Util.getActiveUserEmail() || 'unavailable',
        timestamp:           new Date().toISOString(),
        payload_version:     String(SDC_PAYLOAD_VERSION)
      });
    });

    log('INFO', 'Validate endpoint returned HTTP ' + response.statusCode);

    if (!response.parsed) {
      var err = new Error('Validate endpoint returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 200));
      err.stage = 'endpoint-response';
      throw err;
    }
```

## 4. `007_Validate.js` — add the `Validate._call` helper

In the private helpers section at the bottom (where the `_stage` note lives). Identical to `Preview._call`, renamed.

```js
/**
 * GET the validate endpoint with query params + API-TOKEN header. Mirrors
 * Preview._call. Treats any 2xx as success and returns the parsed body;
 * lets 4xx/5xx through as parsed bodies too (the recipe signals an invalid
 * config in the body, not via status).
 */
Validate._call = function(url, apiToken, params) {
  if (!url)      throw new Error('Validate._call: validateUrl is empty.');
  if (!apiToken) throw new Error('Validate._call: apiPlatformToken is empty.');

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

## 5. `007_Validate.js` — header comment fixup (optional but tidy)

The file header still describes the POST path. Worth correcting so the doc doesn't lie:

**Before:**
```js
 *   PrimaryKey.backfill Ã¢â€ â€™ Drive.serializeConfig('validate') Ã¢â€ â€™
 *   Variant.serializeAll('validate') Ã¢â€ â€™ Drive.shareWithIntegrationAccount Ã¢â€ â€™
 *   Payload.validate Ã¢â€ â€™ Webhook.call (returns parsed validation result)
```

**After:**
```js
 *   PrimaryKey.backfill Ã¢â€ â€™ Drive.serializeConfig('validate') Ã¢â€ â€™
 *   Variant.serializeAll('validate') Ã¢â€ â€™ Drive.shareWithIntegrationAccount Ã¢â€ â€™
 *   Validate._call (GET, API-TOKEN header; returns parsed validation result)
```

## 6. `003_Payload.js` — `Payload.validate` is now dead

Nothing calls it after change 3. Leave it as a record of the old wire format or delete it. If you keep it, a one-line note above it (`// Unused since validate moved to the GET API-Platform path; retained for reference.`) saves the next reader the grep.

---

## Manual step: `_developer_settings`

Rename the row key from `previewApiToken` to `apiPlatformToken` (category stays `webhook`, value unchanged). The validate `validateUrl` row you presumably already have.

## One flag worth your attention

This rename is a breaking change for any *existing* workbook. `Config.build` reads `get('webhook', 'apiPlatformToken')` — once you rename the property+lookup, a workbook whose `_developer_settings` still says `previewApiToken` returns `null` for the token, and both preview and validate then throw `apiPlatformToken is empty` at the `_call` guard. That's a loud, clear failure rather than a silent one, which is the good case — but it means every workbook needs the row updated, not just new ones.

Per your own schema definition in `003_Schema.js` (schema = sheets, columns, label strings), a `_developer_settings` key rename isn't a schema bump — it's config, not structure — so this doesn't touch `SDC_SCHEMA_VERSION` or the migration chain. It's a manual one-row edit per workbook. Given the platform was never live and you're in a bounded pilot, that's likely a handful of workbooks at most. But if it's more than you want to touch by hand, the zero-migration alternative is a fallback read:

```js
apiPlatformToken: get('webhook', 'apiPlatformToken',
                      get('webhook', 'previewApiToken'))
```

New key wins, old key as fallback, no workbook edits required, and you delete the fallback later. It's slightly less clean than a hard rename — but it's the move if updating rows by hand is more friction than it's worth.

The two recipe-side contract checks from before still stand and are the things most likely to bite: confirm the validate recipe's GET trigger declares exactly these param names, and confirm whether its body nests the verdict (`response.parsed.verdict`, like preview) or surfaces it flat (`response.parsed`, like your old POST) so `data.validationResult` feeds the right object to `showValidationResults_`.
