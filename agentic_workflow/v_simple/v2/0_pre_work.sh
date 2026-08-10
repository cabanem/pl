#!/usr/bin/env bash
# ==============================================================================
# phase0.sh — SDC Corpus Agent: Phase 0 provisioning (shared-project edition)
#
# Idempotent: safe to re-run. Every resource is namespaced under ${APP} so it
# coexists politely with everything else in the team project. The only
# project-level mutations are API enablement and two IAM grants to the
# dedicated service account (Vertex AI has no resource-level IAM).
#
# Identity model:
#   - Your EXISTING service account (set SA_EMAIL below) owns all permissions.
#     The script verifies it exists and audits what it already carries; it
#     does not create SAs. It is the same identity the promoted Cloud Run job
#     will run as later, so the IAM you validate in M1 is what you ship with.
#   - You NEVER download a key. In Cloud Shell you impersonate the SA via
#     short-lived tokens (ADC impersonation), which this script configures.
#
# Roles YOU need to run this successfully (else ask an admin per-section):
#   - roles/serviceusage.serviceUsageAdmin        (section 1: enable APIs)
#   - roles/storage.admin                         (section 3: create bucket)
#   - roles/secretmanager.admin                   (section 4: create secret)
#   - roles/resourcemanager.projects.setIamPolicy (section 5: the two
#     project-level grants — in a shared project this is the one most likely
#     to need an admin; the script prints the exact commands to hand over)
# ==============================================================================
set -euo pipefail

# ---- Config ------------------------------------------------------------------
PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
USER_EMAIL="$(gcloud config get-value account 2>/dev/null)"
APP="sdc-corpus"
REGION="us-east1"                 # bucket location (near you; latency-irrelevant at MB scale)
# Your existing SA. Edit here, or override at invocation:
#   SA_EMAIL=my-existing-sa@project.iam.gserviceaccount.com ./phase0.sh
SA_EMAIL="${SA_EMAIL:-CHANGE_ME@${PROJECT_ID}.iam.gserviceaccount.com}"
BUCKET="gs://${APP}-${PROJECT_ID}"
SECRET="${APP}-workato-token"

echo "Project : ${PROJECT_ID}"
echo "User    : ${USER_EMAIL}"
echo "SA      : ${SA_EMAIL}"
echo "Bucket  : ${BUCKET}"
echo "Secret  : ${SECRET}"
echo

# ---- 1. APIs (no-op for anything already enabled) ----------------------------
echo "[1/6] Enabling APIs..."
gcloud services enable \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com          # required for keyless impersonation

# ---- 2. Existing service account: verify + audit -----------------------------
echo "[2/6] Service account (pre-existing)..."
if [[ "${SA_EMAIL}" == CHANGE_ME@* ]]; then
  echo "  !! SA_EMAIL is unset — edit the config block or pass SA_EMAIL=... "
  exit 1
fi
if ! gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  echo "  !! ${SA_EMAIL} not found in ${PROJECT_ID}. Check the name:"
  echo "     gcloud iam service-accounts list --format='value(email)'"
  exit 1
fi
echo "  found ${SA_EMAIL}"
echo "  project-level roles it ALREADY holds (the agent inherits all of these):"
gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten="bindings[].members" \
  --filter="bindings.members=serviceAccount:${SA_EMAIL}" \
  --format="value(bindings.role)" 2>/dev/null | sed 's/^/     /' \
  || echo "     (could not read project IAM policy — ask an admin for the list)"
KEY_COUNT="$(gcloud iam service-accounts keys list --iam-account="${SA_EMAIL}" \
  --managed-by=user --format='value(name)' 2>/dev/null | wc -l)"
echo "  user-managed keys on this SA: ${KEY_COUNT}"
if [[ "${KEY_COUNT}" -gt 0 ]]; then
  echo "     note: this workload needs none of them (impersonation only) —"
  echo "     once nothing else uses them, they are deletion candidates."
fi

# ---- 3. Bucket: versioned, uniform access, SA scoped to THIS bucket only -----
echo "[3/6] Bucket..."
if ! gcloud storage buckets describe "${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "${BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
  echo "  created ${BUCKET}"
else
  echo "  exists, skipping"
fi
gcloud storage buckets update "${BUCKET}" --versioning
# Resource-level grant: the SA can touch this bucket and nothing else.
gcloud storage buckets add-iam-policy-binding "${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null
echo "  versioning on; SA granted objectAdmin (bucket-scoped)"

# ---- 4. Secret: created empty, token added interactively, SA scoped to it ----
echo "[4/6] Secret..."
if ! gcloud secrets describe "${SECRET}" >/dev/null 2>&1; then
  gcloud secrets create "${SECRET}" --replication-policy="automatic"
  echo "  created ${SECRET}"
else
  echo "  exists, skipping"
fi
if [[ "$(gcloud secrets versions list "${SECRET}" --format='value(name)' | wc -l)" -eq 0 ]]; then
  echo "  Paste your Workato API token (input hidden), then Enter:"
  read -rs WORKATO_TOKEN
  printf '%s' "${WORKATO_TOKEN}" | gcloud secrets versions add "${SECRET}" --data-file=-
  unset WORKATO_TOKEN
  echo "  version 1 added"
else
  echo "  already has a version, skipping token entry"
fi
# Resource-level grant: the SA can read this secret and no others.
gcloud secrets add-iam-policy-binding "${SECRET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null
echo "  SA granted secretAccessor (secret-scoped)"

# ---- 5. The two unavoidable project-level grants -----------------------------
# Vertex AI model calls have no resource-level IAM; serviceUsageConsumer lets
# the impersonated SA bill quota to the project (the classic impersonation 403).
echo "[5/6] Project-level grants for the SA..."
for ROLE in roles/aiplatform.user roles/serviceusage.serviceUsageConsumer; do
  if gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
       --member="serviceAccount:${SA_EMAIL}" \
       --role="${ROLE}" --condition=None >/dev/null 2>&1; then
    echo "  granted ${ROLE}"
  else
    echo "  !! could not grant ${ROLE} — ask an admin to run:"
    echo "     gcloud projects add-iam-policy-binding ${PROJECT_ID} \\"
    echo "       --member=serviceAccount:${SA_EMAIL} --role=${ROLE}"
  fi
done

# ---- 6. Keyless impersonation from Cloud Shell -------------------------------
echo "[6/6] Impersonation setup..."
# Let YOU mint short-lived tokens for the SA (grant is on the SA, not project):
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="user:${USER_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" >/dev/null
echo "  ${USER_EMAIL} can now impersonate ${SA_EMAIL} (this path uses no keys)"
echo
echo "Run this once yourself (interactive browser flow; writes your ADC file):"
echo "  gcloud auth application-default login --impersonate-service-account=${SA_EMAIL}"
echo "  gcloud auth application-default set-quota-project ${PROJECT_ID}"
echo
echo "Smoke test after that:"
echo "  gcloud secrets versions access latest --secret=${SECRET} --impersonate-service-account=${SA_EMAIL} | head -c 8; echo ...ok"
echo "  echo hello | gcloud storage cp - ${BUCKET}/smoke.txt --impersonate-service-account=${SA_EMAIL}"
echo
echo "Phase 0 complete."