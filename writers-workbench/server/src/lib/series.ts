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

export interface StoredSeries {
  name?: string;
  description?: { text: string; tagline: string; source: 'generated' | 'edited'; updated_at: string };
  books?: Record<string, SeriesBookTitle>;
  suggestions?: Record<string, TitleSuggestion[]>;
  suggested_at?: string;
  endings?: Record<string, EndingDraft>;
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
