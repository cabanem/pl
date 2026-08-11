#!/usr/bin/env bash
# ==============================================================================
# preflight.sh — SDC Corpus Agent: session preflight (READ-ONLY, always safe)
#
# Run at the start of every work session:   ./preflight.sh [--ui] [--live]
#
# Verifies the full prerequisite chain and prints a fix for every failure.
# Creates nothing, grants nothing, writes nothing. The provisioners
# (phase0.sh, deploy.sh) create state; this script only proves it.
#
#   (default)  tooling, session env, credential planes, GCP chain, artifacts
#   --ui       adds the UI tier (chainlit, ui/ files, IAP consent brand)
#   --live     adds one tiny Gemini call (costs a few tokens; proves Vertex
#              end-to-end under the SA)
# ==============================================================================
set -uo pipefail    # deliberately no -e: we want to reach the end and summarize

PASS=0; FAIL=0; WARN=0
ok()   { printf '  ok    %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"; FAIL=$((FAIL+1)); }
warn() { printf '  warn  %s\n' "$1"; [ -n "${2:-}" ] && printf '        note: %s\n' "$2"; WARN=$((WARN+1)); }
have() { command -v "$1" >/dev/null 2>&1; }

UI=0; LIVE=0
for a in "$@"; do case "$a" in --ui) UI=1;; --live) LIVE=1;; esac; done

echo "== 1. Tooling =="
have python3 && ok "python3 $(python3 -V 2>&1 | cut -d' ' -f2)" \
  || bad "python3 missing" "install Python 3.9+"
have gcloud && ok "gcloud present" \
  || bad "gcloud missing" "run this in Cloud Shell, or install the SDK"
if have sqlite3; then
  SV="$(sqlite3 --version | cut -d' ' -f1)"
  case "$SV" in
    3.3[9-9]*|3.4*|3.5*|4.*) ok "sqlite3 ${SV} (FULL OUTER JOIN ok)";;
    *) warn "sqlite3 ${SV} < 3.39" "drift queries use FULL OUTER JOIN; use LEFT JOIN + UNION shims or upgrade";;
  esac
else
  bad "sqlite3 CLI missing" "sudo apt-get install -y sqlite3"
fi
python3 - <<'PY' 2>/dev/null && ok "google-genai importable" || warn "google-genai not importable" "source ~/corpus-venv/bin/activate  (only --fake works without it)"
import google.genai
PY

echo "== 2. Session environment =="
for V in PROJECT_ID SA_EMAIL BUCKET SECRET MODEL; do
  VAL="${!V:-}"
  if [ -z "$VAL" ]; then
    bad "$V unset" "run the session prelude in GUIDE.md"
  elif [ "$V" = "SA_EMAIL" ]; then
    # The stripped-hyphen trap: an empty prefix var leaves '-name@...' or '@...'
    case "$VAL" in
      -*|@*) bad "SA_EMAIL looks truncated: '$VAL'" "a composing variable was unset — paste the literal email";;
      *@*.iam.gserviceaccount.com) ok "SA_EMAIL=$VAL";;
      *) warn "SA_EMAIL='$VAL' doesn't look like an SA email" "expected <name>@<project>.iam.gserviceaccount.com";;
    esac
  else
    ok "$V=$VAL"
  fi
done

echo "== 3. Credential planes =="
[ -n "${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:-}" ] \
  && warn "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT is exported (${CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT})" \
          "this OVERRIDES gcloud config; provisioners cannot suspend it — unset unless deliberate"
[ -n "${DEPLOY_SA:-}" ] \
  && warn "DEPLOY_SA is exported (${DEPLOY_SA})" \
          "deploy.sh will enter choreography mode; unset if you deploy as yourself"
if have gcloud; then
  ACCT="$(gcloud config get-value account 2>/dev/null)"
  [ -n "$ACCT" ] && ok "gcloud account: $ACCT" || bad "no gcloud account" "gcloud auth login"
  IMP="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null)"
  if [ -n "$IMP" ] && [ "$IMP" = "${SA_EMAIL:-}" ]; then
    ok "gcloud CLI plane impersonates the SA"
  else
    bad "gcloud CLI plane not impersonating (${IMP:-none})" \
        "gcloud config set auth/impersonate_service_account \${SA_EMAIL}"
  fi
  ADC="${HOME}/.config/gcloud/application_default_credentials.json"
  if [ -f "$ADC" ]; then
    grep -q impersonated_service_account "$ADC" \
      && ok "ADC plane is impersonated (client libraries act as the SA)" \
      || warn "ADC exists but is NOT impersonated" \
              "gcloud auth application-default login --impersonate-service-account=\${SA_EMAIL}"
  else
    bad "no ADC file" "gcloud auth application-default login --impersonate-service-account=\${SA_EMAIL}"
  fi
fi

echo "== 4. GCP chain (read-only probes, as the SA) =="
if have gcloud && [ -n "${SA_EMAIL:-}" ]; then
  gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1 \
    && ok "SA exists" || bad "SA not found: ${SA_EMAIL}" "check the name / project"
  if [ -n "${SECRET:-}" ]; then
    HEAD="$(gcloud secrets versions access latest --secret="${SECRET}" 2>/dev/null | head -c 4)"
    [ -n "$HEAD" ] && ok "secret readable (token present)" \
      || bad "cannot read secret '${SECRET}'" "check impersonation + secretAccessor grant; re-run phase0.sh"
  fi
  if [ -n "${BUCKET:-}" ]; then
    if gcloud storage ls "${BUCKET}/" >/dev/null 2>&1; then
      ok "bucket reachable"
      AGE="$(gcloud storage ls -l "${BUCKET}/artifacts/facts.db" 2>/dev/null | awk 'NR==1{print $2}')"
      if [ -n "$AGE" ]; then
        ok "artifacts/facts.db present (uploaded ${AGE})"
      else
        warn "no artifacts/facts.db in bucket" "run Phase 1-2 (dump + derive), then upload"
      fi
    else
      bad "bucket unreachable: ${BUCKET}" "check name + objectAdmin grant; re-run phase0.sh"
    fi
  fi
fi

echo "== 5. Repo files =="
for F in corpus.py agent.py BRIEF.md derive.py dump_recipes.py schema.sql schema_catalog.sql; do
  [ -f "$F" ] && ok "$F" || warn "$F missing here" "fine if you're in a different directory on purpose"
done
[ -f facts.db ] && ok "local facts.db present" \
  || warn "no local facts.db" "gcloud storage cp \${BUCKET}/artifacts/facts.db ."
[ -n "${WORKATO_API_TOKEN:-}" ] \
  && warn "WORKATO_API_TOKEN is exported in this shell" \
          "prefer per-command fetch so it can't go stale after rotation" \
  || ok "no long-lived Workato token in the environment"

if [ "$UI" = 1 ]; then
  echo "== 6. UI tier =="
  python3 - <<'PY' 2>/dev/null && ok "chainlit importable" || bad "chainlit not importable" "pip install chainlit (in the venv)"
import chainlit
PY
  for F in ui/app.py ui/deploy.sh ui/Dockerfile ui/requirements.txt; do
    [ -f "$F" ] && ok "$F" || bad "$F missing" "re-assemble the ui/ bundle"
  done
  if have gcloud; then
    gcloud services list --enabled --filter="name:run.googleapis.com" \
      --format='value(config.name)' 2>/dev/null | grep -q run \
      && ok "Cloud Run API enabled" || warn "Cloud Run API not enabled" "deploy.sh section 1 enables it"
    BRANDS="$(gcloud iap oauth-brands list --format='value(name)' 2>/dev/null | head -1)"
    [ -n "$BRANDS" ] && ok "OAuth consent brand exists (IAP-ready)" \
      || warn "no OAuth consent brand" "create the consent screen (Internal) once, in Console, before IAP"
  fi
fi

if [ "$LIVE" = 1 ]; then
  echo "== 7. Live model probe (costs a few tokens) =="
  python3 - "$@" <<'PY' && ok "Gemini reachable as the SA" || bad "Gemini call failed" "check MODEL id, aiplatform.user grant, and ADC impersonation"
import os
from google import genai
c = genai.Client(vertexai=True, project=os.environ["PROJECT_ID"],
                 location=os.environ.get("LOCATION", "global"))
r = c.models.generate_content(model=os.environ["MODEL"], contents="Reply: ok")
assert r.text
PY
fi

echo
echo "== Summary: ${PASS} ok, ${WARN} warn, ${FAIL} FAIL =="
[ "$FAIL" -eq 0 ] && echo "Preflight clean — fly." || echo "Fix the FAILs above before proceeding."
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
