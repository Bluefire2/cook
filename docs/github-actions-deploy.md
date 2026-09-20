# GitHub Actions production deploy

`.github/workflows/deploy.yml` is **`workflow_dispatch` only**. It does not run
on push. Every run replaces the public Cloud Run service behind
https://sous.kyrylo.lol.

**Actions → Deploy → Run workflow.** Pick `main` unless you intend to ship
another ref. Tick **Omit RESEND_API_KEY** only for `SOUS_DISABLE_RESEND=1`.
The job prints the live revision, then runs `bash scripts/deploy.sh`. Secrets
are reused from the live service — do not put `GEMINI_API_KEY` or
`SESSION_SECRET` in GitHub Secrets.

The workflow authenticates with Workload Identity Federation as
`sous-github-deploy@cooking-assistant-508423.iam.gserviceaccount.com`. Until
the pool, provider, and service account exist, the job fails at
`google-github-actions/auth`.

Create those once, as the project owner (`chernyshov.k@gmail.com`), always
with `--project=cooking-assistant-508423`. **PowerShell is the better shell
for this block** (`gcloud.cmd` is a Windows program; no MSYS `://` rewriting).
Git Bash is here if you are already in that shell. Do not maintain a third
copy — if a flag changes, edit both listings below.

The GitHub environment is `production`. Add a required reviewer under
**Settings → Environments** if you want a second click before the job starts.
IAM can take a few minutes to propagate.

## PowerShell

`gcloud` is a native executable, so a non-zero exit does **not** stop the
session. Run these one at a time and check `$LASTEXITCODE` is `0` before
moving on.

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'
$PROJECT_NUMBER = '62867274312'
$SA = "sous-github-deploy@${P}.iam.gserviceaccount.com"
$REPO = 'bluefire2/cook'

& $gcloud config get account

& $gcloud services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com --project=$P

& $gcloud iam service-accounts create sous-github-deploy --project=$P --display-name="GitHub Actions deploy"

& $gcloud iam workload-identity-pools create github --project=$P --location=global --display-name="GitHub Actions Pool"

& $gcloud iam workload-identity-pools providers create-oidc github-actions --project=$P --location=global --workload-identity-pool=github --display-name="GitHub Actions" --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" --attribute-condition="assertion.repository == '$REPO'"

& $gcloud iam service-accounts add-iam-policy-binding $SA --project=$P --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:${SA}" --role=roles/run.admin --condition=None
& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:${SA}" --role=roles/cloudbuild.builds.editor --condition=None
& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:${SA}" --role=roles/artifactregistry.writer --condition=None

& $gcloud iam service-accounts add-iam-policy-binding 62867274312-compute@developer.gserviceaccount.com --project=$P --member="serviceAccount:${SA}" --role=roles/iam.serviceAccountUser

& $gcloud iam service-accounts add-iam-policy-binding "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --project=$P --member="serviceAccount:${SA}" --role=roles/iam.serviceAccountUser

# Source upload for gcloud builds submit. Skip if this bucket name differs.
& $gcloud storage buckets add-iam-policy-binding "gs://${P}_cloudbuild" --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin --project=$P
```

Space-separated service names are separate arguments; do not join them with
commas. Do not use `--set-env-vars` anywhere in this flow (`ALLOWED_EMAILS` is
comma-separated; `deploy.sh` writes `--env-vars-file`).

## Git Bash

`gcloud` is often not on PATH, and MSYS rewrites arguments that look like
`https://`, `gs://`, or `principalSet://` when it invokes `gcloud.cmd`. Export
`MSYS_NO_PATHCONV=1` first or those bindings land on the wrong resource.

```bash
export MSYS_NO_PATHCONV=1
if ! command -v gcloud >/dev/null 2>&1; then
  PATH="$HOME/AppData/Local/Google Cloud SDK/google-cloud-sdk/bin:$PATH"
  export PATH
fi
command -v gcloud >/dev/null 2>&1 || { echo "gcloud not found; add the Cloud SDK bin dir to PATH"; exit 1; }

PROJECT=cooking-assistant-508423
PROJECT_NUMBER=62867274312
SA=sous-github-deploy@${PROJECT}.iam.gserviceaccount.com
REPO=bluefire2/cook

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com --project="$PROJECT"

gcloud iam service-accounts create sous-github-deploy \
  --project="$PROJECT" \
  --display-name="GitHub Actions deploy"

gcloud iam workload-identity-pools create github \
  --project="$PROJECT" \
  --location=global \
  --display-name="GitHub Actions Pool"

gcloud iam workload-identity-pools providers create-oidc github-actions \
  --project="$PROJECT" \
  --location=global \
  --workload-identity-pool=github \
  --display-name="GitHub Actions" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository == '${REPO}'"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role=roles/run.admin --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role=roles/cloudbuild.builds.editor --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role=roles/artifactregistry.writer --condition=None

gcloud iam service-accounts add-iam-policy-binding \
  62867274312-compute@developer.gserviceaccount.com \
  --project="$PROJECT" \
  --member="serviceAccount:${SA}" \
  --role=roles/iam.serviceAccountUser

gcloud iam service-accounts add-iam-policy-binding \
  "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --project="$PROJECT" \
  --member="serviceAccount:${SA}" \
  --role=roles/iam.serviceAccountUser

# Source upload for gcloud builds submit. Skip if this bucket name differs.
gcloud storage buckets add-iam-policy-binding "gs://${PROJECT}_cloudbuild" \
  --member="serviceAccount:${SA}" \
  --role=roles/storage.objectAdmin \
  --project="$PROJECT"
```

Stay in Git Bash for local deploys (`bash scripts/deploy.sh`). The Actions job
replaces that once this IAM exists.
