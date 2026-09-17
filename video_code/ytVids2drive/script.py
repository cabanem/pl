#!/usr/bin/env python3
"""
vid2notes.py - turn YouTube training videos into study notes, filed as Google Docs in Drive.

    YouTube captions  -->  Gemini on Vertex AI  -->  Markdown  -->  Google Doc in a Drive folder

Sibling of video2pptx.py, and built on the same two ideas:

  * Keep the flaky/expensive step separate from the cheap one. There, `analyze` vs `build`.
    Here, the transcript fetch is the fragile step (unofficial endpoint, and YouTube blocks IPs
    that ask too often), so each transcript is cached in --work-dir on first fetch. Re-running
    to try a different prompt never touches YouTube again.
  * A timestamp is the join key between the model's text and the video. The transcript is sent
    with [MM:SS] markers, the model ends each section heading with the marker where it starts,
    and the script turns those into links that open the video at that moment.

The video ID is the identity of a note. The Doc carries it as a Drive property, so a re-run
updates the same Doc (Docs keeps the version history) instead of piling up duplicates.

Setup (once)
------------
    pip install google-genai youtube-transcript-api google-api-python-client

    Vertex works with plain ADC, as in video2pptx. Drive does not: gcloud's built-in OAuth client
    may not request Drive scopes, so ADC has to be minted with a client ID of your own.
      1. In the project: enable the Google Drive API, then APIs & Services > Credentials >
         Create OAuth client ID > Desktop app (consent screen: Internal). Download the JSON.
      2. gcloud auth application-default login --client-id-file=client_secret.json ^
             --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.file
      3. python vid2notes.py --make-folder "GCP training notes"      (prints the folder ID)

    drive.file is the narrow scope: this credential can only see what this script created, which
    is why the script makes the folder. Move the folder anywhere you like afterwards; the ID and
    the access travel with it. To target a folder you made by hand, use the full .../auth/drive
    scope in step 2 instead and skip step 3.

Usage
-----
    python vid2notes.py URL [URL ...] --project MY_PROJECT --drive-folder FOLDER_ID
    python vid2notes.py --urls-file course.txt --project MY_PROJECT --drive-folder FOLDER_ID ^
        --instructions gem.txt --context "Course: Developing apps on Google Cloud. Products: Cloud Run, Pub/Sub"

Without --drive-folder the notes are only written to --work-dir as <video_id>.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path

# --------------------------------------------------------------------------
# Configuration you may want to tweak
# --------------------------------------------------------------------------

DEFAULT_MODEL = "gemini-3.5-flash"   # same defaults as video2pptx
DEFAULT_LOCATION = "global"
DEFAULT_THINKING = "low"             # restructuring text, not reasoning
DEFAULT_WORK_DIR = "vid2notes_work"  # <id>.transcript.json (cache) and <id>.md (last notes) live here
MAX_OUTPUT_TOKENS = 65535            # includes thinking tokens
TIMEOUT_MINUTES = 10
MARKER_SECONDS = 30                  # a [MM:SS] marker starts each ~30 s block of transcript
FETCH_PAUSE_SECONDS = 1.0            # politeness gap between uncached YouTube requests

GOOGLE_DOC = "application/vnd.google-apps.document"
GOOGLE_FOLDER = "application/vnd.google-apps.folder"
DRIVE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform",
                "https://www.googleapis.com/auth/drive.file"]
ADC_LOGIN = ("gcloud auth application-default login --client-id-file=client_secret.json "
             "--scopes=" + ",".join(DRIVE_SCOPES))

# Style: replace this with your Gem's instructions via --instructions FILE.
DEFAULT_INSTRUCTIONS = """\
You turn the transcript of a technical training video into study notes for a working developer.
- Organise by concept. Merge repetition, drop greetings, recaps, and filler.
- Preserve exact product names, API and method names, flags, commands, quotas, limits, and defaults.
- The captions may be auto-generated and mangle names: normalise them ("big query" -> BigQuery,
  "pub sub" -> Pub/Sub, "cloud run" -> Cloud Run).
- Capture decision rules (when to use X rather than Y) as short lists or small tables.
- Put commands and code in fenced code blocks.
- Finish with "Key takeaways" and "To verify or look up".
- Never add facts that are not in the transcript. If something is unclear, say so.
"""

# Contract: always appended, because the code below depends on it whatever the style says.
OUTPUT_CONTRACT = """\

Output contract (required by the program that files these notes):
- Output Markdown only: no preamble, and no code fence around the whole document.
- The first line is a single H1 (# ) with a specific title for the notes.
- The transcript carries [MM:SS] markers. End every H2 (## ) heading with the marker where that
  section's material begins, for example: ## IAM role types [07:30]
  Use only markers that appear in the transcript. Cover the whole video, start to finish.
"""


# --------------------------------------------------------------------------
# Helpers carried over from video2pptx.py (unchanged unless noted)
# --------------------------------------------------------------------------

def log(msg: str) -> None:                      # simplified: no run.log tee, Docs keeps the history
    print(msg, flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


_TS_RE = re.compile(r"^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.(\d+))?\s*$")


def parse_timestamp(value: str | None) -> float | None:
    """'07:45' / '1:02:30' / '07:45.5' -> seconds. Anything else -> None."""
    if not value:
        return None
    m = _TS_RE.match(value)
    if not m:
        return None
    hours = int(m.group(1) or 0)
    minutes = int(m.group(2))
    seconds = int(m.group(3))
    frac = float("0." + m.group(4)) if m.group(4) else 0.0
    return hours * 3600 + minutes * 60 + seconds + frac


def fmt_timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _enum_name(value) -> str | None:
    if value is None:
        return None
    return getattr(value, "name", None) or str(value)


def describe_response(response) -> dict:
    """What the API tells us about the call, flattened (trimmed from video2pptx: no safety detail)."""
    usage = getattr(response, "usage_metadata", None)
    cands = getattr(response, "candidates", None) or []
    cand = cands[0] if cands else None
    feedback = getattr(response, "prompt_feedback", None)
    return {
        "model_version": getattr(response, "model_version", None),
        "finish_reason": _enum_name(getattr(cand, "finish_reason", None)),
        "finish_message": getattr(cand, "finish_message", None),
        "prompt_tokens": getattr(usage, "prompt_token_count", None),
        "thinking_tokens": getattr(usage, "thoughts_token_count", None),
        "output_tokens": getattr(usage, "candidates_token_count", None),
        "block_reason": _enum_name(getattr(feedback, "block_reason", None)),
    }


def log_gemini_summary(g: dict) -> None:
    """One dense line about the call, then warnings (reworded for notes)."""
    def n(x): return f"{x:,}" if isinstance(x, int) else "?"
    log(f"  Gemini: {g.get('model_version') or '?'} | finish: {g.get('finish_reason') or '?'} | "
        f"in {n(g.get('prompt_tokens'))} | thinking {n(g.get('thinking_tokens'))} | out {n(g.get('output_tokens'))}")
    fr = g.get("finish_reason")
    if fr == "MAX_TOKENS":
        log(f"  WARNING: hit the {MAX_OUTPUT_TOKENS:,}-token output limit, so the notes are cut off. "
            f"Try --thinking none, or ask for terser notes in your instructions.")
    elif fr and fr != "STOP":
        log(f"  WARNING: finish reason was {fr}{' - ' + g['finish_message'] if g.get('finish_message') else ''}.")
    if g.get("block_reason"):
        log(f"  WARNING: the prompt was blocked ({g['block_reason']}).")


# --------------------------------------------------------------------------
# 1. Transcript: YouTube captions, cached by video ID
# --------------------------------------------------------------------------

_ID_RE = re.compile(r"(?:[?&]v=|youtu\.be/|/embed/|/live/|/shorts/)([A-Za-z0-9_-]{11})")


def video_id(url_or_id: str) -> str | None:
    s = url_or_id.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    m = _ID_RE.search(s)
    return m.group(1) if m else None


def get_transcript(vid: str, work: Path, languages: list[str], refetch: bool) -> dict:
    """Cached transcript if present, else fetch and cache. Unlisted videos work; private ones do not."""
    cache = work / f"{vid}.transcript.json"
    if cache.is_file() and not refetch:
        log("  transcript: cached")
        return json.loads(cache.read_text(encoding="utf-8"))

    from youtube_transcript_api import YouTubeTranscriptApi   # imported here so --make-folder never needs it
    t = YouTubeTranscriptApi().fetch(vid, languages=languages)
    data = {"video_id": vid, "language_code": t.language_code, "is_generated": t.is_generated,
            "fetched_at": dt.datetime.now().isoformat(timespec="seconds"), "snippets": t.to_raw_data()}
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    log(f"  transcript: fetched {len(data['snippets'])} caption lines "
        f"({'auto-generated' if t.is_generated else 'human-made'}, {t.language_code})")
    time.sleep(FETCH_PAUSE_SECONDS)
    return data


def video_title(vid: str) -> str | None:
    """oEmbed needs no API key and answers for unlisted videos. None on any failure: the title is a nicety."""
    import requests   # already a dependency of youtube-transcript-api, and honours the same proxy/CA settings
    try:
        r = requests.get("https://www.youtube.com/oembed",
                         params={"format": "json", "url": f"https://www.youtube.com/watch?v={vid}"}, timeout=10)
        r.raise_for_status()
        return r.json().get("title") or None
    except Exception:  # noqa: BLE001
        return None


def transcript_text(snippets: list[dict]) -> str:
    """One line per ~MARKER_SECONDS of speech, each starting with its [MM:SS] marker."""
    lines: list[str] = []
    buf: list[str] = []
    next_mark = 0.0
    for s in snippets:
        if s["start"] >= next_mark or not buf:
            if buf:
                lines.append(" ".join(buf))
            buf = [f"[{fmt_timestamp(s['start'])}]"]
            next_mark = s["start"] + MARKER_SECONDS
        text = " ".join(s["text"].split())
        if text:
            buf.append(text)
    if buf:
        lines.append(" ".join(buf))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 2. Notes: transcript --> Gemini (Vertex AI) --> Markdown
# --------------------------------------------------------------------------

def generate_notes(client, types, model: str, thinking: str, system: str, user_text: str) -> str:
    """Plain generate_content: a transcript call takes well under a minute, so none of video2pptx's
    streaming/heartbeat machinery (there to keep a 20-minute video ingestion alive) is needed."""
    config_kwargs = dict(
        system_instruction=system,
        temperature=0.2,             # faithful extraction, not creativity
        max_output_tokens=MAX_OUTPUT_TOKENS,
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    if thinking != "none":
        config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=thinking)
    response = client.models.generate_content(model=model, contents=user_text,
                                              config=types.GenerateContentConfig(**config_kwargs))
    log_gemini_summary(describe_response(response))
    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("the model returned no text (see the Gemini line above)")
    return text


_FENCE_RE = re.compile(r"\A```(?:markdown|md)?[ \t]*\n(.*)\n```\s*\Z", re.DOTALL)
_HEADING_TS_RE = re.compile(r"^(#{2,6}[ \t].*?)[ \t]*[\[(]((?:\d{1,2}:)?\d{1,3}:\d{2})[\])][ \t]*$", re.MULTILINE)


def finish_markdown(md: str, vid: str, title: str | None, model: str) -> tuple[str, list[float]]:
    """Unwrap a stray whole-document fence, link heading timestamps to the video, add a source line.
    Returns (markdown, heading timestamps in seconds) - the second feeds the coverage check."""
    m = _FENCE_RE.match(md)
    if m:
        md = m.group(1)

    stamps: list[float] = []

    def link(match: re.Match) -> str:
        secs = parse_timestamp(match.group(2))
        if secs is None:
            return match.group(0)
        stamps.append(secs)
        return f"{match.group(1)} ([{match.group(2)}](https://youtu.be/{vid}?t={int(secs)}))"

    md = _HEADING_TS_RE.sub(link, md)

    source = (f"Source: [{title or vid}](https://www.youtube.com/watch?v={vid}) | "
              f"notes generated {dt.date.today():%Y-%m-%d} by {model}")
    lines = md.split("\n")
    at = 1 if lines and lines[0].startswith("# ") else 0     # directly under the H1 if there is one
    blank_follows = at < len(lines) and not lines[at].strip()
    lines[at:at] = ["", source] if blank_follows else ["", source, ""]
    return "\n".join(lines).strip() + "\n", stamps


def first_h1(md: str) -> str | None:
    m = re.search(r"^# +(.+?)\s*$", md, re.MULTILINE)
    return m.group(1) if m else None


def check_coverage(stamps: list[float], snippets: list[dict]) -> None:
    """The report_coverage idea from video2pptx, reduced to the one failure that matters for notes:
    the model summarised the first part of a long transcript and skimmed the rest."""
    if not stamps:
        log("  note: no section timestamps found, so headings are not linked to the video.")
        return
    end = snippets[-1]["start"] if snippets else 0
    log(f"  coverage: {len(stamps)} linked sections, the latest at {fmt_timestamp(max(stamps))} of {fmt_timestamp(end)}")
    if end and max(stamps) < 0.7 * end:
        log("  WARNING: no section starts in the last 30% of the video - the model may have stopped early.")


# --------------------------------------------------------------------------
# 3. Drive: Markdown --> Google Doc (create, or update the Doc that already holds this video)
# --------------------------------------------------------------------------

def drive_service():
    import google.auth
    from googleapiclient.discovery import build
    # For user ADC the scopes were fixed at `gcloud ... login` time; this argument only matters
    # if ADC is ever a service account.
    creds, _ = google.auth.default(scopes=DRIVE_SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def drive_hint(e: Exception) -> str:
    status = getattr(getattr(e, "resp", None), "status", None)
    text = str(e).lower()
    if status == 403 and ("insufficient" in text or "scope" in text):
        return ("ADC carries no Drive scope (a plain `gcloud auth application-default login` silently "
                "drops it). Run:\n  " + ADC_LOGIN)
    if status == 403 and ("has not been used" in text or "disabled" in text):
        return "Enable the Google Drive API in the project that owns your OAuth client ID."
    if status == 404:
        return ("That folder is not visible to this credential. Under the drive.file scope the script "
                "only sees folders it created: run --make-folder once and use the ID it prints.")
    return ""


def make_folder(svc, name: str) -> None:
    f = svc.files().create(body={"name": name, "mimeType": GOOGLE_FOLDER}, fields="id,webViewLink").execute()
    log(f"Created folder '{name}'\n  id:   {f['id']}\n  link: {f['webViewLink']}\n"
        f"Pass it as --drive-folder {f['id']}. Move the folder wherever you like; the ID does not change.")


def upsert_doc(svc, folder_id: str, vid: str, name: str, markdown: str) -> tuple[str, bool]:
    """Drive converts text/markdown to a native Doc when the target mimeType is a Google Doc.
    The video ID is stored as a file property and is what we look up - not the name, which you
    are free to change in Drive. Returns (link, updated_existing)."""
    from googleapiclient.http import MediaInMemoryUpload
    media = MediaInMemoryUpload(markdown.encode("utf-8"), mimetype="text/markdown", resumable=False)
    q = (f"'{folder_id}' in parents and trashed = false and "
         f"properties has {{ key='video_id' and value='{vid}' }}")
    found = svc.files().list(q=q, fields="files(id)", supportsAllDrives=True,
                             includeItemsFromAllDrives=True).execute().get("files", [])
    if found:
        f = svc.files().update(fileId=found[0]["id"], media_body=media, fields="id,webViewLink",
                               supportsAllDrives=True).execute()
    else:
        body = {"name": name, "parents": [folder_id], "mimeType": GOOGLE_DOC, "properties": {"video_id": vid}}
        f = svc.files().create(body=body, media_body=media, fields="id,webViewLink",
                               supportsAllDrives=True).execute()
    return f["webViewLink"], bool(found)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

EXAMPLES = """\
examples:
  python vid2notes.py --make-folder "GCP training notes"
  python vid2notes.py https://youtu.be/VIDEO_ID --project MY_PROJECT --drive-folder FOLDER_ID
  python vid2notes.py --urls-file course.txt --project MY_PROJECT --drive-folder FOLDER_ID ^
      --instructions gem.txt --context "Course: Developing apps on Google Cloud"

course.txt holds one URL or video ID per line; blank lines and # comments are ignored.
Re-running a video reuses its cached transcript and updates its existing Doc.
"""


def read_targets(args: argparse.Namespace) -> list[str]:
    raw = list(args.urls)
    if args.urls_file:
        for line in Path(args.urls_file).read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                raw.append(line)
    ids: list[str] = []
    for item in raw:
        vid = video_id(item)
        if vid is None:
            die(f"Not a YouTube URL or 11-character video ID: {item}")
        if vid not in ids:
            ids.append(vid)
    return ids


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        description="Turn YouTube training videos into study notes (Google Docs) with Gemini on Vertex AI.",
        epilog=EXAMPLES, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urls", nargs="*", help="YouTube URLs or video IDs")
    ap.add_argument("--urls-file", help="Text file with one URL or ID per line")
    ap.add_argument("--project", help="GCP project ID (or set GOOGLE_CLOUD_PROJECT)")
    ap.add_argument("--location", help=f"Vertex location (default: {DEFAULT_LOCATION})")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    ap.add_argument("--thinking", choices=["low", "medium", "high", "none"], default=DEFAULT_THINKING)
    ap.add_argument("--instructions", help="Text file with your note-taking instructions (e.g. your Gem's)")
    ap.add_argument("--context", default="", help='Free text for the model: course name, products covered ...')
    ap.add_argument("--drive-folder", help="Drive folder ID to file the Docs in (omit to only write local .md)")
    ap.add_argument("--make-folder", metavar="NAME", help="Create a Drive folder, print its ID, and exit")
    ap.add_argument("--work-dir", default=DEFAULT_WORK_DIR, help=f"Transcript cache + local .md (default: {DEFAULT_WORK_DIR}/)")
    ap.add_argument("--languages", default="en", help="Caption languages in priority order, comma-separated (default: en)")
    ap.add_argument("--refetch", action="store_true", help="Ignore cached transcripts")
    args = ap.parse_args(argv)

    if args.make_folder:
        try:
            make_folder(drive_service(), args.make_folder)
        except Exception as e:  # noqa: BLE001
            die(f"{e}\n{drive_hint(e)}")
        return

    ids = read_targets(args)
    if not ids:
        ap.print_help()
        return
    project = args.project or os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        die("Pass --project or set GOOGLE_CLOUD_PROJECT.")
    location = args.location or os.environ.get("GOOGLE_CLOUD_LOCATION") or DEFAULT_LOCATION
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        die("google-genai is not installed. Run: pip install google-genai")

    style = Path(args.instructions).read_text(encoding="utf-8") if args.instructions else DEFAULT_INSTRUCTIONS
    system = style.rstrip() + "\n" + OUTPUT_CONTRACT
    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    client = genai.Client(vertexai=True, project=project, location=location,
                          http_options=types.HttpOptions(timeout=TIMEOUT_MINUTES * 60 * 1000))   # milliseconds
    svc = drive_service() if args.drive_folder else None
    languages = [x.strip() for x in args.languages.split(",") if x.strip()]

    failed: list[str] = []
    for i, vid in enumerate(ids, start=1):
        log(f"[{i}/{len(ids)}] {vid}")
        try:
            transcript = get_transcript(vid, work, languages, args.refetch)
            title = video_title(vid)
            user_text = (f"Video title: {title or 'unknown'}\n"
                         + (f"Context from the requester: {args.context.strip()}\n" if args.context else "")
                         + "\nTranscript ([MM:SS] markers give the position in the video):\n"
                         + transcript_text(transcript["snippets"]))
            md, stamps = finish_markdown(
                generate_notes(client, types, args.model, args.thinking, system, user_text),
                vid, title, args.model)
            (work / f"{vid}.md").write_text(md, encoding="utf-8")      # saved before Drive, so a Drive failure loses nothing
            check_coverage(stamps, transcript["snippets"])
            if svc:
                link, updated = upsert_doc(svc, args.drive_folder, vid, title or first_h1(md) or vid, md)
                log(f"  {'updated' if updated else 'created'}: {link}")
            else:
                log(f"  wrote {work / (vid + '.md')}")
        except Exception as e:  # noqa: BLE001 - one bad video should not stop the batch
            failed.append(vid)
            hint = drive_hint(e)
            log(f"  FAILED ({type(e).__name__}): {e}" + (f"\n  {hint}" if hint else ""))

    log(f"Done: {len(ids) - len(failed)} of {len(ids)} videos." + (f" Failed: {', '.join(failed)}" if failed else ""))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()