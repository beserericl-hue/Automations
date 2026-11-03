/**
 * Newsletter → Content Studio: the n8n studio chat agents as a page. For each edition the signed-in
 * user owns that one of their radars feeds (ai-mvp ← Trend Radar, ai-dev-roundup ← Dev Radar, or any
 * edition with a radar:// source):
 *
 *   Slate       this week's (and past weeks') ranked topics; pick by checkbox or "1-5, 8, 12-16"; draft them
 *   Review      drafts and approved posts: blog + LinkedIn, edit inline, revise with AI, regenerate, image, discard
 *   Queue       scheduled / failed / published posts (also on the Post calendar): cancel, requeue, move
 *   Next issue  which posts / topics go into the edition's next newsletter, in order; generate the issue
 *   Feeds       the edition's public RSS URLs for Substack
 *
 * plus the assistant panel, which does the same things by instruction through the engine hub.
 * Other users never see these editions: the server answers 404 for any edition that is not theirs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { studioApi, waitForJob, type StudioEdition } from '../../lib/studio';
import StudioSlate from './StudioSlate';
import StudioReview from './StudioReview';
import StudioQueue from './StudioQueue';
import StudioIssue from './StudioIssue';
import StudioAssistant from './StudioAssistant';

type Tab = 'slate' | 'review' | 'queue' | 'issue';

export interface RunningJob {
  id: string;
  label: string;
}

export interface StudioContext {
  edition: StudioEdition;
  week: string | null;
  setWeek: (w: string | null) => void;
  /** Track an engine job; the studio refreshes as it runs and reports what it did. */
  track: (jobId: string, label: string) => void;
  jobs: RunningJob[];
  notify: (message: string) => void;
  refresh: () => void;
}

export default function ContentStudio() {
  const { editionId } = useParams<{ editionId?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('slate');
  // ?week=yyyy-mm-dd opens an older slate week directly.
  const [params] = useSearchParams();
  const urlWeek = /^\d{4}-\d{2}-\d{2}$/.test(params.get('week') ?? '') ? params.get('week') : null;
  const [week, setWeek] = useState<string | null>(urlWeek);
  const [jobs, setJobs] = useState<RunningJob[]>([]);
  const [notices, setNotices] = useState<string[]>([]);

  const editions = useQuery({ queryKey: ['studio', 'editions'], queryFn: () => studioApi.editions() });
  const list = useMemo(() => editions.data?.data ?? [], [editions.data]);
  const edition = list.find((e) => e.edition_id === editionId) ?? null;

  useEffect(() => {
    if (!editionId && list.length) navigate(`/newsletter/studio/${encodeURIComponent(list[0].edition_id)}`, { replace: true });
  }, [editionId, list, navigate]);
  useEffect(() => setWeek(urlWeek), [editionId, urlWeek]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['studio'] });
    void qc.invalidateQueries({ queryKey: ['social-calendar'] });
  }, [qc]);

  const notify = useCallback((m: string) => setNotices((n) => [m, ...n].slice(0, 6)), []);

  const track = useCallback((jobId: string, label: string) => {
    setJobs((j) => [...j, { id: jobId, label }]);
    void waitForJob(jobId, refresh).then((out) => {
      setJobs((j) => j.filter((x) => x.id !== jobId));
      refresh();
      const msg = out.status === 'complete'
        ? String(out.result?.message ?? `${label}: done.`)
        : `${label} failed: ${out.error ?? 'unknown error'}`;
      notify(msg);
    });
  }, [notify, refresh]);

  if (editions.isLoading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!list.length) {
    return (
      <div className="space-y-2" data-testid="studio-empty">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Content Studio</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          The Content Studio works on newsletter editions fed by one of your radars. You have none, so there is nothing to show.
        </p>
      </div>
    );
  }
  if (editionId && !edition) {
    return (
      <div className="space-y-2" data-testid="studio-not-found">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Content Studio</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300">No such studio edition. <Link className="text-brand-700 hover:underline" to="/newsletter/studio">Back to the studio</Link></p>
      </div>
    );
  }
  if (!edition) return null;

  const ctx: StudioContext = { edition, week, setWeek, track, jobs, notify, refresh };
  const TABS: Array<[Tab, string]> = [['slate', 'Slate'], ['review', 'Review'], ['queue', 'Queue'], ['issue', 'Next issue & feeds']];

  return (
    <div className="space-y-4" data-testid="content-studio">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Content Studio</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Draft from the {edition.radar === 'trend' ? 'Trend' : 'Dev'} Radar slate, review, publish or schedule, and choose what goes into the next issue.
            Scheduled posts also appear on the <Link to="/newsletter/calendar" className="text-brand-700 hover:underline dark:text-brand-300">post calendar</Link>.
          </p>
        </div>
        <label className="text-sm text-gray-700 dark:text-gray-300">
          <span className="mr-2">Edition</span>
          <select aria-label="Studio edition" value={edition.edition_id} data-testid="studio-edition"
            onChange={(e) => navigate(`/newsletter/studio/${encodeURIComponent(e.target.value)}`)}
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
            {list.map((e) => <option key={e.edition_id} value={e.edition_id}>{e.name}</option>)}
          </select>
        </label>
      </header>

      {(jobs.length > 0 || notices.length > 0) && (
        <section className="space-y-1 rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900" data-testid="studio-activity" aria-live="polite">
          {jobs.map((j) => <p key={j.id} className="text-amber-700 dark:text-amber-300">⏳ {j.label}…</p>)}
          {notices.map((n, i) => <p key={i} className="whitespace-pre-line text-gray-700 dark:text-gray-300">{n}</p>)}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <nav className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700" role="tablist">
            {TABS.map(([t, label]) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} data-testid={`studio-tab-${t}`} onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? 'border-brand-600 font-medium text-brand-700 dark:text-brand-300' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'slate' && <StudioSlate ctx={ctx} />}
          {tab === 'review' && <StudioReview ctx={ctx} />}
          {tab === 'queue' && <StudioQueue ctx={ctx} />}
          {tab === 'issue' && <StudioIssue ctx={ctx} />}
        </div>
        <StudioAssistant ctx={ctx} />
      </div>
    </div>
  );
}
