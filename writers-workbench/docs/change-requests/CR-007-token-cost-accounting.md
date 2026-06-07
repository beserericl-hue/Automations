# CR-007 — Token & cost accounting (billing parity with n8n)

| | |
|---|---|
| **Status** | Done (engine) — UI wiring in CR-008 |
| **Opened** | 2026-06-06 |
| **Tier** | DEV (built + verified); PROD at go-live |
| **Goal** | Restore the per-call LLM token + USD cost record the n8n workflows kept, so cost-per-chapter is known and the credit model (1 credit = N tokens; 10 credits/chapter) can be set. |

## Problem

n8n wrote every AI call to **`token_usage_v2`** (input/output/total tokens + `cost_usd`, model,
workflow). The engine only had transient Prometheus counters + the Redis rate-limit budget (60s
window) — so cost-per-chapter was unknowable and the credit model couldn't be grounded.

## Solution (implemented)

- **`telemetry/token_accounting.py`** — request-scoped contextvar accumulator + per-model rate table +
  `cost_usd()`; `begin()/record()/flush()`. `asyncio.gather` children share the dict, so parallel
  sub-chapter usage is captured.
- **`llm/router.complete`** records every call (single choke point through which all providers go).
- **chapter handler** `begin()`s the context (user/project/chapter/op) and `flush()`es per-call rows
  to `token_usage_v2` via `persist_helpers.persist_token_usage` (total includes cache tokens).
- Rates: Sonnet/Haiku/Opus 4.x + Perplexity/Gemini (override in `_DEFAULT_RATES`).

## Verified

Full Burial Mound repair pass (ch0–95): **484 rows** (388 Sonnet + 96 Perplexity), input 4.60M /
output 1.50M / total 6.63M tokens, **$36.56** (~69k tok, **$0.38/chapter** for a repair). See
`knowledgebase/Writers Workbench Wiki/Workbench-Test-Output-7/TOKENS.md`.

## Open

- **Exact tokens-per-credit** needs one measured chapter **write** under CR-007 (writes are heavier
  than repairs; the original write pass predated CR-007). Estimate: write ≈ 150–180k tokens →
  1 credit ≈ 15–18k tokens at 10 credits/chapter.
- **UI**: `CostDashboard` reads `token_usage_v2`; project-scoping + credit mapping tracked in CR-008.
- Original build's exact $ is in the **Anthropic Console** (2026-06-06); not reconstructable from the
  DB since it predated this CR.
