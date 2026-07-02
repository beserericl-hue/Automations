/**
 * Generate page (Compose Newsletter 2a — S6).
 *
 * Three fields: Edition select, Send-date, Previous-newsletter-content
 * textarea. Submit hits POST /api/newsletter/generate and routes to
 * /newsletter/execution/<id> on success.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import EditionBadge from './EditionBadge';
import HelpButton from './HelpButton';
import type { NewsletterEdition, NewsletterTemplateListItem } from '../../types/database';

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

interface TemplatesListResponse {
  success: boolean;
  templates: NewsletterTemplateListItem[];
}

interface PreviewResponse {
  success: boolean;
  html: string;
  warnings: string[];
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

function formatLongDate(yyyyMmDd: string): string {
  // "2026-04-24" → "Friday, April 24, 2026" — what the masthead shows.
  // Tolerate parse failures by passing the raw string through.
  const [y, m, d] = yyyyMmDd.split('-').map((p) => parseInt(p, 10));
  if (!y || !m || !d) return yyyyMmDd;
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return yyyyMmDd;
  return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export default function NewsletterGenerate() {
  const navigate = useNavigate();
  // The setup wizard deep-links here as `?edition=<id>` ("Generate now →"); honour it so the chosen
  // edition is preselected instead of silently defaulting to editions[0].
  const [searchParams] = useSearchParams();
  const [editionId, setEditionId] = useState<string>(searchParams.get('edition') ?? '');
  const [templateId, setTemplateId] = useState<string>(''); // empty = use edition's default
  const [sendDate, setSendDate] = useState<string>(todayIso());
  const [previousContent, setPreviousContent] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Template preview (T4)
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

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

  // Default the select to the first edition once editions load. Also recover if a deep-linked
  // ?edition id isn't among the loaded editions (stale/invalid) — fall back to the first.
  useEffect(() => {
    if (!editions.length) return;
    if (!editionId || !editions.some((e) => e.id === editionId)) setEditionId(editions[0].id);
  }, [editionId, editions]);

  // Templates for the chosen edition. The dropdown shows them all; "" =
  // "use the active default" so users without preferences can ignore it.
  const templatesQuery = useQuery({
    queryKey: ['newsletter-templates', editionId],
    queryFn: () => apiFetch<TemplatesListResponse>(
      `/api/newsletter/templates?edition_id=${encodeURIComponent(editionId)}&include_inactive=false`,
    ),
    enabled: !!editionId,
    staleTime: 30_000,
  });
  const templates = templatesQuery.data?.templates ?? [];
  // Reset template selection when the edition changes — a non-default
  // template from the previous edition would be a confusing leftover.
  useEffect(() => { setTemplateId(''); }, [editionId]);

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

  async function handlePreview() {
    if (!editionId) return;
    setPreviewError(null);
    setPreviewHtml('');
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      // Find the active default template for this edition. The list endpoint
      // already orders is_default desc, so the first row is the right one.
      const list = await apiFetch<TemplatesListResponse>(
        `/api/newsletter/templates?edition_id=${encodeURIComponent(editionId)}`,
      );
      const def = list.templates.find((t) => t.is_default && t.active) ?? list.templates[0];
      if (!def) {
        setPreviewError(`No template found for edition "${editionId}". Create one in Newsletter → Templates.`);
        return;
      }
      // Render with sample-data fallback only — the AI hasn't run yet, so the
      // preview at compose time is the template + sample data, not real content.
      // Including the chosen send_date so the issue date in the preview matches.
      const res = await apiFetch<PreviewResponse>(
        `/api/newsletter/templates/${encodeURIComponent(def.id)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({ data: { issue: { date: formatLongDate(sendDate) } } }),
        },
      );
      setPreviewHtml(res.html);
    } catch (err) {
      if (err instanceof ApiError) setPreviewError(`${err.code}: ${err.message}`);
      else setPreviewError('Unexpected preview error');
    } finally {
      setPreviewLoading(false);
    }
  }

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
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Generate newsletter</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Pick an edition, set the send date, and optionally override the template or paste prior content so the model avoids duplicate coverage.
          </p>
        </div>
        <HelpButton section="generate" />
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

        {/* Template (optional override) */}
        <div>
          <label htmlFor="template" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
            Template
            <span className="ml-2 text-xs font-normal text-gray-400">
              defaults to the active default for this edition
            </span>
          </label>
          <select
            id="template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={submitting || !editionId || templatesQuery.isLoading}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">(default for this edition)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.is_default ? ' — default' : ''}
              </option>
            ))}
          </select>
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handlePreview()}
              disabled={submitting || previewLoading || !editionId}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              title="Render the active default template against its sample data"
            >
              {previewLoading ? 'Rendering…' : 'Preview template'}
            </button>
            <button
              type="submit"
              disabled={submitting || !editionId}
              className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-gray-700"
            >
              {submitting ? 'Starting…' : 'Generate newsletter →'}
            </button>
          </div>
        </div>
      </form>

      {/* Preview modal */}
      {previewOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Template preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setPreviewOpen(false); }}
        >
          <div className="flex h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-900">
            <header className="flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-700">
              <div>
                <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Template preview</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Default template for {selectedEdition?.display_name ?? editionId} rendered with sample data. Real AI content shows up at send time.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="rounded-md px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Close
              </button>
            </header>
            {previewError ? (
              <div role="alert" className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                {previewError}
              </div>
            ) : previewLoading ? (
              <div className="flex flex-1 items-center justify-center text-sm text-gray-400">Rendering…</div>
            ) : (
              <iframe
                title="Template preview iframe"
                sandbox=""
                srcDoc={previewHtml}
                className="block flex-1 w-full border-0"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
