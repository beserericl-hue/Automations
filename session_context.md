# Session Context — Writer's Workbench Engine (Path B) parity + cutover

_Last updated: 2026-06-10. Branch: `develop` (all work committed + pushed)._

## LATEST SESSION (2026-06-20) — CR-010 B1/B2: kill remaining n8n fallbacks (commit `bfe2c6b`, on `develop`)

All on DEV, pushed to `develop` (engine + server repo-connected → auto-redeploy). Closes the
"no user action falls back to n8n with HUB_BACKEND=engine" acceptance bar except the ingestion cron.

- **B1 rewrite-with-research** (`/api/content/:id/rewrite-with-research`) now branches on `hubBackend()`
  → engine `chapter.repair` (returns an engine job_id the `useEngineJobQueue` poller already reads); n8n
  path kept as fallback. Engine `_op_repair` now honours author params threaded through
  `_drift_correct_pass` → `_correct_drift`: `research_focus` forces a Perplexity fetch even with no QA
  gap and binds the query to it; `style_directives` applied; `citation_mode` → invisible (fiction) vs
  inline footnotes (non-fiction). `use_qa_report` is passed but the engine re-detects QA fresh (cycle 1),
  which supersedes the stored report (equivalent-or-better).
- **B1 brainstorm submit** (`/api/brainstorm/submit`) branches on `hubBackend()` → engine
  `create-project` (sync) then `brainstorm.story` (async, `persist:true`) — mirrors n8n create→brainstorm→save.
- **B2b lifecycle** — engine `library.lifecycle` now snapshots into `content_versions_v2` on approve/publish
  and emails on approve/publish/reject/schedule (new `send_lifecycle_email`), the auto-version + notify the
  old direct-Supabase UI write skipped. New `POST /api/content/:id/lifecycle` (engine-first, server-side
  snapshot+status **fallback** so approve/publish never hard-fails on engine downtime). ContentDetail
  status + schedule mutations route through it (impersonation path unchanged).
- **B2a** — ContentDetail Engine-QA "Fix drift" is now non-blocking + Cancel, via a new shared
  `client/src/hooks/useChapterRepair.ts`; the Chapters-table button (`dae99d7`) refactored onto the same
  hook (−~75 lines dup).
- **B2c** — deleted dead `sendWebhookCommand`.
- Verify: client+server tsc clean; server tests 12/12; engine ruff clean; gateway pytest 13/13.
  **NOT yet exercised against the live engine** (no live job run / no browser click) — do post-deploy.

### REMAINING CR-010 (next): A2 embeddings+token-accounting (quality parity), A2 versions/bible + A3
email-content, B3 first-class buttons (research/social/image/bible), then Part C scale (queue split,
per-provider budgets, replicas+LB, HA Redis). A1 Eve callback still gated on agent go-ahead. A3 ingestion
cron decision (keep n8n vs port) is the only user-invisible n8n dependency left.

---

## LATEST SESSION (2026-06-09 → 06-10) — newest first, all on DEV, pushed to `develop`

### Z. Removed dead `format-kindle` engine op (commit `6c74d08`)
- Audited Export-to-Word end to end: the Workbench **Export tab** (`client/.../export/ExportDialog.tsx`) → `POST /api/export/docx` → `server/src/routes/export.ts` builds the KDP `.docx` **fully server-side** via the `docx` lib from `published_content_v2` (status approved/published only, Prologue→Ch1-N→Epilogue). It **never calls the engine**.
- Engine `chapter.format-kindle` was a stub returning a fake path, reachable only via a chat "format kindle" command. Removed: catalog entry, `_op_format_kindle`+OPS, router heuristic branch + `_FORMAT_KINDLE*`/`_PAGE_SIZE` regexes. "format for kindle" now degrades to conversation. Hub-router tests updated (35 pass), ruff clean. CR-010 A1 marked resolved.
- Note: user's Export tab showed "0 of 96" because Burial Mound chapters are all `draft` — export only includes approved/published. Working as designed.

### Y. CR-010 — full n8n→engine→UI parity audit, ONE consolidated CR (commit `c55684e`)
- File: `writers-workbench/docs/change-requests/CR-010-engine-parity-completion-ui-wiring-and-multi-engine-scale.md` (indexed in change-requests/README.md).
- Method: mapped all 24 n8n V2 workflows (`workflows/01..24`) vs engine `hub/catalog.py` (21 ops) + each `services/*/main.py` OPS vs UI buttons→server routes. Spot-verified top gaps in source.
- Key gaps captured: engine STUBS (format-kindle [now removed], eve-callback/reset placeholders in notify_step); PARTIALS (embeddings off+untriggered = lost canon-grounding in chapter.write; token accounting chapter-only; library versions/revert not hub-routable; story_bible.update not routable; no "email me X" op); MISSING pipeline (content ingestion/scraping cron has no engine producer); UI still on n8n even with HUB_BACKEND=engine (rewrite-with-research, brainstorm submit); blocking/orphaned UI (ContentDetail Fix-Drift while-loop, approve/publish via UI skips snapshot+email, dead `sendWebhookCommand`, no buttons for research/social/image/bible); multi-engine LB remaining (extends CR-003): gateway replicas+LB, per-provider shared budgets (OpenAI/Perplexity/Gemini), heavy/light queue split, HA Redis + alerting (the 9-day outage gap), autoscaling.
- **Recommendation flagged to user**: for format-kindle, route hub op to server `/api/export/docx` rather than reimplement — but user chose to REMOVE it (done, item Z).

### X. Non-blocking action buttons + Generate Cover Art (commit `e7561d7`)
- Root cause: Outline/Re-outline, Write/Rewrite, Run Q/A used `sendWebhookCommand` → posts n8n webhook SYNCHRONOUSLY (hangs UI for the whole op) and post-cutover bypassed the engine.
- `client/src/lib/webhook.ts`: new `enqueueHubCommand()` → always POSTs `/api/chat/proxy` (engine-aware) → returns `job_id` instantly.
- `client/src/hooks/useEngineJobQueue.ts` (NEW): tracks many jobs by action key, background-polls `/api/jobs/engine/:id/status`, invalidates React Query keys on complete. Click never awaits generation → fan out freely.
- Wired in `ProjectDetail.tsx`: Outline/Re-outline + Write/Rewrite (Outline tab), Rewrite (Chapters tab) → queue + "Queued…". `QAReportPanel.tsx`: Run Q/A/Re-run → queue+poll. New **Generate Cover Art** button in Book Overview → `media.cover-art` from premise → Art gallery (generate many, pick at publish), invalidates `['generated-images']`.
- RewriteWithResearchModal was ALREADY non-blocking (BullMQ→jobId) — untouched.
- Verified offline via `_heuristic_route` (no jobs run): every command → queued TASK op (chapter.plan / chapter.write / chapter.qa / media.cover-art). Client tsc clean. NOT yet clicked in a live browser / no live job run.

### W. Graceful per-job Cancel for Fix Drift (commit `dae99d7`)
- orchestrator `WorkerSettings.allow_abort_jobs=True` + `POST /pipelines/write/jobs/{id}/abort` (arq abort: queued→dropped, running→cancelled at next await, not retried). Module-level logger added.
- gateway passthrough `POST /internal/write/jobs/{id}/abort` (+2 tests, 15 gateway tests pass).
- server `abortEngineJob()` + `POST /api/jobs/engine/:id/abort`. client Cancel button on Chapters Fix Drift (shows once "Queued — fixing…").
- Engine repo-connected → auto-redeploys; worker restart on deploy activates allow_abort_jobs. NOT yet smoke-tested live post-deploy.

---


## What this session did (all on DEV, all pushed to `develop`)

### 1. Cover-art parity (committed)
- `media._op_cover_art` generated images (KIE.AI nano-banana → DALL-E fallback → Supabase `cover-images` bucket) but **never wrote a `generated_images_v2` row**, so the UI showed "No cover image."
- Fixed: `_upload_cover` now returns `(public_url, storage_path)`; new `_record_generated_image()` inserts a `generated_images_v2` row (image_type=`cover_art`, project_id, storage_path, prompt, genre, model) — n8n `save_to_storage` (workflow 02) parity. `media` is in `_EMAIL_TOOLS` so it emails on completion.
- File: `writers-workbench/engine/services/media_step/src/media_step/main.py`

### 2. Stronger character-drift correction (committed)
- ch36 (Burial Mound) kept flagging drift: outline says **Sokan is "Ahanu's rival"** but the chapter depicted them cohabiting (a REAL contradiction, not a false-positive). The conservative correction only softened wording → alternating aligned true/false across runs.
- Fixed `_build_correct_system` (chapter_step) so a roster **relationship** contradiction is top priority: the model must **re-stage the scene** (setting/blocking/dialogue), not soften a word.
- Also `persist_chapter` now stamps `updated_at` on re-writes (no DB trigger existed; repaired rows kept first-write timestamps).
- Files: `services/chapter_step/src/chapter_step/main.py`, `packages/writer_engine/src/writer_engine/persist_helpers.py`

### 3. Task-completion emails — CONFIRMED WORKING
- Verified a real email arrived (`eve@courseworx.media` → `eric@agileadtesting.com`) at 2026-06-08T00:00:09Z for ch36 `chapter.repair` with full metadata (task, project, chapter, words 7653, **Aligned: True**, tokens 67671, $0.367406) + excerpt.
- Root cause of earlier silence: prior runs predated the CR-009 email deploy (`bea8338`). Worker emails on `status=="ok"` for tools `{chapter, brainstorm, research, media}`; recipient resolves from `users_v2.email` (phone-number user `+14105914612` → the email).

### 4. ch36 Fix Drift — VERIFIED end-to-end (engine→DB→email)
- Latest repair (00:00:09) cleared drift across all three stores: `chapter_qa_v2` aligned=true, `published_content.metadata.drift_report` aligned=true (character_drift 0), email "Aligned: True".
- Caveat: verified the engine path the button POSTs (`/api/content/:id/repair` → engine `chapter.repair`); did NOT click the button in a live browser.

### 5. Eve voice webhook (committed)
- Added `POST /internal/hub/voice` (gateway `routes/internal.py`): ElevenLabs server-tool surface. Maps `system__caller_id`/`caller_id`/`phone_number` → user_id, `user_message_request` → message; returns FLAT `{response, kind, job_id?, status?, tool?, op?}` the agent speaks. Shared `_execute_hub()` with `/hub`. Stateless per turn (ElevenLabs holds dialog).
- `dispatch.py`: synthesizes a generic spoken ack for queued tasks when the router gives none.
- 11 gateway tests pass (added voice caller-id-mapping + flat-shape + secret-gate tests).
- NOTE: pointing the Eve **agent** at this is a baseline-protected ElevenLabs config change — needs user go-ahead. NOT done.

### 6. Fix Drift button in Chapters table (committed) — now NON-BLOCKING
- Added `ChapterFixDriftButton` to the Chapters table action set (shows on rows where latest QA `aligned===false`), next to Rewrite / Rewrite with research.
- User feedback fixed: button **queues and returns immediately** ("Queued — fixing…"), a background `useEffect` poller watches the engine job and refetches `project-chapter-qa` + `project-chapters` when complete (badge flips to ✓). User can fan out Fix Drift across many chapters.
- File: `writers-workbench/client/src/components/projects/ProjectDetail.tsx`

### 7. CUTOVER FLIPPED — DEV chat now routes through the engine hub
- Set on Railway service **WritersWorkbench** (env `develop`):
  - `HUB_BACKEND=engine`
  - `ENGINE_GATEWAY_URL=http://writer-engine-gateway.railway.internal:8000`
  - (`SERVICE_SHARED_SECRET` already shared between server + gateway = `3a69afb2...faedf1ff`, 64 chars)
- Redeployed + healthy (build `fe1e4b7`; `/api/health` → supabase/redis/postal all ok).
- Smoke-tested engine hub via gateway public URL `https://writer-engine-gateway-develop.up.railway.app` with `x-service-secret`:
  - conversation → `kind:reply` ✓
  - `list all my outlines` → `kind:data`, tool `library list-outlines`, orchestrator payload ✓
  - `/internal/hub/voice` → flat `{response, kind}` ✓
- To REVERT cutover: `railway variables --service WritersWorkbench --set "HUB_BACKEND=n8n"` (or unset).

## RESOLVED — running-job question + graceful Cancel built (commit `dae99d7`, on develop)
- User's answer: the in-flight repair **completed on its own** (no kill needed); the UI now shows additional drift, which is the start point for the next fix. No destructive action was taken.
- User said **YES, build a real Cancel** — DONE this session:
  - orchestrator `WorkerSettings.allow_abort_jobs=True` (worker.py); new `POST /pipelines/write/jobs/{id}/abort` (main.py) sets arq's abort flag — queued job dropped before run, running job cancelled at its next await, aborted jobs not retried. Added module-level `logger` (routes live in `build_app`, the old `logger` was only in `lifespan`).
  - gateway passthrough `POST /internal/write/jobs/{id}/abort` (internal.py) + 2 tests (forward + secret-gate). 15 gateway tests pass.
  - server: `abortEngineJob()` (engine-hub.ts) + `POST /api/jobs/engine/:id/abort` proxy (jobs.ts).
  - client: **Cancel button** on the Chapters Fix Drift action — shows once a row is "Queued — fixing…" AND a job_id exists; aborts, stops the poller, refetches QA/chapters. (`ChapterFixDriftButton` in ProjectDetail.tsx.)
  - Confirmed the non-blocking/queue ask: each row has its own state + background poller, so clicking Fix Drift queues and returns immediately and the UI is free to fan out across many chapters in parallel — unchanged, verified by reading the component.
- Checks: engine ruff clean, gateway pytest 15 green, client + server `tsc --noEmit` clean, orchestrator app builds with the `/abort` route registered.
- Deploy: engine is repo-connected → orchestrator+gateway auto-redeploy from develop; the worker restart on deploy is what activates `allow_abort_jobs`. NOT yet smoke-tested against the live gateway post-deploy (do this next session: enqueue a repair, hit `POST /api/jobs/engine/:id/abort`, confirm `aborted:true`).

## NON-BLOCKING ACTION BUTTONS + COVER ART (commit `e7561d7`, on develop)
User: every heavy action button hung the UI until done; make them queue + free the UI; ensure the engine handles each; add a Generate Cover Art button.
- Root cause: Outline/Re-outline, Write/Rewrite, Run Q/A used `sendWebhookCommand` → posts to the n8n webhook **synchronously** (pending for the whole op) and, post-cutover, bypassed the engine entirely.
- `client/src/lib/webhook.ts`: new `enqueueHubCommand()` → always POSTs `/api/chat/proxy` (engine-aware) → heavy op enqueues, returns `job_id` instantly.
- `client/src/hooks/useEngineJobQueue.ts` (new): tracks many jobs by action key, background-polls `/api/jobs/engine/:id/status`, invalidates React Query keys on complete so results auto-appear. Click never awaits generation → fan out freely.
- `ProjectDetail.tsx`: Outline/Re-outline + Write/Rewrite (Outline tab) and Rewrite (Chapters tab) queue + show "Queued…"; **new Generate Cover Art button** in Book Overview builds a `media.cover-art` job from the premise → Art gallery (generate many, pick at publish), invalidates `['generated-images']`.
- `QAReportPanel.tsx`: Run Q/A / Re-run queue + poll (no block).
- **RewriteWithResearchModal was already non-blocking** (BullMQ enqueue → jobId) — untouched.
- Verified routing offline via `_heuristic_route` (non-destructive, no jobs run): every command → a queued **task** op: `chapter.plan` (outline), `chapter.write` (write/rewrite), `chapter.qa` (q/a), `media.cover-art` (cover). Catalog in `engine/.../hub/catalog.py` confirms all routes exist; Gemini is the live primary router (cleaner param extraction).
- Caveats: in the deterministic FALLBACK, "rewrite" maps to `chapter.write` (still produces a new draft) and project_title extraction is messy with the "IMPORTANT:…" suffix — Gemini (primary) extracts cleanly; command strings are unchanged from the proven n8n format. Client `tsc --noEmit` clean. NOT yet clicked in a live browser / no live job run this round.

## Pending / next tasks
1. ~~Resolve the running-job question~~ — DONE (job completed on its own).
2. ~~Build job Cancel~~ — DONE this session (commit `dae99d7`). Remaining: live post-deploy smoke test of the abort path.
3. **Eve agent cutover** (optional, needs permission): point the ElevenLabs Eve agent's server-tool at `/internal/hub/voice` + flat-response field. Baseline-protected — do NOT touch the PROD agent without explicit OK. **Still on HOLD until user says go.**
4. Live browser click-through of Fix Drift + Cancel (only thing not verified headless).
5. **New drift surfaced** — after the last repair, the UI shows additional drift on (a) chapter(s) of Burial Mound (`62cc734f-...`). User flagged this as the next fix to tackle.

## Key facts / credentials / commands
- DEV Supabase: `gvbvwcnmjkdpclcisqrr.supabase.co`. REST creds in `writers-workbench/engine/.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). PROD = `faklxfakgzkpkbxfihzh` — NEVER touch without permission.
- Burial Mound project_id: `62cc734f-c861-4210-bc12-e9ea002fcf66` (96 chapters, replaces the older Burial Mound). user_id = `+14105914612` (the phone-number user, email eric@agileadtesting.com).
- Railway: CLI linked to project `bubbly-solace`, env `develop`. Services: `WritersWorkbench` (server+client, public `writersworkbench-develop.up.railway.app`), `writer-engine-gateway` (public `writer-engine-gateway-develop.up.railway.app`, internal `writer-engine-gateway.railway.internal:8000`), `writer-engine-runtime` (all step services + arq worker + orchestrator). Engine is REPO-CONNECTED — do NOT `railway up`.
- Gateway smoke test: `SEC=$(railway variables --service writer-engine-gateway --json | python3 -c "import json,sys;print(json.load(sys.stdin)['SERVICE_SHARED_SECRET'])"); curl -X POST https://writer-engine-gateway-develop.up.railway.app/internal/hub -H "x-service-secret: $SEC" -H 'content-type: application/json' -d '{"message":"...","user_id":"+14105914612"}'`
- Engine tests: `cd writers-workbench/engine && uv run --project services/gateway python -m pytest services/gateway/tests/test_routes.py`
- Client typecheck: `cd writers-workbench/client && npx tsc --noEmit`
- Lint engine: `cd writers-workbench/engine && uvx ruff check <files>`

## Constraints (persist across sessions)
- NEVER modify PROD (Supabase `faklxfakgzkpkbxfihzh`, PROD n8n workflows, PROD ElevenLabs agent `agent_2801kks580vnf5q80j3bd0n0x45v`) without explicit permission. All work on DEV.
- Base tables immutable for migrations 008+. Never bypass branch protection. Never delete vault sample folders.
- Leaked n8n API key in `.mcp.json` — user handles it; do NOT use/expose.
- Autonomous-mode standing order (from stress test): on bugs, fix + record + continue; don't stop to ask.
