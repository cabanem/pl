Yes — all four, though unevenly: the Makefile changes materially, `.gitignore` and `cloudbuild.yaml` meaningfully, `pyproject.toml` trivially. Updated versions, with the reasoning where it's non-obvious:

**`Makefile`** — the big one: the local/cloud test split, and `derive-fixture` completely rewired (old version pointed at `acquisition/derive.py` with a `--out facts.db` flag that no longer describes reality — `derive.py` reads from GCS and writes to a dataset, so the fixture must be *staged* first):

```makefile
.PHONY: setup test test-bq derive-fixture eval lint scan-secrets

# Dev-project coordinates — override via environment as needed
DEV_BUCKET      ?= wwi-dev-snapshots
FIXTURE_PREFIX  ?= fixtures
FIXTURE_DATASET ?= wwi_fixture

setup:
	python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt

lint:
	.venv/bin/ruff check . && .venv/bin/pyright

# LOCAL loop — no cloud, no credentials of any kind
test:
	.venv/bin/pytest tests/ -x -q --ignore=tests/views --ignore=tests/check_manifest.py

# Stage the committed fixture snapshot to the dev bucket, derive into wwi_fixture
derive-fixture:
	gcloud storage rsync fixtures/snapshot "gs://$(DEV_BUCKET)/$(FIXTURE_PREFIX)" --recursive
	.venv/bin/python bin/derive.py \
	  --bucket  "$(DEV_BUCKET)" \
	  --prefix  "$(FIXTURE_PREFIX)" \
	  --dataset "$(FIXTURE_DATASET)" \
	  --source  fixture

# DEV DATASET loop — needs ambient ADC; still Workato-credential-free (R2)
test-bq: derive-fixture
	.venv/bin/python tests/check_manifest.py --dataset "$(FIXTURE_DATASET)"
	.venv/bin/pytest tests/views -x -q

eval:
	@echo "eval harness lands at M2 (C4)" && exit 1

scan-secrets:
	gitleaks detect --source . --no-banner
```

(`test-bq` depending on `derive-fixture` means the manifest check always measures a derive that just happened — that's the manifest-identity test doing its job, not overhead. `--source fixture` assumes derive.py's `--source` accepts it like `scheduled`; confirm against the actual flag when seeding the repo.)

**`cloudbuild.yaml`** — gains the dev-dataset step, using the cloud-sdk image because staging needs the `gcloud` CLI and Cloud Build's own identity handles auth ambiently — the no-secrets payoff in practice:

```yaml
steps:
  - id: lint-and-test
    name: python:3.12-slim
    entrypoint: bash
    args:
      - -c
      - |
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
