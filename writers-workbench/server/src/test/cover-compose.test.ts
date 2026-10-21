/**
 * Cover composition.
 *
 * Two things went wrong in Apple Books before this existed, and both are asserted here:
 *   - the generated art is SQUARE, so readers letterboxed it into the portrait shelf tile with grey
 *     bars above and below;
 *   - it carried no words, so the shelf showed a picture rather than a book.
 *
 * And one thing went wrong while building it, which is the reason for the glyph guard: opentype.js
 * intermittently emitted a non-finite coordinate (`QNaN 566.95 ...`) on a closing curve. librsvg
 * stops parsing at the bad command, so a single bad glyph silently truncated the whole cover — the
 * first render lost everything after the "O" of OSSUARY, including the author, with no error
 * anywhere. A cover missing letters is worse than no composed cover at all, so the composer refuses
 * rather than shipping one.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { composeCover, splitTitle } from '../lib/cover.js';
import { buildEpub } from '../lib/epub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT = join(HERE, '../../assets/fonts/Raleway-Variable.ttf');

// sharp is typed as a namespace under this module resolution, so the callable form is reached
// through a loose local type — the same shape the composer itself uses.
type SharpFn = (input?: Buffer | Record<string, unknown>) => {
  png(): { toBuffer(): Promise<Buffer> };
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
};

async function loadSharp(): Promise<SharpFn> {
  const mod = (await import('sharp')) as unknown as { default?: SharpFn };
  return (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
}

/** A small square image standing in for generated cover art. */
async function squareArt(): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#7a4a24' } })
    .png()
    .toBuffer();
}

async function dimensions(buf: Buffer) {
  const sharp = await loadSharp();
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, format: m.format };
}

describe('splitTitle', () => {
  it('puts a leading article on its own line, as jackets do', () => {
    expect(splitTitle('The Ossuary')).toEqual({ lead: 'THE', main: 'OSSUARY' });
  });

  it.each(['A Winter Crossing', 'An Ordinary Year'])('handles "%s"', (t) => {
    expect(splitTitle(t).lead).not.toBe('');
  });

  it('leaves a single word alone', () => {
    expect(splitTitle('Ossuary')).toEqual({ lead: '', main: 'OSSUARY' });
  });

  it('does not strip a word that merely starts with "the"', () => {
    expect(splitTitle('Theodore Rising').lead).toBe('');
  });

  it('survives an empty title without throwing', () => {
    expect(splitTitle('')).toEqual({ lead: '', main: '' });
  });
});

describe('the bundled font', () => {
  it('is present, because the container has no system fonts', () => {
    // If this file goes missing the composer silently falls back to raw art, which is exactly the
    // bug this feature exists to fix — so its absence should fail loudly here instead.
    expect(readFileSync(FONT).length).toBeGreaterThan(100_000);
  });
});

describe('composeCover', () => {
  it('turns square art into a portrait cover', async () => {
    const out = await composeCover({ art: await squareArt(), title: 'The Ossuary', author: 'Eric L Beser' });
    expect(out).not.toBeNull();
    const d = await dimensions(out!);
    expect(d.width).toBe(1600);
    expect(d.height).toBe(2560);
    // 1:1.6 — what Books, Kindle and KDP expect. A square cover is the original defect.
    expect(d.height! / d.width!).toBeCloseTo(1.6, 2);
    expect(d.format).toBe('jpeg');
  }, 30_000);

  it('produces a file small enough to ship in a book', async () => {
    // The first hand-built cover was a 13.5MB PNG, which made the book bigger than the manuscript.
    const out = await composeCover({ art: await squareArt(), title: 'The Ossuary', author: 'Eric L Beser' });
    expect(out!.length).toBeLessThan(2_000_000);
  }, 30_000);

  it('renders every glyph or refuses the cover', async () => {
    // The guard that matters: a dropped glyph means a half-drawn jacket, so the composer returns
    // null and the caller falls back to the raw art.
    const out = await composeCover({ art: await squareArt(), title: 'The Ossuary', author: 'Eric L Beser' });
    expect(out, 'composer dropped glyphs — see the NaN guard in cover.ts').not.toBeNull();
  }, 30_000);

  it('works without an author', async () => {
    const out = await composeCover({ art: await squareArt(), title: 'Ossuary' });
    expect(out).not.toBeNull();
  }, 30_000);

  it('handles a long title without running off the edge', async () => {
    const out = await composeCover({
      art: await squareArt(),
      title: 'The Remarkable And Protracted History Of Everything',
      author: 'Eric L Beser',
    });
    expect(out).not.toBeNull();
  }, 30_000);

  it('returns null for empty art rather than throwing', async () => {
    expect(await composeCover({ art: Buffer.alloc(0), title: 'X' })).toBeNull();
  });

  it('returns null for art that is not an image, so an export never fails on the cover', async () => {
    expect(await composeCover({ art: Buffer.from('not an image'), title: 'X' })).toBeNull();
  }, 20_000);
});

describe('the cover reaches the book', () => {
  it('is declared three ways, because readers disagree about which they honour', async () => {
    const cover = await composeCover({ art: await squareArt(), title: 'The Ossuary', author: 'Eric L Beser' });
    const epub = await buildEpub({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      chapters: [{ chapter_number: 1, title: 'One', content_text: 'Prose.', status: 'draft' }],
      cover: { data: cover!, ext: 'jpg' },
      now: new Date('2026-10-20T12:00:00Z'),
      bookId: 'urn:uuid:test',
    });
    const zip = await JSZip.loadAsync(epub);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');

    expect(zip.file('OEBPS/cover.jpg'), 'the image itself').toBeTruthy();
    expect(opf, 'EPUB 3 manifest property').toContain('properties="cover-image"');
    expect(opf, 'legacy EPUB 2 meta, used by some Kindle paths').toContain('<meta name="cover"');
    // And the book opens on it.
    expect(opf.match(/<item id="x0" href="([^"]+)"/)![1]).toBe('cover.xhtml');
    expect(opf).toContain('<dc:creator>Eric L Beser</dc:creator>');
  }, 30_000);

  it('still builds a book when there is no cover at all', async () => {
    const epub = await buildEpub({
      title: 'The Ossuary',
      chapters: [{ chapter_number: 1, title: 'One', content_text: 'Prose.', status: 'draft' }],
      now: new Date('2026-10-20T12:00:00Z'),
      bookId: 'urn:uuid:test',
    });
    const zip = await JSZip.loadAsync(epub);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).not.toContain('cover-image');
    expect(opf.match(/<item id="x0" href="([^"]+)"/)![1]).toBe('title.xhtml');
  });
});
