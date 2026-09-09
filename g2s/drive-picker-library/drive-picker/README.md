# DrivePicker — Apps Script library

DrivePicker lets a visitor to an Apps Script web app select files from **the visitor's own** Google Drive. The
library then gives the file contents to your server as a Blob.

The library does two things:

1. It puts the Google Picker in a page.
2. It converts a selected file into a Blob. It uses the visitor's own access token to do this.

The library does not know about your folders, logs, or business rules. Your code decides what to do with the
Blob. This boundary makes the library reusable in many tools.

Status: v1.0.0. The first consumer is the Contract Intake dashboard (`gemini-2-sf`). This README is the handoff
document. It contains all the information you need to publish, configure, consume, and debug the library.

---

## 1. The problem it solves

A web app deployed with **Execute as: Me** has only the deployer's authority on the server.
`ScriptApp.getOAuthToken()` returns the deployer's token. The page in the visitor's browser has no credential.

The Picker must show the *visitor's* Drive. So it needs a token that belongs to the visitor.

The library does this in the browser:

1. It gets a token for the visitor with Google Identity Services (scope `drive.file`).
2. It opens the Picker with that token.
3. It returns the selected files *and the token* to the host page.

The host page posts both to its server. On the server, `fetchPicked()` downloads the file. It sends the
visitor's token in the `Authorization` header. `UrlFetchApp` runs with the host's authorization, but Drive
answers for the visitor.

Google recommends the `drive.file` scope for the Picker. It is the least-privilege option. The app can read only
the files that the visitor selected in that session. The token is valid for about one hour.

---

## 2. Contract

### Server (library globals)

Members with a name that ends in `_` are private.

| Member | Type | Purpose |
|---|---|---|
| `VERSION` | `var` string | Library version. It is a `var` because `const` and `let` are not visible across the library boundary. |
| `clientHtml()` | → string | The `<script>` block that defines `window.DrivePicker`. Inline it in a host **template**: `<?!= DrivePicker.clientHtml() ?>` |
| `fetchPicked(pick, token, opts?)` | → Blob | `pick = {id, name, mimeType}` from `onPicked`. `token` is the visitor's token. Native Google files are **exported** (PDF by default, or `opts.exportMime`). The file name gets the matching extension. Errors are thrown in plain language. |

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

Nothing loads until the first click. The browser half never calls your server. It does not know your function
names, and `google.script.run` cannot call library functions. Your `onPicked` function calls the server (see §5).

---

## 3. One-time Google Cloud setup

Do this once for each **OAuth client**, not for each host. One client can list many authorized origins. So one
client id can serve every web app that uses the library.

1. **Select the project.** Use a standard GCP project that you control. The Apps Script default project cannot
   hold API keys or OAuth clients. Record the **project number**. This is `appId`.
2. **Enable the Google Picker API.** Go to APIs & Services → Library → "Google Picker API".
3. **Create an API key.** Go to Credentials → Create credentials → API key. Then restrict the key:
   - *API restrictions*: Google Picker API only.
   - *Application restrictions*: HTTP referrers, `https://*.googleusercontent.com/*` and
     `https://script.google.com/*`.

   This is `apiKey`. The key is public by design. The restrictions protect it.
4. **Configure the OAuth consent screen.** User type: **Internal** (Workspace). Scope: `…/auth/drive.file`.
   Internal apps do not need verification.
5. **Create the OAuth client.** Go to Credentials → Create credentials → OAuth client ID → *Web application*.
   Leave the redirect URIs empty. The GIS token flow does not use them. For *Authorized JavaScript origins*, see
   §7. You add the sandbox origin of each host here. The library's error message gives you the exact string.
   This is `clientId`.

---

## 4. Publishing the library

```bash
clasp create --type standalone --title "DrivePicker"     # once; writes the scriptId into .clasp.json
clasp push
```

Then, in the editor: **Deploy → New deployment → type: Library → Deploy.** Record the version number. Each later
`clasp push` plus new library deployment increases the version number. Consumers pin a version and upgrade when
they choose.

Consumers need at least **Viewer** access to the library script. Share it with the group that owns the tools.

While you work on the library itself, a consumer can set `developmentMode: true` to run HEAD. The running user
must then have edit access. Always pin a version in a deployed host.

Run the hermetic tests before you publish: `node run-tests-node.js` (or `runTests()` in the editor).

---

## 5. Consuming it (host project)

You make three edits and one mount call. The Contract Intake host has a worked example in `host/INTEGRATION.md`.

**a. Dependency.** Add this to the host's `appsscript.json`, so clasp can reproduce it:

```json
"dependencies": {
  "libraries": [
    { "userSymbol": "DrivePicker", "libraryId": "<this library's script id>", "version": "1", "developmentMode": false }
  ]
}
```

Scopes: the library's server call uses `UrlFetchApp` (`script.external_request`). If the host lists scopes
explicitly (recommended), make sure that scope is present. No other scope is needed.

**b. Include.** Add this to the host's HtmlService page. The page must be served as a **template**
(`createTemplateFromFile(...).evaluate()`, not `createHtmlOutputFromFile`):

```html
<? if (picker) { ?><?!= DrivePicker.clientHtml() ?><? } ?>
```

Gate the include on configuration. Then the library is never touched when the picker is off.

**c. Shim.** Add one server function to the host. This is the function that `google.script.run` can call:

```js
function importPicked(p) {
  const blob = DrivePicker.fetchPicked(p.pick, p.token);   // throws readable errors
  // ...check the size, then do what this host needs: create the file in a folder, log it, return {name, url}
}
```

**d. Mount.** Call `mount` in the page after you have the settings (usually from a data call):

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

Compare `f.sizeBytes` with your own limit before you import. For native Google files, `f.sizeBytes` is `0` or
null. The exported size is known only after the export. Drive limits exports to 10 MB.

---

## 6. Important points, in the order you will meet them

- **`google.script.run` cannot call library functions.** Always add a one-line shim in the host.
- **Exported members must be functions or `var`s.** Top-level `const` and `let` are not visible to consumers.
- **Functions with a name that ends in `_` are private** to the library. Apps Script hides them from consumers.
  This is intentional.
- **`clientHtml()` works because `HtmlService.createHtmlOutputFromFile` reads the library's own files when it
  runs inside the library.** The host must inline the returned string in a template. The host cannot reference
  `Client.html` directly.
- **The host page must be a template.** Otherwise the `<?!= ?>` include does not evaluate. To convert a static
  page, change one line in `doGet`. First check the page for stray `<?` sequences. Usually there are none.
- **`appId` is the project *number*, not the project id.** It must belong to the project that owns `clientId`.
  If it does not, the `drive.file` grants do not attach to the selected files, and `fetchPicked` gets a 403 error.
- **The token is valid for about one hour.** The client caches the token. It requests a new one when the token is
  within one minute of expiry. If `fetchPicked` gets a 401 error, the visitor must click again.
- **Native Google files cannot be downloaded. They can only be exported.** The default export is PDF. Forms,
  Sites, and Maps are refused with a readable message. Drive limits exports to 10 MB.
- **Shared drives**: the view enables them. Downloads pass `supportsAllDrives=true`.
- **Browsers report different MIME types for local files. The Picker's `mimeType` comes from Drive.** You can
  trust it. `fetchPicked` sets the Blob's content type from it (or from the export type).
- **Do not give the Picker the deployer's token** (`ScriptApp.getOAuthToken()`) as a shortcut. The Picker would
  then show every visitor all the files that the deployer's account can see, member or not.

---

## 7. The origin problem, and how the library reports it

GIS runs inside the HtmlService sandbox iframe. The origin of that iframe is a
`https://n-…-script.googleusercontent.com` host, not `script.google.com`. The OAuth client must list **that**
origin under *Authorized JavaScript origins*. You cannot know the exact string until you are on the page.

So the library tells you. Each sign-in error reported through `onError` ends with this text:

> …this page's origin is `https://n-XXXX-0lu-script.googleusercontent.com` and it must be listed under
> "Authorized JavaScript origins" on OAuth client `<clientId>`.

To onboard a new host:

1. Deploy the host.
2. Click **Add from Drive**.
3. Copy the origin from the error message.
4. Add the origin to the OAuth client.
5. Click **Add from Drive** again.

The Picker itself receives the origin of the *top* window through `google.script.host.origin`. This lets the
Picker post back into the iframe. This part needs no configuration.

---

## 8. Smoke test

These steps test the parts that the automated tests cannot reach.

1. Consume the library in a temporary web app. Or use the Contract Intake dashboard with the picker keys set.
2. Click **Add from Drive**. Give consent (first time only). The Picker opens on *your* Drive. Shared drives are
   visible.
3. Select a PDF. The host receives a Blob with the same size and type.
4. Select a Google Doc. The host receives `<name>.pdf`.
5. Select a file that you own but the deployer does not. This still works, because the token is yours, not the
   deployer's.
6. Wait one hour. Select a file again. The library requests a new token without a consent prompt. There is no
   401 error.

---

## 9. Files

| File | Purpose |
|---|---|
| `Code.js` | Server surface: `VERSION`, `clientHtml()`, `fetchPicked()`. Pure helpers: `downloadPlan_`, `describeDriveError_`. |
| `Client.html` | Browser half: `window.DrivePicker.mount(...)`. Loads `api.js` and `gsi/client` on first use. |
| `Tests.js` | Hermetic tests for the pure helpers (`runTests()`). |
| `run-tests-node.js` | Runs the test suite locally under Node. Google services are stubbed to throw. |
| `appsscript.json` | V8 runtime, `script.external_request` scope. |
| `.clasp.json` | Replace `scriptId` after `clasp create`. |

## 10. Changelog

- **1.0.0** — Initial release: GIS `drive.file` token, DocsView with shared drives and MIME filter, media
  download and native export, sign-in errors that report the origin, hermetic tests.
