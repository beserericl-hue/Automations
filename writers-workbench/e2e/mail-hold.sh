#!/usr/bin/env bash
#
# Hold mail to the regression-test inbox for the length of a run:  mail-hold.sh on | off
#
# The regression suite signs in as a real account and drives real jobs, so every "chapter is ready",
# approve / delete notice and research report landed in that inbox (about 60 a run). This writes one
# row, e2e_mail_hold, into app_config_global_v2 on DEV; the engine's Postal client and the server's
# mailer skip any send whose every recipient is on it. Mail to anyone else still goes out. The row
# expires by itself after E2E_MAIL_HOLD_HOURS (default 8), so a runner that dies cannot mute the inbox.
# The run's own result email (notify.mjs) is not affected. Nothing here touches PROD.
set -uo pipefail
URL="${E2E_SUPA_URL:-${SUPABASE_URL:-}}"
KEY="${E2E_SUPA_SERVICE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
case "$URL" in *gvbvwcnmjkdpclcisqrr*) ;; *) echo "mail-hold: not DEV Supabase; skipping" >&2; exit 0 ;; esac
[ -n "$KEY" ] || { echo "mail-hold: no service key; skipping" >&2; exit 0; }
EMAIL="${E2E_TEST_EMAIL:-}"
API="$URL/rest/v1/app_config_global_v2"
H=(-H "apikey: $KEY" -H "authorization: Bearer $KEY" -H "Content-Type: application/json")
case "${1:-}" in
  on)
    [ -n "$EMAIL" ] || { echo "mail-hold: E2E_TEST_EMAIL unset; not holding" >&2; exit 0; }
    UNTIL=$(node -e 'process.stdout.write(new Date(Date.now()+Number(process.argv[1])*3600e3).toISOString())' "${E2E_MAIL_HOLD_HOURS:-8}")
    VALUE=$(node -e 'process.stdout.write(JSON.stringify({until:process.argv[1],addresses:[process.argv[2].toLowerCase()]}))' "$UNTIL" "$EMAIL")
    BODY=$(node -e 'process.stdout.write(JSON.stringify({key:"e2e_mail_hold",value:process.argv[1],description:"Regression run: mail to these addresses is held until the time given",updated_by:"e2e-runner"}))' "$VALUE")
    curl -s -m 15 -o /dev/null -w "mail-hold on: HTTP %{http_code}\n" -X POST "$API?on_conflict=key" "${H[@]}" -H "Prefer: resolution=merge-duplicates" -d "$BODY" ;;
  off)
    curl -s -m 15 -o /dev/null -w "mail-hold off: HTTP %{http_code}\n" -X DELETE "$API?key=eq.e2e_mail_hold" "${H[@]}" ;;
  *) echo "usage: mail-hold.sh on|off" >&2; exit 2 ;;
esac
