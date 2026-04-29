/**
 * IngestionBrowser — inspect the raw articles the cron worker has scraped
 * into content_ingestion_v2. Now defaults to the most recent day that has
 * any content (rather than today, which is often empty); shows a sidebar
 * of "days with content"; surfaces a "Manage feeds" shortcut so users can
 * jump straight to where new ingestion URLs are added.
 *
 * Each row shows title, type, source URL, published date, AND scanned date.
 *
 * Calls (all session-authed; the cron's shared-secret routes are kept
 * separate so the browser never sees the secret):
 *
 *   GET /api/ingestion/mine/days
 *   GET /api/ingestion/mine?date=YYYY-MM-DD
 *   GET /api/ingestion/mine/get?key=YYYY-MM-DD/slug.source
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import HelpButton from './HelpButton';
import type { NewsletterEdition } from '../../types/database';

interface IngestionItem {
  id: string;
  key: string;
  user_id: string;
  type: string;
  title: string | null;
  authors: string[] | null;
  source_name: string | null;
  source_url: string | null;
  published_timestamp: string | null;
  feed_url: string | null;
  storage_path_md: string;
  storage_path_html: string;
  created_at: string;
}
interface SearchResponse { success: boolean; items: IngestionItem[] }
interface GetResponse {
  success: boolean;
  item: IngestionItem;
  markdown: string;
  html: string;
}
interface DaysResponse {
  success: boolean;
  days: Array<{ date: string; total: number; types: Record<string, number> }>;
}
interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function IngestionBrowser() {
  // Days-with-content sidebar — always loaded so the picker has options.
  const daysQuery = useQuery({
    queryKey: ['ingestion-days'],
    queryFn: () => apiFetch<DaysResponse>('/api/ingestion/mine/days'),
    staleTime: 30_000,
  });
  const days = daysQuery.data?.days ?? [];

  // Default to the most recent day with content (rather than today, which is
  // often empty when the cron hasn't fired yet). User can change with the
  // picker or sidebar.
  const [date, setDate] = useState<string>(todayIso());
  const [dateTouched, setDateTouched] = useState(false);
  useEffect(() => {
    if (!dateTouched && days[0]) setDate(days[0].date);
  }, [days, dateTouched]);

  const [openKey, setOpenKey] = useState<string | null>(null);

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });
  const firstEdition = editionsQuery.data?.editions?.[0] ?? null;

  const listQuery = useQuery({
    queryKey: ['ingestion-list', date],
    queryFn: () =>
      apiFetch<SearchResponse>(`/api/ingestion/mine?date=${encodeURIComponent(date)}`),
    staleTime: 30_000,
  });

  const itemsByKey = useMemo(() => {
    const m = new Map<string, IngestionItem>();
    for (const it of listQuery.data?.items ?? []) m.set(it.key, it);
    return m;
  }, [listQuery.data]);
  const items = listQuery.data?.items ?? [];

  const totalAcrossAllDays = days.reduce((acc, d) => acc + d.total, 0);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Ingestion library</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Every article the cron scraped from your feeds. {totalAcrossAllDays.toLocaleString()} total across {days.length} {days.length === 1 ? 'day' : 'days'}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {firstEdition && (
            <Link
              to={`/newsletter/editions/${encodeURIComponent(firstEdition.id)}/feeds`}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Manage feeds →
            </Link>
          )}
          <HelpButton section="ingestion" />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
        {/* Days sidebar */}
        <aside className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Days with content</h2>
          {daysQuery.isLoading ? (
            <div className="text-xs text-gray-400">Loading…</div>
          ) : days.length === 0 ? (
            <div className="text-xs text-gray-400">
              No ingested articles yet. The cron polls every 30 min — once your feeds' fetch intervals elapse, content will appear here.
            </div>
          ) : (
            <ul className="space-y-0.5 max-h-96 overflow-y-auto">
              {days.map((d) => (
                <li key={d.date}>
                  <button
                    type="button"
                    onClick={() => { setDate(d.date); setDateTouched(true); }}
                    className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${
                      d.date === date
                        ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200'
                        : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    <span>{d.date}</span>
                    <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">{d.total}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Main pane */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-gray-700 dark:text-gray-200">Date:</span>
              <input
                type="date"
                value={date}
                onChange={(e) => { setDate(e.target.value); setDateTouched(true); }}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
            </label>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {listQuery.isLoading ? 'Loading…' : `${items.length} ${items.length === 1 ? 'article' : 'articles'}`}
            </span>
          </div>

          <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
            {listQuery.isLoading ? (
              <div className="p-6 text-sm text-gray-400">Loading…</div>
            ) : listQuery.isError ? (
              <div className="p-6 text-sm text-red-600 dark:text-red-300">
                {(listQuery.error as ApiError).message ?? 'Failed to load.'}
              </div>
            ) : items.length === 0 ? (
              <div className="p-12 text-center text-sm text-gray-400">
                No items for {date}.
                {firstEdition && (
                  <>
                    {' '}Check the{' '}
                    <Link to={`/newsletter/editions/${encodeURIComponent(firstEdition.id)}/feeds`} className="underline">
                      Feeds page
                    </Link>{' '}for last-fetch errors.
                  </>
                )}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-2">Title</th>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Published</th>
                    <th className="px-4 py-2">Scanned</th>
                    <th className="px-4 py-2 text-right">View</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.key} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-4 py-2 max-w-md">
                        <button
                          type="button"
                          onClick={() => setOpenKey(it.key)}
                          className="text-left font-medium text-gray-900 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-300"
                        >
                          {it.title || '(untitled)'}
                        </button>
                        <div className="mt-0.5 text-xs text-gray-400 truncate font-mono">{it.key}</div>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{it.type}</td>
                      <td className="px-4 py-2 max-w-xs">
                        {it.source_url ? (
                          <a href={it.source_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline dark:text-brand-300 break-all">
                            {it.source_name || hostnameOf(it.source_url)} ↗
                          </a>
                        ) : (
                          <span className="text-xs text-gray-500">{it.source_name ?? '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                        {it.published_timestamp ? new Date(it.published_timestamp).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                        {new Date(it.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setOpenKey(it.key)}
                          className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>

      {openKey && itemsByKey.get(openKey) && (
        <IngestionDrawer
          item={itemsByKey.get(openKey)!}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

interface DrawerProps { item: IngestionItem; onClose: () => void }

function IngestionDrawer({ item, onClose }: DrawerProps) {
  const [tab, setTab] = useState<'markdown' | 'html'>('markdown');
  const detailQuery = useQuery({
    queryKey: ['ingestion-detail', item.key],
    queryFn: () => apiFetch<GetResponse>(`/api/ingestion/mine/get?key=${encodeURIComponent(item.key)}`),
    staleTime: 60_000,
  });
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="relative z-10 flex h-full w-full max-w-3xl flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <header className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {item.title || '(untitled)'}
              </h2>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 font-mono break-all">{item.key}</div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
                <span>type: <span className="font-medium text-gray-700 dark:text-gray-200">{item.type}</span></span>
                {item.source_name && <span>source: <span className="font-medium text-gray-700 dark:text-gray-200">{item.source_name}</span></span>}
                <span>scanned: <span className="font-medium text-gray-700 dark:text-gray-200">{new Date(item.created_at).toLocaleString()}</span></span>
                {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer" className="text-brand-700 underline dark:text-brand-300">open original ↗</a>}
              </div>
            </div>
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400">Close</button>
          </div>
          <div className="mt-3 flex gap-2 text-xs">
            {(['markdown', 'html'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-2 py-1 font-medium ${
                  tab === t
                    ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {detailQuery.isLoading ? (
            <div className="p-6 text-sm text-gray-400">Loading…</div>
          ) : detailQuery.isError ? (
            <div className="p-6 text-sm text-red-600 dark:text-red-300">
              {(detailQuery.error as ApiError).message ?? 'Failed to load detail.'}
            </div>
          ) : tab === 'markdown' ? (
            <pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-gray-800 dark:text-gray-200">
              {detailQuery.data?.markdown ?? ''}
            </pre>
          ) : (
            <iframe
              title="Ingestion HTML preview"
              sandbox=""
              srcDoc={detailQuery.data?.html ?? ''}
              className="block min-h-full w-full border-0"
            />
          )}
        </div>
      </div>
    </div>
  );
}
