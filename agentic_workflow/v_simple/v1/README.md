# SDC Corpus Agent

A read-only Q&A agent over the SDC Workato platform (~58 recipes): ask it
structural, dependency, and impact questions — "who writes
`WFA_SupplierRequest.template_file_id`?", "what's the call chain below
UPL-01?", "what changed since last week?" — and get answers with a
machine-readable evidence trail.

The system is deliberately small. Its one architectural commitment:

    facts  →  tools  →  judgment  →  evidence

A deterministic pipeline turns recipe JSON into queryable facts (SQLite).
A two-tool surface exposes those facts, bounded and read-only. A model adds
judgment on top. Every claim traces back through a logged tool call to a row
to a raw capture in versioned object storage. The model is never asked to
parse recipe JSON, and nothing the model does can write anything.

## Parts

| File                 | Role |
|----------------------|------|
| `phase0.sh`          | GCP provisioning (shared-project edition): verifies the service account, creates the versioned bucket + secret, scopes IAM to resources, configures keyless impersonation. Idempotent. |
| `dump_recipes.py`    | Acquisition. Pulls recipe code + data-table schemas from the Workato Developer API into one self-describing snapshot directory. Stdlib only, GET-only. |
| `derive.py`          | Derivation. Walks a snapshot into `facts.db`. The **only writer**. Single commit at the end — a failed run leaves nothing. |
| `schema.sql`         | The fact store: 7 snapshot-keyed tables + base views. The data contract. |
| `schema_catalog.sql` | The agent's view catalog: latest-scoped views promoted from real questions (`v_field_writes`, `v_datapill_consumers`, `v_calls`, `v_table_use`, `v_recipe_drift`). |
| `corpus.py`          | The two tools. `query` — read-only SQL, row-capped, step inputs shielded. `get_step` — the one sanctioned drill-down, field UUIDs resolved. CLI + importable. |
| `BRIEF.md`           | The agent's system prompt: schema tour, learned traps, conduct rules. Under the middle path this is the **only** home for guidance — prompt fixes are edits here, never code. |
| `agent.py`           | The loop: manual `google-genai` function calling over the two tools, evidence log per run (`runs/evidence_*.jsonl`), fake-adapter mode for token-free plumbing tests. |
| `tool_spec.py`       | The six-tool contract from the original design. Not live: retained as the view catalog's spec and the per-class fallback (see Tripwires). |
| `GUIDE.md`           | The build guide: Phases 0–6, each with an exit test. The project's how and why, phase by phase. |

## How it works

**Acquisition.** `dump_recipes.py` writes one `{handle}__{id}.recipe.json`
per recipe (code tree parsed at the boundary) plus three sidecars:
`manifest.json` (table schemas, canonicalized on the numeric id recipe code
uses), `_manifest.json` (provenance: what, when, errors), `_tables_raw.json`
(the untransformed API response — the escape hatch when mappings degrade).
Snapshots write through to a versioned GCS bucket; `$HOME` is scratch, the
bucket is canonical.

**Derivation.** `derive.py` walks each recipe's step tree once, extracting:
steps (identity = positional `step_path`), typed edges (calls, table
reads/writes, connections, properties), and every `#{_dp(...)}` datapill
reference, resolved against the manifest. A within-snapshot backfill then
names every target the snapshot itself knows, so a surviving `resolved=0`
means something sharp: *the target is not in this snapshot*. The report ends
with honesty lines — degraded edges, unresolvable pills, skipped sidecars —
because a nonzero count you can see beats a zero you can't trust.

**Query surface.** `corpus.py` opens `facts.db` with `mode=ro` (writes
physically impossible), accepts SELECT/WITH only, caps rows with an explicit
`truncated` marker, echoes `latest_snapshot` in every result (evidence
carries its vintage), and nulls `steps.input_json` via an authorizer — big
detail flows only through `get_step`, one step at a time. Misses return
`{error, hint}` with nearest names: empty must explain itself.

**Agent.** `agent.py` runs a hand-rolled function-calling loop — automatic
function calling deliberately declined, because the manual loop is what
produces the evidence log, and the evidence log is the product's
credibility. `BRIEF.md` teaches the model the schema, the catalog, the
traversal pattern (recursive CTE), and the traps below.

**Identity.** Everything acts as one service account via short-lived
impersonated credentials — no key files exist for this workload. IAM is
scoped to the specific bucket and secret; the Workato token lives in Secret
Manager and is fetched per-invocation. The same SA becomes the Cloud Run
job's identity at promotion, so validated IAM ships unchanged.

## Design decisions

**The middle path (D1).** Two tools + a view catalog, instead of six curated
tools or raw SQL alone. The SQL exists under every option; this option
freezes proven query shapes as views and lets the model compose over them —
including traversal- and diff-shaped questions no fixed tool set covers.
Semantic guardrails live in the data layer (id canonicalization, backfill,
snapshot echo), where they protect any surface.

**The promotion ladder.** Capability is added at the cheapest rung that has
*earned* it: `BRIEF.md` mirrors learned traps → the catalog mirrors
recurring questions → `tool_spec.py` mirrors the catalog (on tripwire only)
→ a new edge kind in derive mirrors demanded impact analysis. Nothing
mirrors a single answered question.

**Tripwires, not rewrites.** If calibration shows repeated join errors
against well-named views, or one question class misfiring more than once,
exactly that class is promoted to a named tool from `tool_spec.py`.
Per-class retreat, never wholesale.

**Snapshot keying.** Every table is keyed by `snapshot_id`, so change
detection is a self-join, not a redesign: `v_recipe_drift` (latest vs
previous) came free, and edge-level drift ("REM-02 stopped writing
`last_reminder_sent_at`") is the same shape.

**Schema migration is free.** `facts.db` is a pure derivation — the dumps
are the truth. Any schema change is delete, rebuild, re-derive. There is no
data migration, ever.

## Using it

```bash
# session prelude (Cloud Shell)
export PROJECT_ID=... APP=sdc-corpus SA_EMAIL=... BUCKET=... SECRET=... MODEL=...
source ~/corpus-venv/bin/activate

# refresh the corpus
export WORKATO_API_TOKEN="$(gcloud secrets versions access latest --secret=${SECRET})"
SNAP="snap_$(date -u +%Y%m%dT%H%M%SZ)"
python3 dump_recipes.py --folder <id> --dest dumps/${SNAP}
python3 derive.py --dumps dumps/${SNAP} --manifest dumps/${SNAP}/manifest.json \
  --db facts.db --notes "${SNAP} derive=r3"

# ask by hand
python3 corpus.py query "SELECT * FROM v_field_writes WHERE table_name='WFA_SupplierRequest'"

# ask the agent (fake first: zero tokens, verifies plumbing)
python3 agent.py --fake "smoke"
python3 agent.py "Why do failed validations dead-end at steps 25/26?"
```

`GUIDE.md` holds the full phase-by-phase path with exit tests.

## Known limitations

- **Step diffs are positionally noisy.** `step_path` is position-in-parent,
  so inserting one step shifts every later sibling — one insertion reads as
  N modifications. Recipe-level drift (fingerprints) and edge-level drift
  (set comparison) are stable; step-level precision is deliberately
  unsolved until a real question demands tree-diffing.
- **Only two providers cast edges.** Recipe functions and db tables. WFA
  actions (and everything else) exist in `steps` but are invisible to the
  impact graph until a `wfa_write` (etc.) edge kind is promoted into derive.
- **Snapshot diffs conflate two kinds of change** — corpus edits and
  pipeline edits. Only diff snapshots sharing a derive version; the version
  is tagged in `snapshots.notes` (`derive=rN`).
- **Datapill resolution is table-scoped.** Pills referencing job context,
  properties, or prior step outputs stay unresolved by design (counted in
  the honesty lines), and property edges are inferred from pill provider
  naming.
- **One workspace, one corpus.** Folder-scoped acquisition; cross-workspace
  references surface only as `resolved=0` edges.
- **The agent is stateless per run**, bounded by max turns, row caps, and a
  payload guard; the model id is deliberately unpinned (retirement churn)
  and set per-session.
- **Not yet built, on purpose:** contracts engine (contracts are a markdown
  file the agent may read), findings store, scheduled acquisition, review
  UI, embeddings/RAG, write paths of any kind.

## Field notes (Workato boundary knowledge, paid for in full)

- **Data tables have two identities.** The data-tables API returns `id`
  (UUID) and `numeric_id`; recipe code references tables *only* by the
  numeric one. Manifests must canonicalize on `numeric_id` or every table
  join silently NULLs.
- **Export styles differ in enrichment.** Package-style exports resolve
  references to `{id, name}` dicts; raw Developer API code carries bare
  ids. Pipelines built against one style silently degrade on the other —
  hence within-snapshot backfill.
- **`code` may be a string.** The Developer API returns the code tree as a
  JSON string; parse at the boundary, tolerate already-parsed.
- **A snapshot directory is not all recipes.** Sidecar files share the
  `.json` suffix; the filename contract (`.recipe.json`) plus a
  root-shape guard (dict with `code`) keeps them out of ingest — a
  code-less dict otherwise becomes a phantom zero-step recipe.
- **Table-write columns are underscore-UUIDs.** Input keys are field UUIDs
  with hyphens swapped for underscores; store both forms
  (`field_uuid`/`field_key`) so no query does string surgery.
- **UI labels are not machine names.** "Update a request in a workflow app"
  is a label; `steps.provider/name` hold machine strings. Discover the
  vocabulary (census or anchor recipe), then filter.
- **Datapills live inside string values.** `#{_dp('<json>')}` must be
  regexed per string value during the walk — never against the serialized
  whole, where escaping corrupts the payload.

## Roadmap

M1 (this repo): corpus Q&A with evidence — calibration in progress.
M2: scheduled snapshots + drift findings (the schema already supports it;
the bucket already versions for it). M3: contracts as enforced checks,
findings review, promotion onto the parallel-agent-graph runtime (Cloud
Run, action-registry dispatch) — the two tools become two registry entries.
