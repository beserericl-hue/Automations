/**
 * The final "Send to subscribers" gate (2026-11-03). The issue is rendered and saved; nothing has
 * reached a subscriber. Shows what approving will do (subject, issue number, how many active
 * subscribers) and offers "Send me a test copy": the rendered issue mailed to the signed-in owner's
 * own address only, "[TEST]" in the subject, through the same Postal path as the real send. Each
 * copy is recorded (who, when, Postal message id) and listed here.
 *
 * The rendered email itself is shown by ApprovalEmailPreview, which for this gate serves the saved
 * issue's HTML rather than a template approximation.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';

interface SendPayload {
  subject?: string;
  pre_header_text?: string;
  issue_number?: number | null;
  subscriber_count?: number | null;
  send_date?: string;
}

interface TestCopy {
  id: string;
  to_email: string;
  subject: string;
  postal_message_id: string | null;
  sent_at: string;
}

interface TestCopyResponse {
  success: boolean;
  data: { to: string | null; subject: string | null; message_id: string | null; sent_at: string | null; message: string };
}

function subscriberLine(count: number | null | undefined): string {
  if (typeof count !== 'number') return 'Approving sends it to every active subscriber of this edition.';
  if (count === 0) return 'This edition has no active subscribers: approving records the issue as sent and emails nobody.';
  return `Approving sends it to ${count} active subscriber${count === 1 ? '' : 's'}.`;
}

export default function ApprovalPayloadSend({ token, payload }: { token: string; payload: Record<string, unknown> }) {
  const p = payload as SendPayload;
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copies = useQuery({
    queryKey: ['newsletter-test-copies', token],
    queryFn: () => apiFetch<{ success: boolean; data: TestCopy[] }>(`/api/newsletter/approvals/${encodeURIComponent(token)}/test-copies`),
    staleTime: 10_000,
  });

  async function sendTestCopy() {
    setSending(true);
    setError(null);
    setNote(null);
    try {
      const r = await apiFetch<TestCopyResponse>(`/api/newsletter/approvals/${encodeURIComponent(token)}/test-copy`, { method: 'POST' });
      setNote(r.data.message);
      void queryClient.invalidateQueries({ queryKey: ['newsletter-test-copies', token] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the test copy');
    } finally {
      setSending(false);
    }
  }

  const sent = copies.data?.data ?? [];
  return (
    <div className="space-y-3" data-testid="send-gate">
      <section className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Ready to send{typeof p.issue_number === 'number' ? ` · Issue #${p.issue_number}` : ''}
        </div>
        <h3 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">{p.subject || 'Untitled issue'}</h3>
        {p.pre_header_text && (
          <p className="mt-1 border-l-2 border-gray-200 pl-3 text-sm italic text-gray-600 dark:border-gray-700 dark:text-gray-300">{p.pre_header_text}</p>
        )}
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-200" data-testid="send-gate-subscribers">
          Nothing has been sent yet. {subscriberLine(p.subscriber_count)}
        </p>
      </section>

      <section className="space-y-2 rounded-md border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void sendTestCopy()}
            disabled={sending}
            data-testid="send-test-copy"
            className="rounded-md border border-brand-600 px-3 py-1.5 font-medium text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-brand-300"
          >
            {sending ? 'Sending…' : 'Send me a test copy'}
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400">Goes to your own email only, marked [TEST]. Subscribers get nothing.</span>
        </div>
        {note && <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status" data-testid="test-copy-result">{note}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        {sent.length > 0 && (
          <ul className="space-y-0.5 text-xs text-gray-500 dark:text-gray-400" data-testid="test-copy-log">
            {sent.map((c) => (
              <li key={c.id}>
                Test copy to {c.to_email} · {new Date(c.sent_at).toLocaleString()}
                {c.postal_message_id ? <span className="font-mono"> · {c.postal_message_id}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
