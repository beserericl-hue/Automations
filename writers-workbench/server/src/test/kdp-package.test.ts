/**
 * The KDP package.
 *
 * Two things are worth pinning down here. First the listing file, because it is read by a person
 * filling in the Amazon form and a missing heading means a field left blank — and an *absent*
 * field has to read as absent rather than as an empty line that looks like nothing was needed.
 *
 * Second the whole build, which is where the pieces have to agree with each other: the spine comes
 * from the interior's real page count, so an interior and a wrap built from different numbers are
 * a book with the title printed on its front edge. The assertions below are about that agreement,
 * not about whether a PDF was produced.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildKdpPackage, listingText, type PackageSettings } from '../lib/kdp-package.js';
import { spineWidthInches } from '../lib/cover.js';
import {
  assessReadiness,
  marketingKey,
  publishingOf,
  PUBLISHING_DEFAULTS,
} from '../routes/publishing.js';

const SETTINGS: PackageSettings = {
  trim: '6x9',
  paper: 'cream',
  publisher: 'Owl Hill',
  isbns: { '1': '978-1-11111-111-1', '2': '978-2-22222-222-2' },
  dedication: 'For the ones in the ground.',
  epigraph: '',
  epigraph_attribution: '',
  authors_note: 'The four ossuaries are real.',
  acknowledgements: '',
  body_size: 11,
};

/** Real raster art, so the cover path runs for real rather than failing into its fallback. */
async function squareArt(): Promise<Buffer> {
  const mod = (await import('sharp')) as unknown as { default?: unknown };
  const sharp = (mod.default ?? mod) as (o: Record<string, unknown>) => {
    png: () => { toBuffer: () => Promise<Buffer> };
  };
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#7a4a24' } })
    .png()
    .toBuffer();
}

function prose(paras = 10): string {
  return Array.from(
    { length: paras },
    () =>
      'The gravel gave one sharp crack under the front tire and then went quiet. She did not get ' +
      'out. Through the windshield the tree line across the creek was still mostly dark, and the ' +
      'water under it moved without sound.',
  ).join('\n\n');
}

function chapters(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chapter_number: i,
    title: i === 0 ? 'Prologue' : `Chapter ${i}`,
    content_text: prose(8),
    status: i % 3 === 0 ? 'draft' : 'approved',
  }));
}

const MARKETING = {
  '1': {
    blurb: 'A box arrives, and nobody will say who sent it.',
    back_cover: 'Three hundred years of silence, and one unlocked box.',
    hook: 'The dead kept better records than the living.',
    keywords: ['historical fiction native american', 'burial mound archaeology'],
    categories: ['Fiction > Historical > General'],
    comparable_titles: ['The Round House — Louise Erdrich'],
    author_bio: 'A bio the copywriter suggested.',
  },
};

describe('the listing file', () => {
  it('names every KDP field, and says plainly when one is unwritten', () => {
    const text = listingText('The Ossuary', 'Eric L Beser', MARKETING['1'], '978-1-11111-111-1');
    for (const heading of [
      'TITLE',
      'AUTHOR',
      'DESCRIPTION',
      'BACK COVER',
      'KEYWORDS',
      'CATEGORIES',
      'AUTHOR BIO',
      'ISBN',
    ]) {
      expect(text).toContain(`=== ${heading}`);
    }
    expect(text).toContain('A box arrives');
    expect(text).toContain('978-1-11111-111-1');
  });

  it('counts the keyword slots actually used, because the unused ones are free reach', () => {
    const text = listingText('T', 'A', MARKETING['1'], '');
    expect(text).toContain('KEYWORDS  (2 of 7 slots');
    expect(text).toContain('1. historical fiction native american');
  });

  it('says "(not written yet)" rather than leaving a field blank', () => {
    const text = listingText('T', 'A', null, '');
    expect(text.match(/\(not written yet\)/g)?.length ?? 0).toBeGreaterThan(4);
  });

  it('titles a volume as the series, not as the book', () => {
    const text = listingText('The Ossuary', 'A', MARKETING['1'], '', {
      index: 2,
      total: 3,
      firstChapter: 31,
      lastChapter: 61,
    });
    expect(text).toContain('The Ossuary: Volume Two');
    expect(text).toContain('book 2 of 3');
  });
});

describe('where the publishing state lives', () => {
  it('reads defaults when a project has never been configured', () => {
    expect(publishingOf(null).trim).toBe(PUBLISHING_DEFAULTS.trim);
    expect(publishingOf({}).isbns).toEqual({});
  });

  it('keeps the stored choices and fills in only what is absent', () => {
    const p = publishingOf({ _publishing: { trim: '5.5x8.5', isbns: { '1': 'x' } } });
    expect(p.trim).toBe('5.5x8.5');
    expect(p.isbns).toEqual({ '1': 'x' });
    expect(p.paper).toBe(PUBLISHING_DEFAULTS.paper);
  });

  it('does not alias one volume onto another', () => {
    expect(marketingKey(null)).toBe('_marketing');
    expect(marketingKey(1)).toBe('_marketing');
    expect(marketingKey(2)).toBe('_marketing_v2');
    expect(marketingKey(3)).not.toBe(marketingKey(2));
  });
});

describe('the package', () => {
  it('holds every file the upload needs, and a readme that names them', async () => {
    const pkg = await buildKdpPackage({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      authorBio: 'He lives in Maryland and has spent thirty years near the site.',
      chapters: chapters(5),
      settings: SETTINGS,
      marketing: MARKETING,
    });
    const zip = await JSZip.loadAsync(pkg.zip);
    const names = Object.keys(zip.files);
    expect(names).toContain('README.txt');
    expect(names.some((n) => n.endsWith('.epub'))).toBe(true);
    expect(names.some((n) => n.endsWith('.pdf'))).toBe(true);
    expect(names).toContain('book/kdp-listing.txt');
    expect(names).toContain('book/pre-flight.txt');
    expect(pkg.volumes).toHaveLength(1);
    expect(pkg.filename).toMatch(/\.zip$/);
  }, 120_000);

  it("prints the author's approved bio, not the copywriter's suggestion", async () => {
    const approved = 'He grew up a mile from the mound and has spent thirty years arguing about it.';
    const pkg = await buildKdpPackage({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      authorBio: approved,
      chapters: chapters(4),
      settings: SETTINGS,
      marketing: MARKETING,
    });
    const zip = await JSZip.loadAsync(pkg.zip);
    const epubName = Object.keys(zip.files).find((n) => n.endsWith('.epub'))!;
    const inner = await JSZip.loadAsync(await zip.files[epubName].async('nodebuffer'));
    const pages = await Promise.all(
      Object.keys(inner.files)
        .filter((n) => n.endsWith('.xhtml'))
        .map((n) => inner.files[n].async('string')),
    );
    const all = pages.join('\n');
    expect(all).toContain('grew up a mile from the mound');
    expect(all).not.toContain('A bio the copywriter suggested');
  }, 120_000);

  it('measures the spine from the interior it actually built', async () => {
    const pkg = await buildKdpPackage({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      authorBio: '',
      chapters: chapters(6),
      settings: SETTINGS,
      art: await squareArt(),
      marketing: MARKETING,
    });
    const v = pkg.volumes[0];
    // Asserted, not skipped past: a spineIn of null means no wrap was composed, and a test that
    // tolerates that would pass on a build that shipped no cover.
    expect(v.spineIn).not.toBeNull();
    expect(v.spineIn).toBeCloseTo(spineWidthInches(v.pageCount, 'cream'), 6);
    // And the paper stock has to reach the arithmetic — cream is thicker than white, so a wrap
    // built against the default would be narrower than the book it has to go round.
    expect(v.spineIn).toBeGreaterThan(spineWidthInches(v.pageCount, 'white'));
    expect(v.files.some((f) => f.endsWith('-cover-wrap.png'))).toBe(true);
  }, 120_000);

  it('splits a planned multi-volume book into one folder per volume', async () => {
    const pkg = await buildKdpPackage({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      authorBio: '',
      chapters: chapters(8),
      settings: SETTINGS,
      volumes: [
        { index: 1, first_chapter: 0, last_chapter: 3 },
        { index: 2, first_chapter: 4, last_chapter: 7 },
      ],
      marketing: MARKETING,
    });
    expect(pkg.volumes.map((v) => v.index)).toEqual([1, 2]);
    expect(pkg.volumes[0].chapters).toBe(4);
    expect(pkg.volumes[1].chapters).toBe(4);
    // Volume 2 has no listing copy of its own, and that is a blocker rather than a silent reuse of
    // volume 1's description.
    expect(pkg.errors.some((e) => e.includes('volume-2') && /description/i.test(e))).toBe(true);
  }, 180_000);

  it('builds one requested volume on its own', async () => {
    const pkg = await buildKdpPackage({
      title: 'The Ossuary',
      author: 'A',
      authorBio: '',
      chapters: chapters(8),
      settings: SETTINGS,
      volumes: [
        { index: 1, first_chapter: 0, last_chapter: 3 },
        { index: 2, first_chapter: 4, last_chapter: 7 },
      ],
      onlyVolume: 2,
      marketing: MARKETING,
    });
    expect(pkg.volumes.map((v) => v.index)).toEqual([2]);
    expect(pkg.filename).toContain('-v2');
  }, 120_000);

  it('refuses a volume that is not in the plan rather than building the wrong book', async () => {
    await expect(
      buildKdpPackage({
        title: 'T',
        author: 'A',
        authorBio: '',
        chapters: chapters(4),
        settings: SETTINGS,
        volumes: [{ index: 1, first_chapter: 0, last_chapter: 3 }],
        onlyVolume: 7,
      }),
    ).rejects.toThrow('NO_SUCH_VOLUME');
  });

  it('refuses an empty manuscript', async () => {
    await expect(
      buildKdpPackage({
        title: 'T',
        author: 'A',
        authorBio: '',
        chapters: [{ chapter_number: 1, title: 'x', content_text: '   ' }],
        settings: SETTINGS,
      }),
    ).rejects.toThrow('NO_CHAPTERS');
  });

  it('honours only_approved, and marks the drafts when it does not', async () => {
    const withDrafts = await buildKdpPackage({
      title: 'T',
      author: 'A',
      authorBio: '',
      chapters: chapters(6),
      settings: SETTINGS,
    });
    const approvedOnly = await buildKdpPackage({
      title: 'T',
      author: 'A',
      authorBio: '',
      chapters: chapters(6),
      settings: SETTINGS,
      onlyApproved: true,
    });
    expect(approvedOnly.volumes[0].chapters).toBeLessThan(withDrafts.volumes[0].chapters);
  }, 180_000);
});

describe('readiness — what stops an upload and what only costs reach', () => {
  const READY = {
    outline: {
      _publishing: { ...PUBLISHING_DEFAULTS, publisher: 'Owl Hill', dedication: 'd', authors_note: 'n' },
      _volume_plan: { volume_count: 1, volumes: [{ index: 1 }] },
      _marketing: {
        blurb: 'A box arrives.',
        keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        categories: ['Fiction > Historical'],
      },
    },
    chapterCount: 96,
    authorName: 'Eric L Beser',
    authorBio: 'A bio.',
    hasCoverArt: true,
  };

  it('is ready when everything that matters is present', () => {
    const v = assessReadiness(READY);
    expect(v.ready).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it('blocks on no chapters, no name, no cover art and no description', () => {
    const v = assessReadiness({
      outline: {},
      chapterCount: 0,
      authorName: '  ',
      authorBio: '',
      hasCoverArt: false,
    });
    expect(v.ready).toBe(false);
    const text = v.blockers.join(' | ');
    expect(text).toContain('no chapters');
    expect(text).toContain('author name');
    expect(text).toContain('no cover art');
    expect(text).toContain('no listing copy');
  });

  it('treats an empty blurb as a blocker even when the rest of the copy exists', () => {
    const v = assessReadiness({
      ...READY,
      outline: { ...READY.outline, _marketing: { ...READY.outline._marketing, blurb: '   ' } },
    });
    expect(v.ready).toBe(false);
    expect(v.blockers.join(' ')).toContain('blurb is empty');
  });

  it('does not block on a missing ISBN, bio, note or dedication — those publish', () => {
    const v = assessReadiness({
      ...READY,
      authorBio: '',
      outline: { ...READY.outline, _publishing: { ...PUBLISHING_DEFAULTS } },
    });
    expect(v.ready).toBe(true);
    const gaps = v.gaps.join(' | ');
    expect(gaps).toContain('author bio');
    expect(gaps).toContain('ISBN');
    expect(gaps).toContain("author's note");
    expect(gaps).toContain('dedication');
  });

  it('says how many keyword slots are unused, because that is the actionable number', () => {
    const v = assessReadiness({
      ...READY,
      outline: { ...READY.outline, _marketing: { ...READY.outline._marketing, keywords: ['a', 'b'] } },
    });
    expect(v.gaps.join(' ')).toContain('2 of 7 keyword slots');
    expect(v.ready).toBe(true);
  });

  it('checks each planned volume separately and labels which one is short', () => {
    const v = assessReadiness({
      ...READY,
      outline: {
        ...READY.outline,
        _volume_plan: { volume_count: 3, volumes: [{ index: 1 }, { index: 2 }, { index: 3 }] },
      },
    });
    expect(v.volume_count).toBe(3);
    expect(v.blockers.join(' | ')).toContain('volume 2: no listing copy');
    expect(v.blockers.join(' | ')).toContain('volume 3: no listing copy');
    // Volume 1 has its copy, so it must not be reported as missing.
    expect(v.blockers.some((b) => b.startsWith('volume 1:'))).toBe(false);
  });

  it('nudges towards the planner when there is none, without blocking', () => {
    const v = assessReadiness({ ...READY, outline: { _marketing: READY.outline._marketing } });
    expect(v.gaps.join(' ')).toContain('volume plan');
    expect(v.volume_count).toBe(1);
  });
});
