# Developer Artifacts Guide — Agent Health Check Framework

A phase-by-phase walkthrough of the artifacts a software team would produce, with reasoning for each and prompts you can use to generate them.

**How to use this:** Each phase lists the artifacts in roughly the order you'd produce them. Each artifact has three parts: *what it is*, *why it exists*, and *a prompt to elicit it*. Skip any artifact whose "why" doesn't apply to your situation — the goal is fitness for purpose, not completeness for its own sake.

**Prompt conventions:** Where prompts say `[bracketed text]`, fill in your specifics. Where they say "attach the X spec," paste the relevant prior artifact into the conversation. AI assistants produce dramatically better artifacts when they have prior artifacts as context.

---

## Phase 0 — Align

**Produce** A small set of documents that lock decisions and surface dependencies before code is written. This phase is mostly writing, almost no code.

### Artifact 0.1 — Registry contract document

**What it is:** A short document (≤2 pages) stating exactly what your framework needs from the agent registry. Field names, types, semantics, immutability commitments.

**Why it exists:** Without it, "agreement" with the registry owner is a verbal nod that drifts. With it, both of you have something to point at when a question comes up six weeks from now.

**Prompt:**
> I need to produce a contract document specifying what my agent health check framework requires from a separate agent registry being built by a colleague. The registry is the system of record for agent identity, persona, and lineage. My framework joins to it on `agent_id` and adds operational metadata. I need this contract to specify exactly five fields I depend on (`agent_id`, `lifecycle_status`, `agent_type`, `owner_email`, `environment`), their types, their semantics including enum values, my read-only commitment, and the requirement that `agent_id` be immutable once issued. The audience is my colleague who is building her first database. The document should be ≤2 pages, be reviewable by a non-engineer, and serve as a binding agreement. Produce the document.

### Artifact 0.2 — Architecture Decision Record (ADR) shell

**What it is:** A one-page document capturing the major architectural decisions that have been made, why, and what alternatives were considered. ADRs are typically numbered (ADR-001, ADR-002) and stored in the repo. You already use these for SDC.

**Why it exists:** When someone asks "why did we do it this way?" six months from now, the ADR is the answer. Without it, the reasoning lives in your head and disappears when you move on.

**Prompt:**
> Produce an Architecture Decision Record for an agent health check framework. The decisions to capture are: (1) the framework joins to a separate agent registry on `agent_id` rather than owning identity itself, (2) all four operational tables live in the same single GCP project as the registry, (3) checks run on an hourly cadence for v1, (4) the v1 check set is connectivity & auth, model integrity, and knowledge freshness only. For each decision, capture context, the decision itself, alternatives considered, consequences (positive and negative), and status. Use the standard ADR format (Michael Nygard style). Single page per decision is fine.

### Artifact 0.3 — Project README (initial)

**What it is:** The repo's README at the moment of repo creation. States what this project is, who owns it, how to get started, and where the key documents live.

**Why it exists:** It's the front door. A repo without a README is a repo no one can onboard to.

**Prompt:**
> Produce an initial README for the agent health check framework repository. The repo will eventually contain Python code, Terraform IaC, design documents, and tests. At this stage the repo has only documentation — no code yet. The README should state: project purpose, current status (Phase 0 — design), key documents and where to find them (registry contract, ADRs, action plan, RegistryClient spec), the technology choices made so far (Python, BigQuery, Cloud Run, Terraform), and how to contribute. Keep it under one screen. Use standard markdown conventions (badges optional, table of contents only if needed).

---

## Phase 1 — Stub and skeleton

**Produce** The first runnable code, the first tests, the first deployed infrastructure. The foundation everything else sits on.

### Artifact 1.1 — Repo structure

**What it is:** The directory layout for the project. Decided once, lived with for the project's life.

**Why it exists:** A consistent structure means anyone can find things. An inconsistent one means everyone re-derives the layout in their head every time they open the repo.

**Prompt:**
> Propose a repo structure for a Python-based GCP service. The service will contain: domain code (RegistryClient, Check interface, Orchestrator, three concrete checks), Terraform IaC for BigQuery datasets/tables, Cloud Run service, Cloud Scheduler, Pub/Sub, Secret Manager bindings, service accounts, unit tests (fast, in-memory fixtures), integration tests (against test BigQuery dataset), documentation (ADRs, runbook, onboarding guide, README), and stub data (CSV files for the mock registry). I prefer a clear separation between domain code and infrastructure code. I use `pyproject.toml` and `uv` for Python. Show the directory tree with brief explanations of what goes where, and propose the top-level files (pyproject.toml, .gitignore, Makefile if appropriate).

### Artifact 1.2 — Stub registry data and IaC

**What it is:** A CSV file with representative agent data, plus the Terraform code that creates the GCS bucket, BigQuery dataset, and external table.

**Why it exists:** The stub is permanent test infrastructure (per the action plan), not throwaway. Treating it as IaC from day one means anyone can recreate it.

**Prompt:**
> I need two artifacts. First, a CSV file containing 10 representative agent rows for a stub registry. Columns: `agent_id` (string, kebab-case), `lifecycle_status` (active/deprecated/retired), `agent_type` (rag/tool_using/conversational/classifier), `owner_email`, `environment` (dev/staging/prod). Cover every combination of agent_type and lifecycle_status that meaningfully exercises downstream code. Second, the Terraform code that creates: a GCS bucket for stub data with versioning enabled, a BigQuery dataset called `agent_health`, and a BigQuery external table called `registry_stub` pointing at the CSV. The Terraform should be idempotent and use a remote state backend (GCS bucket with versioning). Use a single GCP project. Variables for project ID and region.

### Artifact 1.3 — `RegistryClient` implementation

**What it is:** The Python code implementing the protocol from the spec, with the BigQuery-backed implementation, the in-memory fake, and the error types.

**Why it exists:** This is the load-bearing abstraction. Worth implementing carefully and reviewing for adherence to the spec.

**Prompt:**
> Attached is the RegistryClient interface specification. Produce the Python implementation. I need: (1) the `RegistryClient` protocol, (2) the `AgentRecord` frozen dataclass and three enums, (3) the two error types, (4) `BigQueryStubRegistryClient` reading from a BigQuery external table using `google-cloud-bigquery`, (5) `FakeRegistryClient` for tests. Use Python 3.11+, type hints throughout, no inheritance where Protocol works. Match the spec exactly — if anything is ambiguous, ask before guessing. Include docstrings that match the spec's docstring text. The code should be in `src/health_check/registry/` with files named per the repo structure I'll attach.

### Artifact 1.4 — Unit tests for `RegistryClient`

**What it is:** Tests covering every code path in the registry client implementations. Fast (milliseconds), no network.

**Why it exists:** This is the abstraction the rest of the system depends on. If it's broken, everything downstream is broken in subtle ways. Tests catch breakage at the boundary.

**Prompt:**
> Attached is my RegistryClient implementation. Produce a complete pytest test suite covering: (1) `FakeRegistryClient` returns expected records for various lifecycle statuses including correct filtering of RETIRED, (2) `FakeRegistryClient.get_agent` returns None for unknown IDs, (3) `BigQueryStubRegistryClient._row_to_record` correctly converts valid rows, (4) `BigQueryStubRegistryClient._row_to_record` raises `RegistryDataError` with helpful message on invalid enum values, (5) `BigQueryStubRegistryClient` raises `RegistryUnavailableError` on BigQuery failures (mock the client), (6) `AgentRecord` is immutable (mutation attempts raise). Use pytest fixtures. Mock BigQuery using `unittest.mock`. No actual GCP calls. Tests should run in under one second total.

### Artifact 1.5 — Cloud Run skeleton service

**What it is:** A minimal Flask or FastAPI service that, on HTTP trigger, calls `list_agents_for_check_run()` and logs the results. Plus the Dockerfile and Terraform to deploy it.

**Why it exists:** Phase 1 ends with a working demo. This is the "working" part — proof the read path works end-to-end against real GCP infrastructure.

**Prompt:**
> Produce a minimal Cloud Run service in Python. It should: (1) accept HTTP POST at `/run`, (2) instantiate `BigQueryStubRegistryClient`, (3) call `list_agents_for_check_run()`, (4) log each agent as a structured JSON log line with `agent_id`, `lifecycle_status`, `agent_type`, `environment`, (5) return a JSON response with the count of agents processed. Use FastAPI. Include a Dockerfile (multi-stage build, non-root user, minimal base image). Include the Terraform to deploy it: Cloud Run service, service account with `bigquery.dataViewer` on the dataset and `bigquery.jobUser` on the project, plus Cloud Scheduler firing hourly (initially disabled). Variables for project ID, region, container image. Assume the image will be built and pushed to Artifact Registry separately.

### Artifact 1.6 — End-of-phase status update

**What it is:** A short note (paragraph or three) saying what got built, what got skipped, what's blocked. Often posted in a team channel or PR description.

**Why it exists:** Visible progress is a real thing. Status updates are how you make visible progress visible. They also catch drift early — if you can't write a clean update, something's off.

**Prompt:**
> Produce a Phase 1 completion status update for the agent health check framework. Phase 1 covered: stub registry data and IaC, RegistryClient implementation with three flavors, unit tests, minimal Cloud Run service, hourly Cloud Scheduler (disabled). Format: 3–4 short paragraphs covering what was built, what was deferred, any blockers, what's next (Phase 2 — thin end-to-end slice with the connectivity check). Tone: factual, not promotional. Audience: my manager and the registry owner.

---

## Phase 2 — Thin end-to-end slice

**Produce** The first complete vertical slice. One check, one finding, end-to-end. This phase is where the architecture either works or doesn't.

### Artifact 2.1 — `Check` interface specification

**What it is:** The same kind of spec we produced for `RegistryClient`, but for the check abstraction. Smaller surface but equally load-bearing.

**Why it exists:** Same reason as the registry spec — the interface determines whether new checks are easy or expensive. Worth designing deliberately.

**Prompt:**
> I need a specification document for a `Check` interface in my agent health check framework. The interface needs to support three concrete checks initially (connectivity & auth, model integrity, knowledge freshness) and accommodate future checks without refactoring. Each check is a pure function from (agent record, operational config, optional RAG config, reference data, current time) to a verdict. Verdicts are check-specific enums plus optional structured detail. I/O happens inside checks only when necessary (e.g., the connectivity check actually probes the endpoint). Follow the same structure as the attached RegistryClient spec: purpose, interface, types, error handling, implementations, invariants, what would push back this design, acceptance criteria. The spec should be implementation-language-agnostic conceptually but show Python signatures.

### Artifact 2.2 — DDL for `agent_operational` and `health_check_findings`

**What it is:** The CREATE TABLE statements (or Terraform equivalents) for the two tables Phase 2 needs.

**Why it exists:** Findings table schema is one of the seven load-bearing pieces. Worth getting right before data accumulates.

**Prompt:**
> Produce BigQuery DDL via Terraform for two tables. Table 1: `agent_operational`. Columns: `agent_id` (STRING, NOT NULL, primary key conceptually), `endpoint_url` (STRING), `protocol` (STRING, enum: https/grpc), `auth_method` (STRING, enum: api_key/oauth2_client_credentials/gcp_service_account/none), `credential_secret_ref` (STRING, Secret Manager resource name), `health_probe_path` (STRING, nullable), `expected_status_code` (INT64, default 200), `latency_p95_threshold_ms` (INT64), `request_payload_template_ref` (STRING, nullable), `checks_enabled` (ARRAY<STRING>), `created_at` (TIMESTAMP, NOT NULL), `updated_at` (TIMESTAMP, NOT NULL). Table 2: `health_check_findings`. Append-only, partitioned by DATE(run_at), clustered on (agent_id, check_name). Columns: `finding_id` (STRING, NOT NULL), `run_id` (STRING, NOT NULL), `agent_id` (STRING, NOT NULL), `check_name` (STRING, NOT NULL), `run_at` (TIMESTAMP, NOT NULL), `verdict` (STRING, NOT NULL), `verdict_reason` (STRING, nullable), `latency_ms` (INT64, nullable), `detail_json` (JSON, nullable), `runner_version` (STRING). Apply the column-vs-JSON discipline: filterable/aggregable fields are columns; everything else is detail_json. Use Terraform `google_bigquery_table` resources.

### Artifact 2.3 — Connectivity check implementation

**What it is:** The first concrete `Check`. The template for the next two.

**Why it exists:** The first implementation of an interface is where you find out if the interface works. Producing this carefully de-risks the next two checks.

**Prompt:**
> Attached are the Check interface spec and the RegistryClient implementation. Produce the connectivity & auth check in Python. Verdicts: pass | latency_warn | latency_fail | auth_fail | unreachable. Logic: resolve credential from Secret Manager via the credential resolver (assume it exists with signature `resolve(secret_ref: str) -> dict`), construct the request based on auth_method, hit `health_probe_path` (or `endpoint_url` if path is null), measure latency, classify based on status code and latency relative to `latency_p95_threshold_ms` (warn at threshold, fail at 2x threshold). Use `httpx` for requests. Timeout at 30 seconds total. Include the `Verdict` dataclass with verdict, verdict_reason, latency_ms, and detail dict. Match the Check protocol exactly. Place in `src/health_check/checks/connectivity.py`.

### Artifact 2.4 — Credential resolver

**What it is:** A small module that pulls secrets from Secret Manager. Called by checks.

**Why it exists:** Single chokepoint for credential access — easier to audit, easier to change later. Don't let checks call Secret Manager directly.

**Prompt:**
> Produce a credential resolver module for the agent health check framework. Single function: `resolve(secret_ref: str) -> dict`. Inputs are Secret Manager resource names like `projects/123/secrets/agent-x-credential/versions/latest`. Output is the parsed secret payload (always JSON in our convention, with structure depending on auth_method). Cache results within a single process (LRU cache, max 100 entries) but never persist across process restarts. Use `google-cloud-secret-manager`. Raise a clear error type (`CredentialResolutionError`) on missing secrets, malformed JSON, or access denied. Include unit tests using mocked Secret Manager.

### Artifact 2.5 — Orchestrator

**What it is:** The coordinator that ties registry, operational config, checks, and findings together.

**Why it exists:** Without an orchestrator, checks are isolated functions with no story. The orchestrator is what makes the system *run*.

**Prompt:**
> Produce the orchestrator for the agent health check framework. Inputs at construction: `registry: RegistryClient`, `operational: OperationalConfigStore` (you'll need to design this — same pattern as RegistryClient, simpler), `findings: FindingsWriter`, `checks: dict[str, Check]`. Single method: `run(run_id: str) -> RunSummary`. Logic: list checkable agents, for each agent load operational config (skip with INFO log if missing), for each check_name in checks_enabled run the check (skip with WARNING log if check not registered), write each verdict to findings with the run_id. Bounded concurrency (configurable, default 10 concurrent checks). Per-check timeout (configurable, default 30s). Catch and log per-check exceptions; don't let one check crash the run. Return a RunSummary with counts by verdict. Use `asyncio` for concurrency. Place in `src/health_check/orchestrator.py`. Attach the Check spec, the RegistryClient implementation, and the connectivity check for context.

### Artifact 2.6 — Integration test

**What it is:** A test that runs the full orchestrator against the stub registry and a test BigQuery dataset, end-to-end.

**Why it exists:** Unit tests don't catch wiring issues. Integration tests do. You need at least one.

**Prompt:**
> Produce a pytest integration test for the agent health check framework. Setup: a test BigQuery dataset (use a fixture that creates and tears down), a `FakeRegistryClient` with three agents (one healthy, one with bad credentials, one unreachable), a real `OperationalConfigStore` against the test dataset seeded with operational config for all three, a real `FindingsWriter` against the test dataset, the real connectivity check, the real orchestrator. Action: run the orchestrator. Assertion: three findings rows in BigQuery with correct verdicts. The test should clean up after itself. Use `pytest` markers to mark this as `@pytest.mark.integration` so it can be excluded from fast test runs. Document how to run it locally (requires GCP credentials with permissions on a dev project).

### Artifact 2.7 — Pull request description (template you'll reuse)

**What it is:** The text that goes on a PR when you submit code for review. Real teams have a template; small teams develop one over time.

**Why it exists:** A good PR description is how the reviewer (or future-you) understands what changed and why without reading every diff.

**Prompt:**
> Produce a pull request description template for the agent health check framework repo, plus an example filled-in description for the Phase 2 PR (which adds the connectivity check, credential resolver, orchestrator, and the two operational tables). Template should have sections: Summary, Why, What changed, Testing performed, Risks, Out of scope, Linked artifacts. Tone: terse and factual, not promotional. The example should be realistic for the work described.

---

## Phase 3 — Broaden checks

**Produce** The second and third concrete check, the supporting tables, the broadened tests. Less novelty, more consistency.

### Artifact 3.1 — `approved_models` table and seed process

**Prompt:**
> Produce the Terraform DDL for an `approved_models` BigQuery table and a scheduled load process from a Google Sheet. Columns: `provider` (STRING), `family` (STRING), `version` (STRING), `status` (STRING, enum: approved/deprecated/sunset), `sunset_date` (DATE, nullable), `notes` (STRING, nullable), `last_updated` (TIMESTAMP). Primary key is conceptually (provider, family, version). The Sheet is the source of truth — non-engineers edit it. A daily Cloud Scheduler job triggers a Cloud Function (or BigQuery scheduled query if simpler) that loads the Sheet into the table. Include the Terraform for both the table and the scheduled load. Document who has Sheet edit access and how that's managed.

### Artifact 3.2 — Model integrity check

**Prompt:**
> Produce the model integrity check in Python, following the same shape as the attached connectivity check. Verdicts: approved | deprecated | sunset_imminent | unknown. Logic: read the model's provider/family/version from the agent record (or operational config — match where they actually live per the ADR), look up in the `approved_models` table via an `ApprovedModelsStore` you'll need to design, return verdict. `sunset_imminent` is when sunset_date is within 30 days (configurable). `unknown` is when no matching row exists. Include unit tests with a fake ApprovedModelsStore. Place in `src/health_check/checks/model_integrity.py`.

### Artifact 3.3 — `agent_rag_config` table

**Prompt:**
> Produce the Terraform DDL for the `agent_rag_config` BigQuery table. Columns: `agent_id` (STRING, NOT NULL), `vector_store_type` (STRING, enum: vertex_ai_search/matching_engine/pinecone/weaviate), `vector_store_resource` (STRING), `last_refresh_at` (TIMESTAMP), `freshness_threshold_days` (INT64), `source_corpus_refs` (ARRAY<STRING>), `refresh_job_ref` (STRING, nullable), `created_at` (TIMESTAMP), `updated_at` (TIMESTAMP). One row per RAG agent — non-RAG agents have no row. Primary key is conceptually `agent_id`.

### Artifact 3.4 — Knowledge freshness check

**Prompt:**
> Produce the knowledge freshness check in Python, following the same shape as the connectivity and model integrity checks. Verdicts: fresh | stale | refresh_overdue | not_applicable. The check only applies to RAG agents — return `not_applicable` for any other agent_type. Logic: read `last_refresh_at` and `freshness_threshold_days` from RAG config, compute age in days, classify (fresh: < threshold, stale: between threshold and 1.5x threshold, refresh_overdue: > 1.5x threshold). If RAG config is missing for an agent typed as RAG, that's a verdict reason: "missing_rag_config", verdict `unknown`. Include unit tests. Place in `src/health_check/checks/knowledge_freshness.py`.

---

## Phase 4 — Close the loop

**Produce** The pieces that turn findings from data into action. Pub/Sub topic, subscriber, dashboard, runner self-observability.

### Artifact 4.1 — Pub/Sub publishing

**Prompt:**
> Modify the orchestrator to publish a Pub/Sub message for each failure verdict. Failure verdicts are: auth_fail, unreachable, latency_fail, deprecated, sunset_imminent, refresh_overdue. Message payload (JSON): finding_id, run_id, agent_id, check_name, verdict, verdict_reason, owner_email (looked up from registry), environment, run_at, link_to_runbook (template URL). Use `google-cloud-pubsub`. Publish should be best-effort — log a warning on publish failure but don't fail the check. Include the Terraform for the Pub/Sub topic and a dead-letter topic for failed deliveries. Update tests.

### Artifact 4.2 — Email subscriber Cloud Function

**Prompt:**
> Produce a Python Cloud Function that subscribes to the Pub/Sub topic and sends an email. Use SendGrid (or Gmail API if simpler in our environment). Email format: subject "[Health Check Alert] <verdict> on <agent_id>", body includes all message fields and the runbook link. Recipient is `owner_email` from the message. Include the Terraform: Cloud Function, IAM bindings, secret for SendGrid API key. Include a unit test using a mocked email client. Document how to test end-to-end (publish a test message, verify email arrives).

### Artifact 4.3 — Looker Studio dashboard

**Prompt:**
> Produce a specification (not the dashboard itself — Looker Studio is built in the UI) for a Looker Studio dashboard over the `health_check_findings` BigQuery table. Three views: (1) current status by agent — pivot of latest verdict per (agent_id, check_name), color-coded, (2) failures in last 24h — table of all failure verdicts with timestamps and owners, (3) failure trend over time — line chart of failure count per day, broken out by check_name. Include the BigQuery views or queries that back each visualization. Document who has access and how to share. Include screenshots of what the finished dashboard should look like (described, not actual images).

### Artifact 4.4 — Runner self-observability

**Prompt:**
> Produce the runner self-observability layer. Two parts: (1) structured logging — every log line from the orchestrator and checks should be JSON with `severity`, `run_id`, `agent_id`, `check_name`, `verdict`, `latency_ms`, `message`, automatically picked up by Cloud Logging, (2) a Cloud Monitoring alert policy that fires if no successful orchestrator run has completed in the last 90 minutes (allowing a 30-minute grace period for the hourly schedule). Include the Terraform for the alert policy and notification channel (email to my address). Document what each alert means and the response.

---

## Phase 5 — Document and harden

**Produce** The artifacts that let other people use what you built. This phase is mostly writing — the most undervalued and most important phase.

### Artifact 5.1 — Runbook

**Prompt:**
> Produce a runbook for the agent health check framework. One section per verdict that requires action: auth_fail, unreachable, latency_fail, deprecated, sunset_imminent, refresh_overdue. Each section answers: What does this verdict mean? What's the likely cause? What should the on-call person check first? Who is accountable for fixing it? When can it be safely ignored or muted? Include also: how to mute alerts for an agent (set `lifecycle_status` to retired or remove the check from `checks_enabled`), how to manually trigger a check run for one agent, how to query findings history. Format: markdown, organized for fast lookup during an incident. Audience: someone who has never seen this system before, called at 2am.

### Artifact 5.2 — Onboarding guide

**Prompt:**
> Produce an onboarding guide for adding a new agent to the health check framework. Sections: prerequisites (agent must exist in registry, owner must have access), required information (endpoint URL, auth method, credential to store in Secret Manager, relevant thresholds, which checks apply), step-by-step process (store credential, add row to `agent_operational`, if RAG add row to `agent_rag_config`, verify within next hourly run, troubleshoot if checks fail), examples for each agent_type. Include a one-page quick-reference card at the top. Audience: a developer onboarding their first agent.

### Artifact 5.3 — Final ADR consolidation

**Prompt:**
> Review the attached existing ADRs and the work that actually got built. Identify decisions made during implementation that aren't yet captured in an ADR. Common candidates: choice of Python framework, choice of Terraform vs alternative, choice of BigQuery vs Postgres, the operational config table design, the column-vs-JSON discipline in findings, the credential resolver caching strategy, the Pub/Sub topology. For each, produce a brief retroactive ADR following the same format as the existing ones. Mark them as "Accepted (retroactive)" so future readers know they were captured after the fact.

### Artifact 5.4 — Repo README (final)

**Prompt:**
> Update the project README based on the finished system. Sections: what this is, current status (Production), architecture overview (one diagram in mermaid or ascii), how it works at a high level, key documents (link to runbook, onboarding guide, ADRs, specs), how to develop locally, how to deploy, how to monitor, who to contact. Replace the Phase 0 README I attach. Tone: clear, professional, assumes a software engineer audience but not a domain expert.

---

## A note on using these prompts

A few things that will make the output dramatically better:

**Always attach prior artifacts.** When the prompt says "attach the X spec," it means literally paste the spec into the conversation. AI assistants produce code that fits into a system when they can see the system. Without context, you get generic output that requires significant editing.

**Read the output skeptically.** AI-generated code is a starting point, not a finished product. Read every line. Question every choice. Ask "why this and not that?" when something feels off. The goal is not to ship what comes out — it's to use the output as a draft and improve it.

**Iterate on the prompt itself.** If the first output isn't right, the prompt was wrong. Adjust the prompt, don't just edit the output. This is the skill that makes AI-assisted development fast.

**Match the artifact to your phase.** Producing a Phase 4 artifact while you're in Phase 1 is a waste. The sequencing exists for a reason — earlier artifacts inform later ones, and skipping ahead means rewriting later.

**Don't produce artifacts you don't need.** This guide lists what a *typical* developer produces. Your project may not need every one. The right number of ADRs is "enough to capture decisions someone will ask about later," not "one per artifact in the guide."

---

## What you're actually doing

The pattern across all of these: a real developer doesn't produce these artifacts because a checklist says to. They produce them because each one solves a problem — capturing a decision, enabling someone else to onboard, catching a regression, communicating progress, surviving a 2am page. When you find yourself producing an artifact and can't articulate the problem it solves, that's a signal to skip it.

Conversely: when you find yourself wishing you had something — "I wish I'd written down why we chose X," "I wish there was a runbook" — that's a signal to produce it, even if no checklist mentioned it.

This is the meta-skill. The artifacts are downstream of it.
