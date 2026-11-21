/**
 * A chapter the editor has saved, as the prose the book files expect.
 *
 * The engine writes a chapter as plain text, paragraphs separated by a blank line, italics as
 * `*word*`, a scene break as `---`. The first time the author saves it from the editor it becomes
 * HTML (`<p>`, `<em>`, `<hr>`), and every export that read it as prose (the EPUB, the print
 * interior, the audiobook, the KDP package) then printed the tags as letters: "<p>She <em>ran</em>.</p>"
 * in the book. This turns the HTML back into the prose form once, where the book is loaded, so all of
 * them see the same text. Text that is not HTML is returned as it came.
 */

const HTML_TAG = /<\/?(p|h[1-6]|em|strong|i|b|br|hr|blockquote|ul|ol|li|div|span)\b[^>]*>/i;

export function looksLikeHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

function decode(s: string): string {
  return s
    .replace(/&(nbsp|amp|lt|gt|quot|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip);|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlToProse(text: string): string {
  if (!looksLikeHtml(text)) return text;
  const s = text
    // A formatting block becomes a fenced run of paragraphs.
    .replace(/<div\b[^>]*data-format-block[^>]*>/gi, (tag) => {
      const attr = (n: string) => new RegExp(`data-${n}="([^"]*)"`, 'i').exec(tag)?.[1] ?? '';
      const style = cleanBlockStyle({ preset: attr('preset'), font: attr('font'), size: attr('size'), align: attr('align'), indent: attr('indent'), spacing: attr('spacing'), italic: attr('italic') });
      return `\n\n:::block ${JSON.stringify(style)}\n\n`;
    })
    .replace(/<\/div>/gi, '\n\n:::\n\n')
    // Italics and emphasis become the prose form's asterisks; a run that spans nothing is dropped.
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => (inner.trim() ? `*${inner.trim()}*` : inner))
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '$2')
    // A scene break.
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Blocks end a paragraph. Headings and list items stand as their own paragraphs.
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decode(s)
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------------------------------
// Formatting blocks: a styled run of paragraphs (a letter, a poem, an epigraph) inside a chapter.
//
// In the editor a block is `<div data-format-block ...>`. In the prose form the book files read, it is
// fenced by two marker lines so it survives the conversion above:
//
//   :::block {"font":"typewriter","align":"left","size":95,"indent":2,"spacing":1.4,"italic":false}
//   the paragraphs of the block, separated by blank lines
//   :::
//
// The EPUB turns the fence into a styled div. The print interior and the audiobook do not style it yet:
// they read the paragraphs and drop the fence (stripBlockMarkers), so a block is never printed or spoken
// as markers.
// ---------------------------------------------------------------------------------------------------

export interface BlockStyle {
  preset?: string;
  font: 'serif' | 'sans' | 'typewriter' | 'handwriting';
  /** Percent of the body size. */
  size: number;
  align: 'left' | 'center' | 'right' | 'justify';
  /** Left indent in em. */
  indent: number;
  /** Line height. */
  spacing: number;
  italic: boolean;
}

export const BLOCK_DEFAULTS: BlockStyle = { font: 'serif', size: 100, align: 'left', indent: 0, spacing: 1.5, italic: false };

export const FONT_STACKS: Record<BlockStyle['font'], string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "'Helvetica Neue', Arial, sans-serif",
  typewriter: "'Courier New', Courier, monospace",
  handwriting: "'Segoe Script', 'Bradley Hand', cursive",
};

const num = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** A style from untrusted attributes: every field is clamped or checked against its list. */
export function cleanBlockStyle(raw: Record<string, unknown>): BlockStyle {
  const font = String(raw.font ?? '') as BlockStyle['font'];
  const align = String(raw.align ?? '') as BlockStyle['align'];
  return {
    ...(raw.preset ? { preset: String(raw.preset).slice(0, 60) } : {}),
    font: font in FONT_STACKS ? font : BLOCK_DEFAULTS.font,
    size: num(raw.size, 70, 150, BLOCK_DEFAULTS.size),
    align: ['left', 'center', 'right', 'justify'].includes(align) ? align : BLOCK_DEFAULTS.align,
    indent: num(raw.indent, 0, 6, BLOCK_DEFAULTS.indent),
    spacing: num(raw.spacing, 1, 3, BLOCK_DEFAULTS.spacing),
    italic: raw.italic === true || raw.italic === 'true',
  };
}

export function blockCss(style: BlockStyle): string {
  return [
    `font-family:${FONT_STACKS[style.font]}`,
    `font-size:${style.size}%`,
    `text-align:${style.align}`,
    `margin:1em 0 1em ${style.indent}em`,
    `line-height:${style.spacing}`,
    style.italic ? 'font-style:italic' : '',
  ]
    .filter(Boolean)
    .join(';');
}

const FENCE_OPEN = /^:::block\s*(\{.*\})?\s*$/;
const FENCE_CLOSE = /^:::\s*$/;

export function isBlockOpen(line: string): BlockStyle | null {
  const m = FENCE_OPEN.exec(line.trim());
  if (!m) return null;
  try {
    return cleanBlockStyle(m[1] ? (JSON.parse(m[1]) as Record<string, unknown>) : {});
  } catch {
    return cleanBlockStyle({});
  }
}

export function isBlockClose(line: string): boolean {
  return FENCE_CLOSE.test(line.trim());
}

/** The prose with the fences removed and the paragraphs kept: for readers that do not style blocks. */
export function stripBlockMarkers(text: string): string {
  if (!text || !text.includes(':::')) return text;
  return text
    .split('\n')
    .filter((l) => !isBlockOpen(l) && !isBlockClose(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
