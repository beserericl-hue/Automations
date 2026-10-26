/**
 * After the page is up: where to buy the book once it is on sale, and email to the people who
 * reserved a copy.
 *
 * Every email is sent one reader at a time, with their own unsubscribe link and a line saying why
 * they are getting it. "Send a test to me" goes to the author alone first, so the message is read
 * once in a real inbox before anyone else sees it.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

export interface Mailing {
  id: string;
  subject: string;
  recipients: number;
  sent: number;
  failed: number;
  created_at: string;
}

interface Props {
  projectId: string;
  published: boolean;
  subscribed: number;
  buy: { url: string; label: string } | null;
  mailings: Mailing[];
  queryKey: readonly unknown[];
}

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = (err.body as { error?: { fields?: { field: string; message: string }[] } } | null)?.error?.fields;
    if (fields?.length) return fields.map((f) => `${f.field}: ${f.message}`).join('; ');
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export default function ReaderFollowUp({ projectId, published, subscribed, buy, mailings, queryKey }: Props) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const base = `/api/landing-page/project/${projectId}`;
  const [buyUrl, setBuyUrl] = useState('');
  const [buyLabel, setBuyLabel] = useState('Buy the book');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [tested, setTested] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setBuyUrl(buy?.url ?? '');
    setBuyLabel(buy?.label ?? 'Buy the book');
  }, [buy]);

  const saveBuy = useMutation({
    mutationFn: async (url: string | null) =>
      apiFetch(`${base}/buy-link`, { method: 'PUT', body: JSON.stringify({ url, label: buyLabel.trim() || undefined }) }),
    onSuccess: (_d, url) => {
      void queryClient.invalidateQueries({ queryKey });
      addToast(url ? 'Buy link saved. The page now sends readers to it.' : 'Buy link removed', 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const send = useMutation({
    mutationFn: async (test: boolean) =>
      (
        await apiFetch<ApiEnvelope<{ test?: boolean; to?: string; ok?: boolean; sent?: number; failed?: number; recipients?: number }>>(
          `${base}/mailings`,
          { method: 'POST', body: JSON.stringify({ subject, body, test }) },
        )
      ).data!,
    onSuccess: (d) => {
      if (d.test) {
        if (d.ok) {
          setTested(true);
          addToast(`Test sent to ${d.to}`, 'success');
        } else addToast('The test could not be sent', 'error');
        return;
      }
      setConfirming(false);
      setSubject('');
      setBody('');
      setTested(false);
      void queryClient.invalidateQueries({ queryKey });
      addToast(`Sent to ${d.sent} of ${d.recipients}${d.failed ? ` (${d.failed} failed)` : ''}`, d.failed ? 'error' : 'success');
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  return (
    <div className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-800">
      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Where to buy it</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Once the book is on sale, paste its store page. The page’s buttons then go there, and the form below them
          becomes “hear when the next book is out”.
        </p>
        <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
          <input aria-label="Buy link" value={buyUrl} onChange={(e) => setBuyUrl(e.target.value)} placeholder="https://www.amazon.com/dp/…" className={inputClass} />
          <input aria-label="Button label" value={buyLabel} onChange={(e) => setBuyLabel(e.target.value)} className={inputClass} />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => saveBuy.mutate(buyUrl.trim())}
            disabled={!buyUrl.trim() || saveBuy.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300"
          >
            Save buy link
          </button>
          {buy ? (
            <button onClick={() => saveBuy.mutate(null)} className="text-xs text-gray-500 underline">
              Remove it (back to pre-orders)
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Write to the people who reserved a copy</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {subscribed} on the list. Each gets their own email, addressed by first name, with a link to stop them and a
          line saying they reserved a copy on your page.{buy ? ' Your buy link goes in as a button.' : ''} Replies come
          to you.
        </p>
        <input aria-label="Subject" value={subject} onChange={(e) => { setSubject(e.target.value); setTested(false); }} placeholder="Subject" className={inputClass} />
        <textarea
          aria-label="Message"
          value={body}
          onChange={(e) => { setBody(e.target.value); setTested(false); }}
          rows={6}
          placeholder="Plain text. A blank line starts a new paragraph."
          className={inputClass}
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => send.mutate(true)}
            disabled={!published || !subject.trim() || !body.trim() || send.isPending}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300"
          >
            Send a test to me
          </button>
          {confirming ? (
            <>
              <button
                onClick={() => send.mutate(false)}
                disabled={send.isPending}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {send.isPending ? 'Sending…' : `Yes, send to ${subscribed}`}
              </button>
              <button onClick={() => setConfirming(false)} className="text-xs text-gray-500 underline">
                Not yet
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={!published || !tested || !subscribed}
              title={tested ? undefined : 'Send yourself a test first'}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Send to {subscribed} {subscribed === 1 ? 'person' : 'people'}
            </button>
          )}
        </div>
        {!tested && subject && body ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">Send yourself a test first; then the real send unlocks.</p>
        ) : null}
        {mailings.length ? (
          <ul data-testid="mailings" className="divide-y divide-gray-100 text-xs text-gray-600 dark:divide-gray-800 dark:text-gray-400">
            {mailings.map((m) => (
              <li key={m.id} className="flex justify-between gap-2 py-1">
                <span>{m.subject}</span>
                <span>
                  {m.sent} of {m.recipients} sent{m.failed ? `, ${m.failed} failed` : ''} · {new Date(m.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
