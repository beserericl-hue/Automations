/**
 * The project's Series Bible — the canon card the engine keeps for every outlined book.
 *
 * The engine writes it on every outline save (writer_engine.persist_helpers.persist_canon) as ONE
 * story_bible_v2 row: entry_type "concept", name "Series Bible", and a description of labelled lines
 *
 *   SYNOPSIS: …
 *   STORY ARC: …
 *   TARGET CHAPTER COUNT: 12
 *   DRAMATIC QUESTION: …
 *
 * It is what a later chapter is written against, so it gets a panel of its own instead of sitting in
 * the Story Bible grid as a "concept" card cut off after three lines. The grid leaves it out so it is
 * not shown twice.
 */

import type { StoryBibleEntry } from '../../types/database';

export const SERIES_BIBLE_NAME = 'Series Bible';

export function isSeriesBibleEntry(e: Pick<StoryBibleEntry, 'name' | 'entry_type'>): boolean {
  return (e.name || '').trim().toLowerCase() === SERIES_BIBLE_NAME.toLowerCase() && e.entry_type === 'concept';
}

/** The project's Series Bible row (the most recently updated, should there be more than one). */
export function pickSeriesBible(entries: StoryBibleEntry[] | undefined): StoryBibleEntry | null {
  const rows = (entries ?? []).filter(isSeriesBibleEntry);
  if (!rows.length) return null;
  return rows.reduce((a, b) => ((b.updated_at ?? '') > (a.updated_at ?? '') ? b : a));
}

export interface SeriesBibleFields {
  synopsis: string;
  storyArc: string;
  targetChapterCount: number | null;
  dramaticQuestion: string;
  /** Any other labelled line the engine adds later, in order, so a new field shows without a deploy. */
  other: Array<{ label: string; value: string }>;
}

const KNOWN: Record<string, 'synopsis' | 'storyArc' | 'targetChapterCount' | 'dramaticQuestion'> = {
  SYNOPSIS: 'synopsis',
  'STORY ARC': 'storyArc',
  'TARGET CHAPTER COUNT': 'targetChapterCount',
  'DRAMATIC QUESTION': 'dramaticQuestion',
};

/** Parse the engine's labelled description. A description with no labels is treated as the synopsis. */
export function parseSeriesBible(description: string | null | undefined): SeriesBibleFields {
  const out: SeriesBibleFields = { synopsis: '', storyArc: '', targetChapterCount: null, dramaticQuestion: '', other: [] };
  const text = (description ?? '').trim();
  if (!text) return out;
  const label = /^([A-Z][A-Z /&-]{1,40}):[ \t]*/gm;
  const marks: Array<{ label: string; start: number; end: number }> = [];
  for (let m = label.exec(text); m; m = label.exec(text)) marks.push({ label: m[1].trim(), start: m.index, end: m.index + m[0].length });
  if (!marks.length) {
    out.synopsis = text;
    return out;
  }
  if (marks[0].start > 0) out.synopsis = text.slice(0, marks[0].start).trim();
  marks.forEach((mk, i) => {
    const value = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : undefined).trim();
    const key = KNOWN[mk.label];
    if (key === 'targetChapterCount') {
      const n = parseInt(value, 10);
      out.targetChapterCount = Number.isFinite(n) ? n : null;
    } else if (key) {
      out[key] = value;
    } else if (value) {
      out.other.push({ label: mk.label, value });
    }
  });
  return out;
}

function titleCase(label: string): string {
  return label.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SeriesBiblePanel({
  entry,
  outlineChapterCount,
}: {
  entry: StoryBibleEntry | null;
  /** Chapters in the project's current outline, to flag a Series Bible that has fallen behind it. */
  outlineChapterCount?: number;
}) {
  if (!entry) {
    return (
      <div
        data-testid="series-bible-empty"
        className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
      >
        <span className="font-semibold text-gray-700 dark:text-gray-200">Series Bible</span> — none yet. It is written
        when the engine saves an outline for this project.
      </div>
    );
  }
  const f = parseSeriesBible(entry.description);
  const stale =
    f.targetChapterCount != null && outlineChapterCount != null && outlineChapterCount > 0 && outlineChapterCount !== f.targetChapterCount;

  return (
    <section
      data-testid="series-bible"
      className="rounded-lg border border-brand-200 bg-white p-4 dark:border-brand-900 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Series Bible</h3>
        <span className="text-[10px] text-gray-400">Updated {new Date(entry.updated_at).toLocaleString()}</span>
      </div>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        The canon every chapter is written against. Kept by the engine and refreshed whenever the outline is saved.
      </p>

      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Story arc</dt>
          <dd data-testid="series-bible-arc" className="text-sm text-gray-800 dark:text-gray-200">
            {f.storyArc || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Target chapter count</dt>
          <dd data-testid="series-bible-chapters" className="text-sm font-semibold text-gray-900 dark:text-white">
            {f.targetChapterCount ?? '—'}
          </dd>
          {stale && (
            <dd data-testid="series-bible-stale" className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
              The outline now has {outlineChapterCount} chapters; this updates the next time the outline is saved.
            </dd>
          )}
        </div>
        <div className="sm:col-span-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Synopsis</dt>
          <dd data-testid="series-bible-synopsis" className="whitespace-pre-line text-sm leading-relaxed text-gray-800 dark:text-gray-200">
            {f.synopsis || '—'}
          </dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Dramatic question</dt>
          <dd data-testid="series-bible-question" className="text-sm italic text-gray-800 dark:text-gray-200">
            {f.dramaticQuestion || '—'}
          </dd>
        </div>
        {f.other.map((o) => (
          <div key={o.label} className="sm:col-span-3" data-testid="series-bible-other">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{titleCase(o.label)}</dt>
            <dd className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">{o.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
