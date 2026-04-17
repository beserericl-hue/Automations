#!/bin/bash
# Restore redacted Supabase keys before importing workflows to n8n.
# Usage: ./scripts/restore_secrets.sh <supabase_service_key>
#
# Example:
#   ./scripts/restore_secrets.sh sb_secret_yourActualKeyHere
#
# This replaces REDACTED_SUPABASE_KEY with the real key in all workflow JSON files.

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <supabase_service_key>"
  echo "  Replaces REDACTED_SUPABASE_KEY with the provided key in all workflow JSON files."
  exit 1
fi

KEY="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOWS_DIR="$SCRIPT_DIR/../workflows"

count=0
for f in "$WORKFLOWS_DIR"/*.json; do
  if grep -q "REDACTED_SUPABASE_KEY" "$f" 2>/dev/null; then
    sed -i '' "s/REDACTED_SUPABASE_KEY/$KEY/g" "$f"
    count=$((count + 1))
  fi
done

echo "Restored key in $count workflow files."
echo "WARNING: Do NOT commit these files — run scripts/scrub_secrets.sh before committing."
