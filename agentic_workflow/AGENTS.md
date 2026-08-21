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

`dump_recipes.py` pulls recipe JSON and table schemas from the Workato Developer API into
deterministic snapshots (stdlib-only, GET-only). `derive.py` — the **only writer** — turns
a snapshot into `facts.db` in a single atomic commit. An ADK agent answers questions
through exactly two tools: `query(sql)` (read-only, row-capped, views + non-blob columns
only) and `get_step(recipe_id, step_path)` (the one sanctioned drill-down). The views
declared in `schema.sql` are the API. Every answer traces to rows; every row traces to a
captured snapshot. The model never parses raw recipe JSON.

## Hard rules

These restate the project's decision log (`SOLUTION_DESIGN.md` §7, D1–D8) as prohibitions.
Violating one is never a judgment call. If a task appears to require breaking a rule, stop
and escalate — see "When to stop and ask."

- **R1 — Never write to Workato.** The acquisition client is GET-only by construction. Do
  not add non-GET calls, "just for testing" included. (D4)
- **R2 — Never touch real credentials.** You work against the fixture workspace
  (`fixtures/`) only. If a task seems to need a real token or a real workspace, that task
  is mis-specified — stop. There are no exceptions to this rule. (Firewall C8, P1)
- **R3 — Never break dump determinism.** Two runs over the same input produce
  byte-identical output. `make test` enforces this; treat a determinism failure as a
  design error in your change, not a test to update. (D2, C2)
- **R4 — `derive.py` is the sole writer of `facts.db`.** No other code path writes to it,
  ever, including test helpers. Failed derives must leave nothing behind. (D2)
- **R5 — Never add or widen an agent tool when a view suffices.** The extension model is:
  promote a proven query to a view in `schema.sql`. A view becomes a declared tool only
  when calibration shows the agent fumbling that question class despite brief + view —
  and that promotion is a human decision, not yours. (D3)
- **R6 — `facts.db` is opened read-only at answer time** (`file:...?mode=ro`). Do not
  relax this to make a feature easier. (D4)
- **R7 — Never emit anything token-shaped.** No credentials or credential-like strings in
  logs, snapshots, artifacts, test data, comments, or commit messages. The canary
  redaction test must stay green; if your change adds a new output path, extend the
  canary test to cover it in the same change. (C8)
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
