#!/usr/bin/env bash
#
# Two-pass result-asserting regression runner against DEV.
#
#   Pass A — light specs (DB / render / fast API): workers=4.
#   Pass B — heavy specs that dispatch real engine / LLM / image jobs: workers=1,
#            so concurrent multi-minute jobs never starve the shared DEV engine.
#   Pass C — topbar-signout: its own project (revokes the shared Supabase session).
#
# Requires the DEV E2E env to be sourced first (E2E_BASE_URL, E2E_SUPA_URL,
# E2E_SUPA_SERVICE_KEY, E2E_TEST_EMAIL/PASSWORD, VITE_SUPABASE_ANON_KEY, E2E_USER_ID).
# NEVER point these at PROD (faklx...) — DEV is gvbvwcnmjkdpclcisqrr.
#
set -uo pipefail
cd "$(dirname "$0")/.."

: "${E2E_BASE_URL:?source your DEV env first (E2E_BASE_URL unset)}"
case "${E2E_SUPA_URL:-$SUPABASE_URL}" in
  *gvbvwcnmjkdpclcisqrr*) : ;;  # DEV — ok
  *) echo "REFUSING TO RUN: Supabase URL is not DEV (gvbv...). Point at DEV before running." >&2; exit 2 ;;
esac

# Heavy = real engine/LLM/image jobs (>=90s internal timeouts).
HEAVY=(
  regression/project-plan-write.spec.ts
  regression/content-repair.spec.ts
  regression/content-qa.spec.ts
  regression/content-detail-full.spec.ts
  regression/brainstorm-submit.spec.ts
  regression/project-art.spec.ts
  regression/newsletter-generate.spec.ts
  regression/newsletter-send-full.spec.ts
  regression/cover-art-content.spec.ts
)

# Light = every other regression spec (computed so new light specs are picked up automatically).
LIGHT=()
for f in e2e/regression/*.spec.ts; do
  base="regression/$(basename "$f")"
  skip=0
  for h in "${HEAVY[@]}"; do [ "$base" = "$h" ] && skip=1; done
  [ "$base" = "regression/topbar-signout.spec.ts" ] && skip=1  # runs in Pass C
  [ "$skip" = 0 ] && LIGHT+=("$base")
done

# retries=2: attempts are assertion-preserving (each retry re-runs the full
# result-assert flow). They absorb (a) concurrency-timing flakes in Pass A and
# (b) external engine/KIE.AI job flakiness in Pass B — not weakened assertions.
RETRIES="${E2E_RETRIES:-2}"

echo "=== Pass A: ${#LIGHT[@]} light specs @ workers=3, retries=$RETRIES ==="
npx playwright test --project=chromium --workers=3 --retries="$RETRIES" --reporter=line "${LIGHT[@]}"
A=$?

echo "=== Pass B: ${#HEAVY[@]} heavy engine specs @ workers=1, retries=$RETRIES ==="
npx playwright test --project=chromium --workers=1 --retries="$RETRIES" --reporter=line "${HEAVY[@]}"
B=$?

echo "=== Pass C: topbar-signout (isolated session) ==="
npx playwright test --project=signout --workers=1 --retries="$RETRIES" --reporter=line
C=$?

echo "=== RESULT: passA=$A passB=$B passC=$C ==="
[ $A -eq 0 ] && [ $B -eq 0 ] && [ $C -eq 0 ]
