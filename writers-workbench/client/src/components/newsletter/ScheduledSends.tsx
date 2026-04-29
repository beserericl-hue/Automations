/**
 * ScheduledSends — replaces the Phase-2b stub with a real list view.
 *
 * Filters by status (default 'scheduled'; flip to draft/sent/failed) and
 * by edition. Each row links to NewsletterDetail for the rendered HTML
 * + lineage.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import EditionBadge from './EditionBadge';
import HelpButton from './HelpButton';
import type {
  NewsletterEdition,
  NewsletterSend,
  NewsletterSendStatus,
} from '../../types/database';

interface SendsResponse { success: boolean; sends: NewsletterSend[] }
interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }

const STATUSES: Array<NewsletterSendStatus | 'all'> = [
  'all', 'draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled',
];

export default function ScheduledSends() {
  const [status, setStatus] = useState<NewsletterSendStatus | 'all'>('scheduled');
  const [editionId, setEditionId] = useState<string>('');

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });
  const editions = editionsQuery.data?.editions ?? [];
  const editionsById = new Map(editions.map((e) => [e.id, e]));

  const sendsQuery = useQuery({
    queryKey: ['newsletter-sends', status, editionId],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (status !== 'all') qs.set('status', status);
      if (editionId) qs.set('edition_id', editionId);
      qs.set('limit', '50');
      return apiFetch<SendsResponse>(`/api/newsletter/sends?${qs.toString()}`);
    },
    staleTime: 15_000,
  });
  const sends = sendsQuery.data?.sends ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Sends</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Every newsletter run lands here. Click a row to see the rendered email + lineage.
          </p>
        </div>
        <HelpButton section="sends" />
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-700 dark:text-gray-200">Status:</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as NewsletterSendStatus | 'all')}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-700 dark:text-gray-200">Edition:</span>
          <select
            value={editionId}
            onChange={(e) => setEditionId(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">All editions</option>
            {editions.map((e) => <option key={e.id} value={e.id}>{e.display_name} ({e.id})</option>)}
          </select>
        </label>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {sendsQuery.isLoading ? (
          <div className="p-6 text-sm text-gray-400">Loading…</div>
        ) : sends.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            No sends matching that filter.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Subject</th>
                <th className="px-4 py-2">Edition</th>
                <th className="px-4 py-2">Issue</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Sent</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => {
                const edition = s.edition_id ? editionsById.get(s.edition_id) : null;
                return (
                  <tr key={s.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2">
                      <Link to={`/newsletter/sends/${encodeURIComponent(s.id)}`} className="font-medium text-gray-900 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-300">
                        {s.subject}
                      </Link>
                      {s.preheader && (
                        <div className="text-xs text-gray-400 truncate max-w-md">{s.preheader}</div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {edition ? <EditionBadge edition={edition} /> : <span className="text-xs text-gray-400">{s.edition_id ?? '—'}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">
                      {s.issue_number != null ? `#${s.issue_number}` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={s.status} />
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {formatDate(s.send_date)}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                      {s.sent_at ? new Date(s.sent_at).toLocaleString() : '—'}
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

function StatusPill({ status }: { status: NewsletterSendStatus }) {
  const cls =
    status === 'sent' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
    : status === 'sending' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
    : status === 'scheduled' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
    : status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    : status === 'cancelled' ? 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
    : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

function formatDate(s: string): string {
  try {
    return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return s; }
}
