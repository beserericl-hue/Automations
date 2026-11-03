/**
 * The radar slate for one week: ranked topics with source, type, angle and link, and whether a draft or
 * post already exists. Select by checkbox or by range text ("1-5, 8, 12-16"), then draft them into
 * review (nothing is scheduled). "Run radar now" builds this week's slate.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { parseRanks, STATE_LABEL, studioApi } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';

export default function StudioSlate({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const [picked, setPicked] = useState<number[]>([]);
  const [range, setRange] = useState('');
  const [error, setError] = useState('');

  const overview = useQuery({ queryKey: ['studio', ed, 'overview'], queryFn: () => studioApi.overview(ed) });
  const slate = useQuery({
    queryKey: ['studio', ed, 'slate', ctx.week],
    queryFn: () => studioApi.slate(ed, ctx.week),
    refetchInterval: ctx.jobs.length ? 5000 : false,
  });
  const topics = useMemo(() => slate.data?.data.topics ?? [], [slate.data]);
  const weeks = overview.data?.data.weeks ?? [];
  const week = slate.data?.data.week_of ?? null;
  const run = overview.data?.data.run as { week_of?: string; status?: string; error?: string | null } | null | undefined;

  const runRadar = useMutation({
    mutationFn: () => studioApi.runRadar(ed),
    onSuccess: (r) => ctx.track(r.jobId, 'Building this week’s slate'),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start the radar'),
  });
  const generate = useMutation({
    mutationFn: (ids: string[]) => studioApi.generate(ed, { topic_ids: ids, ...(week ? { week_of: week } : {}) }),
    onSuccess: (r, ids) => {
      ctx.track(r.jobId, `Drafting ${ids.length} topic${ids.length === 1 ? '' : 's'}`);
      setPicked([]);
      setRange('');
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start drafting'),
  });

  const applyRange = () => {
    const ranks = parseRanks(range, topics.map((t) => t.rank));
    setPicked(ranks);
    setError(ranks.length ? '' : 'None of those numbers are on this slate');
  };
  const chosen = topics.filter((t) => picked.includes(t.rank));
  const undrafted = topics.filter((t) => !t.post || t.post.state === 'cancelled').map((t) => t.rank);

  return (
    <section className="space-y-3" data-testid="studio-slate">
      <div className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Week of</span>
          <select aria-label="Slate week" value={week ?? ''} onChange={(e) => { ctx.setWeek(e.target.value || null); setPicked([]); }}
            data-testid="slate-week" className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
            {weeks.length === 0 && !week && <option value="">—</option>}
            {(week && !weeks.includes(week) ? [week, ...weeks] : weeks).map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        {run?.week_of && <span className="text-xs text-gray-500">Last run: week of {run.week_of}, {String(run.status ?? '').replace('_', ' ')}{run.error ? ` (${run.error})` : ''}</span>}
        <button type="button" onClick={() => runRadar.mutate()} disabled={runRadar.isPending}
          className="ml-auto rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Run radar now</button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 1-5, 8, 12-16" aria-label="Select by number"
          onKeyDown={(e) => { if (e.key === 'Enter') applyRange(); }} data-testid="slate-range"
          className="w-48 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
        <button type="button" onClick={applyRange} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600" data-testid="slate-range-apply">Select</button>
        <button type="button" onClick={() => setPicked(undrafted)} disabled={!undrafted.length}
          className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Select all not drafted</button>
        <button type="button" onClick={() => setPicked([])} disabled={!picked.length} className="rounded px-2 py-1.5 text-gray-500 disabled:opacity-50">Clear</button>
        <button type="button" data-testid="slate-generate" disabled={!chosen.length || generate.isPending}
          onClick={() => generate.mutate(chosen.map((t) => t.id))}
          className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          Generate {chosen.length || ''} draft{chosen.length === 1 ? '' : 's'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      {slate.isError && <p className="text-sm text-red-600">Could not load the slate.</p>}
      {slate.isSuccess && topics.length === 0 && <p className="text-sm text-gray-500">No slate yet. “Run radar now” builds this week’s.</p>}

      <ol className="space-y-2">
        {topics.map((t) => (
          <li key={t.id} className="rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={`slate-topic-${t.rank}`}>
            <label className="flex items-start gap-3">
              <input type="checkbox" className="mt-1" checked={picked.includes(t.rank)} aria-label={`Select topic ${t.rank}`}
                onChange={(e) => setPicked(e.target.checked ? [...picked, t.rank] : picked.filter((n) => n !== t.rank))} />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-semibold text-gray-400">
                  {t.rank}. {t.item_type === 'video' ? 'VIDEO' : 'ARTICLE'}{t.score != null ? ` · score ${t.score}` : ''} · {t.source}
                </span>
                <a href={t.url} target="_blank" rel="noreferrer" className="block font-medium text-gray-900 hover:underline dark:text-gray-100">{t.title}</a>
                {t.angle && <span className="mt-1 block text-sm text-gray-700 dark:text-gray-300">{t.angle}</span>}
                {t.summary && <span className="mt-1 block whitespace-pre-line text-xs text-gray-500 dark:text-gray-400">{t.summary}</span>}
                {t.post && (
                  <span className="mt-1 block text-xs text-emerald-700 dark:text-emerald-300" data-testid={`slate-topic-${t.rank}-post`}>
                    #{t.post.display_number} · {STATE_LABEL[t.post.state] ?? t.post.state}
                    {t.post.scheduled_date ? ` · ${t.post.scheduled_date}` : ''}
                    {t.post.edition_id && t.post.edition_id !== ed ? ` (in ${t.post.edition_id})` : ''}
                  </span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ol>
    </section>
  );
}
