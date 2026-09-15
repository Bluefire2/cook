#!/usr/bin/env bash
set -euo pipefail

# Builds the container and deploys it as the public Cloud Run service behind
# https://sous.kyrylo.lol. Modelled on match-cal's deploy/deploy-web.sh.
#
#   bash scripts/deploy.sh
#
# Secrets are typed once. On every later run they are read back off the
# deployed service, so a redeploy needs nothing in the environment and
# APP_PASSWORD cannot be changed by accident -- changing it locks out every
# device whose Settings screen still holds the old value.
#
# Runs in Git Bash on Windows and unchanged in Cloud Shell. Does not create the
# project, enable APIs, or create the Artifact Registry repo; see
# docs/plans/sous-subdomain.md step 1 for those.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT="${PROJECT:-cooking-assistant-508423}"
# europe-west1, not europe-west2: Cloud Run refuses domain mappings there, and
# a service deployed in the wrong region cannot be mapped without redeploying.
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-sous}"
REPO_NAME="${REPO_NAME:-sous}"
IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT}/${REPO_NAME}/${SERVICE_NAME}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Converts a Windows path (C:\Users\x) to the POSIX form bash needs (/c/Users/x).
to_posix_path() {
  local p="${1:-}"
  [[ -n "$p" ]] || return 1
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$p"
  else
    printf '%s' "$p" | sed -e 's#\\#/#g' -e 's#^\([A-Za-z]\):#/\l\1#'
  fi
}

# The reverse: gcloud.cmd is a Windows program and cannot read /tmp/... or
# /c/Users/... paths. Native no-ops everywhere that isn't MSYS/Cygwin.
to_native_path() {
  local p="${1:-}"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p"
  else
    printf '%s' "$p"
  fi
}

# Windows: gcloud is often installed but not on PATH (and Git Bash will not see gcloud.cmd).
ensure_gcloud_on_path() {
  if command -v gcloud >/dev/null 2>&1; then
    return 0
  fi
  local candidates=(
    "$HOME/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin"
    "/c/Users/${USERNAME:-}/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin"
    "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin"
    "/c/Program Files/Google/Cloud SDK/google-cloud-sdk/bin"
  )
  local localapp
  if localapp="$(to_posix_path "${LOCALAPPDATA:-}")" && [[ -n "$localapp" ]]; then
    candidates=("$localapp/Google/Cloud SDK/google-cloud-sdk/bin" "${candidates[@]}")
  fi
  local dir
  for dir in "${candidates[@]}"; do
    if [[ -x "$dir/gcloud" || -f "$dir/gcloud.cmd" ]]; then
      PATH="$dir:$PATH"
      export PATH
      return 0
    fi
  done
}

require_gcloud() {
  ensure_gcloud_on_path
  command -v gcloud >/dev/null 2>&1 \
    || die "gcloud CLI not found on PATH. Install it and run 'gcloud auth login'. This script does not install it."
  gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
    || die "No active gcloud account. Run: gcloud auth login"
}

# Reads one env var back off the deployed service. Must never fail: on the first
# deploy there is no service to read, and under `set -e` a failing command
# substitution would abort the script with no output at all.
# Single-line node -e: a multiline script inside $(...) prints nothing under
# Git Bash (see strip_controls) — and this function's whole output is captured
# in $(...) by resolve_secret, so a multiline script here silently reads nothing.
read_deployed_env() {
  local json
  json="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" \
    --project="$PROJECT" --format=json 2>/dev/null)" || return 0
  [[ -n "$json" ]] || return 0
  printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const env=JSON.parse(s).spec.template.spec.containers[0].env||[];const hit=env.find((e)=>e.name===process.argv[1]);if(hit&&typeof hit.value==="string")process.stdout.write(hit.value);}catch{}});' "$1" || return 0
}

# Git Bash `read -rs` + Windows paste can prefix a C0 control (STX #x0002 is the
# one gcloud's YAML parser has actually rejected). These secrets are printable,
# so strip rather than fail. Single-line node -e: a multiline script inside
# $(...) prints nothing under Git Bash. [\x01-\x1F] not [\u0000-...]: bash cannot
# store NUL anyway, and \u0000 in -e is a quoting footgun on Windows.
strip_controls() {
  printf '%s' "${1:-}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.replace(/[\x01-\x1F\x7F]/g,"")));'
}

# Environment wins, then the deployed service, then an interactive prompt. Never echoed.
resolve_secret() {
  local name="$1" prompt="$2" value orig
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    info "${name} taken from the environment"
  else
    value="$(read_deployed_env "$name" || true)"
    if [[ -n "$value" ]]; then
      info "${name} reused from the deployed service"
    elif [[ -t 0 ]]; then
      printf '%s: ' "$prompt" >&2
      read -rs value
      printf '\n' >&2
    fi
  fi
  orig="$value"
  value="$(strip_controls "$value")"
  if [[ -n "$orig" && "$value" != "$orig" ]]; then
    warn "${name} contained non-printable characters (often a Git Bash paste artefact); they were stripped."
  fi
  [[ -n "$value" ]] || die "${name} is not set, is not on the deployed service, and there is no terminal to prompt on. Export it and re-run."
  printf -v "$name" '%s' "$value"
  export "$name"
}

require_gcloud
command -v node >/dev/null 2>&1 || die "node not found; it is needed to read env vars back off the deployed service."

resolve_secret GEMINI_API_KEY "GEMINI_API_KEY"
resolve_secret APP_PASSWORD   "APP_PASSWORD (must match the app's Settings screen)"

IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE="${IMAGE:-${IMAGE_REPO}:${IMAGE_TAG}}"

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  info "SKIP_BUILD=1, deploying existing image ${IMAGE}"
else
  info "Building ${IMAGE}"
  # .gcloudignore keeps .env* out of the uploaded source. Verify with:
  #   gcloud meta list-files-for-upload
  gcloud builds submit "$(to_native_path "$REPO_ROOT")" --tag "$IMAGE" --project="$PROJECT"
fi

# --env-vars-file, not --set-env-vars: gcloud splits --set-env-vars values on
# commas, and escaping that on Windows needs quadrupled carets. A YAML file has
# no such problem, and keeps the secrets off the command line and out of shell
# history.
ENV_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"
trap 'rm -f "$ENV_FILE"' EXIT
# JSON.stringify produces a double-quoted YAML scalar and escapes quotes and
# backslashes. Do not put the values on the node command line — they are
# already in the environment. Single-line -e: see strip_controls.
node -e 'const fs=require("fs");const dest=process.argv[process.argv.length-1];const keys=["GEMINI_API_KEY","APP_PASSWORD"];const lines=keys.map(k=>{const v=process.env[k];if(typeof v!=="string"||v==="")process.exit(2);return k+": "+JSON.stringify(v);});fs.writeFileSync(dest,lines.join("\n")+"\n");' "$(to_native_path "$ENV_FILE")" \
  || die "failed to write --env-vars-file (a required secret was empty?)"

info "Deploying Cloud Run service ${SERVICE_NAME} in ${REGION}"
gcloud run deploy "$SERVICE_NAME" \
  --quiet \
  --region="$REGION" \
  --project="$PROJECT" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=4 \
  --image="$IMAGE" \
  --env-vars-file="$(to_native_path "$ENV_FILE")"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" \
  --project="$PROJECT" --format='value(status.url)' 2>/dev/null || true)"
DIGEST="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" \
  --project="$PROJECT" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"

info "Deployed to ${SERVICE_URL:-(url unavailable)}"
info "Running image: ${DIGEST:-(unknown)}"
info ""
info "Next, before mapping the domain: check ${SERVICE_URL:-the service URL} serves"
info "  /, a deep link such as /settings, the assets, and a STREAMING chat turn."
info "Then the remaining manual steps:"
info "  1. gcloud beta run domain-mappings create --service=${SERVICE_NAME} \\"
info "       --domain=sous.kyrylo.lol --region=${REGION} --project=${PROJECT}"
info "     Run it as the account that verified kyrylo.lol in Search Console."
info "  2. Add the record it prints in Cloudflare as DNS-only (grey cloud), not proxied,"
info "     or the managed certificate will never provision."
info "  3. Wait for CertificateProvisioned=True. 'You must configure your DNS records'"
info "     shows for the whole pending window even when DNS is already correct."
