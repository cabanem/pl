# SDC Recipe Model

A small pipeline that fetches Workato recipe JSON, normalizes it to one canonical
edge model, and derives every artifact (call graph, table-access matrix, status
writers, single-owner audit, …) from that single source — so the projections can
never disagree with each other.

**The one design rule:** fetching is the only impure stage. Everything downstream
is a pure function of a frozen snapshot, which is why the whole pipeline is
testable with the network off. The interactive `Workspace` keeps this rule by
being a *lazily-materialized* snapshot: every fetch happens at most once per
session, on first touch, and `refresh()` is the only way to re-capture.

---

## Layout

```
sdc-recipe-model/
│
├── sdc_recipe_model.contract.yaml   # authoritative one-page contract: relations,
│                                    #   identity model, provenance, projection catalog
├── sdc_recipe_model.py              # typed realization of the contract — the spine
│                                    #   everything imports (enums, Edge, Target, registries)
│
│   ── stage 1: fetch (the only impure boundary) ──
├── workato_client.py                # config + host derivation + retry + list/detail/
│                                    #   tables/folder_assets/folders; transport injected
│
│   ── stages 2–4: the transform (pure) ──
├── normalize.py                     # recipe code tree → ordered NormStep list (block[i]. paths)
├── extract.py                       # NormStep list → typed Edges (corpus-confirmed vocabulary)
├── resolve.py                       # bind edge targets to the registries (labels attached)
│
│   ── resolution + analysis ──
├── registries.py                    # folder_assets → RecipeRegistry (+ <DOM>-NN handles),
│                                    #   data_tables list (inline schemas) → TableSchemaRegistry
├── projections.py                   # read-only views over resolved edges: call graph, table
│                                    #   access, status writers, column_writers bridge,
│                                    #   single_owner_audit
├── inspect_corpus.py                # the inspectors — settle vocabulary questions against
│                                    #   a real corpus (providers / keywords / input keys)
│
│   ── the interactive surface ──
├── workspace.py                     # Workspace: one object per session; every question the
│                                    #   heredocs used to answer is a method call (see §3)
│
│   ── whole-corpus runs ──
├── corpus_pass.py                   # spine over every production recipe + the full report
│                                    #   (coverage, unhandled worklist, drift, audit)
├── run.py                           # one command: offline preflight → live corpus pass →
│                                    #   freeze the resolved edge set to out/edges.json
├── dump_recipes.py                  # capture recipe code trees to ./recipes/, one file per
│                                    #   recipe — fixture-compatible, git-diffable snapshots
│
│   ── validation harnesses ──
├── slice_run.py                     # STS-01 vertical slice against the fixture + the shared
│                                    #   ORACLE answer key (single source, imported everywhere)
├── real_oracle.py                   # one-command live oracle: capture real STS-01 → spine →
│                                    #   diff against the spec facts
├── fetch_selftest.py                # offline stage-1 proof against canned responses (also
│                                    #   exports make_fake_transport for other offline tests)
├── workspace_selftest.py            # offline proof of the Workspace facade, including
│                                    #   transport-call counting for the snapshot guarantee
├── live_smoke.py                    # staged, GET-only verification against a real workspace
│
└── fixtures/
    └── sts_01.recipe.fixture.json   # hand-reconstructed STS-01 (the live capture is ground truth)
```

`__pycache__/` and `out/` (written by `run.py`) are generated — safe to delete. A
two-line `.gitignore` (`__pycache__/`, `out/`) keeps them out of version control.
`recipes/` (written by `dump_recipes.py`) is the opposite: a deterministic,
diffable capture of the corpus, meant to be committed.

---

## How it flows

```
fetch ──▶ normalize ──▶ extract ──▶ resolve ──▶ project
(impure)   (pure)        (pure)      (pure)      (pure)
```

`sdc_recipe_model.py` sits at the bottom; everything depends on it. `normalize`,
`inspect_corpus`, and `workato_client` are otherwise standalone; `extract` pulls
in the model and `normalize`; `resolve` and `projections` are the graduated
stage-4/5 modules. Two surfaces sit on top of the same spine: the **scripts**
(`slice_run`, `real_oracle`, `corpus_pass`, `run`) for one-command answers, and
the **`Workspace`** for interactive sessions. The workspace adds no analysis
logic of its own — it only sequences the same pure functions the scripts call —
so the two surfaces cannot disagree.

---

## Setup

Python 3.9+. **No dependencies to install** — the client's default transport is
the standard-library `urllib`.

Environment variables (only needed for the live steps; a `.env` file next to the
modules is read automatically, real exports win):

```bash
export WORKATO_API_TOKEN="…"                          # required
export WORKATO_BASE_URL="https://app.eu.workato.com"  # only if NOT on the EU data center
export SDC_FOLDER_ID="…"                               # the project / top-level folder

# optional — production scoping for corpus_pass / run.py / ws.production_recipes():
export SDC_RECIPES_FOLDER_NAME="Recipes"               # subfolder holding production recipes
export SDC_RECIPES_FOLDER_ID="…"                       # fast-path override; skips the name lookup
```

Everything in the pipeline is GET-only (list, detail, folder_assets, folders,
table list). There is no write path, so nothing here can mutate a workspace.

---

## Run it

### 1. Offline checks — no credentials

Prove the whole stack with the network off. All three exit `0` on green.

```bash
python3 slice_run.py           # STS-01 spine → oracle diff against the fixture
python3 fetch_selftest.py      # stage-1 fetch/registry/inspector wiring vs canned responses
python3 workspace_selftest.py  # the Workspace facade: identity, oracle parity, drift,
                               #   vocabulary, audit — and the snapshot rule proven by
                               #   COUNTING transport calls, not by trusting the memoization
```

Run these after any change to the spine, the registries, or `workspace.py` —
they are the regression gate, and they're free.

### 2. Live verification — read-only, against your workspace

Staged smoke test: each gate confirms one shape assumption before the next, and it
halts at the first surprise. Reads as `PASS` (matched), `LOOK` (eyeball this), or
`STOP` (assumption broke).

```bash
python3 live_smoke.py
```

The gate that matters most is stage 3: it prints what `derive_handle` produces for
your real recipe names. If those don't come out as `STS-01` / `API-00` / etc., that
is the `LOOK` that sends you to `registries.derive_handle`.

### 3. Interactive sessions — the Workspace

This replaces the raw-python heredocs. One object per session; every question is
a method call; every fetch happens **at most once** and is answered from the same
captured state until you `refresh()`.

Start a REPL from the project root:

```python
>>> from workspace import Workspace
>>> ws = Workspace.connect()          # .env + WORKATO_* + SDC_FOLDER_ID, like the scripts
>>> ws                                # repr shows what's materialized; it never fetches
<Workspace folder 12345 | recipes not yet fetched | tables not yet fetched | 0 codes cached>
```

**What a session costs** (each price paid once, on first touch):

| first touch of…                       | API calls |
|---------------------------------------|-----------|
| any handle / `ws.recipes`             | 1 (folder_assets) |
| any table fact / `ws.tables`          | 1 (data_tables list; schemas are inline) |
| one recipe's code / facts / oracle    | 1 per recipe (detail) |
| `ws.vocabulary()` / `ws.samples()`    | N+1 (the whole corpus) — after this, `code()` for any recipe is free |
| `ws.production_recipes()`             | 1–2 (folders lookup + recipe list) |

Everything after the fetch is the same pure spine the scripts use. Re-asking any
question costs zero calls — `workspace_selftest.py` asserts this arithmetic.

**The oracle — is a recipe still on-spec?**

```python
>>> ws.oracle("STS-01")               # diffs regenerated facts vs the shared ORACLE
OracleResult(…)                       # truthy exactly when green:
>>> if ws.oracle("STS-01"): print("still on-spec")
>>> print(ws.oracle("STS-01"))        # the full real_oracle readout, drift included
```

Targets are handles or numeric flow_ids, interchangeably, everywhere:
`ws.oracle(84)` == `ws.oracle("STS-01")`. An unknown handle raises; a handle that
collides across recipes refuses and asks for the flow_id rather than guessing.

Any recipe, your own answer key:

```python
>>> r = ws.oracle("UPL-01", expected={
...     "reads":  {"SUP_SupplierRequest", "RUN_Upload"},
...     "writes": {"RUN_Upload"},
... })
>>> r.ok                              # bool
>>> r.diff                            # only the mismatched keys: {key: {missing, extra}}
>>> r.facts                           # the full regenerated facts, green or red
>>> r.drift                           # (recipe_label, live_name, field_id) disagreements
```

**Reading a recipe — the spine, piecewise:**

```python
>>> ws.facts("STS-01")                # {reads, writes, status_columns, calls}
>>> ws.edges("STS-01")                # the raw resolved Edge list — project it yourself
>>> ws.steps("STS-01")                # the NormStep list (framing, providers, inputs)
>>> ws.code("STS-01")                 # the parsed code tree (fetched once, memoized)
>>> ws.drift("STS-01")                # recipe label ≠ live column name, per field_id
```

**The vocabulary — what does the corpus actually say?**

```python
>>> v = ws.vocabulary()               # fetches the corpus once (N+1), then memoized
>>> print(v)                          # providers / keywords / data-table input keys
>>> v.providers; v.keywords; v.usage; v.table_keys      # the same, as data
>>> ws.samples("workato_db_table", limit=5)             # eyeball raw step payloads
```

Reconcile `v` against `extract.py` whenever a new step type appears:
**`PY_PROVIDERS`** (the Python provider string), the **call encoding**
(`workato_recipe_function::call_recipe`), and **`TABLE_KEYS`** + the
`writes_column` record key (the data-table action's input keys confirm both).

**The invariants — corpus-level questions:**

```python
>>> ws.production_recipes()           # (flow_id, handle) per the SDC_RECIPES_FOLDER_* scope
>>> edges = ws.all_edges()            # resolved edges across the production set (memoized)
>>> ws.audit()                        # single-owner audit: who writes the guarded status
...                                   #   columns, by path (table-api vs WFA); defaults to
...                                   #   owner="STS-01" and the ORACLE's status_columns
>>> ws.audit(owner="STS-01", guarded={"status"}, edges=edges)   # any subset, no refetch
```

**Dump the corpus to disk — the snapshot as files:**

```python
>>> ws.dump()                         # the production set -> ./recipes/, one file each
>>> ws.dump(dest="snapshots/2026-07-08")             # dated capture
>>> ws.dump(targets=["STS-01", "UPL-01", 84])        # explicit handles / flow_ids
{'written': ['recipes/STS-01__84.recipe.json', …], 'errors': [], 'manifest': 'recipes/_manifest.json'}
```

Or as one command (env-driven, exits `0`/`1` like the other scripts):

```bash
python3 dump_recipes.py                     # the production set -> ./recipes/
python3 dump_recipes.py STS-01 UPL-01 84    # explicit targets
SDC_DUMP_DIR=snapshots/2026-07-08 python3 dump_recipes.py
```

Three properties worth knowing, all asserted by `workspace_selftest.py`:

- **Files are the fixture format.** Each file is the bare parsed code tree —
  `json.load(path)` feeds `normalize()` directly, or drops into `fixtures/`
  as-is. `json.load(file) == ws.code(flow_id)`, exactly; provenance (folder,
  timestamp, file → recipe map) lives in `_manifest.json`, not inside the
  artifacts.
- **Deterministic bytes.** Stable names (`{handle}__{flow_id}.recipe.json` —
  unique even when handles collide) and stable formatting, so re-dumping an
  unchanged corpus is a no-op and `git diff` between dumps shows real recipe
  drift only.
- **Costs nothing beyond the snapshot.** Recipes already fetched this session
  (or held by the corpus after `vocabulary()`) dump with **zero** API calls;
  cold recipes cost the usual one detail fetch each. Toward the API this is
  still GET-only — the only new impurity is the local write.

One bad recipe doesn't abort the dump; it lands in `errors` (and the manifest),
same keep-going rule as `corpus_pass`.

**After you edit a recipe or table** — the snapshot is deliberately stale until
you say otherwise, so a memoized code can't lie to the oracle:

```python
>>> ws.refresh()                      # drop the snapshot; next question re-captures
>>> print(ws.oracle("STS-01"))        # now judged against live state
```

**Recipes for future me:**

- *"I just changed STS-01 — did I break the spec?"* → `ws.refresh()`, then
  `print(ws.oracle("STS-01"))`. Green/RED plus exactly which fact moved.
- *"The oracle is RED — where do I look?"* → `r.diff` names the fact.
  `ws.facts(...)` and `ws.edges(...)` show what was regenerated;
  `ws.samples(provider)` shows the raw step if extraction looks wrong. If **all
  three** fact sets come back empty, `extract.py`'s vocabulary isn't reconciled
  to a new step type — run `ws.vocabulary()` and compare.
- *"Is the single-writer invariant still true?"* → `ws.audit()`. Non-owner
  writers are flagged for review, not asserted as bugs — a creation-time WFA
  write may be legitimate; you judge.
- *"I want tonight's corpus on disk / in git / to diff against last month"* →
  `python3 dump_recipes.py`, commit `recipes/`. Next dump, `git diff` shows
  exactly which recipes changed and how. Before a risky edit:
  `SDC_DUMP_DIR=snapshots/$(date +%F) python3 dump_recipes.py`.
- *"I want to test facade changes with no workspace at all"* → inject the fake:

  ```python
  from fetch_selftest import make_fake_transport, FOLDER_ID
  from workato_client import WorkatoClient, WorkatoConfig
  fake = WorkatoClient(config=WorkatoConfig.from_env({"WORKATO_API_TOKEN": "fake"}),
                       transport=make_fake_transport(), sleep=lambda _s: None)
  ws = Workspace.connect(folder_id=FOLDER_ID, client=fake)
  ```

### 4. The real oracle — one command

The packaged capture-and-diff, for scripts/CI rather than a REPL. Same answer key
(`slice_run.ORACLE`), same spine, accepts handle or flow_id:

```bash
PYTHONPATH=/path/to/sdc-recipe-model python3 real_oracle.py STS-01
```

Exits `0` on green, `1` on mismatch, and prints exactly which facts differ. In a
session, `print(ws.oracle("STS-01"))` is the same readout.

### 5. The whole corpus — report and frozen IR

```bash
python3 corpus_pass.py    # spine over every production recipe: coverage partition,
                          #   edges by relation, UNHANDLED worklist, unresolved calls,
                          #   column drift, single-owner audit, per-recipe table
python3 run.py            # the full ritual: offline preflight (slice_run +
                          #   fetch_selftest) → live corpus pass → freeze the resolved
                          #   edge set to out/edges.json (the IR downstream artifacts,
                          #   especially the spec regen, read from)
```

The `UNHANDLED (provider :: action)` ranking in the report is the worklist for
extending `extract.py`: each row is a step type the model doesn't edge yet.

---

## Status

- **Confirmed:** the spine and stage-1 wiring pass offline (`slice_run`,
  `fetch_selftest`, `workspace_selftest`); the extraction vocabulary is
  reconciled against the live corpus and baked into `extract.py`
  (`workato_db_table` + `table_id`/`parameters`, `py_eval`,
  `workato_recipe_function::call_recipe`, all five trigger surfaces).
- **The workspace is sequencing, not logic:** `workspace.py` calls the same pure
  functions the scripts do, so facade answers and script answers cannot diverge.
  Its snapshot guarantee (each fetch at most once) is asserted by transport-call
  counting in `workspace_selftest.py`, not assumed.
- **Reconstruction:** `fixtures/sts_01.recipe.fixture.json` remains the hand-built
  STS-01 for the offline harnesses; the live capture (`real_oracle.py` /
  `ws.code("STS-01")`) is ground truth.
- **Open:** trigger `auth` is left unspecified pending a trigger-input shape read
  (see the `extract.py` trigger branch); cross-project call targets resolve as
  `unresolved` by design — `corpus_pass` lists them for review.
