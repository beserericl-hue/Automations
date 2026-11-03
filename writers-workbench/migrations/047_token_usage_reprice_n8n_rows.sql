-- 047: Price the n8n-era token_usage_v2 rows that 044 missed, and record Gemini as one provider.
--
-- WHY. 044 re-priced rows by `model`. The n8n workflows (Hub V2, Write Chapter Worker, QA Chapter V2,
-- Brainstorm Story/Chapter V2; 2026-03-27 to 2026-04-13) wrote a different shape:
--   * the model is in `llm_model`, `model` is NULL
--   * the tokens are in `prompt_tokens` / `completion_tokens`, `input_tokens` / `output_tokens` are 0
--   * the dollars are in `estimated_cost`, `cost_usd` is 0
--   * Gemini is recorded as provider 'google'
-- Every cost view sums cost_usd, so these rows counted as $0. On DEV (2026-11-02) that was
-- 118 Gemini rows (estimated_cost $1.87) and 151 Claude Sonnet 4 rows (estimated_cost $38.73).
-- Separately, 76 engine rows from 2026-04/05 are priced correctly but say provider 'google', so they
-- group apart from 'gemini' in the cost view.
--
-- WHAT.
--   1. n8n rows (model NULL, llm_model set, cost_usd = 0, not yet repriced) whose llm_model is priced
--      below: copy llm_model to model, prompt/completion tokens to input/output tokens, compute
--      cost_usd from provider_prices (engine telemetry/provider_prices.json), set cost_source,
--      unit_prices, source = 'n8n' and provider 'gemini' for 'google'.
--      cost_source is 'estimated' instead of 'computed' when:
--        - prompt_tokens = 0 (n8n did not capture the prompt; only output is priced), or
--        - Sonnet 4 with a prompt over 200k tokens: that needed the retired 1M-context beta, whose
--          long-context rate is no longer published, so it is priced at the standard rate.
--   2. provider 'google' -> 'gemini' on every remaining row (incl. metadata.provider).
--
-- ORIGINAL VALUES ARE KEPT (044's pattern): metadata.repriced_from = the old cost_usd, and
-- metadata.repriced_047 = {provider, model, input_tokens, output_tokens, source, cost_source} as they
-- were. prompt_tokens, completion_tokens, llm_model and estimated_cost are not touched.
-- To undo:  UPDATE ... SET cost_usd = (metadata->>'repriced_from')::numeric, provider =
--           metadata->'repriced_047'->>'provider', ... WHERE metadata ? 'repriced_047'.
--
-- Prices (USD per 1M tokens, https://ai.google.dev/gemini-api/docs/pricing and
-- https://platform.claude.com/docs/en/about-claude/pricing, both checked 2026-11-02):
--   gemini-2.5-pro             $1.25 in / $10 out; prompts over 200k: $2.50 / $15
--   claude-sonnet-4-20250514   $3 in / $15 out
--
-- Data only: no ALTER on any table (token_usage_v2 is not a base table either; see
-- docs/schema-governance.md). Idempotent: re-running changes nothing. DEV first; PROD at release.

BEGIN;

WITH prices(provider, model, inp, outp, lc_threshold, lc_inp, lc_outp, src) AS (
  VALUES
    ('gemini', 'gemini-2.5-pro', 1.25, 10.0, 200000, 2.50, 15.0,
     'https://ai.google.dev/gemini-api/docs/pricing'),
    ('anthropic', 'claude-sonnet-4-20250514', 3.0, 15.0, NULL::int, NULL::numeric, NULL::numeric,
     'https://platform.claude.com/docs/en/about-claude/pricing')
), target AS (
  SELECT t.id,
         p.src,
         p.provider AS new_provider,
         CASE WHEN p.lc_threshold IS NOT NULL AND t.prompt_tokens > p.lc_threshold THEN p.lc_inp ELSE p.inp END AS inp,
         CASE WHEN p.lc_threshold IS NOT NULL AND t.prompt_tokens > p.lc_threshold THEN p.lc_outp ELSE p.outp END AS outp,
         CASE
           WHEN COALESCE(t.prompt_tokens, 0) = 0 THEN 'estimated'
           WHEN p.lc_threshold IS NULL AND t.prompt_tokens > 200000 THEN 'estimated'
           ELSE 'computed'
         END AS new_cost_source,
         CASE
           WHEN COALESCE(t.prompt_tokens, 0) = 0 THEN 'prompt tokens not captured by n8n; output only'
           WHEN p.lc_threshold IS NULL AND t.prompt_tokens > 200000
             THEN 'prompt over 200k; retired 1M-context rate unpublished, standard rate used'
         END AS note
    FROM token_usage_v2 t
    JOIN prices p
      ON p.model = t.llm_model
     AND p.provider = CASE lower(COALESCE(t.provider, '')) WHEN 'google' THEN 'gemini' ELSE lower(COALESCE(t.provider, '')) END
   WHERE t.model IS NULL
     AND COALESCE(t.cost_usd, 0) = 0
     AND COALESCE(t.input_tokens, 0) = 0
     AND COALESCE(t.output_tokens, 0) = 0
     AND NOT (COALESCE(t.metadata, '{}'::jsonb) ? 'repriced_from')
)
UPDATE token_usage_v2 u
   SET metadata = COALESCE(u.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'repriced_from', u.cost_usd,
                       'repriced_047', jsonb_build_object(
                         'provider', u.provider, 'model', u.model,
                         'input_tokens', u.input_tokens, 'output_tokens', u.output_tokens,
                         'source', u.source, 'cost_source', u.cost_source),
                       'provider', target.new_provider)
                  || CASE WHEN target.note IS NULL THEN '{}'::jsonb
                          ELSE jsonb_build_object('cost_note', target.note) END,
       provider = target.new_provider,
       model = u.llm_model,
       input_tokens = COALESCE(u.prompt_tokens, 0),
       output_tokens = COALESCE(u.completion_tokens, 0),
       cost_usd = round((COALESCE(u.prompt_tokens, 0) * target.inp
                         + COALESCE(u.completion_tokens, 0) * target.outp) / 1000000.0, 6),
       cost_source = target.new_cost_source,
       unit_prices = jsonb_build_object(
         'per_mtok', jsonb_build_object('input', target.inp, 'output', target.outp),
         'source', target.src, 'checked', '2026-11-02', 'repriced_by', '047'),
       source = COALESCE(u.source, 'n8n'),
       operation = COALESCE(u.operation, u.workflow_name)
  FROM target
 WHERE u.id = target.id;

-- 2. One name for Gemini. Rows already handled above keep their repriced_047 record.
UPDATE token_usage_v2
   SET metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('provider', 'gemini', 'provider_from', provider),
       provider = 'gemini'
 WHERE lower(provider) IN ('google', 'google-genai', 'google_genai', 'googleai', 'google-ai');

-- Rows whose metadata still names the old provider (provider column already right).
UPDATE token_usage_v2
   SET metadata = metadata || jsonb_build_object('provider', 'gemini', 'provider_from', metadata->>'provider')
 WHERE provider = 'gemini'
   AND lower(metadata->>'provider') IN ('google', 'google-genai', 'google_genai', 'googleai', 'google-ai');

COMMIT;
