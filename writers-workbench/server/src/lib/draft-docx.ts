/**
 * A hard-copy DRAFT of a project as Word documents: the outline (with every chapter's outline), and the
 * whole manuscript (the chapter titles listed, then every chapter in full).
 *
 * This is not the publishing export. It does not select approved chapters, set the trim size, or
 * typeset for print; it is for reading and marking up on paper or in Word. Every chapter that has text
 * is included whatever its status. A chapter the editor has saved as HTML is turned back into prose
 * first (html-prose.ts), so italics and paragraphs come out right, and a formatting block keeps its look.
 */
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  PageBreak,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from 'docx';
import { BLOCK_DEFAULTS, FONT_STACKS, htmlToProse, isBlockClose, isBlockOpen, type BlockStyle } from './html-prose.js';

const BODY_FONT = 'Times New Roman';
const BODY_SIZE = 24; // half-points: 12 pt
const LETTER = { width: 12240, height: 15840 };
const MARGINS = { top: 1440, bottom: 1440, left: 1440, right: 1440 };

export interface DraftChapter {
  chapter_number: number | null;
  title: string | null;
  content_text: string | null;
}

export interface DraftProject {
  title: string;
  outline: Record<string, unknown> | null;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function footer(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: 20 })],
      }),
    ],
  });
}

export function chapterLabel(n: number | null, title: string | null): string {
  const t = str(title);
  // A title that already says Prologue or Epilogue is not given the word twice.
  if (n === 0) return !t ? 'Prologue' : /^prologue\b/i.test(t) ? t : `Prologue: ${t}`;
  if (n === 999) return !t ? 'Epilogue' : /^epilogue\b/i.test(t) ? t : `Epilogue: ${t}`;
  if (n == null) return t || 'Untitled chapter';
  return t ? `Chapter ${n}: ${t}` : `Chapter ${n}`;
}

/** Inline `*italic*` in prose to runs. */
function runs(text: string, base: { font?: string; size?: number; italics?: boolean } = {}): TextRun[] {
  const out: TextRun[] = [];
  const re = /\*(\S|\S[^*\n]*\S)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const common = { font: base.font ?? BODY_FONT, size: base.size ?? BODY_SIZE };
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...common, italics: base.italics }));
    out.push(new TextRun({ text: m[1], ...common, italics: !base.italics }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...common, italics: base.italics }));
  return out.length ? out : [new TextRun({ text, ...common, italics: base.italics })];
}

const FONT_NAMES: Record<BlockStyle['font'], string> = {
  serif: 'Georgia',
  sans: 'Arial',
  typewriter: 'Courier New',
  handwriting: 'Segoe Script',
};
void FONT_STACKS;

const ALIGN: Record<BlockStyle['align'], (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

/** The paragraphs of one chapter's text. */
export function manuscriptParagraphs(content: string): Paragraph[] {
  const prose = htmlToProse(content || '');
  const out: Paragraph[] = [];
  let block: BlockStyle | null = null;
  let first = true;
  for (const raw of prose.split(/\n\s*\n/)) {
    const part = raw.trim();
    if (!part) continue;
    const opening = isBlockOpen(part);
    if (opening) {
      block = { ...BLOCK_DEFAULTS, ...opening };
      continue;
    }
    if (block && isBlockClose(part)) {
      block = null;
      first = true;
      continue;
    }
    if (/^-{3,}$/.test(part) || /^(\*\s*){3,}$/.test(part)) {
      out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 }, children: runs('* * *') }));
      first = true;
      continue;
    }
    const text = part.replace(/\s*\n\s*/g, ' ');
    if (block) {
      out.push(
        new Paragraph({
          alignment: ALIGN[block.align],
          indent: { left: Math.round(block.indent * 240) },
          spacing: { after: 120, line: Math.round(block.spacing * 240) },
          children: runs(text, { font: FONT_NAMES[block.font], size: Math.round((BODY_SIZE * block.size) / 100), italics: block.italic }),
        }),
      );
      continue;
    }
    out.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        indent: first ? undefined : { firstLine: 360 },
        spacing: { after: 120, line: 360 },
        children: runs(text),
      }),
    );
    first = false;
  }
  return out;
}

const heading = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel], size: number, before = 240): Paragraph =>
  new Paragraph({
    heading: level,
    spacing: { before, after: 120 },
    keepNext: true,
    children: [new TextRun({ text, bold: true, font: BODY_FONT, size })],
  });

const body = (text: string, opts: { bold?: string; italics?: boolean; indent?: number } = {}): Paragraph =>
  new Paragraph({
    spacing: { after: 100, line: 300 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [
      ...(opts.bold ? [new TextRun({ text: `${opts.bold} `, bold: true, font: BODY_FONT, size: 22 })] : []),
      new TextRun({ text, font: BODY_FONT, size: 22, italics: opts.italics }),
    ],
  });

/** The outline, then every chapter's outline, as readable paragraphs. */
export function outlineParagraphs(project: DraftProject): Paragraph[] {
  const o = (project.outline ?? {}) as Json;
  const out: Paragraph[] = [];
  out.push(
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 600, after: 120 }, children: [new TextRun({ text: str(o.title) || project.title, bold: true, font: BODY_FONT, size: 44 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 360 }, children: [new TextRun({ text: 'Outline (draft)', italics: true, font: BODY_FONT, size: 26 })] }),
  );
  if (str(o.premise)) {
    out.push(heading('Premise', HeadingLevel.HEADING_1, 30), body(str(o.premise)));
  }
  for (const [label, key] of [
    ['Dramatic question', 'dramatic_question'],
    ['Story arc', 'story_arc_name'],
  ] as const) {
    if (str(o[key])) out.push(body(str(o[key]), { bold: `${label}:` }));
  }
  const themes = arr(o.themes).map(str).filter(Boolean);
  if (themes.length) out.push(body(themes.join(', '), { bold: 'Themes:' }));

  const characters = arr(o.characters).filter((c): c is Json => typeof c === 'object' && c != null);
  if (characters.length) {
    out.push(heading('Characters', HeadingLevel.HEADING_1, 30, 360));
    for (const c of characters) {
      const role = str(c.role);
      out.push(body(str(c.description), { bold: `${str(c.name) || 'Unnamed'}${role ? ` (${role})` : ''}:` }));
    }
  }

  const chapters = arr(o.chapters).filter((c): c is Json => typeof c === 'object' && c != null);
  if (chapters.length) out.push(heading('Chapters', HeadingLevel.HEADING_1, 30, 360));
  for (const ch of chapters) {
    const n = ch.chapter_number ?? ch.number;
    const num = n == null || n === '' ? null : Number.isNaN(Number(n)) ? null : Number(n);
    const label = typeof n === 'string' && Number.isNaN(Number(n)) ? `${n}${str(ch.title) ? `: ${str(ch.title)}` : ''}` : chapterLabel(num, str(ch.title));
    out.push(heading(label, HeadingLevel.HEADING_2, 26, 300));
    const meta = [str(ch.act) && `Act: ${str(ch.act)}`, str(ch.pov_character) && `POV: ${str(ch.pov_character)}`].filter(Boolean).join('  ·  ');
    if (meta) out.push(body(meta, { italics: true }));
    const beat = str(ch.beat) || str(ch.brief) || str(ch.summary);
    if (beat) out.push(body(beat));
    if (str(ch.arc_point) || str(ch.arc_notes)) out.push(body(str(ch.arc_point) || str(ch.arc_notes), { bold: 'Arc:' }));
    if (str(ch.bridge_from_prior)) out.push(body(str(ch.bridge_from_prior), { bold: 'Picks up from the previous chapter:' }));
    const topics = arr(ch.research_topics).map(str).filter(Boolean);
    if (topics.length) out.push(body(topics.join('; '), { bold: 'Research:' }));

    // The chapter outline: an object with sub_chapters, or the older bare list.
    const co = ch.chapter_outline as Json | unknown[] | undefined;
    const subs = (Array.isArray(co) ? co : arr((co as Json | undefined)?.sub_chapters)).filter((s): s is Json => typeof s === 'object' && s != null);
    if (co && !Array.isArray(co)) {
      const c = co as Json;
      if (str(c.chapter_summary)) out.push(body(str(c.chapter_summary), { bold: 'Chapter outline:' }));
      if (str(c.chapter_story_arc)) out.push(body(str(c.chapter_story_arc), { bold: 'Chapter story arc:' }));
      if (str(c.book_arc_beat)) out.push(body(str(c.book_arc_beat), { bold: 'Book arc beat:' }));
    }
    subs.forEach((s, i) => {
      const sn = s.number ?? s.section_number ?? i + 1;
      out.push(body(str(s.brief), { bold: `${sn}. ${str(s.title)}`.trim() + ':', indent: 360 }));
      const detail = [
        str(s.setting) && `Setting: ${str(s.setting)}`,
        arr(s.characters).length && `Characters: ${arr(s.characters).map(str).join(', ')}`,
        str(s.emotional_tone) && `Tone: ${str(s.emotional_tone)}`,
        str(s.arc_beat) && `Arc beat: ${str(s.arc_beat)}`,
        str(s.connects_to_book_arc) && `Connects to the book arc: ${str(s.connects_to_book_arc)}`,
      ].filter(Boolean);
      for (const d of detail) out.push(body(String(d), { italics: true, indent: 720 }));
    });
  }
  return out;
}

const pageProps = { page: { size: LETTER, margin: MARGINS } };

export async function buildOutlineDraft(project: DraftProject): Promise<Buffer> {
  const doc = new Document({
    creator: 'Writers Workbench',
    title: `${project.title}: outline`,
    sections: [{ properties: pageProps, footers: { default: footer() }, children: outlineParagraphs(project) }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function buildManuscriptDraft(project: DraftProject, chapters: DraftChapter[]): Promise<Buffer> {
  const written = chapters.filter((c) => str(c.content_text));
  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 3600, after: 200 },
    children: [new TextRun({ text: project.title, bold: true, font: BODY_FONT, size: 56 })],
  });
  const sub = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: 'Manuscript (draft)', italics: true, font: BODY_FONT, size: 28 })],
  });
  const count = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `${written.length} chapters`, font: BODY_FONT, size: 24 })],
  });
  const contents: Paragraph[] = [
    new Paragraph({ children: [new PageBreak()] }),
    heading('Chapters', HeadingLevel.HEADING_1, 32, 0),
    ...written.map(
      (c) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: chapterLabel(c.chapter_number, c.title), font: BODY_FONT, size: 24 })] }),
    ),
  ];
  const chapterBlocks: Paragraph[] = [];
  for (const c of written) {
    chapterBlocks.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        alignment: AlignmentType.CENTER,
        spacing: { before: 480, after: 360 },
        keepNext: true,
        children: [new TextRun({ text: chapterLabel(c.chapter_number, c.title), bold: true, font: BODY_FONT, size: 32 })],
      }),
      ...manuscriptParagraphs(c.content_text ?? ''),
    );
  }
  const doc = new Document({
    creator: 'Writers Workbench',
    title: `${project.title}: manuscript`,
    sections: [{ properties: pageProps, footers: { default: footer() }, children: [title, sub, count, ...contents, ...chapterBlocks] }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
