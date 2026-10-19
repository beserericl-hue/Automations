# Next-session prompt — paste into a new Claude Code session

Resume the Writers Workbench (Automations) engine framework work. Scope is Writers Workbench ONLY — CSHSE is a separate project, ignore it. Stay inside `/Users/ericbeser/Documents/GitHub/Automations`.

Before you do anything else, read in this order:
1. `CLAUDE.md` — baseline protection (V1 frozen / PROD tier-2 frozen during sprints / DEV tier is where new work lands) and the env-var-by-tier table.
2. The **2026-05-31 entry** at the bottom of `writers-workbench/SESSION_CONTEXT.md` (engine framework foundation + F2 newsletter saga + F1-A research). That entry supersedes the 2026-05-28 Gate-1 n8n PROD-ship plan — we pivoted.
3. `knowledgebase/Writers Workbench Wiki/Engineering/architecture/python-backend/f1a-decisions.md` — pinned model ids, Tier-4 limits, format-kindle correction, prereqs landed vs remaining.
4. `knowledgebase/Writers Workbench Wiki/Engineering/sprints/engine-framework-sprints.md` — F0/F1-A/F1-B/F2 sprint task breakdown.

## What you're picking up

We replaced the planned Gate-1 newsletter PROD-ship-via-n8n with a Python-engine rewrite. Same end goal (UI-driven newsletter with 3 HITL gates, working on PROD), different mechanism. The engine workspace at `engine/` is a uv workspace with 21 members. Two services run on Railway DEV right now:
- `writer-engine-gateway` — `https://writer-engine-gateway-develop.up.railway.app` (port 8000, `/admin/health` green)
- `writer-engine-runtime` — `https://writer-engine-runtime-develop.up.railway.app` (port 8001, orchestrator + arq worker + all 10 step services as background uvicorns on `localhost:801x`)

WW DEV is already wired to the engine via env vars (`NEWSLETTER_BACKEND=python`, `NEWSLETTER_SERVICE_URL=http://writer-engine-gateway.railway.internal:8000`, matching `SERVICE_SHARED_SECRET`). The Express server's `/api/newsletter/generate` now forwards to the engine when the flag is set.

**PR #77 (branch `feature/engine-foundation`, base `develop`)** is open with two commits:
- `50d561d` — F0 foundation + F2 newsletter saga + WW backend switch (293 files / +31,298 lines, 27 tests)
- `346fc0d` — F1-A prereqs #1 #3 #4: `PostalClient` cc/bcc/headers/attachments extension, `writer_engine.llm.json_extractor` + `LLMResponse.citations`, `writer_engine.rate_limit.AnthropicBudget` Redis sliding-window with Tier-4 defaults (12 files / +755 lines, 22 new tests; 86 total passing)

Check the PR status first: `gh pr view 77 --json state,mergeable,statusCheckRollup`. The next action depends on whether it's merged yet.

## If PR #77 is NOT yet merged

The deployed runtime is still serving the **old saga-state route** (`/pipelines/newsletter/state/{id}`) which collides with the generic `/pipelines/{pipeline}/state/{id}` and returns 500 on lookup. The fix is in this PR — the route was renamed to `/pipelines/newsletter/saga-state/{id}`. The direct `/internal/newsletter/generate` call already works on the deployed gateway (returns `execution_id`); only the state lookup is broken. Do not try to land another `railway up` — Railway dedupes identical-content uploads, which is why the previous deploys silently no-op'd. CI/CD on `develop` merge is the path.

Stop and ask the user if they want it merged. After merge, CI/CD auto-deploys both `writer-engine-runtime` and `writer-engine-gateway` and `WritersWorkbench` from the new `develop` head.

## If PR #77 IS merged

Verify the deploy landed:
```bash
curl -sS https://writer-engine-runtime-develop.up.railway.app/openapi.json \
  | python3 -c "import sys, json; print('\n'.join(sorted(json.load(sys.stdin)['paths'].keys())))" \
  | grep saga-state
```
Should print `/pipelines/newsletter/saga-state/{execution_id}`. If it doesn't after ~3 minutes, check Railway service status.

Then:
- Direct synthetic gateway smoke (saga state read, not just start): start a run, sleep 8s, GET state. The shared secret is on the gateway: `railway variables --service writer-engine-gateway -e develop --kv | grep SERVICE_SHARED_SECRET`.
- The UI smoke needs the engine-backed `lib/approvals.ts` branch first (see below).

## The two known integration gaps

1. **`lib/approvals.ts` only knows about n8n.** Express's POST `/api/newsletter/approvals/:token/resolve` calls the n8n resume path. The engine's HITL gates live in its own Redis-backed token store, not `newsletter_approvals_v2`. Until a `getBackend()`-aware branch lands in `lib/approvals.ts` that POSTs to `${NEWSLETTER_SERVICE_URL}/internal/newsletter/approvals/{token}/resolve` when the saga is engine-backed, **the UI's Approve button does nothing for engine-backed sagas.** ~Half-day of WW server work, scoped as F2-7 in the engine sprint plan. Highest-priority post-merge task.

2. **F1-A prereqs #2 #5 #6 still pending** — `writer_engine.library_helpers/` package, `writer_engine.embeddings` adapter (behind `ENABLE_PYTHON_EMBEDDINGS` flag), and `EngineSettings` env-var expansion. Open a new branch `feature/engine-f1a-prereqs-2` once PR #77 merges.

## F1-A module port order (decided)

After all six prereqs are in, port modules in this order (low → high risk):
`research_step → library_step + story_bible_step + notify_step → brainstorm_step → media_step → chapter_qa_step → chapter_step`

Each module ships as its own PR with module-specific tests and lives behind a per-tool routing flag in the n8n hub (`app_config.python_backend_routing`). F1-B is the cutover sprint.

## Outstanding user decisions (ask once)

- Order of attack for F1-A (default: research first per above; alternative is chapter first for highest-value-first).
- Format-kindle in F1-A or deferred? It's a small port (~250 LOC, `python-docx`, mirrors the live `routes/export.ts` page-size table). Recommend included.
- Save the F1-A research workflow per-module specs as wiki pages under `Engineering/architecture/python-backend/f1a-specs/`?

## Things to keep in mind

- The user does NOT want you to ask before pushing branches or opening PRs in normal day-to-day work. Just do it. Pause only for PROD-touching changes (Tier 2/3 per CLAUDE.md — PROD workflows, PROD Supabase, base-table immutability).
- The user does NOT want to be told to click buttons in Railway / Supabase dashboards when you can do the same thing via CLI or API. CI/CD via `develop` merge is the standard deploy path for every container.
- Don't prefix prompts the user will paste with "Hey, I'm going to…" — say what you did, what's next.
- When the runtime container doesn't pick up a deploy after `railway up`, it's because Railway dedupes identical-content tarballs. **Push the commit to `develop` instead** — that triggers CI/CD reliably.
- The 5-gate work-ordering from 2026-05-25 (Newsletter PROD ship → Sprint 15 → Sprints 16-22 → Sprints 23-27 → Sprint 9) is **still authoritative for the larger plan**, but Gate 1 is now executed via the Python engine rewrite rather than n8n promotion.

## Security carry-forward (from 2026-05-28 and 2026-05-30)

- Rotate PROD Postgres password (was in shell history).
- Rotate the 4 API keys (Gemini, Perplexity, OpenAI, Firecrawl) that passed through chat in the 2026-05-30 session — they were placed in `engine/.env` (gitignored) but transited the chat stream.
