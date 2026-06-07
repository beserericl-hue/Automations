# Token & cost accounting (CR-007) — The Burial Mound

Token + USD cost for every LLM call now lands in **`token_usage_v2`** (the same table the n8n
workflows used), tagged with `metadata.project_id` / `chapter_number` / `workflow_name`. This is the
billing-grade record that was missing from the engine before CR-007.

## Measured: full repair Q/A pass (ch0–95, 96 chapters)

Drift-correct + focused research + line-edit, captured per call:

| | |
|---|---|
| token_usage_v2 rows | 484 (388 Sonnet + 96 Perplexity sonar-pro = 1 research/chapter) |
| input tokens | 4,596,260 |
| output tokens | 1,502,593 |
| total tokens (incl cache) | 6,631,951 |
| **total cost** | **$36.56** |
| per chapter | ~69,082 tokens · **$0.381** |

Rates used (per 1M tok): Sonnet 4.x $3 in / $15 out / $0.30 cache-read / $3.75 cache-write;
Perplexity sonar-pro ~$3/$15. (Override in `token_accounting._DEFAULT_RATES` if rates change.)

## Credit model — tokens per credit (10 credits / chapter)

**Important:** the table above is the cost of a **repair**. The 10-credits/chapter price is for a
chapter **write**, which is heavier (5 sub-chapters + plan + research + drift + QA + correction) than a
repair (research + drift + one correction). The original 84-chapter write pass ran **before** CR-007,
so its tokens were not captured — only repairs have exact numbers so far.

Estimate (write ≈ 2–2.5× a repair):
- write ≈ **150–180k total tokens / chapter** → at 10 credits/chapter, **1 credit ≈ 15–18k tokens**.

To set the **exact** ratio, measure one fresh chapter write with CR-007 active (on a throwaway test
project, not Burial Mound): `total_tokens(write) / 10 = tokens per credit`. Going forward every write
records its real cost in `token_usage_v2`, so the credit price can be tuned from live data and the
n8n `token_usage_daily_v2` view gives per-user/per-day cost analytics for free.

## Note on the original build cost
The "$ to build the 98 chapters" question can't be answered exactly from the DB — the write pass
predated CR-007 (tokens went only to transient Prometheus counters + the Redis budget). The
authoritative figure for that day is the **Anthropic Console** usage for 2026-06-06. From here on,
every generation's cost is in `token_usage_v2`.
