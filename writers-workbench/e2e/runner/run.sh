#!/usr/bin/env bash
#
# One run of the E2E suite against DEV, started by a deploy of the writer-e2e Railway service.
#
#   1. refuse unless every Supabase address is DEV (gvbvwcnmjkdpclcisqrr);
#   2. wait until the DEV Workbench is serving the commit this container was built from, so the
#      suite tests that code and not the deploy before it;
#   3. run the unauthenticated project, then the regression passes in E2E_PASSES (default "A");
#   4. email the result to E2E_NOTIFY_EMAIL;
#   5. run the engine end-to-end suite (scripts/e2e_full_verify.py, 157 chat + voice tests) against
#      the DEV engine gateway and email its result separately; exit non-zero if anything failed.
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

# --- Engine end-to-end suite (scripts/e2e_full_verify.py) against the DEV engine gateway ---------
# 157 chat + voice tests from engine-chat-e2e-suite.md, each polled to completion and checked against
# DEV Supabase. Hours of real engine work and paid model calls, so it runs after the Playwright result
# has already been emailed, and is reported in its own email. E2E_ENGINE_VERIFY=off skips it;
# E2E_ENGINE_ONLY="R01,V03" runs a subset. The gateway secret is a Railway reference variable
# (SERVICE_SHARED_SECRET = ${{writer-engine-gateway.SERVICE_SHARED_SECRET}}); nothing is kept in GitHub.
ENGINE=skipped
if [ "${E2E_ENGINE_VERIFY:-on}" != "off" ]; then
  export E2E_GATEWAY="${E2E_ENGINE_GATEWAY:-https://writer-engine-gateway-develop.up.railway.app}"
  case "$E2E_GATEWAY" in
    *-develop.up.railway.app*) ;;
    *) echo "REFUSING TO RUN the engine suite: E2E_ENGINE_GATEWAY is not the DEV gateway." >&2; exit 2 ;;
  esac
  if [ -z "${SERVICE_SHARED_SECRET:-}" ]; then
    ENGINE=1
    echo "SERVICE_SHARED_SECRET is not set on writer-e2e" > "$LOGS/engine.log"
    E2E_NOTIFY_TITLE="Engine E2E on DEV" node e2e/runner/notify.mjs "${SHA:0:7}" \
      "Engine suite not run: SERVICE_SHARED_SECRET is not set on writer-e2e." 1
  else
    echo "=== Engine suite against $E2E_GATEWAY (${E2E_ENGINE_ONLY:-all tests}) ==="
    E2E_SECRET="$SERVICE_SHARED_SECRET" SUPA_URL="$SUPABASE_URL" SUPA_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
      E2E_ONLY="${E2E_ENGINE_ONLY:-}" E2E_TIMEOUT="${E2E_ENGINE_TIMEOUT:-1200}" \
      python3 -u scripts/e2e_full_verify.py 2>&1 | tee "$LOGS/engine.log"
    ENGINE=${PIPESTATUS[0]}
    E2E_NOTIFY_TITLE="Engine E2E on DEV" node e2e/runner/notify.mjs "${SHA:0:7}" "" "$ENGINE" "$LOGS/engine.log"
  fi
  [ "$ENGINE" = 0 ] || STATUS=1
fi
echo "=== RESULT: noauth=$NOAUTH regression=$REGRESSION engine=$ENGINE ==="
exit "$STATUS"
