## Phase 0 — Local scaffold (no cloud, no credentials)

**1. Create the skeleton** exactly per the AGENTS.md repo map, so the map is true from commit one:

```bash
mkdir workato-workspace-inspector && cd $_
git init
mkdir -p acquisition agent fixtures/snapshot tests/views eval/calibration
touch schema.sql Makefile cloudbuild.yaml
```

Drop in the three documents — `AGENTS.md`, `SOLUTION_DESIGN.md`, `DEVELOPMENT_INFRASTRUCTURE.md` — at the root.

**2. Environment:**

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install google-adk ruff pyright pytest
pip freeze > requirements.txt
```

(`google-adk` is the ADK package. Freezing the full tree rather than hand-listing top-level deps is the right call here specifically because agents will run `make setup` — you want their environment bit-identical to yours, not "compatible.")

**3. `.gitignore`** — the one entry that's load-bearing is `*.db`: derived databases are build products, never committed. Also `.venv/`, `__pycache__/`, `.env`, and `snapshots/` if you ever derive locally from real data.

**4. The Makefile** — this is C6, and worth writing before there's much for it to do, because every later step lands as a target:

```makefile
.PHONY: setup test derive-fixture eval lint scan-secrets

setup:
	python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt

lint:
	.venv/bin/ruff check . && .venv/bin/pyright

test:
	.venv/bin/pytest tests/ -x -q

derive-fixture:
	.venv/bin/python acquisition/derive.py fixtures/snapshot --out fixtures/facts.db
	.venv/bin/python tests/check_manifest.py

eval:
	@echo "eval harness lands at M2" && exit 1

scan-secrets:
	gitleaks detect --source . --no-banner
```

Targets that don't exist yet fail loudly rather than silently succeeding — an agent running `make eval` prematurely should hit a wall, not a no-op. Adjust `derive-fixture`'s invocation to match `derive.py`'s actual CLI when you copy it in.

**5. Tool config** — a minimal `pyproject.toml` used purely for tool settings (packaging stays with requirements.txt):

```toml
[tool.ruff]
target-version = "py312"
line-length = 100

[tool.pyright]
pythonVersion = "3.12"
typeCheckingMode = "standard"
```

Decide strictness *now*, once — this is the "configured standards vs remembered standards" purchase from C10.

**6. First commit.** Docs, skeleton, Makefile, configs. Nothing runs yet; that's fine — the fences exist before the workers arrive.

## Phase 1 — Seed the proven code

**7. Copy in** `dump_recipes.py` and `derive.py` (into `acquisition/`) and `schema.sql` (root) from your corpus-agent work. Copy, don't migrate history — the new repo starts clean, and the old repo remains the archaeological record.

**8. Smoke it:** run `derive.py` against one of your existing real SDC snapshots *locally* (output to a gitignored path) purely to confirm the code survived transplant. `fixtures/` stays empty — populating it is deliberately the first *delegated* task, not a setup step.

## Phase 2 — GCP wiring

**9. Dedicated project.** Given your service-plane/build-plane trap inventory, a fresh project buys you a clean IAM story that's fully yours:

```bash
gcloud projects create wwi-inspector-<suffix> --name="Workspace Inspector"
gcloud config set project wwi-inspector-<suffix>
gcloud services enable cloudbuild.googleapis.com aiplatform.googleapis.com storage.googleapis.com
```

(Plus billing link via console.)

**10. Snapshot bucket, versioned** — versioning is the evidence guarantee, so it's not optional:

```bash
gcloud storage buckets create gs://wwi-snapshots-<suffix> \
  --location=us-east1 --uniform-bucket-level-access
gcloud storage buckets update gs://wwi-snapshots-<suffix> --versioning
```

**11. Connect the repo host to Cloud Build.** Console → Cloud Build → Repositories → connect your host (GitHub and GitLab both work through the same repositories connection flow; note Cloud Source Repositories is closed to new customers, so an external host is the path). Then `cloudbuild.yaml`, honoring the thin-wrapper rule:

```yaml
steps:
  - name: python:3.12-slim
    entrypoint: bash
    args:
      - -c
      - |
        pip install -r requirements.txt
        make lint test
  - name: zricethezav/gitleaks:latest
    entrypoint: gitleaks
    args: ["detect", "--source", ".", "--no-banner"]
```

Create a trigger on push to `main`. Two deliberate omissions: no `make eval` in CI yet (that joins at M2, *and* it's the moment you consciously grant the Cloud Build service account `aiplatform.user` — before then, the build SA needs nothing beyond defaults, which is exactly the credential-minimal posture C8 wants), and no deploy steps (those are M5 decisions).

**12. Local ADK auth**, for when M2 starts — and here your own trap inventory pays out: ADK via Vertex uses the *ADC plane*, so it's `gcloud auth application-default login`, not just `gcloud auth login`. You documented this trap; now you get to walk around it.

## Phase 3 — First delegated task

**13.** Mirror `AGENTS.md` into Antigravity's rules for the workspace, then hand over C1 using the template:

```
Task:               Build the fixture workspace
Objective:          Synthetic sanitized snapshot in fixtures/snapshot exercising every
                    structure derive.py handles (call edges, table reads/writes, both
                    enrichment styles, sidecar guard, UUID-keyed write), plus
                    fixtures/manifest.json with expected row counts.
In scope:           fixtures/, tests/check_manifest.py
Invariants touched: D2 (derive untouched), R2 (synthetic data only — no real names,
                    IDs, or values survive sanitization)
Exit test:          make derive-fixture
Docs:               DEVELOPMENT_INFRASTRUCTURE.md C1 marked built
Out of scope:       Any change to derive.py; if the fixture reveals a derive bug,
                    report it as its own task
```

That task is the whole apparatus in miniature — fences read, exit test run, surprises reported — and when `make derive-fixture` goes green, you'll know the machinery works before anything ambitious rides on it.
