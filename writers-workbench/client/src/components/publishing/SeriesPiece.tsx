/**
 * A closing scene for the end of a book, or a "previously" recap for the front of the next one.
 *
 * Neither is typed in by the engine's author and dropped into the manuscript. The engine plans the closing
 * scene as a chapter-outline entry, researches what it leans on, writes it from the book's own craft, arc and
 * cast, and checks it for drift against its own beat. A recap may say only what the earlier books say. The
 * draft waits here: the author reads it, edits it in place and adds it to the book, and the outline is brought
 * into line when they do. The chapter and the outline are both snapshotted first.
 */

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import type { SeriesView } from './SeriesPanel';

export interface PieceDraft {
  chapter_number: number;
  chapter_title: string;
  text: string;
  words: number;
  new_names: string[];
  drafted_at: string;
  edited_at?: string;
  applied_at?: string;
  // Closing scenes only.
  hook?: string;
  resolved?: string;
  carried?: string;
  research_topics?: string[];
  drift?: { findings?: unknown[] } | null;
  continuity_checked?: string;
  existing_inconsistencies?: string[];
  /** What the continuity check still objects to: the scene cannot be added until an edit passes. */
  problems?: string[];
  /** Edited since the last check. */
  needs_check?: boolean;
  qa?: Record<string, number> | null;
  // Recaps only.
  sources?: number;
  /** Why the engine could not make one. */
  failed?: string;
}

const DEFAULT_DIRECTION =
  'End like the finale of a series season: settle what this book was about, then leave the reader needing the next book.';

function messageOf(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
}

const button =
  'rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';
const primary = 'rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50';

export default function SeriesPiece({
  kind,
  book,
  base,
  draft,
  working,
  onStarted,
  onChanged,
}: {
  kind: 'coda' | 'recap';
  book: number;
  /** `/api/publishing/project/:id/series` */
  base: string;
  draft: PieceDraft | null;
  /** The engine is drafting it now. */
  working: boolean;
  onStarted: (jobId: string) => void;
  onChanged: (s: SeriesView, note?: string) => void;
}) {
  const { addToast } = useToast();
  const noun = kind === 'coda' ? 'closing scene' : 'recap';
  const path = `${base}/books/${book}/${kind}`;
  const [direction, setDirection] = useState(DEFAULT_DIRECTION);
  const [text, setText] = useState('');
  // Adding a scene the check objected to takes an explicit, informed second step.
  const [confirmAnyway, setConfirmAnyway] = useState(false);
  const [readIt, setReadIt] = useState(false);
  useEffect(() => setText(draft?.text ?? ''), [draft?.text]);
  // A failed attempt is a reason, not a draft: there is nothing to read or add.
  const failedWhy = draft?.failed;
  const usable = draft && !failedWhy ? draft : null;
  const edited = Boolean(usable && text.trim() !== usable.text.trim());
  const problems = usable?.problems ?? [];
  const blocked = kind === 'coda' && Boolean(usable && (problems.length > 0 || usable.needs_check));
  const words = text.split(/\s+/).filter(Boolean).length;

  const start = useMutation({
    mutationFn: async () =>
      (
        await apiFetch<{ jobId?: string }>(path, {
          method: 'POST',
          body: JSON.stringify(kind === 'coda' ? { direction: direction.trim() } : {}),
        })
      ).jobId,
    onSuccess: (jobId) => {
      if (jobId) onStarted(jobId);
      addToast(`Drafting the ${noun}. This takes a few minutes; you can leave this page.`, 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  // A closing scene goes back through the continuity check after the author edits it.
  const check = useMutation({
    mutationFn: async () => (await apiFetch<{ jobId?: string }>(`${path}/check`, { method: 'POST' })).jobId,
    onSuccess: (jobId) => {
      if (jobId) onStarted(jobId);
      addToast('Checking your edit against the books around it. This takes a minute.', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const act = useMutation({
    mutationFn: async (what: 'save' | 'apply' | 'apply-anyway' | 'discard') => {
      const applying = what === 'apply' || what === 'apply-anyway';
      const url = applying ? `${path}/apply` : path;
      const method = what === 'save' ? 'PUT' : applying ? 'POST' : 'DELETE';
      const body = what === 'save' ? JSON.stringify({ text }) : what === 'apply-anyway' ? JSON.stringify({ override: true }) : undefined;
      const s = (await apiFetch<ApiEnvelope<{ series: SeriesView }>>(url, { method, body })).data!.series;
      return { s, what };
    },
    onSuccess: ({ s, what }) => {
      onChanged(
        s,
        what === 'apply' || what === 'apply-anyway'
          ? `The ${noun} is in the book and the outline is updated. The earlier chapter and outline are in their versions.`
          : what === 'save'
            ? 'Your edits are saved to the draft.'
            : undefined,
      );
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const lowest = usable?.qa
    ? Object.entries(usable.qa).sort((a, b) => a[1] - b[1])[0]
    : undefined;
  const driftCount = usable?.drift?.findings?.length ?? 0;

  return (
    <div data-testid={`${kind}-${book}`} className="space-y-2 rounded-md bg-gray-50 p-2 dark:bg-gray-800/60">
      <p className="font-medium text-gray-800 dark:text-gray-200">
        {kind === 'coda' ? 'Closing scene' : 'Recap at the front of this book'}
      </p>

      {failedWhy && !working ? (
        <p data-testid={`${kind}-${book}-failed`} className="rounded border border-red-200 bg-red-50 p-2 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          The last attempt did not produce a {noun}: {failedWhy}
        </p>
      ) : null}

      {!usable || working ? (
        <>
          <p className="text-gray-500 dark:text-gray-400">
            {kind === 'coda'
              ? 'Planned as a chapter-outline entry, researched, written from the book’s own craft, arc and cast, and checked for drift against its own beat.'
              : 'Written from the earlier books only: a name or claim they do not support is sent back.'}
          </p>
          {kind === 'coda' ? (
            <label className="block text-gray-600 dark:text-gray-400">
              What you want it to do
              <textarea
                data-testid={`${kind}-${book}-direction`}
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
                rows={2}
                maxLength={1200}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              />
            </label>
          ) : null}
          <button
            data-testid={`${kind}-${book}-draft`}
            onClick={() => start.mutate()}
            disabled={working || start.isPending}
            className={primary}
          >
            {working || start.isPending ? `Drafting the ${noun}… (a few minutes)` : failedWhy ? `Try the ${noun} again` : `Draft the ${noun}`}
          </button>
          {failedWhy && !working ? (
            <button data-testid={`${kind}-${book}-clear`} onClick={() => act.mutate('discard')} disabled={act.isPending} className={`${button} ml-2`}>
              Clear this message
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-gray-600 dark:text-gray-400">
            For the {kind === 'coda' ? 'end of' : 'start of'} chapter {usable.chapter_number}, “{usable.chapter_title}”:{' '}
            {usable.applied_at ? usable.words : words} words
            {usable.edited_at ? ' · edited by you' : ''}
          </p>
          {usable.hook ? <p className="text-gray-600 dark:text-gray-400">Ends on: {usable.hook}</p> : null}
          {usable.resolved ? <p className="text-gray-600 dark:text-gray-400">Settles: {usable.resolved}</p> : null}
          {usable.carried ? <p className="text-gray-600 dark:text-gray-400">Carries forward: {usable.carried}</p> : null}
          {usable.research_topics?.length ? (
            <p className="text-gray-500 dark:text-gray-400">Researched: {usable.research_topics.join('; ')}</p>
          ) : null}
          {kind === 'coda' && problems.length ? (
            <div data-testid={`${kind}-${book}-problems`} className="rounded border border-red-200 bg-red-50 p-2 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
              <p className="font-medium">The check still objects to this scene. Edit the words, save, then check it again:</p>
              <ul className="ml-4 list-disc">
                {problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : kind === 'coda' && usable.needs_check ? (
            <p data-testid={`${kind}-${book}-unchecked`} className="text-amber-700 dark:text-amber-400">
              Edited since the last check. Check it before it can be added to the book.
            </p>
          ) : null}
          {usable.existing_inconsistencies?.length ? (
            <div data-testid={`${kind}-${book}-existing`} className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <p className="font-medium">Already in your book, not caused by this scene:</p>
              <ul className="ml-4 list-disc">
                {usable.existing_inconsistencies.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {usable.continuity_checked ? (
            <p className="text-gray-500 dark:text-gray-400">Continuity: read {usable.continuity_checked}; no contradictions or invented plot found in the scene.</p>
          ) : null}
          {kind === 'coda' ? (
            <p className="text-gray-500 dark:text-gray-400">
              Drift check: {driftCount ? `${driftCount} finding${driftCount === 1 ? '' : 's'} corrected or noted` : 'no drift found'}
              {lowest ? ` · weakest craft score: ${lowest[0].replace(/_/g, ' ')} ${lowest[1].toFixed(2)}` : ''}
            </p>
          ) : usable.sources ? (
            <p className="text-gray-500 dark:text-gray-400">Drawn from {usable.sources} chapters of the earlier books.</p>
          ) : null}
          {usable.new_names.length ? (
            <p className="text-amber-700 dark:text-amber-400">
              Names that are not in the book yet: {usable.new_names.join(', ')}. Check them before using this.
            </p>
          ) : null}
          <textarea
            data-testid={`${kind}-${book}-text`}
            aria-label={`The ${noun}, editable`}
            value={usable.applied_at ? usable.text : text}
            readOnly={Boolean(usable.applied_at)}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            className="w-full rounded border border-brand-200 bg-white p-2 text-sm leading-relaxed text-gray-800 dark:border-brand-800 dark:bg-gray-900 dark:text-gray-200"
          />
          {usable.applied_at ? (
            <p className="text-green-700 dark:text-green-400">
              In the book since {new Date(usable.applied_at).toLocaleString()}. To change it now, edit the chapter; the earlier chapter is in
              its Versions.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {blocked && confirmAnyway ? (
                <div
                  data-testid={`${kind}-${book}-anyway-confirm`}
                  className="w-full space-y-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                >
                  <p>
                    The continuity check objects to this scene. If you add it anyway, the objections are kept in the chapter's restore
                    point and written in the email, and you can take the scene back from there.
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      id={`${kind}-${book}-read-it`}
                      type="checkbox"
                      checked={readIt}
                      onChange={(e) => setReadIt(e.target.checked)}
                    />
                    <span>I have read this scene and the objections, and I want it in my book as it is.</span>
                  </label>
                  <div className="flex gap-2">
                    <button
                      data-testid={`${kind}-${book}-anyway-go`}
                      onClick={() => act.mutate('apply-anyway')}
                      disabled={!readIt || act.isPending}
                      className={primary}
                    >
                      Add it to the book anyway
                    </button>
                    <button
                      onClick={() => {
                        setConfirmAnyway(false);
                        setReadIt(false);
                      }}
                      className={button}
                    >
                      Not yet
                    </button>
                  </div>
                </div>
              ) : null}
              {edited ? (
                <button data-testid={`${kind}-${book}-save`} onClick={() => act.mutate('save')} disabled={act.isPending} className={button}>
                  Save my edits
                </button>
              ) : null}
              {blocked ? (
                <button
                  data-testid={`${kind}-${book}-check`}
                  onClick={() => check.mutate()}
                  disabled={check.isPending || edited}
                  title={edited ? 'Save your edits first' : undefined}
                  className={primary}
                >
                  {check.isPending ? 'Starting the check…' : 'Check it'}
                </button>
              ) : null}
              <button
                data-testid={`${kind}-${book}-apply`}
                onClick={() => act.mutate('apply')}
                disabled={act.isPending || edited || blocked}
                title={blocked ? 'The continuity check has to pass first' : edited ? 'Save your edits first' : undefined}
                className={blocked ? button : primary}
              >
                Add it to the book
              </button>
              {blocked ? (
                <button
                  data-testid={`${kind}-${book}-anyway`}
                  onClick={() => setConfirmAnyway(true)}
                  disabled={act.isPending || edited || confirmAnyway}
                  title={edited ? 'Save your edits first' : undefined}
                  className={button}
                >
                  Add it anyway…
                </button>
              ) : null}
              <button data-testid={`${kind}-${book}-discard`} onClick={() => act.mutate('discard')} disabled={act.isPending} className={button}>
                Discard
              </button>
              <button data-testid={`${kind}-${book}-again`} onClick={() => start.mutate()} disabled={start.isPending} className={button}>
                Draft it again
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
