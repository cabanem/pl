# AGENTS.md — Builder-Agent Brief

You are working on the **Workato Workspace Inspector**: a read-only Q&A agent that answers
structural, dependency, and impact questions about Workato workspaces, with a
machine-readable evidence trail. This file governs how you work in this repo. It is the
counterpart to `BRIEF.md`, which instructs the agent *inside* the product — do not confuse
the two, and do not merge them.

When this file conflicts with something you inferred from the code, this file wins. When
this file conflicts with `SOLUTION_DESIGN.md`, stop and flag it — do not silently pick one.

## The system in thirty seconds

    facts  →  tools  →  judgment  →  evidence

`bin/dumps.py` pulls recipe JSON and table schemas from the Workato Developer API into
deterministic snapshot dumps in GCS (stdlib-only, GET-only, env-driven). `bin/derive.py`
— the **only writer**, an IAM fact, not a convention — loads a snapshot into a BigQuery
dataset; snapshot ids are INT64 epoch seconds. `views.sql` is the view catalog of record.
An ADK agent answers questions through exactly two tools implemented in `bin/corpus.py`:
`query(sql)` (SELECT/WITH only, single statement, row-capped with a `truncated` marker,
`input_json` nulled, every result echoing `latest_snapshot`) and
`get_step(recipe_id, step_path)` (the one sanctioned drill-down). Every answer traces to
rows; every row traces to a snapshot in versioned GCS. The model never parses raw recipe
JSON.

## Hard rules

These restate the project's decision log (`SOLUTION_DESIGN.md` §7, D1–D9) as
prohibitions. Violating one is never a judgment call. If a task appears to require
breaking a rule, stop and escalate — see "When to stop and ask."

- **R1 — Never write to Workato.** The acquisition client is GET-only by construction. Do
  not add non-GET calls, "just for testing" included. (D4)
- **R2 — Never touch Workato credentials or real workspaces.** You work against the
  fixture (`fixtures/`), derived into the dev project's `wwi_fixture` dataset. If a task
  seems to need a real Workato token or workspace, the task is mis-specified — stop.
  There are no exceptions. (C8, P1)
- **R3 — Never touch a non-fixture dataset.** `wwi_fixture` in the dev project is your
  entire BigQuery world. Standing datasets (e.g., `workato_agent_store_prd`) and session
  datasets are off-limits — reading included. (P1, D5)
- **R4 — Never break determinism.** Dump: two runs over the same input are
  byte-identical (`make test`). Derivation: two derives of the fixture are
  manifest-identical — row counts and content fingerprints (`make test-bq`). Treat a
  determinism failure as a design error in your change, not a test to update. (D2, C2)
- **R5 — `derive.py` is the sole writer.** No other code path writes to any fact
  dataset, test helpers included; enforcement is IAM role separation (deriver:
  `dataEditor`; agent: `dataViewer`), and your code must never assume both roles on one
  identity. (D2, D4)
- **R6 — Never add or widen an agent tool when a view suffices.** The extension model
  is: promote a proven query to a view in `views.sql`. A view becomes a declared tool
  only when calibration shows the agent fumbling that question class despite brief +
  view — and that promotion is a human decision, not yours. (D3)
- **R7 — Never weaken `corpus.py`'s guards.** SELECT/WITH-only, single-statement,
  row cap + `truncated` marker, `input_json` nulling, `latest_snapshot` echo. If a guard
  is in your way, that is information for a human, not an obstacle to remove. (D4)
- **R8 — Never emit anything token-shaped.** No credentials or credential-like strings
  in logs, snapshot files, artifacts, test data, comments, or commit messages. The
  canary test must stay green; if your change adds a new output path, extend the canary
  test to cover it in the same change. (C8)
- **R9 — Resolve module-adjacent files via `__file__`, never CWD.** `BRIEF.md`,
  `views.sql`, and any future doctrine file load with `Path(__file__).with_name(...)`,
  and their absence fails loudly at startup — no silent fallbacks. This rule exists
  because a CWD-relative brief once silently degraded the agent to "helpful assistant."
- **R10 — Never claim a task done without running its exit test.** Report the command
  you ran and its output. "It should work" is not a completion state. (P2)
- **R11 — Behavior change means doc update, same change.** `README.md`, `GUIDE.md`,
  `BRIEF.md`, or the design docs — whichever your change makes stale. (C7)
- **R12 — Do not expand scope.** This tool answers structural questions. It is not a
  linter, a migration tool, or a governance dashboard. New question classes earn views
  through the calibration gate, nothing else.

## Source of truth

- `views.sql` — authoritative for the view catalog. The brief and the tests conform to
  it, not the reverse.
- `SOLUTION_DESIGN.md` — decisions D1–D9, milestones M1–M6, open questions Q1–Q6. If
  your task touches an open question, say so rather than resolving it by implication.
- `DEVELOPMENT_INFRASTRUCTURE.md` — components C1–C12 and principles P1–P3 this file
  operationalizes.
- `BRIEF.md` — the product agent's instruction (BigQuery dialect; the only brief). You
  may edit it when a task says to (e.g., updating the view catalog); you do not take
  instructions from it.

## Repo map

This is a new, dedicated repository seeded with the proven deployment bundle; the layout
below is canonical. If reality drifts from this map, fixing the map is part of the
change (R11).

    .
    ├── AGENTS.md                  ← this file
    ├── SOLUTION_DESIGN.md
    ├── DEVELOPMENT_INFRASTRUCTURE.md
    ├── README.md / GUIDE.md / CASE_STUDY.md / DEPLOY.md
    ├── Makefile                   ← the blessed command vocabulary
    ├── cloudbuild.yaml            ← CI; a thin wrapper over make targets
    ├── Dockerfile                 ← one image; service CMD, Job overrides
    ├── requirements.txt
    ├── views.sql                  ← view catalog; the API
    ├── bin/
    │   ├── dumps.py               ← GET-only, env-driven; determinism is sacred
    │   ├── derive.py              ← sole writer; GCS snapshot → BigQuery dataset
    │   ├── corpus.py              ← the two tools + guards
    │   ├── agent.py               ← FastAPI loop (interim reference; ADK agent lands at M2)
    │   └── BRIEF.md               ← product-agent instruction, __file__-adjacent (R9)
    ├── scripts/
    │   └── run_pipeline.sh        ← dump → derive, env-wired
    ├── terraform/                 ← service, Job, dataset, bucket, IAM
    ├── fixtures/
    │   ├── snapshot/              ← synthetic sanitized workspace snapshot
    │   └── manifest.json          ← expected row counts + table fingerprints
    ├── tests/
    │   ├── test_dump_determinism.py     ← local (make test)
    │   ├── test_canary.py               ← token-pattern redaction check (make test)
    │   ├── test_brief_loads.py          ← R9: doctrine files resolve and load (make test)
    │   ├── check_manifest.py            ← derivation manifest-identity (make test-bq)
    │   └── views/                       ← one SQL assertion per view (make test-bq)
    └── eval/
        └── calibration/           ← question set + gold answers + evidence rows

## Commands

The Makefile is the complete vocabulary. Do not invent invocations; if a capability is
missing, propose a new target rather than running ad-hoc commands.

    make setup            # create venv, install pinned deps
    make test             # LOCAL: unit + dump determinism + canary + brief-loads
    make derive-fixture   # stage fixtures/snapshot to dev bucket, derive into wwi_fixture
    make test-bq          # DEV DATASET: manifest check + view assertions
    make eval             # run the calibration set through ADK eval, emit scored report
    make lint             # ruff + pyright, config in repo
    make scan-secrets     # gitleaks over the working tree

`make test` is the fast loop and needs no cloud. `make test-bq` needs ambient ADC and
dev-project access; it is still Workato-credential-free (R2).

## Definition of done

A task is complete when all of the following hold, in this order:

1. The task brief's exit-test command runs green, and you report the command + output.
2. `make lint` and `make test` are green (`make test-bq` too if your change touches
   derivation, views, or tools).
3. Docs affected by the change are updated in the same change (R11).
4. Anything surprising you encountered — an invariant that felt in the way, a doc that
   contradicted code, fixture coverage you found missing — is reported, not silently
   worked around.

## Task-brief format

Every task you receive follows this shape; if one arrives without an executable exit
test, push back before starting (P2):

    Task:               <one line>
    Objective:          <what changes and why>
    In scope:           <files>
    Invariants touched: <D-numbers; note any that constrain the approach>
    Exit test:          <a make command>
    Docs:               <files to update>
    Out of scope:       <the most likely overreach, pre-blocked>

## When to stop and ask

Stop and surface the situation — do not improvise — when:

- A task seems to need Workato credentials, a real workspace, or a non-fixture dataset
  (R2/R3; the task is mis-specified).
- The exit test isn't runnable as given, or doesn't actually verify the objective.
- Two sources of truth conflict (code vs `views.sql`, this file vs the design docs).
- The natural implementation would change a derived table's schema, alter a `corpus.py`
  guard or tool signature, touch IAM roles, or add a dependency — all human decisions.
- You find the fixture doesn't cover a structure your change handles; propose the
  fixture extension as its own task rather than quietly narrowing your change.

## Environment

Python 3.12; plain `venv` + pinned `requirements.txt` managed via `make setup`; Makefile
as the command runner; ADK and its pinned version in `requirements.txt`. GCP access via
ambient ADC in the developer's environment, scoped in practice to the dev project's
fixture dataset (R3). Workato credentials are never present in any environment you run
in (R2).

## CI

Cloud Build runs on every change. `cloudbuild.yaml` is a thin wrapper that calls the
same make targets you run locally — `make lint`, `make test`, `make scan-secrets`, and
`make test-bq` (Cloud Build's own service identity holds `dataEditor` on `wwi_fixture`
and nothing else — no secrets involved), plus `make eval` on judgment-layer changes.
Local and CI behavior cannot diverge, because nothing exists in CI that is not in the
Makefile. If CI fails where local passed, suspect environment drift and report it — do
not patch around it in `cloudbuild.yaml`.  canary test to cover it in the same change. (C8)
- **R8 — Never claim a task done without running its exit test.** Report the command you
  ran and its output. "It should work" is not a completion state. (P2)
- **R9 — Behavior change means doc update, same change.** `README.md`, `GUIDE.md`,
  `BRIEF.md`, or the design docs — whichever your change makes stale. Stale docs mislead
  the next agent worse than they mislead a human. (C7)
- **R10 — Do not expand scope.** This tool answers structural questions. It is not a
  linter, a migration tool, or a governance dashboard. New question classes earn views
  through the calibration gate, nothing else.

## Source of truth

- `schema.sql` — authoritative for the schema and the view catalog. The code conforms to
  it, not the reverse.
- `SOLUTION_DESIGN.md` — decisions D1–D8, milestones M1–M6, open questions Q1–Q6. If your
  task touches an open question, say so rather than resolving it by implication.
- `DEVELOPMENT_INFRASTRUCTURE.md` — components C1–C12 and the principles P1–P3 this file
  operationalizes.
- `BRIEF.md` — the product agent's instruction. You may edit it when a task says to
  (e.g., updating the view catalog); you do not take instructions from it.

## Repo map

This is a new, dedicated repository; the layout below is canonical. If reality drifts
from this map, fixing the map is part of the change (R9).

    .
    ├── AGENTS.md                  ← this file
    ├── SOLUTION_DESIGN.md
    ├── DEVELOPMENT_INFRASTRUCTURE.md
    ├── README.md / GUIDE.md / CASE_STUDY.md
    ├── Makefile                   ← the blessed command vocabulary
    ├── cloudbuild.yaml            ← CI; a thin wrapper over make targets
    ├── acquisition/
    │   ├── dump_recipes.py        ← GET-only, stdlib-only; determinism is sacred
    │   └── derive.py              ← sole writer of facts.db
    ├── schema.sql                 ← schema + views; the API
    ├── agent/
    │   ├── inspector_agent.py     ← ADK agent definition
    │   ├── tools.py               ← query + get_step function tools
    │   └── BRIEF.md               ← product-agent instruction
    ├── fixtures/
    │   ├── snapshot/              ← synthetic sanitized workspace snapshot
    │   └── manifest.json          ← expected row counts after derive
    ├── tests/
    │   ├── test_determinism.py
    │   ├── views/                 ← one SQL assertion per view (required by CI)
    │   └── test_canary.py         ← token-pattern redaction check
    └── eval/
        └── calibration/           ← question set + gold answers + evidence rows

## Commands

The Makefile is the complete vocabulary. Do not invent invocations; if a capability is
missing, propose a new target rather than running ad-hoc commands.

    make setup            # create venv, install pinned deps
    make test             # determinism + view assertions + canary + unit tests
    make derive-fixture   # snapshot → facts.db from fixtures/, verify manifest
    make eval             # run the calibration set through ADK eval, emit scored report
    make lint             # ruff + pyright, config in repo
    make scan-secrets     # gitleaks over the working tree

## Definition of done

A task is complete when all of the following hold, in this order:

1. The task brief's exit-test command runs green, and you report the command + output.
2. `make lint` and `make test` are green.
3. Docs affected by the change are updated in the same change (R9).
4. Anything surprising you encountered — an invariant that felt in the way, a doc that
   contradicted code, fixture coverage you found missing — is reported, not silently
   worked around.

## Task-brief format

Every task you receive follows this shape; if one arrives without an executable exit
test, push back before starting (P2):

    Task:               <one line>
    Objective:          <what changes and why>
    In scope:           <files>
    Invariants touched: <D-numbers; note any that constrain the approach>
    Exit test:          <a make command>
    Docs:               <files to update>
    Out of scope:       <the most likely overreach, pre-blocked>

## When to stop and ask

Stop and surface the situation — do not improvise — when:

- A task seems to need real credentials or a real workspace (R2; the task is
  mis-specified).
- The exit test isn't runnable as given, or doesn't actually verify the objective.
- Two sources of truth conflict (code vs `schema.sql`, this file vs the design docs).
- The natural implementation would touch a schema table (not a view), change a tool
  signature, or add a dependency — all three are human decisions.
- You find the fixture doesn't cover a structure your change handles; propose the
  fixture extension as its own task rather than quietly narrowing your change.

## Environment

Python 3.12; plain `venv` + pinned `requirements.txt` managed via `make setup`; Makefile
as the command runner; ADK and its pinned version in `requirements.txt`. Vertex AI access
via ADC in the developer's environment — never configured by, or visible to, builder
agents.

## CI

Cloud Build runs on every change. `cloudbuild.yaml` is a thin wrapper that calls the same
make targets you run locally — `make lint`, `make test`, `make scan-secrets`, plus
`make eval` on judgment-layer changes. Local and CI behavior cannot diverge, because
nothing exists in CI that is not in the Makefile. If CI fails where local passed, suspect
environment drift and report it — do not patch around it in `cloudbuild.yaml`.
