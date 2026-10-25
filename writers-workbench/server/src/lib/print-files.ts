/**
 * The files RPI prints from, for one edition of one volume: the interior and the cover (or jacket).
 *
 * The interior is the KDP interior, built by the same code, with bleed added when the product is
 * full-bleed. The cover is laid out on the geometry RPI's own template gives for this product at
 * this page count — see rpi-print.ts for why it is read rather than computed.
 */

import { composeCoverWrap } from './cover.js';
import { buildInterior, plannedVolumes, volumeParts, wrapTitling, type VolumeParts } from './kdp-package.js';
import { TRIM_SIZES } from './print-pdf.js';
import {
  RPI_MAX_PAGES,
  RPI_MIN_PAGES,
  coverGeometry,
  rpiPageCount,
  type CoverGeometry,
  type Edition,
} from './rpi-print.js';
import type { BookSource } from './book-source.js';

/** A refusal the author can act on. `code` goes to the client; `message` is shown as written. */
export class PrintFilesError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PrintFiles {
  interior: Buffer;
  outside: Buffer;
  preview: Buffer;
  pageCount: number;
  geometry: CoverGeometry;
  parts: VolumeParts;
  volumeIndex: number;
}

/** The cover as a single-page PDF at exactly the template's size, with the trim marked. */
export async function outsidePdf(png: Buffer, g: CoverGeometry): Promise<Buffer> {
  const sharp = ((await import('sharp')) as unknown as {
    default: (b: Buffer) => { jpeg(o: object): { toBuffer(): Promise<Buffer> } };
  }).default;
  // JPEG inside the PDF: a 300dpi jacket as PNG is tens of megabytes for no visible gain.
  const jpg = await sharp(png).jpeg({ quality: 92 }).toBuffer();
  const { default: PDFDocument } = await import('pdfkit');
  const W = g.widthIn * 72;
  const H = g.heightIn * 72;
  const doc = new PDFDocument({ size: [W, H], margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => doc.on('end', () => r()));
  doc.addPage();
  const dict = doc.page.dictionary.data;
  const e = g.edgeIn * 72;
  dict.TrimBox = [e, e, W - e, H - e];
  dict.BleedBox = [0, 0, W, H];
  doc.image(jpg, 0, 0, { width: W, height: H });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export async function buildPrintFiles(source: BookSource, edition: Edition, volumeIndex: number): Promise<PrintFiles> {
  if (source.settings.trim !== edition.trim) {
    throw new PrintFilesError(
      'TRIM_NOT_OFFERED',
      `Printed copies are ${edition.trim}″; this book is set to ${source.settings.trim}″. Change the trim size above first.`,
    );
  }
  if (!source.art?.length) {
    throw new PrintFilesError('NO_COVER_ART', 'Select cover art for the project first — the cover is built from it.');
  }
  const all = source.chapters.filter((c) => String(c.content_text ?? '').trim());
  if (!all.length) throw new PrintFilesError('NO_CHAPTERS', 'This project has no chapters with text yet.');
  const planned = plannedVolumes(source, all);
  const v = planned.find((p) => p.index === volumeIndex);
  if (!v) throw new PrintFilesError('NO_SUCH_VOLUME', 'That volume is not in the current plan.');
  const parts = volumeParts({ ...source }, planned, all, v);
  if (!parts.rows.length) throw new PrintFilesError('NO_CHAPTERS', 'That volume has no chapters with text.');

  const trim = TRIM_SIZES[edition.trim];
  const interior = await buildInterior({
    title: source.title,
    author: source.author,
    chapters: parts.printChapters,
    matter: parts.matter,
    trim: edition.trim,
    bodySize: source.settings.body_size,
    bleedIn: edition.interiorBleedIn,
  });
  const pages = interior.pageCount;
  if (rpiPageCount(pages) < RPI_MIN_PAGES || rpiPageCount(pages) > RPI_MAX_PAGES) {
    throw new PrintFilesError(
      'PAGE_COUNT',
      `This volume is ${pages} pages; RPI prints ${RPI_MIN_PAGES}–${RPI_MAX_PAGES}. Split it into more volumes, or add to it.`,
    );
  }

  const geometry = await coverGeometry(edition, pages);
  const wrap = await composeCoverWrap({
    art: source.art,
    author: source.author,
    // RPI pads an odd interior with a blank page, and the spine is measured on the padded count.
    pageCount: rpiPageCount(pages),
    trimWidthIn: trim.w,
    trimHeightIn: trim.h,
    blurb: parts.marketing?.back_cover || parts.marketing?.blurb || undefined,
    authorBio: parts.bio || undefined,
    ...wrapTitling(source.title, parts.volume),
    layout: geometry,
    flaps:
      edition.outside === 'jacket'
        ? { front: parts.marketing?.blurb || undefined, back: parts.bio || undefined }
        : undefined,
  });
  if (!wrap) throw new PrintFilesError('COVER_FAILED', 'The cover could not be composed from the selected art.');
  const outside = await outsidePdf(wrap.png, geometry);
  const sharp = ((await import('sharp')) as unknown as {
    default: (b: Buffer) => { resize(w: number): { jpeg(o: object): { toBuffer(): Promise<Buffer> } } };
  }).default;
  const preview = await sharp(wrap.png).resize(1600).jpeg({ quality: 80 }).toBuffer();
  return { interior: interior.pdf, outside, preview, pageCount: pages, geometry, parts, volumeIndex: v.index };
}
