/**
 * Compose an ebook cover from a project's generated art.
 *
 * WHY THIS EXISTS. Generated cover art is square (1024x1024) and carries no words. Ebook readers
 * expect a portrait cover — Books, Kindle and KDP all want roughly 1:1.6 — so a square image is
 * letterboxed into the shelf tile with grey bars above and below, and with no title or author on it
 * the shelf shows a picture rather than a book. Both were visible in Apple Books before this.
 *
 * HOW IT WORKS, and why it is built this odd way. The server runs on `node:20-alpine`, which has no
 * fonts and no ImageMagick. Anything that rasterises text through pango/fontconfig would need system
 * fonts installed in the image. So the text never goes to a text renderer at all:
 *
 *   opentype.js (pure JS) converts the title and author to GLYPH OUTLINES -> an SVG of nothing but
 *   <path> elements -> sharp rasterises it.
 *
 * sharp's SVG support renders paths without any font machinery, so the container needs no fonts and
 * the output is identical everywhere. The bundled face is Raleway (SIL OFL, see assets/fonts/
 * OFL.txt), a variable font instanced to Light — the closest open equivalent to the humanist light
 * caps this design is modelled on.
 *
 * The art is placed full-width inside the portrait frame rather than cropped to shape: the
 * compositions these covers use are wide, and cropping a square to 1:1.6 throws away 37% of the
 * width — on the first real cover that would have cut either the skyline or the figures.
 *
 * Everything here is best-effort by design. `composeCover` returning null means the caller falls
 * back to the raw art, which is what the export did before. A cover is a nicety; failing an export
 * of a 600,000-word manuscript over one is not a trade worth making.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

/** The ebook jacket's exact pixel size. Exported so a caller can validate what it was handed
 *  rather than assume it — the fallback path returns raw art at an unknown size. */
export const EBOOK_COVER_W = 1600;
export const EBOOK_COVER_H = 2560; // 1:1.6, the standard ebook cover ratio
const WIDTH = EBOOK_COVER_W;
const HEIGHT = EBOOK_COVER_H;
const ART_TOP = 860; // leaves a title block above the artwork
const BG = '#130c07'; // dark earth; the art's own darkest tone, so the join is invisible
const INK = '#dcd7d0'; // pale warm grey — sits back from the artwork instead of competing
const RULE = '#6d5740';

const TITLE_SIZE = 190;
const TITLE_SMALL = 132; // for a leading article on its own line ("THE")
const AUTHOR_SIZE = 76;
const SERIES_SIZE = 42;
// Wide tracking is the most characteristic part of this style. Without it the same words in the
// same face read as a generic paperback.
const TITLE_TRACKING = 0.17;
const AUTHOR_TRACKING = 0.28;

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/lib/cover.js at runtime, src/lib/cover.ts in tests — assets sit beside both.
const FONT_CANDIDATES = [
  join(HERE, '../assets/fonts/Raleway-Variable.ttf'),
  join(HERE, '../../assets/fonts/Raleway-Variable.ttf'),
];

interface Glyphable {
  unitsPerEm: number;
  variation?: { set(axes: Record<string, number>): void };
  getPath(text: string, x: number, y: number, size: number): { toPathData(places: number): string };
  getAdvanceWidth(text: string, size: number): number;
}

let fontCache: Glyphable | null | undefined;
let fontBytes: Buffer | null = null;
let parseCache: ((b: ArrayBuffer) => Glyphable) | null = null;

/** Non-finite coordinates in path data. */
const BAD_COORD = /NaN|Infinity|undefined/;

async function loadFont(): Promise<Glyphable | null> {
  if (fontCache !== undefined) return fontCache;
  try {
    const ot = (await import('opentype.js')) as unknown as {
      parse?: (b: ArrayBuffer) => Glyphable;
      default?: { parse: (b: ArrayBuffer) => Glyphable };
    };
    const parse = ot.parse ?? ot.default?.parse;
    if (!parse) throw new Error('opentype.js has no parse()');
    parseCache = parse;
    let buf: Buffer | null = null;
    for (const p of FONT_CANDIDATES) {
      try {
        buf = readFileSync(p);
        break;
      } catch {
        /* try the next location */
      }
    }
    if (!buf) throw new Error('Raleway-Variable.ttf not found');
    fontBytes = buf;
    const font = parse(new Uint8Array(buf).buffer);
    // Raleway ships as a variable font whose default instance is Regular. Light is the weight this
    // design wants, and it is also what keeps a long title from looking heavy at thumbnail size.
    try {
      font.variation?.set({ wght: 300 });
    } catch {
      /* a non-variable build still renders, just heavier */
    }
    fontCache = font;
  } catch (err) {
    logger.warn({ err }, 'cover: font unavailable, covers will use the raw art');
    fontCache = null;
  }
  return fontCache;
}

/**
 * One glyph's outline, with a guard against opentype.js emitting a non-finite coordinate.
 *
 * Observed on this font: a closing quadratic came back as `QNaN 566.95 330.51 566.95`. It is
 * intermittent and did not reproduce when the same glyph was requested in isolation, so it is
 * treated as a fact of the library rather than something to out-argue. What matters is the
 * consequence: librsvg stops parsing at the malformed command, so ONE bad glyph silently truncates
 * the rest of the cover — in the first run that cost the whole title after the "O" and the entire
 * author line, with no error anywhere.
 *
 * A fresh parse of the font clears whatever state produced it. If the retry is also bad the glyph
 * is dropped, and the caller refuses the cover rather than shipping a jacket with a hole in it.
 */
function glyphPath(
  font: Glyphable,
  parse: ((b: ArrayBuffer) => Glyphable) | null,
  char: string,
  x: number,
  y: number,
  size: number,
): { data: string; font: Glyphable } {
  let d = font.getPath(char, x, y, size).toPathData(2);
  if (!BAD_COORD.test(d)) return { data: d, font };
  if (parse && fontBytes) {
    const retryFont = parse(new Uint8Array(fontBytes).buffer);
    try {
      retryFont.variation?.set({ wght: 300 });
    } catch {
      /* non-variable build */
    }
    d = retryFont.getPath(char, x, y, size).toPathData(2);
    if (!BAD_COORD.test(d)) {
      logger.info({ char }, 'cover: recovered a glyph with a non-finite coordinate');
      return { data: d, font: retryFont };
    }
  }
  logger.warn({ char }, 'cover: glyph produced non-finite coordinates twice');
  return { data: '', font };
}

/**
 * One line of copy as glyph outlines, laid out A CHARACTER AT A TIME.
 *
 * Two separate opentype.js faults are avoided here, both found by bisecting real copy:
 *
 *  1. WHOLE-STRING layout breaks on this variable font past roughly 47 characters — it emits a
 *     non-finite coordinate, librsvg stops parsing at it, and the rest of the cover silently
 *     vanishes. Per-character layout does not. (The front of the jacket has always been
 *     per-character, which is why it worked while the back-cover blurb lost two of three lines.)
 *  2. FRACTIONAL x positions trigger the same fault on individual glyphs: laying out three real
 *     lines of blurb, 8 of 187 glyphs came back non-finite at positions like x=967.10, and none at
 *     all once x was rounded. So the pen position is rounded at every glyph. At 300dpi that moves a
 *     letter by 1/300 of an inch, which is nothing, and it removes the fault completely.
 */
function lineToPaths(font: Glyphable, text: string, x: number, y: number, size: number): string[] {
  const out: string[] = [];
  let cursor = x;
  const baseline = Math.round(y);
  for (const ch of text) {
    if (ch !== ' ') {
      const d = font.getPath(ch, Math.round(cursor), baseline, size).toPathData(2);
      if (!BAD_COORD.test(d)) out.push(d);
    }
    cursor += font.getAdvanceWidth(ch, size);
  }
  return out;
}

/**
 * A FRESHLY PARSED font instance.
 *
 * opentype.js carries state between calls on a variable font, and mixing sizes across calls on one
 * instance intermittently yields a non-finite coordinate. The front-of-jacket composer solved that
 * by parsing per line; the back-cover copy did not, and two of its three blurb lines were dropped
 * by the guard — a cover that printed with no blurb on it. One helper now, used by both.
 */
function newFontInstance(): Glyphable | null {
  if (!parseCache || !fontBytes) return fontCache ?? null;
  try {
    const g = parseCache(new Uint8Array(fontBytes).buffer);
    try {
      g.variation?.set({ wght: 300 });
    } catch {
      /* a non-variable build renders heavier, not broken */
    }
    return g;
  } catch {
    return fontCache ?? null;
  }
}

/** Glyph outlines for one centred, letter-spaced line. Returns SVG path data. */
function trackedLine(
  fontRef: { current: Glyphable },
  parse: ((b: ArrayBuffer) => Glyphable) | null,
  text: string,
  size: number,
  tracking: number,
  centreY: number,
): { data: string; dropped: number } {
  const chars = [...text];
  const space = size * tracking;
  const widths = chars.map((c) => fontRef.current.getAdvanceWidth(c, size));
  const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, chars.length - 1);
  // Whole pixels: the glyph positions are a design choice, not a measurement, and integers keep the
  // generated path data short and identical across runs.
  let x = Math.round((WIDTH - total) / 2);
  const parts: string[] = [];
  let dropped = 0;
  chars.forEach((c, i) => {
    if (c !== ' ') {
      const got = glyphPath(fontRef.current, parse, c, x, centreY, size);
      fontRef.current = got.font;
      if (got.data) parts.push(got.data);
      else dropped += 1;
    }
    x += widths[i] + space;
  });
  return { data: parts.join(' '), dropped };
}

/**
 * Split a title for the cover. A leading article goes on its own smaller line, the way jacket
 * design has always handled it ("THE / OSSUARY"), which also stops a long word being shrunk to fit.
 */
export function splitTitle(title: string): { lead: string; main: string } {
  const words = (title || '').trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && /^(the|a|an)$/i.test(words[0])) {
    return { lead: words[0].toUpperCase(), main: words.slice(1).join(' ').toUpperCase() };
  }
  return { lead: '', main: words.join(' ').toUpperCase() };
}

/** Shrink a line until it fits the cover's safe width. A long title must not run off the edge. */
function fitSize(font: Glyphable, text: string, start: number, tracking: number): number {
  const safe = WIDTH * 0.86;
  let size = start;
  for (let i = 0; i < 40; i += 1) {
    const w =
      [...text].reduce((a, c) => a + font.getAdvanceWidth(c, size), 0) +
      size * tracking * Math.max(0, [...text].length - 1);
    if (w <= safe) break;
    size *= 0.94;
  }
  return size;
}

export interface ComposeCoverOptions {
  art: Buffer;
  title: string;
  author?: string;
  /** "Book One of The Ossuary", set small under the title rule on a series book. */
  seriesLine?: string;
}

/**
 * Build a portrait cover. Returns a JPEG buffer, or null when it cannot be built — the caller then
 * uses the raw art, which is the behaviour this replaced.
 */
export async function composeCover(opts: ComposeCoverOptions): Promise<Buffer | null> {
  const { art, title, author } = opts;
  if (!art?.length) return null;
  const seriesText = (opts.seriesLine || '').trim().toUpperCase();
  try {
    // Imported dynamically and typed loosely on purpose: both are optional at runtime, and a
    // missing or unloadable native binary must degrade to "no composed cover", not a build error.
    type SharpFn = (input?: Buffer | Record<string, unknown>) => {
      resize: (w: number, h: number, o?: Record<string, unknown>) => { toBuffer(): Promise<Buffer> };
      composite: (c: Record<string, unknown>[]) => { jpeg: (o: Record<string, unknown>) => { toBuffer(): Promise<Buffer> } };
    };
    const sharpMod = (await import('sharp')) as unknown as { default?: SharpFn };
    const sharp = (sharpMod.default ?? (sharpMod as unknown as SharpFn)) as SharpFn;
    const font = await loadFont();
    if (!font) return null;

    const { lead, main } = splitTitle(title);
    const mainSize = fitSize(font, main, TITLE_SIZE, TITLE_TRACKING);
    const authorText = (author || '').trim().toUpperCase();
    const authorSize = authorText ? fitSize(font, authorText, AUTHOR_SIZE, AUTHOR_TRACKING) : 0;

    const leadY = Math.round(300 + TITLE_SMALL * 0.35);
    const mainY = Math.round((lead ? 500 : 420) + mainSize * 0.35);
    const ruleY = Math.round(mainY + mainSize * 0.62);

    // A FRESH font instance per line. opentype.js's variable-font path generation carries state
    // between calls, and mixing sizes across calls on one instance intermittently produced a
    // non-finite coordinate — `QNaN 566.95 ...` on a closing curve — which none of the same calls
    // reproduced in isolation. Rather than keep trying to out-argue the library, each line gets its
    // own parse. Three parses of a 300KB font per cover is a few milliseconds, and it removes the
    // whole class of bug instead of narrowing it.
    const freshFont = (): Glyphable => {
      if (!parseCache || !fontBytes) return font;
      const g = parseCache(new Uint8Array(fontBytes).buffer);
      try {
        g.variation?.set({ wght: 300 });
      } catch {
        /* non-variable build renders heavier, not broken */
      }
      return g;
    };

    const lines = [
      lead ? trackedLine({ current: freshFont() }, parseCache, lead, TITLE_SMALL, TITLE_TRACKING, leadY) : null,
      trackedLine({ current: freshFont() }, parseCache, main, mainSize, TITLE_TRACKING, mainY),
      authorText
        ? trackedLine({ current: freshFont() }, parseCache, authorText, authorSize, AUTHOR_TRACKING, HEIGHT - 190)
        : null,
      seriesText
        ? trackedLine(
            { current: freshFont() },
            parseCache,
            seriesText,
            fitSize(font, seriesText, SERIES_SIZE, AUTHOR_TRACKING),
            AUTHOR_TRACKING,
            ruleY + 78,
          )
        : null,
    ].filter((l): l is { data: string; dropped: number } => l !== null);

    const dropped = lines.reduce((a, l) => a + l.dropped, 0);
    const paths = lines.map((l) => l.data).filter(Boolean);
    // A cover missing letters is worse than a cover with no lettering: the caller falls back to the
    // raw art, which at least looks deliberate.
    if (dropped > 0) {
      logger.warn({ dropped, title }, 'cover: dropping composed cover, glyphs could not be rendered');
      return null;
    }

    const d = paths.join(' ');
    // Final belt and braces: one malformed command makes librsvg stop mid-document, and the result
    // is a silently half-drawn cover rather than an error.
    if (BAD_COORD.test(d)) {
      logger.warn({ title }, 'cover: path data contained non-finite coordinates, skipping');
      return null;
    }

    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
        `<path d="${d}" fill="${INK}"/>` +
        `<rect x="${WIDTH / 2 - 100}" y="${ruleY}" width="200" height="2" fill="${RULE}"/>` +
        `</svg>`,
    );

    // Soft scrims where the artwork meets the ground, so it dissolves rather than sitting in a box.
    const scrimTop = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="110">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${BG}" stop-opacity="1"/>` +
        `<stop offset="1" stop-color="${BG}" stop-opacity="0"/></linearGradient></defs>` +
        `<rect width="${WIDTH}" height="110" fill="url(#g)"/></svg>`,
    );
    const scrimBottom = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="140">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${BG}" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="${BG}" stop-opacity="1"/></linearGradient></defs>` +
        `<rect width="${WIDTH}" height="140" fill="url(#g)"/></svg>`,
    );

    const artFull = await sharp(art).resize(WIDTH, WIDTH, { fit: 'fill' }).toBuffer();

    return await sharp({
      create: { width: WIDTH, height: HEIGHT, channels: 3, background: BG },
    })
      .composite([
        { input: artFull, top: ART_TOP, left: 0 },
        { input: scrimTop, top: ART_TOP, left: 0 },
        { input: scrimBottom, top: ART_TOP + WIDTH - 140, left: 0 },
        { input: overlay, top: 0, left: 0 },
      ])
      .jpeg({ quality: 86 })
      .toBuffer();
  } catch (err) {
    // Never fail an export over the cover.
    logger.warn({ err }, 'cover: composition failed, falling back to raw art');
    return null;
  }
}

// =====================================================================
// The print cover wrap
// =====================================================================
// A paperback cover is ONE image: back cover, spine and front cover laid side by side, with bleed
// on all four outside edges. Three separate files is the commonest thing a first-time KDP uploader
// gets wrong.
//
// Two numbers decide whether it prints correctly, and both are unforgiving:
//
//  - SPINE WIDTH = page count x paper thickness. It cannot be estimated, because being 2mm out puts
//    the title off-centre on a physical object. This is why the interior PDF is generated first: its
//    page count is the input here.
//  - THE BARCODE ZONE. KDP prints a barcode into a 2" x 1.2" area at the bottom right of the back
//    cover. Anything underneath it is covered up, so that rectangle is left clear deliberately
//    rather than by luck.

/** Paper thickness per page, in inches. KDP's published figures. */
export const PAPER_THICKNESS = {
  white: 0.002252,
  cream: 0.0025,
  colour: 0.0037,
} as const;

export type PaperStock = keyof typeof PAPER_THICKNESS;

export const BLEED_IN = 0.125;
/** KDP's reserved barcode area, bottom right of the back cover. */
export const BARCODE_W_IN = 2.0;
export const BARCODE_H_IN = 1.2;
/** Clearance KDP wants around the barcode and the trim edges. */
export const SAFE_MARGIN_IN = 0.25;

export function spineWidthInches(pageCount: number, paper: PaperStock = 'white'): number {
  return pageCount * PAPER_THICKNESS[paper];
}

/**
 * KDP will not print text on the spine of a book under this many pages.
 *
 * Stated in PAGES because that is how the rule is stated — an earlier version of this expressed it
 * as an inch threshold and got it wrong by half, which would have put type on a spine too thin to
 * carry it.
 */
export const MIN_SPINE_TEXT_PAGES = 100;

/**
 * A printer's own cover geometry, read from its template for one product and page count. Absent
 * means KDP's paperback rules: bleed on the outside edges, panels at the trim, spine from paper.
 */
export interface WrapLayout {
  widthIn: number;
  heightIn: number;
  /** What lies outside the panels on every edge: bleed, or on a case-bound cover the board wrap. */
  edgeIn: number;
  /** One cover panel, front or back. On a hardcover it is larger than the trim (board overhang). */
  panelWIn: number;
  panelHIn: number;
  spineIn: number;
  /** Each flap of a dust jacket. 0 for a cover. */
  flapIn: number;
}

export interface CoverWrapOptions {
  art: Buffer;
  title: string;
  author: string;
  /** From the generated interior. Never an estimate. */
  pageCount: number;
  trimWidthIn: number;
  trimHeightIn: number;
  paper?: PaperStock;
  /** Back-cover copy. Blank lines separate paragraphs. */
  blurb?: string;
  /** One line under the blurb. */
  authorBio?: string;
  volumeLabel?: string;
  /** The printer's geometry. Without it the wrap is laid out for KDP. */
  layout?: WrapLayout;
  /** A series book's series line, for the front. */
  seriesLine?: string;
  /** Dust-jacket flap copy: the front flap carries the description, the back flap the author. */
  flaps?: { front?: string; back?: string };
}

export interface CoverWrapResult {
  png: Buffer;
  widthIn: number;
  heightIn: number;
  spineIn: number;
  spineCarriesText: boolean;
  dpi: number;
}

/**
 * As many whole sentences from the start of `text` as fit in `max` characters; '' when even the
 * first one does not. Never a cut word.
 */
export function leadingSentences(text: string, max: number): string {
  const sentences = text.trim().replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  let out = '';
  for (const s of sentences) {
    const next = `${out} ${s.trim()}`.trim();
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** Greedy line-fill at one size. Blank lines separate paragraphs, and each paragraph ends with ''. */
function wrapLines(font: Glyphable, text: string, width: number, size: number): string[] {
  const lines: string[] = [];
  const paras = (text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (const p of paras) {
    let line = '';
    for (const w of p.split(/\s+/)) {
      const trial = line ? `${line} ${w}` : w;
      if (font.getAdvanceWidth(trial, size) > width) {
        lines.push(line);
        line = w;
      } else line = trial;
    }
    if (line) lines.push(line);
    lines.push('');
  }
  return lines;
}

/**
 * Compose the full wrap at 300dpi.
 *
 * Returned as PNG: KDP accepts PDF or JPEG for covers, and a lossless raster is the honest
 * intermediate — the caller wraps it in a PDF at the exact trim so no scaling happens anywhere.
 */
export async function composeCoverWrap(opts: CoverWrapOptions): Promise<CoverWrapResult | null> {
  const {
    art, title, author, pageCount, trimWidthIn, trimHeightIn, paper = 'white',
  } = opts;
  if (!art?.length || pageCount <= 0) return null;
  const DPI = 300;
  const kdpSpine = spineWidthInches(pageCount, paper);
  const L: WrapLayout = opts.layout ?? {
    widthIn: trimWidthIn * 2 + kdpSpine + BLEED_IN * 2,
    heightIn: trimHeightIn + BLEED_IN * 2,
    edgeIn: BLEED_IN,
    panelWIn: trimWidthIn,
    panelHIn: trimHeightIn,
    spineIn: kdpSpine,
    flapIn: 0,
  };
  const { widthIn, heightIn, spineIn } = L;
  const W = Math.round(widthIn * DPI);
  const H = Math.round(heightIn * DPI);
  const px = (inches: number) => Math.round(inches * DPI);

  try {
    type SharpFn = (input?: Buffer | Record<string, unknown>) => {
      resize: (w: number, h: number, o?: Record<string, unknown>) => { toBuffer(): Promise<Buffer> };
      composite: (c: Record<string, unknown>[]) => { png: () => { toBuffer(): Promise<Buffer> } };
    };
    const mod = (await import('sharp')) as unknown as { default?: SharpFn };
    const sharp = (mod.default ?? (mod as unknown as SharpFn)) as SharpFn;
    const font = await loadFont();
    if (!font) return null;

    // Left to right: edge, back flap, back panel, spine, front panel, front flap, edge.
    const backLeftIn = L.edgeIn + L.flapIn;
    const spineLeftIn = backLeftIn + L.panelWIn;
    const frontLeft = px(spineLeftIn + spineIn);
    const frontW = px(L.panelWIn);
    // The front of the wrap is the SAME jacket as the ebook cover — title, author and all. Placing
    // the raw art here produced a paperback whose front carried no title, while the ebook of the
    // same book did. Falling back to the art is better than no cover, but it is a fallback.
    const jacket = await composeCover({ art, title, author, seriesLine: opts.seriesLine });
    const artBuf = await sharp(jacket ?? art)
      .resize(frontW, px(L.panelHIn), { fit: 'cover' })
      .toBuffer();

    // Back-cover text, set as glyph outlines for the same reason the front is: no system fonts.
    const backX = px(backLeftIn + SAFE_MARGIN_IN);
    const backW = px(L.panelWIn) - px(SAFE_MARGIN_IN + BLEED_IN) * 2;
    const SIZE = 34;
    // The barcode zone is a hard floor for the text block.
    const barcodeTop = H - px(L.edgeIn + SAFE_MARGIN_IN + BARCODE_H_IN) - px(0.15);
    // The author line above the barcode: whole sentences only. A fixed character cut printed
    // "…the Maryland Historical Society brough" on a back cover. A jacket carries the full bio on
    // its back flap, so its back cover leaves the line out.
    const bioSize = SIZE * 0.82;
    const bioFont = newFontInstance() ?? font;
    let bioLines: string[] = [];
    // Fewer whole sentences until it fits in four lines; never a line cut off the end.
    for (let max = L.flapIn > 0 ? 0 : 400; max > 0; ) {
      const bio = leadingSentences(opts.authorBio ?? '', max);
      if (!bio) break;
      const wrapped = wrapLines(bioFont, bio, backW, bioSize).filter(Boolean);
      if (wrapped.length <= 4) {
        bioLines = wrapped;
        break;
      }
      max = bio.length - 1;
    }
    const bioTop = barcodeTop - bioSize - Math.max(0, bioLines.length - 1) * bioSize * 1.42;
    // The blurb stops a line above the bio, so the two never overlap however long either is.
    const blurbFloor = bioLines.length ? bioTop - SIZE * 1.42 * 1.5 : barcodeTop;
    const lines = wrapLines(font, opts.blurb || '', backW, SIZE);
    const maxLines = Math.max(0, Math.floor((blurbFloor - px(L.edgeIn + 1.2)) / (SIZE * 1.42)));
    const shown = lines.slice(0, maxLines);

    const paths: string[] = [];
    let dropped = 0;
    const setLine = (f: Glyphable, line: string, x: number, y: number, size: number): void => {
      const glyphs = lineToPaths(f, line, x, y, size);
      const expected = [...line].filter((c) => c !== ' ').length;
      if (glyphs.length < expected) dropped += expected - glyphs.length;
      paths.push(...glyphs);
    };
    // Its OWN instance. By this point the shared one has laid out the jacket at 190, 132 and 76pt,
    // and mixing sizes across a single opentype.js instance is what corrupts its variable-font
    // state. The back cover is a different size again, so it starts clean.
    const backFont = newFontInstance() ?? font;
    let y = px(L.edgeIn + 1.2);
    for (const line of shown) {
      if (line) setLine(backFont, line, backX, y, SIZE);
      y += SIZE * 1.42;
    }
    let by = bioTop;
    for (const line of bioLines) {
      setLine(bioFont, line, backX, by, bioSize);
      by += bioSize * 1.42;
    }

    // Dust-jacket flaps. Text that does not fit is cut at a whole line and counted, not squeezed.
    let flapOverflow = 0;
    if (L.flapIn > 0) {
      const FLAP = 30;
      const flapW = px(L.flapIn - SAFE_MARGIN_IN * 2);
      const top = px(L.edgeIn + 1.0);
      const floor = H - px(L.edgeIn + SAFE_MARGIN_IN);
      const flap = (text: string | undefined, leftIn: number): void => {
        if (!text?.trim()) return;
        const f = newFontInstance() ?? font;
        const all = wrapLines(f, text, flapW, FLAP);
        const room = Math.max(0, Math.floor((floor - top) / (FLAP * 1.42)));
        flapOverflow += Math.max(0, all.filter(Boolean).length - all.slice(0, room).filter(Boolean).length);
        let fy = top;
        for (const line of all.slice(0, room)) {
          if (line) setLine(f, line, px(leftIn + SAFE_MARGIN_IN), fy, FLAP);
          fy += FLAP * 1.42;
        }
      };
      flap(opts.flaps?.back, L.edgeIn);
      flap(opts.flaps?.front, L.edgeIn + L.flapIn + L.panelWIn * 2 + spineIn);
      if (flapOverflow) logger.warn({ flapOverflow, title }, 'cover wrap: flap copy cut to fit');
    }
    // A back cover missing half its blurb is worse than one with none: it looks like a printing
    // fault rather than a choice. Refuse, and let the caller fall back.
    if (dropped > 0) {
      logger.warn({ dropped, title }, 'cover wrap: back-cover copy lost lines, refusing the wrap');
      return null;
    }

    // Spine type only when the spine is thick enough to carry it.
    const spineCarriesText = pageCount >= MIN_SPINE_TEXT_PAGES;
    const spineCentre = px(spineLeftIn) + px(spineIn) / 2;
    let spineSvg = '';
    if (spineCarriesText) {
      // Title, volume, then author — the order a reader scans a shelf in.
      const label =
        `${title}${opts.volumeLabel ? `  ·  ${opts.volumeLabel}` : ''}` +
        `${author ? `  ·  ${author}` : ''}`;
      const size = Math.min(px(spineIn) * 0.42, 46);
      const sf = newFontInstance() ?? font;
      const w = [...label].reduce((a, c) => a + sf.getAdvanceWidth(c, size), 0);
      const d = lineToPaths(sf, label, 0, 0, size).join(' ');
      if (d) {
        // Rotated 90deg: spine type runs top-to-bottom on an English-language book.
        spineSvg =
          `<g transform="translate(${spineCentre + size * 0.35}, ${H / 2 - w / 2}) rotate(90)">` +
          `<path d="${d}" fill="${INK}"/></g>`;
      }
    }

    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
        `<rect width="${W}" height="${H}" fill="none"/>` +
        (paths.length ? `<path d="${paths.join(' ')}" fill="${INK}"/>` : '') +
        spineSvg +
        '</svg>',
    );

    const png = await sharp({
      create: { width: W, height: H, channels: 3, background: BG },
    })
      .composite([
        { input: artBuf, top: px(L.edgeIn), left: frontLeft },
        { input: overlay, top: 0, left: 0 },
      ])
      .png()
      .toBuffer();

    return { png, widthIn, heightIn, spineIn, spineCarriesText, dpi: DPI };
  } catch (err) {
    logger.warn({ err }, 'cover wrap: composition failed');
    return null;
  }
}
