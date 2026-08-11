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


@cl.on_chat_start
async def start():
    ensure_db()
    adapter, label = get_adapter()
    cl.user_session.set("adapter", adapter)
    cl.user_session.set("model_label", label)
    cl.user_session.set("contents", [])
    await cl.Message(
        "Ask about the SDC corpus — structure, dependencies, impact, drift. "
        "Every answer carries its evidence trail (expand the steps; the full "
        "log is attached to each reply)."
    ).send()


@cl.on_message
async def on_message(message: cl.Message):
    adapter = cl.user_session.get("adapter")
    contents = cl.user_session.get("contents")
    dispatch = make_dispatch(DB_PATH)
    evidence = Evidence(message.content, cl.user_session.get("model_label"),
                        DB_PATH)

    contents.append(adapter.user(message.content))
    answer = None
    for _turn in range(1, MAX_TURNS + 1):
        calls, model_content, text = await asyncio.to_thread(
            adapter.ask, contents)
        if not calls:
            answer = text or "(model returned no text)"
            evidence.close(answer, _turn)
            break
        contents.append(model_content)
        for name, args in calls:
            async with cl.Step(name=name, type="tool") as step:
                step.input = args
                result = await asyncio.to_thread(dispatch, name, args)
                evidence.record(name, args, result)
                step.output = json.dumps(compact(result), indent=2,
                                         ensure_ascii=False)
            contents.append(adapter.tool_response(name, bound_payload(result)))
    else:
        answer = "(max turns reached without a final answer — see evidence log)"
        evidence.close(answer, MAX_TURNS)

    await cl.Message(
        content=answer,
        elements=[cl.File(name=evidence.path.name, path=str(evidence.path),
                          display="inline")],
    ).send()