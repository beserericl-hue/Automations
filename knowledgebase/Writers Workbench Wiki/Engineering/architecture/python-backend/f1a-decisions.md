---
name: F1-A decisions and corrections
description: Model ids, rate-limit headroom, format-kindle library choice, and the F1-A prereqs that have landed in writer_engine. Reference page — port specs cite this for the non-obvious calls.
type: concept
tags: [f1-a, anthropic, models, rate-limits, prereqs, decisions]
last_reviewed: 2026-05-31
---

# F1-A — decisions and corrections

Captures the load-bearing decisions that came out of the F1-A research workflow synthesis + subsequent corrections. Each module's port spec (chapter, chapter-qa, research, brainstorm, media, library-bible-approval-notify) cites this page for the non-obvious calls.

## Model lineup (pinned)

| Strategy slot | Model id | Use |
|---|---|---|
| Default for chapter sub-chapter writes, polish, merge, brainstorm, research synth | `claude-sonnet-4-6` | What the n8n worker uses today — the parity baseline |
| Cheap parallel fan-out, Q/A passes, drift-scan companion calls, structured-output extraction | `claude-haiku-4-5-20251001` | Highest TPM headroom; ~10× cheaper than Sonnet |
| Hardest polish, continuity merge over the whole chapter, hard genre-eval rubrics | `claude-opus-4-8` | Highest quality, highest TPM ceiling at Tier 4 (2M input TPM) — DO use for whole-chapter merges |

`chapter_step/strategy.py` resolves `llm_strategy` ∈ {`sonnet`, `haiku`, `hybrid-draft-polish`, `hybrid-smart`, `tier-default`} to a concrete `(sub_chapter_model, polish_model, merge_model, extract_model)` quadruple. `hybrid-draft-polish` is the configuration designed for parallel fan-out: Haiku writes sub-chapters → Sonnet polishes + merges.

## Anthropic Tier 4 rate limits (probed 2026-05-31)

Confirmed via `anthropic-ratelimit-*` response headers on a probe call against each model id, using the production `5LhCYKsaFO3fF7II` key:

| Model | Input TPM | Output TPM | RPM |
|---|---:|---:|---:|
| `claude-sonnet-4-6` | 450,000 | 90,000 | 1,000 |
| `claude-haiku-4-5-20251001` | 450,000 | 90,000 | 1,000 |
| `claude-opus-4-8` | 2,000,000 | 200,000 | 1,000 |

These numbers are the source of truth for the `writer_engine.rate_limit.AnthropicBudget` `DEFAULT_LIMITS` constant ([[engine-framework]] § rate limit). If the tier or the limits change, update the constant + this page together.

**Bottleneck analysis for parallel chapter writes.** A 6-sub-chapter chapter is ~60k input + ~18k output tokens (assuming a 10k system prompt cached after first call, and 3k output per sub-chapter). With prompt caching:

- **First chapter run** in a 60s window: ~60k input + 18k output (cache write).
- **Subsequent runs in window**: ~18k input (cache read costs ~0.1×) + 18k output.

Output TPM is the binding constraint: 90k ÷ 18k = **5 chapters/minute on Sonnet without falling behind**. With `hybrid-draft-polish` (Haiku writes, Sonnet polishes), output is split across two pools — practical ceiling is closer to 12 chapters/minute. For burst above that, `AnthropicBudget.wait_for_capacity` queues calls instead of letting them HTTP-429.

## Format-kindle: `python-docx`, not Google Docs

The earlier F1-A research workflow agent mis-identified the n8n `format_kindle_book` workflow as using "Google Docs batch ops + Drive share." **This is wrong.** The live UI export at [`writers-workbench/server/src/routes/export.ts`](../../../../writers-workbench/server/src/routes/export.ts) uses the `docx` npm package to generate Word `.docx` directly, with all 17 KDP page sizes baked in ([export.ts:11-29](../../../../writers-workbench/server/src/routes/export.ts#L11-L29)) and Prologue/Chapter-N/Epilogue label logic ([export.ts:184-189](../../../../writers-workbench/server/src/routes/export.ts#L184-L189)).

The Python port uses [`python-docx`](https://python-docx.readthedocs.io/) — same API shape, ~250 LOC of pure document construction. **No Google OAuth, no Drive share, no batch-ops complexity.** This is a normal F1-A port, not a blocker.

The chapter_qa_step port spec is updated accordingly: `format-kindle` op uses `python-docx`, mirrors the existing `routes/export.ts` page-size table + label logic, and emails the docx blob via the Postal `attachments` field (now supported, see prereq #1 below).

## Prereqs landed in this PR

PR #77 (feat(engine): F0 foundation + F2 newsletter saga + WW backend switch) ships the first three of the six F1-A prereqs identified by the research workflow synthesis:

| # | Prereq | Module | Tests |
|---|---|---|---|
| 1 | `PostalClient.send()` extended with `cc` / `bcc` / `reply_to` / `sender` / `headers` / `attachments` / `tag` — required by chapter_qa, brainstorm, media, library, notify | [`writer_engine.postal.client`](../../../../engine/packages/writer_engine/src/writer_engine/postal/client.py) | [`tests/test_postal_extensions.py`](../../../../engine/tests/test_postal_extensions.py) — 4 tests |
| 3 | `writer_engine.llm.json_extractor` — `try_repair_json` + `extract_and_parse` for messy LLM output (trailing commas, single-quoted keys, smart quotes, leading prose, markdown fences, line comments). `LLMResponse.citations` added. `PerplexityAdapter` populates it from sonar response. | [`writer_engine.llm.json_extractor`](../../../../engine/packages/writer_engine/src/writer_engine/llm/json_extractor.py) | [`tests/test_json_extractor.py`](../../../../engine/tests/test_json_extractor.py) — 11 tests |
| 4 | `writer_engine.rate_limit.AnthropicBudget` — Redis sliding-window per-model TPM/RPM gatekeeper. `wait_for_capacity()` + `record_usage()` 2-call interface; falls back to no-op when Redis unavailable. Tier-4 defaults baked into `DEFAULT_LIMITS` constant. | [`writer_engine.rate_limit.anthropic_budget`](../../../../engine/packages/writer_engine/src/writer_engine/rate_limit/anthropic_budget.py) | [`tests/test_anthropic_budget.py`](../../../../engine/tests/test_anthropic_budget.py) — 7 tests |

Outstanding prereqs (next PR after this merges):

| # | Prereq | Why deferred |
|---|---|---|
| 2 | `writer_engine.library_helpers/` (email_recipients, title_resolver, chapter_number normalizer, versions, story_bible, jsonb_merge) + Prime-Directive in `prompt_store.directives` | Larger surface; cleanly fits its own PR with the brainstorm + library spec work |
| 5 | `writer_engine.embeddings` (embed_texts + match_writing_documents RPC + re_embed_project async) behind `ENABLE_PYTHON_EMBEDDINGS` flag | Falls through to n8n shim by default — not blocking initial F1-A ports |
| 6 | Extend `EngineSettings` with new env vars (anthropic budget, postal defaults, model pins, tier flag, feature flags, all `*_STEP_URL`s) | Bundled with the first module port that needs them, not standalone |

## ProviderNotRegistered narrowing (already landed)

[`writer_engine.llm.ProviderNotRegistered(KeyError)`](../../../../engine/packages/writer_engine/src/writer_engine/llm/router.py) was added in the same PR. Step services (pick / subject / segment / research / assemble) catch only this typed exception when falling back to local fixtures, so a real Anthropic 429 / 500 / validation error bubbles up unmasked. This is the F1-A pre-pre-req — the fixture fallback no longer hides real production failures.

## See also

- [[engine-framework]] — program-level architecture
- [[engine-framework-sprints]] — F0 / F1-A / F1-B / F2 sprint task breakdown
- [[chapter-optimization-sprint]] — F2.5 algorithm optimization (post-F1-A)
- [[engine-api-system-tests]] — system test plan
- [[newsletter-microservices]] — F2 newsletter pipeline design
