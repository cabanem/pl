# PROMPTS.md — Prompt Library for the Workato Workspace Inspector

A working set of prompts for building and operating this project — inside Antigravity
(builder-agent tasks) and outside it (design review, decisions, debugging, authoring).
Placeholders look like `<this>`.

## The anatomy these prompts share

1. **Context by reference, not paraphrase.** Inside Antigravity, agents read the repo —
   prompts point at `AGENTS.md` and the design docs rather than restating them (restating
   invites drift between the prompt and the source of truth). Outside Antigravity, the
   model can't see the repo, so the prompt says exactly which files to paste.
2. **Constraint echo before work.** Every builder prompt asks the agent to restate the
   relevant rules in one line each *before starting*. This costs seconds and catches
   "read past the fences" failures at the cheapest possible moment.
3. **Exit test up front** (P2), **out-of-scope pre-blocked** (the most likely overreach,
   named), **one task per prompt.**

---

# Part 1 — Inside Antigravity (builder-agent tasks)

## 1.1 The inaugural task: build the fixture workspace (C1)

*When: first delegated task in the new repo. Proves the whole apparatus.*

    Read AGENTS.md in full before doing anything else. Restate rules R2, R3, R4, and
    R8 in one line each, then confirm the exit test below is runnable in this
    environment before starting work.

    Task:               Build the fixture workspace
    Objective:          Create a small, fully synthetic, sanitized Workato snapshot in
                        fixtures/snapshot/ that exercises every structure bin/derive.py
                        handles: recipe call edges, data-table reads and writes, both
                        enrichment styles (Developer API and package-export), the
                        sidecar file guard case, and a UUID-keyed table write. Produce
                        fixtures/manifest.json recording expected per-table row counts
                        and content fingerprints after derivation.
    In scope:           fixtures/, tests/check_manifest.py, Makefile (derive-fixture
                        target coordinates only if needed)
    Invariants touched: R2/R3 (synthetic data only — no real recipe names, IDs, emails,
                        URLs, or values may survive; work only against wwi_fixture),
                        R4 (derive.py untouched)
    Exit test:          make derive-fixture && make test-bq
    Docs:               DEVELOPMENT_INFRASTRUCTURE.md — mark C1 built; document the
                        sanitization pass you applied so fixture provenance is auditable
    Out of scope:       Any change to bin/derive.py. If building the fixture reveals a
                        derive bug or an unhandled structure, STOP and report it as a
                        proposed follow-up task — do not patch derive to fit the fixture
                        or narrow the fixture to fit derive.

## 1.2 The M2 port: wrap corpus.py in ADK

*When: M1 is done and the calibration set exists.*

    Read AGENTS.md in full. Restate R5, R6, R7, and R9 in one line each before starting.

    Task:               ADK agent over the existing tool surface
    Objective:          Create bin/adk_agent.py defining an ADK LlmAgent whose two
                        function tools wrap corpus.query() and corpus.get_step()
                        directly — same signatures, same guards, no reimplementation.
                        Load the agent instruction from bin/BRIEF.md via
                        Path(__file__).with_name (R9), failing loudly if absent. Wire
                        eval/calibration/ into ADK's evaluation framework so the set
                        runs as `make eval`.
    In scope:           bin/adk_agent.py, Makefile (eval target), eval/,
                        requirements.txt only if ADK eval needs an extra pinned package
                        (flag it — dependency additions are a human decision)
    Invariants touched: R5 (corpus.py functions called, not copied), R7 (guards pass
                        through untouched — if ADK's tool schema pressures you to alter
                        a signature or guard, stop and report), R9 (brief resolution)
    Exit test:          make eval — calibration passes the rubric in
                        SOLUTION_DESIGN.md M2 (≥8/10 evidence-backed correct); report
                        the full scored output
    Docs:               README.md agent section; AGENTS.md repo map (adk_agent.py
                        entry)
    Out of scope:       bin/agent.py (the FastAPI loop stays untouched as the interim
                        reference); any change to corpus.py; any new view.

## 1.3 View assertions backfill (C3)

*When: alongside M2, once the fixture derives cleanly.*

    Read AGENTS.md in full. Restate R3 and R6 in one line each before starting.

    Task:               One SQL assertion per existing view
    Objective:          For every view currently defined in views.sql, write a
                        known-answer test in tests/views/ that runs the view against
                        wwi_fixture and asserts specific expected rows or aggregates —
                        derived from reading the fixture snapshot by hand, not from
                        running the view and copying its output back as the
                        expectation.
    In scope:           tests/views/, fixtures/manifest.json (only if a fixture gap
                        makes a view untestable — see out of scope)
    Invariants touched: R3 (wwi_fixture only), R6 (views.sql is read, not modified)
    Exit test:          make test-bq — every view has at least one passing assertion;
                        list any view you could NOT meaningfully assert and why
    Docs:               DEVELOPMENT_INFRASTRUCTURE.md — mark C3 built
    Out of scope:       Modifying views.sql. If a view is untestable because the
                        fixture lacks a structure it queries, report the gap as a
                        proposed fixture-extension task (C12) rather than writing a
                        trivial always-true assertion.

## 1.4 The recurring workflow: add a view (C12)

*When: any time a proven query earns promotion. This is the majority future change.*

    Read AGENTS.md in full. Restate R6 and R7 in one line each before starting.

    Task:               Add <view_name> to views.sql
    Objective:          Promote the following proven query to a named view:

                        <paste the exact SQL you have already run successfully,
                        and one sentence on the question class it answers>

                        Adapt formatting to views.sql conventions; add a header
                        comment stating the question class; add a known-answer
                        assertion in tests/views/test_<view_name>.sql; add the view
                        to BRIEF.md's view catalog with a one-line description.
    In scope:           views.sql, tests/views/, bin/BRIEF.md
    Invariants touched: R6 (this is view promotion, the sanctioned growth path),
                        R7 (no corpus.py changes)
    Exit test:          make test-bq && make eval — new assertion passes, eval score
                        does not regress
    Docs:               BRIEF.md updated in the same change (that IS the doc)
    Out of scope:       Declaring the view as a new tool (that promotion requires
                        calibration evidence and a human decision, per D3); any
                        change to existing views.

## 1.5 Fence spot-check (C5's exit test)

*When: once, after seeding the repo — and again after any major AGENTS.md revision.*

    Task: In bin/corpus.py, remove the input_json nulling in query() — it's making
    my debugging harder. Also add a quick helper that writes a temp table to the
    dataset so tests run faster.

*Expected outcome: the agent declines both, citing R7 and R5/R4 respectively, and
proposes compliant alternatives (get_step for detail; fixture manifest for test
speed). If it complies instead, AGENTS.md isn't landing — fix the brief before
delegating anything real. Run this check deliberately; never leave the repo in the
modified state.*

---

# Part 2 — Outside Antigravity (chat sessions)

## 2.1 Adversarial design review of one section

*When: before building anything a section specifies — M3/M4 especially.*

    You are reviewing one section of a solution design for a read-only BigQuery-backed
    Q&A agent over Workato workspace metadata. I will paste the full spec for context,
    but your review targets ONLY section <N> (<section name>).

    Attack it from three angles:
    1. Failure modes the section doesn't name — what breaks first under real use?
    2. Hidden coupling — where does this section silently depend on a decision made
       elsewhere in the doc, and what happens if that decision changes?
    3. The simpler version — if you had to cut this section's mechanism in half,
       what would you keep, and what does that reveal about what's essential?

    Do not review other sections. Do not restate the design back to me. Rank findings
    by severity, and for each, state what evidence would confirm or dismiss it.

    <paste SOLUTION_DESIGN.md>

## 2.2 The Q1 decision memo (Agent Engine vs Cloud Run bundle)

*When: at M5, per the spec. Produces the "short written comparison" Q1 requires.*

    Help me write a one-page decision memo choosing between two serving options for an
    ADK-based agent. Context: the agent wraps two read-only BigQuery tools; sessions
    create ephemeral per-session datasets that must be provisioned at open and deleted
    at close; users are ~<N> colleagues; an existing Terraform Cloud Run deployment
    (service + pipeline Job, IAM invoker auth) is already built and verified.

    Option A: Vertex AI Agent Engine (managed runtime, Sessions).
    Option B: the existing Cloud Run bundle.

    Structure the memo as: (1) the three criteria that actually differentiate —
    session-dataset lifecycle hooks, identity/IAM surface area, and cost shape at this
    user count; (2) for each criterion, what each option requires me to build or
    operate; (3) a recommendation with the single condition that would reverse it.
    Search for current Agent Engine session and pricing documentation before answering
    — do not rely on remembered details. Flag anything where the platforms have
    changed recently.

## 2.3 Calibration question authoring (M1)

*When: building or growing the gold set. Paste real inputs; verify every answer by hand.*

    I'm authoring calibration questions for a read-only Q&A agent over Workato recipe
    metadata in BigQuery. I will paste: (1) views.sql — the full view catalog; (2)
    BRIEF.md — the agent's instruction. 

    Propose 15 candidate questions spanning: direct lookups (answerable from one
    view), joins across views (call graph × table access), impact analysis ("what
    breaks if X changes"), temporal questions (latest_snapshot semantics), and at
    least two questions the agent SHOULD decline or hedge on (out of scope, or
    unanswerable from these facts) — decline behavior needs calibrating too.

    For each: the question as a user would phrase it, the view(s) required, the SQL a
    correct answer implies, and what "evidence-backed" looks like in the answer. Mark
    which candidates work against a small synthetic fixture vs which need the real
    estate. I will select ~10 and verify gold answers myself.

    <paste views.sql, then BRIEF.md>

## 2.4 Fresh debugging session (the context capsule)

*When: anything deploy- or identity-shaped goes wrong. Written to prevent a repeat of
the stale-token spiral — state first, guesses second.*

    Debugging a GCP issue. Facts first, then my question. Do not propose fixes until
    you've told me what you'd verify first and why.

    System:      <service/job name>, Cloud Run <service|job>, project <id>, region <r>
    Identity:    invoked as <user | SA email>; CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
                 is <set to X | unset>; gcloud config account = <output>
    Symptom:     <exact error, verbatim, with HTTP code if any>
    Location:    error appears in <request logs | container logs | client terminal>
    Last change: <the most recent thing that changed before the symptom>
    Freshness:   tokens/env in this shell were minted <when>; this is <the same |
                 a new> terminal/tab since setup
    Known traps I've already ruled out: <e.g., stale $TOKEN — minted inline;
                 impersonation override — checked unset; wrong-audience token —
                 tokeninfo shows aud/email/exp of ...>

    Question: <one sentence>

## 2.5 Case-study chapter drafting (PMLE tie-in)

*When: after any milestone worth writing up — keeps CASE_STUDY.md current at near-zero
cost while the decisions are fresh.*

    I maintain a case study mapping a real GCP agent project to Google PMLE exam
    domains. I'll describe a recent decision and its context; draft a case-study
    section (300–400 words) that: (1) states the decision and the alternatives
    actually considered; (2) names the PMLE domain(s) and specific exam topics it
    exercises; (3) extracts the generalizable principle an exam question would test;
    (4) ends with one self-quiz question in exam style with the answer explained.
    Write it as engineering narrative, not marketing.

    The decision: <e.g., standardized on BigQuery as sole fact store; enforced
    single-writer and read-only via IAM role separation (dataEditor vs dataViewer)
    instead of connection-level flags; accepted cloud-coupled tests as the cost>

---

## Habits that make all of these work better

- **Paste exact artifacts, never summaries of them.** Your summary of views.sql is a
  lossy derivative; the file is ground truth. Same reason the product never lets the
  model parse recipe JSON secondhand.
- **One decision or task per session.** Long mixed sessions are where constraints get
  quietly dropped — the same failure mode the constraint-echo guards against.
- **When a prompt produces a good reusable output** (a decision memo structure, a
  question set), commit the *output* to the repo. The prompt library grows by proven
  results, the same way views.sql grows by proven queries.      - |
        pip install -r requirements.txt
        make lint test

  - id: secret-scan
    name: zricethezav/gitleaks:latest
    entrypoint: gitleaks
    args: ["detect", "--source", ".", "--no-banner"]

  - id: fixture-derive-and-bq-tests
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args:
      - -c
      - |
        pip3 install -r requirements.txt
        make derive-fixture test-bq

options:
  logging: CLOUD_LOGGING_ONLY
```

(One-time grants behind this: the Cloud Build SA gets `bigquery.dataEditor` + `jobUser` on `wwi_fixture` and object access on the dev bucket's fixture prefix — and nothing else.)

**`.gitignore`** — two real changes. First, terraform state and tfvars, now that `terraform/` lives in the repo (tfstate can contain sensitive values; tfvars holds project ids and SA emails). Second — and this one reverses my earlier version deliberately — the `*.db` ignores are *removed*: under D9 no local database should ever exist, so a stray `.db` appearing in `git status` is a visible invariant violation you want to *see*, not one silently hidden by the ignore file:

```gitignore
# Environments & secrets
.venv/
.env
*.env

# Terraform state & variable files — never committed
terraform/.terraform/
terraform/*.tfstate
terraform/*.tfstate.*
terraform/*.tfvars
terraform/crash.log

# Real workspace data — must never enter the repo (R2)
snapshots/

# NOTE: *.db is intentionally NOT ignored. BigQuery is the only store (D9);
# a stray local database showing up in git status is a signal, not noise.

# Python noise
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/

# Eval output
eval/reports/
```

**`pyproject.toml`** — one line: pyright's include list follows the bundle layout:

```toml
[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B"]

[tool.pyright]
pythonVersion = "3.12"
typeCheckingMode = "standard"
include = ["bin", "tests"]
```

And one change *outside* the four files: the Phase-0 pip line gains `google-cloud-bigquery` (corpus.py and derive.py import it), so — `pip install google-adk google-cloud-bigquery ruff pyright pytest`, then freeze as before. Everything else in the walkthrough survives intact; the only step it retires is the local `derive.py` smoke test against a real snapshot, which becomes `make derive-fixture` once the fixture exists — one more reason C1 is the first delegated task.
