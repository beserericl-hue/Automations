/**
 * Newsletter Home (Compose Newsletter 2a — S6).
 *
 * Three tiles + recent runs table:
 *   1. In-flight  — populated from useNewsletterEvents() over the last 30 min
 *      and cleared when a `saved` or `error` stage arrives.
 *   2. Pending approvals — `GET /api/newsletter/approvals/open` (S5).
 *   3. Next scheduled send — `GET /api/newsletter/sends?status=scheduled&limit=1`.
 *
 * Recent runs table = `GET /api/newsletter/sends?limit=10`. Row click routes
 * to `/newsletter/sends/:id` when the row already represents a scheduled or
 * sent newsletter; otherwise to `/newsletter/execution/:executionId`.
 */
import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import { useNewsletterEvents } from '../../lib/newsletter/sse';
import EditionBadge from './EditionBadge';
import HelpButton from './HelpButton';
import StatusPill from './StatusPill';
import type {
  NewsletterEdition,
  NewsletterSend,
  NewsletterApprovalStage,
} from '../../types/database';
import type { NewsletterStageEventData, NewsletterStage } from '../../lib/newsletter/schema';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface SendsResponse { success: boolean; sends: NewsletterSend[] }
interface ApprovalsOpenResponse {
  success: boolean;
  approvals: Array<{
    id: string;
    token: string;
    execution_id: string;
    stage: NewsletterApprovalStage;
    created_at: string;
    expires_at: string;
    approval_url: string | null;
  }>;
}

const IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000;
const TERMINAL_STAGES: NewsletterStage[] = ['saved', 'error'];

interface InFlightState {
  executionId: string;
  editionId: string;
  stage: NewsletterStage;
  detail: string;
  ts: string;
}

export default function NewsletterHome() {
  const navigate = useNavigate();
  const [inFlight, setInFlight] = useState<InFlightState | null>(null);

  // Subscribe to live stage events. Keep the most recent non-terminal one
  // around for IN_FLIGHT_WINDOW_MS so the In-flight tile lights up the
  // moment the user kicks off a run.
  useNewsletterEvents({
    onStage: (data: NewsletterStageEventData) => {
      if (TERMINAL_STAGES.includes(data.stage)) {
        setInFlight((prev) => (prev?.executionId === data.executionId ? null : prev));
        return;
      }
      const ageMs = Date.now() - new Date(data.ts).getTime();
      if (ageMs > IN_FLIGHT_WINDOW_MS) return;
      setInFlight({
        executionId: data.executionId,
        editionId: data.editionId,
        stage: data.stage,
        detail: data.detail,
        ts: data.ts,
      });
    },
  });

  // Editions (used for the in-flight tile's edition badge)
  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });
  const editionsById = useMemo(() => {
    const map = new Map<string, NewsletterEdition>();
    for (const e of editionsQuery.data?.editions ?? []) map.set(e.id, e);
    return map;
  }, [editionsQuery.data]);

  // Pending approvals
  const approvalsQuery = useQuery({
    queryKey: ['newsletter-approvals-open'],
    queryFn: () => apiFetch<ApprovalsOpenResponse>('/api/newsletter/approvals/open'),
    staleTime: 15_000,
  });
  const approvals = approvalsQuery.data?.approvals ?? [];

  // Next scheduled send
  const nextScheduledQuery = useQuery({
    queryKey: ['newsletter-next-scheduled'],
    queryFn: () => apiFetch<SendsResponse>('/api/newsletter/sends?status=scheduled&limit=1'),
    staleTime: 30_000,
  });
  const nextScheduled = nextScheduledQuery.data?.sends?.[0] ?? null;

  // Recent runs
  const recentRunsQuery = useQuery({
    queryKey: ['newsletter-sends-recent'],
    queryFn: () => apiFetch<SendsResponse>('/api/newsletter/sends?limit=10'),
    staleTime: 30_000,
  });
  const recentRuns = recentRunsQuery.data?.sends ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Newsletter</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Compose and schedule editions.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <HelpButton section="home" />
          <Link
            to="/newsletter/generate"
            className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
          >
            Generate newsletter →
          </Link>
        </div>
      </header>

      {/* Tiles */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* 1. In-flight */}
        <Tile title="In-flight" empty={!inFlight} emptyText="No active run.">
          {inFlight && (
            <div className="space-y-2">
              {editionsById.has(inFlight.editionId) && (
                <EditionBadge edition={editionsById.get(inFlight.editionId)!} />
              )}
              <div className="flex items-center gap-2">
                <StatusPill status={inFlight.stage} />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {ageString(inFlight.ts)}
                </span>
              </div>
              {inFlight.detail && (
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{inFlight.detail}</p>
              )}
              <Link
                to={`/newsletter/execution/${encodeURIComponent(inFlight.executionId)}`}
                className="block text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
              >
                Resume →
              </Link>
            </div>
          )}
        </Tile>

        {/* 2. Pending approvals */}
        <Tile
          title="Pending approvals"
          count={approvalsQuery.isLoading ? undefined : approvals.length}
          empty={!approvalsQuery.isLoading && approvals.length === 0}
          emptyText="No approvals waiting."
        >
          <ul className="space-y-2">
            {approvals.slice(0, 3).map((a) => (
              <li key={a.token} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">
                  <span className="font-medium">{a.stage === 'subject_line' ? 'Subject line' : 'Stories'}</span>
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{a.execution_id}</span>
                </span>
                <Link
                  to={`/newsletter/approvals/${encodeURIComponent(a.token)}`}
                  className="shrink-0 text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                >
                  Review →
                </Link>
              </li>
            ))}
          </ul>
          {approvals.length > 3 && (
            <Link
              to="/newsletter/approvals"
              className="mt-3 block text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
            >
              See all {approvals.length} →
            </Link>
          )}
        </Tile>

        {/* 3. Next scheduled */}
        <Tile
          title="Next scheduled send"
          empty={!nextScheduledQuery.isLoading && !nextScheduled}
          emptyText="Nothing scheduled."
        >
          {nextScheduled && (
            <div className="space-y-2">
              {nextScheduled.edition_id && editionsById.has(nextScheduled.edition_id) && (
                <EditionBadge edition={editionsById.get(nextScheduled.edition_id)!} />
              )}
              <div className="text-sm font-medium truncate">{nextScheduled.subject || '(no subject)'}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {nextScheduled.scheduled_send_at ? formatDateTime(nextScheduled.scheduled_send_at) : nextScheduled.send_date}
              </div>
              <Link
                to={`/newsletter/sends/${encodeURIComponent(nextScheduled.id)}`}
                className="block text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
              >
                View →
              </Link>
            </div>
          )}
        </Tile>
      </section>

      {/* Recent runs */}
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Recent runs</h2>
          {recentRunsQuery.isLoading && (
            <span className="text-xs text-gray-400">Loading…</span>
          )}
        </header>
        {recentRuns.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-400">No newsletters yet — start with Generate above.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Edition</th>
                <th className="px-4 py-2">Subject</th>
                <th className="px-4 py-2">Send date</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((run) => {
                const route = run.status === 'draft' && run.execution_id
                  ? `/newsletter/execution/${encodeURIComponent(run.execution_id)}`
                  : `/newsletter/sends/${encodeURIComponent(run.id)}`;
                const edition = run.edition_id ? editionsById.get(run.edition_id) : null;
                return (
                  <tr
                    key={run.id}
                    onClick={() => navigate(route)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(route); }
                    }}
                    className="cursor-pointer border-t border-gray-100 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:border-gray-800 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
                  >
                    <td className="px-4 py-2">
                      {edition ? <EditionBadge edition={edition} /> : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-2 max-w-md truncate">{run.subject || '(no subject)'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{run.send_date}</td>
                    <td className="px-4 py-2"><StatusPill status={run.status} /></td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                      {formatDateTime(run.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Tile({
  title,
  count,
  empty,
  emptyText,
  children,
}: {
  title: string;
  count?: number;
  empty?: boolean;
  emptyText: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</h2>
        {typeof count === 'number' && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            {count}
          </span>
        )}
      </header>
      {empty ? (
        <p className="text-sm text-gray-400">{emptyText}</p>
      ) : (
        children
      )}
    </div>
  );
}

function ageString(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ago`;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}
