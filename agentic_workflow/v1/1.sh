#!/usr/bin/env bash
# =============================================================================
# path1_iam_auth.sh — Cloud SQL IAM database authentication (zero secrets)
#
# Usage (from Cloud Shell):
#   ./path1_iam_auth.sh setup    # create/enable all five IAM-auth elements
#   ./path1_iam_auth.sh verify   # prove login + in-DB privileges as YOUR identity
#
# The five elements this covers:
#   1. instance flag  cloudsql.iam_authentication=on
#   2. principals registered as database users
#   3. IAM roles: cloudsql.client + cloudsql.instanceUser
#   4. a connection path that injects OAuth tokens (Auth Proxy --auto-iam-authn)
#   5. in-database grants (the forgotten half): app_rw role pattern
#
# Assumes the instance already exists (Phase 0). Idempotent: safe to re-run.
# =============================================================================
set -euo pipefail

# ---- config (override via env) ----------------------------------------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
INSTANCE="${INSTANCE:-agentgraph}"
DB_NAME="${DB_NAME:-agentgraph}"
PROXY_VERSION="${PROXY_VERSION:-v2.15.1}"   # bump to current before running
PROXY_PORT="${PROXY_PORT:-5433}"

ME="$(gcloud config get-value account 2>/dev/null)"          # your user email
SA_API="sa-agent-api@${PROJECT_ID}.iam.gserviceaccount.com"
SA_RUNNER="sa-agent-runner@${PROJECT_ID}.iam.gserviceaccount.com"

# Postgres-side usernames. Asymmetry worth memorizing:
#   user accounts keep the FULL email; service accounts DROP .gserviceaccount.com
PG_ME="$ME"
PG_API="sa-agent-api@${PROJECT_ID}.iam"
PG_RUNNER="sa-agent-runner@${PROJECT_ID}.iam"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -n "$PROJECT_ID" ]] || die "no project set (gcloud config set project ...)"
gcloud sql instances describe "$INSTANCE" --format='value(name)' >/dev/null \
  || die "instance '$INSTANCE' not found — run Phase 0 first"

CONN_NAME="$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')"

# ---- helpers ----------------------------------------------------------------
ensure_proxy() {
  if [[ ! -x ./cloud-sql-proxy ]]; then
    echo ">> downloading cloud-sql-proxy ${PROXY_VERSION}"
    curl -sSLo cloud-sql-proxy \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
    chmod +x cloud-sql-proxy
  fi
}

start_proxy() {  # $1 = extra flags ("" or --auto-iam-authn)
  ensure_proxy
  ./cloud-sql-proxy $1 --port "$PROXY_PORT" "$CONN_NAME" >/tmp/proxy.log 2>&1 &
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
  # -- element 1: instance flag (NOTE: flag changes RESTART the instance, and
  #    --database-flags REPLACES the whole flag set — if you've added other
  #    flags, include them all here) -----------------------------------------
  if gcloud sql instances describe "$INSTANCE" \
       --format='value(settings.databaseFlags)' | grep -q 'cloudsql.iam_authentication'; then
    echo ">> flag already enabled"
  else
    echo ">> enabling cloudsql.iam_authentication (instance will restart)"
    gcloud sql instances patch "$INSTANCE" \
      --database-flags=cloudsql.iam_authentication=on --quiet
  fi

  # -- element 2: register principals as database users ----------------------
  existing="$(gcloud sql users list --instance="$INSTANCE" --format='value(name)')"
  echo "$existing" | grep -qx "$PG_ME" || \
    gcloud sql users create "$ME" --instance="$INSTANCE" --type=cloud_iam_user
  echo "$existing" | grep -qx "$PG_API" || \
    gcloud sql users create "$SA_API" --instance="$INSTANCE" --type=cloud_iam_service_account
  echo "$existing" | grep -qx "$PG_RUNNER" || \
    gcloud sql users create "$SA_RUNNER" --instance="$INSTANCE" --type=cloud_iam_service_account

  # -- element 3: IAM roles (reaching vs logging in are separate permissions) -
  for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="user:${ME}" --role="$role" --condition=None --quiet >/dev/null
    for sa in "$SA_API" "$SA_RUNNER"; do
      gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${sa}" --role="$role" --condition=None --quiet >/dev/null
    done
  done
  echo ">> IAM roles bound"

  # -- element 5: in-database grants (authorization stays in Postgres) -------
  # Needs the built-in postgres admin once. app_rw membership = the authz surface.
  echo ">> connecting as 'postgres' to apply grants"
  read -rs -p "postgres admin password: " PGADMIN_PW; echo
  start_proxy ""
  PGPASSWORD="$PGADMIN_PW" psql \
    "host=127.0.0.1 port=${PROXY_PORT} dbname=${DB_NAME} user=postgres sslmode=disable" <<SQL
DO \$\$ BEGIN CREATE ROLE app_rw NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
GRANT CONNECT, CREATE ON DATABASE ${DB_NAME} TO app_rw;
GRANT USAGE, CREATE ON SCHEMA public TO app_rw;
GRANT app_rw TO "${PG_ME}";
GRANT app_rw TO "${PG_API}";
GRANT app_rw TO "${PG_RUNNER}";
-- Tables the runner creates (PostgresSaver.setup()) are owned by the runner;
-- this makes them readable/writable by other app_rw members automatically:
ALTER DEFAULT PRIVILEGES FOR ROLE "${PG_RUNNER}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
SQL
  echo ">> setup complete"
}

# =============================================================================
verify() {
  echo ">> checking IAM bindings for ${ME}"
  gcloud projects get-iam-policy "$PROJECT_ID" \
    --flatten='bindings[].members' \
    --filter="bindings.members:user:${ME} AND bindings.role:cloudsql" \
    --format='value(bindings.role)' | sed 's/^/   /'

  echo ">> checking registered database users"
  gcloud sql users list --instance="$INSTANCE" \
    --filter='type:CLOUD_IAM_USER OR type:CLOUD_IAM_SERVICE_ACCOUNT' \
    --format='table(name,type)'

  # element 4 in action: --auto-iam-authn mints/refreshes the OAuth token and
  # presents it as the password — no PGPASSWORD anywhere.
  echo ">> connecting as ${PG_ME} via auto-IAM proxy"
  start_proxy "--auto-iam-authn"
  psql "host=127.0.0.1 port=${PROXY_PORT} dbname=${DB_NAME} user=${PG_ME} sslmode=disable" \
    -v ON_ERROR_STOP=1 <<'SQL'
SELECT current_user AS logged_in_as;
CREATE TABLE IF NOT EXISTS iam_access_smoke(id int);
INSERT INTO iam_access_smoke VALUES (1);
DROP TABLE iam_access_smoke;
SQL
  echo ">> PASS: IAM login + CREATE/INSERT/DROP all work"
  # To test a service account's login instead (needs TokenCreator on the SA):
  #   PGPASSWORD="$(gcloud sql generate-login-token \
  #       --impersonate-service-account=$SA_RUNNER)" \
  #   psql "host=127.0.0.1 port=$PROXY_PORT dbname=$DB_NAME user=$PG_RUNNER sslmode=disable"
  # (run against a plain proxy, NOT --auto-iam-authn)
}

case "${1:-}" in
  setup)  setup ;;
  verify) verify ;;
  *) echo "usage: $0 {setup|verify}"; exit 1 ;;
esac
