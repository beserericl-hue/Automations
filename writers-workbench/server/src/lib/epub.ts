/**
 * EPUB 3 builder — the pre-publish "read it as a book" export.
 *
 * Separate from the route so it can be unit-tested without HTTP or Supabase. The .docx export
 * (routes/export.ts) targets KDP print; this targets a reader, so an author can put the manuscript
 * on a Kindle or in Books and read it the way the reader will before committing to publish.
 *
 * Things that are easy to get wrong here, and why the code looks the way it does:
 *
 *  - `mimetype` MUST be the archive's FIRST entry and MUST be STORED, not deflated. Readers sniff
 *    those bytes at a fixed offset. A compressed mimetype is the single commonest reason a
 *    hand-rolled EPUB opens in one reader and silently fails in another.
 *  - Chapter text is plain manuscript prose, not HTML: blank-line paragraphs, `---` for a scene
 *    break, `*word*` for italics. It is HTML-escaped FIRST and marked up SECOND. Reversing that
 *    turns an ampersand or a `<` in the prose into broken XHTML, and a 600,000-word manuscript will
 *    contain both.
 *  - A scene break renders as a centred dinkus, not an `<hr>` — that is what the break means in a
 *    typeset novel and what the Workbench's own `---` convention stands for.
 *  - Every chapter is its own XHTML file. One giant document is valid and makes readers crawl.
 */

import JSZip from 'jszip';

export interface EpubChapter {
  chapter_number: number | null;
  title: string | null;
  content_text: string | null;
  status?: string | null;
}

export interface EpubOptions {
  title: string;
  chapters: EpubChapter[];
  author?: string;
  /** Marks unapproved chapters in the text so a draft read is never mistaken for a final one. */
  markDrafts?: boolean;
  /** Fixed values make the output byte-stable, which is what makes it testable. */
  now?: Date;
  bookId?: string;
  /** Cover image bytes. Declared three ways below because readers disagree about which they honour. */
  cover?: { data: Buffer; ext: 'jpg' | 'png' } | null;
}

const CSS = `@page { margin: 5%; }
body { font-family: Georgia, 'Iowan Old Style', serif; line-height: 1.5; margin: 0; }
h1 { font-size: 1.4em; font-weight: normal; margin: 2em 0 0.2em; text-align: left; }
h1 .num { display: block; font-size: 0.62em; letter-spacing: 0.18em; text-transform: uppercase; color: #777; margin-bottom: 0.6em; }
p { margin: 0; text-indent: 1.3em; text-align: justify; }
p.first { text-indent: 0; }
p.first::first-letter { font-size: 1.6em; line-height: 1; }
.dinkus { text-indent: 0; text-align: center; margin: 1.2em 0; color: #666; letter-spacing: 0.5em; }
.draft { color: #999; font-size: 0.8em; font-style: italic; text-indent: 0; margin-bottom: 1em; }
nav ol { list-style: none; padding-left: 0; line-height: 1.9; }
.title-page { text-align: center; margin-top: 25%; }
.title-page h1 { font-size: 2.2em; text-align: center; }
.title-page .sub { color: #666; font-style: italic; }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Plain manuscript prose -> XHTML paragraphs. Exported for tests: this is where the bodies are buried. */
export function proseToXhtml(text: string): string {
  const out: string[] = [];
  let first = true;
  for (const raw of (text || '').split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^-{3,}$/.test(block) || /^(\*\s*){3,}$/.test(block)) {
      out.push('<p class="dinkus">* * *</p>');
      first = true; // the paragraph after a break opens a new scene
      continue;
    }
    // Escape BEFORE adding markup, or prose containing & or < produces invalid XHTML.
    let body = esc(block).replace(/\n/g, ' ');
    // The content must not start or end with whitespace, or arithmetic and stray asterisks
    // ("5 * 3 and 2 * 4") are silently turned into italics spanning half a sentence.
    body = body.replace(/\*(\S|\S[^*\n]*\S)\*/g, '<em>$1</em>');
    out.push(`<p${first ? ' class="first"' : ''}>${body}</p>`);
    first = false;
  }
  return out.join('\n');
}

function xhtmlDoc(title: string, body: string, isNav = false): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
    `<head><meta charset="utf-8"/><title>${esc(title)}</title>` +
    '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
    `<body${isNav ? ' epub:type="toc"' : ''}>\n${body}\n</body>\n</html>`
  );
}

function chapterLabel(n: number | null, index: number): string {
  if (n === 0) return 'Prologue';
  return `Chapter ${n ?? index + 1}`;
}

export async function buildEpub(opts: EpubOptions): Promise<Buffer> {
  const { title, author, markDrafts = true } = opts;
  const chapters = (opts.chapters || []).filter((c) => (c.content_text || '').trim().length > 0);
  if (chapters.length === 0) throw new Error('NO_CHAPTERS');

  const now = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const bookId = opts.bookId ?? `urn:uuid:${crypto.randomUUID()}`;
  const words = chapters.reduce((a, c) => a + (c.content_text || '').split(/\s+/).filter(Boolean).length, 0);

  const docs: { name: string; xhtml: string }[] = [];
  const navItems: string[] = [];
  const cover = opts.cover ?? null;

  // The cover page goes FIRST in the spine so the book opens on the artwork.
  if (cover) {
    docs.push({
      name: 'cover.xhtml',
      xhtml: xhtmlDoc(
        title,
        '<div style="text-align:center;margin:0;padding:0;">' +
          `<img src="cover.${cover.ext}" alt="${esc(title)}" style="max-width:100%;max-height:100vh;"/>` +
          '</div>',
      ),
    });
  }

  docs.push({
    name: 'title.xhtml',
    xhtml: xhtmlDoc(
      title,
      `<div class="title-page"><h1>${esc(title)}</h1>` +
        (author ? `<p class="sub">${esc(author)}</p>` : '') +
        `<p class="sub">${chapters.length} chapters · ${words.toLocaleString('en-US')} words</p>` +
        `<p class="sub">Exported ${now.slice(0, 10)} from Writer's Workbench</p></div>`,
    ),
  });

  chapters.forEach((c, i) => {
    const n = c.chapter_number;
    const name = `ch${String(n ?? i + 1).padStart(3, '0')}.xhtml`;
    const label = chapterLabel(n, i);
    const chTitle = (c.title || label).trim();
    const isDraft = c.status !== 'approved' && c.status !== 'published';
    const draftNote = markDrafts && isDraft ? '<p class="draft">Draft — not yet approved</p>\n' : '';
    const body =
      `<h1><span class="num">${esc(label)}</span>${esc(chTitle)}</h1>\n` +
      draftNote +
      proseToXhtml(c.content_text || '');
    docs.push({ name, xhtml: xhtmlDoc(`${label} — ${chTitle}`, body) });
    navItems.push(`<li><a href="${name}">${esc(label)}. ${esc(chTitle)}</a></li>`);
  });

  const navDoc = xhtmlDoc(
    'Contents',
    `<nav epub:type="toc" id="toc"><h1>Contents</h1>\n<ol>\n${navItems.join('\n')}\n</ol>\n</nav>`,
    true,
  );

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...(cover
      ? [
          `<item id="cover-image" href="cover.${cover.ext}" ` +
            `media-type="${cover.ext === 'png' ? 'image/png' : 'image/jpeg'}" properties="cover-image"/>`,
        ]
      : []),
    ...docs.map((d, i) => `<item id="x${i}" href="${d.name}" media-type="application/xhtml+xml"/>`),
  ].join('\n');
  const spine = docs.map((_, i) => `<itemref idref="x${i}"/>`).join('\n');

  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    `<dc:identifier id="bookid">${esc(bookId)}</dc:identifier>\n` +
    `<dc:title>${esc(title)}</dc:title>\n` +
    (author ? `<dc:creator>${esc(author)}</dc:creator>\n` : '') +
    '<dc:language>en</dc:language>\n' +
    `<meta property="dcterms:modified">${now}</meta>\n` +
    // The legacy EPUB 2 form. Several readers — including some Kindle paths — still look for it
    // when choosing the shelf thumbnail, and declaring both costs one line.
    (cover ? '<meta name="cover" content="cover-image"/>\n' : '') +
    '</metadata>\n' +
    `<manifest>\n${manifest}\n</manifest>\n` +
    `<spine>\n${spine}\n</spine>\n` +
    '</package>';

  const zip = new JSZip();
  // FIRST and STORED. JSZip writes entries in insertion order, so this must be added before
  // anything else, and with compression explicitly disabled.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
      '</container>',
  );
  zip.file('OEBPS/content.opf', opf);
  zip.file('OEBPS/style.css', CSS);
  zip.file('OEBPS/nav.xhtml', navDoc);
  // Already a compressed image format; deflating again costs time and saves nothing.
  if (cover) zip.file(`OEBPS/cover.${cover.ext}`, cover.data, { compression: 'STORE' });
  for (const d of docs) zip.file(`OEBPS/${d.name}`, d.xhtml);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export function epubFilename(title: string): string {
  const safe = (title || 'book').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'book';
  return `${safe}.epub`;
}
