/**
 * Newsletter Templates list (Templates Sprint — T3).
 *
 * Reads `/api/newsletter/templates`. Lets the caller filter by edition,
 * toggle inactive, and jump to the editor or delete a row. The default
 * template per edition gets a badge so it's obvious which one the
 * Generate flow + n8n send-time pipeline (T4) actually use.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import EditionBadge from './EditionBadge';
import type {
  NewsletterEdition,
  NewsletterTemplateListItem,
} from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface TemplatesResponse { success: boolean; templates: NewsletterTemplateListItem[] }

export default function TemplatesList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editionFilter, setEditionFilter] = useState<string>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });
  const editions = editionsQuery.data?.editions ?? [];
  const editionsById = new Map(editions.map((e) => [e.id, e]));

  const templatesQuery = useQuery({
    queryKey: ['newsletter-templates', editionFilter, includeInactive],
    queryFn: () => {
      const params = new URLSearchParams();
      if (editionFilter) params.set('edition_id', editionFilter);
      if (includeInactive) params.set('include_inactive', 'true');
      const qs = params.toString();
      return apiFetch<TemplatesResponse>(`/api/newsletter/templates${qs ? '?' + qs : ''}`);
    },
    staleTime: 30_000,
  });
  const templates = templatesQuery.data?.templates ?? [];

  async function handleDelete(t: NewsletterTemplateListItem) {
    if (t.is_default && t.active) {
      setError(`"${t.name}" is the active default for ${t.edition_id ?? 'this edition'}. Demote it first.`);
      return;
    }
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    setDeletingId(t.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['newsletter-templates'] });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Unexpected error');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Newsletter templates</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Branded HTML layouts. The default for each edition is what the AI pipeline uses at send time.
          </p>
        </div>
        <Link
          to="/newsletter/templates/new"
          className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          New template
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-700 dark:text-gray-200">Edition:</span>
          <select
            value={editionFilter}
            onChange={(e) => setEditionFilter(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">All editions</option>
            {editions.map((e) => (
              <option key={e.id} value={e.id}>{e.display_name} ({e.id})</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-gray-700 dark:text-gray-200">Show inactive</span>
        </label>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {templatesQuery.isLoading ? (
          <div className="p-6 text-sm text-gray-400">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            No templates yet — start with{' '}
            <Link to="/newsletter/templates/new" className="text-brand-700 hover:underline dark:text-brand-300">
              New template
            </Link>.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Edition</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Default</th>
                <th className="px-4 py-2">Active</th>
                <th className="px-4 py-2 text-right">Updated</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const edition = t.edition_id ? editionsById.get(t.edition_id) : null;
                return (
                  <tr key={t.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2">
                      <Link to={`/newsletter/templates/${encodeURIComponent(t.id)}`} className="font-medium text-gray-900 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-300">
                        {t.name}
                      </Link>
                      {t.description && (
                        <div className="text-xs text-gray-400 truncate max-w-xs">{t.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {edition ? <EditionBadge edition={edition} /> : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        t.source_type === 'system'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                      }`}>
                        {t.source_type}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {t.is_default ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                          default
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {t.active ? (
                        <span className="text-xs text-gray-600 dark:text-gray-300">yes</span>
                      ) : (
                        <span className="text-xs text-gray-400">no</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                      {formatDateTime(t.updated_at)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => navigate(`/newsletter/templates/${encodeURIComponent(t.id)}`)}
                          className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(t)}
                          disabled={deletingId === t.id}
                          className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
                        >
                          {deletingId === t.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
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

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}
