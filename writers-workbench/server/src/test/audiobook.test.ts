/**
 * Audiobooks: what is narrated and in what order, what is charged, and what the screen is told.
 *
 * The plan (lib/audiobook.ts) is pure. The routes run over an in-memory database with the engine
 * stubbed, so each assertion is about what the author is shown, charged and queued — not about a mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import type { AddressInfo } from 'net';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const uploads: { path: string; body: Buffer; contentType?: string }[] = [];
const engineJobs: Record<string, any>[] = [];
const deductions: { userId: string; amount: number; label: string }[] = [];
let credits = 1000;
let role = 'user';
let engineDown = false;
let owner = 'u1';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.userId = owner;
    req.effectiveRole = role;
    req.subscriptionTier = 'pro';
    req.creditsRemaining = credits;
    next();
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../services/credit-costs.js', () => ({ getCreditCost: async () => 8 }));
vi.mock('../services/credits.js', () => ({
  deductCredits: async (userId: string, amount: number, label: string) => { deductions.push({ userId, amount, label }); },
}));

const chapters: { chapter_number: number; title: string; content_text: string; status: string }[] = [];
vi.mock('../lib/book-source.js', () => ({
  loadBookSource: async (p: string, u: string) =>
    p === '11111111-1111-4111-8111-111111111111' && u === 'u1'
      ? { title: 'The Ossuary', author: 'Eric Beser', authorBio: '', chapters, settings: {}, art: null, artByVolume: {}, marketing: {}, series: { name: 'The Ossuary', titles: {} } }
      : null,
}));
vi.mock('../lib/book-cover.js', () => ({
  findCover: async () => ({ id: 'img1', storage_path: 'u1/cover.png', created_at: '', chosen: true }),
  downloadCover: async () => sharp({ create: { width: 1024, height: 1792, channels: 3, background: '#336699' } }).png().toBuffer(),
}));
vi.mock('../lib/engine-hub.js', () => ({
  callEngineWriteTool: async (_tool: string, body: Record<string, any>) => {
    if (engineDown) throw new Error('engine write media 503');
    engineJobs.push(body);
    return { job_id: `job-${engineJobs.length}`, status: 'queued' };
  },
  callEngineWriteToolSync: async (_tool: string, body: Record<string, any>) => {
    engineJobs.push(body);
    return { audio_b64: 'bXAz', content_type: 'audio/mpeg' };
  },
}));

vi.mock('../services/supabase-admin.js', () => {
  let n = 0;
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let order: string | null = null;
    let lim = Infinity;
    let pending: Row | null = null;
    let inserted: Row | null = null;
    const rows = () => {
      let out = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) out = [...out].sort((a, b) => Number(a[order!]) - Number(b[order!]));
      return out.slice(0, lim);
    };
    const q: Record<string, any> = {
      select: () => q,
      order: (c: string) => ((order = c), q),
      limit: (c: number) => ((lim = c), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      insert: (r: Row) => { inserted = { id: `row-${++n}`, ...r }; (db[table] ??= []).push(inserted); return q; },
      upsert: (r: Row, o: { onConflict: string }) => {
        const keys = o.onConflict.split(',');
        const hit = (db[table] ??= []).find((x) => keys.every((k) => x[k] === r[k]));
        if (hit) { Object.assign(hit, r); inserted = hit; } else { inserted = { id: `row-${++n}`, ...r }; db[table].push(inserted); }
        return q;
      },
      update: (p: Row) => ((patch = p), q),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: inserted ?? rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) { for (const r of rows()) Object.assign(r, patch); return resolve({ error: null }); }
        void pending;
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  const storage = {
    from: () => ({
      upload: async (path: string, body: Buffer, o?: { contentType?: string }) => { uploads.push({ path, body, contentType: o?.contentType }); return { error: null }; },
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://dev.supabase.co/sign/${p}?token=t`, error: null })), error: null }),
    }),
  };
  return { getSupabaseAdmin: () => ({ from, storage }) };
});

const PROJECT = '11111111-1111-4111-8111-111111111111';
const realFetch = globalThis.fetch;

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.writing_projects_v2 = [{ id: PROJECT, user_id: 'u1', outline: {} }];
  uploads.length = 0;
  engineJobs.length = 0;
  deductions.length = 0;
  credits = 1000;
  role = 'user';
  engineDown = false;
  owner = 'u1';
  chapters.length = 0;
  chapters.push(
    { chapter_number: 1, title: 'The Door', content_text: words(1500), status: 'approved' },
    { chapter_number: 2, title: 'Chapter 2: Rain', content_text: words(900), status: 'approved' },
  );
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { audiobookRouter } = await import('../routes/audiobook.js');
  const app = express();
  app.use(express.json());
  app.use('/api/audiobook', audiobookRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}/api/audiobook`); } finally { server.close(); }
}
const call = (base: string, method: string, path: string, body?: unknown): Promise<any> =>
  realFetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, ...((await r.json()) as Record<string, unknown>) }));
const get = (base: string) => call(base, 'GET', `/project/${PROJECT}`);

/** What the engine does when a recording finishes. */
function finish(kind: string, chapter = 0, extra: Row = {}) {
  const row = db.audiobook_chapters_v2.find((r) => r.kind === kind && r.chapter_number === chapter)!;
  Object.assign(row, { status: 'ready', storage_path: `u1/b/${row.position}.mp3`, duration_s: 60, size_bytes: 1_440_000, rms_db: -20.5, peak_db: -3.6, spec_ok: true, updated_at: new Date().toISOString(), ...extra });
}

describe('the plan', () => {
  it('speaks "Chapter N." unless the title already says what it is', async () => {
    const { spokenChapterTitle } = await import('../lib/audiobook.js');
    expect(spokenChapterTitle(3, 'The Door')).toBe('Chapter 3. The Door');
    expect(spokenChapterTitle(3, '')).toBe('Chapter 3');
    expect(spokenChapterTitle(2, 'Chapter 2: Rain')).toBe('Chapter 2. Rain');
    expect(spokenChapterTitle(0, 'Prologue')).toBe('Prologue');
    expect(spokenChapterTitle(0, 'Before')).toBe('Before');
  });

  it('opens and closes with spoken credits that say the narrator is an A.I. voice, and fixed slots so a toggle renumbers nothing', async () => {
    const { planAudiobook, normalizeSettings, OPENING_POSITION, CLOSING_POSITION } = await import('../lib/audiobook.js');
    const { loadBookSource } = await import('../lib/book-source.js');
    const src = (await loadBookSource(PROJECT, 'u1'))!;
    const plan = planAudiobook(src, 1, normalizeSettings(null))!;
    expect(plan.items.map((i) => [i.kind, i.position])).toEqual([['opening', OPENING_POSITION], ['chapter', 1], ['chapter', 2], ['closing', CLOSING_POSITION]]);
    expect(plan.items[0].source_text).toBe('The Ossuary. Written by Eric Beser. Narrated by an A.I. voice.');
    expect(plan.items[3].source_text).toBe('This has been The Ossuary, written by Eric Beser. Thank you for listening.');
    const bare = planAudiobook(src, 1, normalizeSettings({ credits: false }))!;
    expect(bare.items.map((i) => [i.kind, i.position])).toEqual([['chapter', 1], ['chapter', 2]]);
  });

  it('a recording is identified by its words, voice and direction — and by nothing else', async () => {
    const { hashItem, normalizeSettings } = await import('../lib/audiobook.js');
    const item = { kind: 'chapter' as const, title: 'Chapter 1', source_text: 'Hello.' };
    const base = hashItem(item, normalizeSettings(null));
    expect(hashItem({ ...item }, normalizeSettings(null))).toBe(base);
    expect(hashItem({ ...item, source_text: 'Hello!' }, normalizeSettings(null))).not.toBe(base);
    expect(hashItem(item, normalizeSettings({ voice: 'cedar' }))).not.toBe(base);
    expect(hashItem(item, normalizeSettings({ style: 'epic' }))).not.toBe(base);
    expect(hashItem(item, normalizeSettings({ custom_style: 'slower' }))).not.toBe(base);
  });

  it('unknown voices and styles fall back; the author\'s note is bounded', async () => {
    const { normalizeSettings, MAX_CUSTOM_STYLE } = await import('../lib/audiobook.js');
    expect(normalizeSettings({ voice: 'nobody', style: 'nope' })).toMatchObject({ voice: 'marin', style: 'fiction', credits: true });
    expect(normalizeSettings({ custom_style: 'x'.repeat(5000) }).custom_style).toHaveLength(MAX_CUSTOM_STYLE);
  });

  it('prices narration per started 1,000 words of chapter text; credits and sample are free', async () => {
    const { narrationUnits } = await import('../lib/audiobook.js');
    expect(narrationUnits([{ kind: 'chapter', words: 1500 }, { kind: 'chapter', words: 900 }, { kind: 'opening', words: 12 }, { kind: 'closing', words: 14 }])).toBe(3);
    expect(narrationUnits([{ kind: 'chapter', words: 1 }])).toBe(1);
  });

  it('file names sort in listening order', async () => {
    const { filenameFor } = await import('../lib/audiobook.js');
    expect(filenameFor({ kind: 'opening', chapter_number: 0, title: '' }, 0)).toBe('00 - Opening Credits.mp3');
    expect(filenameFor({ kind: 'chapter', chapter_number: 1, title: 'Chapter 1. The Door' }, 1)).toBe('01 - Chapter 1 The Door.mp3');
    expect(filenameFor({ kind: 'sample', chapter_number: 0, title: '' }, 9)).toBe('Retail Sample.mp3');
  });

  it('the cover is made square at 2400 px without cropping or stretching the book cover', async () => {
    const { squareCover } = await import('../lib/audiobook.js');
    const out = await squareCover(await sharp({ create: { width: 1024, height: 1792, channels: 3, background: '#cc3333' } }).png().toBuffer());
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 2400, 2400]);
    // The whole cover sits in the middle (its colour), the soft extension at the sides is darker.
    const mid = await sharp(out).extract({ left: 1200, top: 1200, width: 1, height: 1 }).raw().toBuffer();
    expect(mid[0]).toBeGreaterThan(150);
  });
});

describe('GET: what the screen is shown', () => {
  it('nothing built yet: every recording is missing, and the price of building it all is stated', async () => {
    await withServer(async (base) => {
      const r = await get(base);
      expect(r.status).toBe(200);
      expect(r.data.items.map((i: Row) => [i.kind, i.status])).toEqual([['opening', 'none'], ['chapter', 'none'], ['chapter', 'none'], ['closing', 'none']]);
      expect(r.data.summary).toMatchObject({ total: 4, missing: 4, ready: 0 });
      // 1,500 words = 2 units, 900 words = 1 unit, at 8 credits.
      expect(r.data.cost).toMatchObject({ credits_per_unit: 8, to_build_credits: 24, total_credits: 24 });
      expect(r.data.cover.available).toBe(true);
      expect(r.data.settings).toMatchObject({ voice: 'marin', style: 'fiction', credits: true });
    });
  });

  it('another user\'s project, and a malformed id, are 404', async () => {
    await withServer(async (base) => {
      owner = 'u2';
      expect((await get(base)).status).toBe(404);
      owner = 'u1';
      expect((await call(base, 'GET', '/project/not-a-uuid')).status).toBe(404);
    });
  });
});

describe('settings', () => {
  it('are saved per book, and the next read shows them', async () => {
    await withServer(async (base) => {
      const put = await call(base, 'PUT', `/project/${PROJECT}/settings`, { volume: 1, voice: 'cedar', style: 'thriller', custom_style: 'a little slower', credits: false });
      expect(put.status).toBe(200);
      const r = await get(base);
      expect(r.data.settings).toEqual({ voice: 'cedar', style: 'thriller', custom_style: 'a little slower', credits: false, pronunciations: [] });
      expect(r.data.items.map((i: Row) => i.kind)).toEqual(['chapter', 'chapter']);
    });
  });
});

describe('build', () => {
  it('queues one engine job per recording with the text, charges narration only, and tags the files', async () => {
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(r.status).toBe(202);
      expect(r.data).toMatchObject({ queued: 4, credits_charged: 24 });
      expect(deductions).toEqual([{ userId: 'u1', amount: 24, label: `audiobook.narrate:${PROJECT}` }]);

      expect(engineJobs).toHaveLength(4);
      expect(engineJobs.every((j) => j.op === 'audiobook-chapter' && j.user_id === 'u1' && j.async === true)).toBe(true);
      expect(engineJobs[1].tags).toMatchObject({ album: 'The Ossuary', artist: 'Eric Beser', track: '2' });

      const rows = db.audiobook_chapters_v2;
      expect(rows.map((x) => [x.kind, x.status, x.position])).toEqual([['opening', 'queued', 0], ['chapter', 'queued', 1], ['chapter', 'queued', 2], ['closing', 'queued', 9998]]);
      expect(rows[1].title).toBe('Chapter 1. The Door');
      expect(rows[2].title).toBe('Chapter 2. Rain');
      expect(rows[1].source_text.split(' ')).toHaveLength(1500);
      expect(rows[1].engine_job_id).toBeTruthy();
      // The square cover was made and stored.
      const cover = uploads.find((u) => u.path.endsWith('/cover.jpg'))!;
      expect(cover.contentType).toBe('image/jpeg');
      expect(await sharp(cover.body).metadata()).toMatchObject({ width: 2400, height: 2400 });
    });
  });

  it('is not built twice: a second press while they are on their way queues and charges nothing', async () => {
    await withServer(async (base) => {
      await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      engineJobs.length = 0;
      deductions.length = 0;
      const again = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(again.data).toMatchObject({ queued: 0, skipped_in_progress: 4, credits_charged: 0 });
      expect(engineJobs).toHaveLength(0);
      expect(deductions).toHaveLength(0);
    });
  });

  it('refuses with 402 before queueing anything when the balance is short', async () => {
    credits = 10;
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(r.status).toBe(402);
      expect(r.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', creditsRequired: 24 });
      expect(engineJobs).toHaveLength(0);
      expect(db.audiobook_chapters_v2 ?? []).toHaveLength(0);
    });
  });

  it('an admin is never checked or charged', async () => {
    credits = 0;
    role = 'admin';
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(r.status).toBe(202);
      expect(r.data.credits_charged).toBe(0);
      expect(deductions).toHaveLength(0);
    });
  });

  it('when the engine cannot be reached the recordings say so and nothing is charged', async () => {
    engineDown = true;
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(r.data).toMatchObject({ queued: 0, credits_charged: 0 });
      expect(db.audiobook_chapters_v2.every((x) => x.status === 'failed' && /could not be reached/.test(x.error))).toBe(true);
      expect(deductions).toHaveLength(0);
    });
  });

  it('a book with no chapter text cannot be narrated', async () => {
    chapters.length = 0;
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(r.status).toBe(422);
      expect(r.error.code).toBe('NO_CHAPTERS');
    });
  });
});

describe('a built book', () => {
  async function built(base: string) {
    await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
    finish('opening');
    finish('chapter', 1);
    finish('chapter', 2);
    finish('closing');
    engineJobs.length = 0;
    deductions.length = 0;
  }

  it('lists each chapter\'s own recording with a playable link and a named download', async () => {
    await withServer(async (base) => {
      await built(base);
      const r = await get(base);
      const ch1 = r.data.items.find((i: Row) => i.chapter_number === 1);
      expect(ch1.status).toBe('ready');
      expect(ch1.url).toBe('https://dev.supabase.co/sign/u1/b/1.mp3?token=t');
      expect(ch1.download_url).toBe(`${ch1.url}&download=${encodeURIComponent('01 - Chapter 1 The Door.mp3')}`);
      expect(r.data.summary).toMatchObject({ ready: 4, building: 0, failed: 0, stale: 0, missing: 0, out_of_spec: 0, duration_s: 240 });
      expect(r.data.cost.to_build_credits).toBe(0);
    });
  });

  it('flags a recording whose chapter changed, and rebuilding it charges that chapter alone', async () => {
    await withServer(async (base) => {
      await built(base);
      chapters[1].content_text = `${words(900)} and a new ending.`;
      const r = await get(base);
      expect(r.data.items.filter((i: Row) => i.stale).map((i: Row) => i.chapter_number)).toEqual([2]);
      expect(r.data.cost.to_build_credits).toBe(8);

      const b = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(b.data).toMatchObject({ queued: 1, credits_charged: 8 });
      expect(engineJobs.map((j) => j.item_id)).toEqual([db.audiobook_chapters_v2.find((x) => x.chapter_number === 2)!.id]);
    });
  });

  it('a new voice makes every recording stale', async () => {
    await withServer(async (base) => {
      await built(base);
      await call(base, 'PUT', `/project/${PROJECT}/settings`, { volume: 1, voice: 'onyx' });
      const r = await get(base);
      expect(r.data.summary.stale).toBe(4);
    });
  });

  it('a build that stopped answering is reported as interrupted and can be started again', async () => {
    await withServer(async (base) => {
      await built(base);
      const row = db.audiobook_chapters_v2.find((x) => x.chapter_number === 1)!;
      Object.assign(row, { status: 'building', updated_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
      const r = await get(base);
      const ch1 = r.data.items.find((i: Row) => i.chapter_number === 1);
      expect(ch1.status).toBe('failed');
      expect(ch1.error).toMatch(/stopped before it finished/);
      const b = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(b.data.queued).toBe(1);
    });
  });

  it('reports a recording outside the loudness spec', async () => {
    await withServer(async (base) => {
      await built(base);
      finish('chapter', 1, { spec_ok: false, rms_db: -26 });
      expect((await get(base)).data.summary.out_of_spec).toBe(1);
    });
  });
});

describe('the retail sample', () => {
  it('needs the first chapter finished, is cut from it, and costs nothing', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'POST', `/project/${PROJECT}/sample`, { volume: 1 })).status).toBe(422);
      await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      finish('chapter', 1);
      engineJobs.length = 0;
      deductions.length = 0;
      expect((await call(base, 'POST', `/project/${PROJECT}/sample`, { volume: 1 })).status).toBe(202);
      expect(engineJobs).toHaveLength(1);
      expect(deductions).toHaveLength(0);
      expect(db.audiobook_chapters_v2.find((x) => x.kind === 'sample')).toMatchObject({ status: 'queued', position: 9999 });

      finish('sample');
      const r = await get(base);
      expect(r.data.sample).toMatchObject({ status: 'ready', can_build: true });
      expect(r.data.sample.download_url).toContain('download=Retail%20Sample.mp3');
    });
  });
});

describe('preview and cover', () => {
  it('previews the chosen voice and style on the book\'s own opening, not on stock text', async () => {
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/preview`, { volume: 1, voice: 'ballad', style: 'intimate' });
      expect(r.data).toMatchObject({ audio_b64: 'bXAz', content_type: 'audio/mpeg' });
      expect(engineJobs[0]).toMatchObject({ op: 'audiobook-preview', voice: 'ballad', style: 'intimate' });
      expect(String(engineJobs[0].text).startsWith('word0 word1')).toBe(true);
      expect(String(engineJobs[0].text).length).toBeLessThanOrEqual(1200);
    });
  });

  it('makes the square cover on demand and answers with a link to it', async () => {
    await withServer(async (base) => {
      const r = await call(base, 'POST', `/project/${PROJECT}/cover`, { volume: 1 });
      expect(r.status).toBe(200);
      expect(r.data.url).toContain('/cover.jpg');
      expect(uploads.some((u) => u.path.endsWith('/cover.jpg'))).toBe(true);
    });
  });

  it('lists the voices and styles with the price', async () => {
    await withServer(async (base) => {
      const r = await call(base, 'GET', '/options');
      expect(r.data.voices.map((v: Row) => v.id)).toEqual(expect.arrayContaining(['marin', 'cedar', 'onyx']));
      expect(r.data.styles.map((s: Row) => s.id)).toEqual(['fiction', 'thriller', 'intimate', 'epic']);
      expect(r.data).toMatchObject({ credits_per_unit: 8, unit_words: 1000 });
    });
  });
});


describe('pronunciation guide', () => {
  it('is cleaned on the way in: trimmed, blanks dropped, one line per word', async () => {
    const { normalizePronunciations } = await import('../lib/audiobook.js');
    expect(
      normalizePronunciations([
        { word: '  Siobhan ', say: ' Shivawn ' },
        { word: 'Mara', say: '' },
        { word: '', say: 'x' },
        { word: 'Harrow   Vale', say: 'Hair-oh Vayle' },
        { word: 'Siobhan', say: 'Shiv-awn' },
        'junk',
      ]),
    ).toEqual([{ word: 'Siobhan', say: 'Shiv-awn' }, { word: 'Harrow Vale', say: 'Hair-oh Vayle' }]);
    expect(normalizePronunciations('nope')).toEqual([]);
  });

  it('a recording made before the guide existed is not called changed: the fingerprint without a guide is the original formula', async () => {
    const { createHash } = await import('node:crypto');
    const { hashItem, normalizeSettings } = await import('../lib/audiobook.js');
    const item = { kind: 'chapter' as const, title: 'Chapter 1', source_text: 'Mara opened the door.' };
    const s = normalizeSettings({ voice: 'cedar', style: 'thriller', custom_style: 'slow' });
    const original = createHash('sha256').update(['chapter', 'Chapter 1', 'Mara opened the door.', 'cedar', 'thriller', 'slow'].join('\u0000')).digest('hex');
    expect(hashItem(item, s)).toBe(original);
    // a guide that does not touch this chapter leaves it alone too
    expect(hashItem(item, normalizeSettings({ voice: 'cedar', style: 'thriller', custom_style: 'slow', pronunciations: [{ word: 'Siobhan', say: 'Shivawn' }] }))).toBe(original);
  });

  it('re-records only the chapters the word is in', async () => {
    const { hashItem, normalizeSettings } = await import('../lib/audiobook.js');
    const withMara = { kind: 'chapter' as const, title: 'Chapter 1', source_text: 'Mara opened the door.' };
    const without = { kind: 'chapter' as const, title: 'Chapter 2', source_text: 'The river rose.' };
    const none = normalizeSettings(null);
    const guided = normalizeSettings({ pronunciations: [{ word: 'Mara', say: 'Mah-rah' }] });
    expect(hashItem(withMara, guided)).not.toBe(hashItem(withMara, none));
    expect(hashItem(without, guided)).toBe(hashItem(without, none));
    // and changing how it is said changes the chapter again
    const again = normalizeSettings({ pronunciations: [{ word: 'Mara', say: 'Mar-ah' }] });
    expect(hashItem(withMara, again)).not.toBe(hashItem(withMara, guided));
  });

  it('saved with the narrator; a built book then shows only the chapters containing the name as changed', async () => {
    chapters[0].content_text = `Mara opened the door. ${words(1500)}`;
    await withServer(async (base) => {
      await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      for (const [k, n] of [['opening', 0], ['chapter', 1], ['chapter', 2], ['closing', 0]] as const) finish(k, n);
      const put = await call(base, 'PUT', `/project/${PROJECT}/settings`, { volume: 1, pronunciations: [{ word: 'Mara', say: 'Mah-rah' }] });
      expect(put.data.settings.pronunciations).toEqual([{ word: 'Mara', say: 'Mah-rah' }]);
      const r = await get(base);
      expect(r.data.settings.pronunciations).toEqual([{ word: 'Mara', say: 'Mah-rah' }]);
      // only chapter 1 contains "Mara" (the credits are about the title and author)
      expect(r.data.items.filter((i: Row) => i.stale).map((i: Row) => `${i.kind}-${i.chapter_number}`)).toEqual(['chapter-1']);
      engineJobs.length = 0;
      const b = await call(base, 'POST', `/project/${PROJECT}/build`, { volume: 1 });
      expect(b.data).toMatchObject({ queued: 1, credits_charged: 16 });
    });
  });

  it('a preview can say one word with the guide applied, instead of the opening', async () => {
    await withServer(async (base) => {
      await call(base, 'POST', `/project/${PROJECT}/preview`, { volume: 1, say: 'Siobhan', pronunciations: [{ word: 'Siobhan', say: 'Shivawn' }] });
      expect(engineJobs[0]).toMatchObject({ op: 'audiobook-preview', text: 'Siobhan', pronunciations: [{ word: 'Siobhan', say: 'Shivawn' }] });
    });
  });

  it('suggests names that recur mid-sentence, not sentence starts, days or the ones already in the guide', async () => {
    const { suggestNames } = await import('../lib/audiobook.js');
    const text = 'Siobhan ran. Then Siobhan hid, and Siobhan wept. She saw Tomas on Monday, and Tomas smiled; Tomas left. Later, the river rose. Then Harrow came. And Harrow went. Harrow stayed.';
    // Mid-sentence only (the first Siobhan and Harrow open sentences), three or more times, never a weekday.
    expect(suggestNames([text])).toEqual([{ word: 'Tomas', count: 3 }]);
    expect(suggestNames([text, text])).toEqual([{ word: 'Tomas', count: 6 }, { word: 'Harrow', count: 4 }, { word: 'Siobhan', count: 4 }]);
    expect(suggestNames([text, text], ['tomas'])).toEqual([{ word: 'Harrow', count: 4 }, { word: 'Siobhan', count: 4 }]);
  });

  it('the names route returns suggestions from this book\'s chapters', async () => {
    chapters[0].content_text = 'He said Siobhan was gone, and then Siobhan came back, and Siobhan smiled.';
    await withServer(async (base) => {
      const r = await call(base, 'GET', `/project/${PROJECT}/names`);
      expect(r.status).toBe(200);
      expect(r.data.names).toEqual([{ word: 'Siobhan', count: 3 }]);
    });
  });
});
