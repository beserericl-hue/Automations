import { describe, it, expect } from 'vitest';
import { buildManuscriptDraft } from '../lib/draft-docx.js';
import { chaptersFromDocx, chaptersFromHtml, headingOf } from '../lib/draft-import.js';

describe('reading an edited draft back', () => {
  const chapters = [
    { chapter_number: 0, title: 'The Surface', content_text: 'She *ran* away.\n\n---\n\nNext morning.' },
    { chapter_number: 2, title: 'The Box', content_text: '<p>Dear <em>Marcus</em>,</p><p>I am writing.</p>' },
    { chapter_number: 999, title: 'After', content_text: 'The end.' },
  ];

  it('round-trips what Export Draft wrote, by chapter number', async () => {
    const got = await chaptersFromDocx(await buildManuscriptDraft({ title: 'The Ossuary', outline: null }, chapters));
    expect(got.map((c) => c.chapter_number)).toEqual([0, 2, 999]);
    expect(got[0].title).toBe('The Surface');
    expect(got[0].text).toBe('She *ran* away.\n\n---\n\nNext morning.');
    expect(got[1].text).toBe('Dear *Marcus*,\n\nI am writing.');
    expect(got[2].title).toBe('After');
  });

  it('reads a one-book file: the book title page and the contents list are not chapters or text', async () => {
    const books = [{ index: 2, title: 'The Box', first_chapter: 2, last_chapter: 3 }];
    const got = await chaptersFromDocx(await buildManuscriptDraft({ title: 'The Ossuary', outline: null }, chapters, books));
    expect(got.map((c) => c.chapter_number)).toEqual([2, 999]);
    expect(got.find((c) => c.chapter_number === 2)!.text).toBe('Dear *Marcus*,\n\nI am writing.');
  });

  it('recognises the heading forms and ignores a body line that merely mentions a chapter', () => {
    expect(headingOf('Chapter 12: The Dig')).toEqual({ n: 12, title: 'The Dig' });
    expect(headingOf('Prologue')).toEqual({ n: 0, title: '' });
    expect(headingOf('Epilogue: After')).toEqual({ n: 999, title: 'After' });
    expect(headingOf('In chapter 3 she left.')).toBeNull();
  });

  it('keeps the chapter with text when a heading is repeated (a contents list)', () => {
    const got = chaptersFromHtml('<p>Chapter 1: A</p><p>Chapter 2: B</p><h1>Chapter 1: A</h1><p>Real text.</p><h1>Chapter 2: B</h1><p>More &amp; more.</p>');
    expect(got.map((c) => [c.chapter_number, c.text])).toEqual([[1, 'Real text.'], [2, 'More & more.']]);
  });
});
