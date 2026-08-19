# Deploy Runbook — Workato Corpus Agent

Repo layout assumed (matches the Dockerfile and run_pipeline.sh):

```
.
├── Dockerfile
├── requirements.txt
├── BRIEF.md              # copied into the image next to agent.py
├── bin/
│   ├── agent.py
│   ├── corpus.py
│   ├── derive.py
│   ├── dumps.py          # unchanged from your version
│   └── views.sql         # must sit next to derive.py
├── scripts/
│   └── run_pipeline.sh
└── terraform/            # the .tf files + terraform.tfvars
```

Note: `views.sql` goes in `bin/` (derive.py resolves it via `__file__`).
If you keep BRIEF.md inside `bin/` instead of the repo root, delete the
`COPY BRIEF.md ./bin/BRIEF.md` line from the Dockerfile.

## 0. Pre-flight: verify the existing SA's project roles

Both compute resources run as `invoice-idp@...`. This stack grants it the
secret/bucket/dataset bindings itself, but two capabilities must already
exist at the project level (managed outside this stack):

```bash
gcloud projects get-iam-policy rsr-rpa-ai-prd-f1cb \
  --flatten="bindings[].members" \
  --format="table(bindings.role)" \
  --filter="bindings.members:invoice-idp@rsr-rpa-ai-prd-f1cb.iam.gserviceaccount.com"
```

Confirm the list covers:
1. **BigQuery job creation** — roles/bigquery.jobUser, or a broader role
   containing `bigquery.jobs.create`. Without it, every query AND every
   derive load fails 403.
2. **Vertex AI** — roles/aiplatform.user or equivalent. Without it,
   `/healthz` will be fine but `/ask` 403s at the Gemini call. If it's
   missing, that's the one grant (or ticket) needed.

## 1. Build and push the image

The Terraform expects `us-central1-docker.pkg.dev/<project>/workato-agent-repo/workato-app:<tag>`.
If your hand-rolled repo is on the multi-region host (`us-docker.pkg.dev`),
edit `local.agent_image` in main.tf accordingly.

```bash
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/rsr-rpa-ai-prd-f1cb/workato-agent-repo/workato-app:v1 .

# convenience alias for "latest deploys"
gcloud artifacts docker tags add \
  us-central1-docker.pkg.dev/rsr-rpa-ai-prd-f1cb/workato-agent-repo/workato-app:v1 \
  us-central1-docker.pkg.dev/rsr-rpa-ai-prd-f1cb/workato-agent-repo/workato-app:latest
```

## 2. Apply Terraform

```bash
cd terraform
terraform init
terraform apply
```

Your deploy identity needs `iam.serviceAccounts.actAs` on `invoice-idp@...`
and on the scheduler SA this stack creates (Owner/Editor covers it; if
restricted, `roles/iam.serviceAccountUser` on those two SAs).

## 3. Load the token (one manual step, on purpose)

The secret container exists but is EMPTY until this runs — the token
never touches Terraform state:

```bash
echo -n "$WORKATO_TOKEN" | \
  gcloud secrets versions add WORKATO_AGENT_API_TOKEN --data-file=-
```

## 4. First pipeline run (don't wait for 02:00 UTC)

```bash
gcloud run jobs execute workato-agent-pipeline-job \
  --region us-central1 --wait
```

Success looks like: `wrote N recipe file(s)`, `Snapshot <epoch> written`,
`catalog views refreshed`.

## 5. Smoke test the API

Make sure `api_invoker_members` in terraform.tfvars includes your user,
then:

```bash
URL=$(terraform output -raw agent_api_url)
TOKEN=$(gcloud auth print-identity-token)

curl -s -H "Authorization: Bearer $TOKEN" "$URL/healthz" | jq .

curl -s -X POST "$URL/ask" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question": "Which recipes write to CFG_TemplateVersion, and which fields?"}' | jq .
```

## 6. Logging (already structured — nothing to install)

Cloud Run ships stdout to Cloud Logging; the agent's JSON lines (with
`severity`) arrive as parsed `jsonPayload`.

Every tool call the model made:

```
resource.type="cloud_run_revision"
resource.labels.service_name="workato-agent-api"
jsonPayload.event="tool_call"
```

Pipeline runs:

```
resource.type="cloud_run_job"
resource.labels.job_name="workato-agent-pipeline-job"
```

Failed tool calls only: add `jsonPayload.ok=false`.

## Rollback

Deploys are pinned by `image_tag` in terraform.tfvars. To roll back:
set it to the previous tag, `terraform apply`.

## Known trade-off (accepted)

The API service runs as the same SA that holds dataEditor, so IAM does
not enforce read-only for model-authored SQL — corpus.py's SELECT-only +
single-statement guard is the fence. If org process ever permits a
project-level jobUser grant on a fresh SA, splitting the API onto a
dataViewer-only identity is a ~10-line Terraform change.
