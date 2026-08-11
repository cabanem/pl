#!/usr/bin/env bash
# ==============================================================================
# deploy.sh — SDC Corpus Agent UI: Cloud Run + IAP (shared-project edition, v4)
#
# Default identity model (the simple chain, probed before anything runs):
#     you ──deploy/build──▶ service ──runs as──▶ CORPUS_SA ──▶ Vertex/bucket/secret
#
# Optional configuration for locked-down setups:
#   BUILD_SA=<sa>    pin Cloud Build to an SA holding run.builder (use when the
#                    default build identity fails or org policy constrains it)
#   DEPLOY_SA=<sa>   full choreography: impersonate this SA for every deploy-
#                    plane command (use when YOU lack service-plane access —
#                    ./find_deployer.sh discovers whether you do)
#
# Idempotent. Ambient CLI impersonation (session prelude -> corpus SA) is
# always suspended for this provisioner and restored on exit — the corpus SA
# is a runtime identity and must never appear on the deploy plane.
# ==============================================================================
set -euo pipefail

# ---- Config ------------------------------------------------------------------
PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
REGION="us-east1"
SERVICE="sdc-corpus-ui"
APP="sdc-corpus"
SA_EMAIL="${SA_EMAIL:?set SA_EMAIL to the corpus (runtime) service account}"
BUCKET="gs://${APP}-${PROJECT_ID}"
MODEL="${MODEL:?set MODEL to the current Gemini id}"
ACCESS_MEMBER="${ACCESS_MEMBER:?set ACCESS_MEMBER, e.g. group:team@domain or user:you@domain}"
DEPLOY_SA="${DEPLOY_SA:-}"
BUILD_SA="${BUILD_SA:-}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"

AS_DEPLOYER=()
[ -n "${DEPLOY_SA}" ] && AS_DEPLOYER=(--impersonate-service-account="${DEPLOY_SA}")
BUILD_FLAGS=()
[ -n "${BUILD_SA}" ] && BUILD_FLAGS=(--build-service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}")

echo "Project : ${PROJECT_ID} (${PROJECT_NUMBER})"
echo "Deploys : ${DEPLOY_SA:-you ($(gcloud config get-value account 2>/dev/null))}"
echo "Builds  : ${BUILD_SA:-default build identity}"
echo "Runtime : ${SA_EMAIL}"
echo "Service : ${SERVICE} in ${REGION}"
echo "Access  : ${ACCESS_MEMBER}"
echo

# ---- 0a. Identity: suspend ambient impersonation, probe the chain ------------
SAVED_IMP="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
if [ -n "${SAVED_IMP}" ]; then
  echo "[0a] suspending ambient impersonation of ${SAVED_IMP} for this provisioner"
  gcloud config unset auth/impersonate_service_account >/dev/null
  trap "gcloud config set auth/impersonate_service_account '${SAVED_IMP}' >/dev/null; echo '  (impersonation restored)'" EXIT
fi
DEPLOYER_HUMAN="$(gcloud config get-value account 2>/dev/null)"

if [ -n "${DEPLOY_SA}" ]; then
  gcloud auth print-access-token "${AS_DEPLOYER[@]}" >/dev/null 2>&1 \
    && echo "[0a] you can impersonate ${DEPLOY_SA}" \
    || { echo "[0a] !! cannot impersonate ${DEPLOY_SA} — need tokenCreator on it"; exit 1; }
  ACTOR_MEMBER="serviceAccount:${DEPLOY_SA}"
else
  ACTOR_MEMBER="user:${DEPLOYER_HUMAN}"
fi

# Service-plane probe for whoever deploys (fails fast with the fix, never mid-build):
if gcloud run services list --region "${REGION}" --limit=1 "${AS_DEPLOYER[@]}" >/dev/null 2>&1; then
  echo "[0a] deploy identity sees the service plane"
else
  echo "[0a] !! no service-plane access for ${ACTOR_MEMBER}.
     Run ./find_deployer.sh to discover a capable identity, or ask an admin for:
       gcloud projects add-iam-policy-binding ${PROJECT_ID} \\
         --member=${ACTOR_MEMBER} --role=roles/run.sourceDeveloper"
  exit 1
fi

# actAs: whoever deploys must hold serviceAccountUser on the RUNTIME SA.
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="${ACTOR_MEMBER}" --role="roles/iam.serviceAccountUser" >/dev/null 2>&1 \
  && echo "[0a] ${ACTOR_MEMBER} holds actAs on ${SA_EMAIL}" \
  || echo "[0a] !! could not assert actAs (may already exist, or ask an admin:
     gcloud iam service-accounts add-iam-policy-binding ${SA_EMAIL} \\
       --member=${ACTOR_MEMBER} --role=roles/iam.serviceAccountUser)"

# If a build SA is pinned, the deployer also needs actAs on IT:
if [ -n "${BUILD_SA}" ]; then
  gcloud iam service-accounts add-iam-policy-binding "${BUILD_SA}" \
    --member="${ACTOR_MEMBER}" --role="roles/iam.serviceAccountUser" >/dev/null 2>&1 \
    && echo "[0a] ${ACTOR_MEMBER} holds actAs on build SA ${BUILD_SA}" \
    || echo "[0a] !! could not assert actAs on ${BUILD_SA} — ask its owner/admin
     for roles/iam.serviceAccountUser there"
fi

# ---- 0b. Org-policy preflight (informational) --------------------------------
echo "[0b] Org policies that could bite (blank = unset, fine):"
for C in run.allowedIngress iam.allowedPolicyMemberDomains; do
  printf '  %s: ' "$C"
  gcloud resource-manager org-policies describe "$C" --project="${PROJECT_ID}" \
    --format='value(listPolicy)' 2>/dev/null || echo "(not readable/unset)"
done

# ---- 1. APIs (tolerant: may already be enabled) ------------------------------
echo "[1/4] Enabling APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com 2>/dev/null \
  || echo "  !! could not enable APIs (fine if already enabled — the deploy will
     tell you; otherwise ask an admin for run, cloudbuild, artifactregistry, iap)"

# ---- 2. Build + deploy -------------------------------------------------------
echo "[2/4] Deploying ${SERVICE}..."
gcloud run deploy "${SERVICE}" \
  "${AS_DEPLOYER[@]}" \
  "${BUILD_FLAGS[@]}" \
  --source . \
  --region "${REGION}" \
  --service-account "${SA_EMAIL}" \
  --no-allow-unauthenticated \
  --session-affinity \
  --memory 1Gi --cpu 1 --timeout 300 \
  --min-instances 0 --max-instances 3 \
  --set-env-vars "BUCKET=${BUCKET},MODEL=${MODEL},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},LOCATION=global"
# If the BUILD step fails on a build-identity complaint, re-run with
# BUILD_SA=<an SA holding run.builder> — that is exactly what run.builder is for.

# ---- 3. IAP: enable directly on the service, then the two grants -------------
echo "[3/4] IAP..."
gcloud run services update "${SERVICE}" --region "${REGION}" --iap "${AS_DEPLOYER[@]}" 2>/dev/null \
  || gcloud beta run services update "${SERVICE}" --region "${REGION}" --iap "${AS_DEPLOYER[@]}" 2>/dev/null \
  || echo "  !! could not enable IAP via CLI — enable it in Console (Cloud Run ->
     ${SERVICE} -> Security -> IAP). If prompted about an OAuth consent
     screen, create it (Internal type)."

gcloud run services add-iam-policy-binding "${SERVICE}" --region "${REGION}" "${AS_DEPLOYER[@]}" \
  --member="serviceAccount:${IAP_AGENT}" --role="roles/run.invoker" >/dev/null 2>&1 \
  && echo "  IAP service agent granted run.invoker (service-scoped)" \
  || echo "  !! invoker grant failed (needs run.services.setIamPolicy — run.admin
     tier). Console fallback: grant run.invoker to ${IAP_AGENT} on ${SERVICE}."

gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service="${SERVICE}" --region="${REGION}" "${AS_DEPLOYER[@]}" \
  --member="${ACCESS_MEMBER}" --role="roles/iap.httpsResourceAccessor" >/dev/null 2>&1 \
  && echo "  ${ACCESS_MEMBER} granted iap.httpsResourceAccessor" \
  || echo "  !! accessor grant via CLI failed — grant '${ACCESS_MEMBER}' the
     'IAP-secured Web App User' role on ${SERVICE} from Console -> Security ->
     Identity-Aware Proxy."

# ---- 4. Summary --------------------------------------------------------------
echo "[4/4] Done."
URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" "${AS_DEPLOYER[@]}" --format='value(status.url)')"
echo
echo "Open (as a member of ${ACCESS_MEMBER}): ${URL}"
echo
echo "facts.db refresh after a new derive+upload (instances cache their copy):"
echo "  gcloud run services update ${SERVICE} --region ${REGION} \\"
echo "    --update-env-vars REFRESH=\$(date +%s)     # forces new revision -> fresh cold start"
