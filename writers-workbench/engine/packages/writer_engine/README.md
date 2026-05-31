# writer_engine

The shared library that powers every Writer Engine step service and orchestrator.
See the parent [`engine/README.md`](../../README.md) and the wiki page `engine-framework` for the program design.

Modules:

- `llm` — Anthropic / Gemini / Perplexity adapters; prompt caching; token/cost accounting; multi-LLM router
- `prompt_store` — DB-backed prompt registry with hot reload
- `schemas` — Pydantic step-contract base + shared envelopes
- `supabase` — service-role client wrapper
- `redis_client` — async Redis + arq settings + pub/sub helper
- `storage` — Supabase Storage adapter
- `postal` — Postal email + archive permalink delivery
- `telemetry` — structlog + Prometheus + OTel
- `auth` — X-Service-Secret + API-key middleware + Supabase JWT
- `idempotency` — Redis-backed idempotency keys
- `rate_limit` — sliding-window per-key limiter
- `state_machine` — durable saga + HITL gate + SSE progress primitives
- `step_service` — FastAPI template for a step (one-function-per-service)
