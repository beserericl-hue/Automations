# Writer Engine

> Per-step Python microservices for AI writing pipelines — the salable engine behind writing apps.

This monorepo contains the **Writer Engine**: a shared Python library (`writer_engine`) plus thin per-step
microservices that compose into long-form-content and newsletter generation pipelines. It is the F0 foundation of
[[engine-framework]] and is consumed by the Writers Workbench reference app and (later) external B2B customers.

## Layout

```
engine/
├── packages/
│   └── writer_engine/      # the salable library: llm, prompt store, schemas, adapters, state machine
├── services/
│   ├── gateway/            # FastAPI gateway (/internal, /v1, /admin, SSE relay)
│   ├── orchestrator/       # saga coordinator + arq worker for long-running pipelines
│   └── library_retrieve_step/  # F0-8 vertical-slice step service (read-only Supabase query)
├── docs/                   # architecture, "adding a step service", deployment
├── load/                   # k6 smoke load (L6 harness)
├── scripts/                # dev-up.sh and friends
├── .github/workflows/      # CI
├── docker-compose.yml      # full local stack
└── pyproject.toml          # uv workspace
```

## Quickstart

```bash
# 1) install (uses uv workspaces)
make install

# 2) lint + type-check + tests (L0-L4)
make ci

# 3) bring up the full local stack (gateway + orchestrator + step + redis)
cp .env.example .env  # then fill in secrets
make compose-up

# 4) hit it
curl -s http://localhost:8000/admin/health
curl -s -H "X-Service-Secret: $SERVICE_SHARED_SECRET" \
  -X POST http://localhost:8000/internal/library/retrieve \
  -H 'content-type: application/json' \
  -d '{"user_id":"00000000-0000-0000-0000-000000000000","limit":5}'
```

## Adding a step service

See [docs/adding-a-step-service.md](docs/adding-a-step-service.md). The pattern: import `writer_engine`, implement
one async `run(input)`, the template gives you `POST /run`, `/admin/health`, `/metrics`, Dockerfile, and tests for
free.

## Design references

The architecture, decisions, and roadmap live in the Obsidian wiki:

- `engine-framework` — program-level architecture
- `newsletter-microservices` — first concrete pipeline design
- `engine-api-system-tests` — system test plan
- `engine-framework-sprints` — F0/F1/F2 task breakdown
