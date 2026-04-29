/**
 * PendingApprovals (S8) — replaces the S4 stub. Lists open approvals from
 * `GET /api/newsletter/approvals/open` so logged-in reviewers don't need
 * to dig the email link out of their inbox.
 *
 * Columns: stage pill, edition badge, created (absolute), expires (relative),
 * excerpt (first 140 chars of the title or subject_line), Review →.
 *
 * Defensive: filter expired rows client-side too, even though the server's
 * S5 query already does `expires_at > now()`. Cheap safety against a row
 * that aged past expiry between fetch + render.
 */
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import EditionBadge from './EditionBadge';
import HelpButton from './HelpButton';
import StatusPill from './StatusPill';
import type { NewsletterApprovalStage, NewsletterEdition } from '../../types/database';

interface OpenApproval {
  id: string;
  token: string;
  execution_id: string;
  stage: NewsletterApprovalStage;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at: string;
  approval_url: string | null;
  // Edition is denormalized onto newsletter_approvals_v2 (mig 012) but
  // not yet surfaced in the in-app approvals list. Future cleanup: pull
  // edition_id into the SELECT and render the badge per-row instead of
  // hardcoding "ai-news" in callers.
}

interface ApprovalsOpenResponse {
  success: boolean;
  approvals: OpenApproval[];
}

interface EditionsResponse {
  success: boolean;
  editions: NewsletterEdition[];
}

const STAGE_LABEL: Record<NewsletterApprovalStage, string> = {
  stories: 'Stories',
  subject_line: 'Subject',
};

export default function PendingApprovals() {
  const navigate = useNavigate();

  const approvalsQuery = useQuery({
    queryKey: ['newsletter-approvals-open'],
    queryFn: () => apiFetch<ApprovalsOpenResponse>('/api/newsletter/approvals/open'),
    staleTime: 15_000,
  });

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });

  const editions = editionsQuery.data?.editions ?? [];
  // For 2a, the seeded `ai-news` edition is the only one in play; pick
  // it as the visual stand-in if more than one ever lives here.
  const fallbackEdition = editions.find((e) => e.id === 'ai-news') ?? editions[0];

  // Defensive client-side filter: drop rows that aged out between fetch
  // and render. Server already does this, so usually no-op.
  const now = Date.now();
  const approvals = (approvalsQuery.data?.approvals ?? []).filter(
    (a) => new Date(a.expires_at).getTime() > now,
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Pending approvals</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Stories and subject-line approvals waiting on a human decision.
          </p>
        </div>
        <HelpButton section="approvals" />
      </header>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {approvalsQuery.isLoading ? (
          <div className="p-6 text-sm text-gray-400">Loading…</div>
        ) : approvals.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">No pending approvals. You&apos;re caught up.</p>
            <Link to="/newsletter" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300">
              ← Back to Newsletter home
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Stage</th>
                <th className="px-4 py-2">Edition</th>
                <th className="px-4 py-2">Excerpt</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Expires</th>
                <th className="px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => {
                const route = `/newsletter/approvals/${encodeURIComponent(a.token)}`;
                return (
                  <tr
                    key={a.token}
                    onClick={() => navigate(route)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(route); }
                    }}
                    className="cursor-pointer border-t border-gray-100 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:border-gray-800 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
                  >
                    <td className="px-4 py-2">
                      <StatusPill status={a.stage === 'stories' ? 'awaiting_stories_approval' : 'awaiting_subject_approval'} />
                      <span className="ml-2 text-xs text-gray-400">{STAGE_LABEL[a.stage]}</span>
                    </td>
                    <td className="px-4 py-2">
                      {fallbackEdition ? <EditionBadge edition={fallbackEdition} /> : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-2 max-w-md truncate">
                      {excerpt(a)}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {formatAbsolute(a.created_at)}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {formatRelative(a.expires_at, now)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to={route}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                      >
                        Review →
                      </Link>
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

function excerpt(a: OpenApproval): string {
  const p = a.payload as Record<string, unknown>;
  if (a.stage === 'stories') {
    const stories = (p.top_selected_stories as Array<{ title?: string }> | undefined) ?? [];
    const first = stories[0]?.title;
    if (first) return truncate(first, 140);
  } else if (a.stage === 'subject_line') {
    const subj = p.subject_line as string | undefined;
    if (subj) return truncate(subj, 140);
  }
  return '(no excerpt)';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatRelative(iso: string, nowMs: number): string {
  try {
    const ms = new Date(iso).getTime() - nowMs;
    if (ms <= 0) return 'expired';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `in ${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 48) return `in ${hrs}h`;
    return `in ${Math.floor(hrs / 24)}d`;
  } catch {
    return iso;
  }
}
