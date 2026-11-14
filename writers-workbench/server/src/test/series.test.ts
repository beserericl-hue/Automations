/**
 * Series: each book under its own title, and each one selling the next.
 *
 * Asserted: a titled series book carries its title with "Book One of <series>" beneath it on the
 * title and copyright pages; an untitled one reads "<series>: Book One" with no second line; the
 * back matter lists the series in reading order with this book marked, and ends with the next
 * book's first chapter; the last book has no excerpt; titles are kept per chapter range and flagged
 * when the plan moves; and an ending is spliced in only into the chapter it was drafted against,
 * after a snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { bookMatter } from '../lib/bookmatter.js';
import { plannedVolumes, volumeParts, wrapTitling, type BuildPackageOptions } from '../lib/kdp-package.js';
import { chapterWithCoda, chapterWithRecap, outlineWithCoda, outlineWithRecap, seriesView, textHash, type CodaDraft } from '../lib/series.js';
import { lineupHeading, verbatimBlocks, type LandingCopy } from '../lib/landing-page.js';

const text = (sections: { blocks: { text: string }[] }[]) => sections.flatMap((s) => s.blocks.map((b) => b.text));

describe('front and back matter for a series book', () => {
  const base = { title: 'The Ossuary', author: 'Eric L Beser' };
  const books = [
    { index: 1, title: 'The Pewter Light', hook: 'Who speaks for the dead?' },
    { index: 2, title: 'The Fort Post', hook: 'Men were already loading their guns.' },
    { index: 3, title: '' },
  ];

  it('a titled book carries its title, and the series beneath it', () => {
    const m = bookMatter({ ...base, volume: { index: 1, total: 3, seriesName: 'The Ossuary', bookTitle: 'The Pewter Light', books } });
    const title = m.front.find((s) => s.kind === 'title')!;
    expect(text([title])).toEqual(['The Pewter Light', 'Book One of The Ossuary', 'Eric L Beser']);
    const copyright = text(m.front.filter((s) => s.kind === 'copyright'));
    expect(copyright.slice(0, 2)).toEqual(['The Pewter Light', 'Book One of The Ossuary']);
  });

  it('an untitled book reads "<series>: Book Three", with no second line', () => {
    const m = bookMatter({ ...base, volume: { index: 3, total: 3, seriesName: 'The Ossuary', books } });
    expect(text(m.front.filter((s) => s.kind === 'title'))).toEqual(['The Ossuary: Book Three', 'Eric L Beser']);
  });

  it('lists the series in reading order with this book marked, then prints the next book’s opening', () => {
    const m = bookMatter({
      ...base,
      volume: {
        index: 1, total: 3, seriesName: 'The Ossuary', bookTitle: 'The Pewter Light', books,
        excerpt: { bookIndex: 2, bookTitle: 'The Fort Post', ownTitle: true, chapterTitle: 'Stratum IV', text: 'The fort post stood.\n\n---\n\nBent-Reed carried the slab.' },
      },
    });
    const series = m.back.find((s) => s.kind === 'series')!;
    expect(series.heading).toBe('The Ossuary');
    expect(text([series])).toEqual([
      'Book One: The Pewter Light  (this book)', 'Who speaks for the dead?',
      'Book Two: The Fort Post', 'Men were already loading their guns.',
      'Book Three',
    ]);
    // A series lists its books on the series page, not again as "also by".
    expect(m.back.some((s) => s.kind === 'also-by')).toBe(false);
    const excerpt = m.back[m.back.length - 1];
    expect(excerpt.kind).toBe('excerpt');
    expect(excerpt.heading).toBe('Read on: The Fort Post');
    expect(text([excerpt])).toEqual(['Book Two of The Ossuary', 'Stratum IV', 'The fort post stood.', '* * *', 'Bent-Reed carried the slab.']);
  });

  it('a book in volumes, not a series, is unchanged', () => {
    const m = bookMatter({ ...base, volume: { index: 2, total: 3 } });
    expect(text(m.front.filter((s) => s.kind === 'title'))).toEqual(['The Ossuary', 'Volume Two', 'Eric L Beser']);
  });
});

describe('volume parts', () => {
  const chapters = [1, 2, 3, 4, 5, 6].map((n) => ({ chapter_number: n, title: `Ch ${n}`, content_text: `Text of chapter ${n}.`, status: 'draft' }));
  const opts = (titles: Record<string, string>): BuildPackageOptions => ({
    title: 'The Ossuary', author: 'A', authorBio: '', chapters,
    settings: { trim: '6x9', paper: 'cream', publisher: '', isbns: {}, dedication: '', epigraph: '', epigraph_attribution: '', authors_note: '', acknowledgements: '', body_size: 11 },
    volumes: [{ index: 1, first_chapter: 1, last_chapter: 2 }, { index: 2, first_chapter: 3, last_chapter: 4 }, { index: 3, first_chapter: 5, last_chapter: 6 }],
    marketing: { '2': { hook: 'The fort burns.' } },
    series: { name: 'The Ossuary', titles },
  });

  it('gives a book its title, the series list, and the next book’s first chapter', () => {
    const o = opts({ '1': 'The Pewter Light', '2': 'The Fort Post' });
    const planned = plannedVolumes(o, chapters);
    const p = volumeParts(o, planned, chapters, planned[0]);
    expect(p.fullTitle).toBe('The Pewter Light');
    expect(p.volume?.excerpt).toMatchObject({ bookIndex: 2, bookTitle: 'The Fort Post', chapterTitle: 'Ch 3', text: 'Text of chapter 3.' });
    expect(p.volume?.books?.[1]).toEqual({ index: 2, title: 'The Fort Post', hook: 'The fort burns.' });
    expect(wrapTitling('The Ossuary', p.volume)).toEqual({ title: 'The Pewter Light', volumeLabel: 'Book 1', seriesLine: 'Book One of The Ossuary' });
  });

  it('the last book has no excerpt, and an untitled book still says which it is on the cover', () => {
    const o = opts({});
    const planned = plannedVolumes(o, chapters);
    const last = volumeParts(o, planned, chapters, planned[2]);
    expect(last.volume?.excerpt).toBeUndefined();
    expect(last.fullTitle).toBe('The Ossuary: Book Three');
    expect(wrapTitling('The Ossuary', last.volume)).toEqual({ title: 'The Ossuary', volumeLabel: 'Book 3', seriesLine: 'Book Three' });
  });
});

describe('the landing page lineup', () => {
  const copy = {
    title: 'The Ossuary', author: 'A', hook: 'h', blurb: 'b', backCover: 'c', bio: '', facts: [], images: [],
    form: { heading: '', lede: 'l', button: '', fields: [] }, seo: { title: '', description: '', keywords: [] },
    volumes: [{ index: 1, hook: 'Who speaks for the dead?', title: 'The Pewter Light' }, { index: 2, hook: 'The fort burns.' }],
  } as LandingCopy;

  it('is the series, with its pitch and each book’s title, once the pitch is written', () => {
    const withSeries = { ...copy, series: { name: 'The Ossuary', description: 'Twelve thousand years on one terrace.' } };
    expect(lineupHeading(withSeries)).toBe('The Ossuary series');
    expect(lineupHeading({ ...withSeries, series: { name: 'Ossuary Cycle', description: 'x' } })).toBe('The Ossuary Cycle series');
    const labels = verbatimBlocks(withSeries).map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(['series description paragraph 1', 'book 1 title', 'book 1 hook', 'book 2 hook']));
  });

  it('stays "in two volumes" until there is a series pitch', () => {
    expect(lineupHeading(copy)).toBe('The Ossuary in two volumes');
  });
});

describe('the series view', () => {
  it('flags a title chosen for chapters the book no longer covers', () => {
    const outline = {
      _volume_plan: { volumes: [{ index: 1, first_chapter: 0, last_chapter: 30 }, { index: 2, first_chapter: 31, last_chapter: 61 }] },
      _series: { books: { '1': { title: 'The Pewter Light', first_chapter: 0, last_chapter: 28, source: 'edited', chosen_at: 'x' } } },
    };
    const v = seriesView(outline, 'The Ossuary');
    expect(v.name).toBe('The Ossuary');
    expect(v.name_is_default).toBe(true);
    expect(v.books[0]).toMatchObject({ title: 'The Pewter Light', title_stale: true });
    expect(v.books[1]).toMatchObject({ title: '', title_stale: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
// A table whose next insert or update fails, to prove what happens when the database says no.
const failing = { insert: null as string | null, update: null as string | null };
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => { req.userId = 'u1'; next(); },
  requireTierFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const engine = vi.fn();
const engineJob = vi.fn();
vi.mock('../lib/engine-hub.js', () => ({
  callEngineWriteToolSync: (...a: unknown[]) => engine(...a),
  callEngineWriteTool: (...a: unknown[]) => engineJob(...a),
}));
vi.mock('../services/supabase-admin.js', () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q, in: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      insert: (r: Row) => {
        if (failing.insert === table) return Promise.resolve({ error: { message: 'insert refused' } });
        (db[table] ??= []).push({ ...r });
        return Promise.resolve({ error: null });
      },
      update: (p: Row) => ((patch = p), q),
      maybeSingle: () => Promise.resolve({ data: table === 'content_versions_v2' ? null : rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (patch && failing.update === table) return resolve({ data: null, error: { message: 'update refused' } });
        if (patch) { for (const r of rows()) Object.assign(r, patch); return resolve({ data: rows(), error: null }); }
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  return { getSupabaseAdmin: () => ({ from }) };
});

const CHAPTER = 'Marcus carried the box. He set it on the table. I need to think, he said.';
beforeEach(() => {
  engine.mockReset();
  engineJob.mockReset();
  failing.insert = null;
  failing.update = null;
  db.outline_versions_v2 = [];
  db.writing_projects_v2 = [{
    id: 'p1', user_id: 'u1', title: 'The Ossuary', genre_slug: null, deleted_at: null,
    outline: { _volume_plan: { volumes: [{ index: 1, first_chapter: 0, last_chapter: 30, ending_resolves: 'r', ending_carries: 'c' }, { index: 2, first_chapter: 31, last_chapter: 61 }] }, _marketing: { blurb: 'B1' } },
  }];
  db.published_content_v2 = [{ id: 'c30', user_id: 'u1', content_text: CHAPTER }];
  db.content_versions_v2 = [];
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { seriesRouter } = await import('../routes/series.js');
  const app = express();
  app.use(express.json());
  app.use('/api/publishing', seriesRouter);
  const server = app.listen(0);
  try { return await fn(`http://localhost:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (base: string, method: string, path: string, body?: unknown): Promise<any> =>
  fetch(`${base}/api/publishing/project/p1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const outline = () => db.writing_projects_v2[0].outline as Record<string, any>;

describe('series routes', () => {
  it('saves a title against the chapters the book covers now', async () => {
    await withServer(async (base) => {
      const j = await call(base, 'PUT', '/series', { name: 'The Ossuary Cycle', titles: { '1': 'The Pewter Light' }, from_suggestion: ['1'] });
      expect(j.data.series.name).toBe('The Ossuary Cycle');
      expect(outline()._series.books['1']).toMatchObject({ title: 'The Pewter Light', first_chapter: 0, last_chapter: 30, source: 'suggested' });
      // The plan and the copy are untouched.
      expect(outline()._marketing).toEqual({ blurb: 'B1' });
    });
  });

  it('asks the engine for titles with each book’s range and blurb, and keeps the suggestions', async () => {
    engine.mockResolvedValue({ ok: true, books: [{ index: 1, candidates: [{ title: 'The Pewter Light', phrase: 'the light went pewter', why: 'w' }] }], dropped: 2 });
    await withServer(async (base) => {
      const j = await call(base, 'POST', '/series/titles');
      expect(engine).toHaveBeenCalledWith('chapter', expect.objectContaining({
        op: 'series-titles', series_name: 'The Ossuary',
        books: [{ index: 1, first_chapter: 0, last_chapter: 30, blurb: 'B1' }, { index: 2, first_chapter: 31, last_chapter: 61, blurb: '' }],
      }));
      expect(j.data.series.books[0].suggestions[0].title).toBe('The Pewter Light');
      expect(j.data.dropped).toBe(2);
    });
  });

  it('applies a drafted ending only to the chapter it was drafted against, after a snapshot', async () => {
    const offset = CHAPTER.indexOf('He set it');
    engine.mockResolvedValue({
      ok: true, content_id: 'c30', chapter_number: 30, chapter_title: 'Winifred', replace_from: 'He set it on the table.', offset,
      current_ending: CHAPTER.slice(offset), new_ending: 'He opened it, and read the names.', words: 7, resolved: 'r', carried: 'c', new_names: [],
    });
    await withServer(async (base) => {
      await call(base, 'POST', '/series/books/1/ending');
      expect(engine).toHaveBeenCalledWith('chapter', expect.objectContaining({
        op: 'draft-book-ending', book: { index: 1, first_chapter: 0, last_chapter: 30 }, next_book: { index: 2, first_chapter: 31, last_chapter: 61 }, resolves: 'r', carries: 'c',
      }));
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER); // drafting writes nothing
      const j = await call(base, 'POST', '/series/books/1/ending/apply');
      expect(j.success).toBe(true);
      expect(db.published_content_v2[0].content_text).toBe('Marcus carried the box. He opened it, and read the names.');
      expect(db.content_versions_v2).toHaveLength(1);
      expect(db.content_versions_v2[0]).toMatchObject({ content_text: CHAPTER, changed_by: 'series_ending' });
      expect((await call(base, 'POST', '/series/books/1/ending/apply')).error.code).toBe('ALREADY_APPLIED');
    });
  });

  it('refuses to splice into a chapter edited since the draft', async () => {
    const offset = CHAPTER.indexOf('He set it');
    engine.mockResolvedValue({ ok: true, content_id: 'c30', offset, current_ending: CHAPTER.slice(offset), new_ending: 'x', words: 1, new_names: [] });
    await withServer(async (base) => {
      await call(base, 'POST', '/series/books/1/ending');
      db.published_content_v2[0].content_text = CHAPTER.replace('I need to think', 'I need to go');
      const j = await call(base, 'POST', '/series/books/1/ending/apply');
      expect(j.error.code).toBe('CHAPTER_CHANGED');
      expect(db.content_versions_v2).toHaveLength(0);
    });
  });
});


// ---------------------------------------------------------------------------------------------
// Closing scenes and recaps
// ---------------------------------------------------------------------------------------------

const SCENE = 'Renata lifted the binder and read the plot twice.';
const codaDraft = (over: Partial<CodaDraft> = {}): CodaDraft => ({
  content_id: 'c30', base_hash: textHash(CHAPTER), chapter_number: 30, chapter_title: 'Winifred', next_chapter_number: 31,
  text: SCENE, words: 9, brief: { title: 'The Plot Under the Binder', beat: 'Renata finds the held plot.' },
  hook: 'Someone will lift the binder.', resolved: 'r', carried: 'c', outline_beat: 'Closing scene: Renata finds the held plot.',
  next_bridge: 'Renata brings Marcus the journal.', research_topics: [], research: '', drift: null, qa: null, new_names: [], direction: '',
  drafted_at: 'x', ...over,
});
const seed = (series: Record<string, unknown>) => {
  const o = outline();
  o._series = series;
  o.chapters = [
    { chapter_number: 30, title: 'Winifred', beat: 'Marcus carries the box.', chapter_outline: { sub_chapters: [{ title: 'One', beat: 'b' }] } },
    { chapter_number: 31, title: 'Stratum IV', beat: 'The fort post.', bridge_from_prior: 'Sylvia notes the point.' },
  ];
};

describe('the pieces in the book and its outline', () => {
  it('sets a closing scene after the chapter, a recap before it', () => {
    expect(chapterWithCoda('One.\n', SCENE)).toBe(`One.\n\n---\n\n${SCENE}\n`);
    expect(chapterWithRecap('Two.', 'The Ossuary', 'Before.')).toBe('**Previously, in The Ossuary**\n\nBefore.\n\n---\n\nTwo.');
  });

  it('updates the outline to say what the book now holds, and never invents a chapter outline', () => {
    const o = { chapters: [{ chapter_number: 30, beat: 'B.', chapter_outline: { sub_chapters: [{ beat: 'a' }] } }, { chapter_number: 31, bridge_from_prior: 'X.' }, { chapter_number: 32, beat: 'C.' }] };
    const out = outlineWithCoda(o, codaDraft()) as { chapters: Record<string, any>[] };
    expect(out.chapters[0].beat).toBe('B. Closing scene: Renata finds the held plot.');
    expect(out.chapters[0].chapter_outline.sub_chapters).toHaveLength(2);
    expect(out.chapters[0].chapter_outline.sub_chapters[1]).toMatchObject({ number: 2, title: 'The Plot Under the Binder' });
    expect(out.chapters[1].bridge_from_prior).toContain('Renata brings Marcus the journal.');
    expect(out.chapters[2]).toEqual(o.chapters[2]);
    // A chapter with no saved chapter outline gets none: rewriting it from just the scene would lose the chapter.
    const bare = outlineWithCoda({ chapters: [{ chapter_number: 30, beat: 'B.' }] }, codaDraft()) as { chapters: Record<string, any>[] };
    expect(bare.chapters[0].chapter_outline).toBeUndefined();
    expect((outlineWithRecap({ chapters: [{ chapter_number: 31, bridge_from_prior: 'X.' }] }, 31) as any).chapters[0].bridge_from_prior).toBe('X. Opens with a spoken recap of the previous book.');
  });
});

describe('closing scene and recap routes', () => {
  it('starts the engine job for a closing scene with the books’ ranges, the author’s direction, and keeps nothing itself', async () => {
    engineJob.mockResolvedValue({ job_id: 'j1', status: 'queued' });
    await withServer(async (base) => {
      const j = await call(base, 'POST', '/series/books/1/coda', { direction: 'season finale' });
      expect(j).toMatchObject({ success: true, jobId: 'j1', engineJob: true });
      expect(engineJob).toHaveBeenCalledWith('chapter', expect.objectContaining({
        op: 'draft-book-coda', async: true, persist: true, direction: 'season finale',
        book: { index: 1, first_chapter: 0, last_chapter: 30 }, next_book: { index: 2, first_chapter: 31, last_chapter: 61 },
      }));
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER);
    });
  });

  it('asks for a recap of the earlier books, and not for the first book', async () => {
    engineJob.mockResolvedValue({ job_id: 'j2', status: 'queued' });
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/series/books/1/recap')).error.code).toBe('FIRST_BOOK');
      await call(base, 'POST', '/series/books/2/recap');
      expect(engineJob).toHaveBeenCalledWith('chapter', expect.objectContaining({
        op: 'draft-book-recap', series_name: 'The Ossuary', book: { index: 2, first_chapter: 31, last_chapter: 61 },
        previous_books: [{ index: 1, first_chapter: 0, last_chapter: 30 }],
      }));
    });
  });

  it('lets the author edit the draft, then applies it after snapshotting the chapter and the outline', async () => {
    seed({ codas: { '1': codaDraft() } });
    await withServer(async (base) => {
      const e = await call(base, 'PUT', '/series/books/1/coda', { text: 'Renata lifted the binder, and the dead were all on the wrong side of the line.' });
      expect(e.data.series.books[0].coda_draft.edited_at).toBeTruthy();
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER); // editing the draft writes nothing to the book
      const j = await call(base, 'POST', '/series/books/1/coda/apply');
      expect(j.success).toBe(true);
      expect(db.published_content_v2[0].content_text).toBe(`${CHAPTER}\n\n---\n\nRenata lifted the binder, and the dead were all on the wrong side of the line.\n`);
      expect(db.content_versions_v2[0]).toMatchObject({ content_text: CHAPTER, changed_by: 'series_coda' });
      expect(db.outline_versions_v2).toHaveLength(1);
      const o = outline();
      expect(o.chapters[0].beat).toContain('Closing scene: Renata finds the held plot.');
      expect(o.chapters[0].chapter_outline.sub_chapters).toHaveLength(2);
      expect(o.chapters[1].bridge_from_prior).toContain('Renata brings Marcus the journal.');
      expect(o._series.codas['1'].applied_at).toBeTruthy();
      expect((await call(base, 'POST', '/series/books/1/coda/apply')).error.code).toBe('ALREADY_APPLIED');
      expect((await call(base, 'PUT', '/series/books/1/coda', { text: 'x'.repeat(50) })).error.code).toBe('ALREADY_APPLIED');
    });
  });

  it('refuses a closing scene written for a chapter that has been edited since', async () => {
    seed({ codas: { '1': codaDraft() } });
    await withServer(async (base) => {
      db.published_content_v2[0].content_text = `${CHAPTER} One more line.`;
      expect((await call(base, 'POST', '/series/books/1/coda/apply')).error.code).toBe('CHAPTER_CHANGED');
      expect(db.content_versions_v2).toHaveLength(0);
      expect(db.outline_versions_v2).toHaveLength(0);
    });
  });

  it('puts a recap at the front of the book’s first chapter under the series name, and notes it in the outline', async () => {
    seed({ recaps: { '2': { content_id: 'c30', base_hash: textHash(CHAPTER), chapter_number: 31, chapter_title: 'Stratum IV', text: 'Sylvia walks the bluff. Marcus holds the report back.', words: 9, sources: 3, new_names: [], drafted_at: 'x' } } });
    await withServer(async (base) => {
      const j = await call(base, 'POST', '/series/books/2/recap/apply');
      expect(j.success).toBe(true);
      expect(db.published_content_v2[0].content_text).toBe(`**Previously, in The Ossuary**\n\nSylvia walks the bluff. Marcus holds the report back.\n\n---\n\n${CHAPTER}`);
      expect(db.content_versions_v2[0]).toMatchObject({ changed_by: 'series_recap' });
      expect(outline().chapters[1].bridge_from_prior).toContain('Opens with a spoken recap');
    });
  });

  it('discards a draft without touching the book', async () => {
    seed({ codas: { '1': codaDraft() } });
    await withServer(async (base) => {
      const j = await call(base, 'DELETE', '/series/books/1/coda');
      expect(j.data.series.books[0].coda_draft).toBeNull();
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER);
    });
  });
});


const statusOf = (base: string, method: string, path: string): Promise<number> =>
  fetch(`${base}/api/publishing/project/p1${path}`, { method }).then((r) => r.status);

describe('closing scene and recap: what QA found', () => {
  it('will not draft over a piece that is already in the book, so it cannot be added twice', async () => {
    seed({ codas: { '1': codaDraft({ applied_at: 'x' }) }, recaps: { '2': { applied_at: 'x' } } });
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/series/books/1/coda')).error.code).toBe('ALREADY_APPLIED');
      expect((await call(base, 'POST', '/series/books/2/recap')).error.code).toBe('ALREADY_APPLIED');
      expect(engineJob).not.toHaveBeenCalled();
    });
  });

  it('changes nothing when the earlier text could not be kept', async () => {
    seed({ codas: { '1': codaDraft() } });
    failing.insert = 'content_versions_v2';
    await withServer(async (base) => {
      expect(await statusOf(base, 'POST', '/series/books/1/coda/apply')).toBe(500);
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER);
      expect(outline()._series.codas['1'].applied_at).toBeUndefined();
    });
  });

  it('changes nothing when the outline’s earlier version could not be kept', async () => {
    seed({ codas: { '1': codaDraft() } });
    failing.insert = 'outline_versions_v2';
    await withServer(async (base) => {
      expect(await statusOf(base, 'POST', '/series/books/1/coda/apply')).toBe(500);
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER);
    });
  });

  it('leaves the chapter alone when the outline cannot be saved', async () => {
    seed({ codas: { '1': codaDraft() } });
    failing.update = 'writing_projects_v2';
    await withServer(async (base) => {
      expect(await statusOf(base, 'POST', '/series/books/1/coda/apply')).toBe(500);
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER);
    });
  });

  it('puts the outline back when the chapter cannot be written, so the two never disagree', async () => {
    seed({ codas: { '1': codaDraft() } });
    const before = JSON.stringify(outline());
    failing.update = 'published_content_v2';
    await withServer(async (base) => {
      expect(await statusOf(base, 'POST', '/series/books/1/coda/apply')).toBe(500);
      expect(db.published_content_v2[0].content_text).toBe(CHAPTER);
      expect(JSON.stringify(outline())).toBe(before);
    });
  });

  it('shows a failed draft’s reason, cannot apply or edit it, and lets the author clear it', async () => {
    seed({ codas: { '1': { failed: 'the scene came back 1700 words twice', drafted_at: 'x' } } });
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/series/books/1/coda/apply')).error.code).toBe('NO_DRAFT');
      expect((await call(base, 'PUT', '/series/books/1/coda', { text: 'x'.repeat(50) })).error.code).toBe('NO_DRAFT');
      const cleared = await call(base, 'DELETE', '/series/books/1/coda');
      expect(cleared.data.series.books[0].coda_draft).toBeNull();
    });
  });
});
