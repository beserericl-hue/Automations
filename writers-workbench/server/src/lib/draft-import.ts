/**
 * Read an editor's Word file back into chapters.
 *
 * The file is the one Export Draft wrote, edited by a person: each chapter starts at a heading
 * "Chapter 12: Title", "Prologue: Title" or "Epilogue: Title". Chapters are matched by NUMBER (the
 * prologue is 0, the epilogue 999). Anything before the first chapter heading (the title page, the
 * contents list, a book's title page) is ignored, and so is a book title line between chapters.
 *
 * mammoth reads the accepted text: tracked insertions are in, tracked deletions are out.
 */
import mammoth from 'mammoth';

export interface ImportedChapter {
  chapter_number: number;
  title: string;
  /** Plain prose, paragraphs separated by a blank line, *italics*, scene breaks as ---. */
  text: string;
  words: number;
}

const HEADING = /^(?:chapter\s+(\d{1,3})|(prologue)|(epilogue))\s*(?:[:.\-–—]\s*(.*))?$/i;
const BOOK_LINE = /^book\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\b.{0,120}$/i;

const ENT: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
const decode = (s: string): string =>
  s
    .replace(/&(nbsp|amp|lt|gt|quot|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip);/g, (_, n: string) => ENT[n] ?? _)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));

/** One paragraph's inner HTML to prose, keeping italics. */
function inline(html: string): string {
  return decode(
    html
      .replace(/<(em|i)>\s*<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?(em|i)>/gi, '*')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingOf(text: string): { n: number; title: string } | null {
  const m = HEADING.exec(text.trim());
  if (!m || text.length > 200) return null;
  const n = m[1] != null ? Number(m[1]) : m[2] ? 0 : 999;
  return { n, title: (m[4] ?? '').trim() };
}

/** Split already-converted HTML (flat h1/p blocks) into chapters. Exported for tests. */
export function chaptersFromHtml(html: string): ImportedChapter[] {
  const blocks = [...html.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({ tag: m[1].toLowerCase(), text: inline(m[2]) }));
  const found = new Map<number, ImportedChapter>();
  let cur: { n: number; title: string; paras: string[] } | null = null;
  const close = () => {
    if (!cur) return;
    const text = cur.paras.join('\n\n').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const old = found.get(cur.n);
    // The contents list repeats every heading; the real chapter is the one with the text.
    if (words && (!old || words > old.words)) found.set(cur.n, { chapter_number: cur.n, title: cur.title, text, words });
    cur = null;
  };
  for (const b of blocks) {
    if (!b.text) continue;
    const h = headingOf(b.text);
    if (h && (b.tag === 'h1' || b.tag === 'h2' || b.tag === 'p' || b.tag === 'li')) {
      close();
      cur = { n: h.n, title: h.title, paras: [] };
      continue;
    }
    if (!cur) continue;
    if (BOOK_LINE.test(b.text)) continue;
    cur.paras.push(/^(\*\s*){3,}$/.test(b.text) || /^-{3,}$/.test(b.text) ? '---' : b.text);
  }
  close();
  return [...found.values()].sort((a, b) => a.chapter_number - b.chapter_number);
}

export async function chaptersFromDocx(buffer: Buffer): Promise<ImportedChapter[]> {
  const { value } = await mammoth.convertToHtml({ buffer });
  return chaptersFromHtml(value);
}
