/**
 * S12-10 UI MVP — Rewrite-with-Research modal.
 *
 * Opens from the chapter detail view. Collects:
 *   - research_focus (required, 10..2000 chars)
 *   - use_qa_report (default false, auto-checked if chapter has a qa_report)
 *   - style_directives (optional)
 *   - citation_mode: auto | invisible | inline
 *
 * On submit POSTs to /api/content/:id/rewrite-with-research which enqueues
 * a heavy-ops BullMQ job. Progress surfaces via the existing SSE
 * `chat-job-status` event on the window object (AppShell forwards
 * `job-status` -> `chat-job-status`).
 */
import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabase';

interface Props {
  contentId: string;
  chapterLabel: string;
  hasQaReport: boolean;
  projectType: string | null | undefined;
  onClose: () => void;
  onEnqueued?: (jobId: string) => void;
}

type CitationMode = 'auto' | 'invisible' | 'inline';

export default function RewriteWithResearchModal({
  contentId,
  chapterLabel,
  hasQaReport,
  projectType,
  onClose,
  onEnqueued,
}: Props) {
  const [researchFocus, setResearchFocus] = useState('');
  const [useQa, setUseQa] = useState(hasQaReport);
  const [styleDirectives, setStyleDirectives] = useState('');
  const [citationMode, setCitationMode] = useState<CitationMode>('auto');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoHint = (() => {
    const pt = (projectType || 'fiction').toLowerCase();
    if (pt === 'non_fiction' || pt === 'nonfiction') return 'auto → inline (project is non-fiction)';
    return 'auto → invisible (project is fiction)';
  })();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  async function submit() {
    if (submitting) return;
    if (researchFocus.trim().length < 10) {
      setError('research_focus must be at least 10 characters');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/content/${contentId}/rewrite-with-research`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token ?? ''}`,
        },
        body: JSON.stringify({
          research_focus: researchFocus.trim(),
          use_qa_report: useQa,
          style_directives: styleDirectives.trim() || undefined,
          citation_mode: citationMode,
        }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        jobId?: string;
        error?: { message?: string };
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error?.message || `Enqueue failed (${res.status})`);
      }
      onEnqueued?.(body.jobId ?? '');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-800 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 dark:border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Rewrite {chapterLabel} with research
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Grounds character arguments, historical references, and technical vocabulary in real
            facts. For fiction projects the prose stays fiction — no footnotes or source labels
            appear in the rewritten chapter. Citations are preserved in a separate research report.
          </p>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Research focus <span className="text-red-500">*</span>
            </label>
            <textarea
              value={researchFocus}
              onChange={(e) => setResearchFocus(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="e.g. reconcile Lucia Morales' identity with chapters 1-2 and ground the First Amendment compelled speech argument in actual case law"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <p className="mt-1 text-[11px] text-gray-400">{researchFocus.length} / 2000</p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={useQa}
                onChange={(e) => setUseQa(e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-700"
              />
              Also address the chapter&apos;s last Q/A report
              {!hasQaReport && (
                <span className="text-gray-400">(no stored Q/A report for this chapter)</span>
              )}
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Style directives (optional)
            </label>
            <textarea
              value={styleDirectives}
              onChange={(e) => setStyleDirectives(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="e.g. tighter prose, fewer adverbs, keep Mason's internal monologue voice"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Citation mode
            </label>
            <div className="flex flex-col gap-1 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="citation_mode"
                  checked={citationMode === 'auto'}
                  onChange={() => setCitationMode('auto')}
                />
                <span className="text-gray-700 dark:text-gray-300">
                  Auto — derive from project type <span className="text-gray-400">({autoHint})</span>
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="citation_mode"
                  checked={citationMode === 'invisible'}
                  onChange={() => setCitationMode('invisible')}
                />
                <span className="text-gray-700 dark:text-gray-300">
                  Invisible — research grounds prose, no footnotes (force fiction mode)
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="citation_mode"
                  checked={citationMode === 'inline'}
                  onChange={() => setCitationMode('inline')}
                />
                <span className="text-gray-700 dark:text-gray-300">
                  Inline — markdown footnotes in prose (force non-fiction mode)
                </span>
              </label>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
            Rewrites typically take 2-4 minutes (Perplexity research + Claude rewrite). The job runs
            in the background; progress will appear in the chat drawer.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-800 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || researchFocus.trim().length < 10}
            className="rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-brand-400 px-4 py-1.5 text-xs font-medium text-white"
          >
            {submitting ? 'Queuing...' : 'Rewrite with research'}
          </button>
        </div>
      </div>
    </div>
  );
}
