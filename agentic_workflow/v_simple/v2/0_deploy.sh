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
# (Internal type) — IAP requires it to exist; the script tells you if so.#!/usr/bin/env bash
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
# The deploy-plane SA (holds run.builder + deploy perms). The corpus SA stays
# purely runtime — the whole point of the split:
DEPLOY_SA="${DEPLOY_SA:?set DEPLOY_SA to the deployment service account email}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
AS_DEPLOYER=(--impersonate-service-account="${DEPLOY_SA}")

echo "Project : ${PROJECT_ID} (${PROJECT_NUMBER})"
echo "Deploys : ${DEPLOY_SA} (impersonated per-command)"
echo "Runtime : ${SA_EMAIL}"
echo "Service : ${SERVICE} in ${REGION}"
echo "Access  : ${ACCESS_MEMBER}"
echo

# ---- 0a. Identity choreography -----------------------------------------------
# you --tokenCreator--> DEPLOY_SA --deploys--> service --runs as--> CORPUS_SA
# Ambient impersonation (session prelude -> corpus SA) is suspended for this
# provisioner; deploy-plane commands impersonate DEPLOY_SA explicitly.
SAVED_IMP="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
if [ -n "${SAVED_IMP}" ]; then
  echo "[0a] suspending ambient impersonation of ${SAVED_IMP} for this script"
  gcloud config unset auth/impersonate_service_account >/dev/null
  trap "gcloud config set auth/impersonate_service_account '${SAVED_IMP}' >/dev/null; echo '  (impersonation restored)'" EXIT
fi

# Link 1: can you mint tokens for the deploy SA?
gcloud auth print-access-token "${AS_DEPLOYER[@]}" >/dev/null 2>&1 \
  && echo "[0a] link 1 ok: you can impersonate ${DEPLOY_SA}" \
  || { echo "[0a] !! cannot impersonate ${DEPLOY_SA} — need
     roles/iam.serviceAccountTokenCreator on it for $(gcloud config get-value account)"; exit 1; }

# Link 3: does DEPLOY_SA hold a service-plane role? run.builder alone builds
# images but cannot get/create/update services — the classic gap.
if gcloud run services list --region "${REGION}" --limit=1 "${AS_DEPLOYER[@]}" >/dev/null 2>&1; then
  echo "[0a] link 3 ok: ${DEPLOY_SA} can see the service plane"
else
  echo "[0a] !! ${DEPLOY_SA} lacks service-plane permissions (run.builder is
     build-plane only). One complete admin ask breaks the one-error-per-round
     loop:
       gcloud projects add-iam-policy-binding ${PROJECT_ID} \\
         --member=serviceAccount:${DEPLOY_SA} --role=roles/run.sourceDeveloper
       gcloud projects add-iam-policy-binding ${PROJECT_ID} \\
         --member=serviceAccount:${DEPLOY_SA} --role=roles/serviceusage.serviceUsageConsumer
     (or roles/run.admin instead of run.sourceDeveloper, if section 3's IAP
     invoker binding should also automate rather than use its console fallback)"
  exit 1
fi

# Link 2 (the one usually missing): DEPLOY_SA must hold actAs on the runtime SA
# to deploy a service that runs as it. You can self-serve this grant because
# you administer the corpus SA (same path as phase0's tokenCreator grant).
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser" >/dev/null 2>&1 \
  && echo "[0a] link 2 ok: ${DEPLOY_SA} holds actAs on ${SA_EMAIL}" \
  || echo "[0a] !! could not grant actAs — ask an admin to run:
     gcloud iam service-accounts add-iam-policy-binding ${SA_EMAIL} \\
       --member=serviceAccount:${DEPLOY_SA} --role=roles/iam.serviceAccountUser"

# ---- 0. Org-policy preflight (informational — the jumpbox-saga reflex) -------
echo "[0/4] Org policies that could bite (blank = unset, fine):"
for C in run.allowedIngress iam.allowedPolicyMemberDomains; do
  printf '  %s: ' "$C"
  gcloud resource-manager org-policies describe "$C" --project="${PROJECT_ID}" \
    --format='value(listPolicy)' 2>/dev/null || echo "(not readable/unset)"
done

# ---- 1. APIs (tolerant: may already be enabled, or need the deploy SA) -------
echo "[1/4] Enabling APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com 2>/dev/null \
  || gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
       artifactregistry.googleapis.com iap.googleapis.com "${AS_DEPLOYER[@]}" 2>/dev/null \
  || echo "  !! could not enable APIs (fine if already enabled — the deploy
     will tell you; otherwise ask an admin to enable run, cloudbuild,
     artifactregistry, iap)"

# ---- 2. Build + deploy: DEPLOY_SA does both (it holds run.builder) -----------
echo "[2/4] Deploying ${SERVICE} as ${DEPLOY_SA}..."
gcloud run deploy "${SERVICE}" \
  "${AS_DEPLOYER[@]}" \
  --source . \
  --region "${REGION}" \
  --service-account "${SA_EMAIL}" \
  --build-service-account "projects/${PROJECT_ID}/serviceAccounts/${DEPLOY_SA}" \
  --no-allow-unauthenticated \
  --session-affinity \
  --memory 1Gi --cpu 1 --timeout 300 \
  --min-instances 0 --max-instances 3 \
  --set-env-vars "BUCKET=${BUCKET},MODEL=${MODEL},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},LOCATION=global"
# --build-service-account: pins Cloud Build to the deploy SA (run.builder is
# exactly the role prescribed for source-build accounts), sidestepping any
# org constraint on default build identities. --service-account: the service
# RUNS as the corpus SA — runtime scope stays minimal.

# ---- 3. IAP: enable directly on the service, then the two grants -------------
echo "[3/4] IAP (as ${DEPLOY_SA})..."
gcloud run services update "${SERVICE}" --region "${REGION}" --iap "${AS_DEPLOYER[@]}" 2>/dev/null \
  || gcloud beta run services update "${SERVICE}" --region "${REGION}" --iap "${AS_DEPLOYER[@]}" 2>/dev/null \
  || echo "  !! could not enable IAP via CLI — flag may have moved; enable it on
     the service in Console (Cloud Run -> ${SERVICE} -> Security -> IAP).
     If prompted about an OAuth consent screen, create it (Internal type)."

gcloud run services add-iam-policy-binding "${SERVICE}" --region "${REGION}" "${AS_DEPLOYER[@]}" \
  --member="serviceAccount:${IAP_AGENT}" --role="roles/run.invoker" >/dev/null \
  && echo "  IAP service agent granted run.invoker (service-scoped)"

gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service="${SERVICE}" --region="${REGION}" "${AS_DEPLOYER[@]}" \
  --member="${ACCESS_MEMBER}" --role="roles/iap.httpsResourceAccessor" >/dev/null 2>&1 \
  || gcloud beta iap web add-iam-policy-binding \
       --resource-type=cloud-run --service="${SERVICE}" --region="${REGION}" \
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
# The deploy-plane SA (holds run.builder + deploy perms). The corpus SA stays
# purely runtime — the whole point of the split:
DEPLOY_SA="${DEPLOY_SA:?set DEPLOY_SA to the deployment service account email}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
IAP_AGENT="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"
AS_DEPLOYER=(--impersonate-service-account="${DEPLOY_SA}")

echo "Project : ${PROJECT_ID} (${PROJECT_NUMBER})"
echo "Deploys : ${DEPLOY_SA} (impersonated per-command)"
echo "Runtime : ${SA_EMAIL}"
echo "Service : ${SERVICE} in ${REGION}"
echo "Access  : ${ACCESS_MEMBER}"
echo

# ---- 0a. Identity choreography -----------------------------------------------
# you --tokenCreator--> DEPLOY_SA --deploys--> service --runs as--> CORPUS_SA
# Ambient impersonation (session prelude -> corpus SA) is suspended for this
# provisioner; deploy-plane commands impersonate DEPLOY_SA explicitly.
SAVED_IMP="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
if [ -n "${SAVED_IMP}" ]; then
  echo "[0a] suspending ambient impersonation of ${SAVED_IMP} for this script"
  gcloud config unset auth/impersonate_service_account >/dev/null
  trap "gcloud config set auth/impersonate_service_account '${SAVED_IMP}' >/dev/null; echo '  (impersonation restored)'" EXIT
fi

# Link 1: can you mint tokens for the deploy SA?
gcloud auth print-access-token "${AS_DEPLOYER[@]}" >/dev/null 2>&1 \
  && echo "[0a] link 1 ok: you can impersonate ${DEPLOY_SA}" \
  || { echo "[0a] !! cannot impersonate ${DEPLOY_SA} — need
     roles/iam.serviceAccountTokenCreator on it for $(gcloud config get-value account)"; exit 1; }

# Link 2 (the one usually missing): DEPLOY_SA must hold actAs on the runtime SA
# to deploy a service that runs as it. You can self-serve this grant because
# you administer the corpus SA (same path as phase0's tokenCreator grant).
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser" >/dev/null 2>&1 \
  && echo "[0a] link 2 ok: ${DEPLOY_SA} holds actAs on ${SA_EMAIL}" \
  || echo "[0a] !! could not grant actAs — ask an admin to run:
     gcloud iam service-accounts add-iam-policy-binding ${SA_EMAIL} \\
       --member=serviceAccount:${DEPLOY_SA} --role=roles/iam.serviceAccountUser"

# ---- 0. Org-policy preflight (informational — the jumpbox-saga reflex) -------
echo "[0/4] Org policies that could bite (blank = unset, fine):"
for C in run.allowedIngress iam.allowedPolicyMemberDomains; do
  printf '  %s: ' "$C"
  gcloud resource-manager org-policies describe "$C" --project="${PROJECT_ID}" \
    --format='value(listPolicy)' 2>/dev/null || echo "(not readable/unset)"
done

# ---- 1. APIs (tolerant: may already be enabled, or need the deploy SA) -------
echo "[1/4] Enabling APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com 2>/dev/null \
  || gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
       artifactregistry.googleapis.com iap.googleapis.com "${AS_DEPLOYER[@]}" 2>/dev/null \
  || echo "  !! could not enable APIs (fine if already enabled — the deploy
     will tell you; otherwise ask an admin to enable run, cloudbuild,
     artifactregistry, iap)"

# ---- 2. Build + deploy: DEPLOY_SA does both (it holds run.builder) -----------
echo "[2/4] Deploying ${SERVICE} as ${DEPLOY_SA}..."
gcloud run deploy "${SERVICE}" \
  "${AS_DEPLOYER[@]}" \
  --source . \
  --region "${REGION}" \
  --service-account "${SA_EMAIL}" \
  --build-service-account "projects/${PROJECT_ID}/serviceAccounts/${DEPLOY_SA}" \
  --no-allow-unauthenticated \
  --session-affinity \
  --memory 1Gi --cpu 1 --timeout 300 \
  --min-instances 0 --max-instances 3 \
  --set-env-vars "BUCKET=${BUCKET},MODEL=${MODEL},GOOGLE_CLOUD_PROJECT=${PROJECT_ID},LOCATION=global"
# --build-service-account: pins Cloud Build to the deploy SA (run.builder is
# exactly the role prescribed for source-build accounts), sidestepping any
# org constraint on default build identities. --service-account: the service
# RUNS as the corpus SA — runtime scope stays minimal.

# ---- 3. IAP: enable directly on the service, then the two grants -------------
echo "[3/4] IAP (as ${DEPLOY_SA})..."
gcloud run services update "${SERVICE}" --region "${REGION}" --iap "${AS_DEPLOYER[@]}" 2>/dev/null \
  || gcloud beta run services update "${SERVICE}" --region "${REGION}" --iap "${AS_DEPLOYER[@]}" 2>/dev/null \
  || echo "  !! could not enable IAP via CLI — flag may have moved; enable it on
     the service in Console (Cloud Run -> ${SERVICE} -> Security -> IAP).
     If prompted about an OAuth consent screen, create it (Internal type)."

gcloud run services add-iam-policy-binding "${SERVICE}" --region "${REGION}" "${AS_DEPLOYER[@]}" \
  --member="serviceAccount:${IAP_AGENT}" --role="roles/run.invoker" >/dev/null \
  && echo "  IAP service agent granted run.invoker (service-scoped)"

gcloud beta iap web add-iam-policy-binding \
  --resource-type=cloud-run --service="${SERVICE}" --region="${REGION}" "${AS_DEPLOYER[@]}" \
  --member="${ACCESS_MEMBER}" --role="roles/iap.httpsResourceAccessor" >/dev/null 2>&1 \
  || gcloud beta iap web add-iam-policy-binding \
       --resource-type=cloud-run --service="${SERVICE}" --region="${REGION}" \
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
