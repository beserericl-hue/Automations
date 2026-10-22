/**
 * KDP pre-flight.
 *
 * The point is to fail in a second rather than after a twenty-minute upload and a rejection that
 * names nothing. Severity is literal: `error` means the upload is refused or the book prints wrong.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildEpub } from '../lib/epub.js';
import { buildPrintPdf } from '../lib/print-pdf.js';
import {
  validateCoverWrap,
  validateEbookCover,
  validateEpub,
  validatePrintPdf,
} from '../lib/kdp-validate.js';

const chapter = { chapter_number: 1, title: 'One', content_text: 'Prose enough to fill a page.', status: 'approved' };
const FIXED = { now: new Date('2026-10-22T12:00:00Z'), bookId: 'urn:uuid:test' };

async function goodEpub(): Promise<Buffer> {
  return buildEpub({ title: 'The Ossuary', author: 'Eric L Beser', chapters: [chapter], ...FIXED });
}
function codes(r: { findings: { code: string }[] }): string[] {
  return r.findings.map((f) => f.code);
}

describe('EPUB', () => {
  it('passes a book this codebase produced', async () => {
    const r = await validateEpub(await goodEpub());
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  it('always says epubcheck was not run, because it was not', async () => {
    // Claiming a clean bill from a validator that is not epubcheck would be the dishonest part.
    const r = await validateEpub(await goodEpub());
    expect(codes(r)).toContain('EPUBCHECK_NOT_RUN');
    expect(r.ok).toBe(true); // a warning, not a failure
  });

  it('catches a compressed mimetype — the classic silent reader failure', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip'); // deflated by default
    zip.file('META-INF/container.xml', '<container/>');
    const bad = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(codes(await validateEpub(bad))).toContain('MIMETYPE_COMPRESSED');
  });

  it('catches a manifest item that is not in the archive', async () => {
    const epub = await goodEpub();
    const zip = await JSZip.loadAsync(epub);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    zip.file('OEBPS/content.opf', opf.replace('nav.xhtml', 'missing-nav.xhtml'));
    const rebuilt = await zip.generateAsync({ type: 'nodebuffer' });
    expect(codes(await validateEpub(rebuilt))).toContain('MANIFEST_MISSING_FILES');
  });

  it('catches a spine pointing at an id that does not exist', async () => {
    const zip = await JSZip.loadAsync(await goodEpub());
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    zip.file('OEBPS/content.opf', opf.replace('<itemref idref="x0"/>', '<itemref idref="ghost"/>'));
    const rebuilt = await zip.generateAsync({ type: 'nodebuffer' });
    expect(codes(await validateEpub(rebuilt))).toContain('SPINE_DANGLING');
  });

  it('rejects a file that reaches out to the internet', async () => {
    const zip = await JSZip.loadAsync(await goodEpub());
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    zip.file(
      'OEBPS/content.opf',
      opf.replace('<manifest>', '<manifest><item id="r" href="https://example.com/a.css" media-type="text/css"/>'),
    );
    const rebuilt = await zip.generateAsync({ type: 'nodebuffer' });
    expect(codes(await validateEpub(rebuilt))).toContain('REMOTE_RESOURCES');
  });

  it('warns when there is no author rather than failing the upload', async () => {
    const r = await validateEpub(
      await buildEpub({ title: 'T', chapters: [chapter], ...FIXED }),
    );
    expect(codes(r)).toContain('NO_CREATOR');
    expect(r.ok).toBe(true);
  });

  it('rejects something that is not a ZIP at all', async () => {
    expect(codes(await validateEpub(Buffer.from('hello')))).toContain('NOT_A_ZIP');
  });
});

describe('print interior', () => {
  const chapters = Array.from({ length: 3 }, (_, i) => ({
    number: i + 1,
    title: `Chapter ${i + 1}`,
    text: Array.from({ length: 30 }, () => 'Sentences enough to make real pages of text.').join('\n\n'),
  }));

  it('passes an interior this codebase produced', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters, trim: '6x9' });
    const v = validatePrintPdf({ pdf: r.pdf, pageCount: r.pageCount, trimWidthIn: 6, trimHeightIn: 9 });
    // Fewer than 24 pages in a test fixture, so only the page-count floor should complain.
    expect(codes(v).filter((c) => c !== 'TOO_FEW_PAGES')).toEqual([]);
  }, 60_000);

  it('catches a page count that disagrees with the page tree', async () => {
    // The failure this exists for: the generator said 51 while the tree said 54, and the spine is
    // computed from that number.
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters, trim: '6x9' });
    const v = validatePrintPdf({ pdf: r.pdf, pageCount: r.pageCount + 3, trimWidthIn: 6, trimHeightIn: 9 });
    expect(codes(v)).toContain('PAGE_COUNT_MISMATCH');
    expect(v.ok).toBe(false);
  }, 60_000);

  it('catches a trim that is not the one asked for', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters, trim: '6x9' });
    const v = validatePrintPdf({ pdf: r.pdf, pageCount: r.pageCount, trimWidthIn: 5, trimHeightIn: 8 });
    expect(codes(v)).toContain('TRIM_MISMATCH');
  }, 60_000);

  it('enforces the 828-page ceiling', () => {
    const v = validatePrintPdf({
      pdf: Buffer.from('%PDF-1.3'), pageCount: 900, trimWidthIn: 6, trimHeightIn: 9,
    });
    expect(codes(v)).toContain('TOO_MANY_PAGES');
  });

  it('requires embedded fonts', () => {
    const v = validatePrintPdf({
      pdf: Buffer.from('%PDF-1.3 no fonts here'), pageCount: 100, trimWidthIn: 6, trimHeightIn: 9,
    });
    expect(codes(v)).toContain('FONTS_NOT_EMBEDDED');
  });
});

describe('covers', () => {
  it('accepts the 1600x2560 ebook cover this codebase makes', () => {
    expect(validateEbookCover(1600, 2560).ok).toBe(true);
  });

  it('warns about a square cover — the original defect', () => {
    expect(codes(validateEbookCover(1024, 1024))).toContain('COVER_RATIO');
  });

  it('rejects a cover too small to use', () => {
    expect(codes(validateEbookCover(600, 960))).toContain('COVER_TOO_SMALL');
  });

  it('accepts a wrap whose arithmetic is right', () => {
    const spine = 610 * 0.002252;
    const v = validateCoverWrap({
      widthIn: 6 * 2 + spine + 0.25, heightIn: 9.25, pageCount: 610,
      trimWidthIn: 6, trimHeightIn: 9, spineIn: spine, bleedIn: 0.125, dpi: 300,
    });
    expect(v.ok, JSON.stringify(v.findings)).toBe(true);
  });

  it('catches a wrap built with the wrong spine', () => {
    const v = validateCoverWrap({
      widthIn: 12.25, heightIn: 9.25, pageCount: 610,
      trimWidthIn: 6, trimHeightIn: 9, spineIn: 610 * 0.002252, bleedIn: 0.125, dpi: 300,
    });
    expect(codes(v)).toContain('WRAP_WIDTH');
  });

  it('rejects a print cover under 300dpi', () => {
    const spine = 610 * 0.002252;
    const v = validateCoverWrap({
      widthIn: 6 * 2 + spine + 0.25, heightIn: 9.25, pageCount: 610,
      trimWidthIn: 6, trimHeightIn: 9, spineIn: spine, bleedIn: 0.125, dpi: 150,
    });
    expect(codes(v)).toContain('WRAP_DPI');
  });
});
