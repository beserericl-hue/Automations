/**
 * Editions list — "My Newsletters". One row per edition owned by the
 * authenticated user, with quick actions for edit / disable.
 *
 * GET /api/newsletter/editions returns enabled editions only by default.
 * The "Show disabled" toggle hits /api/newsletter/editions?include_disabled=1
 * (server defaults to enabled-only; the include_disabled param is a future
 * extension — currently the toggle is a no-op until the GET route adds it).
 */
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch, ApiError } from '../../lib/api';
import EditionBadge from './EditionBadge';
import HelpButton from './HelpButton';
import type { NewsletterEdition } from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }

export default function EditionsList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [includeDisabled, setIncludeDisabled] = useState(false);

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions', { includeDisabled }],
    queryFn: () => apiFetch<EditionsResponse>(
      includeDisabled
        ? '/api/newsletter/editions?include_disabled=1'
        : '/api/newsletter/editions',
    ),
    staleTime: 30_000,
  });
  const editions = editionsQuery.data?.editions ?? [];

  async function handleDisable(e: NewsletterEdition) {
    if (!confirm(`Disable "${e.display_name}"? It will stop appearing in the Generate page and template list, but you can re-enable it from the disabled view.`)) return;
    setBusyId(e.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/editions/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['newsletter-editions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReenable(e: NewsletterEdition) {
    setBusyId(e.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/editions/${encodeURIComponent(e.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      });
      await qc.invalidateQueries({ queryKey: ['newsletter-editions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">My newsletters</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Each edition has its own branding, default template, and feed sources.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <HelpButton section="editions" />
          <Link
            to="/newsletter/editions/new"
            className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
          >
            New newsletter
          </Link>
        </div>
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeDisabled}
            onChange={(e) => setIncludeDisabled(e.target.checked)}
            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-gray-700 dark:text-gray-200">Show disabled</span>
        </label>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {editionsQuery.isLoading ? (
          <div className="p-6 text-sm text-gray-400">Loading…</div>
        ) : editions.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-400">
            No newsletters yet —{' '}
            <Link to="/newsletter/editions/new" className="text-brand-700 hover:underline dark:text-brand-300">create one</Link>.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-2">Newsletter</th>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Genre</th>
                <th className="px-4 py-2">Subheader</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Updated</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {editions.map((e) => (
                <tr key={e.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2">
                    <Link
                      to={`/newsletter/editions/${encodeURIComponent(e.id)}`}
                      className="font-medium text-gray-900 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-300"
                    >
                      <EditionBadge edition={e} />
                    </Link>
                    {e.description && (
                      <div className="mt-1 text-xs text-gray-400 truncate max-w-md">{e.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{e.id}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{e.genre}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 max-w-sm truncate">{e.subheader}</td>
                  <td className="px-4 py-2">
                    {e.enabled ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">active</span>
                    ) : (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">disabled</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400">{formatDate(e.updated_at)}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => navigate(`/newsletter/editions/${encodeURIComponent(e.id)}/feeds`)}
                        className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                      >
                        Feeds
                      </button>
                      <button
                        onClick={() => navigate(`/newsletter/editions/${encodeURIComponent(e.id)}`)}
                        className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                      >
                        Edit
                      </button>
                      {e.enabled ? (
                        <button
                          onClick={() => handleDisable(e)}
                          disabled={busyId === e.id}
                          className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
                        >
                          {busyId === e.id ? 'Disabling…' : 'Disable'}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleReenable(e)}
                          disabled={busyId === e.id}
                          className="text-xs font-medium text-emerald-700 hover:text-emerald-800 disabled:opacity-50 dark:text-emerald-300"
                        >
                          {busyId === e.id ? 'Re-enabling…' : 'Re-enable'}
                        </button>
                      )}
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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}
