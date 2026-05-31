---
name: API contracts
description: Full HTTP endpoint spec for the Python backend. Public /v1, internal /internal, admin /admin. Request/response schemas, auth, error codes, idempotency.
type: concept
tags: [architecture, python-backend, api]
last_reviewed: 2026-05-09
---

# API contracts

Three layers of HTTP endpoints. Same business logic; different auth + multi-tenancy semantics.

## Auth model summary

| Layer | Auth | Identity source | Multi-tenancy | Used by |
|---|---|---|---|---|
| `/v1/*` | `Authorization: Bearer <api_key>` | `tenants_v2` row from API key hash | YES — every query scoped to `tenant_id` | External B2B customers |
| `/internal/*` | `X-Service-Secret: <secret>` | Request payload `user_id` (E.164) | NO — assumes internal trust + RLS in DB | Workbench server, n8n hub |
| `/admin/*` | `X-Admin-Token: <token>` | NA | NA | Operators, monitoring |

## Common request semantics

### Idempotency

Every mutating endpoint accepts `Idempotency-Key: <uuid>` header. If a request with the same key arrived in the last 24h, return the cached response unchanged. Implementation: Redis `idempotency:{key}` with TTL.

### Versioning

Path prefix: `/v1/...`. Breaking changes → `/v2/...`. Minor (additive) changes → no version bump. Deprecation announced via `Sunset` response header per RFC 8594; minimum 6 months.

### Error envelope

All errors return JSON:

```json
{
  "error": "INSUFFICIENT_CREDITS",
  "message": "Need 5 credits; have 2.",
  "request_id": "req_abc123",
  "details": { "credits_required": 5, "credits_remaining": 2 }
}
```

Error codes are stable enum values. `details` shape varies by error.

### Rate-limit headers

Every response includes:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1715279400
```

429 returned when exceeded.

### Async operations

Heavy operations return immediately with a `job_id`:

```json
HTTP 202 Accepted
{
  "job_id": "job_xyz789",
  "status": "queued",
  "estimated_completion_seconds": 240,
  "result_url": "/v1/jobs/job_xyz789"
}
```

Client polls `/v1/jobs/{job_id}` OR registers a webhook URL via `webhook_url` request field.

## Endpoint catalog

Complete list. Schemas defined in dedicated sections below.

### Module: chapter

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/chapters/write` | yes | `WriteChapterResponse` |
| POST | `/v1/chapters/{id}/qa` | sync | `QaResponse` |
| POST | `/v1/chapters/{id}/scan-drift` | sync | `DriftScanResponse` |
| POST | `/v1/chapters/{id}/rewrite-with-research` | yes | `RewriteResponse` |
| POST | `/v1/chapters/{id}/evaluate-genre` | sync | `GenreEvalResponse` |
| POST | `/v1/chapters/{id}/extract-bible` | sync | `ExtractBibleResponse` |
| POST | `/v1/projects/{id}/cross-chapter-continuity` | yes | `ContinuityCheckResponse` |
| POST | `/v1/chapters/{id}/format-kindle` | sync | `KindleFormatResponse` |
| POST | `/v1/chapters/build-context` | sync | `ChapterContextResponse` |

### Module: brainstorm

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/brainstorm/story` | yes | `BrainstormStoryResponse` |
| POST | `/v1/brainstorm/chapter` | yes | `BrainstormChapterResponse` |
| POST | `/v1/brainstorm/edit-outline` | sync | `EditOutlineResponse` |

### Module: research

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/research/run` | yes | `ResearchResponse` |
| GET | `/v1/research/{id}` | sync | `ResearchReport` |
| POST | `/v1/research/{id}/email` | sync | `EmailDispatchResponse` |

### Module: media

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/media/cover-art` | yes | `CoverArtResponse` |
| POST | `/v1/media/social-posts` | yes | `SocialPostsResponse` |
| POST | `/v1/media/scrape-url` | sync | `ScrapeResponse` |

### Module: library

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/library/insert-draft` | sync | `ContentItem` |
| POST | `/v1/library/{action}` | sync | `LibraryActionResponse` |
| GET | `/v1/library/versions/{content_id}` | sync | `list[ContentVersion]` |
| GET | `/v1/library/versions/{content_id}/{version_number}` | sync | `ContentVersion` |
| POST | `/v1/library/{content_id}/save-version` | sync | `ContentVersion` |
| POST | `/v1/library/{content_id}/revert/{version_number}` | sync | `ContentItem` |
| GET | `/v1/library/retrieve` | sync | `RetrieveResponse` |
| GET | `/v1/library/projects/{project_id}/chapters` | sync | `list[ContentItem]` |
| GET | `/v1/library/outlines` | sync | `list[OutlineSummary]` |
| GET | `/v1/library/outline-versions/{project_id}` | sync | `list[OutlineVersion]` |
| POST | `/v1/library/outline-versions/{project_id}/revert/{version_number}` | sync | `Outline` |

### Module: story_bible

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/story-bible/{action}` | sync | `BibleActionResponse` |
| GET | `/v1/story-bible/projects/{project_id}` | sync | `list[BibleEntry]` |
| POST | `/v1/research-reports/{action}` | sync | `ResearchActionResponse` |

### Module: approval

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/approvals/issue` | sync | `ApprovalToken` |
| GET | `/v1/approvals/{token}` | sync | `ApprovalRecord` |
| POST | `/v1/approvals/{token}/{action}` | sync | `ApprovalActionResponse` |

### Module: notify

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/notify/eve-callback` | yes | `EveCallbackResponse` |
| POST | `/v1/notify/eve-reset-greeting` | sync | `OkResponse` |
| POST | `/v1/notify/email` | sync | `EmailDispatchResponse` |

### Module: newsletter

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/newsletter/ingest` | sync | `IngestionResponse` |
| POST | `/v1/newsletter/cron/ingestion` | yes | `CronRunResponse` |
| POST | `/v1/newsletter/cron/cadence` | yes | `CronRunResponse` |
| POST | `/v1/newsletter/compose` | yes | `NewsletterComposeResponse` |
| POST | `/v1/newsletter/{send_id}/send-to-subscribers` | yes | `FanoutResponse` |

### Module: scheduler

| Method | Path | Async? | Returns |
|---|---|---|---|
| POST | `/v1/scheduler/run-publisher` | yes | `CronRunResponse` |
| POST | `/v1/scheduler/trial-check` | yes | `CronRunResponse` |
| POST | `/v1/scheduler/credit-reset` | yes | `CronRunResponse` |
| POST | `/v1/scheduler/trial-warnings` | yes | `CronRunResponse` |

### Job tracking + webhooks

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/jobs/{job_id}` | Status of any async job |
| POST | `/v1/webhooks` | Register webhook URL for completion callbacks |
| GET | `/v1/webhooks` | List registered webhooks |
| DELETE | `/v1/webhooks/{id}` | Remove |

### Account / billing (B2B customer-facing)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/account/api-keys` | Create new API key |
| GET | `/v1/account/api-keys` | List |
| DELETE | `/v1/account/api-keys/{id}` | Revoke |
| GET | `/v1/account/usage` | Current period usage |
| GET | `/v1/account/billing` | Billing portal link |

### Admin

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/health` | Liveness + dep checks |
| GET | `/admin/queues` | BullMQ depth per tier |
| GET | `/admin/metrics` | Prometheus format |
| POST | `/admin/reload-prompts` | Hot-reload from `app_config_v2.prompts` |
| POST | `/admin/flush-cache` | Clear Redis idempotency cache |
| POST | `/admin/tenants/{id}/suspend` | Suspend a tenant (rate-limit to 0) |

## Schema details (selected — not exhaustive)

### `WriteChapterRequest`

```python
class WriteChapterRequest(BaseModel):
    project_id: UUID
    chapter_number: int = Field(ge=0, le=999)   # 0=Prologue, 999=Epilogue
    chapter_run_id: UUID                          # idempotency key
    llm_strategy: Literal['sonnet','haiku','hybrid-draft-polish','hybrid-smart','tier-default'] = 'tier-default'

    # Optional inputs
    research_topic: str | None = None
    style_directives: list[str] = []
    sub_chapter_count_override: int | None = Field(None, ge=1, le=10)
    use_qa_report_as_input: bool = False
    citation_mode: Literal['auto','invisible','inline'] = 'auto'

    # Webhook callback (B2B only)
    webhook_url: HttpUrl | None = None

    # Internal-only fields (validated against headers; stripped from external requests)
    _user_id: str | None = None  # E.164; populated from /internal/ auth or tenant default user
```

### `WriteChapterResponse`

```python
class WriteChapterResponse(BaseModel):
    chapter_id: UUID
    chapter_run_id: UUID
    content_text: str
    word_count: int
    sub_chapter_count: int
    bible_entries_added: int
    metadata: dict
    timing: ChapterTiming
    cost: ChapterCost
    drift_scan_summary: DriftScanSummary | None  # if drift scanner ran
    qa_report: QaReport | None                    # if QA was inline-requested
```

### `RetrieveRequest` (query params)

```
GET /v1/library/retrieve
  ?content_type=chapter|short_story|blog_post|newsletter|outline|story_bible_entry|research|story_arc
  &search_term=<text>
  &project_id=<uuid>
  &status=draft|approved|published|rejected|scheduled
  &limit=50
  &offset=0
```

Same stop-words filter as n8n version: `outline`, `outlines`, `list`, `show` are removed from `search_term` before SQL query (pre-existing behavior).

### `BrainstormStoryRequest`

```python
class BrainstormStoryRequest(BaseModel):
    user_id: str  # E.164 (internal) — required
    title: str
    genre_slug: str
    project_type: Literal['story','series','kindle_book'] = 'story'
    requirements: str        # user description
    story_arc: str | None = None  # arc name; loaded from story_arcs_v2

    # Revision mode (per CLAUDE.md sprint 12 character lock)
    existing_project_id: UUID | None = None  # if set, revise rather than create
```

### `RewriteWithResearchRequest`

```python
class RewriteWithResearchRequest(BaseModel):
    chapter_id: UUID
    chapter_run_id: UUID
    research_focus: str            # what to research
    use_qa_report: bool = False    # consume metadata.qa_report findings
    style_directives: list[str] = []
    citation_mode: Literal['auto','invisible','inline'] = 'auto'
    webhook_url: HttpUrl | None = None
```

### `DriftScanResponse`

```python
class DriftScanResponse(BaseModel):
    chapter_id: UUID
    scanner_algorithm: Literal['deterministic-regex-v4'] = 'deterministic-regex-v4'
    drift_findings: list[DriftFinding]
    unknown_persons: list[UnknownPerson]
    scan_duration_ms: int

class DriftFinding(BaseModel):
    phase: Literal[0,1,2,3]
    kind: Literal['reverse_order_drift','forward_drift','unknown_person']
    canonical_name: str | None
    occurrence_text: str
    line_number: int | None
    severity: Literal['high','medium','low']
```

### `ContinuityCheckResponse` (NEW capability)

```python
class ContinuityCheckResponse(BaseModel):
    project_id: UUID
    chapters_scanned: int
    contradictions: list[Contradiction]
    rewrites: list[ProposedRewrite] | None  # only if auto_fix=true

class Contradiction(BaseModel):
    type: Literal['character_attribute','plot_event','timeline','setting']
    chapters_involved: list[int]
    description: str
    evidence: list[Evidence]
    severity: Literal['high','medium','low']
    suggested_resolution: str

class Evidence(BaseModel):
    chapter_number: int
    quote: str
    line_number: int | None

class ProposedRewrite(BaseModel):
    chapter_number: int
    span_start: int       # character offset in content_text
    span_end: int
    original_text: str
    rewritten_text: str
    rationale: str
```

## Error codes (stable enum)

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Bad / missing API key |
| `FORBIDDEN` | 403 | Authenticated but lacks permission for resource (wrong tenant) |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different request body |
| `RATE_LIMITED` | 429 | Per-API-key rate limit exceeded |
| `INSUFFICIENT_CREDITS` | 402 | (Internal only — Workbench tier billing) |
| `VALIDATION_ERROR` | 400 | Schema validation failed |
| `FK_VIOLATION` | 400 | Referenced entity doesn't exist (project_id etc.) |
| `STALE_ANCHOR` | 422 | Annotation/rewrite target text not found |
| `LLM_RATE_LIMITED` | 503 | Anthropic 429 propagated; client should retry-after |
| `LLM_OUTPUT_INVALID` | 502 | LLM produced unparseable output (e.g. JSON parse fail) |
| `STORAGE_ERROR` | 503 | Supabase Storage down / quota exceeded |
| `BLOB_MISSING` | 500 | Storage object expected but not found |
| `INTERNAL_ERROR` | 500 | Catch-all |

## Idempotency cache

Redis structure:
```
idempotency:{api_key_id}:{idempotency_key}  → {response_body, status_code, timestamp}
TTL: 86400  # 24h
```

Behavior:
- Request with same key + same body → return cached response.
- Request with same key + different body → 409 IDEMPOTENCY_KEY_REUSED.
- New key → process; cache result.

Internal endpoints follow same pattern but cache key includes `user_id` instead of `api_key_id`.

## Webhook callbacks

When `webhook_url` provided on a heavy-op request, after job completes the service POSTs:

```http
POST {webhook_url}
Content-Type: application/json
X-Author-Agent-Signature: sha256=<hmac of body using webhook_secret>

{
  "event": "chapter.write.completed",
  "job_id": "job_xyz789",
  "tenant_id": "tnt_abc",
  "data": { ... full WriteChapterResponse ... },
  "timestamp": "2026-05-09T14:23:11Z"
}
```

Customer verifies signature using their webhook secret. Retry policy: 3 attempts with exponential backoff (5s, 30s, 5m). After 3 failures: marked failed; visible in `/v1/webhooks/{id}/deliveries`.

Event names:
- `chapter.write.completed`
- `chapter.write.failed`
- `chapter.qa.completed`
- `chapter.rewrite.completed`
- `brainstorm.story.completed`
- `research.completed`
- `media.cover-art.completed`
- `newsletter.compose.completed`
- (etc., one per heavy operation)

## OpenAPI spec

FastAPI auto-generates OpenAPI 3.1 spec at `/openapi.json` and Swagger UI at `/docs`. Public spec excludes `/internal/*` and `/admin/*` endpoints (filtered by tag).

Customer SDK generation via `openapi-generator-cli`:
- Python: `openapi-generator-cli generate -g python -i openapi.json -o sdk/python`
- TypeScript: `openapi-generator-cli generate -g typescript-axios ...`
- Go: future

## Compatibility shim during migration

During [[python-migration-roadmap|migration]], hub can selectively use Python OR n8n per tool via `app_config_v2.python_backend_routing`:

```json
{
  "python_backend_routing": {
    "write_chapter": "python",
    "qa_chapter": "python",
    "brainstorm_story": "n8n",
    "cover_art": "n8n",
    ...
  }
}
```

Tool routing config read at hub startup (and on `/admin/reload-prompts`-style refresh). Lets each tool migrate independently.

## Versioning policy

| Change type | Version impact |
|---|---|
| Add new endpoint | none (additive) |
| Add optional request field | none |
| Add response field (non-breaking) | none |
| Remove endpoint | major (`/v2/`); 6-month deprecation window with `Sunset` header |
| Remove or rename request field | major |
| Change response field shape | major |
| Tighten validation | minor (announce; soft-fail for 30 days) |
| Loosen validation | none |
| Bug fix in business logic | none (announce in changelog) |

Customers pin version in path. We support N + N-1 simultaneously.
