/**
 * Series — a long manuscript sold as several books, each of which has to stand on its own.
 *
 * Every book gets its own title (suggested from its own pages, chosen by the author), and its own
 * ending: one that settles the story the book told and hands the reader a larger question for the
 * next. The planner scores each break on both; where the best break does not land, the engine can
 * draft a revised close, which the author reads beside the current one and accepts or not.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

export interface EndingDraft {
  chapter_number: number;
  chapter_title: string;
  current_ending: string;
  new_ending: string;
  words: number;
  replaced_words?: number;
  resolved: string;
  carried: string;
  new_names: string[];
  drafted_at: string;
  applied_at?: string;
}

export interface SeriesBook {
  index: number;
  first_chapter: number;
  last_chapter: number;
  estimated_pages?: number;
  words?: number;
  ending_score?: number;
  ending_title?: string;
  ending_reason?: string;
  ending_resolves?: string;
  ending_carries?: string;
  title: string;
  title_source: 'suggested' | 'edited' | null;
  title_stale: boolean;
  suggestions: { title: string; phrase: string; why: string }[];
  ending_draft: EndingDraft | null;
}

export interface SeriesView {
  name: string;
  name_is_default: boolean;
  description: { text: string; tagline: string; source: string; updated_at: string } | null;
  suggested_at: string | null;
  books: SeriesBook[];
}

interface Props {
  projectId: string;
  series: SeriesView | undefined;
  planned: boolean;
  planning: boolean;
  onPlan: () => void;
  /**
   * Re-plan with the author's own breaks (the chapter that ends each book but the last), or with
   * null to hand the choice back to the planner.
   */
  onPlanWithBreaks?: (breaks: number[] | null) => void;
  /** True when the current books end where the author put them rather than where the planner did. */
  breaksByAuthor?: boolean;
  warnings?: string[];
  summary?: string;
  stateKey: readonly unknown[];
}

const LANDS = 0.6;

function messageOf(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
}

export default function SeriesPanel({
  projectId,
  series,
  planned,
  planning,
  onPlan,
  onPlanWithBreaks,
  breaksByAuthor,
  warnings,
  summary,
  stateKey,
}: Props) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const base = `/api/publishing/project/${projectId}/series`;
  const [name, setName] = useState('');
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [desc, setDesc] = useState<{ text: string; tagline: string } | null>(null);
  const [drafting, setDrafting] = useState<number | null>(null);
  // The chapter that ends each book but the last, as the author is editing them.
  const [breaks, setBreaks] = useState<string[]>([]);

  useEffect(() => {
    if (!series) return;
    setName(series.name_is_default ? '' : series.name);
    setTitles(Object.fromEntries(series.books.map((b) => [String(b.index), b.title])));
    setDesc(series.description ? { text: series.description.text, tagline: series.description.tagline } : null);
    setBreaks(series.books.slice(0, -1).map((b) => String(b.last_chapter)));
  }, [series]);

  const refresh = (s?: SeriesView) => {
    if (s) queryClient.setQueryData(stateKey, (old: Record<string, unknown> | undefined) => (old ? { ...old, series: s } : old));
    void queryClient.invalidateQueries({ queryKey: stateKey });
  };

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiFetch<ApiEnvelope<{ series: SeriesView }>>(base, { method: 'PUT', body: JSON.stringify(body) })).data!.series,
    onSuccess: (s) => {
      refresh(s);
      addToast('Saved', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const suggest = useMutation({
    mutationFn: async () =>
      (await apiFetch<ApiEnvelope<{ series: SeriesView; dropped: number }>>(`${base}/titles`, { method: 'POST' })).data!,
    onSuccess: (d) => {
      refresh(d.series);
      addToast(d.dropped ? `Titles suggested (${d.dropped} discarded: not drawn from their book)` : 'Titles suggested', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const describe = useMutation({
    mutationFn: async () =>
      (await apiFetch<ApiEnvelope<{ series: SeriesView }>>(`${base}/description`, { method: 'POST' })).data!.series,
    onSuccess: (s) => refresh(s),
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const ending = useMutation({
    mutationFn: async ({ index, what }: { index: number; what: 'draft' | 'apply' | 'discard' }) => {
      const path = `${base}/books/${index}/ending${what === 'apply' ? '/apply' : ''}`;
      const method = what === 'discard' ? 'DELETE' : 'POST';
      return (await apiFetch<ApiEnvelope<{ series: SeriesView }>>(path, { method })).data!.series;
    },
    onMutate: ({ index, what }) => {
      if (what === 'draft') setDrafting(index);
    },
    onSettled: () => setDrafting(null),
    onSuccess: (s, v) => {
      refresh(s);
      if (v.what === 'apply') addToast('The new ending is in the book. The old one is in the chapter’s versions.', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const books = series?.books ?? [];
  const isSeries = books.length > 1;
  const currentBreaks = books.slice(0, -1).map((b) => String(b.last_chapter));
  const breaksChanged = breaks.join(',') !== currentBreaks.join(',');
  const breakNumbers = breaks.map((b) => Number(b));
  const breaksValid =
    breaks.every((b) => b.trim() !== '' && Number.isInteger(Number(b))) &&
    breakNumbers.every((n, i) => i === 0 || n > breakNumbers[i - 1]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 dark:border-gray-800 dark:bg-gray-900">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Series</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Each book is sold on its own. It should settle the story it tells and leave the reader a larger question
          for the next one. A book that stops mid-scene reads as a book with its last pages missing.
        </p>
      </div>

      <button
        onClick={onPlan}
        disabled={planning}
        className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40"
      >
        {planning ? 'Planning…' : planned ? 'Re-run the planner' : 'Plan the books'}
      </button>
      {summary ? <p className="text-xs text-gray-500 dark:text-gray-400">{summary}</p> : null}
      {!planned ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">No plan yet. Until there is one this is a single book.</p>
      ) : null}

      {planned && onPlanWithBreaks ? (
        <div className="space-y-2 rounded-lg border border-gray-200 p-3 text-xs dark:border-gray-800" data-testid="series-breaks">
          <h3 className="font-semibold text-gray-700 dark:text-gray-300">Where each book ends</h3>
          <p className="text-gray-500 dark:text-gray-400">
            {breaksByAuthor
              ? 'You chose these breaks. The planner reads each ending and reports it, but does not move them.'
              : 'The planner chose these breaks. Change any of them — the next book begins with the chapter after.'}
          </p>
          {breaks.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <label className="text-gray-600 dark:text-gray-400">
                Book {i + 1} ends after chapter
                <input
                  aria-label={`Book ${i + 1} ends after chapter`}
                  type="number"
                  min={0}
                  value={b}
                  onChange={(e) => setBreaks(breaks.map((x, k) => (k === i ? e.target.value : x)))}
                  className="ml-2 inline-block w-20 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                />
              </label>
              <span className="text-gray-400">
                {b.trim() ? `Book ${i + 2} begins at chapter ${Number(b) + 1}` : ''}
              </span>
              <button
                onClick={() => setBreaks(breaks.filter((_, k) => k !== i))}
                className="text-gray-500 underline hover:text-red-600"
              >
                Remove this break
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setBreaks([...breaks, ''])}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Add a break
            </button>
            <button
              onClick={() => onPlanWithBreaks(breakNumbers.length ? breakNumbers : null)}
              disabled={planning || !breaksChanged || !breaksValid}
              className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {planning ? 'Planning…' : 'Use these breaks'}
            </button>
            {breaksByAuthor ? (
              <button
                onClick={() => onPlanWithBreaks(null)}
                disabled={planning}
                className="rounded-lg border border-brand-300 px-3 py-1.5 font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300"
              >
                Let the planner choose
              </button>
            ) : null}
          </div>
          {!breaksValid ? (
            <p className="text-amber-700 dark:text-amber-400">Each book must end after the one before it.</p>
          ) : null}
          {breaksChanged && isSeries ? (
            <p className="text-gray-500 dark:text-gray-400">
              Titles chosen for the old chapters are kept and flagged to check; per-book listing copy should be
              written again for the new chapters.
            </p>
          ) : null}
        </div>
      ) : null}

      {isSeries ? (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-600 dark:text-gray-400">
              Series name
              <input
                aria-label="Series name"
                value={name}
                placeholder={series?.name}
                onChange={(e) => setName(e.target.value)}
                className="mt-0.5 block w-64 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            </label>
            <button
              onClick={() => save.mutate({ name: name.trim() || null })}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Save name
            </button>
            <button
              onClick={() => suggest.mutate()}
              disabled={suggest.isPending}
              className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300"
            >
              {suggest.isPending ? 'Reading each book…' : 'Suggest titles from each book'}
            </button>
          </div>

          <ul className="space-y-3">
            {books.map((b) => {
              const key = String(b.index);
              const last = b.index === books.length;
              const score = b.ending_score ?? 0;
              const draft = b.ending_draft;
              return (
                <li key={b.index} data-testid={`series-book-${b.index}`} className="space-y-2 rounded-lg border border-gray-200 p-3 text-xs dark:border-gray-800">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-gray-900 dark:text-white">
                      Book {b.index}
                      {b.title ? `: ${b.title}` : ''} · chapters {b.first_chapter}–{b.last_chapter}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {b.words ? `${b.words.toLocaleString()} words · ` : ''}~{b.estimated_pages} pages
                    </span>
                  </div>

                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-gray-600 dark:text-gray-400">
                      Title
                      <input
                        aria-label={`Title of book ${b.index}`}
                        value={titles[key] ?? ''}
                        onChange={(e) => setTitles({ ...titles, [key]: e.target.value })}
                        className="mt-0.5 block w-72 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                      />
                    </label>
                    <button
                      onClick={() => save.mutate({ titles: { [key]: (titles[key] ?? '').trim() } })}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Save title
                    </button>
                  </div>
                  {b.title_stale ? (
                    <p className="text-amber-700 dark:text-amber-400">
                      This title was chosen when the book covered different chapters. Check it still fits.
                    </p>
                  ) : null}
                  {b.suggestions.length ? (
                    <div className="space-y-1">
                      {b.suggestions.map((s) => (
                        <div key={s.title} className="flex flex-wrap items-baseline gap-2">
                          <button
                            onClick={() => {
                              setTitles({ ...titles, [key]: s.title });
                              save.mutate({ titles: { [key]: s.title }, from_suggestion: [key] });
                            }}
                            className="rounded-full border border-brand-300 px-2 py-0.5 text-brand-700 hover:bg-brand-50 dark:border-brand-700 dark:text-brand-300"
                          >
                            {s.title}
                          </button>
                          <span className="text-gray-500 dark:text-gray-400">
                            from “{s.phrase}” · {s.why}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {b.ending_score != null ? (
                    <div className="space-y-1">
                      <p className="text-gray-600 dark:text-gray-400">
                        {last ? 'Ends the series on ' : 'Ends on '}
                        <span
                          className={
                            score >= LANDS
                              ? 'font-medium text-green-700 dark:text-green-400'
                              : 'font-medium text-amber-700 dark:text-amber-400'
                          }
                        >
                          {score.toFixed(2)}
                        </span>
                        {b.ending_title ? ` · “${b.ending_title}”` : ''}
                        {!last && score < LANDS ? ' · this ending does not land as the end of a book' : ''}
                      </p>
                      {b.ending_resolves ? <p className="text-gray-600 dark:text-gray-400">Settles: {b.ending_resolves}</p> : null}
                      {b.ending_carries ? <p className="text-gray-600 dark:text-gray-400">Carries forward: {b.ending_carries}</p> : null}
                      {b.ending_reason ? <p className="italic text-gray-500 dark:text-gray-400">{b.ending_reason}</p> : null}
                    </div>
                  ) : null}

                  {!draft ? (
                    <button
                      onClick={() => ending.mutate({ index: b.index, what: 'draft' })}
                      disabled={drafting !== null}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      {drafting === b.index ? 'Drafting a closing scene… (a minute or two)' : last ? 'Draft a final close for the series' : 'Draft a closing scene'}
                    </button>
                  ) : (
                    <div data-testid={`ending-draft-${b.index}`} className="space-y-2 rounded-md bg-gray-50 p-2 dark:bg-gray-800/60">
                      <p className="font-medium text-gray-800 dark:text-gray-200">
                        A revised close for chapter {draft.chapter_number}, “{draft.chapter_title}”: {draft.words} words
                        replacing the last {draft.replaced_words ?? draft.current_ending.split(/\s+/).length}
                      </p>
                      {draft.resolved ? <p className="text-gray-600 dark:text-gray-400">Settles: {draft.resolved}</p> : null}
                      {draft.carried ? <p className="text-gray-600 dark:text-gray-400">Carries forward: {draft.carried}</p> : null}
                      {draft.new_names.length ? (
                        <p className="text-amber-700 dark:text-amber-400">
                          Names that are not in the book yet: {draft.new_names.join(', ')}. Check them before using this.
                        </p>
                      ) : null}
                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-gray-500">Now</p>
                          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                            {draft.current_ending}
                          </p>
                        </div>
                        <div>
                          <p className="mb-1 text-gray-500">Revised</p>
                          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded border border-brand-200 bg-white p-2 text-sm text-gray-800 dark:border-brand-800 dark:bg-gray-900 dark:text-gray-200">
                            {draft.new_ending}
                          </p>
                        </div>
                      </div>
                      {draft.applied_at ? (
                        <p className="text-green-700 dark:text-green-400">
                          In the book since {new Date(draft.applied_at).toLocaleString()}. The earlier text is in the chapter’s
                          Versions.
                        </p>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={() => ending.mutate({ index: b.index, what: 'apply' })}
                            className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700"
                          >
                            Use this ending
                          </button>
                          <button
                            onClick={() => ending.mutate({ index: b.index, what: 'discard' })}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
                          >
                            Discard
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Series description</h3>
              <button
                onClick={() => describe.mutate()}
                disabled={describe.isPending}
                className="rounded-lg border border-brand-300 px-3 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300"
              >
                {describe.isPending ? 'Writing…' : desc ? 'Write it again' : 'Write the series description'}
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              What the whole series is, with Book 1 as the way in. Written from each book’s own description; it names no
              one those descriptions do not.
            </p>
            {desc ? (
              <>
                <textarea
                  aria-label="Series description"
                  value={desc.text}
                  onChange={(e) => setDesc({ ...desc, text: e.target.value })}
                  rows={6}
                  className="block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                />
                <input
                  aria-label="Series tagline"
                  value={desc.tagline}
                  onChange={(e) => setDesc({ ...desc, tagline: e.target.value })}
                  className="block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                />
                <button
                  onClick={() => save.mutate({ description: desc })}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
                >
                  Save description
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      {warnings?.length ? (
        <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-400">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
