# CR-004 — Engine Hub (Path B): move the conversational brain into the engine, retire n8n

| | |
|---|---|
| **Status** | In progress (Sprint A) |
| **Opened** | 2026-06-06 |
| **Tier** | DEV (build + validate); PROD cutover gated on sign-off |
| **Goal** | Replace the n8n "The Author Agent" hub with a hub **inside the engine**: one webhook for Eve (voice) and one chat endpoint for the UI, a **Gemini router** that selects the tool, info-gathering calls answered synchronously, load-bearing calls **queued in the engine** and serviced under the CR-003 concurrency/budget caps. Front-end change ≈ point at the new hub URL. |

## Why

Today the engine has the **hands** (per-tool dispatch `/internal/write/{tool}`, the arq queue, CR-003
scaling) but not the **brain**. The brain — intent classification, tool selection, numbered-list
selection, multi-turn conversation, the Eve voice contract — still lives in the n8n hub
(`PROD/DEV - The Author Agent`). Path B moves that brain into the engine so n8n can be retired.

## Design

```
            Eve (ElevenLabs)  ──POST /internal/hub/voice ─┐
                                                          ▼
  UI chat ──/api/chat/proxy──> server ──POST /internal/hub──>  ENGINE HUB
                                                          │   1. Gemini router → HubDecision
                                                          │      {kind, tool, op, params, reply}
                                                          │   2. dispatch:
                                                          │      conversation → reply (text)
                                                          │      info         → call step SYNC → {data}
                                                          │      task         → arq enqueue → {job_id,"queued"}
                                                          ▼
                                          existing orchestrator routes + arq worker (CR-003)
                                          → step services → persist (CR-001) → Supabase
```

### Response contract (the reason front-end work is ~zero)

The hub returns exactly the shapes the server already understands:

| HubDecision.kind | When | Hub response | Server maps to |
|---|---|---|---|
| `conversation` | pure chat, no tool | `{kind:"reply", assistant_message}` | `{mode:"sync", data}` |
| `info` | retrieve / list / lifecycle | `{kind:"data", assistant_message, data}` | `{mode:"sync", data}` |
| `task` | generation (load-bearing) | `{kind:"queued", assistant_message, job_id, status:"queued", tool, op}` | `{mode:"async", jobId}` |

The UI already polls `job_id` and reads results from Supabase (CR-001 persistence), so once the
server points at the engine hub the existing drawer/streaming works unchanged.

### Tool catalog (intent → engine tool/op)

| user intent | tool.op | kind |
|---|---|---|
| "write the chapter / prologue / epilogue" | `chapter.write` | task |
| "plan the chapter / chapter outline" | `chapter.plan` | task |
| "rewrite / revise chapter N" | `chapter.rewrite` | task |
| "fix / repair chapter N" (drift) | `chapter.repair` | task |
| "QA / quality check chapter N" | `chapter.qa` | task |
| "format for Kindle" | `chapter.format-kindle` | task |
| "brainstorm / outline a story/book/novel" | `brainstorm.story` | task |
| "revise the outline" | `brainstorm.revise-outline` | task |
| "edit the outline" (small targeted change) | `brainstorm.edit-outline` | task |
| "new project / create project" | `brainstorm.create-project` | task |
| "research …" | `research.run` | task |
| "cover art" | `media.cover-art` | task |
| "repurpose for social" | `media.social-posts` | task |
| "scrape <url>" | `media.scrape-url` | info |
| "retrieve / pull up / open <title>" | `library.retrieve` | info |
| "list outlines / drafts / projects" | `library.list-outlines` | info |
| "approve / publish / reject / schedule" | `library.lifecycle` | info |
| "list / show story bible" | `story_bible.list` | info |
| (none / chit-chat) | — | conversation |

## Sprint A — engine hub core (this PR)

- `writer_engine/hub/` package: `catalog.py` (single source of truth + router-prompt render),
  `schemas.py` (`HubRequest`/`HubDecision`/`HubResponse`), `router.py` (`route_message` via Gemini
  structured output + preprocess heuristics + tolerant fallback), `dispatch.py`
  (`build_dispatch_plan` — pure, testable: which orchestrator route + sync/async).
- Gateway route `POST /internal/hub` (chat) executing the plan via the existing `_forward`.
- Heuristics ported from the n8n `preprocess_message`: retrieve-before-brainstorm ordering,
  numbered-list selection (`"1"`, `"#3"`, `"the first one"`), `revert/revise/edit outline` routing.
- Tests: router classification, dispatch plan (sync vs async), catalog completeness, bad-JSON fallback.
- No front-end change; n8n untouched.

## Sprint B — Eve voice + cutover

- `POST /internal/hub/voice` — ElevenLabs payload; Eve-flavored responses (immediate spoken ack for
  tasks, spoken data for info); knowledge-callback + outbound-call hooks; mature-fiction allowances.
- Conversation state store (Redis, keyed by `user_id`/`conversation_id`): multi-turn memory,
  last-list (numbered selection), last-project anchor (anti-drift, ties to CR-002).
- Front-end cutover: server `resolveWebhookUrl()` → engine hub behind `HUB_BACKEND=n8n|engine`;
  map hub response → existing `{mode, data|jobId}`; bridge engine job progress (Redis channel) → the
  server SSE so the drawer streams; `/api/jobs/:id` proxy → engine `/write/jobs/{id}`.
- E2E: chat + voice → router → queue → chapter write → CR-001 persist → read in UI. Cutover/rollback
  runbook; DEV first, PROD flip gated on sign-off (per CLAUDE.md baseline protection).

## Out of scope / guardrails

- PROD untouched until the gated flip. All build + validation on DEV.
- n8n hub stays live as the rollback target (`HUB_BACKEND=n8n`) through Sprint B.
- Credits, auth, RLS, `user_id` threading preserved at the server boundary.
