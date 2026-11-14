/**
 * The email that follows a closing scene or a recap going into the book: the words themselves, which chapter
 * they went into, what changed in the outline, and where the earlier versions are kept. The author asked to be
 * told about every change to the manuscript and to be able to read it in the message.
 */

export interface PieceMail {
  kind: 'coda' | 'recap';
  bookIndex: number;
  bookTitle: string;
  seriesTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  text: string;
  words: number;
  outlineChanges: string[];
  link: string;
  /** What the engine checked, when it is known. */
  checks: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function pieceAppliedEmail(m: PieceMail): { subject: string; html: string; text: string } {
  const noun = m.kind === 'coda' ? 'Closing scene' : 'Recap';
  const where = m.kind === 'coda' ? `the end of chapter ${m.chapterNumber}` : `the start of chapter ${m.chapterNumber}`;
  const book = m.bookTitle ? `Book ${m.bookIndex}, ${m.bookTitle}` : `Book ${m.bookIndex}`;
  const subject = `[Writer's Workbench] ${noun} added to ${book} — ${m.seriesTitle}`;
  const sans = 'font-family:system-ui,sans-serif';
  const li = (items: string[]) => items.map((i) => `<li>${esc(i)}</li>`).join('');
  const html =
    `<h2 style="${sans}">${esc(noun)} added to ${esc(book)}</h2>` +
    `<p style="${sans}">It is in the book now, at ${esc(where)} (&ldquo;${esc(m.chapterTitle)}&rdquo;), ${m.words.toLocaleString()} words. ` +
    `You can read and edit it in that chapter${m.link ? ` or from <a href="${esc(m.link)}">the Publish page</a>` : ''}.</p>` +
    (m.checks.length ? `<p style="${sans};margin-bottom:2px"><b>What the engine checked</b></p><ul style="${sans}">${li(m.checks)}</ul>` : '') +
    (m.outlineChanges.length ? `<p style="${sans};margin-bottom:2px"><b>What changed in the outline</b></p><ul style="${sans}">${li(m.outlineChanges)}</ul>` : '') +
    `<p style="${sans}">Nothing was re-recorded. The earlier text of the chapter and the earlier outline are kept in their Versions, so this can be taken back.</p>` +
    `<hr><div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(m.text)}</div>`;
  const text =
    `${noun} added to ${book}\n\nIt is in the book at ${where} ("${m.chapterTitle}"), ${m.words} words.\n\n` +
    (m.checks.length ? `Checked: ${m.checks.join('; ')}\n` : '') +
    (m.outlineChanges.length ? `Outline: ${m.outlineChanges.join('; ')}\n` : '') +
    `\nNothing was re-recorded. Earlier versions are kept.\n\n${m.text}\n`;
  return { subject, html, text };
}
