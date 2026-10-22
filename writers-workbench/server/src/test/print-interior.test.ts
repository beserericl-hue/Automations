/**
 * The print interior.
 *
 * The page count this produces is not a statistic — the cover's spine width is computed from it, so
 * a wrong count means re-making every cover. It is asserted against the PDF's own page tree rather
 * than against the generator's bookkeeping, because those disagreed: the tree said 54 while the
 * function returned 51. Headers and folios sit outside the text block, pdfkit paginates whenever
 * text crosses a margin, and the numbering pass was creating pages and then numbering the ones it
 * had just created.
 */

import { describe, it, expect } from 'vitest';
import { buildPrintPdf, gutterInches, paragraphsOf, TRIM_SIZES } from '../lib/print-pdf.js';
import { bookMatter } from '../lib/bookmatter.js';

function prose(paras = 12): string {
  return Array.from(
    { length: paras },
    () =>
      "The gravel gave one sharp crack under the truck's front tire and then went quiet. She did " +
      'not get out. Through the windshield the tree line across the creek was still mostly dark.',
  ).join('\n\n');
}

function chapters(n = 4) {
  return Array.from({ length: n }, (_, i) => ({
    number: i,
    title: i === 0 ? 'Prologue: The Surface' : `Chapter ${i}`,
    text: prose(10) + '\n\n---\n\n' + prose(8),
  }));
}

/** The authoritative count, read from the PDF's own page tree. */
function pagesInTree(pdf: Buffer): number {
  const m = /\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/.exec(pdf.toString('latin1'));
  return m ? Number(m[1]) : -1;
}

describe('the page count is trustworthy', () => {
  it('matches the PDF page tree exactly', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters: chapters(5) });
    expect(r.pageCount).toBe(pagesInTree(r.pdf));
  }, 60_000);

  it('still matches once front and back matter are added', async () => {
    const m = bookMatter({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      dedication: 'For the ones in the ground.',
      authorsNote: 'The four ossuaries are real.',
      aboutTheAuthor: 'He writes from Maryland.',
      volume: { index: 1, total: 3 },
    });
    const r = await buildPrintPdf({
      title: 'The Ossuary',
      author: 'Eric L Beser',
      chapters: chapters(4),
      front: m.front,
      back: m.back,
    });
    expect(r.pageCount).toBe(pagesInTree(r.pdf));
    expect(r.pageCount).toBeGreaterThan(10);
  }, 60_000);
});

describe('KDP print requirements', () => {
  it('writes the requested trim into the MediaBox', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters: chapters(2), trim: '5.5x8.5' });
    const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(r.pdf.toString('latin1'))![1].trim().split(/\s+/);
    expect(Number(box[2]) / 72).toBeCloseTo(TRIM_SIZES['5.5x8.5'].w, 2);
    expect(Number(box[3]) / 72).toBeCloseTo(TRIM_SIZES['5.5x8.5'].h, 2);
  }, 60_000);

  it('falls back to 6x9 for an unknown trim rather than producing a wrong size', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters: chapters(2), trim: 'A4-ish' });
    expect(r.trim).toBe('6x9');
  }, 60_000);

  it('embeds its fonts — an unembedded font is a rejected upload', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters: chapters(2) });
    const raw = r.pdf.toString('latin1');
    expect(raw).toContain('FontFile2');
    expect(raw).toContain('EBGaramond');
  }, 60_000);

  it('grows the gutter with the page count, as KDP requires', () => {
    // The binding eats the inside edge, and eats more of it the thicker the book.
    expect(gutterInches(120)).toBe(0.375);
    expect(gutterInches(300)).toBe(0.5);
    expect(gutterInches(500)).toBe(0.625);
    expect(gutterInches(700)).toBe(0.75);
    expect(gutterInches(820)).toBe(0.875);
  });

  it('uses the gutter for the volume it is actually making', async () => {
    const r = await buildPrintPdf({
      title: 'T', author: 'A', chapters: chapters(2), estimatedPages: 610,
    });
    expect(r.gutterInches).toBe(0.75);
  }, 60_000);

  it('refuses an empty manuscript rather than emitting a cover-less husk', async () => {
    await expect(buildPrintPdf({ title: 'T', author: 'A', chapters: [] })).rejects.toThrow('NO_CHAPTERS');
  });
});

describe('prose conversion', () => {
  it('splits paragraphs and marks scene breaks', () => {
    const got = paragraphsOf('One.\n\nTwo.\n\n---\n\nThree.');
    expect(got.map((b) => b.kind)).toEqual(['p', 'p', 'break', 'p']);
  });

  it('unwraps a hard-wrapped paragraph', () => {
    expect(paragraphsOf('A line\nwrapped here.')[0].text).toBe('A line wrapped here.');
  });

  it('ignores blank blocks', () => {
    expect(paragraphsOf('One.\n\n   \n\nTwo.')).toHaveLength(2);
  });
});
