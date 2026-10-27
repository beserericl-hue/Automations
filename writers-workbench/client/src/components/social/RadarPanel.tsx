/**
 * The two radars' weekly slates, and "schedule the week" from them.
 *
 * Trend Radar ranks founder / AI news for the TechAhir blog (each topic becomes a blog post and a
 * LinkedIn article); Dev Radar collects AI + software-development articles and videos for the AI Dev
 * Roundup (each becomes a short LinkedIn link post). Both run weekly on the engine; "Run now" builds
 * this week's slate immediately.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { useUser } from '../../contexts/UserContext';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';

type Radar = 'trend' | 'dev';

interface Topic {
  id: string;
  rank: number;
  title: string;
  url: string;
  source: string;
  item_type: 'article' | 'video';
  angle: string;
  score: number | null;
  summary: string;
  also_covered_by: string[];
}

interface RadarData {
  radar: Radar;
  subscribed: boolean;
  week_of: string | null;
  run: { week_of: string; status: string; error: string | null; finished_at: string | null; stats: Record<string, unknown> } | null;
  topics: Topic[];
  queued: Record<string, { display_number: number; state: string; scheduled_date: string; slot: string }>;
}

const INFO: Record<Radar, { name: string; blurb: string; makes: string }> = {
  trend: {
    name: 'Trend Radar',
    blurb: 'Founder and AI news ranked by how much it makes an idea-stage founder want a product built. Runs Mondays 6:00 AM ET.',
    makes: 'Each topic you schedule becomes a TechAhir blog post and a LinkedIn article, with a sketchnote image.',
  },
  dev: {
    name: 'Dev Radar',
    blurb: 'This week’s best AI + software-development articles and videos (Hacker News, YouTube, 15 feeds). Runs Sundays 6:00 AM ET.',
    makes: 'Each item you schedule becomes a short LinkedIn post: our summary, the link, and the “comment newsletter” call to action. Two a weekday.',
  },
};

export default function RadarPanel() {
  const { profile } = useUser();
  const [radar, setRadar] = useState<Radar>('trend');
  const [picked, setPicked] = useState<number[]>([]);
  const [message, setMessage] = useState('');
  const { trackJob, stateOf } = useEngineJobQueue(profile?.user_id, 'radar');

  const query = useQuery({
    queryKey: ['radar', radar],
    queryFn: () => apiFetch<{ success: boolean; data: RadarData }>(`/api/social/radar/${radar}`),
  });
  const data = query.data?.data;
  const running = stateOf(`${radar}:run`) === 'queued';
  const scheduling = stateOf(`${radar}:schedule`) === 'queued';

  const run = useMutation({
    mutationFn: () => apiFetch<{ jobId: string }>(`/api/social/radar/${radar}/run`, { method: 'POST', body: JSON.stringify({ force: true }) }),
    onSuccess: (r) => { trackJob(`${radar}:run`, r.jobId, [['radar', radar]]); setMessage('Building this week’s slate. This takes a few minutes.'); },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Could not start the radar'),
  });
  const schedule = useMutation({
    mutationFn: () => apiFetch<{ jobId: string }>(`/api/social/radar/${radar}/schedule`, { method: 'POST', body: JSON.stringify({ numbers: picked }) }),
    onSuccess: (r) => {
      trackJob(`${radar}:schedule`, r.jobId, [['radar', radar], ['social-calendar']]);
      setMessage(`Drafting ${picked.length} post${picked.length === 1 ? '' : 's'} and putting them on the calendar.`);
      setPicked([]);
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Could not schedule'),
  });

  const unqueued = (data?.topics ?? []).filter((t) => !data?.queued[t.id]).map((t) => t.rank);

  return (
    <div className="space-y-4" data-testid="radar-panel">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Radars</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Weekly topic slates for the blog and the LinkedIn roundup. Scheduled posts appear on the{' '}
            <Link to="/newsletter/calendar" className="text-brand-700 hover:underline dark:text-brand-300">post calendar</Link>.
          </p>
        </div>
        <div className="flex rounded border border-gray-300 dark:border-gray-600" role="tablist">
          {(['trend', 'dev'] as Radar[]).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={radar === r} onClick={() => { setRadar(r); setPicked([]); setMessage(''); }}
              className={`px-3 py-1.5 text-sm ${radar === r ? 'bg-brand-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>
              {INFO[r].name}
            </button>
          ))}
        </div>
      </header>

      <section className="rounded border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <p className="text-sm text-gray-700 dark:text-gray-300">{INFO[radar].blurb}</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{INFO[radar].makes}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {data?.run && (
            <span className="text-gray-600 dark:text-gray-300" data-testid="radar-run">
              Week of {data.run.week_of}: {data.run.status === 'ok' ? `${data.topics.length} topics` : data.run.status.replace('_', ' ')}
              {data.run.error && <span className="ml-1 text-red-600">({data.run.error})</span>}
            </span>
          )}
          {!data?.subscribed && query.isSuccess && (
            <span className="text-amber-700 dark:text-amber-300">This radar is not switched on for your account, so it will not run weekly.</span>
          )}
          <button type="button" onClick={() => run.mutate()} disabled={running || run.isPending}
            className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">
            {running ? 'Running…' : 'Run now'}
          </button>
          <button type="button" onClick={() => setPicked(unqueued)} disabled={!unqueued.length}
            className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Select all not scheduled</button>
          <button type="button" onClick={() => schedule.mutate()} disabled={!picked.length || scheduling || schedule.isPending}
            className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50" data-testid="schedule-selected">
            {scheduling ? 'Scheduling…' : `Schedule ${picked.length || ''} selected`.replace('  ', ' ')}
          </button>
        </div>
        {message && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300" role="status">{message}</p>}
      </section>

      {query.isError && <p className="text-sm text-red-600">Could not load the slate.</p>}
      {data && data.topics.length === 0 && (
        <p className="text-sm text-gray-500">No slate yet. “Run now” builds this week’s.</p>
      )}
      <ol className="space-y-2">
        {data?.topics.map((t) => {
          const queued = data.queued[t.id];
          return (
            <li key={t.id} className="rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={`topic-${t.rank}`}>
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-1" checked={picked.includes(t.rank)} disabled={Boolean(queued)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, t.rank] : picked.filter((n) => n !== t.rank))} />
                <span className="min-w-0 flex-1">
                  <span className="text-xs font-semibold text-gray-400">#{t.rank} {t.item_type === 'video' ? '· video' : ''}{t.score != null ? ` · score ${t.score}` : ''}</span>
                  <a href={t.url} target="_blank" rel="noreferrer" className="block font-medium text-gray-900 hover:underline dark:text-gray-100">{t.title}</a>
                  <span className="block text-xs text-gray-500">{t.source}{t.also_covered_by?.length ? ` · also ${t.also_covered_by.join(', ')}` : ''}</span>
                  {t.angle && <span className="mt-1 block text-sm text-gray-700 dark:text-gray-300">{t.angle}</span>}
                  {t.summary && <span className="mt-1 block whitespace-pre-line text-xs text-gray-500 dark:text-gray-400">{t.summary}</span>}
                  {queued && (
                    <span className="mt-1 block text-xs text-emerald-700 dark:text-emerald-300">
                      On the calendar as #{queued.display_number}, {queued.scheduled_date} {queued.slot === 'afternoon' ? '2:00 PM' : '9:00 AM'} ({queued.state})
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
