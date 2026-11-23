import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildManuscriptDraft, buildOutlineDraft, chapterLabel } from '../lib/draft-docx.js';

const xmlOf = async (buf: Buffer): Promise<string> => (await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string'));

describe('the hard-copy draft', () => {
  const chapters = [
    { chapter_number: 0, title: 'The Surface', content_text: 'She *ran* & did not look back.\n\n---\n\nNext morning.' },
    { chapter_number: 2, title: 'The Box', content_text: '<p>Dear <em>Marcus</em>,</p><div data-format-block="" data-font="typewriter" data-size="95" data-align="center" data-indent="1" data-spacing="1.4" data-italic="false"><p>I am writing.</p></div>' },
    { chapter_number: 3, title: 'Empty', content_text: '   ' },
    { chapter_number: 999, title: 'After', content_text: 'The end.' },
  ];

  it('lists every chapter title, then the whole manuscript, whatever the status', async () => {
    const xml = await xmlOf(await buildManuscriptDraft({ title: 'The Ossuary', outline: null }, chapters));
    for (const t of ['The Ossuary', 'Prologue: The Surface', 'Chapter 2: The Box', 'Epilogue: After', 'She ', 'did not look back.', 'Next morning.', 'I am writing.']) {
      expect(xml).toContain(t);
    }
    expect(xml).not.toContain('Chapter 3: Empty');
    expect(xml).not.toContain('&lt;p&gt;');
    // The contents list names each chapter once before the chapters themselves.
    expect(xml.indexOf('Chapters')).toBeLessThan(xml.indexOf('She '));
    expect(xml.match(/Chapter 2: The Box/g)).toHaveLength(2);
  });

  it('keeps italics, a scene break and a formatting block\'s look', async () => {
    const xml = await xmlOf(await buildManuscriptDraft({ title: 'T', outline: null }, chapters));
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('* * *');
    expect(xml).toContain('Courier New');
    expect(xml).toContain('w:jc w:val="center"');
  });

  it('limits the draft to the books asked for, each under its own book title', async () => {
    const books = [
      { index: 1, title: 'The Margin', first_chapter: 0, last_chapter: 1 },
      { index: 2, title: 'The Box', first_chapter: 2, last_chapter: 3 },
    ];
    const two = await xmlOf(await buildManuscriptDraft({ title: 'The Ossuary', outline: null }, chapters, [books[1]]));
    expect(two).toContain('Book Two: The Box');
    expect(two).toContain('Chapter 2: The Box');
    expect(two).toContain('Epilogue: After');
    expect(two).not.toContain('Prologue: The Surface');
    expect(two).not.toContain('Book One');
    const both = await xmlOf(await buildManuscriptDraft({ title: 'The Ossuary', outline: null }, chapters, books));
    expect(both).toContain('Book One: The Margin');
    expect(both).toContain('Prologue: The Surface');
    expect(both).toContain('Book Two: The Box');
  });

  it('writes the outline: premise, characters, each chapter and its chapter outline', async () => {
    const xml = await xmlOf(
      await buildOutlineDraft({
        title: 'The Ossuary',
        outline: {
          premise: 'Four ossuaries on the Potomac.',
          characters: [{ name: 'Marcus', role: 'lead', description: 'Preservation officer' }],
          chapters: [
            { chapter_number: 25, title: 'The Survey', act: 'The Surface', beat: 'Sylvia runs the radar.', arc_point: 'Frame', chapter_outline: { chapter_summary: 'Survey day', sub_chapters: [{ number: 1, title: 'Dawn', brief: 'She arrives.', setting: 'The bluff' }] } },
            { number: 'Prologue', title: 'Before', brief: 'A beginning.', chapter_outline: [{ title: 'Old style', brief: 'A list entry.' }] },
          ],
        },
      }),
    );
    for (const t of ['Four ossuaries on the Potomac.', 'Marcus (lead):', 'Preservation officer', 'Chapter 25: The Survey', 'Sylvia runs the radar.', 'Survey day', '1. Dawn:', 'She arrives.', 'Setting: The bluff', 'Prologue: Before', 'A list entry.']) {
      expect(xml).toContain(t);
    }
  });

  it('labels prologue, epilogue and numbered chapters', () => {
    expect([chapterLabel(0, 'A'), chapterLabel(999, 'B'), chapterLabel(7, 'C'), chapterLabel(7, null), chapterLabel(null, 'D')]).toEqual([
      'Prologue: A', 'Epilogue: B', 'Chapter 7: C', 'Chapter 7', 'D',
    ]);
    // A title that already names itself a prologue or epilogue is not given the word twice.
    expect([chapterLabel(0, 'Prologue: The Surface'), chapterLabel(999, 'Epilogue')]).toEqual(['Prologue: The Surface', 'Epilogue']);
  });
});
