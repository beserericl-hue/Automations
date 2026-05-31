---
name: Hub architecture (Python)
description: Python rewrite of the n8n hub. Webhook receiver + agent loop + tool dispatcher. Replaces PROD - The Author Agent. Eliminates n8n entirely from the runtime path.
type: concept
tags: [architecture, python-backend, hub, agent]
last_reviewed: 2026-05-10
---

# Hub architecture (Python)

The hub is the **single entry point** for chat + voice traffic. It receives a user message, decides what to do with it, and dispatches to the right service module. Currently n8n. After migration: Python service.

This page is the design for the hub Python service. It's the last piece of n8n elimination — once this ships, the runtime has no n8n dependency.

## Responsibilities (unchanged from n8n version)

1. Accept inbound webhooks from Eve (ElevenLabs) + ChatDrawer (Workbench Express).
2. **Preprocess message** — regex pre-routing for sync ops, flag-setting (isAsyncOp, isWebhookTrigger, isDirectOp, etc.).
3. Run an **agent loop** (Claude Haiku 4.5 with tool-use) that picks the right tool for the user's message.
4. Dispatch tool calls to backend service modules (chapter, brainstorm, research, library, etc.).
5. Compose and return the response (Type A async ack OR Type B sync data).
6. Handle Eve-specific behaviors (knowledge base callbacks, anti-stage-direction rules in prompt).

## Inbound surface

```
POST /webhook/author_request
  Content-Type: application/json
  Authentication: none (existing n8n behavior preserved)
  Body: {
    user_message_request: str,    // user's verbalized or typed request
    user_id: str,                  // E.164 phone number
    originalUserPrompt?: str,
    source?: 'eve' | 'chat' | 'ui'
  }
```

Same shape as the n8n webhook. Drop-in replacement. ElevenLabs forwarding tools (`forward_writing_request_v2`, `forward_writing_request_dev`) and Workbench `chat-proxy` keep working with only a URL change.

For B2B use, an alternate auth path:

```
POST /v1/agent/run
  Authorization: Bearer aa_live_...
  Body: {
    user_message_request: str,
    user_id?: str,                 // optional; otherwise tenant default
    project_id?: str,              // optional context hint
    sync_only?: bool = false,      // force sync; reject if would normally be async
    webhook_url?: str,
    idempotency_key?: str
  }
```

Both surfaces converge on the same agent loop internally.

## Service group placement

The hub is **CPU-light, latency-sensitive, scale-with-user-count**. Lives in the `api-svc` service group with the public `/v1/*` and internal `/internal/*` endpoints. See [[scaling-architecture]] for deployment topology.

Reasons to group with api-svc rather than its own service group:
- Shares the auth + rate-limiting middleware.
- Same Redis dependencies (idempotency, sessions, pub/sub).
- Hub doesn't issue heavy LLM calls itself — it just runs the routing agent + makes HTTP calls to other services. Light footprint.
- Reduces inter-service network hops (when hub and downstream tool API live in the same container, hub→tool is a function call not HTTP).

## Internal architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Hub Python Service (FastAPI)                                │
│                                                              │
│  POST /webhook/author_request                                │
│  POST /v1/agent/run                                          │
│       │                                                      │
│       ▼                                                      │
│  ┌──────────────────┐                                        │
│  │ preprocess_msg   │  regex pre-routing                     │
│  │   - flags        │  - isAsyncOp                           │
│  │   - isDirectOp   │  - isRetrieveOp                        │
│  │   - isListingOp  │  - isWebhookTrigger                    │
│  │   - matched_op?  │  - isEditOutlineOp                     │
│  └────────┬─────────┘  - isBrainstormOp                      │
│           │            - isReverttype                        │
│           ▼            (~30 regex rules total)               │
│  ┌──────────────────┐                                        │
│  │ Routing decision │                                        │
│  └──┬───────┬────┬──┘                                        │
│     │       │    │                                           │
│     │  sync direct│                                          │
│     │   call  │   │                                          │
│     │        │   │  async                                    │
│     │  ┌─────▼─┐ │  ┌────────────┐                          │
│     │  │ direct│ │  │ enqueue +  │                          │
│     │  │ tool  │ │  │ ack        │                          │
│     │  │ call  │ │  └─────┬──────┘                          │
│     │  └───────┘ │        │                                 │
│     │            │        ▼                                 │
│     │            │   Redis queue                            │
│     │            │   (worker picks up)                      │
│     │            │                                          │
│     ▼            ▼                                          │
│  ┌──────────────────┐                                        │
│  │ Agent loop       │  Claude Haiku 4.5 (or Gemini 2.5)      │
│  │ - load prompt    │  with tool-use                         │
│  │ - tool defs      │                                        │
│  │ - run iter       │                                        │
│  └────────┬─────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌──────────────────┐                                        │
│  │ Tool dispatcher  │  resolve tool name → service module    │
│  │                  │  call via HTTP or in-process           │
│  └────────┬─────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│      response composition                                    │
│           │                                                  │
│           ▼                                                  │
│      return                                                  │
└─────────────────────────────────────────────────────────────┘
```

## `preprocess_message` — regex pre-routing

Mirror of the n8n hub's `preprocess_message` Code node. Lives in `app/modules/hub/preprocess.py`.

```python
@dataclass
class PreprocessFlags:
    is_webhook_trigger: bool
    is_async_op: bool
    is_direct_op: bool          # bypass agent for direct dispatch
    direct_op: str | None        # tool name if isDirectOp
    is_retrieve_op: bool
    is_listing_op: bool
    is_revert_op: bool
    is_brainstorm_op: bool
    is_edit_outline_op: bool
    is_numbered_list_selection: bool
    selection_index: int | None
    matched_keywords: list[str]
    sanitized_message: str       # message with stop-words removed for retrieve_content

def preprocess_message(user_message: str) -> PreprocessFlags:
    msg = user_message.lower().strip()
    flags = PreprocessFlags(...)

    # Order matters — first match wins, except retrieve checked BEFORE brainstorm
    if RE_REVERT_OUTLINE.search(msg):
        flags.is_revert_op = True
        flags.is_retrieve_op = True
        flags.direct_op = "revert_outline"
    elif RE_LIST_OUTLINES.search(msg) or RE_BARE_OUTLINES.search(msg):
        flags.is_retrieve_op = True
        flags.is_listing_op = True
        flags.direct_op = "list_outlines"
    elif RE_QA_REPORT.search(msg):
        flags.is_direct_op = True
        flags.direct_op = "direct_qa_chapter"
    elif RE_NUMBERED_SELECTION.match(msg):
        flags.is_numbered_list_selection = True
        flags.selection_index = parse_index(msg)
    elif RE_EDIT_OUTLINE_TARGETED.search(msg):
        flags.is_edit_outline_op = True
        flags.direct_op = "edit_outline"
    elif RE_BRAINSTORM_OP.search(msg):
        flags.is_brainstorm_op = True
    # ... etc

    # Async vs sync classification
    flags.is_async_op = any([
        flags.is_brainstorm_op,
        RE_WRITE_OP.search(msg),
        RE_GENERATE_OP.search(msg),
        # etc
    ]) and not flags.is_listing_op

    # Sanitize for retrieve queries — strip stop words
    flags.sanitized_message = strip_retrieve_stopwords(user_message)

    return flags
```

Key behaviors preserved from n8n version:
- **Revert vs revise narrowing**: regex `revis(e|ing)` not `revise.{0,20}outline` — the latter false-matched "revert" and triggered brainstorm.
- **Retrieve op checked before brainstorm op**: prevents "revert outline" from triggering full re-brainstorm.
- **Numbered list selection** ("1", "show me 3", "#7", "the first one"): maps to item from last list in conversation.
- **Stop words for retrieve**: `outline`, `outlines`, `list`, `show` removed from search_term so `retrieve_content` works on bare keywords.
- **Direct ops bypass agent**: `direct_qa_chapter` and `edit_outline` (small targeted changes) skip the LLM agent entirely — Gemini/Haiku tend to fabricate "I updated X" without calling the tool. Direct dispatch removes that failure mode.

All regex constants in `app/modules/hub/regex_rules.py` for unit testability.

## Agent loop

```python
async def run_agent(
    user_message: str,
    user_id: str,
    flags: PreprocessFlags,
    session_context: SessionContext,
) -> AgentResponse:
    """Run the agent loop until it returns a final answer or hits max iterations."""

    system_prompt = await load_hub_prompt(user_id, session_context)
    tools = await load_tool_definitions(user_id)  # tier-aware tool gating
    messages = build_initial_messages(user_message, flags, session_context)

    for iteration in range(MAX_AGENT_ITERATIONS):  # default 8
        response = await llm_client.messages.create(
            model="claude-haiku-4-5",
            system=system_prompt,
            tools=tools,
            messages=messages,
            max_tokens=2048,
            temperature=0.3,
        )

        if response.stop_reason == "end_turn":
            return AgentResponse(
                text=extract_text(response),
                iterations=iteration + 1,
                tool_calls=session_context.tool_calls,
            )

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = await dispatch_tool(
                        tool_name=block.name,
                        tool_input=block.input,
                        user_id=user_id,
                        request_id=session_context.request_id,
                    )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result),
                    })
                    session_context.tool_calls.append((block.name, result))

            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})

        else:
            # Unexpected stop_reason
            log.warning("unexpected stop_reason", reason=response.stop_reason)
            return AgentResponse(text="(internal error)", iterations=iteration + 1, tool_calls=session_context.tool_calls)

    log.warning("agent loop max iterations hit", user_id=user_id)
    return AgentResponse(text="(stopped — agent loop max iterations)", iterations=MAX_AGENT_ITERATIONS, tool_calls=session_context.tool_calls)
```

### LLM choice — Haiku 4.5 default

Default LLM: **Claude Haiku 4.5**. Reasons:
- Excellent tool-use performance (Anthropic's claim).
- ~3-5× faster than Sonnet for routing decisions.
- ~15× cheaper than Sonnet ($1/MT vs $15/MT output).
- We're already on Anthropic for everything else; one fewer vendor.

Fallback / configurable: **Gemini 2.5 Flash** via Google API. Same shape (tool-use). Configured per-tenant via `app_config_v2.hub_llm_choice` or `tenant_config.hub_llm`. Default is Haiku.

For hubs where customers want premium quality (Pro+ tiers), allow opt-in to Sonnet 4.5.

### Tool definitions

```python
async def load_tool_definitions(user_id: str) -> list[dict]:
    """Load tool defs for the user's tier. Filters by feature gates."""
    user = await get_user(user_id)
    base_tools = ALL_TOOL_DEFINITIONS

    if not user.subscription.tier.features.get("cross_chapter"):
        base_tools = [t for t in base_tools if t["name"] != "cross_chapter_continuity"]
    if not user.subscription.tier.features.get("cover_art"):
        base_tools = [t for t in base_tools if t["name"] != "generate_cover_art"]
    # ... etc
    return base_tools
```

Tool definitions in `app/modules/hub/tools.py` — one entry per tool the agent can call:

```python
WRITE_CHAPTER = {
    "name": "write_chapter",
    "description": "Write a full chapter for a project. Async — returns ack immediately; user gets email when complete.",
    "input_schema": {
        "type": "object",
        "properties": {
            "project_id": {"type": "string", "description": "UUID of the writing_projects_v2 row"},
            "chapter_number": {"type": "integer", "description": "0=Prologue, 999=Epilogue, otherwise normal"},
            "research_topic": {"type": "string", "description": "Optional research topic to inform writing"},
            "style_directives": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["project_id", "chapter_number"]
    }
}

# ~24 tool definitions, mirroring the n8n hub's ai_tool list
```

Tools list (mirrors current PROD hub):
1. `write_chapter`
2. `write_blog_post`
3. `write_newsletter`
4. `write_short_story`
5. `brainstorm_story`
6. `brainstorm_chapter`
7. `edit_outline`
8. `format_kindle_book`
9. `qa_chapter`
10. `rewrite_chapter_with_research`
11. `evaluate_genre_compliance`
12. `scan_character_drift`
13. `generate_cover_art`
14. `repurpose_to_social`
15. `email_research_report`
16. `retrieve_content`
17. `manage_library` (insert/approve/publish/reject/schedule + version history)
18. `manage_story_bible`
19. `manage_research_reports`
20. `eve_knowledge_callback`
21. `cross_chapter_continuity` (Pro+ only — NEW capability)
22. `extract_bible` (mostly internal but exposed for power users)
23. `build_chapter_context` (internal)
24. `research` (general-purpose)

### Tool dispatch

```python
async def dispatch_tool(
    tool_name: str,
    tool_input: dict,
    user_id: str,
    request_id: str,
) -> dict:
    """Dispatch a tool call. Sync ops return data; async ops return ack + job_id."""

    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        return {"error": "unknown_tool", "tool_name": tool_name}

    classification = classify_tool(tool_name)  # 'sync' | 'medium' | 'heavy' | 'background'

    if classification == 'sync':
        # Direct call
        return await handler(tool_input, user_id, request_id)

    # Async — enqueue + return ack
    job_id = await enqueue_tool_job(
        tool_name=tool_name,
        tool_input=tool_input,
        user_id=user_id,
        request_id=request_id,
        priority=classification,  # medium-ops, heavy-ops, etc.
    )
    return {
        "ack": True,
        "job_id": job_id,
        "message": f"I'm working on that. You'll get an email when it's ready.",
    }
```

`TOOL_HANDLERS` is a registry of tool name → callable. Each callable either:
- Calls a backend service module function directly (in-process — same service group), OR
- Issues an internal HTTP call to another service group (`/internal/...` endpoint).

Co-located tools (same `api-svc` container) avoid the HTTP hop. Heavy operations route to worker pool via Redis queue.

## System prompt

Loaded from `app_config_v2.prompts.hub_system_v1` (or filesystem `prompts/hub_system_v1.md` as fallback). Hot-reloadable via `/admin/reload-prompts`.

Sections preserved from n8n version:
- Identity + role.
- TOOL OVERRIDE — never fabricate tool results.
- Type A (async ack) vs Type B (sync data) response rules.
- Listing & browsing content — explicit allowance.
- Mature fiction override — unlocks Gemini/Haiku default refusals (if using Haiku, may not need; if using Gemini, required).
- Available genres — 8 enumerated.
- Available story arcs — 8 enumerated with descriptions.
- Prologue + Epilogue rules.
- Numbered list selection.
- CHARACTER LOCK (3-layer: LOCKED CHARACTERS, Requirements copy-first, FINAL CHECK).
- Eve mode rules.
- Tone & speech style.
- Rule 4 — Type A vs Type B response framing.
- Rule 7 — anti-stage-direction (banned `[Sigh]`, `[whisper]`, etc.).

Stored as a single markdown document. Render via Jinja2 with per-request context injection (current project, recent list contents for numbered selection, etc.).

## Direct dispatch (bypass agent)

Three operations bypass the agent for safety + cost:

### 1. `direct_qa_chapter`

Triggered when user message contains "Q/A report" — direct call to `qa_chapter` tool with last-discussed chapter. Skips agent because Gemini/Haiku sometimes fabricates a Q/A report instead of calling the tool.

### 2. `edit_outline` for small changes

Triggered when message matches `(change|update) (the )?(name|age|description|gender)` (small targeted edits). Direct call to `edit_outline` tool. Reason: agent tends to fabricate "I updated the outline" without actually calling the tool for trivial changes.

### 3. `revert_outline`

Triggered when message contains "revert outline". Direct call to retrieve_content with `operation=revert_outline`. The original n8n bug (revert matching brainstorm regex) has stayed fixed by routing direct.

## Eve-specific behaviors

When `source='eve'` flag set in webhook payload:

- **Anti-stage-direction enforcement**: post-process agent response to strip any `[<word>]` patterns (per CLAUDE.md rule 7). Logged + alerted if detected.
- **First message reset**: after Eve knowledge callback flow completes, schedule a 30s-delayed `eve_reset_greeting` task (replaces n8n `Reset Eve Greeting` workflow).
- **KB upload**: when `eve_knowledge_callback` tool is called, the call goes to the notify module which handles the ElevenLabs KB upload + outbound call orchestration.

All Eve-specific code in `app/modules/hub/eve.py`.

## Session context

The hub maintains lightweight session state for the duration of an agent loop:

```python
@dataclass
class SessionContext:
    request_id: str
    user_id: str
    source: Literal['eve','chat','ui','b2b']
    started_at: datetime
    tool_calls: list[tuple[str, dict]] = field(default_factory=list)
    last_list: list[dict] | None = None  # for numbered selection
    flags: PreprocessFlags
```

For numbered-list selection, `last_list` is loaded from Redis at request start (key: `chat_history:{user_id}:last_list`) and updated when `retrieve_content` returns a list. TTL 30 minutes.

## Observability

Every hub request emits structured log entries:

```json
{"event":"hub_request","request_id":"...","user_id":"+1...","source":"eve","matched_keywords":["chapter","write"],"is_async_op":true}
{"event":"agent_iteration","request_id":"...","iteration":1,"input_tokens":4500,"output_tokens":120}
{"event":"tool_dispatch","request_id":"...","tool_name":"write_chapter","classification":"heavy","job_id":"job_xyz"}
{"event":"hub_response","request_id":"...","response_type":"async_ack","duration_ms":890}
```

Metrics:
- `author_agent_hub_requests_total{source}`
- `author_agent_hub_agent_iterations`
- `author_agent_hub_tool_dispatches_total{tool_name}`
- `author_agent_hub_request_duration_seconds`
- `author_agent_hub_llm_tokens_total{direction}`

OTel spans cover: hub request → preprocess → agent iterations → tool dispatches → response.

## Idempotency

Webhook receivers honor `Idempotency-Key` header (or, for `/webhook/author_request`, a synthesized key from `(user_id, hash(message), minute_bucket)` — duplicate webhook fires within 60s return cached response).

For B2B `/v1/agent/run`, idempotency key required (matches the rest of `/v1/*` API).

## Rate limiting

Per-user rate limit on `/webhook/author_request`: 30 requests/min/user_id. Prevents Eve from looping on stuck calls.

Per-tenant rate limit on `/v1/agent/run`: based on tenant tier (see [[productization]]).

## Reset Eve Greeting (folded into hub)

Replaces n8n workflow `t8xslqa3PWOFMAIM` (PROD) / equivalent.

```python
async def schedule_eve_reset(agent_id: str, default_greeting: str, delay_seconds: int = 30):
    """Schedule ElevenLabs agent first_message reset. Runs as a delayed worker job."""
    await enqueue_job(
        queue="background-ops",
        job_type="eve_reset_greeting",
        payload={"agent_id": agent_id, "default_greeting": default_greeting},
        delay_seconds=delay_seconds,
    )

# Worker handler in app/modules/notify/eve_reset.py
async def eve_reset_greeting_handler(payload: dict):
    await elevenlabs_client.patch_agent(
        agent_id=payload["agent_id"],
        first_message=payload["default_greeting"],
    )
```

Trivial; ~10 lines of Python replaces the entire n8n workflow.

## Approval Token Generator (folded into approval module)

Replaces n8n workflow `wdRZw4bjqPMOYd64` (PROD).

```python
# app/modules/approval/issue.py
async def issue_approval_token(send_id: UUID, user_id: str, expires_in_hours: int = 48) -> ApprovalToken:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(hours=expires_in_hours)
    await db().from_("newsletter_approvals_v2").insert({
        "token": token,
        "send_id": str(send_id),
        "user_id": user_id,
        "expires_at": expires_at.isoformat(),
    }).execute()
    return ApprovalToken(token=token, expires_at=expires_at)
```

Already part of the approval module per [[service-decomposition]]. The n8n workflow `Sub - Approval Token Generator` is fully replaced; no separate work.

## What's left in n8n after hub migration

**Nothing.** All 24 PROD workflows + the entire newsletter cluster + V1 baseline workflows are either:
- Migrated to Python (the active path).
- Frozen V1 (kept alive for legacy customers; not modified).

Production traffic flow:
- Eve / ChatDrawer / B2B → Cloudflare LB → api-svc (Python hub) → Python tool dispatch → Python workers → Supabase.
- No n8n hop in the runtime path for any active customer.

## n8n decommissioning

After Sprint 22 (hub migration) ships and runs stable for 30 days:

1. **Archive (don't delete) all migrated PROD workflows** — rename with `[ARCHIVED-2026-XX-XX]` prefix, deactivate. Keep for 90-day rollback window.
2. **Update ElevenLabs forwarding tools** (`forward_writing_request_v2`, `forward_writing_request_dev`) to point at Python hub URL.
3. **Update Workbench server `chat-proxy`** to call Python hub instead of n8n hub.
4. **V1 baseline Eve agent** keeps using V1 webhook (`/webhook/author_request`) — V1 stays in n8n indefinitely per CLAUDE.md baseline protection.
5. **n8n instance** can be downscaled to a single small container (V1 only). Saves ~$30/month + simplifies ops.
6. **Update CLAUDE.md baseline-protection rules** — Tier 2 (PROD workflows frozen except release/hotfix) becomes archival history; the new rule is "PROD workflows are decommissioned; Python services replace them per [[python-migration-roadmap]]".

After 90-day rollback window: delete archived PROD workflows. n8n instance hosts V1 only.

## Migration risk

The hub migration is the single highest-risk sprint in the program because:

1. **Behavioral parity is hard to verify.** The hub embeds 18 months of prompt engineering nuances. Subtle regressions are hard to catch without long-running production observation.
2. **All traffic flows through it.** A bug here affects 100% of users.
3. **Direct ops have edge cases.** The "revert vs revise" bug class is the kind of thing that can re-emerge.

Mitigations:
1. **Shadow mode for ≥14 days.** Both n8n hub + Python hub receive every request; response from n8n returned to user; Python response logged + diffed.
2. **Q/A diff dashboard.** Every shadow request produces a diff record. Engineers review daily during shadow period.
3. **Cutover by user-id hash.** 1% → 10% → 50% → 100% with monitoring at each step.
4. **Instant rollback via LB.** ElevenLabs forwarding tool points at LB host; LB swaps backend in seconds.
5. **Comprehensive test corpus.** 200+ representative user messages with expected (sync vs async, tool name, parameters) outcomes. Continuous regression test.

See [[python-migration-roadmap]] Sprint 22 for the full migration sprint plan.

## Cost projection

Hub LLM cost per request (using Haiku 4.5):
- Average input: ~3,500 tokens (system prompt + tool defs + message)
- Average output: ~150 tokens (mostly tool calls + brief text)
- Cost: ~3,500 × $0.25/MT + 150 × $1.25/MT = $0.000875 + $0.000188 = **~$0.001 per request**.

At 10,000 requests/day: **~$10/day = $300/month** in hub LLM cost. Negligible relative to chapter-write costs.

For comparison: current Gemini 2.5 Flash hub on n8n is ~$0.0008/request — Haiku is comparable cost, better tool-use accuracy.

## Why Haiku for the hub vs keeping Gemini

| Concern | Gemini 2.5 Flash (current) | Claude Haiku 4.5 (proposed) |
|---|---|---|
| Tool-use accuracy | Good but fabricates "I updated X" sometimes | Excellent; very rare fabrication |
| Latency | ~2-4s per turn | ~1-2s per turn |
| Cost | $0.0008/request | $0.001/request |
| Vendor count | 2 (Anthropic for tools, Gemini for agent) | 1 (Anthropic for everything) |
| Mature fiction handling | Refuses by default; needs override | Less restrictive natively |
| Anti-fabrication | Requires aggressive system prompt rules | Better baseline |
| Open-source alternatives | n/a | n/a |

Net: **Haiku 4.5** is better. Gemini config remains as a fallback flag.

## Open questions

1. Token budget for hub itself (separate from chapter Anthropic budget)? Probably yes — different rate limit on Haiku at Tier 3.
2. Should we cache common agent responses (e.g. greetings, "what can I do")? Probably yes — Redis cache keyed on hashed (system_prompt_version, user_message). Saves ~30% of hub LLM spend.
3. Streaming responses from agent? n8n hub doesn't stream. Python service could; would improve perceived UX. Out of scope for migration; consider for post-migration UX work.

## Cross-references

- [[service-decomposition]] — adds `hub` as module 11.
- [[api-contracts]] — adds `/webhook/author_request` + `/v1/agent/run` endpoint specs.
- [[queueing-architecture]] — describes the queue infrastructure the hub enqueues into.
- [[scaling-architecture]] — shows where hub fits in the deployment topology.
- [[python-migration-roadmap]] — Sprint 22 covers hub migration.
