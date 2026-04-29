/**
 * NewsletterDetail — drilldown for one send. Renders:
 *   - main: html_body in a sandboxed iframe (so the email's CSS doesn't
 *     leak into the app shell, and any pasted scripts don't execute)
 *   - sidebar: subject, preheader, edition, status, dates, execution id,
 *     recipient count, provider info, error (if any)
 *   - footer: collapsible markdown source for copy-paste / debug
 *
 * Loads from GET /api/newsletter/sends/:id (owner-only, returns 404 for
 * other users' sends thanks to the user_id filter).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import EditionBadge from './EditionBadge';
import type { NewsletterEdition, NewsletterSend } from '../../types/database';

interface SendResponse { success: boolean; send: NewsletterSend }
interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }

export default function NewsletterDetail() {
  const { id } = useParams<{ id: string }>();
  const [showMarkdown, setShowMarkdown] = useState(false);

  const sendQuery = useQuery({
    queryKey: ['newsletter-send', id],
    queryFn: () => apiFetch<SendResponse>(`/api/newsletter/sends/${encodeURIComponent(id!)}`),
    enabled: !!id,
    staleTime: 10_000,
  });
  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });

  const send = sendQuery.data?.send;
  const edition = send?.edition_id
    ? editionsQuery.data?.editions.find((e) => e.id === send.edition_id) ?? null
    : null;

  if (sendQuery.isLoading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (sendQuery.isError) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
        Couldn't load this newsletter. {(sendQuery.error as Error).message}
        <div className="mt-2"><Link to="/newsletter/sends" className="underline">Back to sends</Link></div>
      </div>
    );
  }
  if (!send) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        Send not found.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <Link to="/newsletter/sends" className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">← Sends</Link>
        <div className="mt-1 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{send.subject}</h1>
            {send.preheader && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{send.preheader}</p>
            )}
          </div>
          <StatusPill status={send.status} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Rendered email */}
        <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <header className="flex items-center justify-between border-b border-gray-100 px-4 py-2 dark:border-gray-800">
            <h2 className="text-sm font-medium">Rendered HTML</h2>
            <span className="text-xs text-gray-400">{(send.html_body || '').length.toLocaleString()} chars</span>
          </header>
          {send.html_body ? (
            <iframe
              title="Newsletter HTML preview"
              sandbox=""
              srcDoc={send.html_body}
              className="block min-h-[800px] w-full border-0"
            />
          ) : (
            <div className="p-12 text-center text-sm text-gray-400">No HTML stored for this send.</div>
          )}
        </section>

        {/* Sidebar */}
        <aside className="space-y-3">
          <Tile label="Edition">
            {edition ? <EditionBadge edition={edition} /> : <span className="font-mono text-xs">{send.edition_id ?? '—'}</span>}
          </Tile>
          <Tile label="Issue">
            {send.issue_number != null ? `#${send.issue_number}` : '—'}
            <span className="ml-2 text-xs text-gray-400">{formatDate(send.send_date)}</span>
          </Tile>
          {send.scheduled_send_at && (
            <Tile label="Scheduled">{formatDateTime(send.scheduled_send_at)}</Tile>
          )}
          {send.sent_at && (
            <Tile label="Sent">{formatDateTime(send.sent_at)}</Tile>
          )}
          {send.recipient_count != null && (
            <Tile label="Recipients">{send.recipient_count.toLocaleString()}</Tile>
          )}
          {send.delivery_provider && (
            <Tile label="Provider">
              {send.delivery_provider}
              {send.provider_message_id && (
                <span className="ml-2 font-mono text-xs text-gray-400">{send.provider_message_id}</span>
              )}
            </Tile>
          )}
          {send.execution_id && (
            <Tile label="Execution">
              <Link
                to={`/newsletter/execution/${encodeURIComponent(send.execution_id)}`}
                className="font-mono text-xs text-brand-700 hover:underline dark:text-brand-300"
              >
                {send.execution_id}
              </Link>
            </Tile>
          )}
          {send.error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
              <div className="mb-1 font-semibold">Error</div>
              <div className="font-mono whitespace-pre-wrap break-all">{send.error}</div>
            </div>
          )}
          <Tile label="Created">{formatDateTime(send.created_at)}</Tile>
          <Tile label="Updated">{formatDateTime(send.updated_at)}</Tile>
        </aside>
      </div>

      {/* Markdown source — collapsed by default */}
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setShowMarkdown((v) => !v)}
          className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-2 text-left text-sm font-medium hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800"
        >
          <span>Markdown source</span>
          <span className="text-xs text-gray-400">{showMarkdown ? 'Hide' : 'Show'}</span>
        </button>
        {showMarkdown && (
          <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-xs text-gray-800 dark:text-gray-200">
            {send.markdown_body ?? '(no markdown stored)'}
          </pre>
        )}
      </section>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-gray-900 dark:text-gray-100">{children}</div>
    </div>
  );
}

function StatusPill({ status }: { status: NewsletterSend['status'] }) {
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
function formatDateTime(s: string): string {
  try {
    return new Date(s).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return s; }
}
