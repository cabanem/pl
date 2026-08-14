#!/usr/bin/env python3
"""app.py — Chainlit UI for the SDC corpus agent.

Reuses agent.py's adapters, dispatch, and Evidence unchanged; owns only an
async version of the loop so each tool call renders live as a Chainlit step
(the evidence trail IS the interface). Multi-turn within a session: the
conversation contents persist in the Chainlit user session.

Env:
    MODEL                  required for live mode (current Gemini id)
    GOOGLE_CLOUD_PROJECT   required for live mode
    LOCATION               default 'global'
    BUCKET                 gs://... — facts.db pulled from artifacts/facts.db
                           at cold start (skipped if DB_PATH already exists)
    DB_PATH                default /tmp/facts.db
    AGENT_FAKE=1           scripted adapter: UI plumbing test, zero tokens
    MAX_TURNS              default 16

Local smoke test (Cloud Shell):
    AGENT_FAKE=1 DB_PATH=facts.db chainlit run app.py --port 8080
"""

import asyncio
import json
import os
from pathlib import Path

import chainlit as cl

from agent import (Evidence, FakeAdapter, GeminiAdapter, bound_payload,
                   make_dispatch)

DB_PATH = os.environ.get("DB_PATH", "/tmp/facts.db")
BUCKET = os.environ.get("BUCKET", "")
MAX_TURNS = int(os.environ.get("MAX_TURNS", "16"))
FAKE = os.environ.get("AGENT_FAKE") == "1"
MODEL = os.environ.get("MODEL", "")
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
LOCATION = os.environ.get("LOCATION", "global")

_gemini = None          # one shared client; conversation state lives per-session

STARTERS = [
    ("Who writes a table?", "Who writes WFA_SupplierRequest, and which fields?"),
    ("Rename impact", "What breaks if I rename a field on CFG_FormSlotMapping?"),
    ("Call chain", "Show the call chain below UPL-01."),
    ("What changed?", "What changed between the last two snapshots?"),
    ("Action census", "Which recipes use the workflow-app update-request action?"),
    ("One step in depth", "Show me the detail of a step — which recipe and step should I name?"),
]


def friendly_failure(ex):
    """Map infrastructure failures to actionable messages instead of tracebacks."""
    s = str(ex).lower()
    if "429" in s or "quota" in s or "exhausted" in s:
        return "The model is rate-limited right now — wait a few seconds and resend."
    if ("404" in s or "not found" in s) and "model" in s:
        return (f"The model id ({MODEL}) looks wrong or retired — the service's "
                "MODEL env var needs updating (redeploy with the current id).")
    if "403" in s or "permission" in s or "credential" in s or "auth" in s:
        return ("The service's credentials were rejected mid-call — the runtime "
                "SA may have lost a grant. Run preflight.sh against this project.")
    return ("Something failed mid-turn (the evidence file shows how far we got). "
            "Resend, or rephrase naming a specific table, field, or recipe.")


def ensure_db():
    """Cold-start: pull the canonical facts.db from the bucket."""
    if os.path.exists(DB_PATH):
        return
    if not BUCKET:
        raise RuntimeError("no facts.db at DB_PATH and no BUCKET set")
    from google.cloud import storage                 # deferred: fake mode needs nothing
    name = BUCKET.replace("gs://", "").strip("/")
    storage.Client().bucket(name).blob("artifacts/facts.db") \
        .download_to_filename(DB_PATH)


def get_adapter():
    """Fake per session (its script is consumable); Gemini shared globally
    (stateless between asks — contents carry the conversation)."""
    global _gemini
    if FAKE:
        return FakeAdapter(), "fake"
    if _gemini is None:
        brief = Path("BRIEF.md").read_text(encoding="utf-8")
        _gemini = GeminiAdapter(MODEL, PROJECT, LOCATION, brief)
    return _gemini, MODEL


def compact(result):
    """Bounded view of a tool result for the step UI (full payload still goes
    to the model; full record still goes to the evidence log)."""
    if "error" in result:
        return {"error": result["error"], "hint": result.get("hint")}
    if "rows" in result:
        return {"latest_snapshot": result.get("latest_snapshot"),
                "count": result.get("count"),
                "truncated": result.get("truncated"),
                "rows_head": result.get("rows", [])[:5]}
    return {k: result.get(k) for k in
            ("snapshot_id", "recipe_id", "step_path", "provider", "name")}


@cl.set_starters
async def set_starters():
    return [cl.Starter(label=lbl, message=msg) for lbl, msg in STARTERS]


@cl.on_chat_start
async def start():
    try:
        ensure_db()
    except Exception as ex:                                      # noqa: BLE001
        await cl.Message(
            "The corpus database couldn't load from the bucket "
            f"({type(ex).__name__}) — check that artifacts/facts.db exists and "
            "the runtime SA can read the bucket, then bump the revision."
        ).send()
        return
    adapter, label = get_adapter()
    cl.user_session.set("adapter", adapter)
    cl.user_session.set("model_label", label)
    cl.user_session.set("contents", [])
    await cl.Message(
        "Ask about the SDC corpus — the more precisely you name a table, "
        "field, or recipe, the fewer steps an answer takes. Expand the steps "
        "under any reply to see its evidence; the full log is attached. "
        "New topic? Start a new chat — short sessions stay sharp."
    ).send()


@cl.on_message
async def on_message(message: cl.Message):
    adapter = cl.user_session.get("adapter")
    contents = cl.user_session.get("contents")
    dispatch = make_dispatch(DB_PATH)
    evidence = Evidence(message.content, cl.user_session.get("model_label"),
                        DB_PATH)

    base_len = len(contents)            # rollback point: a failed turn must not poison the session
    contents.append(adapter.user(message.content))
    answer, err_streak, last_hint, turn = None, 0, None, 0
    try:
        for turn in range(1, MAX_TURNS + 1):
            calls, model_content, text = await asyncio.to_thread(
                adapter.ask, contents)
            if not calls:
                answer = text or "(model returned no text)"
                break
            contents.append(model_content)
            for name, args in calls:
                async with cl.Step(name=name, type="tool") as step:
                    step.input = args
                    result = await asyncio.to_thread(dispatch, name, args)
                    evidence.record(name, args, result)
                    view = compact(result)
                    if "error" in result:
                        err_streak += 1
                        last_hint = result.get("hint")
                        step.output = "⚠ " + json.dumps(view, indent=2,
                                                        ensure_ascii=False)
                    else:
                        err_streak = 0
                        step.output = json.dumps(view, indent=2,
                                                 ensure_ascii=False)
                contents.append(adapter.tool_response(name, bound_payload(result)))
            # Thrash-breaker: repeated tool failures mean the question shape is
            # fighting the data — stop burning turns and reshape instead.
            if err_streak >= 3:
                answer = (
                    "I couldn't land this one — the last few lookups kept "
                    "failing"
                    + (f" (last hint: {last_hint})" if last_hint else "")
                    + ". A more specific framing usually fixes it: name the "
                    "exact table, field, or recipe — e.g. *Who writes "
                    "WFA_SupplierRequest.status?* or *Call chain below UPL-01*."
                )
                break
        else:
            answer = ("That needed more steps than one turn allows. Try "
                      "splitting it — one artifact per question — or narrow "
                      "the scope. The evidence file shows the ground covered.")
        evidence.close(answer, turn)
    except Exception as ex:                                      # noqa: BLE001
        del contents[base_len:]         # roll the session back to before this turn
        answer = friendly_failure(ex)
        evidence.close(f"(exception: {ex!r})", turn)

    await cl.Message(
        content=answer,
        elements=[cl.File(name=evidence.path.name, path=str(evidence.path),
                          display="inline")],
    ).send()
