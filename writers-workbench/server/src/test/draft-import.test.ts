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

import { planOf } from '../routes/draft-import.js';
describe('titles in the file win', () => {
  it('flags a renamed chapter and leaves a matching or untitled one alone', () => {
    const existing = new Map([
      [1, { id: 'a', chapter_number: 1, title: 'Old', status: 'draft', content_text: 'x' }],
      [2, { id: 'b', chapter_number: 2, title: 'Same', status: 'approved', content_text: 'x' }],
      [3, { id: 'c', chapter_number: 3, title: 'Kept', status: 'draft', content_text: 'x' }],
    ]);
    const plan = planOf(
      [
        { chapter_number: 1, title: 'New', text: 't', words: 1 },
        { chapter_number: 2, title: 'Same', text: 't', words: 1 },
        { chapter_number: 3, title: '', text: 't', words: 1 },
      ],
      existing,
    );
    expect(plan.map((p) => p.renamed_from)).toEqual(['Old', null, null]);
    expect(plan[2].title).toBe('Kept');
  });
});
