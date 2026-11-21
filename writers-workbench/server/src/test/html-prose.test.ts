import { describe, it, expect } from 'vitest';
import { htmlToProse, looksLikeHtml } from '../lib/html-prose.js';
import { proseToXhtml } from '../lib/epub.js';

describe('a chapter saved from the editor, read as prose', () => {
  const HTML = '<p>She <em>ran</em>, &amp; did not look back.</p><p>&ldquo;Now,&rdquo; he said.</p><hr><p>Next morning.</p>';

  it('keeps paragraphs, italics, scene breaks and entities', () => {
    expect(htmlToProse(HTML)).toBe('She *ran*, & did not look back.\n\n“Now,” he said.\n\n---\n\nNext morning.');
  });

  it('leaves plain text exactly as it was', () => {
    const plain = 'One.\n\nTwo with a <not a tag> and 3 < 4.\n\n---\n\nThree *italic*.';
    expect(looksLikeHtml(plain)).toBe(false);
    expect(htmlToProse(plain)).toBe(plain);
  });

  it('turns headings, lists and quotes into paragraphs of their own', () => {
    expect(htmlToProse('<h2>Part One</h2><blockquote><p>A letter.</p></blockquote><ul><li>a</li><li>b</li></ul>')).toBe(
      'Part One\n\nA letter.\n\na\n\nb',
    );
  });

  it('gives the EPUB real paragraphs and emphasis, not the tags as letters', () => {
    const xhtml = proseToXhtml(htmlToProse(HTML));
    expect(xhtml).toContain('<em>ran</em>');
    expect(xhtml).toContain('class="dinkus"');
    expect(xhtml).not.toContain('&lt;p&gt;');
  });
});

import { stripBlockMarkers, cleanBlockStyle, blockCss } from '../lib/html-prose.js';
import { paragraphsOf, buildPrintPdf } from '../lib/print-pdf.js';

describe('a formatting block through the book files', () => {
  const HTML =
    '<p>He opened the envelope.</p><div data-format-block="" data-font="typewriter" data-size="95" data-align="left" data-indent="2" data-spacing="1.4" data-italic="false" data-preset="Letter"><p>Dear Marcus,</p><p>I am writing about the box.</p></div><p>He read it twice.</p>';

  it('is fenced in the prose, with its style, and the paragraphs around it are untouched', () => {
    const prose = htmlToProse(HTML);
    expect(prose).toBe(
      'He opened the envelope.\n\n:::block {"preset":"Letter","font":"typewriter","size":95,"align":"left","indent":2,"spacing":1.4,"italic":false}\n\nDear Marcus,\n\nI am writing about the box.\n\n:::\n\nHe read it twice.',
    );
  });

  it('becomes a styled div in the EPUB', () => {
    const xhtml = proseToXhtml(htmlToProse(HTML));
    expect(xhtml).toContain('<div class="fb" style="font-family:');
    expect(xhtml).toContain('Courier');
    expect(xhtml).toContain('margin:1em 0 1em 2em');
    expect(xhtml).toContain('<p class="fbp">Dear Marcus,</p>');
    expect(xhtml.match(/<div/g)).toHaveLength(1);
    expect(xhtml.match(/<\/div>/g)).toHaveLength(1);
    expect(xhtml).not.toContain(':::');
  });

  it('is read aloud and word-counted as its words only', () => {
    const spoken = stripBlockMarkers(htmlToProse(HTML));
    expect(spoken).toBe('He opened the envelope.\n\nDear Marcus,\n\nI am writing about the box.\n\nHe read it twice.');
    expect(stripBlockMarkers('Plain *text*.\n\n---\n\nMore.')).toBe('Plain *text*.\n\n---\n\nMore.');
  });

  it('keeps its style for the print interior, on the paragraphs inside it only', () => {
    const p = paragraphsOf(htmlToProse(HTML));
    expect(p.map((x) => x.text)).toEqual(['He opened the envelope.', 'Dear Marcus,', 'I am writing about the box.', 'He read it twice.']);
    expect(p.map((x) => x.block?.font)).toEqual([undefined, 'typewriter', 'typewriter', undefined]);
  });

  it('clamps a style that is out of range or not on the list, so nothing arbitrary reaches the CSS', () => {
    const s = cleanBlockStyle({ font: 'comic-sans; background:url(x)', size: 9000, align: 'sideways', indent: -4, spacing: 99, italic: 'true' });
    expect(s).toEqual({ font: 'serif', size: 150, align: 'left', indent: 0, spacing: 3, italic: true });
    expect(blockCss(s)).not.toContain('url');
  });

  it('prints: a typewriter block builds a valid PDF with the typewriter face embedded', async () => {
    const out = await buildPrintPdf({
      title: 'T', author: 'A', trim: '6x9',
      chapters: [{ number: 1, title: 'One', text: htmlToProse(HTML) }],
    } as never);
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(out.pdf.toString('latin1')).toContain('CourierPrime');
  });
});
