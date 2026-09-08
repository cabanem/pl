# DrivePicker — Apps Script library

Let a visitor to an Apps Script web app pick files from **their own** Google Drive and hand your server the bytes.

The library knows two things: how to put the Google Picker in a page, and how to turn a pick into a Blob using
the visitor's own access token. It knows nothing about your folders, logs, or business rules; you decide what to
do with the Blob. That boundary is what makes it reusable across tools.

Status: v1.0.0, first consumer is the Contract Intake dashboard (`gemini-2-sf`). This README is the handoff
document: everything needed to publish, configure, consume, and debug it is here.

---

## 1. The problem it solves

A web app deployed **Execute as: Me** has only the deployer's authority server-side (`ScriptApp.getOAuthToken()`
is the deployer's token), and the page in the visitor's browser has no credential at all. The Picker has to show
the *visitor's* Drive, so it needs a token that belongs to the visitor. The library gets one in the browser with
Google Identity Services (scope `drive.file`), opens the Picker with it, and returns the picks *and the token* to
the host. The host posts both to its server, where `fetchPicked()` downloads the file with the visitor's token in
the `Authorization` header. `UrlFetchApp` runs under the host's authorization, but Drive answers for the visitor.

`drive.file` is the least-privilege pairing Google recommends for the Picker: the app can read only the files the
visitor picked in that session, and only while the token lives (about an hour).

---

## 2. Contract

### Server (library globals; anything ending in `_` is private)

| Member | Type | Purpose |
|---|---|---|
| `VERSION` | `var` string | Library version. `var` because `const`/`let` are invisible across the library boundary. |
| `clientHtml()` | → string | The `<script>` block defining `window.DrivePicker`. Inline it in a host **template**: `<?!= DrivePicker.clientHtml() ?>` |
| `fetchPicked(pick, token, opts?)` | → Blob | `pick = {id, name, mimeType}` from `onPicked`; `token` the visitor's. Native Google files are **exported** (PDF by default, or `opts.exportMime`) and the name gets the matching extension. Throws plain-language errors. |

### Browser (defined by `clientHtml()`)

```js
DrivePicker.mount({
  button,                  // Element the "Add from Drive" button is appended to             (required)
  apiKey,                  // API key with the Google Picker API enabled                        (required)
  clientId,                // OAuth 2.0 Web client id                                           (required)
  appId,                   // project NUMBER of the project that owns clientId                  (required)
  onPicked(files, token),  // files: [{id, name, mimeType, sizeBytes, url}]                     (required)
  onError(err),            // optional; default console.error
  mimeTypes,               // optional array offered by the picker
  scope,                   // optional; default https://www.googleapis.com/auth/drive.file
  multiselect,             // optional; default true
  label, title, className  // optional cosmetics
}) -> { open(), button }
```

Nothing loads until the first click. The browser half never calls your server: it can't know your function
names, and `google.script.run` can't reach library functions anyway. Your `onPicked` does that (see §5).

---

## 3. One-time Google Cloud setup

Do this once per **OAuth client**, not per host. One client can list many authorized origins, so a single
client id can serve every web app that uses the library.

1. **Pick the project.** Use a standard GCP project you control (the Apps Script default project can't hold API
   keys or OAuth clients). Note its **project number** — that is `appId`.
2. **Enable the Google Picker API** (APIs & Services → Library → "Google Picker API").
3. **API key** (Credentials → Create credentials → API key). Restrict it: *API restrictions* → Google Picker API
   only; *Application restrictions* → HTTP referrers, `https://*.googleusercontent.com/*` and
   `https://script.google.com/*`. This is `apiKey`. It is public by design; the restrictions are the protection.
4. **OAuth consent screen**: User type **Internal** (Workspace), scope `…/auth/drive.file`. Internal apps need no
   verification.
5. **OAuth client** (Credentials → Create credentials → OAuth client ID → *Web application*). Leave redirect URIs
   empty (GIS token flow doesn't use them). *Authorized JavaScript origins*: see §7 — you'll add each host's
   sandbox origin here, and the library's error message tells you the exact string. This is `clientId`.

---

## 4. Publishing the library

```bash
clasp create --type standalone --title "DrivePicker"     # once; writes the scriptId into .clasp.json
clasp push
```

Then in the editor: **Deploy → New deployment → type: Library → Deploy.** Note the version number. Every later
`clasp push` + new library deployment increments it; consumers pin a version and move deliberately.

Consumers need at least **Viewer** access to the library script (share it with the group that owns the tools).
While iterating on the library itself, a consumer can set `developmentMode: true` to run HEAD — the running user
must then have edit access — but pin a version in anything deployed.

Run the hermetic tests before publishing: `node run-tests-node.js` (or `runTests()` in the editor).

---

## 5. Consuming it (host project)

Three edits plus a mount call. The Contract Intake host has a worked version in `host/INTEGRATION.md`.

**a. Dependency**, in the host's `appsscript.json` (clasp-reproducible):

```json
"dependencies": {
  "libraries": [
    { "userSymbol": "DrivePicker", "libraryId": "<this library's script id>", "version": "1", "developmentMode": false }
  ]
}
```

Scopes: the library's server call is `UrlFetchApp` (`script.external_request`). If the host lists scopes
explicitly (recommended), make sure that one is present. Nothing else is needed.

**b. Include**, in the host's HtmlService page, which must be served as a **template**
(`createTemplateFromFile(...).evaluate()`, not `createHtmlOutputFromFile`):

```html
<? if (picker) { ?><?!= DrivePicker.clientHtml() ?><? } ?>
```

Gate it on configuration so the library is never touched when the picker is off.

**c. Shim**, one server function in the host (this is the piece `google.script.run` can reach):

```js
function importPicked(p) {
  const blob = DrivePicker.fetchPicked(p.pick, p.token);   // throws readable errors
  // ...size check, then whatever "landing" means in this host: create in a folder, log, return {name, url}
}
```

**d. Mount**, in the page once you know the settings (typically from a data call):

```js
DrivePicker.mount({
  button: document.getElementById('actions'),
  apiKey, clientId, appId, mimeTypes: ['application/pdf', 'application/vnd.google-apps.document'],
  onPicked: function (files, token) {
    files.forEach(function (f) {
      google.script.run
        .withSuccessHandler(function (r) { /* show r.url */ })
        .withFailureHandler(function (e) { /* show e.message */ })
        .importPicked({ pick: { id: f.id, name: f.name, mimeType: f.mimeType }, token: token });
    });
  },
  onError: function (e) { /* show e.message — it includes the origin hint */ }
});
```

Check `f.sizeBytes` against your own cap before importing; it is `0`/null for native Google files, whose exported
size is only known after export (Drive caps exports at 10 MB).

---

## 6. Gotchas, in the order you'll meet them

- **`google.script.run` cannot call library functions.** Always a one-line shim in the host.
- **Exported members must be functions or `var`s.** `const`/`let` at top level are invisible to consumers.
- **Functions ending in `_` are private** to the library (Apps Script hides them from consumers). Used on purpose.
- **`clientHtml()` works because `HtmlService.createHtmlOutputFromFile` inside a library reads the library's own
  files.** The host must inline the returned string in a template; it cannot reference `Client.html` directly.
- **The host page must be a template** for the `<?!= ?>` include to evaluate. Converting a static page is one
  line in `doGet`. Check the page for stray `<?` sequences first; there are usually none.
- **`appId` is the project *number*, not the id**, and must belong to the project that owns `clientId`.
  Otherwise `drive.file` grants don't attach to the picked files and `fetchPicked` gets 403.
- **Token lifetime is about an hour.** The client caches it and requests a fresh one when it's within a minute of
  expiry; a 401 from `fetchPicked` means the visitor should click again.
- **Native Google files can't be downloaded, only exported.** Default PDF; Forms/Sites/Maps are refused with a
  readable message. Exports are capped at 10 MB by Drive.
- **Shared drives**: the view enables them and downloads pass `supportsAllDrives=true`.
- **Browsers vary in what they report as MIME for local files, but the Picker's `mimeType` is Drive's** and can
  be trusted; `fetchPicked` sets the Blob's content type from it (or the export type).
- **Don't hand the Picker the deployer's token** (`ScriptApp.getOAuthToken()`) as a shortcut. It would show every
  visitor whatever the deployer's account can see, member or not.

---

## 7. The origin problem, and why it's self-diagnosing

GIS runs inside HtmlService's sandbox iframe. That iframe's origin is a `https://n-…-script.googleusercontent.com`
host, not `script.google.com`, and it is **that** origin the OAuth client must list under *Authorized JavaScript
origins*. It's not obvious what the string is until you're on the page.

So the library tells you. Every sign-in error reported through `onError` ends with:

> …this page's origin is `https://n-XXXX-0lu-script.googleusercontent.com` and it must be listed under
> "Authorized JavaScript origins" on OAuth client `<clientId>`.

Onboarding a new host is: deploy, click **Add from Drive**, copy the origin from the message, add it to the OAuth
client, click again. (The Picker itself is told the *top* window's origin via `google.script.host.origin`, which
is what lets it post back into the iframe; that part needs no configuration.)

---

## 8. Smoke test (the parts tests can't reach)

1. Consume the library in a throwaway web app (or the Contract Intake dashboard with the picker keys set).
2. Click **Add from Drive** → consent (first time only) → the Picker opens on *your* Drive, shared drives visible.
3. Pick a PDF → the host receives a Blob of the same size and type.
4. Pick a Google Doc → the host receives `<name>.pdf`.
5. Pick a file you own but the deployer does not → still works (the token is yours, not the deployer's).
6. Wait an hour, pick again → a fresh consent-free token is requested; no 401.

---

## 9. Files

| File | Purpose |
|---|---|
| `Code.js` | Server surface: `VERSION`, `clientHtml()`, `fetchPicked()`; pure helpers `downloadPlan_`, `describeDriveError_`. |
| `Client.html` | Browser half: `window.DrivePicker.mount(...)`. Lazy loads `api.js` and `gsi/client`. |
| `Tests.js` | Hermetic tests for the pure helpers (`runTests()`). |
| `run-tests-node.js` | Runs the suite locally under Node with Google services stubbed to throw. |
| `appsscript.json` | V8, `script.external_request` scope. |
| `.clasp.json` | Replace `scriptId` after `clasp create`. |

## 10. Changelog

- **1.0.0** — Initial release: GIS `drive.file` token, DocsView with shared drives and MIME filter, media download
  and native export, origin-reporting sign-in errors, hermetic tests.
