/**
 * History: every slate week of this radar and what became of each topic — never drafted, drafted but
 * not scheduled, scheduled, published, failed, cancelled, discarded. Eric, 2026-11-05: "where is the
 * history of all the posts not generated or scheduled from week to week." A topic never drafted can be
 * drafted from here, whatever week it came from.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { BUCKET_LABEL, STATE_LABEL, studioApi, whenLabel, type HistoryBucket, type HistoryTopic } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';

const ORDER: HistoryBucket[] = ['not_drafted', 'drafted', 'scheduled', 'published', 'failed', 'cancelled', 'discarded'];
const TONE: Record<HistoryBucket, string> = {
  not_drafted: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  drafted: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  scheduled: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  published: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  discarded: 'bg-gray-100 text-gray-500 line-through dark:bg-gray-800 dark:text-gray-400',
};

export default function StudioHistory({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const [filter, setFilter] = useState<HistoryBucket | 'all'>('all');
  const [error, setError] = useState('');
  const history = useQuery({
    queryKey: ['studio', ed, 'history'],
    queryFn: () => studioApi.history(ed),
    refetchInterval: ctx.jobs.length ? 5000 : false,
  });
  const weeks = useMemo(() => history.data?.data.weeks ?? [], [history.data]);
  const totals = history.data?.data.totals ?? {};
  const total = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);

  const draft = useMutation({
    mutationFn: (t: HistoryTopic) => studioApi.generate(ed, { topic_ids: [t.id], week_of: t.week_of }),
    onSuccess: (r, t) => ctx.track(r.jobId, `Drafting “${t.title.slice(0, 60)}” (week of ${t.week_of})`),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start drafting'),
  });

  const shown = weeks
    .map((w) => ({ ...w, topics: filter === 'all' ? w.topics : w.topics.filter((t) => t.bucket === filter) }))
    .filter((w) => w.topics.length > 0);

  return (
    <section className="space-y-3" data-testid="studio-history">
      <div className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
        <span className="text-gray-600 dark:text-gray-300">{weeks.length} week{weeks.length === 1 ? '' : 's'} · {total} topics</span>
        <button type="button" onClick={() => setFilter('all')} data-testid="history-filter-all"
          className={`rounded-full border px-2 py-0.5 text-xs ${filter === 'all' ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-gray-300 dark:border-gray-600'}`}>
          All
        </button>
        {ORDER.map((b) => (
          <button key={b} type="button" onClick={() => setFilter(b)} data-testid={`history-filter-${b}`} disabled={!totals[b]}
            className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-40 ${filter === b ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-gray-300 dark:border-gray-600'}`}>
            {BUCKET_LABEL[b]} {totals[b] ?? 0}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      {history.isError && <p className="text-sm text-red-600">Could not load the history.</p>}
      {history.isSuccess && weeks.length === 0 && <p className="text-sm text-gray-500">No slates yet. “Run radar now” on the Slate tab builds this week’s.</p>}
      {history.isSuccess && weeks.length > 0 && shown.length === 0 && <p className="text-sm text-gray-500">Nothing in that state.</p>}

      {shown.map((w) => (
        <div key={w.week_of} className="rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900" data-testid={`history-week-${w.week_of}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
            <button type="button" className="font-semibold text-gray-800 hover:underline dark:text-gray-100" onClick={() => ctx.setWeek(w.week_of)} title="Open this week on the Slate tab">
              Week of {w.week_of}
            </button>
            <span className="text-xs text-gray-500">
              {ORDER.filter((b) => w.counts[b]).map((b) => `${w.counts[b]} ${BUCKET_LABEL[b].toLowerCase()}`).join(' · ')}
            </span>
          </div>
          <ol className="divide-y divide-gray-100 dark:divide-gray-800">
            {w.topics.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid={`history-topic-${t.week_of}-${t.rank}`}>
                <span className={`rounded px-1.5 py-0.5 text-xs ${TONE[t.bucket]}`} data-testid={`history-topic-${t.week_of}-${t.rank}-bucket`}>{BUCKET_LABEL[t.bucket]}</span>
                <span className="text-xs text-gray-400">{t.rank}.</span>
                <a href={t.url.startsWith('http') ? t.url : undefined} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium text-gray-900 hover:underline dark:text-gray-100">{t.title}</a>
                {t.post && (
                  <span className="text-xs text-gray-500">
                    #{t.post.display_number} · {STATE_LABEL[t.post.state] ?? t.post.state}
                    {t.bucket === 'scheduled' || t.bucket === 'published' ? ` · ${whenLabel(t.post)}` : ''}
                  </span>
                )}
                {t.bucket === 'not_drafted' && (
                  <button type="button" onClick={() => draft.mutate(t)} disabled={draft.isPending} data-testid={`history-draft-${t.week_of}-${t.rank}`}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs dark:border-gray-600 disabled:opacity-50">Draft it</button>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
