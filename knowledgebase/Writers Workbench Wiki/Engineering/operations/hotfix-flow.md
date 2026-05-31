---
name: Hotfix flow
description: Direct-to-PROD fix + mirror to DEV pattern. When and how.
type: concept
tags: [operations, hotfix, ops]
last_reviewed: 2026-05-09
---

# Hotfix flow

For urgent PROD bugs that can't wait for the next release.

## When to hotfix

- Production-impacting bug.
- Cannot reasonably ship via normal release within hours.
- Fix is small + confidently scoped.

If unsure: hotfix. The flow is well-trodden and reversible.

## Flow

```
1. Branch hotfix/<descriptive-name> from main
2. Reproduce on DEV (preferred) or PROD (last resort)
3. Make the fix on the hotfix branch
4. Test locally + push
5. PR hotfix/<name> → main
   - 4 required CI checks must pass
   - Author admin override OK if no second approver available
6. Merge to main
7. Deploy:
   - For Workbench code: git push origin main:release/v1.0
   - For n8n workflows: deploy directly to PROD via REST + mirror to DEV
   - For DB schema: apply migration to PROD via session pooler
8. Smoke test PROD
9. Mirror back to DEV (if applicable)
10. Cherry-pick or merge main → develop
```

## Hotfix categories

### Workbench code only

Trivially reversible. Standard branch flow.

```bash
git checkout main && git pull
git checkout -b hotfix/fix-content-detail-crash
# edit code
git add -A && git commit -m "Fix: ContentDetail crashes on missing metadata"
git push -u origin hotfix/fix-content-detail-crash
gh pr create --base main --title "..." --body "..."
# Wait for CI green
gh pr merge --merge --admin --delete-branch
git push origin main:release/v1.0   # deploys PROD
git checkout develop && git merge main --ff-only && git push
```

Deploy time: ~3 minutes after release/v1.0 push.

### n8n workflow only

```bash
# Edit DEV - X workflow first to verify the fix
# Once verified, edit PROD - X via REST API:
curl -X POST "$N8N/api/v1/workflows/$PROD_ID/deactivate"   # may 403 — OK
curl -X PUT "$N8N/api/v1/workflows/$PROD_ID" -d '{name, nodes, connections, settings: {executionOrder:"v1"}}'
curl -X POST "$N8N/api/v1/workflows/$PROD_ID/activate"

# In n8n UI: refresh PROD workflow tab + click Publish (⌘P) — required for activeVersion rebuild on n8n 2.x

# Mirror to DEV
curl -X POST "$N8N/api/v1/workflows/$DEV_ID/deactivate"
curl -X PUT "$N8N/api/v1/workflows/$DEV_ID" -d '{...same nodes/connections (with DEV substitutions)...}'
curl -X POST "$N8N/api/v1/workflows/$DEV_ID/activate"
```

Often a script. Examples: `scripts/hotfix-add-story-bible-extractor.py` (PR #71).

### Combined code + n8n + DB (e.g. Sprint 12 hotfix)

PR #71 (story-bible extraction) was this kind. Deployed in this order:
1. Apply schema change to DEV (none in PR #71 — pure n8n + script).
2. Edit DEV workflow + verify.
3. Edit PROD workflow.
4. Apply schema change to PROD (none).
5. PR scripts to main (with docs file to bypass CI paths filter).

### Schema-only

Apply via session pooler:
```bash
PGPASSWORD=… /usr/local/opt/postgresql@17/bin/psql \
  "postgresql://postgres.faklxfakgzkpkbxfihzh:…@pooler:5432/postgres" \
  -f writers-workbench/migrations/<NNN.sql>
```

Then commit migration file to repo, PR to main, mirror to DEV.

## Mirroring DEV ← PROD

After a PROD-only hotfix, ensure DEV has the same change so:
- DEV stays a faithful preview of PROD.
- Next release-day promotion doesn't accidentally re-introduce the bug.

For workflow hotfixes: n8n REST PUT against the DEV id with the same nodes/connections (after substituting Supabase URL/key + webhook paths back to DEV values).

For schema: just apply the same migration to DEV.

For Workbench code: cherry-pick the merge commit:
```bash
git checkout develop
git merge main --ff-only
git push
```

If main has diverged from develop (rare), cherry-pick the specific commit:
```bash
git cherry-pick <hotfix-commit-sha>
```

## Hotfix gotchas (per past releases)

### CI paths filter (PR #71 lesson)

Scripts-only PRs don't trigger CI. Required checks can't pass. Workaround: include a docs file (e.g. `writers-workbench/docs/hotfix-2026-04-29-story-bible-extraction.md`) so the path filter triggers CI.

### n8n PUT settings rejection

Only `executionOrder` accepted in `settings`. Anything else → 400. Strip allowlist before PUT.

### n8n 2.x activeVersion

After PUT-via-REST, the runtime keeps the old version until activation rebuilds. Either:
- `deactivate → PUT → activate` cycle, OR
- Refresh n8n UI tab + click Publish (⌘P).

### `webhookId` regeneration on clone

`clone-prod-to-dev.py` regenerates. If you're hand-cloning, generate fresh UUIDs for every `webhookId` in the JSON.

### Cross-tier wiring during hotfix

If you mirror a PROD fix to DEV, ensure DEV-side substitutions land:
- Supabase URL/key
- Webhook paths
- `executeWorkflow` refs

Better: use `clone-prod-to-dev.py` to do the inverse-of-promotion (PROD→DEV) substitution.

## Post-hotfix checklist

- [ ] PROD smoke test passed
- [ ] DEV mirrored
- [ ] develop synced from main (or cherry-pick complete)
- [ ] SESSION_CONTEXT.md entry appended
- [ ] [[hotfixes]] page updated with summary
- [ ] [[releases-and-tags]] updated if version bumped
- [ ] User notified of fix
- [ ] Root cause documented (avoid recurrence — see [[regression-tests]])

## Related

- [[regression-tests]] — sticky bug categories; many born from hotfixes.
- [[hotfixes]] — chronological log of past hotfixes.
- [[releases-and-tags]] — full release procedure (more involved than hotfix).
