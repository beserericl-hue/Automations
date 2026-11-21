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
