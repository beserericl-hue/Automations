/**
 * Review how one book ends, on its own page.
 *
 * The end of a book is where the reader decides whether to buy the next, so it gets a screen of its own:
 * how the book ends now, cliffhangers the engine recommends from the plot structure (each saying what it
 * relies on and what it must leave alone), the closing scene drafted from the one chosen (edit it, check
 * it against the books around it, add it), and the humanizer for the scene's wording.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useUser } from '../../contexts/UserContext';
import { useToast } from '../../contexts/ToastContext';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';
import SeriesPiece from './SeriesPiece';
import type { SeriesBook, SeriesView, CliffhangerOption } from './SeriesPanel';

const card = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900';
const button =
  'rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';
const primary = 'rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50';

interface HumanizeResult {
  text?: string;
  changed?: boolean;
  skipped?: string | null;
  detectability?: number | string | null;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
}

export default function BookEndingReview() {
  const { id, index: indexParam } = useParams<{ id: string; index: string }>();
  const index = Number(indexParam);
  const projectId = id ?? '';
  const { profile } = useUser();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const { trackJob, stateOf } = useEngineJobQueue(profile?.user_id ?? undefined);
  const stateKey = ['publishing', projectId] as const;
  const base = `/api/publishing/project/${projectId}/series`;
  const [chosen, setChosen] = useState<string>('');
  const [humanized, setHumanized] = useState<HumanizeResult | null>(null);

  const { data } = useQuery({
    queryKey: stateKey,
    queryFn: async () => (await apiFetch<ApiEnvelope<{ series?: SeriesView }>>(`/api/publishing/project/${projectId}`)).data!,
    enabled: Boolean(projectId),
  });
  const books: SeriesBook[] = data?.series?.books ?? [];
  const book = books.find((b) => b.index === index);
  const isLast = books.length > 0 && index === books[books.length - 1].index;

  // The chapter the book ends on, as it stands.
  const { data: last } = useQuery({
    queryKey: ['book-last-chapter', projectId, book?.last_chapter],
    queryFn: async () => {
      const { data: row } = await supabase
        .from('published_content_v2')
        .select('id, title, content_text')
        .eq('project_id', projectId)
        .eq('content_type', 'chapter')
        .eq('chapter_number', book!.last_chapter)
        .is('deleted_at', null)
        .maybeSingle();
      return row as { id: string; title: string; content_text: string | null } | null;
    },
    enabled: Boolean(book),
  });

  const refresh = (s?: SeriesView) => {
    if (s) queryClient.setQueryData(stateKey, (old: { series?: SeriesView } | undefined) => ({ ...(old ?? {}), series: s }));
    void queryClient.invalidateQueries({ queryKey: stateKey });
    void queryClient.invalidateQueries({ queryKey: ['book-last-chapter', projectId] });
  };

  const recommend = useMutation({
    mutationFn: async () => (await apiFetch<{ jobId?: string }>(`${base}/books/${index}/cliffhangers`, { method: 'POST' })).jobId,
    onSuccess: (jobId) => {
      if (jobId) trackJob(`${projectId}:cliffhangers:${index}`, jobId, [stateKey]);
      addToast('Reading the plot structure for cliffhangers. This takes a minute or two.', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });
  const recommending = stateOf(`${projectId}:cliffhangers:${index}`) === 'queued';

  const draft = book?.coda_draft && !book.coda_draft.failed ? book.coda_draft : null;
  const humanize = useMutation({
    mutationFn: async () =>
      (await apiFetch<ApiEnvelope<HumanizeResult>>(`/api/content/${last!.id}/humanize`, { method: 'POST', body: JSON.stringify({ text: draft!.text }) })).data!,
    onSuccess: (r) => setHumanized(r),
    onError: (err) => addToast(messageOf(err), 'error'),
  });
  const useHumanized = useMutation({
    mutationFn: async () =>
      (await apiFetch<ApiEnvelope<{ series: SeriesView }>>(`${base}/books/${index}/coda`, { method: 'PUT', body: JSON.stringify({ text: humanized!.text }) })).data!.series,
    onSuccess: (s) => {
      setHumanized(null);
      refresh(s);
      addToast('The humanized wording is in the draft. Check it before adding it.', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  if (!projectId || !book) {
    return (
      <div className="space-y-3">
        <Link to={`/projects/${projectId}`} className="text-xs text-gray-500 hover:text-brand-600">← Project</Link>
        <p className="text-sm text-gray-600 dark:text-gray-300">That book is not in the current plan.</p>
      </div>
    );
  }

  const tail = (last?.content_text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(-220)
    .join(' ');
  const options: CliffhangerOption[] = book.cliffhangers?.options ?? [];

  return (
    <div className="space-y-5" data-testid="ending-review">
      <div>
        <Link to={`/projects/${projectId}`} className="text-xs text-gray-500 hover:text-brand-600 dark:text-gray-400">← Chapters</Link>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
          How Book {book.index} ends{book.title ? `: ${book.title}` : ''}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Chapters {book.first_chapter} to {book.last_chapter}
          {last ? <> · ends on <Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/content/${last.id}`}>{last.title}</Link></> : null}
        </p>
      </div>

      <section className={card}>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">How it ends now</h2>
        <p data-testid="ending-tail" className="mt-2 whitespace-pre-wrap font-serif text-sm text-gray-800 dark:text-gray-200">…{tail}</p>
        {book.ending_reason ? <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">The planner's reading: {book.ending_reason}</p> : null}
        {book.ending_resolves || book.ending_carries ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Settles: {book.ending_resolves || 'nothing'} · Carries forward: {book.ending_carries || 'nothing'}
          </p>
        ) : null}
      </section>

      {isLast ? (
        <section className={card}>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This is the last book, so it closes the story and has no next book to hand the reader to. Cliffhangers and a closing scene are for the books before it.
          </p>
        </section>
      ) : (
        <>
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recommended cliffhangers</h2>
              <button data-testid="recommend" className={primary} onClick={() => recommend.mutate()} disabled={recommend.isPending || recommending}>
                {recommending ? 'Reading the plot…' : options.length ? 'Recommend again' : 'Recommend cliffhangers'}
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Read from this book's plot structure and the next book's outline. Each says what it relies on and what it leaves alone, so the closing scene does not give away or contradict the next book.
            </p>
            {book.cliffhangers?.failed ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{book.cliffhangers.failed}</p> : null}
            <ul className="mt-3 space-y-3">
              {options.map((o) => (
                <li key={o.title} data-testid="cliffhanger-option" className="rounded border border-gray-200 p-3 text-sm dark:border-gray-700">
                  <p className="font-medium text-gray-900 dark:text-white">{o.title}</p>
                  <p className="mt-1 text-gray-800 dark:text-gray-200">{o.hook}</p>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{o.scene}</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Relies on: {o.uses}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Leaves alone: {o.avoid}</p>
                  {o.new_names?.length ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">Names not in the book yet: {o.new_names.join(', ')}</p>
                  ) : null}
                  <button
                    className={`${chosen === o.scene ? primary : button} mt-2`}
                    onClick={() => setChosen(o.scene)}
                    data-testid="use-direction"
                  >
                    {chosen === o.scene ? 'Chosen: draft from this' : 'Draft the closing scene from this'}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className={card}>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Closing scene (epilogue)</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Picks up where chapter {book.last_chapter} stops and ends on the cliffhanger. Edit it, check it against the books around it, then add it.
            </p>
            <div className="mt-2">
              <SeriesPiece
                kind="coda"
                book={book.index}
                base={base}
                draft={book.coda_draft ?? null}
                working={stateOf(`${projectId}:coda:${book.index}`) === 'queued'}
                onStarted={(jobId) => trackJob(`${projectId}:coda:${book.index}`, jobId, [stateKey])}
                onChanged={(s, note) => {
                  refresh(s);
                  if (note) addToast(note, 'success');
                }}
                suggestedDirection={chosen}
              />
            </div>
          </section>

          {draft && !draft.applied_at ? (
            <section className={card} data-testid="humanizer-box">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Humanizer</h2>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Runs the saved draft through the humanizer. You read the result before it replaces anything.
              </p>
              <button className={`${primary} mt-2`} onClick={() => humanize.mutate()} disabled={humanize.isPending || !last}>
                {humanize.isPending ? 'Humanizing…' : 'Run the draft through the humanizer'}
              </button>
              {humanized ? (
                <div className="mt-3 space-y-2" data-testid="humanized-result">
                  {humanized.skipped ? (
                    <p className="text-xs text-gray-500">{humanized.skipped}</p>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap rounded bg-gray-50 p-2 font-serif text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">{humanized.text}</p>
                      <div className="flex flex-wrap gap-2">
                        <button className={primary} onClick={() => useHumanized.mutate()} disabled={useHumanized.isPending || !humanized.changed}>
                          Use this wording
                        </button>
                        <button className={button} onClick={() => setHumanized(null)}>Keep my draft</button>
                        {!humanized.changed ? <span className="text-xs text-gray-500">It came back unchanged.</span> : null}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
