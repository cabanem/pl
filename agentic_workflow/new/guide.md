# SDC Documentation Pipeline — Build Guide

**Goal:** a self-refreshing documentation site for the SDC platform — dependency maps, per-workstream diagrams, a change feed, and (later) per-recipe prose with evidence citations — generated nightly from the live Workato workspace, published behind IAP, readable by the team with their Google accounts.

**Success as defined:** every claim in the finished docs traces to a parsed production artifact, a cited step, or a version-controlled decision record. Nothing hand-maintained that a machine can derive; nothing machine-generated that requires hand-editing.

This guide assumes the fact store does **not** exist yet. Building it is Phases 0–2; the same tables become the corpus agent's store later (decision D9 — BigQuery as sole fact store — is satisfied by this build).

## The shape of the thing

```
Workato Developer API ──▶ ingest (Cloud Run Job, nightly)
                              │  parse code JSON → flatten steps → extract edges
                              ▼
                        BigQuery: workato_facts
                        (recipes / steps / edges, snapshot-partitioned)
                              │  views only — the contract
                              ▼
                        render (same job)
                        Mermaid maps + change feed + index pages
                              │  mkdocs build
                              ▼
                        GCS bucket ──▶ Cloud Run service (nginx + GCS volume)
                                            behind IAP ──▶ team
```

Hand-written "why" pages (ADRs) live in the repo, ship with the job image, and merge into the same site at build time.

## Assumptions to verify before Phase 2

These are the only places this guide leans on API details you should confirm against your workspace (you built the Developer API connector — this will take you minutes):

1. **Base URL** for your data center (`https://www.workato.com` vs `app.eu.workato.com`, etc.). Set via `WORKATO_API_BASE`.
2. **API client token scopes**: the client needs read access to recipes and folders (add connections later if you want them as facts).
3. **Recipe `code` availability**: the client below assumes `GET /api/recipes` list items include `code`; if your tenant returns it only from `GET /api/recipes/:id`, the fallback in `workato.py` handles it — just confirm it fires.
4. **Folder listing**: confirm whether `GET /api/folders` returns the full tree flat or requires `parent_id` traversal; adjust `folders()` if the latter.
5. **IAP attachment**: mirror whatever you did for the corpus agent's Chainlit service; the `--iap` flag shown in Phase 4 is the newer direct integration — use your proven path if gcloud versions disagree.

Everything else (step JSON shape, provider keywords) is handled *empirically* — the parser is defensive, and the edge taxonomy is derived from a census of your actual estate, not assumed.

---

# Phase 0 — Scaffold (½ day)

## 0.1 Local repo

No remote needed. History starts today; GitLab gets a `git remote add` later.

```bash
mkdir sdc-docs-pipeline && cd sdc-docs-pipeline
git init
```

Target layout (files created as you go through the guide):

```
sdc-docs-pipeline/
├── mkdocs.yml
├── requirements.txt
├── Dockerfile                  # the nightly job
├── .env.example
├── infra/
│   └── site/
│       ├── Dockerfile          # nginx docs server
│       └── nginx.conf
├── sql/
│   ├── 001_tables.sql
│   └── 002_views.sql
├── src/pipeline/
│   ├── __init__.py
│   ├── run.py                  # orchestrator
│   ├── workato.py              # API client
│   ├── parse.py                # walk / flatten / fingerprint
│   ├── edges.py                # edge extraction rules
│   ├── load.py                 # BigQuery load
│   ├── render.py               # views → Mermaid + Markdown
│   └── publish.py              # site → GCS
└── docs_static/                # hand-written; merged into site
    ├── index.md
    └── decisions/
        └── ADR-000-template.md
```

`requirements.txt`:

```
requests
google-cloud-bigquery
google-cloud-storage
mkdocs-material
```

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## 0.2 GCP resources

```bash
export PROJECT=<your-project>
export REGION=<your-region>          # match the corpus agent's region
export DATASET=workato_facts
export BUCKET=${PROJECT}-sdc-docs-site
export SA=sdc-docs-pipeline@${PROJECT}.iam.gserviceaccount.com

gcloud config set project $PROJECT

# Service account for both the job and the scheduler trigger
gcloud iam service-accounts create sdc-docs-pipeline \
  --display-name "SDC docs pipeline"

# Site bucket (uniform access; IAP handles humans, nginx reads via SA)
gcloud storage buckets create gs://$BUCKET --location=$REGION \
  --uniform-bucket-level-access

# Workato token → Secret Manager
printf '%s' '<WORKATO_API_TOKEN>' | \
  gcloud secrets create workato-api-token --data-file=-
```

Grants (you're the IAM expert — tighten to taste; this is the minimal working set):

| Principal | Role | On |
|---|---|---|
| pipeline SA | `roles/bigquery.jobUser` | project |
| pipeline SA | `roles/bigquery.dataEditor` | dataset `workato_facts` |
| pipeline SA | `roles/storage.objectAdmin` | bucket |
| pipeline SA | `roles/secretmanager.secretAccessor` | secret `workato-api-token` |
| pipeline SA | `roles/run.invoker` | the nightly job (for Scheduler trigger) |
| docs-site service SA | `roles/storage.objectViewer` | bucket |
| team Google group | `roles/iap.httpsResourceAccessor` | docs service (Phase 4) |

`.env.example` (local runs only; the deployed job uses Secret Manager):

```
WORKATO_API_BASE=https://www.workato.com
WORKATO_API_TOKEN=
GOOGLE_CLOUD_PROJECT=
BQ_DATASET=workato_facts
SITE_BUCKET=
```

**Checkpoint 0:** `bq ls` works, secret exists, empty repo committed.

---

# Phase 1 — The contract (½ day, mostly thinking)

Two rules, written down before any code:

1. **Three core tables, snapshot-partitioned.** Every nightly run appends a full snapshot keyed by `snapshot_date`. History is free; diffs are set arithmetic.
2. **Renderers read views only.** Ingestion may be refactored at will behind them. The views *are* the interface — treat changing a view's shape with the same ceremony as changing a public API.

## 1.1 Tables — `sql/001_tables.sql`

```sql
CREATE SCHEMA IF NOT EXISTS `PROJECT.workato_facts`;

CREATE TABLE IF NOT EXISTS `PROJECT.workato_facts.recipes` (
  snapshot_date DATE NOT NULL,
  recipe_id     INT64 NOT NULL,
  name          STRING,
  folder_id     INT64,
  folder_path   STRING,
  running       BOOL,
  fingerprint   STRING,       -- sha256 of canonicalized code
  code          JSON          -- full recipe definition
) PARTITION BY snapshot_date;

CREATE TABLE IF NOT EXISTS `PROJECT.workato_facts.steps` (
  snapshot_date DATE NOT NULL,
  recipe_id     INT64 NOT NULL,
  step_path     STRING,       -- "0", "0.1", "0.1.2" — position in the tree
  keyword       STRING,       -- trigger / action / if / foreach / catch ...
  provider      STRING,
  action        STRING,
  input         JSON
) PARTITION BY snapshot_date;

CREATE TABLE IF NOT EXISTS `PROJECT.workato_facts.edges` (
  snapshot_date      DATE NOT NULL,
  src_recipe_id      INT64 NOT NULL,
  edge_type          STRING,   -- calls_recipe / reads_lookup_table / http_call / ...
  dst_kind           STRING,   -- recipe / lookup_table / endpoint / external
  dst_id             STRING,
  dst_name           STRING,
  evidence_step_path STRING    -- provenance: the step that creates this edge
) PARTITION BY snapshot_date;

-- Phase 5 uses this; create it now so the contract is complete
CREATE TABLE IF NOT EXISTS `PROJECT.workato_facts.doc_state` (
  recipe_id    INT64 NOT NULL,
  fingerprint  STRING,
  generated_at TIMESTAMP
);
```

`evidence_step_path` is the precision guarantee in one column: every edge — therefore every arrow in every diagram — points back at the exact step that justifies it.

## 1.2 Views — `sql/002_views.sql`

```sql
CREATE OR REPLACE VIEW `PROJECT.workato_facts.v_recipes_latest` AS
SELECT * FROM `PROJECT.workato_facts.recipes`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `PROJECT.workato_facts.recipes`);

CREATE OR REPLACE VIEW `PROJECT.workato_facts.v_steps_latest` AS
SELECT * FROM `PROJECT.workato_facts.steps`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `PROJECT.workato_facts.steps`);

CREATE OR REPLACE VIEW `PROJECT.workato_facts.v_edges_latest` AS
SELECT * FROM `PROJECT.workato_facts.edges`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `PROJECT.workato_facts.edges`);

CREATE OR REPLACE VIEW `PROJECT.workato_facts.v_graph_latest` AS
SELECT e.*, r.name AS src_name, r.folder_path AS src_folder
FROM `PROJECT.workato_facts.v_edges_latest` e
JOIN `PROJECT.workato_facts.v_recipes_latest` r
  ON r.recipe_id = e.src_recipe_id;

-- Change feed: compares the two most recent snapshots
CREATE OR REPLACE VIEW `PROJECT.workato_facts.v_edge_changes` AS
WITH d AS (
  SELECT ARRAY_AGG(DISTINCT snapshot_date ORDER BY snapshot_date DESC LIMIT 2) AS s
  FROM `PROJECT.workato_facts.edges`
),
cur AS (SELECT src_recipe_id, edge_type, dst_kind, dst_id
        FROM `PROJECT.workato_facts.edges`, d WHERE snapshot_date = d.s[OFFSET(0)]),
prv AS (SELECT src_recipe_id, edge_type, dst_kind, dst_id
        FROM `PROJECT.workato_facts.edges`, d WHERE snapshot_date = d.s[SAFE_OFFSET(1)])
SELECT 'added' AS change, * FROM (SELECT * FROM cur EXCEPT DISTINCT SELECT * FROM prv)
UNION ALL
SELECT 'removed' AS change, * FROM (SELECT * FROM prv EXCEPT DISTINCT SELECT * FROM cur);

CREATE OR REPLACE VIEW `PROJECT.workato_facts.v_recipe_changes` AS
WITH d AS (
  SELECT ARRAY_AGG(DISTINCT snapshot_date ORDER BY snapshot_date DESC LIMIT 2) AS s
  FROM `PROJECT.workato_facts.recipes`
),
cur AS (SELECT recipe_id, name, fingerprint
        FROM `PROJECT.workato_facts.recipes`, d WHERE snapshot_date = d.s[OFFSET(0)]),
prv AS (SELECT recipe_id, name, fingerprint
        FROM `PROJECT.workato_facts.recipes`, d WHERE snapshot_date = d.s[SAFE_OFFSET(1)])
SELECT
  COALESCE(c.recipe_id, p.recipe_id) AS recipe_id,
  COALESCE(c.name, p.name)           AS name,
  CASE WHEN p.recipe_id IS NULL THEN 'added'
       WHEN c.recipe_id IS NULL THEN 'removed'
       WHEN c.fingerprint != p.fingerprint THEN 'modified'
  END AS change
FROM cur c FULL OUTER JOIN prv p ON c.recipe_id = p.recipe_id
WHERE (p.recipe_id IS NULL OR c.recipe_id IS NULL OR c.fingerprint != p.fingerprint);
```

Run both files with `PROJECT` substituted:

```bash
sed "s/PROJECT/${PROJECT}/g" sql/001_tables.sql | bq query --use_legacy_sql=false
sed "s/PROJECT/${PROJECT}/g" sql/002_views.sql  | bq query --use_legacy_sql=false
```

## 1.3 The edge taxonomy — a decision you make empirically

The intellectual core of the whole system is *what counts as a dependency*. Don't guess provider keywords — extract everything generically first (Phase 2), then run a census over your real estate:

```sql
SELECT provider, action, keyword, COUNT(*) AS n
FROM `PROJECT.workato_facts.v_steps_latest`
GROUP BY 1, 2, 3
ORDER BY n DESC;
```

That output is the vocabulary of your platform. From it you'll name the edge types that matter — callable-recipe calls, lookup-table reads, endpoint invocations, custom-connector actions, GAS web-app calls — and encode each as a rule in `edges.py`. The v0 extractor below already catches most of them by scanning for reference keys, so the census refines rather than bootstraps.

**Checkpoint 1:** tables and views exist (`bq ls workato_facts`), taxonomy census query saved for after first ingest.

---

# Phase 2 — Ingestion (1–2 days)

## 2.1 API client — `src/pipeline/workato.py`

```python
import os
import requests

BASE = os.environ.get("WORKATO_API_BASE", "https://www.workato.com")
_session = requests.Session()
_session.headers["Authorization"] = f"Bearer {os.environ['WORKATO_API_TOKEN']}"


def _paged(path: str, params: dict | None = None):
    page = 1
    while True:
        p = dict(params or {}, page=page, per_page=100)
        r = _session.get(f"{BASE}{path}", params=p, timeout=60)
        r.raise_for_status()
        items = r.json()
        if isinstance(items, dict):                     # some endpoints wrap results
            items = items.get("items") or items.get("result") or []
        if not items:
            return
        yield from items
        page += 1


def recipes():
    """All recipes, guaranteeing each has `code` (falls back to per-recipe GET)."""
    for r in _paged("/api/recipes"):
        if not r.get("code"):
            detail = _session.get(f"{BASE}/api/recipes/{r['id']}", timeout=60)
            detail.raise_for_status()
            r = detail.json()
        yield r


def folders():
    return list(_paged("/api/folders"))
```

## 2.2 Parse — `src/pipeline/parse.py`

```python
import hashlib
import json


def fingerprint(code_str: str) -> str:
    """Stable hash of the recipe definition, insensitive to key ordering."""
    canon = json.dumps(json.loads(code_str), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def walk_steps(code: dict):
    """Yield (step_path, step) for the trigger and every nested step.

    Recipe code JSON is a tree: the root is the trigger; container steps
    (if / foreach / catch / ...) nest children under `block`. The walk is
    defensive — unknown fields are ignored, missing ones tolerated.
    """
    def rec(step, path):
        yield path, step
        for i, child in enumerate(step.get("block") or [], start=1):
            if isinstance(child, dict):
                yield from rec(child, f"{path}.{i}")
    if isinstance(code, dict):
        yield from rec(code, "0")


def folder_paths(folder_list: list[dict]) -> dict[int, str]:
    by_id = {f["id"]: f for f in folder_list}

    def path_of(fid):
        parts = []
        while fid and fid in by_id:
            f = by_id[fid]
            parts.append(f.get("name", str(fid)))
            fid = f.get("parent_id")
        return "/".join(reversed(parts))

    return {fid: path_of(fid) for fid in by_id}
```

## 2.3 Edge extraction v0 — `src/pipeline/edges.py`

The v0 extractor doesn't need to know provider keywords at all: it scans every step's `input` for *reference keys* — the fields Workato uses to point at other objects — plus literal URLs. This finds callable-recipe calls and lookup-table reads on day one, regardless of how the provider strings turn out. The census (§1.3) then tells you which provider-specific rules to add.

```python
# Reference keys → (edge_type, dst_kind). Extend after the census.
REF_KEYS = {
    "recipe_id":       ("calls_recipe", "recipe"),
    "lookup_table_id": ("reads_lookup_table", "lookup_table"),
}


def _scan(obj, hits):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in REF_KEYS and v not in (None, "", []):
                hits.append((k, str(v)))
            _scan(v, hits)
    elif isinstance(obj, list):
        for v in obj:
            _scan(v, hits)
    elif isinstance(obj, str) and obj.startswith(("http://", "https://")):
        hits.append(("url", obj))


def edges_for_step(recipe_id: int, step_path: str, step: dict):
    hits = []
    _scan(step.get("input") or {}, hits)
    for key, value in hits:
        if key in REF_KEYS:
            edge_type, dst_kind = REF_KEYS[key]
            yield dict(src_recipe_id=recipe_id, edge_type=edge_type,
                       dst_kind=dst_kind, dst_id=value, dst_name=None,
                       evidence_step_path=step_path)
        elif key == "url":
            yield dict(src_recipe_id=recipe_id, edge_type="http_call",
                       dst_kind="endpoint", dst_id=value, dst_name=value,
                       evidence_step_path=step_path)

    # --- Census-derived rules land here. Example shape:
    # if step.get("provider") == "<your_custom_connector>":
    #     yield dict(src_recipe_id=recipe_id, edge_type="connector_action",
    #                dst_kind="external", dst_id=step.get("name"),
    #                dst_name=step.get("name"), evidence_step_path=step_path)
```

Self-referencing `dst_id`s (recipe edges point at recipe ids) get their `dst_name` resolved at render time by joining back to `v_recipes_latest` — names live in one place.

## 2.4 Load — `src/pipeline/load.py`

```python
import os
from google.cloud import bigquery

DATASET = os.environ.get("BQ_DATASET", "workato_facts")
_client = bigquery.Client()


def replace_partition(table: str, snapshot_date: str, rows: list[dict]):
    """Idempotent per-day load: delete today's partition, then append."""
    table_id = f"{_client.project}.{DATASET}.{table}"
    _client.query(
        f"DELETE FROM `{table_id}` WHERE snapshot_date = @d",
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("d", "DATE", snapshot_date)]),
    ).result()
    if rows:
        job = _client.load_table_from_json(
            rows, table_id,
            job_config=bigquery.LoadJobConfig(
                write_disposition="WRITE_APPEND"),
        )
        job.result()
```

(If your client-library version is fussy about `JSON`-typed columns receiving dicts, change `code`/`input` to `STRING` in the DDL and `json.dumps` them here — nothing downstream cares.)

## 2.5 Orchestrator (ingest half) — `src/pipeline/run.py`

```python
import datetime
import json

from . import workato, parse, edges, load


def ingest() -> str:
    snapshot = datetime.date.today().isoformat()
    fpaths = parse.folder_paths(workato.folders())

    recipe_rows, step_rows, edge_rows = [], [], []
    for r in workato.recipes():
        code_str = r["code"] if isinstance(r["code"], str) else json.dumps(r["code"])
        code = json.loads(code_str)
        recipe_rows.append(dict(
            snapshot_date=snapshot, recipe_id=r["id"], name=r.get("name"),
            folder_id=r.get("folder_id"),
            folder_path=fpaths.get(r.get("folder_id"), ""),
            running=bool(r.get("running")),
            fingerprint=parse.fingerprint(code_str), code=code,
        ))
        for step_path, step in parse.walk_steps(code):
            step_rows.append(dict(
                snapshot_date=snapshot, recipe_id=r["id"], step_path=step_path,
                keyword=step.get("keyword"), provider=step.get("provider"),
                action=step.get("name"), input=step.get("input") or {},
            ))
            for e in edges.edges_for_step(r["id"], step_path, step):
                edge_rows.append(dict(snapshot_date=snapshot, **e))

    load.replace_partition("recipes", snapshot, recipe_rows)
    load.replace_partition("steps", snapshot, step_rows)
    load.replace_partition("edges", snapshot, edge_rows)
    print(f"snapshot {snapshot}: {len(recipe_rows)} recipes, "
          f"{len(step_rows)} steps, {len(edge_rows)} edges")
    return snapshot


if __name__ == "__main__":
    ingest()
```

## 2.6 First run and the census

```bash
set -a; source .env; set +a          # local only
python -m src.pipeline.run
```

**Checkpoint 2:**

```sql
SELECT COUNT(*) FROM `PROJECT.workato_facts.v_recipes_latest`;   -- ≈ your estate size
SELECT * FROM `PROJECT.workato_facts.v_edges_latest` LIMIT 20;   -- edges with evidence paths
```

Then run the census from §1.3, read the provider/action vocabulary of your actual estate, and add the two or three provider-specific rules that matter (custom connector actions, GAS web-app calls if their URLs need classifying beyond `http_call`, API-platform invocations). Re-run ingest; same day's partition is replaced cleanly.

**This is the moment the fact store exists.** Everything after this phase is small scripts and queries.

---

# Phase 3 — Render: views → Mermaid → site (1 day)

## 3.1 Renderer — `src/pipeline/render.py`

Reads **views only**. Emits one map per workstream (grouped by recipe-name prefix: `PRV-`, `INV-`, `VAL-`, …), a fleet overview, a generated index, and the change page.

```python
import os
import re
from collections import defaultdict
from pathlib import Path

from google.cloud import bigquery

DATASET = os.environ.get("BQ_DATASET", "workato_facts")
_client = bigquery.Client()
DOCS = Path("build/docs")


def _q(sql: str):
    sql = sql.replace("DS", f"{_client.project}.{DATASET}")
    return [dict(row) for row in _client.query(sql).result()]


def _ws(name: str) -> str:
    m = re.match(r"([A-Z]{2,4})-", name or "")
    return m.group(1) if m else "OTHER"


def _nid(kind: str, ident) -> str:
    return f"{kind}_{re.sub(r'[^A-Za-z0-9]', '_', str(ident))[:40]}"


def _label(s: str, n: int = 48) -> str:
    s = (s or "").replace('"', "'")
    return s if len(s) <= n else s[: n - 1] + "…"


def _mermaid(edge_rows, names) -> str:
    lines, seen = ["graph LR"], set()

    def node(kind, ident, label):
        nid = _nid(kind, ident)
        if nid not in seen:
            seen.add(nid)
            shapes = {
                "recipe":       f'{nid}["{_label(label)}"]',
                "lookup_table": f'{nid}[("{_label(label)}")]',      # cylinder
                "endpoint":     f'{nid}{{{{"{_label(label)}"}}}}',  # hexagon
            }
            lines.append("  " + shapes.get(kind, f'{nid}["{_label(label)}"]'))
        return nid

    for e in edge_rows:
        s = node("recipe", e["src_recipe_id"], e["src_name"])
        dst_label = e["dst_name"] or e["dst_id"]
        if e["dst_kind"] == "recipe" and str(e["dst_id"]).isdigit():
            dst_label = names.get(int(e["dst_id"]), dst_label)
        d = node(e["dst_kind"], e["dst_id"], dst_label)
        lines.append(f'  {s} -->|{e["edge_type"]}| {d}')
    return "\n".join(lines)


def _write_map(slug, title, rows, names):
    md = f"# {title}\n\n```mermaid\n{_mermaid(rows, names)}\n```\n"
    (DOCS / "maps" / f"{slug}.md").write_text(md)


def _write_index(recipes, workstreams):
    lines = [
        "# Generated documentation",
        "",
        "Regenerated nightly from the live workspace. Every arrow in every map",
        "traces to a specific recipe step (`evidence_step_path` in the fact store).",
        "",
        "## Maps",
        "",
        "- [Fleet overview](maps/fleet.md)",
        *[f"- [{ws} workstream](maps/{ws.lower()}.md)" for ws in workstreams],
        "",
        "## Recipe inventory",
        "",
        "| Recipe | Folder | Running |",
        "|---|---|---|",
        *[f"| {r['name']} | {r['folder_path']} | {'yes' if r['running'] else 'no'} |"
          for r in recipes],
    ]
    (DOCS / "generated-index.md").write_text("\n".join(lines) + "\n")


def _write_changes():
    rec = _q("SELECT * FROM `DS.v_recipe_changes` ORDER BY change, name")
    edg = _q("SELECT * FROM `DS.v_edge_changes` ORDER BY change")
    lines = ["# What changed", "", "Comparison of the two most recent snapshots.", ""]
    if not rec and not edg:
        lines.append("_No changes detected (or only one snapshot exists so far)._")
    if rec:
        lines += ["## Recipes", "", "| Change | Recipe |", "|---|---|",
                  *[f"| {r['change']} | {r['name']} |" for r in rec], ""]
    if edg:
        lines += ["## Dependencies", "",
                  "| Change | Source recipe | Type | Target |", "|---|---|---|---|",
                  *[f"| {e['change']} | {e['src_recipe_id']} | {e['edge_type']} "
                    f"| {e['dst_kind']}: {e['dst_id']} |" for e in edg]]
    (DOCS / "changes.md").write_text("\n".join(lines) + "\n")


def render():
    (DOCS / "maps").mkdir(parents=True, exist_ok=True)
    recipes = _q("SELECT recipe_id, name, folder_path, running "
                 "FROM `DS.v_recipes_latest` ORDER BY name")
    names = {r["recipe_id"]: r["name"] for r in recipes}
    graph = _q("SELECT * FROM `DS.v_graph_latest`")

    _write_map("fleet", "Fleet overview", graph, names)

    by_ws = defaultdict(list)
    for e in graph:
        by_ws[_ws(e["src_name"])].append(e)
    for ws, rows in sorted(by_ws.items()):
        _write_map(ws.lower(), f"{ws} workstream", rows, names)

    _write_index(recipes, sorted(by_ws))
    _write_changes()
```

## 3.2 Site config — `mkdocs.yml` (repo root)

Material's built-in Mermaid support via `superfences` — no extra plugin.

```yaml
site_name: SDC Platform Documentation
docs_dir: build/docs
site_dir: build/site
theme:
  name: material
  features:
    - navigation.sections
markdown_extensions:
  - admonition
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
```

`docs_static/index.md` (hand-written home page — a paragraph on what SDC is and links to `generated-index.md`, `changes.md`, and `decisions/`).

## 3.3 Assemble + build — final `src/pipeline/run.py` main

Replace the `__main__` block from Phase 2 with the full orchestration:

```python
import shutil
import subprocess
import sys

from . import publish  # add alongside the existing imports


def build_site():
    shutil.rmtree("build", ignore_errors=True)
    shutil.copytree("docs_static", "build/docs")   # why-layer first
    render_module.render()                          # generated pages beside it
    subprocess.run(["mkdocs", "build"], check=True)


if __name__ == "__main__":
    steps = sys.argv[1:] or ["ingest", "site", "publish"]
    if "ingest" in steps:
        ingest()
    if "site" in steps:
        build_site()
    if "publish" in steps:
        publish.upload_site()
```

(Import `render` as `render_module` — or just `from . import render as render_module` — to avoid shadowing.)

**Checkpoint 3 (local):**

```bash
python -m src.pipeline.run ingest site
mkdocs serve        # http://localhost:8000
```

You should see: home page, fleet map, one map per workstream with labeled arrows, recipe inventory. This is the first artifact the team can see — worth a screenshot to the group chat.

---

# Phase 4 — Publish + automate (1 day)

## 4.1 Site upload — `src/pipeline/publish.py`

```python
import os
from pathlib import Path

from google.cloud import storage


def upload_site(local: str = "build/site"):
    bucket = storage.Client().bucket(os.environ["SITE_BUCKET"])
    root = Path(local)
    for p in root.rglob("*"):
        if p.is_file():
            bucket.blob(p.relative_to(root).as_posix()).upload_from_filename(str(p))
    print("site uploaded")
```

(Overwrite-in-place: pages for deleted recipes can linger in the bucket until you care; at team scale that's a periodic manual sweep, not a feature.)

## 4.2 Docs server — `infra/site/`

`nginx.conf`:

```nginx
server {
  listen 8080;
  root /site;
  index index.html;
  location / { try_files $uri $uri/ =404; }
}
```

`Dockerfile`:

```dockerfile
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

Deploy with the bucket mounted as a read-only volume — **the nightly "deploy" of new docs is just the file upload in 4.1; this service never redeploys**:

```bash
gcloud run deploy sdc-docs \
  --source infra/site --region $REGION \
  --no-allow-unauthenticated \
  --add-volume name=site,type=cloud-storage,bucket=$BUCKET,readonly=true \
  --add-volume-mount volume=site,mount-path=/site \
  --iap
```

Attach IAP exactly as you did for the Chainlit service if the `--iap` flag isn't available in your gcloud version, then grant the team:

```bash
gcloud beta iap web add-iam-policy-binding \
  --member="group:<team-group>@<domain>" \
  --role="roles/iap.httpsResourceAccessor" \
  --resource-type=cloud-run --service=sdc-docs --region=$REGION
```

## 4.3 The nightly job — `Dockerfile` (repo root)

The why-layer ships inside the image — editing an ADR means `gcloud run jobs deploy` again. (When GitLab lands, CI takes this over; until then the redeploy *is* the publish step for hand-written pages.)

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY mkdocs.yml .
COPY src ./src
COPY docs_static ./docs_static
ENTRYPOINT ["python", "-m", "src.pipeline.run"]
```

```bash
gcloud run jobs deploy sdc-docs-nightly \
  --source . --region $REGION \
  --service-account $SA \
  --set-secrets WORKATO_API_TOKEN=workato-api-token:latest \
  --set-env-vars BQ_DATASET=$DATASET,SITE_BUCKET=$BUCKET,WORKATO_API_BASE=https://www.workato.com \
  --max-retries 1 --task-timeout 15m

gcloud run jobs execute sdc-docs-nightly --region $REGION   # first supervised run
```

## 4.4 Schedule

```bash
gcloud scheduler jobs create http sdc-docs-nightly-trigger \
  --location $REGION \
  --schedule "0 5 * * *" --time-zone "America/New_York" \
  --uri "https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/sdc-docs-nightly:run" \
  --http-method POST \
  --oauth-service-account-email $SA
```

Failure visibility: a log-based alert on Cloud Run job execution failures (or, minimally, a weekly glance at `gcloud run jobs executions list`).

**Checkpoint 4:** open the service URL in a browser — IAP challenge, then the site. The change page says "only one snapshot" today and **populates by itself tomorrow**. To see it work on demand: make one trivial recipe edit in Workato, `gcloud run jobs execute`, refresh — the edit appears on the change page and, if it touched a dependency, in the maps. This closes the exact gap that started the project: stakeholder changes now announce themselves.

---

# Phase 5 — Per-recipe prose with evidence citations (2–3 days, after 0–4 are stable)

This is the corpus agent's judgment loop run in **batch** instead of interactively, fingerprint-gated so only changed recipes regenerate. Design level here — the Gemini plumbing is your existing GeminiLib/Vertex code.

## 5.1 What to generate

One page per recipe: **Purpose · Trigger · Inputs & outputs · Calls / called by · Failure paths · Evidence**. The contract that makes it *precise* rather than plausible:

- The model receives only facts from the views: the recipe row, its flattened steps, its inbound and outbound edges.
- Every claim must cite a `step_path` inline — `(step 0.3.2)` — and the prompt states: *only assert what the provided facts support; if the facts don't establish something, say so rather than inferring.*
- Low temperature; spot-review the first full batch by hand before trusting the gate.

## 5.2 The gate

Candidates = recipes whose fingerprint moved:

```sql
SELECT r.recipe_id, r.name, r.fingerprint
FROM `PROJECT.workato_facts.v_recipes_latest` r
LEFT JOIN `PROJECT.workato_facts.doc_state` s USING (recipe_id)
WHERE s.fingerprint IS NULL OR s.fingerprint != r.fingerprint;
```

Flow, inserted into the nightly run between `ingest` and `build_site`:

1. Pull generated-page cache from `gs://$BUCKET-pages/recipes/` into `build/docs/recipes/` (unchanged recipes keep last night's page — zero cost, zero churn).
2. For each candidate: gather facts → generate → overwrite `recipes/<id>.md` locally and in the cache prefix.
3. `MERGE` the new fingerprints into `doc_state`.
4. `build_site()` picks the pages up like any other Markdown.

First run generates ~58 pages; a typical night after that generates 0–3. That's the entire cost-control story.

---

# Phase 6 — Enrichment: the system's edges (as needed, in any order)

**Endpoint catalog (OpenAPI).** Each API collection page in Workato has a *Download OpenAPI spec* link — the specs are auto-generated, so harvest rather than build. Drop them into `docs_static/apis/` and render with the `mkdocs-swagger-ui-tag` plugin (or start with plain links to the specs). If the Developer API exposes collection specs programmatically in your tenant, move the harvest into the nightly job; a manual quarterly download is a perfectly honest v1.

**State-machine diagram.** A small parser over the custom connector's Ruby source extracts the `finalize_verdict` verdict→trigger_context mapping (and `STATUS_TO_WFA_STAGE` from wherever it lives) and emits a Mermaid `stateDiagram-v2` page. Different source artifact, different parser — which is why it's here and not in Phase 2. The payoff is the same provenance property: the state diagram is parsed from the artifact that *defines* the state machine, so it cannot disagree with production.

**Payload shapes.** Normalize step input/output contracts to JSON Schema in the fact store when you want data-shape docs — the one part of the OpenAPI world that generalizes beyond HTTP.

**Deploy ordering.** When CI/CD sequencing needs a topological sort over `v_edges_latest`: `graphlib.TopologicalSorter` — the thirty lines turned out to already be in Python's standard library.

---

# Phase 7 — The why-layer (starts today, in parallel with everything)

Hand-written ADR-style pages in `docs_static/decisions/`, version-controlled, merged into the site at build. This is the layer no parser can recover and the one that most deserves review when GitLab arrives.

`ADR-000-template.md`:

```markdown
# ADR-NNN: <decision, stated as a decision>

Date: YYYY-MM-DD · Status: accepted

## Context
What was true of the world that forced a choice.

## Decision
What was chosen, in one or two sentences.

## Consequences
What this makes easier, what it makes harder, what would trigger revisiting it.
```

Seed list (each is a decision the platform already made — writing them down is recovery, not invention):

1. **ADR-001** — Renderers read views only; views are the fact store's public interface. *(This project's own first decision — the why-layer documents itself.)*
2. **ADR-002** — Cascade scoped-value `~<scope>` suffix convention: value uniqueness + cascade join key; composite-cascade redesign considered and not implemented.
3. **ADR-003** — One WFA app per workspace; client isolation via row-level scoping; provisioning hydrates data, not infrastructure.
4. **ADR-004** — Workato Python file-handling invariant: binary datapill arrives as bytes; normalize, branch on magic number, never unconditionally base64-decode.
5. **ADR-005** — Ruby `is_a?` unreliability on connector response objects and the pattern that replaces it.
6. **ADR-006** — Hash-rocket serialization at the connector boundary.
7. **ADR-007** — GAS instanceof-across-library-boundary failure; `Object.prototype.toString.call()` as the type check.
8. **ADR-008** — Dependent-dropdown INDIRECT pattern in template generation.

Three of these written = the why-layer exists. All eight = the documentation backlog is cleared.

---

# Definition of done

- [ ] Nightly job runs unattended; a failed execution is visible without going looking.
- [ ] Fleet map + per-workstream maps render; **every** edge carries an `evidence_step_path`.
- [ ] Change page reflects a real recipe edit within one cycle (verified once by hand).
- [ ] Site reachable by the team group through IAP with Google accounts; by nobody else.
- [ ] Census-derived edge rules cover the estate's actual provider vocabulary (no meaningful dependency class missing from the maps).
- [ ] At least three ADRs published; index links generated pages, change feed, and decisions.
- [ ] Local git history from day one; pipeline code and why-layer committed; ready for `git remote add` when GitLab lands.
- [ ] *(Phase 5, when enabled)* per-recipe pages cite step paths; unchanged recipes don't regenerate.

# Where the effort actually goes

Phases 0, 3, and 4 are mechanical — a day each of commands and small scripts. **Phases 1–2 are the build**: the edge taxonomy and the parser are the hard twenty percent, and they're also the part that doubles as the corpus agent's fact store, so the effort is spent once and consumed twice. Phase 5 is a repurposing of code you already have; Phases 6–7 are independent tracks that can absorb idle half-days indefinitely.

The system's steady state: you edit recipes; the docs notice. You make decisions; you write them down. Nothing else requires remembering to document anything — which is the property that was missing when this conversation started.
