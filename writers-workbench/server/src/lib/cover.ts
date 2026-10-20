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

const WIDTH = 1600;
const HEIGHT = 2560; // 1:1.6, the standard ebook cover ratio
const ART_TOP = 860; // leaves a title block above the artwork
const BG = '#130c07'; // dark earth; the art's own darkest tone, so the join is invisible
const INK = '#dcd7d0'; // pale warm grey — sits back from the artwork instead of competing
const RULE = '#6d5740';

const TITLE_SIZE = 190;
const TITLE_SMALL = 132; // for a leading article on its own line ("THE")
const AUTHOR_SIZE = 76;
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
}

/**
 * Build a portrait cover. Returns a JPEG buffer, or null when it cannot be built — the caller then
 * uses the raw art, which is the behaviour this replaced.
 */
export async function composeCover(opts: ComposeCoverOptions): Promise<Buffer | null> {
  const { art, title, author } = opts;
  if (!art?.length) return null;
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
