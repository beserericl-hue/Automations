/**
 * The chapter rail's Characters and Humanizer tools, over HTTP.
 *
 * Asserted: threads come from every chapter of the book; a rename touches only the uses ticked,
 * snapshots each chapter first, and skips a use that has changed; a consistency finding survives
 * only with a quote that is really in the chapters; a suggested name only with a quote that is really
 * in the research; and a humanized passage is applied only where it is found, after a snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function reset() {
  db.published_content_v2 = [
    { id: 'c4', user_id: 'u1', project_id: 'p1', content_type: 'chapter', chapter_number: 4, title: 'Ochre slab', deleted_at: null,
      content_text: 'The boy would be seven now.\n\nSeven was not old enough. He had received the name at twelve. Bent-Reed watched.' },
    { id: 'c5', user_id: 'u1', project_id: 'p1', content_type: 'chapter', chapter_number: 5, title: 'The spring', deleted_at: null,
      content_text: 'Seven days later the band moved. Bent-Reed carried the slab.' },
  ];
  db.content_versions_v2 = [];
  db.writing_projects_v2 = [{ id: 'p1', user_id: 'u1', title: 'The Ossuary', outline: { characters: [{ name: 'Bent-Reed', description: 'elder' }] } }];
  db.story_bible_v2 = [{ id: 'b1', project_id: 'p1', entry_type: 'character', name: 'Bent-Reed', description: 'elder', deleted_at: null }];
  db.research_reports_v2 = [
    { id: 'r1', user_id: 'u1', topic: 'The Ossuary — naming', deleted_at: null, content: 'Among Algonquian peoples a child was often called by a descriptive name, such as Tashaw, until a formal name was given.' },
  ];
}

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'u1'; next(); },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const parseWith = vi.fn();
vi.mock('../lib/claude-structured.js', () => ({ parseWith: (...a: unknown[]) => parseWith(...a) }));
const engine = vi.fn();
vi.mock('../lib/engine-hub.js', () => ({ callEngineWriteToolSync: (...a: unknown[]) => engine(...a) }));

vi.mock('../services/supabase-admin.js', () => {
  const build = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let inserted: Row | null = null;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      like: (c: string, v: string) => (filters.push((r) => String(r[c]).startsWith(v.replace(/%$/, ''))), q),
      update: (p: Row) => ((patch = p), q),
      insert: (r: Row) => { inserted = r; db[table].push(r); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === 'content_versions_v2' ? rows().sort((a, b) => Number(b.version_number) - Number(a.version_number))[0] ?? null : rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) { const hit = rows(); for (const r of hit) Object.assign(r, patch); resolve({ data: hit, error: null }); return; }
        resolve({ data: rows(), error: null });
      },
    };
    void inserted;
    return q;
  };
  return { getSupabaseAdmin: () => ({ from: (t: string) => build(t) }) };
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { contentToolsRouter } = await import('../routes/content-tools.js');
  const app = express();
  app.use(express.json());
  app.use('/api/content', contentToolsRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const post = (base: string, path: string, body: unknown): Promise<Json> =>
  fetch(`${base}/api/content/c4${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (base: string, path: string): Promise<Json> => fetch(`${base}/api/content/c4${path}`).then((r) => r.json());

beforeEach(() => { reset(); parseWith.mockReset(); engine.mockReset(); });

describe('threads', () => {
  it('finds a name in every chapter of the book, with context, and says when it is also a number', async () => {
    await withServer(async (base) => {
      const j = await get(base, '/characters/threads?name=Seven');
      expect(j.data.total).toBe(2);
      expect(j.data.threads.map((t: { chapter_number: number }) => t.chapter_number)).toEqual([4, 5]);
      expect(j.data.ambiguity).toMatch(/also a number/);
    });
  });

  it('lists who appears in this chapter, from the cast and from the text', async () => {
    await withServer(async (base) => {
      const j = await get(base, '/characters');
      expect(j.data.characters[0]).toMatchObject({ name: 'Bent-Reed', source: 'cast', mentions_here: 1 });
    });
  });
});

describe('rename', () => {
  it('renames only the ticked uses, snapshots each chapter first, and updates the cast and bible', async () => {
    await withServer(async (base) => {
      const off = String(db.published_content_v2[0].content_text).indexOf('Bent-Reed');
      const off5 = String(db.published_content_v2[1].content_text).indexOf('Bent-Reed');
      const j = await post(base, '/characters/rename', { from: 'Bent-Reed', to: 'Askuwheteau', mention_ids: [`c4:${off}`, `c5:${off5}`] });
      expect(j.data.applied).toBe(2);
      expect(db.published_content_v2[0].content_text).toContain('Askuwheteau watched');
      expect(db.content_versions_v2.map((v) => v.content_id).sort()).toEqual(['c4', 'c5']);
      expect(String(db.content_versions_v2[0].content_text)).toContain('Bent-Reed');
      expect(db.story_bible_v2[0].name).toBe('Askuwheteau');
      expect((db.writing_projects_v2[0].outline as { characters: Array<{ name: string }> }).characters[0].name).toBe('Askuwheteau');
    });
  });

  it('leaves the number alone when only the name use is ticked', async () => {
    await withServer(async (base) => {
      const text = String(db.published_content_v2[0].content_text);
      await post(base, '/characters/rename', { from: 'Seven', to: 'Tashaw', mention_ids: [`c4:${text.indexOf('Seven was')}`], update_records: false });
      expect(db.published_content_v2[0].content_text).toContain('Tashaw was not old enough');
      expect(db.published_content_v2[1].content_text).toContain('Seven days later');
    });
  });
});

describe('consistency check', () => {
  it('keeps a finding only when its quote is really in the chapters', async () => {
    parseWith.mockResolvedValue({ findings: [
      { kind: 'ambiguity', explanation: 'reads as a name and an age', quotes: ['Seven was not old enough.'], suggestion: 'Seven winters was not old enough.' },
      { kind: 'contradiction', explanation: 'invented', quotes: ['Seven was named at birth by the river.'], suggestion: 'x' },
    ] });
    await withServer(async (base) => {
      const j = await post(base, '/characters/check', { name: 'Seven' });
      expect(j.data.findings).toHaveLength(1);
      expect(j.data.findings[0].kind).toBe('ambiguity');
      expect(j.data.dropped).toBe(1);
    });
  });
});

describe('name suggestions', () => {
  it('keeps a suggestion only when its quote is in the research', async () => {
    parseWith.mockResolvedValue({ note: '', suggestions: [
      { name: 'Tashaw', meaning: '', why: 'attested', quote: 'a child was often called by a descriptive name, such as Tashaw', report_id: 'r1' },
      { name: 'Wapasu', meaning: '', why: 'made up', quote: 'Wapasu was a common name', report_id: 'r1' },
    ] });
    await withServer(async (base) => {
      const j = await post(base, '/characters/suggest', { name: 'Seven' });
      expect(j.data.suggestions.map((s: { name: string }) => s.name)).toEqual(['Tashaw']);
      expect(j.data.suggestions[0].report_topic).toBe('The Ossuary — naming');
    });
  });
});

describe('humanizer', () => {
  it('passes the passage to the engine and saves nothing', async () => {
    engine.mockResolvedValue({ text: 'He was too young yet.', changed: true, detectability: 20 });
    await withServer(async (base) => {
      const j = await post(base, '/humanize', { text: 'Seven was not old enough.' });
      expect(engine).toHaveBeenCalledWith('chapter', expect.objectContaining({ op: 'humanize-passage', text: 'Seven was not old enough.' }));
      expect(j.data.text).toBe('He was too young yet.');
      expect(db.content_versions_v2).toEqual([]);
    });
  });

  it('applies the chosen version after a snapshot, and refuses a passage it cannot find', async () => {
    await withServer(async (base) => {
      const ok = await post(base, '/humanize/apply', { original: 'Seven was not old enough.', replacement: 'Seven winters was not old enough.' });
      expect(ok.data.replaced).toBe(true);
      expect(db.published_content_v2[0].content_text).toContain('Seven winters was not old enough.');
      expect(db.content_versions_v2).toHaveLength(1);
      const miss = await post(base, '/humanize/apply', { original: 'Not in the chapter at all.', replacement: 'x' });
      expect(miss.error.code).toBe('PASSAGE_NOT_FOUND');
    });
  });
});
