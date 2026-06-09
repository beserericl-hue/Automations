# Session Context — Writer's Workbench Engine (Path B) parity + cutover

_Last updated: 2026-06-08. Branch: `develop` (all work committed + pushed)._

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
