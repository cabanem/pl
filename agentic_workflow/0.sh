#!/usr/bin/env bash
# =============================================================================
# phase0_setup.sh — foundations: APIs, service accounts, registry, Cloud SQL
#
# Usage (from Cloud Shell):
#   ./phase0_setup.sh
#
# Creates (idempotently — safe to re-run):
#   1. required service APIs
#   2. sa-agent-api and sa-agent-runner service accounts
#   3. an Artifact Registry docker repo
#   4. the Cloud SQL Postgres instance  (~10 min on first run)
#   5. the application database
#
# Deliberately NOT here: IAM role bindings and database users/grants — those
# belong to the auth path you choose (path1_iam_auth.sh / path2_secret_manager.sh),
# whose `verify` mode is this phase's exit test.
# =============================================================================
set -euo pipefail

# ---- config (override via env) ----------------------------------------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-east1}"          # co-locate Run + SQL + Vertex here
INSTANCE="${INSTANCE:-agentgraph}"
DB_NAME="${DB_NAME:-agentgraph}"
PG_VERSION="${PG_VERSION:-POSTGRES_16}"
TIER="${TIER:-db-f1-micro}"           # cheapest shared-core; no SLA — fine for
                                      # build-out. Real use: db-custom-1-3840.
AR_REPO="${AR_REPO:-agent-graph}"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -n "$PROJECT_ID" ]] || die "no project set (gcloud config set project ...)"
echo ">> project=${PROJECT_ID} region=${REGION}"

# ---- 1. APIs ----------------------------------------------------------------
echo ">> enabling APIs (no-op if already on)"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  pubsub.googleapis.com \
  cloudscheduler.googleapis.com \
  aiplatform.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com

# ---- 2. service accounts ----------------------------------------------------
for sa in sa-agent-api sa-agent-runner; do
  if gcloud iam service-accounts describe \
       "${sa}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    echo ">> SA ${sa} exists"
  else
    gcloud iam service-accounts create "$sa" --display-name="$sa"
    echo ">> SA ${sa} created"
  fi
done

# ---- 3. Artifact Registry ---------------------------------------------------
if gcloud artifacts repositories describe "$AR_REPO" \
     --location="$REGION" >/dev/null 2>&1; then
  echo ">> AR repo ${AR_REPO} exists"
else
  gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker --location="$REGION" \
    --description="agent-graph images"
  echo ">> AR repo ${AR_REPO} created"
fi

# ---- 4. Cloud SQL instance --------------------------------------------------
if gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  echo ">> instance ${INSTANCE} exists"
else
  # This password is the 'postgres' admin — the auth scripts prompt for it
  # when applying in-database grants. Pick it here, remember it.
  read -rs -p "choose a password for the 'postgres' admin user: " ROOT_PW; echo
  [[ -n "$ROOT_PW" ]] || die "empty admin password"
  echo ">> creating instance (takes ~10 minutes)..."
  gcloud sql instances create "$INSTANCE" \
    --database-version="$PG_VERSION" \
    --region="$REGION" \
    --tier="$TIER" \
    --storage-size=10GB \
    --storage-auto-increase \
    --root-password="$ROOT_PW"
  echo ">> instance created"
fi

# ---- 5. application database ------------------------------------------------
if gcloud sql databases describe "$DB_NAME" --instance="$INSTANCE" >/dev/null 2>&1; then
  echo ">> database ${DB_NAME} exists"
else
  gcloud sql databases create "$DB_NAME" --instance="$INSTANCE"
  echo ">> database ${DB_NAME} created"
fi

# ---- summary ----------------------------------------------------------------
CONN_NAME="$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')"
cat <<EOF

============================================================
Phase 0 complete.
  connection name : ${CONN_NAME}
  database        : ${DB_NAME}

Exit test = pick an auth path and run its verify:
  ./path1_iam_auth.sh setup && ./path1_iam_auth.sh verify
  ./path2_secret_manager.sh setup && ./path2_secret_manager.sh verify
============================================================
EOF
