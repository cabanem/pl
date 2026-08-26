# CHANGES — Corpus Q&A (v1) · 2026-08-26

Two new files, six patched. Patches were computed programmatically against your uploaded
`workato-inv.zip` — untouched lines are byte-identical, and each file keeps its own
line-ending style (06 and 12 are CRLF in your project; everything else is LF). All eight
files pass `node --check`. The 12 new tests were **executed** here against these exact bytes
(GAS globals shimmed, real SHA-256): 12/12 pass.

---

## New files

### `13_Feature_CorpusQa.js` — 427 lines
- `CORPUS_ANSWER_CONTRACT` — the verbatim answer contract (tests assert on it; change deliberately or not at all).
- `CorpusStore` — one seam over ConfigStore (script scope) for `CORPUS_DIGEST_FILE_ID` / `_FP` / `_AT`.
- `CorpusDigestBuilder` — gathers via `ChangeLedgerRunner.readRows_` (the project's key-resolving read seam, already backed by `withLedgerBackend_` in tests), builds a deterministic body (blocks RECIPES → ANALYSES → EDGES → RECENT_CHANGES → AMBIGUITY → DECISIONS), fingerprints the body (header excluded), skips the write when unchanged, refuses (throws → alert email under `runGuarded_`) when over `QA.DIGEST_MAX_CHARS`. Digest is one plain-markdown Drive file, id cached; the id survives moves, so park the file anywhere private (O3).
- `CorpusQaService.ask(question, ctx?)` — loads the digest (the `loadContext_()` seam — v1 whole-digest; v2 block selection lives here), ONE `answerFromCorpus` call, shapes the response (tolerates null/junk), appends an audit row to System_Logs, returns `{question, answer, citations, not_in_corpus, as_of}`.
- Global `askCorpus(question)` — the future web app's `google.script.run` target; delegates through `Commands`.
- Deliberately skipped: the CacheService layer (one Drive read is ~instant at 58 recipes — complexity without payoff).

### `53_Tests_Corpus.js` — 437 lines, 12 tests
- Tier 1 hermetic ×9: block order + name resolution + window, HEADER/fp/counts, fingerprint determinism, unchanged-skips-write + changed-stores-fp-after-write, oversize refusal, window filter, contract content, response shaping, config + cron wiring (hour 9, no collisions, 8 reserved for weekly docs).
- Tier 2 integration ×3 (GeminiLib-gated with `Assert.skip`): `ask()` end-to-end with canned Gemini (shape, as-of chip, exactly one audit row), the refusal trap path, contract-verbatim-in-prompt ordering.
- `GOLDEN_QUESTIONS` + `runLiveGoldenEval()` — MANUAL ONLY, real Gemini + real digest, prints a scorecard. Never wired into `runAllTests*`.
- Entry points: `runCorpusTests()`, `runCorpusHermeticTests()`, `runAllTestsWithCorpus()` (all six register sets — 50's, 52's, and these). Does **not** rebind `Assert` (L4).

## Patched files

### `00_CoreContext.js` — `***UPDATED***` ×1
- Registered `corpus.ask` (passes ctx through) and `corpus.digest` (manual builder run) in `Commands`.

### `01_CoreConfig.js` — `***UPDATED***` ×2
- `INTEGRATION.DECISIONS_FOLDER_ID` (script property, empty default — DECISIONS block degrades gracefully until set). O1: ADRs as `.md` files in that folder.
- New `QA` block: `RECENT_CHANGES_DAYS: 14`, `DIGEST_MAX_CHARS: 700000`. Runtime state stays in ConfigStore, not here.

### `06_GeminiService.js` — `***UPDATED***` ×2
- `answerFromCorpus(corpusDigest, question)` — ONE `generateStructured` call; returns the parsed object or null. The digest tripping GeminiLib's 100k-char warning is expected and harmless; nothing on this path truncates.
- `_buildCorpusPrompt` — contract first (verbatim), then corpus, then question; joined lines so the digest picks up no indentation noise.

### `12_Cron.js` — `***UPDATED***` ×4
- **BUG FIX:** `cron_ai` called `new AiAnalysisRunner().run(ctx.ids)` — `ctx.ids` is undefined, so the runner received no context and threw `TypeError` the first night the gate found stale recipes (that's the "[SDC docs] AiAnalysis failed" alert path). Now `run(ctx, ids)`.
- Cleanup: removed a stray no-op `'';` expression after the `ALERT_EMAIL` read (leftover from an earlier edit).
- Added `{ handler: 'cron_digest', hour: 9 }` to `CRON_NIGHTLY` (after `cron_ai` at 7; hour 8 stays Monday's `cron_docs_weekly`).
- Added `function cron_digest()` wrapping the builder in `runGuarded_`.

### `21_UIMenu.js` — `***UPDATED***` ×3
- Basic menu: "Ask the corpus (Q&A)" item (O2 interim surface).
- Advanced menu: "Corpus Q&A" submenu — Ask a question… / Rebuild corpus digest.
- **BUG FIX:** `showConfiguration()` line 193 read `user[GOOGLE_CLOUD_PROJECT_ID]` (unquoted key) — a `ReferenceError` whenever the project id lived only in user-scope properties. Now quoted.

### `99_EntryPoints.js` — `***UPDATED***` ×2
- `askCorpusPrompt()` — prompt dialog → `askCorpus()` → alert with answer, citations, and the as-of chip.
- `rebuildCorpusDigest()` — `Commands.run("corpus.digest")`.

---

## Paste-integrity checklist (Ctrl+F each file after pasting)

| File | Check |
|---|---|
| `00_CoreContext.js` | `***UPDATED***` ×1 · 126 lines |
| `01_CoreConfig.js` | `***UPDATED***` ×2 · 236 lines |
| `06_GeminiService.js` | `***UPDATED***` ×2 · 337 lines |
| `12_Cron.js` | `***UPDATED***` ×4 · 80 lines |
| `21_UIMenu.js` | `***UPDATED***` ×3 · 257 lines |
| `99_EntryPoints.js` | `***UPDATED***` ×2 · 215 lines |
| `13_Feature_CorpusQa.js` | `## BLOCK:` ×8 · `CORPUS_` ×17 · 427 lines |
| `53_Tests_Corpus.js` | `runner.add(` ×12 · `Assert.` ×71 · 437 lines |

Paste **whole files** (select-all → replace), never retyped fragments.

## First-run sequence

1. **Before pasting anything:** run `runAllTestsWithLedger()` on the current project and confirm 27/27 (the still-outstanding baseline). Any red → stop, we fix drift first.
2. Paste all eight files (create `13_…` and `53_…` as new script files; replace the six others wholesale). Run the Ctrl+F checks above.
3. Run `runAllTestsWithCorpus()` — expect **39/39** (27 existing + 12 new; integration tests skip only if a library is unbound, which yours aren't).
4. Run `installNightlyTriggers()` once — idempotent, and required so the hour-9 `cron_digest` trigger actually exists.
5. Optional now / later: create a `decisions/` Drive folder with ADR `.md` files and set script property `DECISIONS_FOLDER_ID` (Project Settings → Script properties). Until then the DECISIONS block says so and everything else works.
6. Run `rebuildCorpusDigest()` for the first build (creates `SDC_Corpus_Digest.md` in the executing account's My Drive — move it to your private folder; the cached id follows it).
7. Menu → "Ask the corpus (Q&A)" → try "Which recipes call INV-01?"
8. Run `runLiveGoldenEval()` (costs 4 real Gemini calls) and read the scorecard. Note: the golden set includes the ~scope-suffix "why" question — it can only cite an ADR once one exists (step 5), so expect that line to flag until then.

## Definition-of-done status

- [x] Digest builds nightly, fingerprint-gated (quiet night logs "unchanged", writes nothing) — wired + tested
- [x] `askCorpus(...)` returns cited answers with the as-of chip — wired + tested with canned Gemini
- [x] Trap question path refuses with the exact escape phrase — tested
- [x] Every ask leaves an audit row — tested
- [ ] `runAllTestsWithCorpus()` green **in your editor** (39 expected) — yours to run
- [ ] `runLiveGoldenEval()` scorecard clean against the real digest — yours to run after step 6
- [x] Whole-file deliverables · `node --check` clean · this register with paste counts
