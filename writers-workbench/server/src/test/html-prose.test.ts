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
