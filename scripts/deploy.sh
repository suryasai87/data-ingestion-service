#!/usr/bin/env bash
# Data Ingestion Service: one-command deploy.
#   scripts/deploy.sh                       # demo target: build UI, bundle deploy, setup + history jobs, start app, verify
#   scripts/deploy.sh --code-only           # rebuild UI + redeploy the app only
#   scripts/deploy.sh -t new_workspace --profile P --var uc_catalog=<cat> --var warehouse_id=<id>
#   --skip-build  reuse app/static        --skip-history  don't retrain the forecast model
set -eo pipefail  # no -u: bash 3.2 (macOS) treats empty arrays as unbound
cd "$(dirname "$0")/.."
TARGET=demo; PROFILE_ARGS=(); VARS=(); CODE_ONLY=0; SKIP_BUILD=0; SKIP_HISTORY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) TARGET="$2"; shift 2;;
    --profile) PROFILE_ARGS=(--profile "$2"); export DATABRICKS_CONFIG_PROFILE="$2"; shift 2;;
    --var) VARS+=(--var "$2"); shift 2;;
    --code-only) CODE_ONLY=1; shift;;
    --skip-build) SKIP_BUILD=1; shift;;
    --skip-history) SKIP_HISTORY=1; shift;;
    *) echo "unknown argument $1"; exit 2;;
  esac
done
say() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
B=(databricks bundle -t "$TARGET" "${PROFILE_ARGS[@]}" "${VARS[@]}")

if [[ $SKIP_BUILD -eq 0 ]]; then
  say "build UI (npm proxy)"
  (cd frontend && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit && npx vite build >/dev/null)
  test -f app/static/index.html
fi

say "validate bundle"
"${B[@]}" validate >/dev/null
SUMMARY=$("${B[@]}" summary -o json)
APP_NAME=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d['variables']['app_name']['value'])" <<<"$SUMMARY")
SCOPE=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d['variables']['secret_scope']['value'])" <<<"$SUMMARY")

if [[ $CODE_ONLY -eq 0 ]]; then
  say "secret scope $SCOPE (the app's secret resource needs the key to exist; setup writes the real value)"
  databricks secrets create-scope "$SCOPE" "${PROFILE_ARGS[@]}" 2>/dev/null || true
  if ! databricks secrets list-secrets "$SCOPE" "${PROFILE_ARGS[@]}" -o json 2>/dev/null | grep -q demo_replication_password; then
    databricks secrets put-secret "$SCOPE" demo_replication_password --string-value "pending-setup" "${PROFILE_ARGS[@]}"
  fi
fi

say "bundle deploy"
"${B[@]}" deploy --auto-approve

if [[ $CODE_ONLY -eq 0 ]]; then
  say "setup job (idempotent)"
  "${B[@]}" run dis_setup
  if [[ $SKIP_HISTORY -eq 0 ]]; then
    say "history job (train + publish the forecast model)"
    "${B[@]}" run dis_history
  fi
fi

say "start app"
"${B[@]}" run dis_app

say "verify"
URL=$(databricks apps get "$APP_NAME" "${PROFILE_ARGS[@]}" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
STATE=$(databricks apps get "$APP_NAME" "${PROFILE_ARGS[@]}" -o json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('compute_status',{}).get('state'), d.get('active_deployment',{}).get('status',{}).get('state'))")
TOKEN=$(databricks auth token "${PROFILE_ARGS[@]}" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
for p in / /api/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$URL$p")
  echo "$p -> $code"
  [[ "$code" == "200" ]] || { echo "verification failed for $p"; exit 1; }
done
echo "app $APP_NAME: $STATE  $URL"
