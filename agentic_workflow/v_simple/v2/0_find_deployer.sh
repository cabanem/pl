#!/usr/bin/env bash
# ==============================================================================
# find_deployer.sh — who in this project can already deploy to Cloud Run?
#
# READ-ONLY. Mutates nothing, grants nothing. (Token minting generates
# short-lived credentials but changes no state; failed impersonation
# attempts do appear in audit logs — normal, but worth knowing in a shared
# project if a security team reads them.)
#
# Three passes:
#   0. You, directly — maybe the SA dance is unnecessary
#   1. Project IAM policy inversion — who HOLDS deploy-plane roles
#      (skipped gracefully if you can't read the policy; also blind to
#      folder/org-inherited grants, which pass 2 catches)
#   2. Empirical probes — for every project SA: can YOU impersonate it,
#      and can IT see the service plane? Capability tested, not inferred.
#
# Usage:  ./find_deployer.sh          (REGION env overrides us-east1)
# ==============================================================================
set -uo pipefail

PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
REGION="${REGION:-us-east1}"
CANDIDATES=(); ASKABLE=()

# Probes must run as YOU — suspend ambient impersonation, restore on exit.
SAVED_IMP="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
if [ -n "${SAVED_IMP}" ]; then
  gcloud config unset auth/impersonate_service_account >/dev/null
  trap "gcloud config set auth/impersonate_service_account '${SAVED_IMP}' >/dev/null" EXIT
fi

echo "Project: ${PROJECT_ID} (region probe: ${REGION})"

echo
echo "== 0. You, directly =="
if gcloud run services list --region "${REGION}" --limit=1 >/dev/null 2>&1; then
  echo "  ok    YOU have service-plane access — the deploy-SA dance may be"
  echo "        unnecessary: deploy as yourself (actAs on the corpus SA is the"
  echo "        only link needed, and deploy.sh v2's self-grant covered it)"
else
  echo "  info  you cannot see the service plane directly (expected)"
fi

echo
echo "== 1. Project IAM policy inversion =="
POL="$(gcloud projects get-iam-policy "${PROJECT_ID}" --format=json 2>/dev/null || true)"
if [ -n "${POL}" ]; then
  printf '%s' "${POL}" | python3 -c '
import json, sys
WANT = {"roles/owner", "roles/editor", "roles/run.admin",
        "roles/run.sourceDeveloper", "roles/run.developer"}
pol = json.load(sys.stdin)
hits = {}
for b in pol.get("bindings", []):
    if b.get("role") in WANT:
        cond = " (CONDITIONAL — may not apply here)" if b.get("condition") else ""
        for m in b.get("members", []):
            hits.setdefault(m, []).append(b["role"].split("/")[1] + cond)
if not hits:
    print("  none of the deploy-plane roles are bound at project level")
for m, roles in sorted(hits.items()):
    print(f"  holds {', '.join(roles):<40} {m}")
print("  note: folder/org-inherited grants are INVISIBLE here — pass 2 catches them")
'
else
  echo "  warn  cannot read project IAM policy — relying entirely on pass 2"
  echo "        (which also catches inherited grants this pass would miss)"
fi

echo
echo "== 2. Empirical probes over project service accounts =="
SAS="$(gcloud iam service-accounts list --format='value(email)' 2>/dev/null || true)"
if [ -z "${SAS}" ]; then
  echo "  FAIL  cannot list service accounts — ask an admin for the pass-1"
  echo "        output instead (gcloud projects get-iam-policy ${PROJECT_ID})"
else
  while IFS= read -r SA; do
    if gcloud auth print-access-token --impersonate-service-account="${SA}" >/dev/null 2>&1; then
      if gcloud run services list --region "${REGION}" --limit=1 \
           --impersonate-service-account="${SA}" >/dev/null 2>&1; then
        echo "  CANDIDATE  ${SA}   (you can impersonate it AND it sees the service plane)"
        CANDIDATES+=("${SA}")
      else
        echo "  partial    ${SA}   (impersonatable, but no service plane)"
      fi
    else
      echo "  locked     ${SA}   (you cannot impersonate it)"
      ASKABLE+=("${SA}")
    fi
  done <<< "${SAS}"
fi

echo
echo "== Next action =="
if [ "${#CANDIDATES[@]}" -gt 0 ]; then
  echo "  Use it today — no admin needed:"
  echo "    DEPLOY_SA=${CANDIDATES[0]} SA_EMAIL=<corpus-sa> MODEL=... ACCESS_MEMBER=... ./deploy.sh"
  echo "  (courtesy in a shared project: tell that SA's owning team you're using it)"
elif [ -n "${POL}" ]; then
  echo "  Cross-reference pass 1 with the 'locked' list: if a locked SA holds a"
  echo "  deploy role, the targeted ask is ONE grant on ONE SA (easy sell):"
  echo "    gcloud iam service-accounts add-iam-policy-binding <that-sa> \\"
  echo "      --member=user:$(gcloud config get-value account 2>/dev/null) \\"
  echo "      --role=roles/iam.serviceAccountTokenCreator"
else
  echo "  No capable+reachable identity found — the original two-binding ask on"
  echo "  your deploy SA stands (deploy.sh link 3 prints it verbatim)."
fi
