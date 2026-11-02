/**
 * Exact cost recording on the server (migration 043).
 *
 * Asserted: prices come from the shared table (Haiku 4.5 at $1/$5, Opus 5.5 cache reads at 0.05x,
 * 1-hour cache writes at 2x); an unknown model is recorded at $0 and flagged 'unpriced', never priced
 * as something else; KIE credits use the provider's own count when it gives one; a provider request
 * is never recorded twice; a provisional KIE row is settled exactly once; a Claude call that is
 * refused is still recorded (it was billed); the breakdown routes validate their input and aggregate
 * in the database; and the server's price table is byte-identical to the engine's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { z } from 'zod';

type Row = Record<string, unknown>;
const db: { token_usage_v2: Row[] } = { token_usage_v2: [] };
const rpcCalls: Array<{ fn: string; args: Row }> = [];
let insertError: { code?: string; message: string } | null = null;

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'u1'; next(); },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/supabase-admin.js', () => {
  const build = (table: 'token_usage_v2') => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => db[table].filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      update: (p: Row) => ((patch = p), q),
      insert: (r: Row) => {
        if (insertError) return Promise.resolve({ error: insertError });
        db[table].push({ id: `row${db[table].length + 1}`, ...r });
        return Promise.resolve({ error: null });
      },
      then: (resolve: (v: unknown) => void) => {
        if (patch) { const hit = rows(); for (const r of hit) Object.assign(r, patch); resolve({ data: hit, error: null }); return; }
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  return {
    getSupabaseAdmin: () => ({
      from: (t: 'token_usage_v2') => build(t),
      rpc: (fn: string, args: Row) => {
        rpcCalls.push({ fn, args });
        const data = args.p_group === 'total'
          ? [{ calls: 3, cost_usd: 1.25 }]
          : [{ operation: 'chapter.write', calls: 3, cost_usd: 1.25, avg_cost_per_call: 0.416667 }];
        return Promise.resolve({ data, error: null });
      },
    }),
  };
});

const parse = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { parse: (...a: unknown[]) => parse(...a) }; } }));
vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({ zodOutputFormat: () => ({ type: 'json_schema' }) }));

import {
  anthropicTokens,
  buildUsageRow,
  computeKieCost,
  computeTokenCost,
  findPrice,
  recordUsage,
  settleUsage,
} from '../lib/cost-recorder.js';
import { parseBreakdownQuery, USER_GROUPS, ADMIN_GROUPS } from '../routes/costs.js';

beforeEach(() => {
  db.token_usage_v2 = [];
  rpcCalls.length = 0;
  insertError = null;
  parse.mockReset();
});

describe('price table', () => {
  it('is byte-identical to the engine copy', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const engine = readFileSync(
      path.resolve(here, '../../../engine/packages/writer_engine/src/writer_engine/telemetry/provider_prices.json'),
      'utf8',
    );
    const ts = readFileSync(path.resolve(here, '../lib/provider-prices.ts'), 'utf8');
    const begin = ts.indexOf('\n', ts.indexOf('// BEGIN PROVIDER_PRICES')) + 1;
    const end = ts.indexOf('// END PROVIDER_PRICES');
    expect(ts.slice(begin, end)).toBe(engine.endsWith('\n') ? engine : `${engine}\n`);
  });

  it('prices every model the server calls', () => {
    expect(findPrice('anthropic', 'claude-opus-5-5')).toBeDefined();
    expect(findPrice('anthropic', 'claude-haiku-4-5-20251001')).toBeDefined();
    expect(findPrice('kieai', 'google/nano-banana')).toBeDefined();
  });
});

describe('token pricing', () => {
  it('Haiku 4.5 is $1 in / $5 out (alias resolves)', () => {
    const r = computeTokenCost('anthropic', 'claude-haiku-4-5-20251001', { input: 1_000_000, output: 1_000_000 });
    expect(r.costUsd).toBe(6);
    expect(r.costSource).toBe('computed');
  });

  it('Opus 5.5: $4/$20, cache read $0.20 (0.05x), 5m write $5, 1h write $8', () => {
    const r = computeTokenCost('anthropic', 'claude-opus-5-5', {
      input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000,
    });
    expect(r.costUsd).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6);
  });

  it('Sonnet 4.6 1-hour cache writes cost 2x input', () => {
    expect(computeTokenCost('anthropic', 'claude-sonnet-4-6', { input: 0, output: 0, cacheWrite1h: 1_000_000 }).costUsd).toBe(6);
  });

  it('an unknown model is $0 and flagged unpriced', () => {
    const r = computeTokenCost('anthropic', 'claude-imaginary-9', { input: 1000, output: 1000 });
    expect(r).toEqual({ costUsd: 0, costSource: 'unpriced', unitPrices: null });
  });

  it('splits cache writes by TTL when Anthropic reports it', () => {
    expect(anthropicTokens({
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    })).toEqual({ input: 10, output: 5, cacheRead: 7, cacheWrite5m: 10, cacheWrite1h: 20 });
    expect(anthropicTokens({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 9 }))
      .toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite5m: 9, cacheWrite1h: 0 });
  });
});

describe('KIE credits', () => {
  it('uses creditsConsumed when KIE reports it', () => {
    const r = computeKieCost('google/nano-banana', 6);
    expect(r).toMatchObject({ costUsd: 0.03, costSource: 'computed', units: 6, unitType: 'credits' });
  });
  it('falls back to the listed credits per image, marked estimated', () => {
    const r = computeKieCost('google/nano-banana', null, 1);
    expect(r).toMatchObject({ costUsd: 0.02, costSource: 'estimated', units: 4 });
  });
});

describe('recordUsage', () => {
  it('writes one fully-labelled row', async () => {
    await recordUsage({
      operation: 'characters.check', provider: 'anthropic', model: 'claude-opus-5-5', userId: 'u1',
      projectId: 'p1', contentId: 'c1', chapterNumber: 4, requestId: 'msg_1',
      tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
    expect(db.token_usage_v2).toHaveLength(1);
    expect(db.token_usage_v2[0]).toMatchObject({
      user_id: 'u1', operation: 'characters.check', workflow_name: 'characters.check', provider: 'anthropic',
      model: 'claude-opus-5-5', project_id: 'p1', content_id: 'c1', chapter_number: 4, request_id: 'msg_1',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 100, total_tokens: 1600, source: 'server',
      cost_source: 'computed', cost_usd: 0.01402,
    });
    expect((db.token_usage_v2[0].unit_prices as Row).source).toContain('claude.com');
  });

  it('never records the same provider request twice', async () => {
    const r = { operation: 'x', provider: 'anthropic', model: 'claude-opus-5-5', requestId: 'msg_dup', tokens: { input: 1, output: 1 } };
    await recordUsage(r);
    await recordUsage(r);
    expect(db.token_usage_v2).toHaveLength(1);
  });

  it('swallows a racing duplicate and any write failure', async () => {
    insertError = { code: '23505', message: 'duplicate key' };
    await expect(recordUsage({ operation: 'x', provider: 'kieai', model: 'google/nano-banana', requestId: 't1' })).resolves.toBeUndefined();
    insertError = { message: 'db down' };
    await expect(recordUsage({ operation: 'x', provider: 'anthropic', model: 'claude-opus-5-5' })).resolves.toBeUndefined();
  });

  it('builds a $0 unpriced row for an unknown model instead of guessing', () => {
    expect(buildUsageRow({ operation: 'x', provider: 'anthropic', model: 'mystery', tokens: { input: 5, output: 5 } }))
      .toMatchObject({ cost_usd: 0, cost_source: 'unpriced' });
  });
});

describe('settleUsage (KIE provisional row)', () => {
  it('replaces the estimate with the reported credits, once', async () => {
    const est = computeKieCost('google/nano-banana', null, 1);
    await recordUsage({ operation: 'images.generate', provider: 'kieai', model: 'google/nano-banana', userId: 'u1', projectId: 'p9', requestId: 'task1', units: est.units, unitType: est.unitType, cost: est });
    const fin = computeKieCost('google/nano-banana', 5);
    await settleUsage('kieai', 'task1', { operation: 'images.generate', provider: 'kieai', model: 'google/nano-banana', requestId: 'task1', units: fin.units, unitType: fin.unitType, cost: fin });
    expect(db.token_usage_v2).toHaveLength(1);
    expect(db.token_usage_v2[0]).toMatchObject({ cost_usd: 0.025, cost_source: 'computed', units: 5, project_id: 'p9' });
    const again = computeKieCost('google/nano-banana', 99);
    await settleUsage('kieai', 'task1', { operation: 'images.generate', provider: 'kieai', model: 'google/nano-banana', requestId: 'task1', cost: again, units: again.units });
    expect(db.token_usage_v2[0].cost_usd).toBe(0.025);
  });

  it('inserts the final row when there was no provisional one', async () => {
    const fin = computeKieCost('google/nano-banana', 4);
    await settleUsage('kieai', 'old-task', { operation: 'images.generate', provider: 'kieai', model: 'google/nano-banana', requestId: 'old-task', cost: fin, units: fin.units });
    expect(db.token_usage_v2).toHaveLength(1);
    expect((db.token_usage_v2[0].metadata as Row).settled).toBe(true);
  });
});

describe('parseWith', () => {
  it('records the call even when the model refuses (it was billed)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    parse.mockResolvedValue({
      id: 'msg_refused', model: 'claude-opus-5-5', stop_reason: 'refusal', parsed_output: null,
      usage: { input_tokens: 2000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const { parseWith } = await import('../lib/claude-structured.js');
    await expect(parseWith(z.object({ a: z.string() }), 'prompt', { operation: 'landing-page.facts', userId: 'u1', projectId: 'p1' }))
      .rejects.toThrow(/declined/);
    expect(db.token_usage_v2).toHaveLength(1);
    expect(db.token_usage_v2[0]).toMatchObject({
      operation: 'landing-page.facts', request_id: 'msg_refused', input_tokens: 2000, output_tokens: 10, project_id: 'p1', cost_usd: 0.0082,
    });
  });
});

describe('breakdown routes', () => {
  it('validates group and dates', () => {
    expect(parseBreakdownQuery({ group: 'user' }, USER_GROUPS)).toHaveProperty('error');
    expect(parseBreakdownQuery({ group: 'user' }, ADMIN_GROUPS)).toHaveProperty('params');
    expect(parseBreakdownQuery({ from: 'not-a-date' }, USER_GROUPS)).toHaveProperty('error');
    expect(parseBreakdownQuery({ from: '2026-11-02', to: '2026-11-01' }, USER_GROUPS)).toHaveProperty('error');
    const ok = parseBreakdownQuery({}, USER_GROUPS, new Date('2026-11-02T00:00:00Z'));
    expect(ok).toEqual({ params: expect.objectContaining({ p_group: 'operation', p_from: '2026-10-03T00:00:00.000Z', p_to: '2026-11-02T00:00:00.000Z' }) });
  });

  async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const { costsRouter, adminCostsRouter } = await import('../routes/costs.js');
    const app = express();
    app.use('/api/costs', costsRouter);
    app.use('/api/admin/costs', adminCostsRouter);
    const server = app.listen(0);
    try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
  }

  it('scopes the user endpoint to the caller and aggregates in the database', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/costs/breakdown?group=operation&project_id=p1&user_id=someone-else`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await r.json();
      expect(r.status).toBe(200);
      expect(j.data.totals.cost_usd).toBe(1.25);
      expect(j.data.rows[0].operation).toBe('chapter.write');
      expect(rpcCalls).toHaveLength(2);
      expect(rpcCalls[0]).toEqual({ fn: 'token_usage_breakdown', args: expect.objectContaining({ p_user_id: 'u1', p_project_id: 'p1', p_group: 'operation' }) });
      expect(rpcCalls[1].args.p_group).toBe('total');
    });
  });

  it('lets the admin endpoint filter by any user and group by user', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/admin/costs/breakdown?group=user&user_id=u7`);
      expect(r.status).toBe(200);
      expect(rpcCalls[0].args).toMatchObject({ p_group: 'user', p_user_id: 'u7' });
      const bad = await fetch(`${base}/api/costs/breakdown?group=user`);
      expect(bad.status).toBe(400);
    });
  });
});
