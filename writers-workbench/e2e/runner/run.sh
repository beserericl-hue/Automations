#!/usr/bin/env bash
#
# One run of the E2E suite against DEV, started by a deploy of the writer-e2e Railway service.
#
#   1. refuse unless every Supabase address is DEV (gvbvwcnmjkdpclcisqrr);
#   2. wait until the DEV Workbench is serving the commit this container was built from, so the
#      suite tests that code and not the deploy before it;
#   3. run the unauthenticated project, then the regression passes in E2E_PASSES (default "A");
#   4. email the result to E2E_NOTIFY_EMAIL, and exit non-zero if anything failed.
#
# Pass B (real engine jobs, 15-30 minutes of paid model calls) is opt-in: set E2E_PASSES=ABC on the
# service and redeploy it.
#
set -uo pipefail
cd "$(dirname "$0")/../.."

: "${E2E_BASE_URL:?E2E_BASE_URL is not set}"
for v in SUPABASE_URL VITE_SUPABASE_URL; do
  case "${!v:-}" in
    *gvbvwcnmjkdpclcisqrr*) ;;
    *) echo "REFUSING TO RUN: $v is not DEV Supabase." >&2; exit 2 ;;
  esac
done
case "$E2E_BASE_URL" in
  *writersworkbench-develop*) ;;
  *) echo "REFUSING TO RUN: E2E_BASE_URL is not the DEV Workbench." >&2; exit 2 ;;
esac

export CI=true
export E2E_SUPA_URL="$SUPABASE_URL"
export E2E_SUPA_SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
export E2E_PASSES="${E2E_PASSES:-A}"
export E2E_RETRIES="${E2E_RETRIES:-1}"
SHA="${RAILWAY_GIT_COMMIT_SHA:-}"
LOGS=/tmp/e2e
mkdir -p "$LOGS"

served() {
  curl -s -m 10 "$E2E_BASE_URL/api/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version||"")}catch{}})'
}

WAIT_RESULT="no commit to wait for"
if [ -n "$SHA" ]; then
  WAIT_RESULT="timed out"
  for _ in $(seq 1 120); do
    if [ "$(served)" = "$SHA" ]; then WAIT_RESULT="serving"; break; fi
    sleep 15
  done
fi
echo "=== DEV $E2E_BASE_URL: $WAIT_RESULT (commit ${SHA:0:7}, served $(served | cut -c1-7)) ==="

if [ "$WAIT_RESULT" = "timed out" ]; then
  node e2e/runner/notify.mjs "${SHA:0:7}" "DEV never served this commit within 30 minutes; nothing was tested." 1
  exit 1
fi

echo "=== Unauthenticated project ==="
npx playwright test --project=chromium-noauth --reporter=line 2>&1 | tee "$LOGS/noauth.log"
NOAUTH=${PIPESTATUS[0]}

echo "=== Regression passes: $E2E_PASSES ==="
bash e2e/run-regression.sh 2>&1 | tee "$LOGS/regression.log"
REGRESSION=${PIPESTATUS[0]}

STATUS=$(( NOAUTH != 0 || REGRESSION != 0 ))
node e2e/runner/notify.mjs "${SHA:0:7}" "" "$STATUS" "$LOGS/noauth.log" "$LOGS/regression.log"
echo "=== RESULT: noauth=$NOAUTH regression=$REGRESSION ==="
exit "$STATUS"
