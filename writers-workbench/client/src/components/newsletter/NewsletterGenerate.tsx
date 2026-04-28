/**
 * Generate page (Compose Newsletter 2a — S6).
 *
 * Three fields: Edition select, Send-date, Previous-newsletter-content
 * textarea. Submit hits POST /api/newsletter/generate and routes to
 * /newsletter/execution/<id> on success.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import EditionBadge from './EditionBadge';
import type { NewsletterEdition } from '../../types/database';

interface EditionsResponse {
  success: boolean;
  editions: NewsletterEdition[];
}

interface LastSentResponse {
  success: boolean;
  markdown: string | null;
}

interface GenerateResponse {
  success: boolean;
  executionId: string;
  editionId: string;
  started: boolean;
}

function todayIso(): string {
  // YYYY-MM-DD in the caller's local TZ. Server schema demands the
  // YYYY-MM-DD shape only, so DST changes are fine.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function NewsletterGenerate() {
  const navigate = useNavigate();
  const [editionId, setEditionId] = useState<string>('');
  const [sendDate, setSendDate] = useState<string>(todayIso());
  const [previousContent, setPreviousContent] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Editions
  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });
  const editions = editionsQuery.data?.editions ?? [];
  const selectedEdition = useMemo(
    () => editions.find((e) => e.id === editionId) ?? editions[0],
    [editions, editionId],
  );

  // Default the select to the first edition once editions load.
  useEffect(() => {
    if (!editionId && editions[0]) setEditionId(editions[0].id);
  }, [editionId, editions]);

  // Pre-fill "Previous Newsletter Content" textarea from the edition's
  // most recent send. Only fires after an edition is selected.
  const lastSentQuery = useQuery({
    queryKey: ['newsletter-last-sent', editionId],
    queryFn: () =>
      apiFetch<LastSentResponse>(
        `/api/newsletter/editions/${encodeURIComponent(editionId)}/last-sent-markdown`,
      ),
    enabled: !!editionId,
    staleTime: 60_000,
  });
  // Only auto-prefill when the user hasn't typed something else in.
  useEffect(() => {
    if (!previousContent && lastSentQuery.data?.markdown) {
      setPreviousContent(lastSentQuery.data.markdown);
    }
    // We intentionally leave previousContent as a user-typed value once they
    // edit it — switching editions while typing won't clobber their input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSentQuery.data?.markdown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!editionId || !sendDate) return;
    setSubmitting(true);
    try {
      const res = await apiFetch<GenerateResponse>('/api/newsletter/generate', {
        method: 'POST',
        body: JSON.stringify({
          edition_id: editionId,
          send_date: sendDate,
          previous_newsletter_content: previousContent,
        }),
      });
      navigate(`/newsletter/execution/${encodeURIComponent(res.executionId)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message || `Request failed (${err.status})`);
      } else {
        setSubmitError('Unexpected error — see console.');
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Generate newsletter</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Pick an edition, set the send date, and optionally paste prior content so the model avoids duplicate coverage.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {/* Edition */}
        <div>
          <label htmlFor="edition" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
            Edition
          </label>
          {editionsQuery.isLoading ? (
            <div className="text-sm text-gray-400">Loading editions…</div>
          ) : editions.length === 0 ? (
            <div className="text-sm text-amber-600 dark:text-amber-400">No enabled editions found.</div>
          ) : (
            <div className="flex items-center gap-3">
              <select
                id="edition"
                value={editionId}
                onChange={(e) => setEditionId(e.target.value)}
                disabled={submitting}
                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              >
                {editions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.display_name} ({e.id})
                  </option>
                ))}
              </select>
              {selectedEdition && <EditionBadge edition={selectedEdition} />}
            </div>
          )}
        </div>

        {/* Send date */}
        <div>
          <label htmlFor="send-date" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
            Send date
          </label>
          <input
            id="send-date"
            type="date"
            value={sendDate}
            onChange={(e) => setSendDate(e.target.value)}
            disabled={submitting}
            required
            className="block w-44 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>

        {/* Previous content */}
        <div>
          <label htmlFor="previous-content" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
            Previous newsletter content
            <span className="ml-2 text-xs font-normal text-gray-400">
              {lastSentQuery.isLoading ? 'pre-filling…' : 'pre-filled from your most recent send'}
            </span>
          </label>
          <textarea
            id="previous-content"
            value={previousContent}
            onChange={(e) => setPreviousContent(e.target.value)}
            disabled={submitting}
            rows={10}
            placeholder="Paste the last newsletter's markdown here so the model can avoid duplicate coverage."
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>

        {/* Submit */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-4 dark:border-gray-800">
          <div>
            {submitError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {submitError}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={submitting || !editionId}
            className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-gray-700"
          >
            {submitting ? 'Starting…' : 'Generate newsletter →'}
          </button>
        </div>
      </form>
    </div>
  );
}
