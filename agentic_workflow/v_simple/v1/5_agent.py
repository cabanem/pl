#!/usr/bin/env python3
"""agent.py — corpus Q&A agent: manual function-calling loop (Phase 5).

    export MODEL=<current gemini id>            # unpinned by design
    python3 agent.py "Why do failed validations dead-end at steps 25/26?"
    python3 agent.py --fake "smoke test"        # no SDK, no tokens: loop plumbing only

Design:
  * Manual loop, not the SDK's automatic function calling — the evidence log
    (runs/evidence_*.jsonl) is the product's credibility, so every tool call
    passes through our hands and gets recorded.
  * The model adapter is a boundary switch (same pattern as the side
    project's FakeLLM): GeminiAdapter wraps google-genai; FakeAdapter
    exercises the identical loop with a scripted conversation. google-genai
    is imported only inside GeminiAdapter, so --fake needs nothing installed.
  * Tools are corpus.py's two functions, declared once as plain-dict JSON
    schemas that google-genai coerces natively.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import corpus

MAX_TOOL_PAYLOAD = 80_000        # chars of JSON handed back per tool result

DECLARATIONS = [
    {
        "name": "query",
        "description": (
            "Read-only SQL (SELECT/WITH) over the corpus fact store. Prefer the "
            "catalog views (v_field_writes, v_datapill_consumers, v_calls, "
            "v_table_use). Results carry latest_snapshot, count, truncated; "
            "steps.input_json reads as NULL here — use get_step for step detail. "
            "Errors and empty results include a hint: act on it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sql": {"type": "string",
                        "description": "One SELECT or WITH statement."},
            },
            "required": ["sql"],
        },
    },
    {
        "name": "get_step",
        "description": (
            "Full detail for exactly one step: input with data-table field keys "
            "rewritten to 'field_name (field_key)', the step's datapills, and "
            "its outgoing edges. The only door to step inputs."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "recipe_id": {"type": "string"},
                "step_path": {"type": "string",
                              "description": "Tree position, e.g. '0/2/1'."},
                "snapshot_id": {"type": "integer",
                                "description": "Omit for latest."},
            },
            "required": ["recipe_id", "step_path"],
        },
    },
]


# ---- dispatch (the only place tools execute) ---------------------------------

def make_dispatch(db_path):
    def dispatch(name, args):
        try:
            if name == "query":
                return corpus.query(str(args.get("sql", "")), db_path=db_path)
            if name == "get_step":
                return corpus.get_step(
                    str(args.get("recipe_id", "")), str(args.get("step_path", "")),
                    snapshot_id=args.get("snapshot_id"), db_path=db_path)
            return {"error": f"unknown tool '{name}'",
                    "hint": "available tools: query, get_step"}
        except Exception as ex:                                  # noqa: BLE001
            return {"error": f"tool crashed: {ex!r}",
                    "hint": "simplify the call and retry"}
    return dispatch


def bound_payload(result):
    """Hand the model a bounded JSON payload; disclose any elision."""
    text = json.dumps(result, ensure_ascii=False)
    if len(text) <= MAX_TOOL_PAYLOAD:
        return result
    slim = dict(result)
    rows = slim.get("rows")
    if isinstance(rows, list) and len(rows) > 50:
        slim["rows"] = rows[:50]
        slim["truncated"] = True
        slim["note"] = f"payload elided to 50 of {len(rows)} rows — narrow the query"
        return slim
    return {"error": "result too large to return",
            "hint": "select fewer columns or add a WHERE clause"}


# ---- evidence ----------------------------------------------------------------

class Evidence:
    """One JSONL file per run: header, one line per tool call, footer."""

    def __init__(self, question, model, db_path, out_dir="runs"):
        Path(out_dir).mkdir(exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        self.path = Path(out_dir) / f"evidence_{stamp}.jsonl"
        self.seq = 0
        self.calls = 0
        self._write({"question": question, "model": model, "db": db_path,
                     "started": datetime.now(timezone.utc).isoformat(timespec="seconds")})

    def _write(self, obj):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")

    def record(self, tool, args, result):
        self.seq += 1
        self.calls += 1
        self._write({"seq": self.seq, "tool": tool, "args": args,
                     "ok": "error" not in result,
                     "count": result.get("count"),
                     "truncated": result.get("truncated"),
                     "error": result.get("error")})

    def close(self, answer, turns):
        self._write({"turns": turns, "tool_calls": self.calls,
                     "answer": answer})


# ---- model adapters (the boundary switch) ------------------------------------

class GeminiAdapter:
    """google-genai, manual function calling. All SDK contact lives here."""

    def __init__(self, model, project, location, brief, temperature=0.2):
        from google import genai                      # imported here on purpose
        from google.genai import types
        self.t = types
        self.model = model
        self.client = genai.Client(vertexai=True, project=project,
                                   location=location)
        self.config = types.GenerateContentConfig(
            system_instruction=brief,
            temperature=temperature,
            tools=[types.Tool(function_declarations=[
                types.FunctionDeclaration(**d) for d in DECLARATIONS])],
        )

    def user(self, text):
        return self.t.Content(role="user",
                              parts=[self.t.Part.from_text(text=text)])

    def ask(self, contents):
        resp = self.client.models.generate_content(
            model=self.model, contents=contents, config=self.config)
        calls = [(fc.name, dict(fc.args or {}))
                 for fc in (resp.function_calls or [])]
        model_content = resp.candidates[0].content if resp.candidates else None
        text = None
        if not calls:
            try:
                text = resp.text
            except Exception:                                    # noqa: BLE001
                text = None
        return calls, model_content, text

    def tool_response(self, name, result):
        return self.t.Content(role="tool", parts=[
            self.t.Part.from_function_response(name=name,
                                               response={"result": result})])


class FakeAdapter:
    """Scripted conversation over the identical loop — zero SDK, zero tokens.
    Turn 1: query the catalog. Turn 2: drill into a step. Turn 3: answer."""

    def __init__(self, *_args, **_kw):
        self.script = [
            [("query", {"sql": "SELECT * FROM v_field_writes"})],
            [("get_step", {"recipe_id": "101", "step_path": "2"})],
            [],
        ]

    def user(self, text):
        return {"role": "user", "text": text}

    def ask(self, contents):
        calls = self.script.pop(0) if self.script else []
        if calls:
            return calls, {"role": "model", "calls": calls}, None
        return [], {"role": "model"}, ("FAKE ANSWER — loop plumbing verified: "
                                       "made scripted calls, saw tool results.")

    def tool_response(self, name, result):
        return {"role": "tool", "name": name, "result": result}


# ---- the loop ----------------------------------------------------------------

def run(adapter, question, dispatch, evidence, max_turns=16):
    contents = [adapter.user(question)]
    for turn in range(1, max_turns + 1):
        calls, model_content, text = adapter.ask(contents)
        if not calls:
            answer = text or "(model returned no text)"
            evidence.close(answer, turn)
            return answer
        contents.append(model_content)
        for name, args in calls:
            result = dispatch(name, args)
            evidence.record(name, args, result)
            contents.append(adapter.tool_response(name, bound_payload(result)))
    answer = "(max turns reached without a final answer — see evidence log)"
    evidence.close(answer, max_turns)
    return answer


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("question")
    ap.add_argument("--db", default="facts.db")
    ap.add_argument("--brief", default="BRIEF.md")
    ap.add_argument("--model", default=os.environ.get("MODEL"))
    ap.add_argument("--project",
                    default=os.environ.get("GOOGLE_CLOUD_PROJECT"))
    ap.add_argument("--location", default="global")
    ap.add_argument("--max-turns", type=int, default=16)
    ap.add_argument("--fake", action="store_true",
                    help="scripted adapter: verify loop plumbing, no tokens")
    args = ap.parse_args(argv)

    brief = Path(args.brief).read_text(encoding="utf-8")
    if args.fake:
        adapter = FakeAdapter()
        model_label = "fake"
    else:
        if not args.model or not args.project:
            sys.exit("set MODEL and GOOGLE_CLOUD_PROJECT (or --model/--project)")
        adapter = GeminiAdapter(args.model, args.project, args.location, brief)
        model_label = args.model

    evidence = Evidence(args.question, model_label, args.db)
    dispatch = make_dispatch(args.db)
    answer = run(adapter, args.question, dispatch, evidence,
                 max_turns=args.max_turns)

    print(answer)
    print(f"\n[evidence: {evidence.path} — {evidence.calls} tool call(s)]",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
