/**
 * Item 8 — settings resolve user -> global -> default, and the global table is the one place a
 * system-wide value is kept. An in-memory stand-in for the two tables, enough of PostgREST's builder
 * for the calls app-config.ts makes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'upsert' | 'delete' = 'select';
  let payload: Row | null = null;
  const run = () => {
    const rows = (tables[table] ??= []);
    if (op === 'upsert' && payload) {
      const i = rows.findIndex((r) => r.key === payload!.key);
      const merged = { description: '', is_secret: false, ...(i >= 0 ? rows[i] : {}), ...payload };
      if (i >= 0) rows[i] = merged; else rows.push(merged);
      return [merged];
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === 'delete') tables[table] = rows.filter((r) => !hit.includes(r));
    return hit;
  };
  const b: any = {
    select: () => b,
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
    order: () => b,
    upsert: (p: Row) => { op = 'upsert'; payload = p; return b; },
    delete: () => { op = 'delete'; return b; },
    single: async () => ({ data: run()[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok, bad),
  };
  return b;
}

vi.mock('../services/supabase-admin.js', () => ({ getSupabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));

const cfg = await import('../lib/app-config.js');
const { getCreditCost, clearCreditCostCache } = await import('../services/credit-costs.js');

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.app_config_v2 = [
    { user_id: 'u1', key: 'bcc_email', value: 'mine@x.com' },
    { user_id: 'u2', key: 'tone', value: 'dry' },
  ];
  tables.app_config_global_v2 = [
    { key: 'bcc_email', value: 'ops@x.com', is_secret: false, description: '' },
    { key: 'tone', value: 'warm', is_secret: false, description: '' },
    { key: 'openai_api_key', value: 'sk-abcdef123456', is_secret: true, description: '' },
  ];
  clearCreditCostCache();
});

describe('resolveConfigDetailed', () => {
  it('takes the user value, then the global value, then the default — and says which', async () => {
    const r = await cfg.resolveConfigDetailed(['bcc_email', 'tone', 'missing', 'nothing'], 'u1', { missing: 'd' });
    expect(r).toEqual({
      bcc_email: { value: 'mine@x.com', source: 'user' },
      tone: { value: 'warm', source: 'global' },
      missing: { value: 'd', source: 'default' },
      nothing: { value: null, source: null },
    });
  });

  it('never leaks another user\'s value', async () => {
    expect((await cfg.resolveConfig(['tone'], 'u1')).tone).toBe('warm');
    expect((await cfg.resolveConfig(['tone'], 'u2')).tone).toBe('dry');
  });

  it('with no user, resolves global then default', async () => {
    expect(await cfg.resolveConfig(['bcc_email', 'x'], null, { x: '1' })).toEqual({ bcc_email: 'ops@x.com', x: '1' });
  });
});

describe('global settings CRUD', () => {
  it('upserts, lists with secrets masked, and deletes', async () => {
    await cfg.setGlobalConfig('story_structure_guidelines', 'Three acts.', { description: 'house style', updatedBy: 'admin1' });
    const listed = (await cfg.listGlobalConfig()).map(cfg.forDisplay);
    const key = listed.find((r) => r.key === 'openai_api_key')!;
    expect(key.value).toBe('••••3456');
    expect(key.masked).toBe(true);
    expect(listed.find((r) => r.key === 'story_structure_guidelines')!.value).toBe('Three acts.');
    expect(await cfg.deleteGlobalConfig('story_structure_guidelines')).toBe(true);
    expect(await cfg.getGlobalConfig('story_structure_guidelines')).toBeNull();
  });

  it('refuses a key that is not a plain identifier', async () => {
    await expect(cfg.setGlobalConfig('bad key!', 'x')).rejects.toThrow('Invalid setting key');
  });
});

describe('the superuser config is global', () => {
  it('credit costs come from the global sprint8_superuser_config row', async () => {
    expect(await getCreditCost('write_chapter')).toBe(5);
    await cfg.setGlobalConfig('sprint8_superuser_config', JSON.stringify({ credit_costs: { write_chapter: 7 } }));
    clearCreditCostCache();
    expect(await getCreditCost('write_chapter')).toBe(7);
    expect(await getCreditCost('research')).toBe(2); // unchanged keys keep their default
  });
});
