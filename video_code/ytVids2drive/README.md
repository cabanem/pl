# vid2notes: design notes

`vid2notes.py` turns YouTube training videos into study notes and files them as Google Docs in a Drive folder. It replaces a manual loop (copy the transcript, paste it into a Gem, copy the result somewhere) with one command that takes a list of URLs.

This file explains why the script is shaped the way it is. It is meant to be read once, top to bottom, and then consulted when you want to change something and need to know what the change might break.

## How the documentation is divided

Each kind of fact lives in exactly one place, so that nothing has to be kept in sync by hand.

| Where | What it answers | Example |
| --- | --- | --- |
| Docstrings | What does this function do, and what contract does it keep? | `get_transcript` returns the same shape from cache and from a fresh fetch |
| Inline comments | Why is this particular line the way it is? | `properties`, not `appProperties`, in the Drive query |
| `DESIGN.md` | Why is the architecture this way, and what was rejected? | One command with a cache, rather than two subcommands |
| Doctests | What does the function do for a concrete input? | `parse_timestamp("75:30")` is `4530.0` |

The docstrings follow PEP 257 (a one-line summary in the imperative, then detail) with Google-style `Args`, `Returns` and `Raises` sections. Sections are included only where they say something the signature does not; types live in the annotations and are not repeated in prose. The four non-trivial regexes are written with `re.VERBOSE` so that each part carries its own comment.

## The pipeline

```
YouTube captions ──► <id>.transcript.json ──► Gemini on Vertex AI ──► <id>.md ──► Google Doc
   stage 1 (cached, with title)                 stage 2                 stage 3 (create or update)
```

Every stage writes its artifact before the next stage starts. A failure in stage 3 therefore never costs a model call, and a failure in stage 2 never costs a request to YouTube.

## Architecture decisions

### 1. The video ID is the identity of a note

The ID names the cache file, names the local Markdown, and is stored as a property on the Doc. Every idempotent behaviour in the script follows from this: re-running a video reuses its transcript and updates its Doc. `video_id()` guarantees the ID matches `[A-Za-z0-9_-]{11}`, which is why it can be placed in file names, URLs and a Drive query string with no escaping anywhere downstream. Validation happens once, at the boundary.

### 2. One command with a cache, not two subcommands

`video2pptx` splits `analyze` from `build` because `slides.json` is something you edit by hand between the two. Here there is nothing to edit between fetching a transcript and generating notes, so the same benefit (never repeat the fragile step) comes from a cache, and you never have to think about which command to run.

The transcript fetch is the fragile step because `youtube-transcript-api` uses an undocumented interface and YouTube blocks addresses that ask too often. The title is cached alongside the transcript, so that once a video is cached, a re-run makes no request to YouTube at all. A title lookup that failed is stored as `null` and retried on the next run rather than remembered forever.

The cache stores the raw caption snippets, not the marker-formatted text. Changing `MARKER_SECONDS` or the formatting never invalidates it.

### 3. Markdown as the interchange format, not a JSON schema

`video2pptx` needs JSON because code consumes the structure: a title, bullets and a frame are placed onto a slide. Here the only consumers are Drive's converter and a reader. The model writes Markdown natively, and the Drive API converts `text/markdown` into a native Doc on upload, so no renderer is needed. The one structured thing the code needs back, the section timestamps, is recovered with a single regex.

Rejected: a response schema with sections as objects. It would have required a renderer to turn the JSON back into a document, and it would have constrained your Gem's instructions to whatever shape the schema allowed.

### 4. Style and contract are separate

Your Gem's instructions (`--instructions`) define how the notes read. `OUTPUT_CONTRACT` defines what the code depends on, and is always appended: the first line is an H1 (used as the fallback Doc name), and each H2 ends with a transcript marker (used to build links and to check coverage). You can replace the style freely without breaking the mechanics.

The instructions travel as the system instruction and the data (title, context, transcript) as the user turn. That mirrors how a Gem works, so Gem text drops in unchanged, and it keeps transcript text from being read as instructions.

### 5. A timestamp is the join key

This is the central idea of `video2pptx` (the model names a moment, ffmpeg fetches the frame) applied to text. The transcript is sent with a `[MM:SS]` marker at the start of each line of roughly thirty seconds. The model copies the relevant marker onto each section heading, and `finish_markdown()` turns it into a link that opens the video at that second.

Markers carry the start time of a real caption, not a point on a fixed grid, so every link lands on a caption boundary. Thirty seconds is a trade-off: finer markers cost tokens and clutter the text (per-caption timestamps would nearly double the prompt), coarser ones make the links land further from the content. Markers are written by `fmt_timestamp()` and read back by `parse_timestamp()`, which are inverses, so the model only ever copies a marker and never reformats one.

### 6. Two tiers of error handling

`die()` is reserved for configuration problems that make the whole run pointless, and all of them are detected before any work is done: a malformed URL, a missing project, a missing SDK, an unusable Drive folder. Everything that can go wrong for a single video is raised as an ordinary exception and caught once, in the loop in `main()`, so one bad video does not sink a batch.

The final log line lists the failed IDs so they can be pasted into a re-run. That is the retry mechanism; there is no retry logic inside the script. The exit status is 1 if anything failed, so the script can be used from another script.

### 7. One credential, the narrowest Drive scope

Both Vertex AI and Drive use Application Default Credentials, so the script contains no authentication code. The cost is a setup step: gcloud's built-in OAuth client may not request Drive scopes, so ADC has to be created with `--client-id-file` and an OAuth client of your own. A later plain `gcloud auth application-default login` silently drops the Drive scope; `drive_hint()` recognises the resulting 403 and prints the exact command to restore it. That command is built from the same `ADC_SCOPES` list the code uses, so the two cannot drift apart.

The scope is `drive.file`, under which the credential can only see files the script itself created. This is why `--make-folder` exists: the script must create the folder to be able to see it. The folder can be moved anywhere afterwards. If you would rather target a folder you made by hand, log in with the full `drive` scope instead.

Rejected: the `InstalledAppFlow` pattern from the Drive quickstart, with its own `token.json`. It needs the same OAuth client, adds a dependency and about fifteen lines of token handling, and leaves two credentials to keep alive instead of one.

`check_drive_folder()` makes one cheap request before the loop. Without it, a missing scope would only surface at the first upload, and a forty-video batch would make forty model calls and then fail forty uploads.

### 8. Upsert by property, never by name

`upsert_doc()` finds the existing Doc by a `video_id` file property within the folder. Renaming a Doc in Drive therefore does not produce a duplicate on the next run. An update sends only the new content and no metadata, so your renames and moves survive. Docs keeps the version history, and the source line under the title records which model wrote each version.

The property is a public `properties` entry rather than an `appProperties` entry. App properties are private to the OAuth client that wrote them, so rotating the client ID would orphan every Doc and the next run would duplicate them all.

### 9. Plain data, lazy imports, one file

Data moves through the script as dicts and lists that round-trip through JSON untouched. `Snippet` and `Transcript` are `TypedDict`s: they document the shape and let a type checker enforce it, and add nothing at runtime. There are no classes because there is no state that outlives a function call other than files on disk.

The three SDKs are imported inside the functions that use them. `--make-folder` works without the transcript library, a local-only run works without the Drive client, and `python -m doctest` works with nothing installed at all. `generate_notes()` receives the `google.genai.types` module as an argument for the same reason, which also lets a test hand in a stub.

### 10. Helpers are copied from video2pptx, not shared

Two scripts do not justify a shared module; a third would. The copied helpers sit together under one banner and are logically unchanged, so lifting them into a `gemini_common.py` later is mechanical.

| From `video2pptx.py` | Status here | Why |
| --- | --- | --- |
| `parse_timestamp`, `fmt_timestamp`, `_enum_name` | Carried over | Same job |
| `describe_response`, `log_gemini_summary` | Carried over, trimmed | Safety ratings and per-modality counts say nothing for text-only input |
| `log`, `die` | Simplified | No `run.log`: a re-run costs cents and Docs keeps history |
| Vertex client and config construction | Same pattern | Same model defaults, so the two scripts behave alike |
| `report_coverage` | Reduced to `check_coverage` | Only "stopped early" matters; gap checks misfire on concept-ordered notes |
| `stream_generate` and the heartbeat | Dropped | They keep a twenty-minute video ingestion alive; a transcript call takes about a minute |
| GCS upload, ffprobe, ffmpeg, python-pptx, run folders | Dropped | No video file and no pixels |

## Reading guide

Pure functions touch nothing outside their arguments and carry doctests.

| Function | Stage | Role | Touches |
| --- | --- | --- | --- |
| `video_id` | 1 | URL or bare ID to validated ID | pure |
| `video_title` | 1 | Title through oEmbed; `None` on any failure | network |
| `get_transcript` | 1 | Cache-first transcript and title | network, disk |
| `transcript_text` | 1 | Captions to marker-led lines | pure |
| `build_user_prompt` | 2 | Assemble the data half of the prompt | pure |
| `generate_notes` | 2 | One Gemini call; raises on empty output | network |
| `finish_markdown` | 2 | Unwrap, link timestamps, add source line | pure |
| `first_h1` | 2 | Fallback Doc name | pure |
| `check_coverage` | 2 | Warn if the notes stop before the video does | log only |
| `drive_service` | 3 | Drive client on ADC | none until used |
| `check_drive_folder` | 3 | Preflight: visible, a folder, writable | network |
| `upsert_doc` | 3 | Create the Doc or replace its content | network |
| `make_folder` | 3 | One-time folder creation for `drive.file` | network |
| `drive_hint` | 3 | Likely Drive failures to their fix; safe on any exception | pure |
| `read_targets` | CLI | Merge, validate and de-duplicate targets, in order | disk |
| `main` | CLI | Fail fast on configuration, then isolate each video | everything |

### Details that do not fit a docstring

`finish_markdown()` does three jobs in a fixed order. The whole-document code fence must be removed first, because otherwise line one is a fence and the H1 is not found. The fence pattern is anchored at both ends and greedy, so code blocks inside the notes survive. Timestamps are linked only on H2 to H6 lines and only at the end of the line; parentheses are accepted as well as brackets to tolerate model drift.

`check_coverage()` uses the latest timestamp, not the last one, because notes organised by concept need not be chronological. The start of the last caption stands in for the video's length, which avoids asking anyone for the duration.

In `transcript_text()`, the `or not buf` clause is redundant (the first caption always satisfies `start >= 0.0`). It stays as a guard against a future change to the initial value of `next_mark`.

`read_targets()` strips `#` comments from each line of the URL file. A URL with a `#fragment` would be cut there, which is harmless: the video ID always comes before the fragment.

If two Docs in the folder carry the same `video_id` (for instance after copying one in Drive, if the copy keeps its properties), `upsert_doc()` updates the first one the API returns.

## What you will see when something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `FAILED (IpBlocked)` or `(RequestBlocked)` | YouTube is rate-limiting your address | Wait; cached videos are unaffected. Do not run from a cloud VM |
| `FAILED (TranscriptsDisabled)` or `(NoTranscriptFound)` | No captions, or none in `--languages` | Try `--languages` with another code plus `--refetch` |
| `This app is blocked` during `gcloud ... login` | Login used gcloud's built-in client with a Drive scope | Add `--client-id-file` with your own OAuth client |
| `Cannot file Docs ... insufficient authentication scopes` | ADC was re-created without the Drive scope | Run the command the script prints |
| `Cannot file Docs ... has not been used in project` | Drive API not enabled | Enable it in the project that owns the OAuth client |
| `Cannot file Docs ... File not found` | Folder invisible under `drive.file` | Use `--make-folder`, or log in with the full `drive` scope |
| `WARNING: hit the 65,535-token output limit` | Thinking and notes share one budget | `--thinking none`, or ask for terser notes |
| `WARNING: no section starts in the last 30%` | The model stopped early, or the video ends in Q&A | Read the end of the Doc; re-run if it is cut short |
| Your organisation blocks creating an OAuth client | Policy | Omit `--drive-folder` and point `--work-dir` at a Drive for desktop folder; you get `.md` files instead of Docs |

## Testing

`python -m doctest vid2notes.py` runs twenty examples across the pure functions. It needs no network and no third-party package, so it doubles as a quick check that an edit did not break the parsing, the markers or the link rewriting.

During development the whole flow was also run with YouTube, Gemini and Drive replaced by stubs. That verified: create on the first run and update on the second; the transcript cache; the title being retried after a failed lookup, then cached, then backfilled into a cache file written before titles were stored; a bad video not stopping the batch; custom instructions still receiving the output contract; `--thinking none` sending no thinking config; a local-only run making no Drive calls; and the preflight ending the run before any model call.

Not verified, because the development sandbox had no network: the three live API calls. The one carrying the most doubt is `files.update` re-converting Markdown into an existing Doc. If a re-run leaves a Doc's content unchanged, the fallback is to trash the old Doc and create a new one carrying the same property, at the cost of the version history.

## Known limitations

The cache is keyed on the video ID alone, so changing `--languages` requires `--refetch`.

Notes are not cached, only transcripts. Re-running a URL file regenerates every video in it; to retry failures only, pass the failed IDs the last line printed.

There is no circuit breaker for a systemic Vertex failure such as an expired login. Every video would fail the same way. Each failure is fast and free, and the transcripts fetched along the way are cached, so nothing is lost but the log is noisy.

`check_coverage()` detects notes that stop early. It does not detect a skimmed middle.

Progress goes through `print`, matching `video2pptx`, rather than the `logging` module. If the two scripts ever share a module, that is the moment to switch both.

## Change log

**Revision 2.** The video title is cached with the transcript, so a cached video makes no request to YouTube (previously oEmbed was called on every run, which the docstring overstated). A Drive preflight, `check_drive_folder()`, runs before any model call. `build_user_prompt()` was extracted from `main()`. Full in-code documentation was added: docstrings with contracts, doctests, `TypedDict` data shapes, and commented regexes.

**Revision 1.** First version.

## References

- ADC and scopes outside Google Cloud: https://docs.cloud.google.com/docs/authentication/troubleshoot-adc
- youtube-transcript-api: https://github.com/jdepoix/youtube-transcript-api
- Markdown conversion through the Drive API: https://pulse.appsscript.info/p/2024/07/using-google-drive-api-and-google-apps-script-to-convert-between-google-docs-and-markdown/