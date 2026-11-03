/**
 * The copy assistant (lib/copy-assist.ts, routes/copy-assist.ts) and the per-book copy it can fill
 * (book_copy_v2: subtitle, inside flap, Also by) reaching the exports.
 *
 * Every assertion fails on the code before this change: there was no assistant on these fields, no
 * promo_copy price, no subtitle / inside flap / Also-by anywhere, and the KDP listing and the title
 * page printed none of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

import {
  claimProblems,
  isVerbatim,
  lengthProblems,
  limitOf,
  renderBook,
  runAssist,
  unknownNames,
  type BookFacts,
  type Caller,
} from '../lib/copy-assist.js';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; rows: unknown }> = [];
let auth: Row = {};

vi.mock('../middleware/auth.js', () => {
  const requireAuth = (req: Row, _res: unknown, next: () => void) => {
    Object.assign(req, { userId: 'u1', effectiveRole: 'user', subscriptionTier: { name: 'trial' }, creditsRemaining: 100 }, auth);
    next();
  };
  return { requireAuth, requireSuperuser: (_q: unknown, _s: unknown, n: () => void) => n(), requireAdmin: (_q: unknown, _s: unknown, n: () => void) => n() };
});
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../lib/app-config.js', () => ({ getGlobalJson: async () => null, setGlobalConfig: async () => ({}) }));

const deducted: Array<{ amount: number; description: string }> = [];
let balance = 100;
vi.mock('../services/credits.js', () => ({
  deductCredits: async (_u: string, amount: number, description: string) => {
    if (balance < amount) return { ok: false, reason: 'INSUFFICIENT_CREDITS', message: 'no', balance_after: balance };
    balance -= amount;
    deducted.push({ amount, description });
    return { ok: true, balance_after: balance, transaction_id: `tx${deducted.length}` };
  },
}));

vi.mock('../services/supabase-admin.js', () => {
  const build = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let head = false;
    const rows = () => (db[table] ?? []).filter((r) => f.every((x) => x(r)));
    const q: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), q),
      order: () => q, limit: () => q, range: () => q,
      eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (f.push((r) => r[c] !== v), q),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), q),
      in: (c: string, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
      like: (c: string, v: string) => (f.push((r) => String(r[c] ?? '').startsWith(v.replace(/%$/, ''))), q),
      update: (v: unknown) => (writes.push({ table, op: 'update', rows: v }), q),
      insert: (v: unknown) => (writes.push({ table, op: 'insert', rows: v }), Promise.resolve({ error: null })),
      upsert: (v: Row[]) => {
        writes.push({ table, op: 'upsert', rows: v });
        for (const r of v) {
          db[table] = (db[table] ?? []).filter((x) => !(x.project_id === r.project_id && x.volume_index === r.volume_index && x.field === r.field));
          db[table].push(r);
        }
        return Promise.resolve({ error: null });
      },
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => void) => ok(head ? { count: rows().length, error: null } : { data: rows(), error: null }),
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from: (t: string) => build(t), storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) } }) };
});

// ------------------------------------------------------------------------------------------------
// The lib
// ------------------------------------------------------------------------------------------------

const facts = (over: Partial<BookFacts> = {}): BookFacts => ({
  title: 'The Clockwork Rebellion',
  genre: 'political-scifi',
  premise: 'In 1888 London, Cogwheel, a clockwork automaton, awakens.',
  themes: ['freedom versus control'],
  chapters: [
    { number: 0, title: 'The Demonstration', beat: 'Sir Reginald Blackwood unveils Cogwheel.' },
    { number: 1, title: 'The Factory District', beat: 'Cogwheel meets Mary Kellerton.' },
    { number: 2, title: 'The Uprising', beat: 'The workers strike and Blackwood falls.' },
  ],
  bible: [{ type: 'character', name: 'Mary Kellerton', description: 'a match girl' }],
  excerpts: [{ chapter: 0, text: 'The gears turned, and for the first time Cogwheel wondered why it should obey.' }],
  saved: {},
  series: null,
  author: { pen_name: 'R. T. Testwell', pronouns: '', lives: '', background: 'Restored Victorian clocks.', credentials: [], prior_work: [], why_this_book: '', personal: '', links: [] },
  research: [],
  ...over,
});

const reply = (value: string, items: string[] = [], attribution = '') => ({ value, items, attribution });

describe('the honesty and length checks', () => {
  it('flags reviews, awards, bestseller claims, ratings and sales figures', () => {
    expect(claimProblems('The bestselling saga continues.')).toEqual([expect.stringContaining('bestseller')]);
    expect(claimProblems('An award-winning debut.')[0]).toContain('award');
    expect(claimProblems('"A triumph of imagination" — Publishers Weekly')[0]).toContain('attributed quote');
    expect(claimProblems('Rated five stars by readers')[0]).toContain('rating');
    expect(claimProblems('Over 10,000 copies sold')[0]).toContain('sales');
    expect(claimProblems('Cogwheel wakes in a gaslit drawing room.')).toEqual([]);
  });

  it('lets a bio repeat a claim the author profile itself makes', () => {
    expect(claimProblems('Winner of the Nebula Award.', 'Credentials: Winner of the Nebula Award')).toEqual([]);
  });

  it('measures KDP limits: 4,000-character description, 7 keywords of 50 characters', () => {
    expect(lengthProblems('blurb', reply('x'.repeat(4001)), 4000)).toEqual(['4,001 characters; the limit is 4,000']);
    const eight = Array.from({ length: 8 }, (_, i) => `keyword ${i}`);
    expect(lengthProblems('keywords', reply('', eight), 50)).toEqual(['8 items; the limit is 7']);
    expect(lengthProblems('keywords', reply('', ['y'.repeat(51)]), 50)[0]).toContain('51 characters; each may be at most 50');
  });

  it('shares the 200 characters between the title and the subtitle', () => {
    expect(limitOf('subtitle', 'x'.repeat(150))).toBe(49);
    expect(limitOf('blurb', 'anything')).toBe(4000);
  });

  it('accepts an epigraph only if it is copied from the manuscript', () => {
    const src = ['The gears turned, and for the first time Cogwheel wondered why it should obey.'];
    expect(isVerbatim('“for the first time Cogwheel wondered why it should obey.”', src)).toBe(true);
    expect(isVerbatim('Every machine dreams of freedom.', src)).toBe(false);
  });

  it('reports names that are nowhere in the book, but not placeholders or known names', () => {
    const material = renderBook(facts());
    expect(unknownNames('Mary Kellerton fights back, helped by Inspector Halvorsen.', material)).toEqual(['Halvorsen']);
    expect(unknownNames('For [Name Here], with love from Cogwheel.', material)).toEqual([]);
  });

  it('marks the last third of the chapter plan as not to be revealed, and lists only the profile facts', () => {
    const text = renderBook(facts());
    expect(text).toContain('LATE Ch 2 "The Uprising"');
    expect(text).not.toContain('LATE Ch 0');
    expect(text).toContain('Background: Restored Victorian clocks.');
    expect(text).not.toContain('Lives:');
  });
});

describe('runAssist', () => {
  it('sends the book as the cached prefix and keeps a clean draft to one call', async () => {
    const call = vi.fn<Caller>().mockResolvedValue(reply('Cogwheel wakes. Mary Kellerton needs it.'));
    const r = await runAssist({ field: 'blurb', mode: 'draft' }, facts(), { userId: 'u1' }, call);
    expect(call).toHaveBeenCalledTimes(1);
    const [prompt, ctx, prefix] = call.mock.calls[0];
    expect(prefix).toContain('Title: The Clockwork Rebellion');
    expect(prompt).toContain('Never invent reviews');
    expect(prompt).toContain('at most 4000 characters');
    expect(ctx.operation).toBe('copy-assist.blurb');
    expect(r).toMatchObject({ value: 'Cogwheel wakes. Mary Kellerton needs it.', over_limit: false, warnings: [], calls: 1, limit: 4000 });
  });

  it('corrects an over-long draft with a claim in it once, naming both problems', async () => {
    const call = vi
      .fn<Caller>()
      .mockResolvedValueOnce(reply(`The bestselling tale of Cogwheel. ${'x'.repeat(990)}`))
      .mockResolvedValueOnce(reply('Cogwheel wakes in a drawing room.'));
    const r = await runAssist({ field: 'back_cover', mode: 'draft' }, facts(), { userId: 'u1' }, call);
    expect(call).toHaveBeenCalledTimes(2);
    const fix = call.mock.calls[1][0];
    expect(fix).toContain('the limit is 1,000');
    expect(fix).toContain('bestseller claim');
    expect(call.mock.calls[1][1].operation).toBe('copy-assist.back_cover.correct');
    expect(r).toMatchObject({ value: 'Cogwheel wakes in a drawing room.', over_limit: false, calls: 2 });
  });

  it('reports what survives the correction instead of hiding it', async () => {
    const bad = reply(`Award-winning. ${'x'.repeat(4100)}`);
    const call = vi.fn<Caller>().mockResolvedValue(bad);
    const r = await runAssist({ field: 'blurb', mode: 'draft' }, facts(), { userId: 'u1' }, call);
    expect(r.over_limit).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/award claim/);
    expect(r.warnings.join(' ')).toMatch(/the limit is 4,000/);
  });

  it('a revision carries the current text and the author\'s instruction', async () => {
    const call = vi.fn<Caller>().mockResolvedValue(reply('Shorter.'));
    await runAssist({ field: 'hook', mode: 'revise', current: 'A long hook about Cogwheel.', instruction: 'shorter, more suspense' }, facts(), { userId: 'u1' }, call);
    const prompt = call.mock.calls[0][0];
    expect(prompt).toContain('<current>\nA long hook about Cogwheel.\n</current>');
    expect(prompt).toContain('"shorter, more suspense"');
    expect(call.mock.calls[0][1].operation).toBe('copy-assist.hook.revise');
  });

  it('a bio with no pronouns in the profile may not guess one', async () => {
    const call = vi
      .fn<Caller>()
      .mockResolvedValueOnce(reply('R. T. Testwell restored clocks. He lives in [city].'))
      .mockResolvedValueOnce(reply('R. T. Testwell restored clocks and lives in [city].'));
    const r = await runAssist({ field: 'author_bio', mode: 'draft' }, facts(), { userId: 'u1' }, call);
    expect(call.mock.calls[1][0]).toContain('profile gives no pronouns');
    expect(r.value).not.toMatch(/\bhe\b/i);
    expect(r.warnings).toContain('has [placeholders] for you to fill in before saving');
  });

  it('an epigraph not found in the manuscript gets one correction, and a warning if it persists', async () => {
    const call = vi.fn<Caller>().mockResolvedValue(reply('Every machine dreams of freedom.', [], 'Cogwheel'));
    const r = await runAssist({ field: 'epigraph', mode: 'draft' }, facts(), { userId: 'u1' }, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.warnings.join(' ')).toContain('not copied word for word');
    expect(r.attribution).toBe('Cogwheel');
  });

  it('a list comes back as one item per line, numbering stripped', async () => {
    const call = vi.fn<Caller>().mockResolvedValue(reply('', ['1. steampunk', '2) victorian london', '- automaton']));
    const r = await runAssist({ field: 'keywords', mode: 'draft' }, facts(), { userId: 'u1' }, call);
    expect(r.items).toEqual(['steampunk', 'victorian london', 'automaton']);
    expect(r.value).toBe('steampunk\nvictorian london\nautomaton');
    expect(r.limit).toBe(50);
  });
});

// ------------------------------------------------------------------------------------------------
// The routes
// ------------------------------------------------------------------------------------------------

const modelCalls = vi.fn<Caller>();

async function server<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { copyAssistRouter, setAssistCaller } = await import('../routes/copy-assist.js');
  setAssistCaller((...a) => modelCalls(...a));
  const app = express();
  app.use(express.json());
  app.use('/api/copy-assist', copyAssistRouter);
  const s = app.listen(0);
  try {
    return await fn(`http://localhost:${(s.address() as AddressInfo).port}`);
  } finally {
    s.close();
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; headers: Headers }> {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
}

beforeEach(async () => {
  for (const k of Object.keys(db)) delete db[k];
  db.writing_projects_v2 = [
    { id: 'p1', user_id: 'u1', title: 'The Clockwork Rebellion', genre_slug: 'political-scifi', deleted_at: null, outline: { premise: 'Cogwheel awakens.', chapters: [{ chapter_number: 0, title: 'The Demonstration', beat: 'Blackwood unveils Cogwheel.' }] } },
    { id: 'p2', user_id: 'u1', title: 'The Signal Beneath', deleted_at: null, outline: {} },
    { id: 'p3', user_id: 'u1', title: 'The Burial Mound (CR-001) (2026-10-26 19:10)', deleted_at: null, outline: {} },
    { id: 'p4', user_id: 'u1', title: 'Empty Idea', deleted_at: null, outline: {} },
  ];
  db.published_content_v2 = [
    { id: 'c1', user_id: 'u1', project_id: 'p1', content_type: 'chapter', chapter_number: 0, content_text: 'The gears turned.', deleted_at: null },
    { id: 'c2', user_id: 'u1', project_id: 'p2', content_type: 'chapter', chapter_number: 1, content_text: 'Static.', deleted_at: null },
    { id: 'c3', user_id: 'u1', project_id: 'p3', content_type: 'chapter', chapter_number: 1, content_text: 'Mound.', deleted_at: null },
  ];
  db.story_bible_v2 = [];
  db.author_profiles_v2 = [{ user_id: 'u1', pen_name: 'R. T. Testwell' }];
  db.book_copy_v2 = [];
  writes.length = 0;
  deducted.length = 0;
  balance = 100;
  auth = {};
  modelCalls.mockReset().mockResolvedValue(reply('Cogwheel wakes in a gaslit room.'));
  const { clearCreditCostCache } = await import('../services/credit-costs.js');
  clearCreditCostCache();
});

describe('POST /assist', () => {
  it('drafts one field, charges promo_copy (3 credits) once, and saves nothing', async () => {
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'blurb' });
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ field: 'blurb', value: 'Cogwheel wakes in a gaslit room.', limit: 4000, credits_charged: 3, credits_remaining: 97 });
      expect(deducted).toEqual([{ amount: 3, description: 'copy-assist.draft:promo_copy blurb' }]);
      expect(r.headers.get('X-Credits-Remaining')).toBe('97');
      expect(writes).toEqual([]);
    });
  });

  it('answers 402 before calling the model when the balance is short', async () => {
    auth = { creditsRemaining: 2 };
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'hook' });
      expect(r.status).toBe(402);
      expect(r.json.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', creditsRequired: 3, creditsRemaining: 2 });
      expect(modelCalls).not.toHaveBeenCalled();
      expect(deducted).toEqual([]);
    });
  });

  it('never charges an admin', async () => {
    auth = { effectiveRole: 'admin', creditsRemaining: 0 };
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'dedication' });
      expect(r.status).toBe(200);
      expect(r.json.data.credits_charged).toBe(0);
      expect(deducted).toEqual([]);
    });
  });

  it('a revision needs the current text and an instruction, and is charged like a draft', async () => {
    await server(async (base) => {
      const bad = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'hook', mode: 'revise', instruction: 'shorter' });
      expect(bad.status).toBe(400);
      const ok = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'hook', mode: 'revise', instruction: 'shorter', current: 'A long hook.' });
      expect(ok.status).toBe(200);
      expect(deducted).toEqual([{ amount: 3, description: 'copy-assist.revise:promo_copy hook' }]);
    });
  });

  it('an empty answer costs nothing', async () => {
    modelCalls.mockResolvedValue(reply(''));
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'hook' });
      expect(r.json.data.credits_charged).toBe(0);
      expect(deducted).toEqual([]);
    });
  });

  it('"Also by" lists the author\'s other projects with chapters, skipping working copies, with no model and no charge', async () => {
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'also_by' });
      expect(r.status).toBe(200);
      expect(r.json.data.items).toEqual(['The Signal Beneath']);
      expect(r.json.data.credits_charged).toBe(0);
      expect(modelCalls).not.toHaveBeenCalled();
      expect(deducted).toEqual([]);
    });
  });

  it('another user\'s project is a 404', async () => {
    auth = { userId: 'u2' };
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist', { field: 'blurb' });
      expect(r.status).toBe(404);
      expect(modelCalls).not.toHaveBeenCalled();
    });
  });
});

describe('POST /assist/all', () => {
  it('refuses a total the author was not shown (409) and runs nothing', async () => {
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist/all', { fields: ['blurb', 'hook'], expected_cost: 3 });
      expect(r.status).toBe(409);
      expect(r.json.error.total).toBe(6);
      expect(modelCalls).not.toHaveBeenCalled();
    });
  });

  it('drafts the listed fields at the quoted total and charges only the ones that came back', async () => {
    modelCalls.mockImplementation(async (_p, ctx) => {
      if (ctx.operation === 'copy-assist.hook') throw new Error('model down');
      return ctx.operation === 'copy-assist.keywords' ? reply('', ['steampunk']) : reply('Cogwheel wakes.');
    });
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist/all', { fields: ['blurb', 'hook', 'keywords'], expected_cost: 9 });
      expect(r.status).toBe(200);
      expect(Object.keys(r.json.data.results).sort()).toEqual(['blurb', 'keywords']);
      expect(r.json.data.errors).toEqual({ hook: 'model down' });
      expect(deducted).toEqual([{ amount: 6, description: 'copy-assist.all:promo_copy x2' }]);
      expect(writes).toEqual([]);
    });
  });

  it('only package fields can be batch-drafted (not the dedication)', async () => {
    await server(async (base) => {
      const r = await call(base, 'POST', '/api/copy-assist/project/p1/assist/all', { fields: ['dedication'], expected_cost: 3 });
      expect(r.status).toBe(400);
    });
  });
});

describe('the saved copy', () => {
  it('saves subtitle, inside flap and Also by on book_copy_v2 and reads them back with the price', async () => {
    await server(async (base) => {
      const put = await call(base, 'PUT', '/api/copy-assist/project/p1/copy', { subtitle: 'A Novel', inside_flap: 'London, 1888.', also_by: ['The Signal Beneath'], generated: ['inside_flap'] });
      expect(put.status).toBe(200);
      const rows = writes.find((w) => w.table === 'book_copy_v2')!.rows as Row[];
      expect(rows.map((r) => [r.field, r.volume_index, r.source])).toEqual([
        ['subtitle', 1, 'edited'],
        ['inside_flap', 1, 'generated'],
        ['also_by', 1, 'edited'],
      ]);
      const got = await call(base, 'GET', '/api/copy-assist/project/p1/copy');
      expect(got.json.data.books['1']).toEqual({ subtitle: 'A Novel', inside_flap: 'London, 1888.' });
      expect(got.json.data.also_by).toEqual(['The Signal Beneath']);
      expect(got.json.data.assist).toMatchObject({ price: 3, charged: true });
      expect(got.json.data.assist.fields.blurb).toMatchObject({ limit: 4000 });
      expect(got.json.data.assist.fields.keywords).toMatchObject({ limit: 50, max_items: 7 });
      expect(got.json.data.assist.fields.also_by.free).toBe(true);
    });
  });

  it('refuses a subtitle that takes title + subtitle past KDP\'s 200 characters', async () => {
    await server(async (base) => {
      const r = await call(base, 'PUT', '/api/copy-assist/project/p1/copy', { subtitle: 'x'.repeat(180) });
      expect(r.status).toBe(400);
      expect(writes).toEqual([]);
    });
  });
});
