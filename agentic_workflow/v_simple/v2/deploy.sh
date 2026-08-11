#!/usr/bin/env bash
# ==============================================================================
# deploy.sh — SDC Corpus Agent UI: Cloud Run + IAP (shared-project edition)
#
# Idempotent. Deploys the Chainlit app under the EXISTING service account —
# which already holds aiplatform.user, bucket read, and secret access from
# phase0.sh, so the only NEW permissions are IAP plumbing:
#   - the IAP service agent gets run.invoker on this service
#   - your team group gets iap.httpsResourceAccessor (the "may visit" role)
#
# One-time console step if prompted: the project's OAuth consent screen
# (Internal type) — IAP requires it to exist; the script tells you if so.
# ==============================================================================
set -euo pipefail

# ---- Config ------------------------------------------------------------------
PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
REGION="us-east1"
SERVICE="sdc-corpus-ui"
APP="sdc-corpus"
SA_EMAIL="${SA_EMAIL:?set SA_EMAIL to the existing agent service account}"
BUCKET="gs://${APP}-${PROJECT_ID}"
MODEL="${MODEL:?set MODEL to the current Gemini id}"
# Who may open the UI. Prefer a group; a single user works too:
#   ACCESS_MEMBER="group:sdc-team@yourdomain.com"
ACCESS_MEMBER="${ACCESS_MEMBER:?set ACCESS_MEMBER, e.g. group:team@domain or user:you@domain}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"

echo "Project : ${PROJECT_ID} (${PROJECT_NUMBER})"
echo "Service : ${SERVICE} in ${REGION}, running as ${SA_EMAIL}"
echo "Access  : ${ACCESS_MEMBER}"
echo

# ---- 0. Org-policy preflight (informational — the jumpbox-saga reflex) -------
echo "[0/4] Org policies that could bite (blank = unset, fine):"
for C in run.allowedIngress iam.allowedPolicyMemberDomains; do
  printf '  %s: ' "$C"
  gcloud resource-manager org-policies describe "$C" --project="${PROJECT_ID}" \
    --format='value(listPolicy)' 2>/dev/null || echo "(not readable/unset)"
done

# ---- 1. APIs -----------------------------------------------------------------
echo "[1/4] Enabling APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com

# ---- 2. Build + deploy from source (uses the Dockerfile) ---------------------
echo "[2/4] Deploying ${SERVICE}..."
gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --service-account "${SA_EMAIL}" \
  --no-allow-unauthenticated \
  --session-affinity \
  --memory 1Gi --cpu 1 --timeout 300 \
  --min-instances 0 --max-instances 3 \
  --set-env-vars "BUCKET=${BUCKET},MODEL=${MODEL},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},LOCATION=global"
# --session-affinity: Chainlit uses websockets; sticky sessions keep a chat
# pinned to one instance. --no-allow-unauthenticated: nothing gets in except
# via IAP once section 3 lands.

# ---- 3. IAP: enable directly on the service, then the two grants -------------
echo "[3/4] IAP..."
gcloud run services update "${SERVICE}" --region "${REGION}" --iap 2>/dev/null \
  || gcloud beta run services update "${SERVICE}" --region "${REGION}" --iap 2>/dev/null \
  || echo "  !! could not enable IAP via CLI — flag may have moved; enable it on
     the service in Console (Cloud Run -> ${SERVICE} -> Security -> IAP).
     If prompted about an OAuth consent screen, create it (Internal type)."

gcloud run services add-iam-policy-binding "${SERVICE}" --region "${REGION}" \
  --member="serviceAccount:${IAP_AGENT}" --role="roles/run.invoker" >/dev/null \
  && echo "  IAP service agent granted run.invoker (service-scoped)"

gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service="${SERVICE}" --region="${REGION}" \
  --member="${ACCESS_MEMBER}" --role="roles/iap.httpsResourceAccessor" >/dev/null 2>&1 \
  && echo "  ${ACCESS_MEMBER} granted iap.httpsResourceAccessor" \
  || echo "  !! accessor grant via CLI failed — grant '${ACCESS_MEMBER}' the
     'IAP-secured Web App User' role on ${SERVICE} from Console -> Security ->
     Identity-Aware Proxy."

# ---- 4. Summary --------------------------------------------------------------
echo "[4/4] Done."
URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo
echo "Open (as a member of ${ACCESS_MEMBER}): ${URL}"
echo
echo "facts.db refresh after a new derive+upload (instances cache their copy):"
echo "  gcloud run services update ${SERVICE} --region ${REGION} \\"
echo "    --update-env-vars REFRESH=\$(date +%s)     # forces new revision -> fresh cold start"
