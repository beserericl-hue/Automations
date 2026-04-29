/**
 * IngestionBrowser — inspect the raw articles the cron worker has scraped
 * into content_ingestion_v2 for a given date.
 *
 *  - Date picker (defaults to today)
 *  - Table of ingested rows from /api/ingestion/search?prefix={date}/&user_id={me}&type_not=newsletter
 *  - Click-to-expand drawer: GET /api/ingestion/get/{key} → markdown + html tabs
 *
 * Uses the X-Ingestion-Secret-protected ingestion routes via the same
 * shared-secret pattern the cron uses; the public-API frontend instead
 * goes through a session-authed proxy. We piggyback on the existing
 * /api/ingestion/search and /api/ingestion/get/:key routes — they already
 * accept a session JWT through requireIngestionSecret? No — those are
 * shared-secret-only. So this page calls a session-auth wrapper.
 *
 * The wrapper doesn't exist yet; we add a thin GET /api/ingestion/mine
 * route in the server. For now though, route via the existing endpoints
 * with the X-Ingestion-Secret header would be wrong (the secret would
 * leak to the browser). The simplest correct thing is a NEW session-auth
 * route that filters by req.userId. We keep the cron-only routes as-is.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import HelpButton from './HelpButton';

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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function IngestionBrowser() {
  const [date, setDate] = useState<string>(todayIso());
  const [openKey, setOpenKey] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Ingestion browser</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Raw articles the cron scraped into content_ingestion_v2. The newsletter generator reads from this pool.
          </p>
        </div>
        <HelpButton section="ingestion" />
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-700 dark:text-gray-200">Date:</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </label>
        {listQuery.data && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {listQuery.data.items.length} items
          </span>
        )}
      </div>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {listQuery.isLoading ? (
          <div className="p-6 text-sm text-gray-400">Loading…</div>
        ) : listQuery.isError ? (
          <div className="p-6 text-sm text-red-600 dark:text-red-300">
            {(listQuery.error as ApiError).message ?? 'Failed to load.'}
          </div>
        ) : (listQuery.data?.items ?? []).length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            No items for {date}. Try yesterday, or check the Feeds page for last-fetch errors.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Published</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(listQuery.data?.items ?? []).map((it) => (
                <tr key={it.key} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2 max-w-md">
                    <button
                      type="button"
                      onClick={() => setOpenKey(it.key)}
                      className="text-left font-medium text-gray-900 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-300"
                    >
                      {it.title || '(untitled)'}
                    </button>
                    <div className="mt-0.5 text-xs text-gray-400 truncate">{it.key}</div>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{it.type}</td>
                  <td className="px-4 py-2">
                    {it.source_url ? (
                      <a href={it.source_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline dark:text-brand-300">
                        {it.source_name || 'source ↗'}
                      </a>
                    ) : (
                      <span className="text-xs text-gray-500">{it.source_name ?? '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {it.published_timestamp ? new Date(it.published_timestamp).toLocaleDateString() : '—'}
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

      {openKey && itemsByKey.get(openKey) && (
        <IngestionDrawer
          item={itemsByKey.get(openKey)!}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
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
