/**
 * Feeds list — per-edition feed source management. Implemented in Sprint 3.
 * Sprint 1 ships this as a routed stub so the "Feeds" button in EditionsList
 * lands on a page that exists.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import type { NewsletterEdition, NewsletterFeedSource } from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface FeedsResponse { success: boolean; feeds: NewsletterFeedSource[] }

const URL_TYPES: Array<NewsletterFeedSource['url_type']> = ['rss', 'reddit', 'source', 'firecrawl_scrape'];

export default function FeedsList() {
  const { id: editionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 30_000,
  });
  const edition = editionsQuery.data?.editions.find((e) => e.id === editionId) ?? null;

  const feedsQuery = useQuery({
    queryKey: ['newsletter-feeds', editionId],
    queryFn: () => apiFetch<FeedsResponse>(`/api/newsletter/editions/${encodeURIComponent(editionId!)}/feeds`),
    enabled: !!editionId,
    staleTime: 15_000,
  });
  const feeds = feedsQuery.data?.feeds ?? [];

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Reset banner when edition changes
  useEffect(() => { setError(null); }, [editionId]);

  async function handleToggle(f: NewsletterFeedSource) {
    setBusyId(f.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/feeds/${encodeURIComponent(f.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ active: !f.active }),
      });
      await qc.invalidateQueries({ queryKey: ['newsletter-feeds', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(f: NewsletterFeedSource) {
    if (!confirm(`Delete feed "${f.name}"?`)) return;
    setBusyId(f.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/feeds/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['newsletter-feeds', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusyId(null);
    }
  }

  if (!editionId) return null;
  if (editionsQuery.isLoading || feedsQuery.isLoading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (!edition) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        Newsletter not found, or you don't have access.{' '}
        <Link to="/newsletter/editions" className="underline">Back to my newsletters</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={() => navigate('/newsletter/editions')}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
          >
            ← My newsletters
          </button>
          <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Feeds for {edition.display_name}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            RSS / Reddit / source URLs the cron worker polls to populate this newsletter's content pool.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setShowAdd(true); setEditingId(null); }}
          className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          Add feed
        </button>
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {(showAdd || editingId) && (
        <FeedEditor
          editionId={editionId}
          initial={editingId ? feeds.find((f) => f.id === editingId) ?? null : null}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
          onSaved={async () => {
            await qc.invalidateQueries({ queryKey: ['newsletter-feeds', editionId] });
            setShowAdd(false);
            setEditingId(null);
          }}
        />
      )}

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {feeds.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            No feeds yet. Click "Add feed" to add the first RSS / Reddit / source URL.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">URL</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Interval</th>
                <th className="px-4 py-2">Last fetch</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{f.name}</td>
                  <td className="px-4 py-2 max-w-md truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={f.url}>{f.url}</td>
                  <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{f.url_type}</td>
                  <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{f.fetch_interval_minutes}m</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {f.last_fetched_at ? new Date(f.last_fetched_at).toLocaleString() : '—'}
                    {f.last_item_count != null && (
                      <span className="ml-2 text-gray-400">({f.last_item_count} items)</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {f.last_error ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300" title={f.last_error}>
                        error
                      </span>
                    ) : f.active ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">active</span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">paused</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => { setEditingId(f.id); setShowAdd(false); }} className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300">Edit</button>
                      <button onClick={() => handleToggle(f)} disabled={busyId === f.id} className="text-xs font-medium text-gray-600 hover:text-gray-800 disabled:opacity-50 dark:text-gray-300">
                        {busyId === f.id ? '…' : f.active ? 'Pause' : 'Resume'}
                      </button>
                      <button onClick={() => handleDelete(f)} disabled={busyId === f.id} className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

interface FeedEditorProps {
  editionId: string;
  initial: NewsletterFeedSource | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

function FeedEditor({ editionId, initial, onClose, onSaved }: FeedEditorProps) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [urlType, setUrlType] = useState<NewsletterFeedSource['url_type']>(initial?.url_type ?? 'rss');
  const [interval, setIntervalMin] = useState<number>(initial?.fetch_interval_minutes ?? 240);
  const [active, setActive] = useState<boolean>(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !url.trim()) {
      setError('Name and URL are required.');
      return;
    }
    if (!/^https?:\/\//i.test(url.trim())) {
      setError('URL must start with http:// or https://');
      return;
    }
    setSaving(true);
    try {
      if (isEdit && initial) {
        await apiFetch(`/api/newsletter/feeds/${encodeURIComponent(initial.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ name, url, url_type: urlType, fetch_interval_minutes: interval, active }),
        });
      } else {
        await apiFetch(`/api/newsletter/editions/${encodeURIComponent(editionId)}/feeds`, {
          method: 'POST',
          body: JSON.stringify({ name, url, url_type: urlType, fetch_interval_minutes: interval, active }),
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSave}
      className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-900/40 dark:bg-brand-950/20"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{isEdit ? 'Edit feed' : 'Add feed'}</h2>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">Cancel</button>
      </div>
      {error && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">{error}</div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="text-xs">
          <span className="block text-gray-700 dark:text-gray-200">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
        </label>
        <label className="text-xs">
          <span className="block text-gray-700 dark:text-gray-200">Type</span>
          <select value={urlType} onChange={(e) => setUrlType(e.target.value as NewsletterFeedSource['url_type'])} className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
            {URL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-xs md:col-span-2">
          <span className="block text-gray-700 dark:text-gray-200">URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm font-mono dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
        </label>
        <label className="text-xs">
          <span className="block text-gray-700 dark:text-gray-200">Fetch interval (minutes)</span>
          <input type="number" min={5} max={1440} value={interval} onChange={(e) => setIntervalMin(parseInt(e.target.value, 10) || 240)} className="mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
        </label>
        <label className="flex items-center gap-2 text-xs pt-5">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
          <span className="text-gray-700 dark:text-gray-200">Active (poll on cron)</span>
        </label>
      </div>
      <div>
        <button type="submit" disabled={saving} className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {saving ? 'Saving…' : isEdit ? 'Save' : 'Add feed'}
        </button>
      </div>
    </form>
  );
}
