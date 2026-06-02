# F1-B — hub routing + DEV→PROD cutover

Routes the n8n hub's write-workshop `ai_tool`s to the Python engine instead of `executeWorkflow`,
behind a per-tool `app_config` flag, with a DEV shadow before each PROD flip.

## Engine machinery (done — this is non-gated)

The 8 write-workshop step services now run inside `writer-engine-runtime` (Dockerfile COPY +
entrypoint start on ports 8020–8027 + `*_STEP_URL` config), and are callable through one uniform
route:

- **gateway** `POST /internal/newsletter/../write/{tool}` (`X-Service-Secret`) → forwards to
- **orchestrator** `POST /pipelines/write/{tool}/run` → dispatches to the step's `/run`.

Tools: `chapter`, `research`, `brainstorm`, `media`, `library`, `story_bible`, `approval`, `notify`
(name == step `STEP_NAME`). Body is the step payload (`{op, ...}`); response is the `StepOutput`.

Example:
```
POST https://writer-engine-gateway-develop.up.railway.app/internal/write/chapter
X-Service-Secret: <secret>
{ "op": "write", "project_id": "...", "chapter_number": 1, "chapter_run_id": "...", "llm_strategy": "sonnet" }
```

## Hub rewiring (F1-7 — DEV first)

Per write-workshop `ai_tool` in the **DEV** hub (`DEV - The Author Agent` + the `DEV - Tool - *`
workflows), replace the `executeWorkflow` call with an HTTP Request node to
`{ENGINE_GATEWAY}/internal/write/{tool}` (header-auth `X-Service-Secret`), gated by
`app_config.python_backend_routing.{tool}` (n8n reads the flag; both paths exist, flag chooses).

**Shadow:** with the flag in "shadow" mode, run BOTH the n8n tool and the engine call, log both
artifacts, and diff (the L5 parity harness). Target ≥95% agreement on structure + craft dimensions.

## Cutover (F1-8 — Tier-2/3, GATED on explicit user sign-off)

Per tool, after **7 clean days** of DEV shadow at ≥0.95 parity:
1. Flip `app_config.python_backend_routing.{tool}=engine` on PROD.
2. Smoke the tool on PROD.
3. After 7 clean days on PROD, archive the replaced n8n tool workflow (90-day rollback).

**Do not flip PROD without the user's go** — this changes the PROD hub (Tier-2) + PROD behaviour.
Set the PROD engine env first (`WORKBENCH_API_URL`, `INGESTION_SECRET`, `ANTHROPIC_API_KEY`,
`PERPLEXITY_API_KEY`, `KIEAI_API_KEY`, `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, step URLs).

## Remaining engine work before cutover
- `media.cover-art` (KIE.AI submit/poll + DALL·E fallback) and `media.scrape-url` (Firecrawl) HTTP
  clients (F1-A.6b) — keys present; currently stubs.
- L5 parity harness wired per tool (extends `scripts/f1a-chapter-regression.py`).
