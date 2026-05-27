# Preview Download Button Dead — Fix

## Symptom
The modal renders, the **Download .xlsx** button is visible, but clicking does nothing (not greyed out — just dead).

## Cause
A visible-but-dead button means **the click handler never attached** — the inline `<script>` errored before reaching `addEventListener('click', …)`. The trigger is this line:

```javascript
var B64 = '<?= b64 ?>';
```

`<?= ?>` is HtmlService's HTML-escaping scriptlet, and the base64 string is large (thousands of chars). Two failure modes live here:
- If the injected value contains anything that breaks the JS string literal (or the HTML-escaping mangles a character into an entity), the `var B64 = '…'` statement is malformed → **SyntaxError** → the whole script block aborts → no handler attaches → button is inert.
- Even when it doesn't throw, HTML-escaping is the *wrong* escaping for a JS string, so the base64 can arrive corrupted → `atob` fails on click.

Injecting a big string into a script via `<?= ?>` is fragile by construction. The fix removes the injection entirely.

## Confirm first (10 seconds)
Open the modal → right-click inside it → **Inspect** → **Console**. A dead button almost always shows a red `Uncaught SyntaxError` (or `ReferenceError`) naming the exact line. That confirms "script broke before the handler attached."

## Fix — fetch the bytes via `google.script.run`, don't inject them

The bytes stay server-side; the modal asks for them on click. No large string ever enters the HTML/JS, so the script can't break on injection and the handler always attaches.

### Container `.gs` — `showTemplatePreview_` + a getter
```javascript
function showTemplatePreview_(data) {
  // Stash bytes server-side; the modal fetches them via google.script.run.
  var c = CacheService.getUserCache();
  c.put('preview_b64',  data.fileContent || '', 300);   // 5 min TTL
  c.put('preview_name', data.fileName || 'preview.xlsx', 300);

  var t = HtmlService.createTemplateFromFile('preview_template');
  t.filename = data.fileName || 'preview.xlsx';          // for the visible meta only
  t.meta     = data.metadata || {};
  // no t.b64 — bytes no longer travel through the template
  SpreadsheetApp.getUi().showModalDialog(
    t.evaluate().setWidth(480).setHeight(300), 'Template preview');
}

// Called by the modal after the user clicks Download.
function getPreviewBytes_() {
  var c = CacheService.getUserCache();
  return { b64: c.get('preview_b64') || '', name: c.get('preview_name') || 'preview.xlsx' };
}
```

### `preview_template.html` — script block
Replace the `var B64 = '<?= b64 ?>'` approach with a click handler that fetches:
```html
<button id="dl" class="primary">Download .xlsx</button>
<button onclick="google.script.host.close()">Close</button>

<script>
  document.getElementById('dl').addEventListener('click', function () {
    var btn = this; btn.disabled = true; btn.textContent = 'Preparing…';
    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.b64) {
          alert('Preview data expired — please run Preview again.');
          btn.disabled = false; btn.textContent = 'Download .xlsx'; return;
        }
        var bin = atob(res.b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var blob = new Blob([arr],
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = res.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        btn.disabled = false; btn.textContent = 'Download .xlsx';
      })
      .withFailureHandler(function (e) {
        alert('Download failed: ' + e.message);
        btn.disabled = false; btn.textContent = 'Download .xlsx';
      })
      .getPreviewBytes_();
  });
</script>
```
Keep the rest of the HTML (meta display via `<?= meta.* ?>` and `<?= filename ?>`, the Excel warning note) as-is — those are small, safe values.

## Why this is the right fix, not a workaround
- The inline script is now tiny and contains no injected data → it can't throw on load → **the handler always attaches** → the button is always clickable.
- The base64 travels as a **data return value** through `google.script.run`, never through HTML escaping → no corruption, no size-related fragility.
- Bonus: the button shows "Preparing…" and re-enables, and an expired cache surfaces a clear message instead of a silent 0-byte file.

## Dependency reminder
This still requires `Preview.run` to return `fileContent` (the base64) — if the library is still returning only `driveFileUrl`, `data.fileContent` is undefined, the cache holds `''`, and you'll get the "Preview data expired" alert on click. Land the `Preview_Modal_Fix.md` library change (return `fileContent`) together with this.

## Verify
1. Open modal → button clickable immediately.
2. Click → file downloads, non-zero size, opens in Excel with working dropdowns.
3. (Inspect → Console) no red errors on modal load.
