# DrivePicker — Apps Script library + picker helper (v2)

Let a visitor to an Apps Script web app pick files from **their own** Google Drive and hand your server the bytes.

One Apps Script project, two roles: a **library** your host references (`clientHtml`, `fetchPicked`), and a tiny
**web app of its own** — the *picker helper* — that runs the Google Picker as the visitor. Hosts embed the helper,
receive the picks and the visitor's token, and download the file on their own server with `fetchPicked`.

---

## 1. Why it is built this way (read this once)

A web app deployed **Execute as: Me** has only the deployer's authority. The Picker must show the *visitor's* Drive,
so it needs a token that belongs to the visitor. There are only two ways to get one in Apps Script:

- **In the browser with Google Identity Services.** Requires the page's origin to be registered on an OAuth client.
  Every HtmlService page lives on `https://n-…-script.googleusercontent.com`, and Google refuses to register
  Google-owned domains as JavaScript origins (*"invalid origin"*). **Dead end.** v1 of this library tried it.
- **Server-side with `ScriptApp.getOAuthToken()`.** The token belongs to whoever the script *executes as*. So the
  picker must run in a web app deployed **Execute as: User accessing**, separate from the host dashboard, which
  keeps executing as its owner so visitors need no access to its sheets and folders.

Hence the helper: this project is deployed as a web app (as the visitor, `drive.file` only). The host embeds it in
an iframe; the helper opens the Picker with `ScriptApp.getOAuthToken()`, then posts the picks and the token up the
frame chain to the host page; the host's server downloads the file with that token. The visitor authorises the
helper once. This is the pattern Google's own Apps Script Picker sample uses.

---

## 2. Contract

### Library (host server side)

| Member | Purpose |
|---|---|
| `VERSION` | `var` — `const`/`let` are invisible across the library boundary. |
| `clientHtml()` → string | The host-side embed `<script>` defining `window.DrivePicker`. Inline in a host **template**: `<?!= DrivePicker.clientHtml() ?>` |
| `fetchPicked(pick, token, opts?)` → Blob | `pick = {id, name, mimeType}` from `onPicked`; `token` the visitor's. Native Google files are exported (PDF by default or `opts.exportMime`). Plain-language errors. |

### Host page

```js
DrivePicker.mount({
  button,                  // Element the "Add from Drive" button is appended to      (required)
  url,                     // this project's web-app /exec URL — the picker helper      (required)
  onPicked(files, token),  // files: [{id, name, mimeType, sizeBytes, url}]            (required)
  onError(err),            // optional
  mimeTypes,               // optional array offered by the picker
  label, className,        // optional cosmetics
  authTimeoutMs            // optional, default 6000: how long to wait before offering the one-time sign-in
}) -> { open(), close(), button }
```

No OAuth client, no Google Identity Services, no origin registration with Google. The host needs **one** value:
the helper's URL.

---

## 3. One-time Google Cloud setup

All in one standard GCP project (the one your Vertex work already uses is fine). Note its **project number**
(Dashboard → Project info; 12 digits, not the ID).

1. **APIs & Services → Library**: enable **Google Picker API** and **Google Drive API**. Both. The download uses
   the visitor's token, which Drive attributes to this project, so Drive API must be on here.
2. **Google Auth Platform** (older console: OAuth consent screen): Audience **Internal**; under Data Access add the
   scope `https://www.googleapis.com/auth/drive.file`. Internal needs no verification.
3. **APIs & Services → Credentials → Create credentials → API key.** Copy it. Edit it: API restrictions → Google
   Picker API only; Application restrictions → Websites → `https://*.googleusercontent.com/*` and
   `https://script.google.com/*`.

You do **not** create an OAuth client. If you made one for v1, delete it.

---

## 4. Publishing this project (once)

1. **Switch it to the standard project.** In the DrivePicker script editor: Project Settings (gear) → *Google Cloud
   Platform (GCP) Project* → **Change project** → paste the project **number** → Set project. This is what makes
   `ScriptApp.getOAuthToken()` mint tokens under that project (so `drive.file` grants attach to `PICKER_APP_ID`) and
   lets it use the consent screen from §3.
2. **Script properties** (same page): `PICKER_API_KEY` = the key; `PICKER_APP_ID` = the project number;
   `PICKER_ALLOWED_ORIGINS` = leave empty for now (step 6 fills it).
3. `.claspignore` must list `run-tests-node.js` (it requires Node's `fs` and would break the library if pushed).
   `clasp push`; expect five files: `appsscript.json`, `Code.js`, `Client.html`, `Picker.html`, `Tests.js`.
4. Run `runTests()` in the editor: `18 passed, 0 failed`.
5. **Deploy → New deployment → Web app**: Execute as **User accessing the web app**; Who has access **Anyone within
   \<org\>**. Copy the `/exec` URL: that is the `picker_url` every host uses.
6. **Deploy → New deployment → Library**: note the version (v2 of the code should be library version 2 or higher).
7. **Share** the script with your team group as Viewer (consumers must be able to read the library).

---

## 5. Consuming it (host project)

1. `appsscript.json`: `dependencies.libraries: [{ userSymbol: "DrivePicker", libraryId: "<this script id>", version: "<from §4.6>", developmentMode: false }]`.
2. Serve the host page as a **template** and include the embed: `<?!= DrivePicker.clientHtml() ?>` (gate it on
   configuration so the library isn't touched when the picker is off).
3. One server shim (`google.script.run` cannot call library functions):
   ```js
   function importPicked(p) {
     const blob = DrivePicker.fetchPicked(p.pick, p.token);   // throws readable errors
     // …size check, then whatever "landing" means in this host
   }
   ```
4. Mount: `DrivePicker.mount({ button, url: <picker_url>, mimeTypes, onPicked(files, token) { … importPicked({pick, token}) … } })`.
   Check `f.sizeBytes` against your own cap before importing; native Google files report 0 (size known only after export;
   Drive caps exports at 10 MB).

The Contract Intake host keeps `picker_url` in its Config sheet; presence of the value is the switch.

---

## 6. First click: registering the host (the only "origin" step, and it's ours)

Click **Add from Drive** on the host. Two things can happen the first time:

- **A "one-time sign-in needed" panel.** The visitor hasn't authorised the helper yet, and Google's consent page
  cannot render inside an iframe. The panel's button opens the helper in its own tab; the visitor approves
  `drive.file`, sees *You're set*, comes back and clicks again.
- **"This host is not allowed to use the picker. Add its origin to Script Property PICKER_ALLOWED_ORIGINS … :
  https://n-…-0lu-script.googleusercontent.com".** Copy that string into the property (comma-separated for several
  hosts), save, click again. This replaces Google's OAuth-client origin list with one we control, and the message
  hands you the exact value. The origin is stable per host script project.

Then the Picker opens on the visitor's Drive (shared drives included), filtered to the host's MIME list.

---

## 7. Security model, briefly

The helper page contains the visitor's `drive.file` token, served only to that visitor, exactly as Google's sample
does. It posts the token only to the origin the host passed in `?o=`, and only if that origin is on
`PICKER_ALLOWED_ORIGINS` (the page is embeddable by anyone because of `ALLOWALL`; the allow-list is the guard).
The host accepts messages only from `*-script.googleusercontent.com` origins carrying the nonce it generated for
that click, and only while its panel is open. `drive.file` means the token can read only files the visitor picked.

---

## 8. Gotchas

- **`google.script.run` cannot call library functions** — always a shim in the host.
- **`PICKER_APP_ID` is the project *number*** of the project the DrivePicker script is switched to. A mismatch means
  `drive.file` grants don't attach and every download returns 403.
- **Drive API must be enabled** in that project, not only the Picker API.
- **Two deployments of this project** coexist: the web app (helper) and the library. Bump the library version when
  `Code.js`/`Client.html` change; make a new web-app version when `Picker.html`/`doGet` change.
- **`.claspignore`** — never push `run-tests-node.js`.
- **The helper runs as the visitor** and asks each visitor to authorise `drive.file` once. Keep its manifest scopes to
  `drive.file` and `script.external_request` so that consent stays small.
- **Native Google files export** to PDF by default; Forms/Sites/Maps are refused with a readable message.
- **`fetchPicked` 401 after ~an hour**: the token expired; the message tells the user to click again.

---

## 9. Files

| File | Purpose |
|---|---|
| `Code.js` | `VERSION`, `clientHtml()`, `fetchPicked()`, the helper's `doGet()`, pure helpers. |
| `Client.html` | Host-side embed: overlay + iframe, nonce, message handling, one-time sign-in fallback. |
| `Picker.html` | The helper page: opens the Picker with the visitor's token, posts results up the frame chain. |
| `Tests.js` | Hermetic tests (`runTests()`): download plan, error text, origin allow-list. |
| `run-tests-node.js` | Runs the suite under Node. Listed in `.claspignore`. |
| `appsscript.json` | Scopes `drive.file` + `script.external_request`; web app executes as user accessing, domain access. |

## 10. Changelog

- **2.0.0** — Replaced Google Identity Services with a picker helper web app executing as the visitor
  (`ScriptApp.getOAuthToken()`), embedded by hosts; `PICKER_ALLOWED_ORIGINS` allow-list; hosts need only the helper
  URL. Reason: Google rejects `googleusercontent.com` origins on OAuth clients, so GIS cannot run in HtmlService.
- **1.0.0** — Initial (GIS-based) release. Superseded.
