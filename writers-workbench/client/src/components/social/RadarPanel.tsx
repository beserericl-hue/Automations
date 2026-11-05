/**
 * The two radars' weekly slates, and "schedule the week" from them.
 *
 * Trend Radar ranks founder / AI news for the TechAhir blog (each topic becomes a blog post and a
 * LinkedIn article); Dev Radar collects AI + software-development articles and videos for the AI Dev
 * Roundup (each becomes a short LinkedIn link post). Both run weekly on the engine; "Run now" builds
 * this week's slate immediately.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    blurb: 'News from your feeds, ranked by how strongly it makes your ideal customer want what you offer. Runs Mondays 6:00 AM ET.',
    makes: 'Each topic you schedule becomes a blog post and a LinkedIn article in your brand’s voice, with a sketchnote image.',
  },
  dev: {
    name: 'Dev Radar',
    blurb: 'This week’s best AI + software-development articles and videos (Hacker News, YouTube, your feeds). Runs Sundays 6:00 AM ET.',
    makes: 'Each item you schedule becomes a short LinkedIn post: your summary, the link, and the “comment newsletter” call to action. Two a weekday.',
  },
};

interface RadarSetupData {
  radar: Radar;
  subscribed: boolean;
  enabled: boolean;
  edition_id: string | null;
  channels: string[];
  slate_email: boolean;
  brand: Record<string, string>;
  last_run: { week_of: string; status: string } | null;
}
interface RadarsResponse {
  radars: RadarSetupData[];
  editions: Array<{ id: string; name: string }>;
}

const BRAND_FIELDS: Array<{ key: string; label: string; hint: string; radar?: Radar; long?: boolean }> = [
  { key: 'name', label: 'Brand name', hint: 'Who is speaking. e.g. Kent Smith Studio' },
  { key: 'what_we_do', label: 'What you do', hint: 'One clause after the name: “…which ghostwrites business books in 90 days”' },
  { key: 'audience', label: 'Ideal customer', hint: 'Who the posts and the ranking are for' },
  { key: 'goal', label: 'What the content must achieve', hint: 'e.g. make founders realise they need a book before their next raise', radar: 'trend' },
  { key: 'pitch', label: 'Your pitch, in a line', hint: 'The “How <brand> helps” section of every article', radar: 'trend' },
  { key: 'cta_text', label: 'Call to action', hint: 'The link text at the end of every post', radar: 'trend' },
  { key: 'cta_url', label: 'Call-to-action link', hint: 'https://…', radar: 'trend' },
  { key: 'scoring_focus', label: 'What to rank high', hint: 'Plain words: what a top story looks like, what is off-topic. Blank keeps the MVP-demand ranking.', radar: 'trend', long: true },
  { key: 'newsletter_name', label: 'Newsletter name', hint: 'Named in the call to action of every roundup post', radar: 'dev' },
  { key: 'newsletter_cta', label: 'How readers subscribe', hint: "e.g. comment 'newsletter'", radar: 'dev' },
  { key: 'hashtags', label: 'Hashtags always included', hint: '#ai #founders', long: false },
];

/** Switch a radar on for THIS account and say what it feeds, where it posts, and whose voice it uses.
 *  Eric, 2026-11-05: "These Radars are not global, but account specific, so we need to be able to
 *  initialize radars for other contents created by other users." A superuser impersonating a user
 *  sets it up for them here. */
function RadarSetup({ radar }: { radar: Radar }) {
  const qc = useQueryClient();
  const radars = useQuery({ queryKey: ['radars'], queryFn: () => apiFetch<{ success: boolean; data: RadarsResponse }>('/api/social/radars') });
  const channels = useQuery({ queryKey: ['social-channels'], queryFn: () => apiFetch<{ success: boolean; data: Array<{ channel: string; kind: string; label: string; enabled: boolean }> }>('/api/social/channels') });
  const current = radars.data?.data?.radars?.find((r) => r.radar === radar);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ enabled: false, edition_id: '', channels: [] as string[], slate_email: true, brand: {} as Record<string, string> });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (current) setForm({ enabled: current.enabled, edition_id: current.edition_id ?? '', channels: current.channels, slate_email: current.slate_email, brand: current.brand });
  }, [current]);
  useEffect(() => { if (current && !current.subscribed) setOpen(true); }, [current]);

  const save = useMutation({
    mutationFn: () => apiFetch(`/api/social/radar/${radar}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: form.enabled, edition_id: form.edition_id || null, channels: form.channels, slate_email: form.slate_email, brand: form.brand }),
    }),
    onSuccess: () => {
      setError('');
      setSaved(form.enabled ? 'Saved. This radar runs weekly for your account.' : 'Saved. This radar is switched off.');
      void qc.invalidateQueries({ queryKey: ['radars'] });
      void qc.invalidateQueries({ queryKey: ['radar', radar] });
      void qc.invalidateQueries({ queryKey: ['studio', 'editions'] });
    },
    onError: (e) => { setSaved(''); setError(e instanceof ApiError ? e.message : 'Could not save the radar'); },
  });

  const editions = radars.data?.data?.editions ?? [];
  const chans = (channels.data?.data ?? []).filter((c) => c.enabled);
  const brand = (k: string, v: string) => setForm({ ...form, brand: { ...form.brand, [k]: v } });
  return (
    <section className="rounded border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" data-testid={`radar-setup-${radar}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {INFO[radar].name} for your account
          {current && (
            <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${current.enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`} data-testid={`radar-setup-${radar}-state`}>
              {current.enabled ? 'on' : current.subscribed ? 'off' : 'not set up'}
            </span>
          )}
        </h2>
        <button type="button" onClick={() => setOpen((v) => !v)} data-testid={`radar-setup-${radar}-toggle`} className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600">
          {open ? 'Hide setup' : current?.subscribed ? 'Settings' : 'Set up'}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} data-testid={`radar-setup-${radar}-enabled`} />
            Run this radar weekly for my account
          </label>
          <label className="block">
            <span className="text-gray-700 dark:text-gray-300">Feeds the edition</span>
            <select value={form.edition_id} onChange={(e) => setForm({ ...form, edition_id: e.target.value })} data-testid={`radar-setup-${radar}-edition`}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
              <option value="">— none (slate only; no Content Studio) —</option>
              {editions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span className="text-xs text-gray-500">The Content Studio works on this edition; its slate feeds the edition’s issues.</span>
          </label>
          <div>
            <span className="text-gray-700 dark:text-gray-300">Posts go to</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {chans.map((c) => (
                <label key={c.channel} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={form.channels.includes(c.channel)} data-testid={`radar-setup-${radar}-channel-${c.channel}`}
                    onChange={(e) => setForm({ ...form, channels: e.target.checked ? [...form.channels, c.channel] : form.channels.filter((x) => x !== c.channel) })} />
                  {c.label}
                </label>
              ))}
              {!chans.length && <span className="text-xs text-gray-500">No channels yet — switch some on in Settings → Integrations.</span>}
            </div>
            <span className="text-xs text-gray-500">None ticked = every channel you have switched on.</span>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.slate_email} onChange={(e) => setForm({ ...form, slate_email: e.target.checked })} data-testid={`radar-setup-${radar}-slate-email`} />
            Email me the slate when a run finishes
          </label>
          <details>
            <summary className="cursor-pointer font-medium text-gray-800 dark:text-gray-100">Voice &amp; brand (blank fields keep the defaults)</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {BRAND_FIELDS.filter((f) => !f.radar || f.radar === radar).map((f) => (
                <label key={f.key} className={`block ${f.long ? 'sm:col-span-2' : ''}`}>
                  <span className="text-gray-700 dark:text-gray-300">{f.label}</span>
                  {f.long ? (
                    <textarea value={form.brand[f.key] ?? ''} onChange={(e) => brand(f.key, e.target.value)} rows={4} placeholder={f.hint} data-testid={`radar-setup-${radar}-brand-${f.key}`}
                      className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
                  ) : (
                    <input value={form.brand[f.key] ?? ''} onChange={(e) => brand(f.key, e.target.value)} placeholder={f.hint} data-testid={`radar-setup-${radar}-brand-${f.key}`}
                      className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
                  )}
                </label>
              ))}
            </div>
          </details>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending} data-testid={`radar-setup-${radar}-save`}
              className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50">{save.isPending ? 'Saving…' : 'Save radar'}</button>
            {saved && <span className="text-xs text-green-700 dark:text-green-300" role="status">{saved}</span>}
          </div>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}

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

      <RadarSetup radar={radar} />

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
