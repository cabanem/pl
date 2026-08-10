# SDC Corpus Agent — Milestone 1 Implementation Guide (rev. 2, post-Phase-0)

Goal: a read-only Q&A agent over the recipe corpus, built entirely in Cloud
Shell, with no *compute* deployed until the agent passes calibration.

Spine of the design: **facts → tools → judgment → evidence.** The deterministic
layer (`derive.py` → `facts.db`) produces facts. The agent only ever sees facts
through the sanctioned tool surface. Every answer is traceable to tool calls;
every tool result is traceable to rows; every row is traceable to a raw capture.

**Dual use:** this file is a checklist for a human, and each phase is written
with a definition of done so it can be pasted verbatim — together with
`schema.sql`, `derive.py`, and (if D1 resolves to six tools) `tool_spec.py` —
as the brief for a coding agent. Give an agent one phase at a time.

**What changed in rev. 2:** Phase 0 is now `phase0.sh` (shared team project,
dedicated service account, keyless impersonation, bucket + secret provisioned
up front). Consequences ripple forward: the Workato token comes from Secret
Manager in Phase 1 (never an env var pasted by hand), snapshots and artifacts
write through to GCS as they are produced, and all model calls use the
`google-genai` SDK — the old `vertexai.generative_models` modules were
**removed from the SDK on June 24, 2026** and must not appear in any code.

Files in this kit:

    phase0.sh      shared-project provisioning (SA, bucket, secret, IAM)
    schema.sql     the fact store DDL (7 tables, 3+ views) — the data contract
    derive.py      dumps + manifest -> facts.db — the derivation pass
    tool_spec.py   the 6-tool contract — view-catalog spec + per-class fallback
    schema_catalog.sql  latest-scoped agent views (apply after schema.sql)
    corpus.py      the two tools: query (read-only SQL) + get_step

Rules that hold in every phase:

1. The agent never parses raw recipe JSON. If a question can't be answered
   through the tool surface, that is a signal to extend the surface (a new
   view, or a new tool), not to hand the model JSON.
2. Read-only against Workato throughout M1. The only Workato API calls are
   GETs during acquisition. `facts.db` is opened read-only by every consumer
   except `derive.py`.
3. Compute follows proof. Storage and identity were provisioned in Phase 0
   because they are near-free and shape every later phase; nothing that *runs
   unattended* is deployed before Phase 5 passes.
4. One identity. Everything — CLI, Python, and later Cloud Run — acts as the
   single SA in `${SA_EMAIL}`. If something works as you but fails as the SA,
   the SA is missing a grant; fix the grant, never widen your own access as a
   patch. One workload, one identity — resist splitting across multiple SAs
   until there are genuinely multiple workloads (promotion, at the earliest).

---

## Environment prelude (paste at the top of every session)

Cloud Shell sessions are ephemeral shells over a persistent `$HOME`. Start
each session with:

    export PROJECT_ID="$(gcloud config get-value project)"
    export APP=sdc-corpus
    export SA_EMAIL="<your-existing-sa>@${PROJECT_ID}.iam.gserviceaccount.com"
    export BUCKET="gs://${APP}-${PROJECT_ID}"
    export SECRET="${APP}-workato-token"
    export MODEL="<current Gemini id>"   # check the Agent Platform model
                                         # catalog; the 2.5 family retires
                                         # 2026-10-16 — do not hardcode it
    source ~/corpus-venv/bin/activate

**Two credential planes, both pointed at the SA.** Python client libraries
read the impersonated ADC file written in Phase 0 and need nothing further.
The `gcloud` CLI is a *separate* plane — it runs as you unless told otherwise,
and *you* hold no resource grants (only the SA does). Point it at the SA once:

    gcloud config set auth/impersonate_service_account "${SA_EMAIL}"

Every `gcloud` command below assumes this is set. The warning banner gcloud
prints on each impersonated call is normal.

---

## Phase 0 — Provisioning (done)

`phase0.sh` has run: the pre-existing SA verified and audited (its inherited
project-level roles printed — that inheritance IS the agent's real permission
surface, so read the list), bucket versioned, secret populated, new IAM
scoped to resources, impersonated ADC configured, and
`~/corpus-venv` exists with `google-genai` + `google-cloud-storage` installed.

**Done when:** both smoke tests pass —

    gcloud secrets versions access latest --secret="${SECRET}" | head -c 8
    echo hello | gcloud storage cp - "${BUCKET}/smoke.txt"

If either 403s within a minute of running `phase0.sh`, wait 60 seconds —
fresh IAM bindings propagate slowly and impersonation failures masquerade as
real permission problems.

## Phase 1 — Data in

Two inputs: recipe dumps and the table manifest — `dump_recipes.py` (standalone
Cloud Shell edition) now captures both in one run. The token comes from Secret
Manager; it must be exported (the script reads the environment, never a file):

    export WORKATO_API_TOKEN="$(gcloud secrets versions access latest --secret="${SECRET}")"
    SNAP="snap_$(date -u +%Y%m%dT%H%M%SZ)"
    cd ~/sdc-agent
    python3 dump_recipes.py --folder <SDC_FOLDER_ID> --dest dumps/${SNAP}

This writes one `{handle}__{id}.recipe.json` per recipe (code tree parsed),
plus three sidecars: `manifest.json` (the table schema map derive.py consumes),
`_manifest.json` (provenance of this dump: what, when, errors), and
`_tables_raw.json` (the untransformed data-tables API response — the escape
hatch if field-uuid mapping degrades). EU data center: set
`WORKATO_API_BASE=https://app.eu.workato.com` first.

Manifest shape — `derive.py` expects `[{table_id, name, fields:[{uuid, name,
type}]}]`, which `dump_recipes.py` emits; if the dump report counts fields
without uuids, inspect `_tables_raw.json` and adapt `load_manifest()` in
`derive.py` — that remains the single adapter point. Deriving without a
manifest works but degrades field resolution to NULLs — get the manifest in
before calibration.

Write-through to the bucket immediately (versioning makes this the diffable
history; `$HOME` is scratch, the bucket is canonical):

    gcloud storage cp -r dumps/${SNAP} "${BUCKET}/snapshots/${SNAP}/"

**Done when:** `ls dumps/${SNAP}/*.recipe.json | wc -l` ≈ 58, `manifest.json`
exists with zero (or explained) uuid-less fields, the dump report shows zero
errors, the snapshot is in `${BUCKET}/snapshots/${SNAP}/`, and
`unset WORKATO_API_TOKEN` has run.

## Phase 2 — Derive and sanity-check

    sqlite3 facts.db < schema.sql
    python3 derive.py --dumps dumps/${SNAP} --manifest dumps/${SNAP}/manifest.json \
      --db facts.db --notes "${SNAP}"

The report prints counts plus two honesty lines: degraded call edges
(`resolved=0`) and unresolvable datapills. Nonzero is expected — investigate
magnitude, not existence. Spot-check against the `edges.json` freeze: pick
three edges you know by heart (a `call_sync`, a `table_write` with column
detail, a property read) and confirm each appears with correct endpoints.

Publish the artifact:

    gcloud storage cp facts.db "${BUCKET}/artifacts/facts.db"

**Done when:** recipe count matches the corpus, spot-checks pass, and the
artifact is in the bucket. Every later phase may re-download it fresh:
`gcloud storage cp "${BUCKET}/artifacts/facts.db" .`

## Phase 3 — Answer questions by hand

Before any agent exists, prove the *data* can answer real questions. Open the
db read-only and work three calibration questions with raw SQL:

    sqlite3 "file:facts.db?mode=ro"

Suggested set (swap in your own — the point is questions whose answers you
already know from hand analysis):

1. Which recipes write `WFA_SupplierRequest`, and which columns?
2. Every consumer of one `CFG_` table field, across the corpus.
3. The full call chain from UPL-01 downward, with sync/async marked.

As you work, notice which joins recur. **Promote each recurring join into a
named view in `schema.sql`** (e.g. `v_datapill_consumers`). This is not
housekeeping — in the two-tool design (D1 below) the view catalog *is* the
tool surface, and this phase is where it gets discovered rather than invented.

**Done when:** all three questions answered in ≤3 SQL statements each, and
every recurring join has become a view.

## Phase 4 — The tool layer

**Decision D1 — RESOLVED: the middle path.** `query(sql)` + `get_step`, with
the catalog views as the curated surface. The SQL exists under every option;
the middle path freezes the shapes Phase 3 proved (as views) and lets the
model compose over them — including traversal- and diff-shaped questions no
fixed tool set covers. `tool_spec.py` is retained as the view catalog's
contract and the per-class fallback (see Phase 6 tripwires).

Deliverables:

- `schema_catalog.sql` — latest-scoped catalog views (v_field_writes,
  v_datapill_consumers, v_calls, v_table_use). Apply once, or fold into
  schema.sql. Promotion ritual: any join written twice gets a name here.
- `corpus.py` — the two tools, as CLI subcommands and importable functions:

    python3 corpus.py query "SELECT ... FROM v_calls WHERE ..."
    python3 corpus.py get-step <recipe_id> 0/2/1

Non-negotiables, enforced in corpus.py rather than suggested:

- `mode=ro` URI connection — writes are physically impossible.
- SELECT/WITH only; row cap (default 200) with an explicit `truncated`
  marker; every result echoes `latest_snapshot` so evidence carries vintage.
- An authorizer nulls `steps.input_json` under `query` — big detail flows
  only through `get_step`, one step at a time. (Rule: no tool ever returns
  a raw code tree. `get_step` is the sanctioned door and rewrites data-table
  field keys to 'field_name (field_key)'.)
- Errors and misses return `{error, hint}` — nearest names, known
  step_paths — never a bare empty or a stack trace.

**Done when:** the three Phase 3 questions are answerable using only the CLI —
no direct sqlite3 access — and a `get_step` on a py_eval step returns resolved
field names.

## Phase 5 — The agent loop

Two files: `BRIEF.md` (the system prompt — the ONLY place guidance lives
under the middle path, so prompt fixes in Phase 6 are edits here, never code
changes) and `agent.py` (the manual loop over corpus.py's two tools).

    from google import genai
    from google.genai import types
    # all SDK contact lives inside agent.py's GeminiAdapter

Loop: send question + the two declarations → while the response contains
function calls, dispatch to corpus.query / corpus.get_step, append results,
log every call as a JSON line (runs/evidence_*.jsonl: header, one line per
call with {tool, args, ok, count, truncated}, footer with the answer) →
final text.

Run order:

1.  `python3 agent.py --fake --db facts.db "smoke"` — the FakeAdapter (same
    boundary-switch pattern as the side project's FakeLLM) exercises the
    identical loop with a scripted conversation: zero SDK, zero tokens.
    Verifies dispatch, payload bounding, and the evidence log before any
    live call.
2.  `export MODEL=<current id>; export GOOGLE_CLOUD_PROJECT=<project>` then
    `python3 agent.py "…"` for live runs.

Notes that will save you an afternoon:

- The SDK is client-based; there is no `vertexai.init()`. Anything using
  `vertexai.generative_models` is dead code as of 2026-06-24.
- Automatic function calling stays off (declarations only, no callables):
  the manual loop is what produces the evidence log, and the evidence log
  is the product's credibility.
- Responses are Pydantic models — `.model_dump()`, not `.to_dict()`.
- Tool payloads back to the model are bounded (row cap in corpus.py plus a
  character guard in agent.py that discloses any elision).

**Done when (acceptance test):** the agent, using only the tool surface,
reproduces your hand-derived diagnosis of the steps-25/26 dead-end — same
root cause, evidence log showing the tool calls that support it.

## Phase 6 — Calibrate, then decide about promotion

Run a ~10-question calibration set spanning the question classes you actually
ask (impact-of-rename, who-writes-this-table, call-chain, config-resolution).
For each: correct/incorrect, evidence quality, tool calls consumed. Failures
route to exactly one of three fixes — a missing view, a prompt clarification,
or a **tripwire promotion**: if calibration shows repeated join errors against
well-named views, or one specific question class misfiring more than once,
promote exactly that class to a named tool from `tool_spec.py` — per-class
retreat, never wholesale.

Promotion is now *only* a compute decision, because identity and storage
already exist: a Cloud Run job running as `${SA_EMAIL}` (the same SA —
zero new IAM) doing acquisition + derivation on a Cloud Scheduler cadence,
with the interactive loop pointed at `${BUCKET}/artifacts/facts.db`. The
promotion runtime can be the parallel-agent-graph platform when its Phase 2+
exists; `query` and `get_step` become two action-registry entries. That
convergence is a reward for passing calibration, not a prerequisite.

**Done when:** calibration score recorded with transcripts in
`${BUCKET}/artifacts/calibration/${SNAP}/`, and a written go/no-go on
promotion.

---

## Deliberately out of scope for M1 (unchanged from rev. 1)

No embeddings/RAG. No contracts engine (contracts live in a markdown file the
agent may read). No findings table (an M1 finding is an answer with its
evidence log attached). No snapshot diffing (the schema already supports it;
the bucket already versions for it). No BigQuery (a `bq load` mirror is one
command away if ad-hoc console SQL ever earns its keep). No ADK, no Agent
Engine, no Workato write paths.