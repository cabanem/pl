# SDC Recipe Model

A small pipeline that fetches Workato recipe JSON, normalizes it to one canonical
edge model, and derives every artifact (call graph, table-access matrix, status
writers, …) from that single source — so the projections can never disagree with
each other.

**The one design rule:** fetching is the only impure stage. Everything downstream
is a pure function of a frozen snapshot, which is why the whole pipeline is
testable with the network off.

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
│                                    #   tables/schema/folder_assets; transport injected
│
│   ── stages 2–3: the transform (pure) ──
├── normalize.py                     # recipe code tree → ordered NormStep list (block[i]. paths)
├── extract.py                       # NormStep list → typed Edges (toolkit-confirmed keys)
│
│   ── resolution + analysis ──
├── registries.py                    # folder_assets → RecipeRegistry (+ <DOM>-NN handles),
│                                    #   data_tables + schema → TableSchemaRegistry
├── resolve.py                       # stage 4: bind edge targets to the registries (label, drift-aware)
├── projections.py                   # read-only views: call_graph, table_access_matrix, status_writers,
│                                    #   + the bridge (field_index, column_writers, stage_movers, single_owner_audit)
├── inspect_corpus.py                # the inspectors — settle the open vocabulary flags
│                                    #   against a real corpus
│
│   ── validation harnesses ──
├── slice_run.py                     # STS-01 vertical slice: spine → projections → oracle
│                                    #   diff (holds the shared ORACLE answer key)
├── corpus_pass.py                   # the full-corpus harness: spine over every production recipe →
│                                    #   coverage partition, edges-by-relation, single-owner audit
├── real_oracle.py                   # one-command live oracle: capture real STS-01 → spine →
│                                    #   diff the live recipe against the spec facts
├── fetch_selftest.py                # offline stage-1 proof against canned responses
├── live_smoke.py                    # staged, GET-only verification against a real workspace
│
└── fixtures/
    └── sts_01.recipe.fixture.json   # hand-reconstructed STS-01 (replaced by the real pull)
```

`__pycache__/` appears after any run — generated, safe to delete. A one-line
`.gitignore` (`__pycache__/`, `*.pyc`) keeps it out of version control.

---

## How it flows

```
fetch ──▶ normalize ──▶ extract ──▶ resolve ──▶ project
(impure)   (pure)        (pure)      (pure)      (pure)
```

`sdc_recipe_model.py` sits at the bottom; everything depends on it. `normalize`,
`inspect_corpus`, and `workato_client` are otherwise standalone; `extract` pulls
in the model and `normalize`; `resolve` and `projections` are their own modules
(stage 4 and 5); the harnesses (`slice_run`, `corpus_pass`, `real_oracle`) sit on
top and share them.

---

## Setup

Python 3.9+. **No dependencies to install** — the client's default transport is
the standard-library `urllib`.

Environment variables (only needed for the live steps):

```bash
export WORKATO_API_TOKEN="…"                          # required
export WORKATO_BASE_URL="https://app.eu.workato.com"  # only if NOT on the EU data center
export SDC_FOLDER_ID="…"                               # the folder to test against
```

Everything in stage 1 is GET-only (list, detail, folder_assets, table list, table
schema). There is no write path, so the live steps cannot mutate anything.

---

## Run it

### 1. Offline checks — no credentials

Prove the spine and the stage-1 wiring with the network off. Both exit `0` on green.

```bash
python3 slice_run.py        # STS-01 spine → oracle diff against the fixture
python3 fetch_selftest.py   # stage-1 fetch/registry/inspector wiring vs canned responses
```

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

### 3. Settle the vocabulary — the inspectors

Stage 5 of the smoke test already prints this, but to re-run just the flag-settling
readout against the live folder:

```bash
python3 - <<'PY'
import os
from workato_client import WorkatoClient, WorkatoConfig
from inspect_corpus import (
    inspect_connector_usage, inspect_recipe_keywords, inspect_provider_input_keys,
)

client = WorkatoClient(config=WorkatoConfig.from_env())
recipes = client.get_structured_recipes(folder_id=os.environ["SDC_FOLDER_ID"], include_code=True)

print("providers:", sorted({p for p, _ in inspect_connector_usage(recipes)}))
print("keywords :", dict(inspect_recipe_keywords(recipes)))
for p in {p for p, _ in inspect_connector_usage(recipes)}:
    if "db_table" in p or p == "data_tables":
        print(f"{p} input keys:", {a: dict(c)
              for a, c in inspect_provider_input_keys(recipes, p).items()})
PY
```

Reconcile the output against `extract.py`:
- **`PY_PROVIDERS`** — which of `py_eval` / `workato_python` / `python` actually appears?
- **call encoding** — a `call` keyword, or `workato_recipe_function` / `call_recipe`?
- **`TABLE_KEYS` / record key** — the data-table action's input keys confirm both.

### 4. The real oracle

Once the handles and keys above are reconciled, capture the real STS-01 and run it
through the spine with **live** registries (not the stubs). Set `STS01_ID` to its
`flow_id` from stage 5 / `folder_assets`.

```bash
python3 - <<'PY'
import os
from workato_client import WorkatoClient, WorkatoConfig, safe_parse_json
from registries import build_recipe_registry, build_table_schema_registry
from normalize import normalize
from extract import extract
from resolve import resolve
from projections import table_access_matrix, status_writers, call_graph

STS01_ID = 84  # <-- your STS-01 flow_id
client = WorkatoClient(config=WorkatoConfig.from_env())
folder = os.environ["SDC_FOLDER_ID"]

code  = safe_parse_json(client.get_recipe(STS01_ID)["code"])
edges = extract(normalize(code), STS01_ID)

rreg = build_recipe_registry(client.folder_assets(folder))
treg = build_table_schema_registry(client.list_data_tables())   # list carries schemas inline
resolve(edges, rreg, treg)

tam = table_access_matrix(edges)
print("reads :", tam.get("read"))
print("writes:", tam.get("write"))
print("status:", status_writers(edges))
print("calls :", call_graph(edges))
PY
```

The heredoc above shows the mechanism, but the packaged form is one command —
`real_oracle.py` does the same capture-and-diff against the shared spec facts,
accepting the recipe by handle or flow_id:

```bash
PYTHONPATH=/path/to/sdc-recipe-model python3 real_oracle.py STS-01
```

It exits `0` on green, `1` on mismatch, and prints exactly which facts differ. It
only goes green once the data-table vocabulary in `extract.py` is reconciled (step
3) — until then it reports the missing table/status facts and points you back to
the inspector.

### 5. The full corpus

Once a single recipe is trustworthy, run the spine over every production recipe at
once. `corpus_pass` scopes to the recipes directly in the **Recipes** folder
(subfolders and dev/test excluded), resolves call targets against the full subtree,
and prints the coverage partition (covered / control / py / state / transform /
unhandled), edges by relation, column-name drift, and the single-owner audit.

```bash
export SDC_FOLDER_ID="…"                      # the project / top-level folder
export SDC_RECIPES_FOLDER_ID="…"              # optional: skip name-resolution of "Recipes"
PYTHONPATH=/path/to/sdc-recipe-model python3 corpus_pass.py
```

The bottom section is the payoff: for each guarded status column, every writer and
its path (`table-api` vs `wfa`), flagging any writer that isn't STS-01 — the
single-writer invariant as a report. A non-owner writer is surfaced, not judged:
a WFA `add_request` setting initial status at creation is legitimate; the same
write from a non-creation recipe is the signal worth chasing.

---

## Status

Coverage is complete: across the 52 production recipes, every step is either edged
or in a named edge-less class (control / py / state / transform) — zero unhandled.
All seven relations are wired against real recipe shapes, and `real_oracle` proved
STS-01 against the independently-authored spec (non-circular).

- **Built:** the full spine (fetch → normalize → extract → resolve → project), all
  seven relations, the coverage partition, and the bridge projection / single-owner
  audit. `resolve` and `projections` are their own modules.
- **Known tidy-ups:** the `www.`/`app.` records-host derivation only fires for an
  `app.`-prefixed base; four `accesses_table` table_ids from the first full pass
  don't resolve against the data-tables list. (Trigger `auth` is also left
  unspecified — a per-recipe config dimension needing the trigger-input shapes.)
- **Next:** the full-corpus oracle — regenerate the OpenAPI spec from the model and
  diff it against the hand-authored spec across all 52 recipes (the corpus-wide
  version of what `real_oracle` does for STS-01 alone).
```
