Good question — and the right answer depends on a current Google Cloud API detail (the exact endpoint and response shape), so let me verify rather than hand you something stale.Two different "list models" calls exist in Vertex, and the names are close enough to bite you, so the first thing is picking the right one:

- `projects.locations.models.list` lists Models in a Location — that's *your project's own* uploaded/tuned models, not what you want.
- `publishers.models.list` is the Model Garden catalog (the Gemini/Imagen/partner models). The Firebase docs confirm this is the call for the Vertex AI Gemini API: call the publishers.models.list endpoint.

You want the second. It's a plain REST call, and since `GeminiLib` already authenticates to Vertex, the OAuth scope you need (`cloud-platform`) is almost certainly already granted — so this drops cleanly into your framework with `UrlFetchApp` + `ScriptApp.getOAuthToken()`, no new library.

A static method on `GeminiService` (static so it doesn't trip the constructor's project-ID guard, and doesn't spin up the lib client you don't need here):

```js
/**
 * Lists Model Garden publisher models. Catalog metadata, not a serveability check.
 * @param {{ publisher?: string, location?: string, pageSize?: number }} [opts]
 * @returns {Array<{id:string, name:string, versionId:string, launchStage:string}>}
 */
static listPublisherModels(opts = {}) {
  const cfg = AppConfig.get().VERTEX;
  const publisher = opts.publisher || "google";
  // "global" has no region prefix and shows the broadest catalog;
  // a regional host reflects what's serveable there.
  const location = opts.location || "global";
  const host = (location === "global")
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;

  const token = ScriptApp.getOAuthToken();
  const out = [];
  let pageToken = "", safety = 0;

  do {
    const url =
      `https://${host}/v1/publishers/${publisher}/models` +
      `?pageSize=${opts.pageSize || 200}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const resp = UrlFetchApp.fetch(url, {
      method: "get",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-goog-user-project": cfg.GOOGLE_CLOUD_PROJECT_ID  // quota/billing attribution
      },
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code !== 200) throw new Error(`publishers.models.list ${code}: ${body}`);

    const json = JSON.parse(body);
    (json.publisherModels || []).forEach(m => out.push({
      id: String(m.name || "").split("/").pop(),  // e.g. gemini-2.5-pro
      name: m.name,                                 // publishers/google/models/...
      versionId: m.versionId || "",
      launchStage: m.launchStage || ""
    }));
    pageToken = json.nextPageToken || "";
  } while (pageToken && ++safety < 20);

  return out;
}
```

And a diagnostic entry point in `99_EntryPoints.js`, matching your `debugPropertyReport()` style:

```js
function listVertexModels() {
  const models = GeminiService.listPublisherModels({ location: "global" });
  const gemini = models.filter(m => /^gemini/.test(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  console.log(`Found ${models.length} publisher models (${gemini.length} Gemini):`);
  gemini.forEach(m => console.log(`  ${m.id}  [${m.launchStage}]`));
  SpreadsheetApp.getActiveSpreadsheet().toast(`${gemini.length} Gemini models. See logs.`, "Vertex", 5);
  return models;
}
```

Three things worth knowing, in order of how likely they are to matter to you:

The path format is `publishers/{publisher}/models/{publisherModel}` — the name of the PublisherModel resource, format publishers/{publisher}/models/{publisherModel} — which is why I split the last segment off into `id` for a clean model string you can paste into `MODEL_ID`.

The catalog is location-sensitive in a way that's directly relevant to you: your config points at `us-central1`, but all Gemini 2.5 and later preview and experimental models are only available in the global location. Your `MODEL_ID` is `gemini-3.1-pro` — a 3.x model — so if a variant you want shows up only when you list against `global`, that's your signal that `VERTEX.LOCATION` needs to be `"global"` rather than `us-central1` for it to actually serve. Listing the catalog tells you a model *exists*; the real serveability test is a `generateContent` call in your chosen location, which your tool already does.

Last, defensive note: I'm confident on the endpoint and path, slightly less so on the exact response wrapper field. If the array comes back empty but the HTTP code is 200, log `body` once — the collection field is `publisherModels` in the responses I've seen, but a one-line check beats guessing. If instead you get a 401/403 with a scope complaint, add `https://www.googleapis.com/auth/cloud-platform` to your `appsscript.json` `oauthScopes` and re-authorize; everything else is already in place.
