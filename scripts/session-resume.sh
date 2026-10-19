#!/usr/bin/env bash
# session-resume.sh — print the carry-forward state for the Writers Workbench
# (Automations) project and verify live DEV/PROD health, so a new session
# window can pick up exactly where 2026-05-28 left off.
#
# Scope: Writers Workbench / Automations ONLY. CSHSE is a separate project and
# is intentionally not referenced here.
#
# Usage:  bash scripts/session-resume.sh
# Safe:   read-only. No writes, no deploys, no PROD mutations.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
hr()   { printf '%.0s-' {1..72}; echo; }

bold "WRITERS WORKBENCH — SESSION RESUME ($(date -u +%Y-%m-%dT%H:%MZ))"
hr
cat <<'EOF'
WORK-ORDERING (wiki: Engineering/sprints/work-ordering-2026-05.md)
  Gate 1 Newsletter PROD ship   <- ACTIVE
  Gate 2 Sprint 15 testbed
  Gate 3 Python rewrite (16-22)
  Gate 4 B2B platform (23-27)
  Gate 5 Stripe (9)  <- LAST
  Rule: no merges to main until newsletter dev is 100% complete.

GATE 1 STATUS
  [x] 1.1 E2E green   [x] 1.2 PR#76   [x] 1.3 PR#68
  [x] 1.4 PROD migrations 013-017 applied + verified
  [x] (infra) PROD Redis outage fixed (was down since 2026-05-19)
  [ ] 1.5 create 4 PROD newsletter workflows
  [ ] 1.6 seed PROD demo   [ ] 1.7 PROD smoke   [ ] 1.8 release tag

NEXT ACTION — Step 0 of the runbook (prove on DEV first):
  Set on DEV WritersWorkbench (bubbly-solace / develop env):
    N8N_NEWSLETTER_WEBHOOK_URL=https://n8n.agileadautomation.com/webhook/compose-newsletter-dev
  Redeploy DEV, run a real generation from the DEV UI, verify a row in
  DEV newsletter_sends_v2 with the Workbench masthead.
  Then create PROD copies (path -> compose-newsletter-v2, callbacks ->
  writersworkbench-production), set PROD env var, map IDs, seed, smoke, tag.

KEY DOCS
  Runbook:  knowledgebase/Writers Workbench Wiki/Engineering/operations/newsletter-prod-ship-runbook.md
  Handoff:  writers-workbench/SESSION_CONTEXT.md (latest entry: 2026-05-28)
  Memory:   ~/.claude/.../memory/project_prod_redis_outage_risk.md

SECURITY TODO: rotate the PROD Postgres password (typed into prior shell history).
EOF
hr

bold "GIT STATE"
echo "branch: $(git branch --show-current 2>/dev/null)"
echo "ahead of develop: $(git rev-list --count origin/develop..HEAD 2>/dev/null || echo '?') commit(s)"
echo "open PRs:"; gh pr list --state open 2>/dev/null | head -5 || echo "  (gh not available)"
echo "uncommitted (count): $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
hr

bold "LIVE HEALTH (read-only)"
for tier in develop production; do
  url="https://writersworkbench-${tier}.up.railway.app/api/health"
  out=$(curl -sS -m 12 "$url" 2>/dev/null)
  if echo "$out" | grep -q '"status"'; then
    env=$(echo "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('environment'),'| checks:',d.get('checks'))" 2>/dev/null)
    echo "  ${tier}: $env"
  else
    echo "  ${tier}: UNREACHABLE / non-JSON (${out:0:60})"
  fi
done
hr

bold "NEWSLETTER n8n WORKFLOWS (ids for reference)"
cat <<'EOF'
  Content - Newsletter Agent V2          bMvMKyK8obwYZmNb  (form+webhook compose-newsletter-dev)
  AI News Data Ingestion V2              2T3TwGHhdGQlTpQ5  (17 RSS/schedule triggers)
  DEV - Newsletter Cadence Cron          7l1z4uMS9kdkYIT4  (scheduleTrigger)
  DEV - Newsletter Ingestion Multi-User  JAQ8rmCaDoddqt2k  (scheduleTrigger)
  All currently DEV-wired (callbacks -> writersworkbench-develop). No PROD copies yet.
EOF
hr
echo "Resume complete. Open the runbook for the full step-by-step."
