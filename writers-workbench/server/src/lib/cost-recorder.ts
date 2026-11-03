/**
 * Exact cost recording for every paid provider call the server makes.
 *
 * One row per call in token_usage_v2, with the same columns and labels the engine writes
 * (migration 044): operation, provider, model, user/project/content ids, token and unit counts, the
 * unit prices used, cost_usd and where the cost came from (cost_source):
 *
 *   provider_reported  the provider returned the dollar figure itself
 *   computed           provider-reported usage (tokens, credits, words) x a published price
 *   estimated          a fallback price, or a unit count the provider did not report
 *   unpriced           the model is not in the price table — recorded at $0 and FLAGGED, never
 *                      silently priced as something else
 *
 * Best-effort: recording never throws into the caller. A failed write is logged.
 */
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from './logger.js';
import { PROVIDER_PRICES, type PriceEntry } from './provider-prices.js';

export type CostSource = 'provider_reported' | 'computed' | 'estimated' | 'unpriced';

/**
 * Other names a provider has been recorded under. n8n's "Hub V2" and the engine before 2026-05 wrote
 * Gemini calls as provider "google"; left as-is they group as a separate provider in the cost view and
 * miss the price table. Same map as the engine's pricing.PROVIDER_ALIASES.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  google: 'gemini',
  'google-genai': 'gemini',
  google_genai: 'gemini',
  googleai: 'gemini',
  'google-ai': 'gemini',
  claude: 'anthropic',
};

/** The canonical provider name: lower-case, aliases ("google") mapped to "gemini" etc. */
export function normalizeProvider(provider: string | null | undefined): string {
  const key = (provider ?? '').trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? key;
}

export function findPrice(provider: string, model: string): PriceEntry | undefined {
  const p = normalizeProvider(provider);
  const m = model.trim();
  return PROVIDER_PRICES.entries.find(
    (e) => e.provider === p && (e.model === m || e.aliases.includes(m)),
  );
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface CostResult {
  costUsd: number;
  costSource: CostSource;
  unitPrices: Record<string, unknown> | null;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Token cost from the price table. Anthropic's input_tokens already exclude cache reads/writes. */
export function computeTokenCost(provider: string, model: string, t: TokenCounts): CostResult {
  const entry = findPrice(provider, model);
  if (!entry || !entry.per_mtok) {
    return { costUsd: 0, costSource: 'unpriced', unitPrices: null };
  }
  let rates = entry.per_mtok;
  const promptTokens = t.input + (t.cacheRead ?? 0) + (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0);
  if (entry.long_context && promptTokens > entry.long_context.threshold_tokens) {
    rates = { ...rates, ...entry.long_context.per_mtok };
  }
  const cost =
    (t.input * rates.input +
      t.output * rates.output +
      (t.cacheRead ?? 0) * (rates.cache_read ?? rates.input) +
      (t.cacheWrite5m ?? 0) * (rates.cache_write_5m ?? rates.input) +
      (t.cacheWrite1h ?? 0) * (rates.cache_write_1h ?? rates.input)) /
    1_000_000;
  return {
    costUsd: round6(cost),
    costSource: (entry.fallback_cost_source as CostSource | undefined) ?? 'computed',
    unitPrices: { per_mtok: rates, source: entry.source, checked: entry.checked },
  };
}

/** Anthropic SDK usage object → token counts (cache writes split by TTL when the API reports it). */
export function anthropicTokens(usage: unknown): TokenCounts {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const creation = (u.cache_creation ?? null) as Record<string, unknown> | null;
  const w5 = creation ? num(creation.ephemeral_5m_input_tokens) : 0;
  const w1 = creation ? num(creation.ephemeral_1h_input_tokens) : 0;
  const total = num(u.cache_creation_input_tokens);
  const split = w5 + w1 > 0;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: split ? w5 : total,
    cacheWrite1h: split ? w1 : 0,
  };
}

/**
 * KIE.AI image cost. ``creditsConsumed`` from the task record is the provider's own count; without it
 * the model's listed credits per image are used and the row is marked estimated.
 */
export function computeKieCost(
  model: string,
  creditsConsumed: number | null | undefined,
  images = 1,
): CostResult & { units: number; unitType: string } {
  const entry = findPrice('kieai', model);
  const reported = typeof creditsConsumed === 'number' && Number.isFinite(creditsConsumed) && creditsConsumed >= 0;
  if (!entry || entry.per_credit === undefined) {
    return {
      costUsd: 0,
      costSource: 'unpriced',
      unitPrices: null,
      units: reported ? creditsConsumed! : images,
      unitType: reported ? 'credits' : 'images',
    };
  }
  const credits = reported ? creditsConsumed! : (entry.credits_per_unit ?? 0) * images;
  return {
    costUsd: round6(credits * entry.per_credit),
    costSource: reported ? 'computed' : 'estimated',
    unitPrices: {
      per_credit: entry.per_credit,
      credits_per_unit: entry.credits_per_unit,
      source: entry.source,
      checked: entry.checked,
    },
    units: credits,
    unitType: 'credits',
  };
}

export interface UsageRecord {
  operation: string;
  provider: string;
  model: string;
  userId?: string | null;
  projectId?: string | null;
  contentId?: string | null;
  chapterNumber?: number | null;
  runId?: string | null;
  requestId?: string | null;
  tokens?: TokenCounts;
  units?: number | null;
  unitType?: string | null;
  /** Pre-computed cost (e.g. KIE credits, a provider-reported figure). Overrides token pricing. */
  cost?: CostResult;
  metadata?: Record<string, unknown>;
}

/** The token_usage_v2 row for one call. Exported for tests. */
export function buildUsageRow(input: UsageRecord): Record<string, unknown> {
  // The types require both, but an empty string or a value from untyped JSON still gets through. A
  // row that cannot be grouped or priced is written (dropping it would lose billing data) but never
  // silently: defaulted, tagged label_defaulted, logged at error. Mirrors the engine's
  // persist_helpers.label_token_rows.
  const missing: string[] = [];
  let r = input;
  if (!String(r.provider ?? '').trim()) {
    missing.push('provider');
    r = { ...r, provider: 'unknown' };
  }
  if (!String(r.operation ?? '').trim()) {
    missing.push('operation');
    r = { ...r, operation: `unattributed.${r.provider}` };
  }
  if (missing.length) {
    logger.error({ missing, provider: r.provider, operation: r.operation, model: r.model }, 'cost.unlabelled_row');
    r = { ...r, metadata: { ...(r.metadata ?? {}), label_defaulted: missing } };
  }
  const provider = normalizeProvider(r.provider);
  const t = r.tokens ?? { input: 0, output: 0 };
  const cost = r.cost ?? computeTokenCost(r.provider, r.model, t);
  const cacheRead = t.cacheRead ?? 0;
  const w5 = t.cacheWrite5m ?? 0;
  const w1 = t.cacheWrite1h ?? 0;
  return {
    user_id: r.userId ?? null,
    workflow_name: r.operation,
    operation: r.operation,
    provider,
    model: r.model,
    input_tokens: t.input,
    output_tokens: t.output,
    total_tokens: t.input + t.output + cacheRead + w5 + w1,
    cache_read_tokens: cacheRead,
    cache_write_tokens: w5,
    cache_write_1h_tokens: w1,
    units: r.units ?? null,
    unit_type: r.unitType ?? null,
    unit_prices: cost.unitPrices,
    cost_usd: round6(cost.costUsd),
    cost_source: cost.costSource,
    source: 'server',
    project_id: r.projectId ?? null,
    content_id: r.contentId ?? null,
    chapter_number: r.chapterNumber ?? null,
    run_id: r.runId ?? null,
    request_id: r.requestId ?? null,
    metadata: { ...(r.metadata ?? {}), provider, project_id: r.projectId ?? null },
  };
}

/**
 * Replace a provisional row (recorded at an estimate when an async provider task was created) with
 * the final figure once the task finishes. Settles once: a second call for the same request is a
 * no-op, so a status endpoint polled repeatedly after success cannot rewrite or double-count it.
 * With no provisional row (a task created before this code shipped), the final row is inserted.
 * Never throws.
 */
export async function settleUsage(provider: string, requestId: string, r: UsageRecord): Promise<void> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('token_usage_v2')
      .select('id, metadata, user_id, project_id')
      .eq('provider', normalizeProvider(provider))
      .eq('request_id', requestId)
      .limit(1);
    if (error) {
      logger.warn({ error: error.message, operation: r.operation }, 'cost.settle_lookup_failed');
      return;
    }
    const existing = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    if (!existing) {
      await recordUsage({ ...r, metadata: { ...(r.metadata ?? {}), settled: true } });
      return;
    }
    const oldMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    if (oldMeta.settled === true) return;
    const row = buildUsageRow({
      ...r,
      userId: (existing.user_id as string | null) ?? r.userId,
      projectId: (existing.project_id as string | null) ?? r.projectId,
    });
    const { error: upErr } = await getSupabaseAdmin()
      .from('token_usage_v2')
      .update({
        units: row.units,
        unit_type: row.unit_type,
        unit_prices: row.unit_prices,
        cost_usd: row.cost_usd,
        cost_source: row.cost_source,
        metadata: { ...oldMeta, ...(r.metadata ?? {}), settled: true },
      })
      .eq('id', existing.id as string);
    if (upErr) logger.warn({ error: upErr.message, operation: r.operation }, 'cost.settle_failed');
  } catch (err) {
    logger.warn({ err, operation: r.operation }, 'cost.settle_failed');
  }
}

/**
 * Write one cost row. Never throws. With a request_id the write is idempotent: a second record of
 * the same provider request (a KIE task polled twice after success) is ignored, so it cannot be
 * double-counted.
 */
export async function recordUsage(r: UsageRecord): Promise<void> {
  let row: Record<string, unknown>;
  try {
    row = buildUsageRow(r);
  } catch (err) {
    logger.warn({ err, operation: r.operation }, 'cost.record_build_failed');
    return;
  }
  if (row.cost_source === 'unpriced') {
    logger.warn({ provider: r.provider, model: r.model, operation: r.operation }, 'cost.unpriced_model');
  }
  try {
    const table = getSupabaseAdmin().from('token_usage_v2');
    if (row.request_id) {
      // The unique index is partial (WHERE request_id IS NOT NULL), which ON CONFLICT cannot always
      // infer through PostgREST — so check first, then insert; a racing duplicate then fails on the
      // index (23505) and is treated as already recorded.
      const { data: existing, error: selErr } = await table
        .select('id')
        .eq('provider', row.provider as string)
        .eq('request_id', row.request_id as string)
        .limit(1);
      if (!selErr && Array.isArray(existing) && existing.length > 0) return;
      const { error } = await getSupabaseAdmin().from('token_usage_v2').insert(row);
      if (error && (error as { code?: string }).code !== '23505') {
        logger.warn({ error: error.message, operation: r.operation }, 'cost.record_failed');
      }
      return;
    }
    const { error } = await table.insert(row);
    if (error) logger.warn({ error: error.message, operation: r.operation }, 'cost.record_failed');
  } catch (err) {
    logger.warn({ err, operation: r.operation }, 'cost.record_failed');
  }
}
