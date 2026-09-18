#!/usr/bin/env python3
r"""Turn YouTube training videos into study notes filed as Google Docs in Drive.

Pipeline - one artifact per stage, each written before the next stage starts, so a failure
never costs you the stages before it::

    YouTube captions --> <id>.transcript.json --> Gemini on Vertex AI --> <id>.md --> Google Doc
         (stage 1, cached)                         (stage 2)                (stage 3, upsert)

The video ID is the identity of a note everywhere: it names the cache file and the local
Markdown, and it is stored as a property on the Doc, so a re-run updates the same Doc (Docs
keeps the version history) instead of creating a duplicate.

Two ideas are inherited from the sibling script video2pptx.py:

* Keep the fragile step apart from the cheap one. There it is ``analyze`` vs ``build``; here the
  transcript fetch is the fragile step (unofficial endpoint; YouTube blocks IPs that ask too
  often), so the transcript and the title are cached on first fetch. Once a video is cached, a
  re-run to try a different prompt makes no request to YouTube at all.
* A timestamp is the join key between the model's text and the video. The transcript is sent
  with ``[MM:SS]`` markers, the model ends each section heading with the marker where the
  section starts, and the script turns those into links that open the video at that moment.

Where the documentation lives
-----------------------------
* Docstrings say WHAT a function does and the contract it keeps (arguments, return, errors).
* Inline comments say WHY a particular line is the way it is.
* DESIGN.md says why the ARCHITECTURE is this way, and which alternatives were rejected.

Setup (once)
------------
::

    pip install google-genai youtube-transcript-api google-api-python-client
    pip install truststore        # optional; needs Python 3.10+. See "Behind a corporate proxy" below.

Vertex works with plain ADC, as in video2pptx. Drive does not: gcloud's built-in OAuth client
may not request Drive scopes, so ADC has to be minted with an OAuth client ID of your own.

1. In the project: enable the Google Drive API, then APIs & Services > Credentials >
   Create OAuth client ID > Desktop app (consent screen: Internal). Download the JSON.
2. Log in with both scopes. One line, on purpose, and with the scopes QUOTED: PowerShell can
   split an unquoted comma-separated value into separate arguments::

       gcloud auth application-default login --client-id-file=client_secret.json --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.file"

3. Create the folder: ``python vid2notes.py --make-folder "GCP training notes"`` (prints its ID).

``drive.file`` is the narrow scope: this credential can only see what this script created, which
is why the script makes the folder. Move the folder anywhere you like afterwards; the ID and the
access travel with it. To target a folder you made by hand, use the full ``.../auth/drive`` scope
in step 2 instead and skip step 3.

Usage
-----
::

    python vid2notes.py "URL" ["URL" ...] --project MY_PROJECT --drive-folder FOLDER_ID
    python vid2notes.py --urls-file course.txt --project MY_PROJECT --drive-folder FOLDER_ID `
        --instructions gem.txt --context "Course: Developing apps on Google Cloud"

The trailing backtick continues a line in PowerShell. In cmd.exe use a caret (^) instead; they are
not interchangeable, and the wrong one reaches the script as a stray argument. Quote URLs: an
unquoted ``&`` in a URL is an operator in both shells.

Without ``--drive-folder`` the notes are only written to ``--work-dir`` as ``<video_id>.md``.

Behind a corporate proxy
------------------------
A proxy that inspects TLS re-signs every site's certificate with the company's own root CA. IT
installs that root in the Windows certificate store, so browsers are happy, but Python verifies
against the ``certifi`` bundle, which has never heard of it: ``CERTIFICATE_VERIFY_FAILED ...
unable to get local issuer certificate``. With ``truststore`` installed, the script verifies
against the operating system's store instead - the same trust decisions as your browser, kept
current by IT. Verification is never switched off.

Exit status
-----------
0 if every video succeeded; 1 if any video failed or the configuration was unusable.

Self-check
----------
The pure functions carry doctests. They need no network and no third-party package::

    python -m doctest vid2notes.py
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
from types import ModuleType
from typing import TYPE_CHECKING, Any, TypedDict

if TYPE_CHECKING:
    # Imported for type checkers and IDEs only. At runtime the SDKs are imported lazily, inside
    # the functions that need them, so `--make-folder` works without the transcript library and
    # a local-only run works without the Drive client.
    from google import genai

# --------------------------------------------------------------------------
# Configuration you may want to tweak
# --------------------------------------------------------------------------

DEFAULT_MODEL = "gemini-3.5-flash"   # same default as video2pptx, so the two scripts behave alike
DEFAULT_LOCATION = "global"          # or a region such as "us-central1" if policy requires it
DEFAULT_THINKING = "low"             # this is restructuring text, not reasoning
DEFAULT_WORK_DIR = "vid2notes_work"  # holds <id>.transcript.json (cache) and <id>.md (latest notes)
MAX_OUTPUT_TOKENS = 65535            # shared by the model's thinking tokens AND the notes it writes
TIMEOUT_MINUTES = 10                 # for the whole call (it is not streamed); a transcript takes ~1 minute
MARKER_SECONDS = 30                  # one [MM:SS] marker per ~30 s: finer costs tokens, coarser blunts the links
FETCH_PAUSE_SECONDS = 1.0            # politeness gap after each uncached YouTube request
COVERAGE_THRESHOLD = 0.7             # warn if no section starts after this fraction of the video

GOOGLE_DOC = "application/vnd.google-apps.document"
GOOGLE_FOLDER = "application/vnd.google-apps.folder"
ADC_SCOPES = ["https://www.googleapis.com/auth/cloud-platform",   # Vertex AI
              "https://www.googleapis.com/auth/drive.file"]       # Drive, limited to files this script created
# Built from ADC_SCOPES so the fix we print can never drift from the scopes we ask for.
ADC_LOGIN = ("gcloud auth application-default login --client-id-file=client_secret.json "
             '--scopes="' + ",".join(ADC_SCOPES) + '"')   # quoted: PowerShell can split an unquoted a,b

# STYLE: how the notes read. Replace it with your Gem's instructions via --instructions FILE.
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

# CONTRACT: what the code below depends on. Always appended to the style, whatever the style says:
# first_h1() needs the H1, finish_markdown() needs the heading markers.
OUTPUT_CONTRACT = """\

Output contract (required by the program that files these notes):
- Output Markdown only: no preamble, and no code fence around the whole document.
- The first line is a single H1 (# ) with a specific title for the notes.
- The transcript carries [MM:SS] markers. End every H2 (## ) heading with the marker where that
  section's material begins, for example: ## IAM role types [07:30]
  Use only markers that appear in the transcript. Cover the whole video, start to finish.
"""


# --------------------------------------------------------------------------
# Data shapes
# --------------------------------------------------------------------------
# Plain dicts, so they round-trip through JSON untouched. The TypedDicts exist to document the
# shape and let a type checker enforce it; they add nothing at runtime.

class Snippet(TypedDict):
    """One caption line, exactly as youtube-transcript-api's ``to_raw_data()`` returns it."""

    text: str
    start: float      # seconds from the start of the video
    duration: float   # seconds


class Transcript(TypedDict):
    """The contents of ``<video_id>.transcript.json``.

    Caption snippets are stored raw, not as the marker-formatted text, so changing
    ``MARKER_SECONDS`` or the formatting never invalidates the cache.
    """

    video_id: str
    title: str | None        # None if oEmbed failed; retried on the next run
    language_code: str
    is_generated: bool       # True for YouTube's auto-captions
    fetched_at: str          # ISO 8601, local time
    snippets: list[Snippet]


# --------------------------------------------------------------------------
# Helpers carried over from video2pptx.py (logic unchanged unless noted)
# --------------------------------------------------------------------------

def log(msg: str) -> None:
    """Print a progress line immediately.

    Simplified from video2pptx: no tee into run.log. That trail existed because an ``analyze``
    run was expensive; here a re-run costs cents and Docs keeps the version history.
    """
    print(msg, flush=True)   # flush: progress must show up promptly even when output is piped


def die(msg: str, code: int = 1) -> None:
    """Report a problem that makes the whole run pointless, and exit.

    Reserved for configuration errors found before any work starts. Anything that can go wrong
    for one video is raised instead, and handled per video in ``main``.
    """
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


_TS_RE = re.compile(r"""
    ^\s*
    (?:(\d{1,2}):)?     # hours, optional
    (\d{1,3}):          # minutes - up to three digits, because models write 75:30 for 1:15:30
    (\d{2})             # seconds
    (?:\.(\d+))?        # fractional seconds, optional
    \s*$
""", re.VERBOSE)


def parse_timestamp(value: str | None) -> float | None:
    """Convert ``MM:SS`` or ``H:MM:SS`` (optionally with a fraction) to seconds.

    Returns None, rather than raising, for anything that is not a timestamp: callers treat
    "not a timestamp" as an ordinary case. Inverse of ``fmt_timestamp``.

    >>> parse_timestamp("07:45")
    465.0
    >>> parse_timestamp("1:02:30")
    3750.0
    >>> parse_timestamp("75:30")
    4530.0
    >>> parse_timestamp("soon") is None
    True
    """
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
    """Format seconds as ``MM:SS``, or ``HH:MM:SS`` from one hour up. Negative input clamps to zero.

    The script writes transcript markers with this function and reads them back with
    ``parse_timestamp``, so the model only ever has to copy a marker, never to reformat one.

    >>> fmt_timestamp(465)
    '07:45'
    >>> fmt_timestamp(3750.9)
    '01:02:30'
    >>> fmt_timestamp(-3)
    '00:00'
    """
    seconds = max(0.0, seconds)
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _enum_name(value: Any) -> str | None:
    """Return ``'STOP'`` for ``FinishReason.STOP``; pass strings through; keep None as None."""
    if value is None:
        return None
    return getattr(value, "name", None) or str(value)


def describe_response(response: Any) -> dict[str, Any]:
    """Flatten what the API says about a call into plain values.

    Every attribute is read with a default, which protects against SDK shape changes and
    against a blocked prompt, where ``candidates`` is empty. Trimmed from video2pptx: the safety
    ratings, per-modality token counts and cache counts say nothing useful for text-only input.

    Returns:
        A dict with the keys ``model_version``, ``finish_reason``, ``finish_message``,
        ``prompt_tokens``, ``thinking_tokens``, ``output_tokens`` and ``block_reason``.
        Any of them may be None.
    """
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


def log_gemini_summary(g: dict[str, Any]) -> None:
    """Log one dense line about the call, then a warning for each limit people actually hit.

    Args:
        g: The dict produced by ``describe_response``.
    """
    def n(x: Any) -> str:
        return f"{x:,}" if isinstance(x, int) else "?"

    log(f"  Gemini: {g.get('model_version') or '?'} | finish: {g.get('finish_reason') or '?'} | "
        f"in {n(g.get('prompt_tokens'))} | thinking {n(g.get('thinking_tokens'))} | out {n(g.get('output_tokens'))}")
    fr = g.get("finish_reason")
    if fr == "MAX_TOKENS":
        # The one that matters: notes that stop mid-sentence usually mean thinking ate the budget.
        log(f"  WARNING: hit the {MAX_OUTPUT_TOKENS:,}-token output limit, so the notes are cut off. "
            f"Try --thinking none, or ask for terser notes in your instructions.")
    elif fr and fr != "STOP":
        log(f"  WARNING: finish reason was {fr}{' - ' + g['finish_message'] if g.get('finish_message') else ''}.")
    if g.get("block_reason"):
        log(f"  WARNING: the prompt was blocked ({g['block_reason']}).")


# --------------------------------------------------------------------------
# Stage 1. Transcript: YouTube captions and title, cached by video ID
# --------------------------------------------------------------------------

_ID_RE = re.compile(r"""
    (?: [?&]v= | youtu\.be/ | /embed/ | /live/ | /shorts/ )   # the URL shapes YouTube hands out;
                                                              # [?&] stops a match inside e.g. "nov="
    ([A-Za-z0-9_-]{11})                                       # the ID: 11 base64url characters
""", re.VERBOSE)


# Paste artefacts. A YouTube ID only ever contains the ASCII hyphen, so mapping the look-alikes
# that rich-text editors and chat apps substitute back to "-" cannot change a valid ID.
_PASTE_FIXES = {**dict.fromkeys(map(ord, "\u2010\u2011\u2012\u2013\u2014\u2212"), "-"),   # hyphen/dash look-alikes
                **dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"), None)}          # zero-width characters
_WRAPPERS = "<>\"'\u2018\u2019\u201c\u201d"   # <url> from e-mail, straight and curly quotes


def video_id(url_or_id: str) -> str | None:
    r"""Extract the 11-character video ID from a YouTube URL, or accept a bare ID.

    The input is cleaned of paste artefacts first: look-alike hyphens become ``-``, zero-width
    characters are dropped, and wrapping quotes or angle brackets are stripped.

    The result is guaranteed to match ``[A-Za-z0-9_-]{11}``. Everything downstream relies on
    that: the ID goes into file names, URLs and a Drive query string without any escaping.

    Returns:
        The ID, or None if there is none - the caller decides how serious that is.

    >>> video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")
    'dQw4w9WgXcQ'
    >>> video_id("https://youtu.be/dQw4w9WgXcQ")
    'dQw4w9WgXcQ'
    >>> video_id("dQw4w9WgXcQ")
    'dQw4w9WgXcQ'
    >>> video_id("https://example.com/") is None
    True
    >>> video_id("<youtu.be/abcd\u2011EFGhi1?si=xyz>")   # a non-breaking hyphen looks identical on screen
    'abcd-EFGhi1'
    """
    s = url_or_id.translate(_PASTE_FIXES).strip().strip(_WRAPPERS)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    m = _ID_RE.search(s)
    return m.group(1) if m else None


def video_title(vid: str) -> str | None:
    """Look up a video's title through YouTube's oEmbed endpoint.

    oEmbed needs no API key and no extra API to enable, and it answers for unlisted videos.
    ``requests`` rather than ``urllib``: it is already a dependency of youtube-transcript-api and
    honours the same proxy and CA settings, so if the transcript fetch works on your network,
    this does too.

    Returns:
        The title, or None on any failure. The title is a nicety - the caller falls back to the
        notes' own H1 and then to the video ID - so no error here is worth stopping for.
    """
    import requests
    try:
        r = requests.get("https://www.youtube.com/oembed",
                         params={"format": "json", "url": f"https://www.youtube.com/watch?v={vid}"}, timeout=10)
        r.raise_for_status()
        return r.json().get("title") or None
    except Exception:  # noqa: BLE001 - deliberate: see Returns
        return None


def get_transcript(vid: str, work: Path, languages: list[str], refetch: bool) -> Transcript:
    """Return the transcript and title for a video, from the cache if possible.

    A cache hit and a fresh fetch return the identical shape, so callers cannot tell them
    apart. Unlisted videos work; private ones do not.

    Args:
        vid: Video ID, as validated by ``video_id``.
        work: Directory holding the cache files.
        languages: Caption language codes in priority order. The library prefers human-made
            captions over auto-generated ones within a language.
        refetch: Ignore the cache. Needed after changing ``languages``, because the cache is
            keyed on the video ID alone.

    Raises:
        Exception: Whatever youtube-transcript-api raises (``TranscriptsDisabled``, ``IpBlocked``,
            ``VideoUnavailable`` ...). Deliberately not wrapped: its messages are already specific.
    """
    cache = work / f"{vid}.transcript.json"
    dirty = False   # does the cache file need (re)writing?

    if cache.is_file() and not refetch:
        data: Transcript = json.loads(cache.read_text(encoding="utf-8"))
        log("  transcript: cached")
    else:
        from youtube_transcript_api import YouTubeTranscriptApi
        t = YouTubeTranscriptApi().fetch(vid, languages=languages)
        data = {"video_id": vid, "title": None, "language_code": t.language_code,
                "is_generated": t.is_generated,
                "fetched_at": dt.datetime.now().isoformat(timespec="seconds"),
                "snippets": t.to_raw_data()}
        dirty = True
        log(f"  transcript: fetched {len(data['snippets'])} caption lines "
            f"({'auto-generated' if t.is_generated else 'human-made'}, {t.language_code})")
        time.sleep(FETCH_PAUSE_SECONDS)   # only after a real request, so cached runs stay instant

    # .get(): caches written before the title was stored have no "title" key. A failed lookup
    # leaves None behind, so it is retried on the next run instead of being remembered forever.
    if not data.get("title"):
        data["title"] = video_title(vid)
        dirty = dirty or bool(data["title"])

    if dirty:
        cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def transcript_text(snippets: list[Snippet]) -> str:
    """Render captions as one line per ~``MARKER_SECONDS`` of speech, each led by its ``[MM:SS]`` marker.

    A marker carries the start time of a real caption rather than a point on a fixed grid, so
    every link built from one lands on a caption boundary. Per-caption timestamps would be more
    precise but nearly double the token count and bury the prose.

    >>> caps = [{"text": "hello  there", "start": 0.0, "duration": 2.0},
    ...         {"text": "more", "start": 12.0, "duration": 2.0},
    ...         {"text": "later", "start": 31.5, "duration": 2.0}]
    >>> print(transcript_text(caps))
    [00:00] hello there more
    [00:31] later
    """
    lines: list[str] = []
    buf: list[str] = []      # the line being built: its marker, then caption texts
    next_mark = 0.0          # the first caption at or after this time opens a new line
    for s in snippets:
        if s["start"] >= next_mark or not buf:
            if buf:
                lines.append(" ".join(buf))
            buf = [f"[{fmt_timestamp(s['start'])}]"]
            next_mark = s["start"] + MARKER_SECONDS
        text = " ".join(s["text"].split())   # captions carry hard line breaks; flatten them
        if text:
            buf.append(text)
    if buf:
        lines.append(" ".join(buf))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Stage 2. Notes: transcript --> Gemini (Vertex AI) --> Markdown
# --------------------------------------------------------------------------

def build_user_prompt(title: str | None, context: str, snippets: list[Snippet]) -> str:
    """Assemble the user turn: the DATA the model works on (title, requester's context, transcript).

    The INSTRUCTIONS travel separately, as the system instruction (see ``generate_notes``). That
    mirrors how a Gem works, so Gem instructions drop in unchanged, and it keeps transcript text
    from being read as instructions.

    >>> caps = [{"text": "welcome", "start": 0.0, "duration": 2.0}]
    >>> print(build_user_prompt("Intro to Cloud Run", "", caps))
    Video title: Intro to Cloud Run
    <BLANKLINE>
    Transcript ([MM:SS] markers give the position in the video):
    [00:00] welcome
    """
    return (f"Video title: {title or 'unknown'}\n"
            + (f"Context from the requester: {context.strip()}\n" if context.strip() else "")
            + "\nTranscript ([MM:SS] markers give the position in the video):\n"
            + transcript_text(snippets))


def generate_notes(client: genai.Client, genai_types: ModuleType, model: str,
                   thinking: str, system: str, user_text: str) -> str:
    """Ask Gemini for the notes and return them as Markdown.

    A plain ``generate_content`` call. video2pptx streams, with a heartbeat, to keep a 20-minute
    video ingestion alive through proxies; a transcript call finishes in about a minute, so none
    of that is needed. There is no retry logic either: ``main`` lists the failed IDs at the end,
    and re-running just those is the retry.

    Args:
        client: A ``genai.Client`` configured for Vertex AI.
        genai_types: The ``google.genai.types`` module. Passed in, not imported here, so the lazy
            import lives in one place (``main``) and tests can hand in a stub.
        model: Model ID.
        thinking: ``low`` / ``medium`` / ``high``, or ``none`` to send no thinking config at all.
        system: Style instructions followed by ``OUTPUT_CONTRACT``.
        user_text: The output of ``build_user_prompt``.

    Raises:
        RuntimeError: The model returned no text (blocked, or cut off before writing anything).
        Exception: Whatever the SDK raises for auth, quota, model-name or network problems.
    """
    config_kwargs: dict[str, Any] = dict(
        system_instruction=system,
        temperature=0.2,             # faithful extraction, not creativity
        max_output_tokens=MAX_OUTPUT_TOKENS,
        # We pass no tools, so AFC is irrelevant; saying so explicitly silences the SDK's warning.
        automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
    )
    if thinking != "none":
        config_kwargs["thinking_config"] = genai_types.ThinkingConfig(thinking_level=thinking)
    response = client.models.generate_content(model=model, contents=user_text,
                                              config=genai_types.GenerateContentConfig(**config_kwargs))
    log_gemini_summary(describe_response(response))   # before the emptiness check: it explains an empty reply
    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("the model returned no text (see the Gemini line above)")
    return text


_FENCE_RE = re.compile(r"""
    \A```(?:markdown|md)?[ \t]*\n   # an opening fence on the very first line ...
    (.*)                            # ... the document - greedy, so an inner ``` cannot end the match ...
    \n```\s*\Z                      # ... and a closing fence at the very end
""", re.VERBOSE | re.DOTALL)

_HEADING_TS_RE = re.compile(r"""
    ^(\#{2,6}[ \t].*?)                         # group 1: an H2-H6 heading, as little of it as possible
    [ \t]*
    [\[(] ((?:\d{1,2}:)?\d{1,3}:\d{2}) [\])]   # group 2: MM:SS or H:MM:SS; () tolerated as well as []
    [ \t]*$                                    # at the END of the line only - never in running text
""", re.VERBOSE | re.MULTILINE)


def finish_markdown(md: str, vid: str, title: str | None, model: str) -> tuple[str, list[float]]:
    r"""Post-process the model's Markdown: unwrap, link the timestamps, add a source line.

    The order matters. A whole-document code fence is removed first, because otherwise line one
    is a fence and the H1 is not found. Timestamps are linked only where a heading ENDS with one,
    which makes a false positive in body text all but impossible.

    Args:
        md: Markdown as returned by the model.
        vid: Video ID, used to build the links.
        title: Video title for the source line; the ID stands in if None.
        model: Model ID, recorded in the source line so that two versions in the Doc's history
            can be told apart by what wrote them.

    Returns:
        ``(markdown, timestamps)``: the finished document, and the heading timestamps in seconds
        in document order - collected here so ``check_coverage`` needs no second regex pass.

    >>> md, stamps = finish_markdown("# T\n\n## IAM roles [07:30]\nbody\n", "dQw4w9WgXcQ", "Talk", "m")
    >>> stamps
    [450.0]
    >>> md.splitlines()[4]
    '## IAM roles ([07:30](https://youtu.be/dQw4w9WgXcQ?t=450))'
    >>> md.splitlines()[2].startswith("Source: [Talk](https://www.youtube.com/watch?v=dQw4w9WgXcQ)")
    True
    """
    m = _FENCE_RE.match(md)
    if m:
        md = m.group(1)

    stamps: list[float] = []

    def link(match: re.Match[str]) -> str:
        secs = parse_timestamp(match.group(2))
        if secs is None:
            return match.group(0)
        stamps.append(secs)   # side channel out of re.sub: this is how the timestamps get returned
        return f"{match.group(1)} ([{match.group(2)}](https://youtu.be/{vid}?t={int(secs)}))"

    md = _HEADING_TS_RE.sub(link, md)

    source = (f"Source: [{title or vid}](https://www.youtube.com/watch?v={vid}) | "
              f"notes generated {dt.date.today():%Y-%m-%d} by {model}")
    lines = md.split("\n")
    at = 1 if lines and lines[0].startswith("# ") else 0     # directly under the H1, if there is one
    blank_follows = at < len(lines) and not lines[at].strip()
    lines[at:at] = ["", source] if blank_follows else ["", source, ""]   # exactly one blank line either side
    return "\n".join(lines).strip() + "\n", stamps


def first_h1(md: str) -> str | None:
    r"""Return the text of the first H1, or None. The fallback Doc name when the title lookup failed.

    >>> first_h1("intro\n# Cloud Run basics \n## Part one")
    'Cloud Run basics'
    """
    m = re.search(r"^# +(.+?)\s*$", md, re.MULTILINE)
    return m.group(1) if m else None


def check_coverage(stamps: list[float], snippets: list[Snippet]) -> None:
    """Warn if the notes appear to stop before the video does.

    ``report_coverage`` from video2pptx, reduced to the one failure that matters for notes: the
    model summarised the beginning of a long transcript and skimmed the rest. It only warns -
    a video can legitimately end in a long Q&A with nothing worth a section.

    Args:
        stamps: Heading timestamps from ``finish_markdown``. The LATEST one is used, not the last,
            because notes organised by concept need not be chronological.
        snippets: The captions. The start of the last one stands in for the video's length, which
            saves asking anyone for the duration.
    """
    if not stamps:
        log("  note: no section timestamps found, so headings are not linked to the video.")
        return
    end = snippets[-1]["start"] if snippets else 0
    log(f"  coverage: {len(stamps)} linked sections, "
        f"the latest at {fmt_timestamp(max(stamps))} of {fmt_timestamp(end)}")
    if end and max(stamps) < COVERAGE_THRESHOLD * end:
        log(f"  WARNING: no section starts in the last {1 - COVERAGE_THRESHOLD:.0%} of the video - "
            f"the model may have stopped early.")


# --------------------------------------------------------------------------
# Stage 3. Drive: Markdown --> Google Doc (create, or update the Doc that already holds this video)
# --------------------------------------------------------------------------

def drive_service() -> Any:
    """Build a Drive v3 client on Application Default Credentials.

    Returns:
        A googleapiclient ``Resource``. Typed ``Any`` because the library generates its methods
        at runtime from the API's discovery document, so there is nothing static to annotate.
    """
    import google.auth
    from googleapiclient.discovery import build
    # For USER credentials the scopes were fixed when `gcloud ... login` obtained consent, and this
    # argument is ignored. It only takes effect if ADC is ever a service account.
    creds, _ = google.auth.default(scopes=ADC_SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def drive_hint(e: Exception) -> str:
    """Translate the likeliest Drive failures into the fix.

    Safe to call with ANY exception - a non-Drive error simply yields ``""`` - which is why the
    per-video handler in ``main`` calls it unconditionally.

    Returns:
        A sentence to show under the error message, or ``""`` if there is nothing useful to add.
    """
    status = getattr(getattr(e, "resp", None), "status", None)   # googleapiclient.errors.HttpError keeps it here
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


def ssl_hint(e: Exception) -> str:
    """Explain a certificate-verification failure, which on a work machine almost always means TLS inspection.

    Returns:
        The fix, or ``""`` if ``e`` is not a certificate-verification failure.
    """
    if "certificate verify failed" not in str(e).lower():
        return ""
    if "truststore" in sys.modules:   # use_system_trust_store() succeeded, so the OS store was already in use
        return ("Verification failed even against the operating system's certificate store, so the proxy's "
                "root CA is probably not installed in Windows. Ask IT for it; or export it as Base-64 "
                "(.cer), append it to a copy of the file `python -m certifi` prints, and point both "
                "REQUESTS_CA_BUNDLE and SSL_CERT_FILE at that copy.")
    return ("Python was shown a certificate it cannot trace to a CA it knows - typical of a corporate proxy "
            "that inspects TLS. Run `pip install truststore` (Python 3.10+) and re-run: the script will then "
            "verify against the Windows certificate store, as your browser does. Do not disable verification: "
            "your Google credentials travel over these connections.")


def failure_hint(e: Exception) -> str:
    """Return the first applicable hint for an exception, or ``""``. Safe to call with any exception."""
    return drive_hint(e) or ssl_hint(e)


def make_folder(svc: Any, name: str) -> None:
    """Create a folder at the root of My Drive and print its ID.

    Exists because of the ``drive.file`` scope: the credential cannot see a folder you made by
    hand, but it can see - and keep seeing, wherever you move it - one it made itself.
    """
    f = svc.files().create(body={"name": name, "mimeType": GOOGLE_FOLDER}, fields="id,webViewLink").execute()
    log(f"Created folder '{name}'\n  id:   {f['id']}\n  link: {f['webViewLink']}\n"
        f"Pass it as --drive-folder {f['id']}. Move the folder wherever you like; the ID does not change.")


def check_drive_folder(svc: Any, folder_id: str) -> str:
    """Confirm with one cheap request that Docs can be filed, before any model call is paid for.

    Without this, a missing Drive scope would only surface at the first upload, and a 40-video
    batch would make 40 model calls and then fail 40 uploads.

    Returns:
        The folder's name, for the log.

    Raises:
        googleapiclient.errors.HttpError: The folder is invisible to this credential (404) or
            the credential has no Drive scope (403). ``drive_hint`` explains both.
        ValueError: The ID belongs to something that is not a folder.
        PermissionError: The folder is visible but read-only for this account.
    """
    f = svc.files().get(fileId=folder_id, fields="name,mimeType,capabilities(canAddChildren)",
                        supportsAllDrives=True).execute()
    if f.get("mimeType") != GOOGLE_FOLDER:
        raise ValueError(f"'{f.get('name')}' is not a folder (it is {f.get('mimeType')})")
    if not f.get("capabilities", {}).get("canAddChildren", False):
        raise PermissionError(f"you cannot add files to the folder '{f.get('name')}'")
    return f["name"]


def upsert_doc(svc: Any, folder_id: str, vid: str, name: str, markdown: str) -> tuple[str, bool]:
    """Create the Doc for a video, or replace the content of the Doc that already holds it.

    Drive converts ``text/markdown`` into a native Doc when the target mimeType is a Google Doc.
    The existing Doc is found by a ``video_id`` file property, never by name, so renaming a Doc
    in Drive does not produce a duplicate on the next run.

    Args:
        svc: Drive client from ``drive_service``.
        folder_id: Folder to look in and create in.
        vid: Video ID. Already restricted to ``[A-Za-z0-9_-]`` by ``video_id``, which is why it can
            be placed in the query string without escaping.
        name: Name for a NEW Doc. Ignored on update, so your renames survive.
        markdown: The finished notes.

    Returns:
        ``(link, updated)``: the Doc's URL, and True if an existing Doc was updated.
    """
    from googleapiclient.http import MediaInMemoryUpload
    # In memory and non-resumable: notes are a few kB, and a resumable upload costs an extra round trip.
    media = MediaInMemoryUpload(markdown.encode("utf-8"), mimetype="text/markdown", resumable=False)
    # `properties`, not `appProperties`: app properties are private to the OAuth client that wrote
    # them, so rotating the client ID would orphan every Doc and the next run would duplicate them all.
    q = (f"'{folder_id}' in parents and trashed = false and "
         f"properties has {{ key='video_id' and value='{vid}' }}")
    found = svc.files().list(q=q, fields="files(id)", supportsAllDrives=True,       # *AllDrives: the folder
                             includeItemsFromAllDrives=True).execute().get("files", [])  # may be on a shared drive
    if found:
        # Media only, no metadata body: the name and location are yours to change in Drive.
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
  python vid2notes.py "https://youtu.be/VIDEO_ID" --project MY_PROJECT --drive-folder FOLDER_ID
  python vid2notes.py --urls-file course.txt --project MY_PROJECT --drive-folder FOLDER_ID `
      --instructions gem.txt --context "Course: Developing apps on Google Cloud"

(The trailing ` continues a line in PowerShell; in cmd.exe use ^ instead. Quote URLs: & is an operator.)
course.txt holds one URL or video ID per line; blank lines and # comments are ignored.
Re-running a video reuses its cached transcript and updates its existing Doc.
"""


def use_system_trust_store() -> bool:
    """Verify TLS against the operating system's certificate store, if ``truststore`` is installed.

    Must run before any HTTP library creates an SSL context, which is why ``main`` calls it first
    and why it matters that the SDK imports in this file are lazy. ``inject_into_ssl()`` swaps
    ``ssl.SSLContext`` process-wide, so any library that builds its contexts from the ``ssl``
    module picks it up - requests (the transcript and title) and httpx (Gemini) among them. It is
    meant for applications and scripts, never for libraries; this file is a script.

    Returns:
        True if the OS store is now in use; False if ``truststore`` is not installed, in which
        case every library keeps its default (the ``certifi`` bundle) and nothing changes.
    """
    try:
        import truststore
    except ImportError:
        return False
    truststore.inject_into_ssl()
    return True


def read_text_file(path: str) -> str:
    """Read a user-supplied text file, whichever encoding Windows gave it.

    ``echo ... > file`` in Windows PowerShell 5.1 writes UTF-16 with a byte-order mark; Notepad
    and PowerShell 7 write UTF-8, with or without one. A UTF-8 BOM left in place would cling to
    the first line, and UTF-16 read as UTF-8 fails outright, so the BOM decides the codec.
    """
    raw = Path(path).read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")      # the BOM tells the codec the byte order, and is consumed
    return raw.decode("utf-8-sig")       # strips a UTF-8 BOM if there is one


def explain_bad_target(item: str) -> str:
    """Say why a target was rejected, for the mistakes people actually make.

    The caller shows the rejected text with ``ascii()``, so a stray, invisible or look-alike
    character is visible in the message as an escape. This function adds the likely cause.

    >>> explain_bad_target("^")[:41]
    'That is a line-continuation character. Po'
    >>> explain_bad_target("https://www.youtube.com/playlist?list=PL123")[:23]
    'That is a playlist URL.'
    >>> explain_bad_target("https://www.skills.google/course/1/video/2")[:30]
    'That is not a youtube.com or y'
    """
    low = item.strip().lower()
    if low in ("^", "`"):
        return ("That is a line-continuation character. PowerShell continues a line with a backtick (`), "
                "cmd.exe with a caret (^); the wrong one is passed to the script as an argument, and the "
                "lines after it run as separate commands. Use the right one, or put the command on one line.")
    if "list=" in low:
        return ("That is a playlist URL. Playlists are not expanded: list the videos' own URLs or IDs, "
                "one per line, in a file and pass it with --urls-file.")
    if not item.isascii():
        return ("It contains a non-ASCII character, shown above as a \\u.... escape - usually picked up by "
                "copying the link through a document or chat app. Copy it again from YouTube's Share dialog.")
    if low.startswith(("http://", "https://")) and "youtu" not in low:
        return ("That is not a youtube.com or youtu.be address. If the video is embedded in a course page, "
                "right-click the player and choose 'Copy video URL'.")
    return ("Expected https://www.youtube.com/watch?v=VIDEO_ID, https://youtu.be/VIDEO_ID, "
            "or the bare 11-character ID. Quote URLs on the command line: an unquoted & is an operator.")


def read_targets(args: argparse.Namespace) -> list[str]:
    """Collect video IDs from the command line and ``--urls-file``, de-duplicated, in the order given.

    A list rather than a set, so a course keeps its order. A malformed entry ends the run at
    once (``die``): a typo is cheaper to fix now than to discover after forty videos.
    """
    raw = list(args.urls)
    if args.urls_file:
        for line in read_text_file(args.urls_file).splitlines():
            line = line.split("#", 1)[0].strip()   # strip comments; a video ID always precedes any URL #fragment
            if line:
                raw.append(line)
    ids: list[str] = []
    for item in raw:
        vid = video_id(item)
        if vid is None:
            # !a, not !r: repr() prints a non-breaking hyphen as itself; ascii() shows it as \u2011.
            die(f"Not a YouTube URL or 11-character video ID: {item!a}\n{explain_bad_target(item)}")
        if vid not in ids:
            ids.append(vid)
    return ids


def main(argv: list[str] | None = None) -> None:
    """Parse arguments, check everything that can be checked up front, then process each video.

    Configuration problems end the run before any work is done (``die``). After that, each video
    is isolated: one failure is logged and the batch carries on.

    Args:
        argv: Arguments without the program name. None means ``sys.argv[1:]``; tests pass a list.
    """
    ap = argparse.ArgumentParser(
        description="Turn YouTube training videos into study notes (Google Docs) with Gemini on Vertex AI.",
        epilog=EXAMPLES, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urls", nargs="*", help="YouTube URLs or video IDs")
    ap.add_argument("--urls-file", help="Text file with one URL or ID per line")
    ap.add_argument("--project", help="GCP project ID (or set GOOGLE_CLOUD_PROJECT)")
    ap.add_argument("--location", help=f"Vertex location (default: {DEFAULT_LOCATION})")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    ap.add_argument("--thinking", choices=["low", "medium", "high", "none"], default=DEFAULT_THINKING,
                    help=f"Gemini thinking level (default: {DEFAULT_THINKING}). 'none' sends no thinking config.")
    ap.add_argument("--instructions", help="Text file with your note-taking instructions (e.g. your Gem's)")
    ap.add_argument("--context", default="", help="Free text for the model: course name, products covered ...")
    ap.add_argument("--drive-folder", help="Drive folder ID to file the Docs in (omit to only write local .md)")
    ap.add_argument("--make-folder", metavar="NAME", help="Create a Drive folder, print its ID, and exit")
    ap.add_argument("--work-dir", default=DEFAULT_WORK_DIR,
                    help=f"Transcript cache + local .md (default: {DEFAULT_WORK_DIR}/)")
    ap.add_argument("--languages", default="en",
                    help="Caption languages in priority order, comma-separated (default: en)")
    ap.add_argument("--refetch", action="store_true", help="Ignore cached transcripts")
    args = ap.parse_args(argv)

    # First, before anything opens a connection: see use_system_trust_store().
    if use_system_trust_store():
        log("TLS: verifying against the operating system's certificate store (truststore)")

    # --make-folder stands alone: it needs neither a project nor the Gemini SDK.
    if args.make_folder:
        try:
            make_folder(drive_service(), args.make_folder)
        except Exception as e:  # noqa: BLE001
            die(f"{e}\n{failure_hint(e)}")
        return

    # ---- configuration: everything that can fail without doing any work, fails here ----
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
        from google.genai import types as genai_types
    except ImportError:
        die("google-genai is not installed. Run: pip install google-genai")

    style = read_text_file(args.instructions) if args.instructions else DEFAULT_INSTRUCTIONS
    system = style.rstrip() + "\n" + OUTPUT_CONTRACT
    languages = [x.strip() for x in args.languages.split(",") if x.strip()]
    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)

    svc = None   # None = local-only run
    if args.drive_folder:
        try:
            svc = drive_service()
            log(f"Drive folder: {check_drive_folder(svc, args.drive_folder)}")
        except Exception as e:  # noqa: BLE001
            die(f"Cannot file Docs in --drive-folder {args.drive_folder}: {e}\n{failure_hint(e)}")

    client = genai.Client(vertexai=True, project=project, location=location,
                          http_options=genai_types.HttpOptions(timeout=TIMEOUT_MINUTES * 60 * 1000))   # milliseconds

    # ---- the pipeline, once per video ----
    failed: list[str] = []
    for i, vid in enumerate(ids, start=1):
        log(f"[{i}/{len(ids)}] {vid}")
        try:
            # 1. Transcript and title (cached after the first run).
            transcript = get_transcript(vid, work, languages, args.refetch)
            title = transcript.get("title")

            # 2. Notes.
            raw = generate_notes(client, genai_types, args.model, args.thinking, system,
                                 build_user_prompt(title, args.context, transcript["snippets"]))
            md, stamps = finish_markdown(raw, vid, title, args.model)
            # Saved BEFORE the upload, so a Drive failure never costs a model call.
            (work / f"{vid}.md").write_text(md, encoding="utf-8")
            check_coverage(stamps, transcript["snippets"])

            # 3. Drive.
            if svc:
                link, updated = upsert_doc(svc, args.drive_folder, vid, title or first_h1(md) or vid, md)
                log(f"  {'updated' if updated else 'created'}: {link}")
            else:
                log(f"  wrote {work / (vid + '.md')}")
        except Exception as e:  # noqa: BLE001 - one bad video must not stop the batch
            failed.append(vid)
            hint = failure_hint(e)
            log(f"  FAILED ({type(e).__name__}): {e}" + (f"\n  {hint}" if hint else ""))

    # The failed IDs are printed so they can be pasted straight into a re-run: that is the retry mechanism.
    log(f"Done: {len(ids) - len(failed)} of {len(ids)} videos." + (f" Failed: {', '.join(failed)}" if failed else ""))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
