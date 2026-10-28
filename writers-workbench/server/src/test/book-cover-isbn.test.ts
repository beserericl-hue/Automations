/**
 * The cover the author chose, and the ISBN they typed.
 *
 * Both used to be guesses: the cover was whichever picture was generated last, so trying an idea out
 * replaced the cover, and an ISBN was printed on the copyright page exactly as typed, so a slipped
 * digit reached KDP. These pin the choice and the check.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { coverChoice, findCover } from '../lib/book-cover.js';
import { buildKdpPackage, type PackageSettings } from '../lib/kdp-package.js';
import { assessReadiness, isbnProblem, publishingOf, PUBLISHING_DEFAULTS } from '../routes/publishing.js';

type Row = { id: string; project_id: string; image_type: string; storage_path: string; created_at: string };

/** Just enough of the query builder for findCover: eq filters, newest-first, one row. */
function fakeSupabase(rows: Row[]): SupabaseClient {
  return {
    from: () => {
      const filters: [string, unknown][] = [];
      let newest = false;
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        order: () => {
          newest = true;
          return q;
        },
        limit: () => q,
        maybeSingle: async () => {
          let hit = rows.filter((r) => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
          if (newest) hit = [...hit].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return { data: hit[0] ?? null, error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const P = 'project-1';
const ROWS: Row[] = [
  { id: 'old', project_id: P, image_type: 'cover_art', storage_path: 'a.png', created_at: '2026-10-01T00:00:00Z' },
  { id: 'new', project_id: P, image_type: 'cover_art', storage_path: 'b.png', created_at: '2026-10-20T00:00:00Z' },
  { id: 'two', project_id: P, image_type: 'cover_art', storage_path: 'c.png', created_at: '2026-10-10T00:00:00Z' },
  { id: 'elsewhere', project_id: 'other', image_type: 'cover_art', storage_path: 'd.png', created_at: '2026-10-25T00:00:00Z' },
];

const outlineWith = (p: Record<string, unknown>) => ({ _publishing: { ...PUBLISHING_DEFAULTS, ...p } });

describe('which picture is the cover', () => {
  it('is the newest cover art when nothing is chosen — and says it was not chosen', async () => {
    const c = await findCover(fakeSupabase(ROWS), P, {});
    expect(c).toMatchObject({ id: 'new', chosen: false });
  });

  it('is the chosen picture, however old', async () => {
    const c = await findCover(fakeSupabase(ROWS), P, outlineWith({ cover_image_id: 'old' }));
    expect(c).toMatchObject({ id: 'old', chosen: true });
  });

  it("is a book's own picture in a series, and the series picture for a book without one", async () => {
    const outline = outlineWith({ cover_image_id: 'old', cover_image_ids: { '2': 'two' } });
    expect((await findCover(fakeSupabase(ROWS), P, outline, 2))?.id).toBe('two');
    expect((await findCover(fakeSupabase(ROWS), P, outline, 1))?.id).toBe('old');
    expect((await findCover(fakeSupabase(ROWS), P, outline))?.id).toBe('old');
  });

  it('never takes a picture from another project, even when its id is stored', async () => {
    const c = await findCover(fakeSupabase(ROWS), P, outlineWith({ cover_image_id: 'elsewhere' }));
    expect(c).toMatchObject({ id: 'new', chosen: false });
  });

  it('falls back rather than leaving the book bare when the chosen picture was deleted', async () => {
    const c = await findCover(fakeSupabase(ROWS), P, outlineWith({ cover_image_id: 'gone' }));
    expect(c?.id).toBe('new');
  });

  it('reads the stored choice, ignoring junk', () => {
    expect(coverChoice(outlineWith({ cover_image_id: 'x', cover_image_ids: { '1': 'y', '2': '', '3': 7 } }))).toEqual({
      default: 'x',
      books: { '1': 'y' },
    });
    expect(coverChoice(null)).toEqual({ default: null, books: {} });
  });

  it('keeps the stored choices separate from the defaults object', () => {
    const a = publishingOf(outlineWith({ cover_image_ids: { '1': 'y' } }));
    a.cover_image_ids['2'] = 'z';
    expect(PUBLISHING_DEFAULTS.cover_image_ids).toEqual({});
  });
});

describe('the ISBN check', () => {
  it.each([
    ['978-0-306-40615-7'],
    ['9780306406157'],
    ['979-8-88888-888-0'.replace(/0$/, String(checkDigit13('979888888888')))],
    ['0-306-40615-2'],
    ['080442957X'],
    [''],
  ])('accepts %s', (isbn) => {
    expect(isbnProblem(isbn)).toBeNull();
  });

  it('catches a slipped digit by the check digit', () => {
    expect(isbnProblem('978-0-306-40615-8')).toMatch(/check digit/);
    expect(isbnProblem('0-306-40615-3')).toMatch(/check digit/);
  });

  it('says what an ISBN looks like when it is not one', () => {
    expect(isbnProblem('12345')).toMatch(/13 digits/);
    expect(isbnProblem('1230306406157')).toMatch(/978 or 979/);
  });

  it('blocks the upload on a bad ISBN, but a missing one only costs a gap', () => {
    const base = {
      outline: {
        _publishing: { ...PUBLISHING_DEFAULTS, isbns: { '1': '978-0-306-40615-8' } },
        _volume_plan: { volume_count: 1, volumes: [{ index: 1 }] },
        _marketing: { blurb: 'A box arrives.', keywords: ['a'], categories: ['c'] },
      },
      chapterCount: 10,
      authorName: 'A',
      authorBio: 'B',
      hasCoverArt: true,
    };
    expect(assessReadiness(base).blockers.some((b) => b.includes('check digit'))).toBe(true);
    const missing = { ...base, outline: { ...base.outline, _publishing: { ...PUBLISHING_DEFAULTS } } };
    expect(assessReadiness(missing).blockers.some((b) => /ISBN/.test(b))).toBe(false);
  });

  it('notes a cover that was never chosen, without blocking', () => {
    const v = assessReadiness({
      outline: { _publishing: { ...PUBLISHING_DEFAULTS }, _marketing: { blurb: 'x' } },
      chapterCount: 10,
      authorName: 'A',
      authorBio: 'B',
      hasCoverArt: true,
      coverChosen: false,
    });
    expect(v.gaps.some((g) => g.startsWith('cover not chosen'))).toBe(true);
    expect(v.blockers.some((b) => /cover/.test(b))).toBe(false);
  });
});

function checkDigit13(twelve: string): number {
  const sum = [...twelve].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

describe("each book's own cover in the package", () => {
  it('builds a book from its own picture, and only that book', async () => {
    const mod = (await import('sharp')) as unknown as { default?: unknown };
    const sharp = (mod.default ?? mod) as (o: Record<string, unknown>) => {
      png: () => { toBuffer: () => Promise<Buffer> };
    };
    const art = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#24507a' } })
      .png()
      .toBuffer();
    const settings: PackageSettings = {
      trim: '6x9',
      paper: 'cream',
      publisher: '',
      isbns: {},
      dedication: '',
      epigraph: '',
      epigraph_attribution: '',
      authors_note: '',
      acknowledgements: '',
      body_size: 11,
    };
    const text = Array.from({ length: 8 }, () => 'The water under the trees moved without a sound. '.repeat(12)).join('\n\n');
    const pkg = await buildKdpPackage({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      authorBio: '',
      chapters: Array.from({ length: 4 }, (_, i) => ({
        chapter_number: i + 1,
        title: `Chapter ${i + 1}`,
        content_text: text,
        status: 'approved',
      })),
      settings,
      volumes: [
        { index: 1, first_chapter: 1, last_chapter: 2 },
        { index: 2, first_chapter: 3, last_chapter: 4 },
      ],
      // No series picture: book 2 has its own, book 1 has none.
      art: null,
      artByVolume: { '2': art },
    });
    const noCover = pkg.errors.filter((e) => /no cover art/.test(e));
    expect(noCover.some((e) => e.includes('volume-1'))).toBe(true);
    expect(noCover.some((e) => e.includes('volume-2'))).toBe(false);
  }, 180_000);
});
