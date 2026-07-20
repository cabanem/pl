# SDC form — 40-minute viability spike

Four seams, tested in isolation, each with a binary pass/fail and a defined
meaning for failure. Seam 0 (renderer correctness) is already proven by the
27-test suite; nothing here re-tests logic, only integration.

Seams 1 and 2 are independent — run them in either order or in parallel.

---

## Seam 1 — GAS serves the form and round-trips a POST (~10 min, zero Workato)

**Proves:** HtmlService's sandboxed iframe renders our full document (inline
CSS + JS), the cascade script executes in that sandbox, a plain form POST
reaches `doPost`, and `e.parameter` yields the exact envelope the shim
forwards.

1. New Apps Script project → paste `spike_shim.gs` (leave `STUB_MODE = true`).
2. Deploy → New deployment → Web app → Execute as **Me**, access **Anyone**.
3. Open the `/exec` URL in an incognito window.

**Pass criteria, in order:**
- The rate card form renders styled (header, meta line, white card). If it
  renders as unstyled text or blank, the sandbox is interfering — see failure
  meanings.
- Job family shows **Engineering** pre-selected and Role shows **Integration
  developer** — that's L9 cascade rehydration running live for the first time.
- Change Job family to **Finance** → Role repopulates to Financial analyst →
  select it → Seniority flips to disabled **"Not applicable"** (the
  empty-array branch, live).
- Set it back, pick a Seniority, hit Submit → the echo page shows
  `{token, fields}` with the correlation token and every field. Note
  `seniority` is **absent** when its dropdown was disabled — that's the
  missing ≡ null contract behavior, visible.

**If it fails:** a rendering/JS failure here means HtmlService's sandbox is
the problem, and no Workato work fixes it — the shim host moves to the Cloud
Function immediately (same spike, `run.app` URL, no sandbox). A POST failure
(echo never appears) means the same. This seam failing is the *only* outcome
that changes the architecture, which is why it goes first and costs nothing.

---

## Seam 2 — Workato returns `text/html` from a Python-rendered form (~15 min)

**Proves:** an API recipe on your plan can return raw HTML with the right
content type, and `renderer.py` runs inside a Workato Python action.

1. Throwaway API collection `SDC Spike` + API client + key (this is 4d-lite;
   it graduates or gets deleted).
2. New API recipe: trigger GET `/form`, no required params for the spike.
   Configure the response as raw text with header
   `Content-Type: text/html; charset=utf-8`.
3. Python action → paste `spike_render_action.py` whole. Output schema:
   `html` (string), `log` (string). No inputs needed — the fixture is
   embedded.
4. Respond 200 with the `html` datapill. Start the recipe, activate the
   endpoint.
5. `curl -sD - -H "api-token: KEY" "https://apim.workato.com/<prefix>/sdc-spike/form" | head -30`

**Pass criteria:** headers show `text/html`; body starts `<!DOCTYPE html>`.
Bonus check: pipe the body to a file and diff against `golden.html` — byte
equality proves the Workato Python runtime renders identically to your laptop
(the paste-drift failure mode, measured).

**If it fails:** if the response config can't emit raw HTML/content-type on
your plan, the render moves *out* of Workato and into the shim host (shim
fetches config JSON from Workato instead of HTML, renders locally) — the
contract survives intact, only the render site moves. If the Python action
itself fails, read the error: size/timeout limits would show here and nowhere
else.

---

## Seam 3 — The relay (~5 min, needs 1 + 2 green)

**Proves:** `UrlFetchApp` with the `api-token` header reaches the endpoint and
the relayed HTML renders in the browser.

1. In the GAS project: Script properties → `WORKATO_BASE` (collection base
   URL) and `API_TOKEN` (spike key).
2. Flip `STUB_MODE = false`. Deploy → Manage deployments → edit → new version
   (same URL keeps working).
3. Reload the incognito `/exec` URL.

**Pass criteria:** the identical form appears — but this time it traveled
browser → GAS → Workato → GAS → browser. Cascade still works (it's the same
bytes, but confirm).

**If it fails:** read `r.getResponseCode()` by temporarily echoing it — a 401
means header/key mixup; anything else is URL. Nothing architectural fails
here; this seam is plumbing.

---

## Seam 4 — POST through the whole chain (~10 min)

**Proves:** raw-text POST trigger, envelope parsing in Python, and HTML
response on the return path.

1. Second spike API recipe: trigger POST `/submit`, request content type
   **raw text**, same raw `text/html` response config. Python action → paste
   `spike_submit_echo.py`, map the raw request body to input `body`, output
   `html`. Respond 200 with it. Add to the collection.
2. In `spike_render_action.py` inside the Seam-2 recipe, replace `DEPLOY_ID`
   in the fixture's `action_url` with your real deployment id (so the
   Workato-rendered form posts back through the shim).
3. Reload the form via the shim, fill it, Submit.

**Pass criteria:** "Seam 4 PASS" page showing the parsed envelope — compare it
to Seam 1's echo; they should match. That page traveled browser → GAS →
Workato (parse) → GAS → browser, which is the complete production data path.

**If it fails:** a FAIL page with the raw body means the shim's re-encoding or
the raw-text trigger mapping is off — both visible in the echoed content,
which is why the echo prints the raw body on failure.

---

## Verdict table

| Result | Meaning |
|---|---|
| All four green | The architecture is proven end to end. Steps 4a–4d proceed as written; the spike client becomes 4d, the spike shim becomes step 5. |
| Seam 1 red | Host moves to Cloud Function; everything else unchanged. |
| Seam 2 red (response config) | Render moves into the shim host; Workato serves config JSON; contract unchanged. |
| Seam 3/4 red | Plumbing, not architecture — debug in place. |

Cleanup if you pause here: deactivate the two spike recipes and delete the
spike key. The GAS deployment can stay — it serves nothing real.
