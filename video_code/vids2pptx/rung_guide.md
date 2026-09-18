# video2pptx — Run Guide (Windows + Vertex AI)

Turns a recorded presentation (MP4) into a PowerPoint deck: one slide per step or
concept, terse bullets on the slide, the full spoken instruction in the speaker
notes, and a screenshot from the video wherever something on screen mattered.

**Files**

| File | Purpose |
|---|---|
| `video2pptx.py` | The whole pipeline. Two subcommands: `analyze` and `build`. |
| `requirements.txt` | Three Python packages. |
| `RUN_GUIDE.md` | This document. |
| `runs/` | Created on first `analyze`; one folder per run (see below). Safe to delete old ones. |

**How it works, in one paragraph.** `analyze` uploads the MP4 to a Cloud Storage
bucket (Vertex reads video from `gs://` URIs, not from your laptop), then asks
Gemini for a JSON deck. Gemini sees the video at one frame per second with a
timestamp on every second and hears the audio, so it can both write the
instruction and say *when* a visual was on screen. `build` takes that JSON, uses
ffmpeg to cut one frame at each timestamp, and lays the slides out with
python-pptx. The two halves are separate on purpose: `analyze` costs money and
minutes, `build` is free and instant, so you can edit the JSON and rebuild freely.

**Every run gets its own folder.** `analyze` creates `runs/<video>_<timestamp>/`
(or `runs/<name>/` with `--run name`) and everything for that run lives inside it,
so a second run never overwrites the first and frames from a test clip can't leak
into a full-length deck:

```
runs/talk_20260916-143205/
  prompt.txt     the exact prompt sent to the model
  slides.json    the model's output plus _meta (model, tokens, timing, video path,
                 and a `gemini` block: finish reason, tokens by modality, thinking)
  response.json  the complete raw API response, saved before parsing
  run.log        everything analyze and build printed, including all warnings
  frames/        slide01.jpg, slide02.jpg, …
  talk.pptx      the built deck
```

`build` with no arguments uses the newest run; `build --run runs/talk_…` picks one.
It reads the video's path from `slides.json`, so you don't retype it.

---

## 1. Install the three tools (once)

Open **PowerShell** (not the old Command Prompt). Run each check; install only
what's missing. Open a **new** PowerShell window after each install so `PATH`
updates take effect.

### 1a. Python 3.11 or newer

```powershell
python --version
```

If missing or older than 3.11:

```powershell
winget install --id Python.Python.3.12 -e
```

(Or download from python.org and tick **"Add python.exe to PATH"** in the installer.)

### 1b. ffmpeg (includes ffprobe)

```powershell
ffmpeg -version
ffprobe -version
```

If missing:

```powershell
winget install --id Gyan.FFmpeg -e
```

Open a new terminal and re-check both commands. If `winget` isn't available,
download the "release essentials" build from gyan.dev, unzip it, and add its
`bin` folder to your user PATH (Settings → System → About → Advanced system
settings → Environment Variables).

### 1c. Google Cloud CLI

```powershell
gcloud --version
```

If missing:

```powershell
winget install --id Google.CloudSDK -e
```

---

## 2. Set up Google Cloud (once)

You need a project with the Vertex AI API enabled, a bucket, and credentials on
this machine. If your org manages projects centrally, you may need an admin for
steps 2b–2c; the rest is yours.

### 2a. Log in and pick the project

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

`YOUR_PROJECT_ID` is the project *ID* (e.g. `rsr-automation-dev`), not the display name.

### 2b. Enable the APIs

```powershell
gcloud services enable aiplatform.googleapis.com storage.googleapis.com
```

### 2c. Create a bucket for the video

```powershell
gcloud storage buckets create gs://YOUR_BUCKET_NAME --location=us --uniform-bucket-level-access
```

Bucket names are globally unique, so something like `rsr-video2pptx-emily` works.
Any location is fine for the `global` Vertex endpoint; if your org requires a
specific region, use that here and pass the same region as `--location` later.

### 2d. Application Default Credentials (what the Python libraries read)

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

This is different from `gcloud auth login` in 2a. That one authorises the
`gcloud` command itself; this one writes a credentials file that the
`google-genai` and `google-cloud-storage` libraries pick up automatically, so
the script never handles a key.

### 2e. Permissions to confirm

Your account needs, on the project:

- **Vertex AI User** (`roles/aiplatform.user`) — to call Gemini
- **Storage Object Admin** on the bucket (or **Storage Admin**) — to upload the video

If you created the project yourself you already have these. If not and step 4
returns a 403, that's what to ask an admin for.

---

## 3. Set up the project folder (once)

```powershell
mkdir C:\video2pptx
cd C:\video2pptx
# copy video2pptx.py and requirements.txt into this folder

python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If `Activate.ps1` is blocked ("running scripts is disabled on this system"):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

then run the activate line again. Your prompt shows `(.venv)` when it's active.
Every new terminal session needs the activate line again.

Quick sanity check that everything imports:

```powershell
python -c "import google.genai, google.cloud.storage, pptx; print('ok')"
python video2pptx.py --help
```

---

## 4. Smoke test on a 5-minute clip (do this first)

Don't start with the full 50 minutes. Cut the first five minutes — a stream copy,
no re-encode, takes a couple of seconds — and run the whole pipeline on it. It
tests auth, upload, the model, JSON parsing, frame extraction and the deck for
a few cents and about a minute of waiting.

```powershell
cd C:\video2pptx
.\.venv\Scripts\Activate.ps1
ffmpeg -i "C:\path\to\talk.mp4" -t 300 -c copy test5.mp4

python video2pptx.py analyze --video test5.mp4 --project YOUR_PROJECT_ID --bucket YOUR_BUCKET_NAME
```

You should see `Run folder: runs\test5_…`, then `Uploading …`, then `Calling gemini-… on gs://…`,
then after roughly 30–90 seconds a line like `Done in 48s. 4 slides (3 with a frame) -> runs\test5_…\slides.json`.

Open that `slides.json` in your editor and check:

- Do the `title` / `bullets` reflect what was actually said?
- Are the `notes` complete? (This is the primary record — they should read like
  a competent transcript reorganised into instructions, not a summary.)
- Do the `frame_at` values look like `MM:SS` and fall inside the clip?
- Does the `Timeline:` line printed by `analyze` span the whole clip with no warnings?

Then build:

```powershell
python video2pptx.py build
```

It picks the run you just made. Open `runs\test5_…\test5.pptx`. Look at each slide with a screenshot and ask: is this the
frame I'd have chosen? If the frames are consistently a beat early (mid-transition,
before the dialog appears), see Tuning below. Open the notes pane (View →
Notes) to confirm the spoken instruction is there.

---

## 5. The full run

```powershell
python video2pptx.py analyze --video "C:\path\to\talk.mp4" --project YOUR_PROJECT_ID --bucket YOUR_BUCKET_NAME --context "Audience: <who>. This is a walkthrough of <what>. Terminology: <anything the model should spell correctly>."
```

What to expect:

- Upload is the slowest local step (a 50-minute 1080p recording is often 500 MB–2 GB).
  The script skips the upload on re-runs if the file is already in the bucket.
- The model call typically takes a few minutes. The script waits up to 30 minutes.
- Roughly 100 tokens per second of video at default resolution, so ~300K input
  tokens for 50 minutes — a small number of cents on a Flash model. Check the
  Vertex AI pricing page for the current rate; the script prints token counts.

When it finishes, review the run's `slides.json` the same way as in step 4, then:

```powershell
python video2pptx.py build
```

The deck lands in the run folder as `talk.pptx`, with the frames beside it in
`frames\` in case you want to reuse them elsewhere. To write the deck somewhere
else (a shared drive, say), add `--out "\\server\share\talk.pptx"`; the run
folder still keeps the frames and log.

---

## 6. Iterating — the part that makes this worth it

Because `build` is free, the fastest way to fix the deck is usually to edit the
run's `slides.json` and rebuild. If you want to keep the original output, copy the
run folder first (`Copy-Item -Recurse runs\talk_… runs\talk-edited`) and build
with `--run runs\talk-edited`; both versions then sit side by side.

| Problem | Edit in `slides.json` |
|---|---|
| Wrong frame on a slide | Change `frame_at` to the timestamp you want (scrub the video to find it). |
| Slide doesn't need a picture | Set `frame_at` to `""`. |
| Slide should have a picture | Put a timestamp in `frame_at` and a line in `frame_caption`. |
| Two slides should be one | Merge the bullets and notes, delete the other object. |
| Bullet is wrong / too long | Just fix the text. |
| Deck title | Change `deck_title`. |
| Find where a slide came from | `starts_at` is where its content begins in the video; `frame_at` is where its screenshot was taken. |

Re-run `build` (or `build --run <folder>`). Seconds.

Re-run `analyze` only when the *shape* of the deck is wrong — too many slides,
too few, missing sections, frames systematically off. Then use the knobs below.

---

## 7. Tuning knobs (`analyze`)

| Flag | Default | When to change it |
|---|---|---|
| `--context "..."` | none | Always worth setting. Audience, purpose, product names, jargon. Cheapest lever, biggest effect on quality. |
| `--min-slides N` | ~1 per 2 min, at least 5 | Deck came back too thin. The prompt asks for at least this many and the script warns if it gets fewer. |
| `--max-slides N` | 40 | Deck too long. A ceiling, not a target. |
| `--resolution high` | model default | The visual instruction involves small text — settings dialogs, code, spreadsheet cells — and the model is misreading or ignoring it. Costs ~3× the video tokens. |
| `--resolution low` | model default | You hit a context/size limit, or the visuals are large and simple (slides, diagrams). Cheapest. |
| `--model ...` | `gemini-3.5-flash` | Swap for a newer Flash, or a Pro model, if you want higher quality. Check the Vertex AI Model Garden for current IDs. |
| `--location ...` | `global` | Your org requires a specific region (data residency), or the model you want isn't served on the global endpoint. |
| `--run NAME` | `<video>_<timestamp>` | Give the run folder a meaningful name (`--run talk-highres`) when you're comparing settings. |
| `--gcs-uri gs://...` | — | You already uploaded the video (e.g. `gcloud storage cp talk.mp4 gs://bucket/`) and want to skip the script's upload. |

If frames are consistently a beat early, add to `--context`:
`"When choosing frame_at, pick a moment 2-3 seconds after the screen changes, once it has fully rendered."`

Two things live in the script rather than flags, because you'll rarely touch
them: the `PROMPT_TEMPLATE` (the instructions to the model) and the `STYLE`
dict (font, sizes, colours). Both are at the top of `video2pptx.py`.

---

## 8. Troubleshooting

**`Video not found (… no path recorded in the run)`** — The run's `slides.json`
was made by an older version of the script, or the video moved. Pass `--video`.

**`ffmpeg` is not recognized** — It isn't on PATH in this terminal. Open a new
PowerShell window; if still missing, redo step 1b.

**`DefaultCredentialsError` / "could not automatically determine credentials"** —
Step 2d wasn't run, or was run as a different Windows user. Run
`gcloud auth application-default login` again.

**`403 PERMISSION_DENIED` on `aiplatform.googleapis.com`** — Either the API isn't
enabled (step 2b) or your account lacks Vertex AI User (step 2e). The error
message says which.

**`403` on the bucket / upload fails** — Your account can't write to the bucket.
Ask for Storage Object Admin on it, or upload with `gcloud storage cp` (which
uses your `gcloud auth login` identity) and pass `--gcs-uri`.

**`404 NOT_FOUND` / "model not found"** — The model ID is wrong, retired, or not
served in that location. Check the Model Garden for the current Flash/Pro ID
and pass it with `--model`; try `--location global` if you had set a region.

**`400` mentioning token limit / video too long** — Re-run with `--resolution low`.

**`ERROR: Model output was not valid JSON`** — The script saved the raw text to
`slides.raw.txt` in the run folder, and the `Gemini:` line just above the error
says why. `finish: MAX_TOKENS` means it was truncated: lower `--max-slides`
(e.g. 30) and retry. If it's a JSON syntax slip, you can often
fix it by hand and save it as `slides.json`.

**`ERROR: Gemini call failed …`** — The API's own message is printed and logged.
Token-limit or input-size wording → `--resolution low`. Model-name or location
wording → check `--model` / `--location`.

**Timeout / connection reset after a long wait** — Retry; the upload is
skipped on the second run, so only the model call repeats. Video processing on
the Vertex side occasionally stalls.

**Reading the `Gemini:` line** — every `analyze` prints one line like

```
Gemini: gemini-3.5-flash-001 | finish: STOP | in 302,411 (video 268,000, audio 33,200, text 1,211) | thinking 8,900 | out 14,300 | total 325,611
```

- `finish: STOP` is the only good value. `MAX_TOKENS` means the answer was cut off
  at the 65,535-token output limit — and *thinking tokens count against that
  limit*, so a run where the model thought hard can truncate even when the JSON
  would have fit. Lower `--max-slides`, or split the video. Any other value
  (`SAFETY`, `RECITATION`, …) means the model stopped for a policy reason; the
  details are in the run's `response.json`.
- `in` is the whole prompt. Video should dominate at roughly 100 tokens per
  second of footage at default resolution (about 3× that at `--resolution high`);
  audio adds about 30 per second. If `video` is far below what the duration
  implies, the model didn't see the whole file. If `in` is above ~850,000 you're
  near the 1M context window — use `--resolution low`.
- `thinking` is the model's reasoning before it answered; large values are
  normal for long inputs, but they eat into the output budget.
- `out` is the JSON itself. Around 300–500 tokens per slide is typical.

**Far fewer slides than expected (e.g. 7 from 50 minutes)** — `analyze` now prints
a timeline line and warnings that say which of three things happened:

- *"prompt used N tokens but ~M were expected"* — the model didn't ingest the whole
  file. Confirm `--video` is the full recording, and run `ffprobe talk.mp4` to check
  it has an audio stream (a `Stream #0:1 … Audio:` line). No audio means Gemini only
  had the pictures, and the notes will read like captions instead of instruction.
- *"the last slide starts at X of Y"* — it saw the file but stopped early. Retry;
  if it repeats, add `--context "The video runs the full N minutes; cover it all."`
- *"only N slides; the prompt asked for at least M"* with good timeline coverage —
  it merged steps, usually by mirroring the presenter's own slide count. Re-run with
  `--context` naming the kinds of steps you expect to see split out, or raise
  `--min-slides`. Every slide carries a `starts_at` timestamp, so you can also see
  exactly where the merging happened.

**Frames are black or blank** — Usually a timestamp that lands on a transition
or a cut. Edit `frame_at` in the JSON by a second or two and rebuild.

**A slide's text overflows** — The model wrote more than 5 bullets or very long
ones. Trim in the JSON. (Speaker notes have no length problem — they're in the
notes pane.)

**PowerShell says scripts are disabled** — See step 3, `Set-ExecutionPolicy`.

---

## 9. Reading the code

`video2pptx.py` is about 400 lines in four blocks: configuration and prompt at
the top (the part you'd change), shared helpers (timestamp parsing, ffprobe),
`cmd_analyze` (upload → prompt → Gemini → JSON), and `cmd_build` (JSON → ffmpeg
→ python-pptx). Each function's docstring says what it does and why.

Two design choices worth knowing about: the response schema is passed to Gemini
so the output is guaranteed to be parseable JSON with exactly those fields (no
prompt-only "please return JSON"); and bullets are real PowerPoint bullets
(`a:buChar` with a hanging indent) rather than literal "•" characters, so they
behave like bullets when someone edits the deck afterwards.
