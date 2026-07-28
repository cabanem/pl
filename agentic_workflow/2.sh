#!/usr/bin/env bash
# =============================================================================
# path2_secret_manager.sh — Cloud SQL built-in user + Secret Manager
#
# Usage (from Cloud Shell):
#   ./path2_secret_manager.sh setup    # password → secret, db user, accessor bindings
#   ./path2_secret_manager.sh verify   # read secret + log in with it + smoke DDL
#
# Elements this path requires instead of IAM auth:
#   1. a generated password that never touches disk or shell history
#   2. the secret + a version holding it
#   3. a built-in Postgres user carrying that password
#   4. roles/secretmanager.secretAccessor for each runtime SA (on the SECRET,
#      not the project — least privilege)
#   5. the same in-database grants as path 1 (authorization never moved)
#
# Assumes the instance already exists (Phase 0). Idempotent: safe to re-run.
# =============================================================================
set -euo pipefail

# ---- config (override via env) ----------------------------------------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
INSTANCE="${INSTANCE:-agentgraph}"
DB_NAME="${DB_NAME:-agentgraph}"
DB_USER="${DB_USER:-app}"
SECRET="${SECRET:-agentgraph-db-password}"
PROXY_VERSION="${PROXY_VERSION:-v2.15.1}"   # bump to current before running
PROXY_PORT="${PROXY_PORT:-5433}"

SA_API="sa-agent-api@${PROJECT_ID}.iam.gserviceaccount.com"
SA_RUNNER="sa-agent-runner@${PROJECT_ID}.iam.gserviceaccount.com"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -n "$PROJECT_ID" ]] || die "no project set (gcloud config set project ...)"
gcloud sql instances describe "$INSTANCE" --format='value(name)' >/dev/null \
  || die "instance '$INSTANCE' not found — run Phase 0 first"

CONN_NAME="$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')"

ensure_proxy() {
  if [[ ! -x ./cloud-sql-proxy ]]; then
    echo ">> downloading cloud-sql-proxy ${PROXY_VERSION}"
    curl -sSLo cloud-sql-proxy \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
    chmod +x cloud-sql-proxy
  fi
}

start_proxy() {
  ensure_proxy
  ./cloud-sql-proxy --port "$PROXY_PORT" "$CONN_NAME" >/tmp/proxy.log 2>&1 &
  PROXY_PID=$!
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 15); do
    pg_isready -h 127.0.0.1 -p "$PROXY_PORT" >/dev/null 2>&1 && return 0
    sleep 1
  done
  cat /tmp/proxy.log; die "proxy did not become ready"
}

# =============================================================================
setup() {
  # -- elements 1+2: password lives ONLY in this process + the secret --------
  if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
    echo ">> secret exists — reusing current version"
    PW="$(gcloud secrets versions access latest --secret="$SECRET")"
  else
    echo ">> generating password and creating secret"
    PW="$(openssl rand -base64 33 | tr -d '/+=' | head -c 32)"
    gcloud secrets create "$SECRET" --replication-policy=automatic
    printf '%s' "$PW" | gcloud secrets versions add "$SECRET" --data-file=-
  fi

  # -- element 3: built-in user, password synced to the secret ---------------
  if gcloud sql users list --instance="$INSTANCE" --format='value(name)' \
       | grep -qx "$DB_USER"; then
    gcloud sql users set-password "$DB_USER" --instance="$INSTANCE" --password="$PW"
    echo ">> user '${DB_USER}' password re-synced to secret"
  else
    gcloud sql users create "$DB_USER" --instance="$INSTANCE" --password="$PW"
    echo ">> user '${DB_USER}' created"
  fi

  # -- element 4: accessor on the secret itself, per SA ----------------------
  for sa in "$SA_API" "$SA_RUNNER"; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
      --member="serviceAccount:${sa}" \
      --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  done
  echo ">> secretAccessor bound for both runtime SAs"

  # -- element 5: same in-DB grants as path 1 --------------------------------
  echo ">> connecting as 'postgres' to apply grants"
  read -rs -p "postgres admin password: " PGADMIN_PW; echo
  start_proxy
  PGPASSWORD="$PGADMIN_PW" psql \
    "host=127.0.0.1 port=${PROXY_PORT} dbname=${DB_NAME} user=postgres sslmode=disable" <<SQL
DO \$\$ BEGIN CREATE ROLE app_rw NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
GRANT CONNECT, CREATE ON DATABASE ${DB_NAME} TO app_rw;
GRANT USAGE, CREATE ON SCHEMA public TO app_rw;
GRANT app_rw TO ${DB_USER};
SQL
  echo ">> setup complete"
}

# =============================================================================
verify() {
  echo ">> can I read the secret as ${USER}@cloudshell?"
  PW="$(gcloud secrets versions access latest --secret="$SECRET")" \
    || die "cannot access secret — need secretAccessor (or owner) yourself"
  echo "   yes (length: ${#PW})"

  echo ">> checking SA accessor bindings on the secret"
  gcloud secrets get-iam-policy "$SECRET" \
    --flatten='bindings[].members' \
    --filter='bindings.role:secretmanager.secretAccessor' \
    --format='value(bindings.members)' | sed 's/^/   /'

  echo ">> logging in as '${DB_USER}' with the secret's value"
  start_proxy
  PGPASSWORD="$PW" psql \
    "host=127.0.0.1 port=${PROXY_PORT} dbname=${DB_NAME} user=${DB_USER} sslmode=disable" \
    -v ON_ERROR_STOP=1 <<'SQL'
SELECT current_user AS logged_in_as;
CREATE TABLE IF NOT EXISTS secret_access_smoke(id int);
INSERT INTO secret_access_smoke VALUES (1);
DROP TABLE secret_access_smoke;
SQL
  echo ">> PASS: secret read + password login + CREATE/INSERT/DROP all work"
}

case "${1:-}" in
  setup)  setup ;;
  verify) verify ;;
  *) echo "usage: $0 {setup|verify}"; exit 1 ;;
esac
