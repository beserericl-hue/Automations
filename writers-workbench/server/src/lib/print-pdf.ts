/**
 * The print interior: a KDP-ready PDF of one volume.
 *
 * This is the file a printer reads, and print is unforgiving in ways a screen is not:
 *
 *  - **The gutter is not the margin.** The inside edge is bound, so part of it disappears into the
 *    spine. KDP's required inside margin grows with page count — 0.375" under 150 pages, 0.875"
 *    past 600 — and a 600-page volume typeset with equal margins has its inside column swallowed.
 *    So margins are asymmetric and MIRRORED: wide on the inside, which is the left on a recto and
 *    the right on a verso.
 *  - **A chapter opens on a recto.** Right-hand page, always, which means a blank verso whenever
 *    the previous chapter ended on one. Those blanks are real pages and they are why an estimate
 *    and a generated interior never quite agree.
 *  - **Fonts must be embedded.** pdfkit embeds the TTF it is given, which is why the body face
 *    ships with the server rather than being named and hoped for.
 *  - **Page numbers and running heads belong on the body, not on front matter**, and never on a
 *    blank or a chapter opener.
 *
 * The page count this returns is authoritative. The spine width of the cover is computed from it,
 * so it has to be the count the printer will see, not an estimate — which is the whole reason this
 * generates the interior before anything makes a cover.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { MatterSection } from './bookmatter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIRS = [join(HERE, '../assets/fonts'), join(HERE, '../../assets/fonts')];

const POINTS_PER_INCH = 72;

/** Trim sizes KDP offers, in inches. */
export const TRIM_SIZES: Record<string, { w: number; h: number }> = {
  '5x8': { w: 5, h: 8 },
  '5.06x7.81': { w: 5.06, h: 7.81 },
  '5.25x8': { w: 5.25, h: 8 },
  '5.5x8.5': { w: 5.5, h: 8.5 },
  '6x9': { w: 6, h: 9 },
  '6.14x9.21': { w: 6.14, h: 9.21 },
  '6.69x9.61': { w: 6.69, h: 9.61 },
  '7x10': { w: 7, h: 10 },
  '8.5x11': { w: 8.5, h: 11 },
};

/**
 * KDP's minimum inside (gutter) margin, by page count. Inches.
 *
 * These are requirements, not suggestions — an interior under them is rejected at upload. The
 * binding eats the inside edge, and it eats more of it the thicker the book.
 */
export function gutterInches(pageCount: number): number {
  if (pageCount <= 150) return 0.375;
  if (pageCount <= 300) return 0.5;
  if (pageCount <= 500) return 0.625;
  if (pageCount <= 700) return 0.75;
  return 0.875;
}

export const OUTSIDE_MARGIN_IN = 0.5;
export const TOP_MARGIN_IN = 0.6;
export const BOTTOM_MARGIN_IN = 0.65;

export interface PrintChapter {
  number: number | null;
  title: string | null;
  text: string | null;
}

export interface PrintPdfOptions {
  title: string;
  author: string;
  chapters: PrintChapter[];
  front?: MatterSection[];
  back?: MatterSection[];
  trim?: string;
  /** Used only to pick the gutter. The true count is returned. */
  estimatedPages?: number;
  bodySize?: number;
  leading?: number;
}

export interface PrintPdfResult {
  pdf: Buffer;
  /** Authoritative. The cover's spine width is computed from this. */
  pageCount: number;
  trim: string;
  gutterInches: number;
}

const SCENE_BREAK = /^-{3,}$/;

function loadFont(file: string): Buffer {
  for (const dir of FONT_DIRS) {
    try {
      return readFileSync(join(dir, file));
    } catch {
      /* next */
    }
  }
  throw new Error(`font not found: ${file}`);
}

/** Plain manuscript prose -> paragraphs and scene breaks. */
export function paragraphsOf(text: string): { kind: 'p' | 'break'; text: string }[] {
  const out: { kind: 'p' | 'break'; text: string }[] = [];
  for (const raw of (text || '').split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    if (SCENE_BREAK.test(block)) out.push({ kind: 'break', text: '' });
    else out.push({ kind: 'p', text: block.replace(/\s*\n\s*/g, ' ') });
  }
  return out;
}

/** Strip the inline markers the manuscript uses; pdfkit has no inline styling in flowed text. */
function plain(s: string): string {
  return s.replace(/\*(\S|\S[^*\n]*\S)\*/g, '$1');
}

export async function buildPrintPdf(opts: PrintPdfOptions): Promise<PrintPdfResult> {
  const trimName = opts.trim && TRIM_SIZES[opts.trim] ? opts.trim : '6x9';
  const trim = TRIM_SIZES[trimName];
  const bodySize = opts.bodySize ?? 11;
  const leading = opts.leading ?? bodySize * 1.32;
  const chapters = (opts.chapters || []).filter((c) => (c.text || '').trim());
  if (!chapters.length) throw new Error('NO_CHAPTERS');

  const gutter = gutterInches(opts.estimatedPages ?? 400);
  const pageW = trim.w * POINTS_PER_INCH;
  const pageH = trim.h * POINTS_PER_INCH;
  const topM = TOP_MARGIN_IN * POINTS_PER_INCH;
  const botM = BOTTOM_MARGIN_IN * POINTS_PER_INCH;
  const insideM = gutter * POINTS_PER_INCH;
  const outsideM = OUTSIDE_MARGIN_IN * POINTS_PER_INCH;
  const textW = pageW - insideM - outsideM;

  const { default: PDFDocument } = await import('pdfkit');
  const serif = loadFont('EBGaramond-Variable.ttf');
  const sans = loadFont('Raleway-Variable.ttf');

  const doc = new PDFDocument({
    size: [pageW, pageH],
    margins: { top: topM, bottom: botM, left: insideM, right: outsideM },
    autoFirstPage: false,
    bufferPages: true,
    info: { Title: opts.title, Author: opts.author },
  });
  doc.registerFont('body', serif);
  doc.registerFont('display', sans);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  let physical = 0; // pages emitted so far
  // Which pages carry a running head and a folio. Front matter and blanks do not, and a chapter
  // opener does not — a page number under a chapter title is a manuscript, not a book.
  const bodyPages = new Set<number>();

  const isRecto = () => physical % 2 === 1; // page 1 is a recto

  function newPage(): void {
    doc.addPage();
    physical += 1;
    // Mirrored margins: the gutter is on the left of a recto and the right of a verso.
    if (isRecto()) doc.page.margins.left = insideM, (doc.page.margins.right = outsideM);
    else doc.page.margins.left = outsideM, (doc.page.margins.right = insideM);
  }

  /** Start a page that must be on the right-hand side, leaving a blank verso if needed. */
  function newRecto(): void {
    newPage();
    if (!isRecto()) newPage();
  }

  function textLeft(): number {
    return isRecto() ? insideM : outsideM;
  }

  // ---- front matter -------------------------------------------------------------------------
  for (const section of opts.front ?? []) {
    newRecto();
    let y = topM + pageH * 0.14;
    for (const b of section.blocks) {
      const style = b.style ?? 'centre';
      const size = style === 'title' ? 26 : style === 'author' ? 15 : style === 'small' ? 8.5 : bodySize;
      doc.font(style === 'title' || style === 'author' ? 'display' : 'body').fontSize(size);
      const align = style === 'left' ? 'left' : 'center';
      doc.text(plain(b.text), textLeft(), y, { width: textW, align });
      y = doc.y + (style === 'title' ? 24 : style === 'small' ? 7 : 12);
    }
  }

  // ---- chapters -----------------------------------------------------------------------------
  const chapterStarts: { page: number; title: string }[] = [];
  for (const ch of chapters) {
    newRecto();
    const label =
      ch.number === 0 ? 'Prologue' : ch.number == null ? '' : `Chapter ${ch.number}`;
    const title = (ch.title || label).trim();
    chapterStarts.push({ page: physical, title });

    // Chapter openers sink: the title sits a third of the way down, which is what a printed novel
    // does and what tells a reader at a glance that a new chapter has begun.
    let y = topM + pageH * 0.18;
    const showLabel = label && !title.toLowerCase().startsWith(label.toLowerCase());
    if (showLabel) {
      doc.font('display').fontSize(9).fillColor('#444');
      doc.text(label.toUpperCase(), textLeft(), y, { width: textW, align: 'center', characterSpacing: 2.2 });
      y = doc.y + 10;
    }
    doc.font('display').fontSize(15).fillColor('#000');
    doc.text(title, textLeft(), y, { width: textW, align: 'center' });
    y = doc.y + 26;

    doc.font('body').fontSize(bodySize).fillColor('#000');
    let first = true;
    for (const block of paragraphsOf(ch.text || '')) {
      if (doc.y > pageH - botM - leading * 2) {
        newPage();
        bodyPages.add(physical);
        y = topM;
      }
      if (block.kind === 'break') {
        doc.moveDown(0.6);
        doc.text('* * *', textLeft(), doc.y, { width: textW, align: 'center', characterSpacing: 3 });
        doc.moveDown(0.6);
        first = true;
        continue;
      }
      doc.text(plain(block.text), textLeft(), y === topM ? topM : doc.y, {
        width: textW,
        align: 'justify',
        indent: first ? 0 : bodySize * 1.2,
        lineGap: leading - bodySize,
        paragraphGap: 0,
      });
      // Every page the flow touched is a body page.
      bodyPages.add(physical);
      first = false;
      y = 0;
    }
  }

  // ---- back matter --------------------------------------------------------------------------
  for (const section of opts.back ?? []) {
    newRecto();
    let y = topM + pageH * 0.18;
    if (section.heading) {
      doc.font('display').fontSize(14).text(section.heading, textLeft(), y, {
        width: textW,
        align: 'center',
      });
      y = doc.y + 20;
    }
    doc.font('body').fontSize(bodySize).fillColor('#000');
    for (const b of section.blocks) {
      const align = b.style === 'centre' ? 'center' : 'left';
      doc.text(plain(b.text), textLeft(), y, {
        width: textW,
        align,
        lineGap: leading - bodySize,
      });
      y = doc.y + 10;
      bodyPages.add(physical);
    }
  }

  // ---- running heads and folios ---------------------------------------------------------------
  // Added last, over the finished pages, because only now is it known which pages carry body text
  // and which are blanks or openers.
  const openers = new Set(chapterStarts.map((c) => c.page));
  const range = doc.bufferedPageRange();
  // Headers and folios sit OUTSIDE the text block, above the top margin and below the bottom one.
  // pdfkit paginates whenever text crosses a margin, so writing a folio there adds a page — and
  // then numbers the page it just created. Caught by the page tree reporting 54 pages while this
  // function returned 51: a three-page error in the number the cover's spine width is computed
  // from. Dropping the vertical margins for this pass, and disabling line breaking, keeps the
  // numbering pass from changing what it is numbering.
  const savedTop = doc.page.margins.top;
  const savedBottom = doc.page.margins.bottom;
  for (let i = 0; i < range.count; i += 1) {
    const pageNo = range.start + i + 1;
    if (!bodyPages.has(pageNo) || openers.has(pageNo)) continue;
    doc.switchToPage(range.start + i);
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    const recto = pageNo % 2 === 1;
    const left = recto ? insideM : outsideM;
    doc.font('display').fontSize(8).fillColor('#555');
    // Verso carries the author, recto the title — the convention, and it tells a reader which book
    // they are holding when a volume has been put down for a week.
    doc.text(recto ? opts.title : opts.author, left, topM - 22, {
      width: textW,
      align: 'center',
      characterSpacing: 1,
      lineBreak: false,
    });
    doc.fontSize(9).fillColor('#000');
    doc.text(String(pageNo), left, pageH - botM + 16, {
      width: textW,
      align: 'center',
      lineBreak: false,
    });
    doc.page.margins.top = savedTop;
    doc.page.margins.bottom = savedBottom;
  }

  // Re-read the count AFTER the numbering pass rather than trusting the earlier snapshot.
  const finalCount = doc.bufferedPageRange().count;
  doc.end();
  await done;
  return {
    pdf: Buffer.concat(chunks),
    pageCount: finalCount,
    trim: trimName,
    gutterInches: gutter,
  };
}
