#!/bin/bash
# Scrub Supabase keys from workflow JSON files before committing to git.
# Usage: ./scripts/scrub_secrets.sh <supabase_service_key>
#
# This replaces the Supabase service key with REDACTED_SUPABASE_KEY
# in all workflow JSON files. Run this after syncing workflows from n8n
# and before committing.

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <supabase_service_key>"
  echo "  Replaces the provided key with REDACTED_SUPABASE_KEY in all workflow JSON files."
  exit 1
fi

SECRET="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOWS_DIR="$SCRIPT_DIR/../workflows"
PLACEHOLDER="REDACTED_SUPABASE_KEY"

count=0
for f in "$WORKFLOWS_DIR"/*.json; do
  if grep -q "$SECRET" "$f" 2>/dev/null; then
    sed -i '' "s/$SECRET/$PLACEHOLDER/g" "$f"
    count=$((count + 1))
  fi
done

echo "Scrubbed secret from $count workflow files."

remaining=$(grep -rl "$SECRET" "$WORKFLOWS_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$remaining" != "0" ]; then
  echo "ERROR: $remaining files still contain the secret!"
  exit 1
fi

echo "Verified: 0 files contain the secret. Safe to commit."
