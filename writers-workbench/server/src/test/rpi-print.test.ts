/**
 * RPI Print: the parts that decide whether a printed book comes out right.
 *
 * Asserted: the cover geometry is read from RPI's template labels and refused when its parts do not
 * add up; a webhook is accepted only with RPI's signature over the exact bytes; a full-bleed
 * interior carries a TrimBox on every page, including the pages pdfkit adds by itself; chapters
 * open on a recto however their paragraphs break; and the author line on a back cover is whole
 * sentences.
 */
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { parseTemplateGeometry, rpiPageCount, verifyWebhook } from '../lib/rpi-print.js';
import { buildPrintPdf } from '../lib/print-pdf.js';
import { leadingSentences } from '../lib/cover.js';
import { outsidePdf } from '../lib/print-files.js';

// The labels as RPI's templates print them (IDML story text, 592 pages).
const SOFTCOVER =
  'Back Cover Front Cover Spine 1. Full Cover: 13.750&quot; × 9.250&quot; 2. Cover Bleed: 0.125&quot; ' +
  '3. Cover Safe Zone: 5.500&quot; × 8.500&quot; 6. Spine: 1.500&quot; 4. Front Cover: 6.000&quot; × 9.000&quot; ' +
  '5. Back Cover: 6.000&quot; × 9.000&quot; 8. Spine Safe: 1.375&quot;';
const HARDCOVER =
  '1. Full Cover: 15.593" × 10.750" 2. Cover Bleed: 0.750" 3. Cover Safe Zone: 5.750" × 8.750" ' +
  '6. Spine: 1.593" 4. Front Cover: 6.250" × 9.250" 5. Back Cover: 6.250" × 9.250" 8. Spine Safe: 1.468"';
const JACKET =
  '1. Full Jacket: 21.852" × 9.500" 2. Jacket Bleed: 0.125" 3. Jacket Safe Zone: 5.750" × 8.750" ' +
  '6. Spine: 1.789" 4. Front Cover: 6.250" × 9.250" 5. Back Cover: 6.250" × 9.250" ' +
  '9. Left Flap: 3.656" 10. Right Flap: 3.656" 8. Spine Safe: 1.664" 11. Barcode';

describe('cover geometry from the template', () => {
  it('reads a softcover, a case-bound cover and a dust jacket', () => {
    expect(parseTemplateGeometry(SOFTCOVER)).toEqual({
      widthIn: 13.75, heightIn: 9.25, edgeIn: 0.125, panelWIn: 6, panelHIn: 9, spineIn: 1.5, flapIn: 0,
    });
    expect(parseTemplateGeometry(HARDCOVER)).toMatchObject({ edgeIn: 0.75, panelWIn: 6.25, spineIn: 1.593, flapIn: 0 });
    expect(parseTemplateGeometry(JACKET)).toMatchObject({ widthIn: 21.852, spineIn: 1.789, flapIn: 3.656 });
  });

  it('does not take "Spine Safe" for the spine', () => {
    const swapped = SOFTCOVER.replace('6. Spine: 1.500&quot;', '') + ' 6. Spine: 1.500&quot;';
    expect(parseTemplateGeometry(swapped).spineIn).toBe(1.5);
  });

  it('refuses a template whose parts do not add up to the whole', () => {
    expect(() => parseTemplateGeometry(SOFTCOVER.replace('Spine: 1.500', 'Spine: 1.200'))).toThrow('TEMPLATE_DOES_NOT_ADD_UP');
    expect(() => parseTemplateGeometry('Back Cover Front Cover')).toThrow('TEMPLATE_UNREADABLE');
  });

  it('measures an odd interior as RPI pads it', () => {
    expect(rpiPageCount(593)).toBe(594);
    expect(rpiPageCount(592)).toBe(592);
  });
});

describe('webhook signature', () => {
  const secret = 'e1e6-test-secret';
  const body = Buffer.from('{"source":"OrderShipped","data":{"order":{"customerOrderId":"ww-1"}}}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');

  it('accepts RPI’s signature over the exact bytes', () => {
    expect(verifyWebhook(body, sig, secret)).toBe(true);
  });

  it('refuses a changed body, a wrong secret, and a missing header or secret', () => {
    expect(verifyWebhook(Buffer.from(body.toString().replace('Shipped', 'Cancelled')), sig, secret)).toBe(false);
    expect(verifyWebhook(body, sig, 'other')).toBe(false);
    expect(verifyWebhook(body, undefined, secret)).toBe(false);
    expect(verifyWebhook(body, sig, undefined)).toBe(false);
  });
});

/** Page dictionaries in pdfkit's output, in order, as raw text. pdfkit writes them uncompressed. */
function pageDicts(pdf: Buffer): string[] {
  return pdf.toString('latin1').match(/<<\n\/Type \/Page\n[\s\S]*?\n>>/g) ?? [];
}

describe('interior', () => {
  // Long paragraphs, so that pdfkit continues them on pages it adds by itself.
  const para = 'The terrace held. '.repeat(260);
  const chapters = [1, 2, 3, 4].map((n) => ({ number: n, title: `Chapter ${n}`, text: `${para}\n\n${para}` }));

  it('puts a TrimBox on every page of a full-bleed interior', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters, trim: '6x9', bleedIn: 0.125 });
    const dicts = pageDicts(r.pdf);
    expect(dicts.length).toBe(r.pageCount);
    expect(r.pageCount).toBeGreaterThan(8);
    // 6.25 x 9.25 in media, trimmed 9pt in on every side.
    for (const d of dicts) {
      expect(d).toContain('/MediaBox [0 0 450 666]');
      expect(d).toContain('/TrimBox [9 9 441 657]');
    }
  });

  it('a KDP interior stays at the trim with no boxes added', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters, trim: '6x9' });
    const dicts = pageDicts(r.pdf);
    expect(dicts.every((d) => d.includes('/MediaBox [0 0 432 648]') && !d.includes('/TrimBox'))).toBe(true);
  });

  it('opens every chapter on a recto even when paragraphs run onto pages pdfkit adds', async () => {
    const r = await buildPrintPdf({ title: 'T', author: 'A', chapters, trim: '6x9' });
    // Page labels for the chapter openers: pdfkit writes each text run as hex glyph ids, so find
    // the openers through the page count instead — every chapter's pages, with a blank verso
    // before an opener when needed, make the total even per chapter.
    const perChapter = await buildPrintPdf({ title: 'T', author: 'A', chapters: chapters.slice(0, 1), trim: '6x9' });
    const pagesOfOne = perChapter.pageCount;
    // Four identical chapters, each starting on a recto: (pages rounded up to even) x 3 + pages.
    const even = pagesOfOne % 2 === 0 ? pagesOfOne : pagesOfOne + 1;
    expect(r.pageCount).toBe(even * 3 + pagesOfOne);
  });
});

describe('author line on the back cover', () => {
  it('takes whole sentences that fit, never a cut word', () => {
    const bio = 'He lives in Maryland. He wrote two books about archives and the people in them. He sails.';
    expect(leadingSentences(bio, 30)).toBe('He lives in Maryland.');
    expect(leadingSentences(bio, 85)).toBe('He lives in Maryland. He wrote two books about archives and the people in them.');
    expect(leadingSentences('One very long sentence with no end in sight at all.', 10)).toBe('');
  });
});

describe('cover PDF', () => {
  it('is one page at the template size, trimmed at the edge, with the image’s rendering intent set', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#130c07' } }).png().toBuffer();
    const pdf = (await outsidePdf(png, { widthIn: 13.75, heightIn: 9.25, edgeIn: 0.125, panelWIn: 6, panelHIn: 9, spineIn: 1.5, flapIn: 0 })).toString('latin1');
    expect(pdf).toContain('/MediaBox [0 0 990 666]');
    expect(pdf).toContain('/TrimBox [9 9 981 657]');
    expect(pdf).toMatch(/\/Subtype \/Image[\s\S]*?\/Intent \/RelativeColorimetric/);
  });
});
