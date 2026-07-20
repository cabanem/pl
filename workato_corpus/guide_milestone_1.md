# SDC Corpus Agent — Milestone 1 Implementation Guide

Goal: a read-only Q&A agent over the recipe corpus, built entirely in Cloud
Shell, with no infrastructure created until the agent passes calibration.

Spine of the design: **facts → tools → judgment → evidence.** The deterministic
layer (`derive.py` → `facts.db`) produces facts. The agent only ever sees facts
through six bounded tools (`tool_spec.py`). Every answer is traceable to tool
calls; every tool result is traceable to rows; every row is traceable to a raw
capture (`recipes.raw_path`).

**Dual use:** this file is a checklist for a human, and each phase is written
with a definition of done so it can be pasted verbatim — together with
`schema.sql`, `tool_spec.py`, and `derive.py` — as the brief for a coding
agent. Give an agent one phase at a time, not the whole file.

Files in this kit:

    schema.sql     the fact store DDL (7 tables, 3 views) — the data contract
    tool_spec.py   the 6 tool declarations + output shapes — the tool contract
    derive.py      dumps + manifest -> facts.db — the derivation pass

Rules that hold in every phase:

1. The agent never parses raw recipe JSON. If a question can't be answered
   with the six tools, that is a signal to extend the tool layer, not to
   hand the model JSON.
2. Read-only against Workato throughout M1. The only Workato API calls are
   GETs during acquisition.
3. Infrastructure follows proof. Nothing is deployed before Phase 5 passes.

---

## Phase 0 — Cloud Shell setup (10 min)

    mkdir -p ~/sdc-agent/{dumps,out} && cd ~/sdc-agent
    # upload schema.sql, tool_spec.py, derive.py via the Cloud Shell menu
    pip install --user google-genai
    python3 -c "import sqlite3, google.genai; print('ok')"

Cloud Shell's home directory persists across sessions; everything lives there
until Phase 6. No service accounts, no keys, no buckets yet.

**Done when:** the import check prints ok.

## Phase 1 — Data in

Two inputs: recipe dumps and the table manifest.

Recipe dumps — either upload existing `dump_recipes.py` output, or pull fresh
from the Developer API (token pasted into an env var for now; Secret Manager
comes in Phase 6):

    export WORKATO_API_TOKEN=...   # do not write this into any file
    # per recipe id:
    curl -s -H "Authorization: Bearer $WORKATO_API_TOKEN" \
      "https://www.workato.com/api/recipes/<id>" > dumps/r_<id>.json

Manifest — export the data-table manifest to `manifest.json`. `derive.py`
expects `[{table_id, name, fields:[{uuid, name, type}]}]` and tolerates common
aliases; if your manifest shape differs, `load_manifest()` in `derive.py` is
the single adapter point to edit. Deriving without a manifest works but
degrades field resolution to NULLs — get the manifest in before calibration.

**Done when:** `ls dumps/*.json | wc -l` ≈ 58 and `manifest.json` exists.

## Phase 2 — Derive and sanity-check

    sqlite3 facts.db < schema.sql
    python3 derive.py --dumps dumps --manifest manifest.json --db facts.db

The report prints counts plus two honesty lines: degraded call edges
(`resolved=0`) and unresolvable datapills. Nonzero is expected — investigate
magnitude, not existence.

Acceptance queries (run in `sqlite3 facts.db`; you know the right answers):

    -- 1. Corpus loaded: should be ~58
    SELECT COUNT(*) FROM recipes;
    -- 2. Call graph looks like the platform you built
    SELECT src_recipe_name, dst_recipe_name FROM v_call_graph;
    -- 3. UPL-01 calls VAL-01 (ground truth from the June trace)
    SELECT * FROM v_call_graph WHERE src_recipe_name LIKE '%UPL-01%';
    -- 4. Writers of WFA_SupplierRequest exist and are the recipes you expect
    SELECT recipe_name, src_step_path FROM v_table_access
      WHERE table_name='WFA_SupplierRequest' AND kind='table_write';
    -- 5. Field resolution live: template_file_id resolves
    SELECT table_id, field_key FROM table_fields WHERE field_name='template_file_id';

**Done when:** all five return plausible results and you can explain every
`resolved=0` row (they should correspond to known export degradations).

## Phase 3 — Implement the tool layer

Write `tools.py`: one function per entry in `tool_spec.TOOLS`, dispatching SQL
against `facts.db`. The spec is the contract — parameter names, output shapes,
bounds, and the error convention (`{"error", "hint"}`, never raise) are all
defined there. Implementation notes:

- Open read-only: `sqlite3.connect("file:facts.db?mode=ro", uri=True)`.
- Resolve "latest snapshot" once per call via `v_latest_snapshot`.
- `get_step` input resolution: parse `input_json`, rewrite any key found in
  `table_fields.field_key` to `"<field_name> (<field_key>)"`.
- `find_edges` detail resolution: parse `detail_json`, map `columns` entries
  through `table_fields.field_key -> field_name`.
- `trace_datapill` writers: `table_write` edges whose `detail_json` columns
  contain the field's `field_key`; consumers: `datapills` rows matching
  `field_uuid`. (Both joins validated against fixtures already.)
- Enforce limits and set `truncated` honestly — query `limit+1`, return
  `limit`.

Then hand-drive it before any model touches it:

    python3 -c "import tools, json; print(json.dumps(tools.list_recipes(), indent=1))"

Ask your five acceptance questions through the tools by hand. If a question is
awkward to answer with the six tools, fix the tool layer now — this is the
cheapest moment to change the design.

**Done when:** each tool answers correctly from the CLI, matches its declared
output shape, and returns `{"error", "hint"}` for a bad recipe_id.

## Phase 4 — The agent loop

~50 lines, no framework. Mechanism first; ADK is the Phase-6+ promotion path.

    from google import genai
    from google.genai import types
    import tools, tool_spec, json

    client = genai.Client(vertexai=True, project="<PROJECT>", location="us-central1")
    cfg = types.GenerateContentConfig(
        system_instruction=(
            "You answer questions about a Workato recipe corpus using only the "
            "provided tools. Never guess recipe contents. Cite evidence as "
            "recipe_id/step_path. If tools cannot answer, say so."),
        tools=[types.Tool(function_declarations=tool_spec.gemini_declarations())])

    def ask(question, max_turns=12):
        contents = [types.Content(role="user", parts=[types.Part(text=question)])]
        for _ in range(max_turns):
            resp = client.models.generate_content(
                model="gemini-flash-latest", contents=contents, config=cfg)
            calls = resp.function_calls or []
            if not calls:
                return resp.text
            contents.append(resp.candidates[0].content)
            for call in calls:
                result = getattr(tools, call.name)(**dict(call.args))
                contents.append(types.Content(role="tool", parts=[
                    types.Part.from_function_response(name=call.name, response={"result": result})]))
        return "(max turns reached)"

    if __name__ == "__main__":
        import sys; print(ask(" ".join(sys.argv[1:])))

(Verify current SDK call signatures against the google-genai docs — the shape
above is the pattern, not gospel.) Log every tool call and its row counts to
stderr: that trace is your debugging view and, later, the finding's evidence.

**Done when:** `python3 agent.py "which recipes call VAL-01?"` answers
correctly with a visible tool-call trace.

## Phase 5 — Calibration (the gate)

Ten questions you already know the answers to, graded on three axes:
**correct answer**, **valid evidence chain** (every claim traceable to a tool
result), **sane tool budget** (no flailing; roughly ≤10 calls each). Starters,
grounded in your own defect history:

1. Which recipes call VAL-01, and from which steps?
2. What tables does UPL-01 write, and which columns?
3. What breaks if `WFA_SupplierRequest.template_file_id` is renamed?
   (trace_datapill: writers + consumers)
4. Which steps anywhere contain the literal `pending_review`? Any
   near-misses? (the STS-01 typo class — search `pending_re`)
5. Which recipes have unresolved call targets? (find_edges, resolved=false)
6. Which `RUN_`-prefixed tables are written by recipes that UPL-01 calls,
   directly or one hop away?
7. What is the trigger and step skeleton of the INV-01a join recipe?
8. Which py_eval steps reference `base64`?
9. Which recipes are flagged unfinished?
10. **Acceptance test:** why do failed validations dead-end at UPL-01 steps
    25/26? The agent should reach the verdict-token routing story — the
    "error"-verdict dead-end and the hardcoded `target_state` at step 28 —
    from tool evidence alone.

Grade honestly. Wrong answers split into two failure classes with different
fixes: the tool lied (fix derivation/tools — deterministic bug) or the model
misread true tool output (fix descriptions/system prompt). The trace tells
you which.

**Done when:** ≥8/10 correct with valid evidence, and #10 in particular
reaches the known diagnosis.

## Phase 6 — Productionize (only after Phase 5 passes)

    gsutil mb -l us-central1 gs://<project>-sdc-corpus
    gsutil versioning set on gs://<project>-sdc-corpus

- Token to Secret Manager; delete the env-var habit.
- Wrap acquisition + `derive.py` as a Cloud Run job (container: python:3.12-slim,
  the two scripts, no other deps). Job SA gets `secretmanager.secretAccessor`
  + `storage.objectAdmin` on the bucket, nothing else. No downloaded keys
  anywhere.
- Cloud Scheduler → nightly job run. Writes `snapshots/<ts>/*.json` and
  `artifacts/facts.db`.
- Agent stays in Cloud Shell (downloads `facts.db` at start) until you want it
  callable — then the same `tools.py` + loop wraps as a small Cloud Run
  service, and GAS can call it exactly like GeminiService calls Gemini today.

**Done when:** two consecutive scheduled runs produce diffable snapshots and a
fresh `facts.db`, untouched by hand.

---

## Deliberately out of scope for M1

No embeddings/RAG (58 recipes: SQL + grep wins on accuracy and debuggability).
No contracts engine (M3 — but keep an informal `contracts-notes.md` as rules
occur to you). No write path of any kind. No ADK/Agent Engine until the
graph/checkpoint features are needed for the M3 review gate. No BigQuery
unless you want a human browsing mirror — and then only as a read-only copy.

## Where this goes next

M2 (drift diagnosis) = a second snapshot + a `diff_snapshots` tool + the
watchdog invoking `ask()` with a templated question. M3 (change review) =
contracts as data + findings with review status. Both reuse everything above;
nothing here is throwaway.
