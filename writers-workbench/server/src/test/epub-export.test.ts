/**
 * EPUB export — the pre-publish read.
 *
 * Most of what makes a hand-built EPUB fail is invisible until an actual reader refuses to open it,
 * and by then the author has emailed the file to someone. So the structural rules are asserted
 * here rather than trusted: mimetype first and uncompressed, well-formed XHTML, a spine that
 * matches the manifest, and prose escaping that survives the characters a real novel contains.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildEpub, proseToXhtml, epubFilename, type EpubChapter } from '../lib/epub.js';

const FIXED = { now: new Date('2026-10-20T12:00:00Z'), bookId: 'urn:uuid:test' };

function ch(over: Partial<EpubChapter> = {}): EpubChapter {
  return {
    chapter_number: 1,
    title: 'The Petition',
    content_text: 'He drove south on Route 210.\n\nThe heater ticked as it cooled.',
    status: 'draft',
    ...over,
  };
}

async function openEpub(chapters: EpubChapter[], opts: Record<string, unknown> = {}) {
  const buf = await buildEpub({ title: 'The Ossuary', chapters, ...FIXED, ...opts });
  return { buf, zip: await JSZip.loadAsync(buf) };
}

describe('archive structure — the rules readers actually enforce', () => {
  it('puts mimetype first and STORES it uncompressed', async () => {
    // The single commonest reason a hand-rolled EPUB opens in one reader and not another: readers
    // sniff these bytes at a fixed offset, which only works if the entry is first and not deflated.
    const { buf, zip } = await openEpub([ch()]);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
    // Verify at the byte level, not via the library's own bookkeeping. In a local file header the
    // 30-byte fixed part is followed by the NAME, then the data — which is exactly the layout
    // epubcheck relies on.
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    expect(buf.readUInt16LE(8)).toBe(0); // compression method 0 = STORE
    expect(buf.subarray(30, 38).toString('latin1')).toBe('mimetype');
    const dataAt = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
    expect(buf.subarray(dataAt, dataAt + 20).toString('latin1')).toBe('application/epub+zip');
  });

  it('carries the container, package, nav and stylesheet', async () => {
    const { zip } = await openEpub([ch()]);
    for (const f of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/style.css']) {
      expect(zip.file(f), `${f} missing`).toBeTruthy();
    }
  });

  it('gives every chapter its own document', async () => {
    const { zip } = await openEpub([ch({ chapter_number: 1 }), ch({ chapter_number: 2 })]);
    expect(zip.file('OEBPS/ch001.xhtml')).toBeTruthy();
    expect(zip.file('OEBPS/ch002.xhtml')).toBeTruthy();
  });

  it('keeps the spine and manifest in step', async () => {
    const { zip } = await openEpub([ch({ chapter_number: 1 }), ch({ chapter_number: 2 })]);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    // title page + 2 chapters in the spine; manifest adds nav and css.
    expect((opf.match(/<itemref/g) || []).length).toBe(3);
    expect((opf.match(/<item /g) || []).length).toBe(5);
  });

  it('refuses to build a book with nothing in it', async () => {
    await expect(buildEpub({ title: 'x', chapters: [], ...FIXED })).rejects.toThrow('NO_CHAPTERS');
  });

  it('ignores chapters that have no text rather than emitting empty documents', async () => {
    const { zip } = await openEpub([ch({ chapter_number: 1 }), ch({ chapter_number: 2, content_text: '   ' })]);
    expect(zip.file('OEBPS/ch002.xhtml')).toBeNull();
  });
});

describe('prose conversion', () => {
  it('splits paragraphs on blank lines', () => {
    expect((proseToXhtml('One.\n\nTwo.').match(/<p/g) || []).length).toBe(2);
  });

  it('renders a scene break as a dinkus, not a rule', () => {
    const out = proseToXhtml('One.\n\n---\n\nTwo.');
    expect(out).toContain('class="dinkus"');
    expect(out).not.toContain('<hr');
  });

  it('turns *word* into emphasis', () => {
    expect(proseToXhtml('She said *nothing* at all.')).toContain('<em>nothing</em>');
  });

  it('escapes BEFORE marking up, so prose with & and < stays valid XHTML', () => {
    // Both appear in real manuscripts — "Fire & Water", and dialogue or notation using angle
    // brackets. Escaping after markup would corrupt the document.
    const out = proseToXhtml('Fire & Water <not a tag> and *this*.');
    expect(out).toContain('&amp;');
    expect(out).toContain('&lt;not a tag&gt;');
    expect(out).toContain('<em>this</em>');
  });

  it('does not turn arithmetic or a stray asterisk into italics', () => {
    // Real bug this caught: "5 * 3 and 2 * 4" rendered as "5 <em> 3 and 2 </em> 4", italicising
    // half a sentence. Emphasis must hug its text.
    expect(proseToXhtml('5 * 3 and 2 * 4')).not.toContain('<em>');
    expect(proseToXhtml('a * b')).not.toContain('<em>');
  });

  it('still italicises a single word and a phrase', () => {
    expect(proseToXhtml('say *now*')).toContain('<em>now</em>');
    expect(proseToXhtml('say *right now*')).toContain('<em>right now</em>');
  });

  it('starts a new scene unindented after a break', () => {
    const out = proseToXhtml('One.\n\n---\n\nTwo.');
    expect((out.match(/class="first"/g) || []).length).toBe(2);
  });

  it('collapses a hard-wrapped paragraph into one line', () => {
    expect(proseToXhtml('A line\nwrapped here.')).toBe('<p class="first">A line wrapped here.</p>');
  });
});

describe('every document is well-formed XML', () => {
  it('parses each XHTML file', async () => {
    const { zip } = await openEpub([
      ch({ content_text: 'Fire & Water.\n\n---\n\n*Italic* and <angle> brackets.' }),
    ]);
    const { DOMParser } = await import('@xmldom/xmldom').catch(() => ({ DOMParser: null }) as never);
    const names = Object.keys(zip.files).filter((n) => /\.(xhtml|opf|xml)$/.test(n));
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) {
      const xml = await zip.file(n)!.async('string');
      // No parser dependency required: assert the invariants that break readers.
      expect(xml.startsWith('<?xml'), `${n} missing XML declaration`).toBe(true);
      const bare = xml.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, '');
      expect(bare.includes('&'), `${n} has an unescaped ampersand`).toBe(false);
      if (DOMParser) {
        let failed = '';
        const doc = new DOMParser({
          onError: (_l: unknown, m: string) => {
            failed = m;
          },
        }).parseFromString(xml, 'text/xml');
        expect(failed, `${n}: ${failed}`).toBe('');
        expect(doc).toBeTruthy();
      }
    }
  });
});

describe('drafts are visible as drafts', () => {
  it('marks an unapproved chapter', async () => {
    const { zip } = await openEpub([ch({ status: 'draft' })]);
    expect(await zip.file('OEBPS/ch001.xhtml')!.async('string')).toContain('Draft — not yet approved');
  });

  it('does not mark an approved one', async () => {
    const { zip } = await openEpub([ch({ status: 'approved' })]);
    expect(await zip.file('OEBPS/ch001.xhtml')!.async('string')).not.toContain('not yet approved');
  });

  it('can be turned off for a clean read', async () => {
    const { zip } = await openEpub([ch({ status: 'draft' })], { markDrafts: false });
    expect(await zip.file('OEBPS/ch001.xhtml')!.async('string')).not.toContain('not yet approved');
  });
});

describe('navigation', () => {
  it('lists every chapter in the table of contents', async () => {
    const { zip } = await openEpub([
      ch({ chapter_number: 0, title: 'The Surface' }),
      ch({ chapter_number: 1, title: 'The Petition' }),
    ]);
    const nav = await zip.file('OEBPS/nav.xhtml')!.async('string');
    expect((nav.match(/<a href=/g) || []).length).toBe(2);
    // Chapter 0 is the prologue in this project's numbering, not "Chapter 0".
    expect(nav).toContain('Prologue. The Surface');
    expect(nav).toContain('Chapter 1. The Petition');
  });

  it('escapes a title containing markup characters', async () => {
    const { zip } = await openEpub([ch({ title: 'Marcus & "the <box>"' })]);
    const nav = await zip.file('OEBPS/nav.xhtml')!.async('string');
    expect(nav).toContain('&amp;');
    expect(nav).not.toContain('<box>');
  });
});

describe('filename', () => {
  it('is derived safely from the title', () => {
    expect(epubFilename('The Ossuary')).toBe('The_Ossuary.epub');
    expect(epubFilename('Marcus & Co: Vol. 1')).toBe('Marcus_Co_Vol_1.epub');
  });

  it('never produces a bare extension', () => {
    expect(epubFilename('!!!')).toBe('book.epub');
    expect(epubFilename('')).toBe('book.epub');
  });
});
