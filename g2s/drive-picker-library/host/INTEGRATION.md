# Plugging DrivePicker into gemini-2-sf

Exact edits to the host project. Apply top to bottom; each is small. `Intake.js` in this folder is a complete
file that **replaces** `Upload.js` (same functions, plus the shared landing and the `importPicked` shim).

---

## 0. Before the picker is configured

Everything below is safe to apply now. Until the three `picker_*` Config cells are filled in, the page renders
exactly as it does today: no button, no library script, no extra network calls. Filling in the cells and
deploying a new version turns it on.

---

## 1. `appsscript.json` — declare the dependency

```json
"dependencies": {
  "enabledAdvancedServices": [ { "userSymbol": "Drive", "serviceId": "drive", "version": "v3" } ],
  "libraries": [
    { "userSymbol": "DrivePicker", "libraryId": "<DrivePicker library script id>", "version": "1", "developmentMode": false }
  ]
}
```

Pin a version. Use `developmentMode: true` only while iterating on the library itself. The
`userinfo.email` scope added for uploads is all the picker needs; the library's own call is `UrlFetchApp`,
already covered by `script.external_request`.

---

## 2. `ContractIntake.js` — three optional Config keys

In the `Config` typedef:

```js
 * @property {string}  picker_api_key      Optional. Google Picker API key. All three picker_* keys present = picker on.
 * @property {string}  picker_client_id    Optional. OAuth 2.0 Web client id.
 * @property {string}  picker_app_id       Optional. Project NUMBER of the project that owns the client id.
```

In `readConfig_`, after `upload_allowed_emails`:

```js
    picker_api_key:         str_(raw.picker_api_key),
    picker_client_id:       str_(raw.picker_client_id),
    picker_app_id:          str_(raw.picker_app_id)
```

---

## 3. `Upload.js` → `Intake.js`

Delete `Upload.js`; add `Intake.js` from this folder. Public functions the page calls: `uploadContract`,
`importPicked`. Everything that used to be in `Upload.js` is still there under the same names
(`validateUpload_`, `assertUploadAllowed_`, `uploaderEmail_`, `mb_`, `countIntakeFiles_`), so `Tests.js` still
passes; see §7 for two new tests.

---

## 4. `WebApp.js` — template, include, picker config

Replace `doGet` and add `pickerConfig_`:

```js
/**
 * Web app entry point. Dashboard.html is a TEMPLATE now (not a static file) so the DrivePicker script can be
 * included only when configured — `<?!= DrivePicker.clientHtml() ?>` is evaluated here, server-side.
 */
function doGet(e) {
  let picker = null;
  try { picker = pickerConfig_(readConfig_()); } catch (err) { /* a config problem must not take the page down */ }

  const t = HtmlService.createTemplateFromFile('Dashboard');
  t.picker = picker !== null;
  return t.evaluate()
    .setTitle('Contract Intake')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Picker settings for the page, or null when any of the three Config keys is blank. Presence is the switch.
 * @param {Config} cfg
 * @return {?{apiKey:string, clientId:string, appId:string, mimeTypes:string[]}}
 * @private
 */
function pickerConfig_(cfg) {
  if (!cfg.picker_api_key || !cfg.picker_client_id || !cfg.picker_app_id) return null;
  return { apiKey: cfg.picker_api_key, clientId: cfg.picker_client_id, appId: cfg.picker_app_id, mimeTypes: PICKER_MIME_TYPES };
}
```

In `getDashboardData`, read config once (tolerantly) and add an `intake` block:

```js
function getDashboardData() {
  const now = new Date();
  let cfg = null;
  try { cfg = readConfig_(); } catch (err) { /* page still renders; intake block degrades */ }

  const queueSheet = getQueueSheet_();
  const summary = summarizeLogs_(readRecentLogRows_(DASHBOARD_LOG_TAIL), now, DASHBOARD_ERROR_DAYS, DASHBOARD_LIST_CAP);
  return {
    generatedAt: now.toISOString(),
    pollMinutes: POLL_MINUTES,
    maxUploadBytes: INLINE_PDF_MAX_BYTES,
    intakeWaiting: countIntakeFiles_(),
    intake: {
      picker: cfg ? pickerConfig_(cfg) : null,
      folderUrl: cfg ? DriveApp.getFolderById(cfg.folder_id_ingestion).getUrl() : ''
    },
    heartbeats: readHeartbeats_(queueSheet),
    queue: readQueueRows_(queueSheet),
    today: summary.today,
    errors: summary.errors,
    activity: summary.activity
  };
}
```

---

## 5. `Dashboard.html`

**a. The include.** Immediately before the page's own `<script>` (so `DrivePicker` exists before `render()` runs):

```html
  <? if (picker) { ?><?!= DrivePicker.clientHtml() ?><? } ?>
```

That is the only scriptlet in the file. When `picker` is false nothing is emitted and the library is never
touched during page load.

**b. A mount point and a folder link.** In the drop zone, replace the lone `intakeWaiting` span with:

```html
      <span class="hint" id="intakeWaiting"></span>
      <span class="actions" id="intakeActions"></span>
```

and in the `<style>` drop-zone section:

```css
    .drop .actions { display: inline-flex; gap: 8px; align-items: center; }
```

**c. Row factory.** In the upload script, replace the top of `sendOne` (everything from `var li = ...` through the
inner `status` function) with a call to a shared factory, so any source can report progress the same way:

```js
      // A status row in the uploads list. Shared by every intake source (local drop, Drive picker, ...).
      function intakeRow(name) {
        var li = document.createElement('li');
        var fname = document.createElement('span');
        fname.className = 'fname';
        fname.textContent = name;
        var st = document.createElement('span');
        st.className = 'st';
        li.appendChild(fname);
        li.appendChild(st);
        list.appendChild(li);
        list.hidden = false;

        return {
          status: function (text, dotClass) {
            st.textContent = '';
            if (dotClass) {
              var d = document.createElement('span');
              d.className = 'dot ' + dotClass;
              st.appendChild(d);
            }
            st.appendChild(document.createTextNode(text));
          },
          link: function (url, label) {
            var a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener';
            a.textContent = label || name;
            fname.textContent = '';
            fname.appendChild(a);
          }
        };
      }

      window.Intake = { row: intakeRow, refresh: load };   // the seam other modules plug into
```

Then `sendOne` starts with `var row = intakeRow(file.name);` and uses `row.status(...)` and
`row.link(r.url, r.name)` in place of the old inline `status()` and anchor-building code.

**d. Mount the picker once data arrives.** In `render()`, after the drop-zone lines:

```js
        if (data.intake) {
          if (data.intake.folderUrl) {
            $('dropHint').innerHTML = esc($('dropHint').textContent) +
              ' Or <a href="' + esc(data.intake.folderUrl) + '" target="_blank" rel="noopener">open the Intake folder</a> to move a Drive file in.';
          }
          mountPicker(data.intake.picker);
        }
```

and the function itself, next to `sendOne`:

```js
      // Drive picker: present only when the server sent picker settings AND the library script was included.
      function mountPicker(p) {
        if (state.pickerMounted || !p || !window.DrivePicker) return;
        state.pickerMounted = true;

        DrivePicker.mount({
          button: $('intakeActions'),
          className: 'refresh',                 // reuse the pill-button style
          label: 'Add from Drive',
          apiKey: p.apiKey, clientId: p.clientId, appId: p.appId,
          mimeTypes: p.mimeTypes,
          onPicked: function (files, token) {
            files.forEach(function (f) {
              var row = intakeRow(f.name);
              if (f.sizeBytes && f.sizeBytes > state.maxUploadBytes) {
                return row.status('Too large: ' + (f.sizeBytes / 1048576).toFixed(1) + ' MB (limit ' +
                  Math.round(state.maxUploadBytes / 1048576) + ' MB).', 'critical');
              }
              row.status('Importing from Drive…');
              google.script.run
                .withSuccessHandler(function (r) {
                  row.link(r.url, r.name);
                  row.status('Imported. It will be read within about ' + state.pollMinutes +
                    ' minutes; the review sheet then appears in the queue and in Chat.', 'good');
                  load();
                })
                .withFailureHandler(function (err) {
                  row.status('Not imported: ' + (err && err.message ? err.message : String(err)), 'critical');
                })
                .importPicked({ pick: { id: f.id, name: f.name, mimeType: f.mimeType }, token: token });
            });
          },
          onError: function (err) {
            intakeRow('Add from Drive').status(err && err.message ? err.message : String(err), 'critical');
          }
        });
      }
```

Add `pickerMounted: false` to the `state` object.

**e. Link label by context.** In the Today table, the intake rows are recognised by log context rather than by
message prefix, so a new source needs no page change:

```js
                  var linkText = (a.context === 'intake' || a.message.indexOf('Uploaded ') === 0) ? 'Open file' : 'Open review sheet';
```

---

## 6. `run-tests-node.js`

In the file list replace `'Upload.js'` with `'Intake.js'`, and add `'DrivePicker'` to the proxy list so a test
that accidentally reaches the library fails loudly.

---

## 7. `Tests.js` — two more pure cases in `registerUploadTests_`

```js
  t('intakeDescription_ / intakeMessage_: provenance reads correctly for both sources', function () {
    var when = new Date('2026-09-08T19:00:00.000Z');
    assertEq_(intakeDescription_({ source: 'upload', who: 'ann@corp.com', from: '' }, when),
      'Via dashboard upload by ann@corp.com at 2026-09-08T19:00:00.000Z');
    assertEq_(intakeDescription_({ source: 'picker', who: '', from: 'https://drive.google.com/file/d/X/view' }, when),
      'Via dashboard (Drive picker) at 2026-09-08T19:00:00.000Z (source: https://drive.google.com/file/d/X/view)');
    assertEq_(intakeMessage_('a.pdf', { source: 'upload', who: 'ann@corp.com' }), 'Uploaded a.pdf (ann@corp.com)');
    assertEq_(intakeMessage_('b.pdf', { source: 'picker', who: '' }), 'Imported b.pdf');
  });
```

---

## 8. Deploy

`clasp push`, then Deploy → Manage deployments → New version (the page and `doGet` changed). If you added the
library dependency in the editor rather than the manifest, `clasp pull` first so the manifest matches.

## 9. Turning the picker on, later

1. Complete the one-time GCP setup in the library README (API key, OAuth client, appId).
2. Fill `picker_api_key`, `picker_client_id`, `picker_app_id` in the Config sheet.
3. Load the dashboard, click **Add from Drive**. If sign-in fails, the error names this page's origin; add it to
   the OAuth client's Authorized JavaScript origins and try again.
