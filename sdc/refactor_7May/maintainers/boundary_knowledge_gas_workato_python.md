# Boundary Knowledge: GAS ↔ Workato ↔ Python ↔ Excel

**What this is:** the accumulated, hard-won lessons about what happens to *values* when they cross the execution boundaries of the SDC platform. Every entry here cost at least one debugging session; several cost multiple across different months before the pattern was named. None of them are documented by the platforms involved.

**The one principle underneath all of it:**

> **At a boundary, never ask a value where it came from or what it is. Ask what it looks like, or ask it to do what you need and handle the failure.**

Identity checks (`instanceof`, `is_a?`, `isinstance` on wrapped types), assumptions about encoding, and assumptions about serialization format all break at boundaries, because the thing that crosses is never quite the thing that was sent — it's a wrapper, a re-encoding, a re-stringification, or an object from a foreign context. The reliable moves are **brand checks** (what does the value's structure say it is), **magic numbers** (what do the bytes say they are), and **try-and-rescue** (does it do the thing, regardless of what it claims to be).

Each section below covers one boundary: the principle, the mechanism, the symptom you'll see, the pattern to use, and the case history that earned the entry.

---

## 1. Workato → Python: file content is bytes, not base64 (usually)

**Principle:** file content from a binary datapill arrives in Python as a `bytes` object, *not* a base64 string — but sometimes it's a base64 string anyway. Never assume; **branch on the magic number.**

**Mechanism:** Workato's datapill layer sometimes hands Python raw bytes and sometimes a base64 rendering of the same content, depending on how the upstream action produced it and how the field was mapped. Calling `base64.b64decode` on raw bytes doesn't error — base64's alphabet overlaps enough that it silently "decodes" the binary into short garbage (the classic tell: a 68-byte output from a multi-KB input, with a nonsense head).

**Symptoms:** `"File is not a zip file"` from openpyxl; `UnicodeDecodeError: byte 0x8d` when an XLSX zip header hits a UTF-8 decoder; mysteriously tiny decoded payloads.

**Pattern:**

```python
import base64, binascii

def _to_bytes(content):
    """Normalize a Workato file datapill to bytes without corrupting binary."""
    if isinstance(content, (bytes, bytearray)):
        return bytes(content)
    if isinstance(content, str):
        return content.encode("latin-1")   # lossless byte-for-byte for binary-in-str
    raise TypeError(f"Unexpected file content type: {type(content)}")

def _decode_xlsx(content):
    """Return raw XLSX (zip) bytes. The bytes announce what they are."""
    raw = _to_bytes(content)
    magic = binascii.hexlify(raw[:4]).decode("ascii")
    if magic == "504b0304":      # 'PK\x03\x04' -> raw zip/xlsx, use as-is
        return raw
    if magic == "55457344":      # 'UEsD' -> base64-encoded xlsx, decode
        return base64.b64decode(raw)
    raise ValueError(f"Not a recognizable XLSX (magic={magic})")
```

Key details: `.encode('latin-1')` is the correct str→bytes normalization because latin-1 maps every byte value 0–255 one-to-one — UTF-8 would corrupt. `55457344` is the hex of the ASCII text `UEsD`, which is itself the base64 encoding of `PK\x03\x04` — the magic number of the *encoding of* the magic number. **Assert the magic at the boundary** — a third value means something upstream changed, and you want to know immediately, not three steps later.

**Diagnostics channel:** `print()` is not reliably surfaced by Workato Python actions. Route diagnostics through a declared **output field** (conventionally `log`), and on unexpected exceptions, return `traceback.format_exc()` through it — a catch-all `try/except` wrapping `main`'s body guarantees the structured return contract survives any failure.

**Related normalization:** cell values read from index/key columns need text normalization before matching — Excel numerics arrive as floats, so `1234.0` must collapse to `"1234"` or every join against a text key silently matches zero rows.

**Case history:** VAL-01's "File is not a zip file" (unconditional b64decode on raw bytes, May 2026); INC-01/INC-02's `0x8d` UnicodeDecodeError (XLSX routed to a CSV/UTF-8 path — fixed with magic-number dispatch between openpyxl and the CSV reader).

---

## 2. The outbound mirror: formula mode and `.decode_base64`

**Principle:** the byte-vs-text ambiguity is symmetric. Everything in §1 has a mirror on the way *out* of Python, at the datapill-mapping layer.

**Mechanism:** when handing base64 file content to a Workato file-writing action, the content field must be in **formula mode** with `=<pill>.decode_base64` — with formula mode OFF, the literal text `.decode_base64` is treated as part of a plain string, and the action stores the base64 *text* verbatim as the file's content.

**Symptom:** the stored "XLSX" opens as garbage; its first bytes read `UEsD…` (base64 text) instead of `PK\x03\x04`. Checking the stored file's first bytes is the definitive one-look diagnosis.

**Case history:** TPL-02's FileStorage password/corruption mystery (June 2026) — two hashing theories were empirically disproven before the actual cause turned out to be a content field that had dropped out of formula mode. The lesson generalizes: **when a stored file is wrong, check its first bytes before theorizing about the code that produced it.**

---

## 3. Workato → Python: hash-rocket serialization (Ruby leaking through)

**Principle:** a Ruby hash stringified by `to_s` is not JSON. If Python's `json.loads` sees `=>`, Ruby's default stringification ran somewhere between the producer and your input.

**Mechanism:** Workato's runtime is Ruby. A connector action that ends in `.to_json` produces real JSON — but if the pill is then wrapped in a formula construct that evaluates and re-stringifies it, or if the receiving field's **declared schema type is `object`** when a string pill is mapped in, Workato constructs a Ruby hash literal and renders it via `to_s`, producing `{"customer" => {...}}`.

**Symptom (the fingerprint):** `json.loads` failing with **"line 1 column 11, expecting ':' delimiter"** — position 10 is the space after the first quoted key, position 11 is the `=` of `=>`, exactly where JSON expects `:`. Any expecting-colon error at a low column number is this bug until proven otherwise.

**Fix checklist:** (1) the receiving input field's declared type must be `string`, not `object`, when the payload is a JSON string; (2) formula mode OFF for a direct pill-to-string handoff — formula mode is for *constructing* values, and a bare pill in formula mode invites re-stringification; (3) one-look diagnosis: `raise Exception(f"LEN: {len(raw)}, FIRST 80: {repr(raw[:80])}")` at the top of `main`.

**The rule of thumb unifying §2 and §3:** formula mode is a converter, not a decoration. It must be ON when the field needs Ruby evaluation (`.decode_base64`) and OFF when the pill is already the final value — and both mistakes fail silently at map time, surfacing only downstream.

---

## 4. Inside Workato's Ruby SDK: type introspection lies

**Principle:** in the connector runtime, **never ask an object what it is — ask it to do what you need and rescue the failure.** `is_a?`, `kind_of?`, and even `respond_to?` are unreliable on response objects.

**Mechanism:** Workato wraps HTTP responses and collections in proxy types that *behave* like Hash/Array (support `.each`, `[]`, `.map`) but do not satisfy `is_a?(Array)` or `is_a?(Hash)`. Branching on introspection sends execution down the wrong path with a valid-looking object in hand.

**Two specific traps:**

- **`Array(value)` is toxic.** Ruby's `Array()` coercion calls `.to_a` on hash-like wrappers, exploding them into `[["data", [...]]]` key-value pairs. Use `value.to_ary` (implicit conversion — only real Arrays implement it) with a `rescue`/fallback to `[value]`.
- **`is_a?(Array)` false-negatives on array-like wrappers** send execution to the Hash branch, where `response["data"]` string-indexes into an array-like → `TypeError`.

**Pattern:** direct access + rescue, encapsulated once:

```ruby
# Don't ask "are you a Hash?". Try the access; rescue if it isn't.
unwrap_envelope: lambda do |response|
  begin
    response["data"] || response
  rescue
    response
  end
end
```

Where a type branch is unavoidable, check Hash *first* (the only case where string indexing is safe) and make the array-ish path the catch-all.

**Case history:** the Data Tables connector review (March 2026) — `is_a?(Array)` false-negative producing `TypeError`; the follow-up connector build (April 2026) that replaced all introspection with begin/rescue and established the mental model. This is the Ruby twin of §5.

---

## 5. GAS container ↔ GAS library: `instanceof` is context-sensitive

**Principle:** the container script and a GAS library are **separate execution contexts with separate global constructors**. `value instanceof Date` inside the library returns `false` for a Date minted in the container — different `Date` constructor, no inheritance relationship. The cross-context-safe check is the brand check.

**Mechanism:** the container creates the Spreadsheet (`SpreadsheetApp.getActiveSpreadsheet()`), passes it to the library, and every `Date` that `getValues()` mints off it belongs to the container's context. Library-side `instanceof` fails; the value silently falls through to the non-Date branch of whatever function was checking. `Array.isArray` is already brand-safe; `instanceof` never is across this boundary.

**Symptom:** a diagnostic running in one context reports `[object Date]` while code in the other context rejects the same value as not-a-Date — a contradiction that only makes sense once you know there are two `Date`s in play. Failures are silent (wrong branch, not an exception).

**Pattern:**

```javascript
// NOT `value instanceof Date` — context-sensitive across the library boundary.
if (Object.prototype.toString.call(value) === '[object Date]') {
  return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
}
```

**Case history:** the expected-date field (July 2026) — `Util.toIsoDate` rejected valid picker-entered Dates as malformed, and `Drive.normalizeDates` had been silently skipping normalization on the same path since day one, masked only because no serialized sheet had carried a true Date before. Note the symmetry with §4: *same lesson, both runtimes.* Ruby's `is_a?` and JavaScript's `instanceof` fail at their respective boundaries for structurally identical reasons, and the fix in both is to ask what the value looks like.

---

## 6. GAS library deployment: pinning is a cache

**Principle:** a container pinned to a library version executes a **frozen snapshot**. Library edits are invisible to it until published (new deployment version) and repinned. When a fix "doesn't work," the fix may simply never have arrived.

**Diagnostic reflex (ten seconds, do it first):** `Logger.log(SDC.Version.LIBRARY)` from the container. If it prints a stale version, stop debugging the fix. Note this affects diagnostics too — a debug function resolving helpers via `SDC.*` faithfully reproduces the *pinned* bug, including the one you just fixed in HEAD.

**Working arrangement:** the development test workbook runs the library in **development mode** (tracks HEAD; every save is live). Everything else stays **pinned** and repins per release. Dev mode requires editor access to the library project and re-creates the scope-drift hazard (§7), so it's a scoped exception, never fleet policy. Corollary: accumulated fixes all arrive *at once* on repin — several simultaneous behavior changes after repinning is expected, not a new mystery.

---

## 7. GAS authorization: libraries run on the container's grant

**Principle:** a GAS library executes entirely under the **container script's** authorization and the running user's grant of the *container's* scopes. The library's own manifest is irrelevant at runtime.

**The failure ladder** (each produces "You do not have permission to call X. Required permissions: (...)" at runtime, not at authorization):

1. **Dev-mode scope drift:** a container referencing a library in development mode has its scope set frozen at the container's last save; when the library later grows code touching a new Google service, users are never re-prompted — they hit runtime permission errors instead. (The classic reason "re-auth never fired.")
2. **Granular consent:** users can individually uncheck scopes on the consent screen; the script works until the first call needing the unchecked scope. Remediation: revoke the app at myaccount.google.com/permissions and re-authorize clean.
3. **Insufficient scope tier:** `drive.file` does not satisfy `DriveApp.getFolderById` on arbitrary folders — the error text listing `(drive.readonly || drive)` is that signature.

**The durable fix:** explicit `oauthScopes` in the container's `appsscript.json` (replacing scope inference entirely), a pinned library version, and the release discipline that a library change touching a new Google service is a scope-affecting release requiring a manifest update + container resave. Hidden scope dependency worth remembering: `UrlFetchApp` calls that authenticate with `ScriptApp.getOAuthToken()` (e.g., the Sheets export endpoint) need the Drive scope *on that token* — a 403 HTML page from the export URL is a scope problem wearing an HTTP costume.

**Adjacent ACL layer (separate from scopes):** in My Drive, only a file's **owner** can trash it — multi-user cleanup routines fail silently on files other users created (shared drives fix this: drive-owned files, content managers can trash anything). And integration reads by **file ID + share** don't care what folder a file is in — which is what makes "write transient artifacts to user-owned scratch space, share by ID" a design option that deletes an entire folder-ACL coordination problem.

---

## 8. GAS runtime quirks worth one line each

- **`Utilities.computeDigest` returns SIGNED bytes** (−128..127). Hex-encoding without `& 0xFF` produces garbage for any byte ≥ 0x80. (`Util.sha256Hex` carries the mask.)
- **`getValues()` returns computed results, not formulas** — so volatile formulas (`NOW()`, `TODAY()`, `RAND()`) make serialized output differ every run. Content-fingerprinting anything containing one is drift by construction. (Case history: `_mapping!AR2`.)
- **Formatting is presentation, not value.** Number formats affect display only; a date format on a text cell converts nothing, and Format → Plain text converts a real Date *into* text. Type changes require re-entry (format → Automatic, delete, re-enter). Data validation with `setAllowInvalid(false)` blocks new entry but does not evict pre-existing content.
- **Two write channels, one race:** `SpreadsheetApp` mutations are queued; the Sheets REST API (`Sheets.Spreadsheets.batchUpdate`) is a separate channel that doesn't see them until `SpreadsheetApp.flush()`. Creating named ranges via SpreadsheetApp and immediately referencing them via the REST API fails intermittently without a flush between.
- **Two log destinations:** `console.warn`/`console.log` land in the **Executions panel** (Extensions → Apps Script → Executions), not in any sheet-side log. When a sheet log line is generic, the real message may be sitting in Executions.

---

## 9. Google Sheets → Excel: `INDIRECT` validation does not survive export

**Principle:** Google Sheets → XLSX export does **not** faithfully preserve `INDIRECT`-based data validation, regardless of how it was set. Dependent dropdowns cannot be built in a temp Google Sheet and exported; they must be written **natively into the XLSX** (openpyxl), with named ranges and the validation formula in Excel's own format.

**Two supporting facts:** the Sheets API's `ONE_OF_RANGE` condition rejects deeply nested formulas, so you can't work around it API-side; and this is the architectural reason the template-build path moved from GAS-export to Workato-Python-openpyxl in the first place.

**The load-bearing invariant once you're generating natively — one sanitization source:** the rule that names the lookup ranges and the `SUBSTITUTE` chain inside the `INDIRECT` formula **must derive from a single source**. Implemented as parallel rules, a parent value like `R&D` or `IT/Security` gets sanitized differently by each, the formula resolves to a name that doesn't exist, and the dropdown goes silently blank. The clean construction: scan all parent values up front, derive the substitution character set once, and use that one set both to sanitize range names and to build the chained `SUBSTITUTE` formula — synchronized by construction.

**Collision namespace:** distinct raw values can sanitize identically (`North/America` and `North-America` → `North_America`), silently merging dropdowns. Named ranges therefore carry a namespace: `LU_<lookup>__<sanitized_parent>`, and generation asserts uniqueness after sanitization rather than hoping.

---

## 10. The debugging reflexes, condensed

When something crosses a boundary and misbehaves, in order:

1. **Look at the first bytes / first characters.** Magic number for files (`504b0304` vs `UEsD`), `repr(raw[:80])` for strings, char-code dump for labels. The value announces what it is; theories don't.
2. **Confirm the code you fixed is the code that's running.** Version probe (§6) before any second round of debugging.
3. **Suspect the boundary before the logic.** A function that's correct in isolation and wrong in production almost always received something other than what its author pictured — wrapper, re-encoding, foreign-context object, stale snapshot.
4. **Check both log destinations** (§8) before concluding a failure is unlogged.
5. **When a check contradicts itself across contexts** (diagnostic says Date, code says not-Date), that's not a paradox — it's two contexts. §4/§5.

---

*Sources: SDC platform development, 2026. Case histories: VAL-01 zip error (May), INC-01/02 dispatch (June), TPL-02 formula-mode corruption (June), PRV hash-rocket parse (May), Data Tables connector introspection (Mar–Apr), dependent-dropdown export migration (Apr) and sanitization collision (May), expected-date `instanceof` and deployment-pinning episodes (July).*
