/**
 * A series: one manuscript, sold as several books, each with its own title.
 *
 * The planner decides where the books break; this decides what each book is CALLED, how the
 * series is pitched, and holds the drafts of revised endings the author has asked for. All of it
 * lives on the project outline under `_series`, beside `_volume_plan`.
 *
 * A title is chosen for a book's chapter range. When the planner later moves a break, the title is
 * kept but flagged as chosen for different chapters: renaming a book silently because its last
 * chapter moved would be wrong, and so would keeping it without saying so.
 */

import { createHash } from 'node:crypto';

export interface SeriesBookTitle {
  title: string;
  first_chapter: number;
  last_chapter: number;
  source: 'suggested' | 'edited';
  chosen_at: string;
}

export interface TitleSuggestion {
  title: string;
  phrase: string;
  why: string;
}

export interface EndingDraft {
  content_id: string;
  chapter_number: number;
  chapter_title: string;
  replace_from: string;
  offset: number;
  current_ending: string;
  new_ending: string;
  words: number;
  resolved: string;
  carried: string;
  new_names: string[];
  drafted_at: string;
  applied_at?: string;
}

/**
 * A closing scene drafted for the end of one book. The engine plans it as a chapter-outline entry, researches
 * it, writes it from the book's craft, arc and cast, and checks it for drift; it waits here until the author has
 * read it, edited it and applied it.
 */
export interface CodaDraft {
  content_id: string;
  /** Hash of the chapter's text when the scene was written for it: apply refuses if the chapter has moved on. */
  base_hash: string;
  chapter_number: number;
  chapter_title: string;
  next_chapter_number: number | null;
  text: string;
  words: number;
  /** The chapter-outline entry for the scene (a sub-chapter brief). */
  brief: Record<string, unknown>;
  hook: string;
  resolved: string;
  carried: string;
  outline_beat: string;
  next_bridge: string;
  research_topics: string[];
  research: string;
  drift: unknown;
  qa: Record<string, number> | null;
  new_names: string[];
  direction: string;
  drafted_at: string;
  edited_at?: string;
  applied_at?: string;
}

/** A "previously" recap drafted for the front of a book, from the earlier books only. */
export interface RecapPiece {
  content_id: string;
  base_hash: string;
  chapter_number: number;
  chapter_title: string;
  text: string;
  words: number;
  sources: number;
  new_names: string[];
  drafted_at: string;
  edited_at?: string;
  applied_at?: string;
}

export interface StoredSeries {
  name?: string;
  description?: { text: string; tagline: string; source: 'generated' | 'edited'; updated_at: string };
  books?: Record<string, SeriesBookTitle>;
  suggestions?: Record<string, TitleSuggestion[]>;
  suggested_at?: string;
  endings?: Record<string, EndingDraft>;
  codas?: Record<string, CodaDraft>;
  recaps?: Record<string, RecapPiece>;
}

export interface PlannedBook {
  index: number;
  first_chapter: number;
  last_chapter: number;
  estimated_pages?: number;
  ending_score?: number;
  ending_title?: string;
  ending_reason?: string;
  ending_resolves?: string;
  ending_carries?: string;
}

type Outline = Record<string, unknown>;

const ORDINALS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

export function bookOrdinal(index: number): string {
  return ORDINALS[index] ?? String(index);
}

export function storedSeries(outline: Outline | null): StoredSeries {
  return ((outline?._series as StoredSeries | undefined) ?? {}) as StoredSeries;
}

export function plannedBooks(outline: Outline | null): PlannedBook[] {
  const plan = outline?._volume_plan as { volumes?: PlannedBook[] } | undefined;
  return (plan?.volumes ?? []).map((v) => ({ ...v }));
}

/** The series name: the author's, or the project title until they choose one. */
export function seriesName(outline: Outline | null, projectTitle: string): string {
  return storedSeries(outline).name?.trim() || projectTitle;
}

/** The title a book is published under. Empty until the author chooses one. */
export function bookTitle(outline: Outline | null, index: number): string {
  return storedSeries(outline).books?.[String(index)]?.title?.trim() ?? '';
}

/** What the screen shows: every planned book with its title, its ending and the drafts. */
export function seriesView(outline: Outline | null, projectTitle: string) {
  const s = storedSeries(outline);
  const books = plannedBooks(outline).map((b) => {
    const chosen = s.books?.[String(b.index)];
    return {
      ...b,
      title: chosen?.title ?? '',
      title_source: chosen?.source ?? null,
      // Chosen for a different stretch of the manuscript than the book now covers.
      title_stale: Boolean(chosen && (chosen.first_chapter !== b.first_chapter || chosen.last_chapter !== b.last_chapter)),
      suggestions: s.suggestions?.[String(b.index)] ?? [],
      ending_draft: s.endings?.[String(b.index)] ?? null,
      coda_draft: s.codas?.[String(b.index)] ?? null,
      recap_draft: s.recaps?.[String(b.index)] ?? null,
    };
  });
  return {
    name: seriesName(outline, projectTitle),
    name_is_default: !s.name?.trim(),
    description: s.description ?? null,
    suggested_at: s.suggested_at ?? null,
    books,
  };
}

export function withSeries(outline: Outline, patch: (s: StoredSeries) => StoredSeries): Outline {
  return { ...outline, _series: patch({ ...storedSeries(outline) }) };
}

// ---------------------------------------------------------------------------------------------
// Closing scenes and recaps: how they sit in the book and in its outline
// ---------------------------------------------------------------------------------------------

export const SCENE_BREAK = '\n\n---\n\n';

/** The fingerprint of a chapter's text, for "has this chapter changed since the piece was written for it". */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The chapter with the closing scene after it, set off by the book's own scene break. */
export function chapterWithCoda(chapterText: string, coda: string): string {
  return `${chapterText.trimEnd()}${SCENE_BREAK}${coda.trim()}\n`;
}

export function recapHeading(seriesTitle: string): string {
  return `**Previously, in ${seriesTitle}**`;
}

/** The chapter with the recap before it. */
export function chapterWithRecap(chapterText: string, seriesTitle: string, recap: string): string {
  return `${recapHeading(seriesTitle)}\n\n${recap.trim()}${SCENE_BREAK}${chapterText.trimStart()}`;
}

type Chapter = Record<string, unknown>;

function mapChapter(outline: Outline, chapterNumber: unknown, edit: (c: Chapter) => Chapter): Outline {
  const chapters = (outline.chapters as Chapter[] | undefined) ?? [];
  return {
    ...outline,
    chapters: chapters.map((c) => (String(c?.chapter_number) === String(chapterNumber) ? edit({ ...c }) : c)),
  };
}

/**
 * The outline after a closing scene is applied, so the outline says what the book now contains: the chapter's
 * beat names the scene, its chapter outline gains the scene as its last sub-chapter (only when the chapter
 * already has one: a chapter rewritten from a list holding only the scene would lose the rest), and the next
 * book's first chapter records how it picks up from it.
 */
export function outlineWithCoda(outline: Outline, d: CodaDraft): Outline {
  let next = mapChapter(outline, d.chapter_number, (c) => {
    const beat = String(c.beat ?? '').trim();
    if (d.outline_beat && !beat.includes(d.outline_beat)) c.beat = `${beat} ${d.outline_beat}`.trim();
    const co = c.chapter_outline as { sub_chapters?: unknown[] } | null | undefined;
    if (co && Array.isArray(co.sub_chapters) && co.sub_chapters.length) {
      c.chapter_outline = { ...co, sub_chapters: [...co.sub_chapters, { ...d.brief, number: co.sub_chapters.length + 1 }] };
    }
    return c;
  });
  if (d.next_chapter_number != null && d.next_bridge) {
    next = mapChapter(next, d.next_chapter_number, (c) => {
      const bridge = String(c.bridge_from_prior ?? '').trim();
      if (!bridge.includes(d.next_bridge)) c.bridge_from_prior = `${bridge} After the closing scene of the previous book: ${d.next_bridge}`.trim();
      return c;
    });
  }
  return next;
}

/** The outline after a recap is applied: the chapter it opens records that it begins with one. */
export function outlineWithRecap(outline: Outline, chapterNumber: number): Outline {
  const note = 'Opens with a spoken recap of the previous book.';
  return mapChapter(outline, chapterNumber, (c) => {
    const bridge = String(c.bridge_from_prior ?? '').trim();
    if (!bridge.includes(note)) c.bridge_from_prior = `${bridge} ${note}`.trim();
    return c;
  });
}
