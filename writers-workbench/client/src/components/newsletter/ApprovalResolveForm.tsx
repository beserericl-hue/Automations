/**
 * Shared "Approve / Revise" form used by ExecutionStatus's awaiting-approval
 * panel (S7) and the approvals-detail page (S8). Posts to
 * `POST /api/newsletter/approvals/:token/resolve`.
 *
 * Validation:
 *   - decision required (radio is uncontrolled enough to default to 'approve')
 *   - if decision === 'revise', feedback must be non-empty (the LLM needs
 *     a concrete steer; this is how the workflow builds the next prompt)
 *
 * The component is uncontrolled in form-state but exposes onResolved so the
 * parent can advance its strip / clear the panel optimistically.
 */
import { useState } from 'react';
import { apiFetch, ApiError } from '../../lib/api';

interface ResolveResponseOk {
  success: true;
  resumed: boolean;
}
interface ResolveResponseErr {
  success: false;
  error: { code: string; message: string };
  resolved_at?: string | null;
  decision?: 'approve' | 'revise' | null;
  expires_at?: string;
}
type ResolveResponse = ResolveResponseOk | ResolveResponseErr;

interface Props {
  token: string;
  /** Notifies the parent on a successful resolve (200 OR 502 — the
   *  decision IS persisted in both). resumed=false signals n8n didn't ack. */
  onResolved: (decision: 'approve' | 'revise', resumed: boolean) => void;
  /** Optional disable while parent is in a busy state (e.g. another approval). */
  disabled?: boolean;
}

export default function ApprovalResolveForm({ token, onResolved, disabled }: Props) {
  const [decision, setDecision] = useState<'approve' | 'revise'>('approve');
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (decision === 'revise' && feedback.trim() === '') {
      setError('Revise needs feedback so the model knows what to change.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<ResolveResponse>(
        `/api/newsletter/approvals/${encodeURIComponent(token)}/resolve`,
        { method: 'POST', body: JSON.stringify({ decision, feedback: feedback.trim() }) },
      );
      // 200 path returns success: true / resumed: true.
      // The 502 path returns 200-shaped { success: true, resumed: false } per
      // the S5 server contract (decision is persisted, n8n didn't ack).
      if (res.success) {
        onResolved(decision, res.resumed);
      } else {
        // Defensive — apiFetch throws on non-2xx, so we only land here on a
        // surprising 2xx-with-success-false.
        setError(res.error?.message ?? 'Resolve failed');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        // 409 already-resolved: surface a helpful message; parent can choose
        // to refresh state. 410 expired: same idea.
        if (err.status === 409) setError('This approval was already resolved.');
        else if (err.status === 410) setError('This approval has expired.');
        else if (err.status === 403) setError('You can only resolve your own approvals.');
        else if (err.status === 502) setError('Decision saved, but the workflow resume failed. The on-call operator can rerun.');
        else setError(err.message || `Request failed (${err.status})`);
      } else {
        setError('Unexpected error — see console.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <fieldset className="space-y-2" disabled={submitting || disabled}>
        <legend className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Your decision
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="decision"
            value="approve"
            checked={decision === 'approve'}
            onChange={() => setDecision('approve')}
            className="text-brand-600"
          />
          <span><strong>Approve</strong> — proceed with the workflow as proposed.</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="decision"
            value="revise"
            checked={decision === 'revise'}
            onChange={() => setDecision('revise')}
            className="text-brand-600"
          />
          <span><strong>Revise</strong> — send back with feedback below.</span>
        </label>
      </fieldset>

      <label className="block text-sm">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Feedback {decision === 'revise' && <span className="text-red-600">*</span>}
        </span>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          disabled={submitting || disabled}
          rows={3}
          maxLength={5000}
          placeholder={decision === 'revise' ? 'What should change?' : 'Optional notes…'}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting || disabled}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : decision === 'approve' ? 'Approve →' : 'Send back to revise →'}
        </button>
      </div>
    </form>
  );
}
