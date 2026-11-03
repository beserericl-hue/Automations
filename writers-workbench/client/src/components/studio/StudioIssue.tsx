/**
 * The next issue: which posts (and slate topics) go into the edition's next newsletter, in what order.
 * While a selection has stories, the newsletter run for this edition uses exactly these instead of
 * picking by itself; the issue then goes through the usual approvals (stories, subject, images, each
 * with an email preview). Approving the images renders and saves the issue; it then waits at a final
 * "Send to subscribers" approval that shows the rendered email and the subscriber count, offers a
 * test copy to the owner, and sends nothing until it is approved (2026-11-03). This replaces the n8n
 * weekly digest email. Also here: the edition's public RSS feeds for Substack, and the record of
 * each "Email me the week's slate" (migration 052).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { STATE_LABEL, studioApi, type IssueItem } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';

type Item = { kind: 'post' | 'topic'; id: string; title: string; note: string };

function todayEt(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function toItem(i: IssueItem): Item {
  const note = i.kind === 'post' ? `#${i.display_number ?? '?'} · ${STATE_LABEL[i.state ?? ''] ?? i.state ?? ''}` : `slate ${i.rank ?? '?'} · week of ${i.week_of ?? ''}`;
  return { kind: i.kind, id: i.id, title: i.title ?? '(gone)', note };
}

export default function StudioIssue({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const navigate = useNavigate();
  const issue = useQuery({ queryKey: ['studio', ed, 'issue'], queryFn: () => studioApi.issue(ed) });
  const approved = useQuery({ queryKey: ['studio', ed, 'posts', 'all'], queryFn: () => studioApi.posts(ed, 'all') });
  const slate = useQuery({ queryKey: ['studio', ed, 'slate', ctx.week], queryFn: () => studioApi.slate(ed, ctx.week) });
  const [items, setItems] = useState<Item[]>([]);
  const [dirty, setDirty] = useState(false);
  const [sendDate, setSendDate] = useState(todayEt());
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dirty && issue.data) setItems(issue.data.data.items.map(toItem));
  }, [issue.data, dirty]);

  const save = useMutation({
    mutationFn: () => studioApi.setIssue(ed, items.map(({ kind, id }) => ({ kind, id }))),
    onSuccess: (r) => { setDirty(false); ctx.notify(r.data.message ?? 'Saved the next issue.'); ctx.refresh(); setError(''); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the selection'),
  });
  const fresh = useMutation({
    mutationFn: () => studioApi.newIssue(ed),
    onSuccess: () => { setDirty(false); ctx.refresh(); ctx.notify('Started a new selection for the next issue.'); },
  });
  const generate = useMutation({
    mutationFn: () => apiFetch<{ executionId: string }>('/api/newsletter/generate', { method: 'POST', body: JSON.stringify({ edition_id: ed, send_date: sendDate }) }),
    onSuccess: (r) => navigate(`/newsletter/execution/${encodeURIComponent(r.executionId)}`),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start the issue'),
  });

  const has = (kind: string, id: string) => items.some((i) => i.kind === kind && i.id === id);
  const add = (i: Item) => { if (!has(i.kind, i.id)) { setItems([...items, i]); setDirty(true); } };
  const move = (n: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(n, 1);
    next.splice(Math.max(0, Math.min(next.length, n + d)), 0, x);
    setItems(next); setDirty(true);
  };
  const posts = (approved.data?.data ?? []).filter((p) => !['draft', 'cancelled'].includes(p.state));
  const topics = slate.data?.data.topics ?? [];
  const last = issue.data?.data.last_issue;

  return (
    <section className="space-y-4" data-testid="studio-issue">
      <div className="space-y-2 rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="font-semibold text-gray-800 dark:text-gray-100">Next issue of {ctx.edition.name}</h2>
        <p className="text-xs text-gray-500">
          {items.length
            ? 'The next newsletter run for this edition uses exactly these stories, in this order (no automatic pick).'
            : 'Nothing chosen: the next run picks from the week’s slate and posts by itself.'}
          {' '}Nothing reaches subscribers until you approve the final “Send to subscribers” step.
          {last?.send_date ? ` Last chosen issue: ${last.send_date}.` : ''}
        </p>
        <ol className="space-y-1" data-testid="issue-items">
          {items.map((i, n) => (
            <li key={`${i.kind}-${i.id}`} className="flex items-center gap-2 text-sm" data-testid={`issue-item-${n + 1}`}>
              <span className="w-5 text-right text-gray-400">{n + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{i.title}</span>
              <span className="text-xs text-gray-500">{i.note}</span>
              <button type="button" aria-label="Move up" onClick={() => move(n, -1)} disabled={n === 0} className="px-1 disabled:opacity-30">↑</button>
              <button type="button" aria-label="Move down" onClick={() => move(n, 1)} disabled={n === items.length - 1} className="px-1 disabled:opacity-30">↓</button>
              <button type="button" aria-label="Remove" onClick={() => { setItems(items.filter((_, k) => k !== n)); setDirty(true); }} className="px-1 text-red-600">✕</button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="issue-save"
            className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">Save selection</button>
          <button type="button" onClick={() => fresh.mutate()} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600">Start a new selection</button>
          <span className="ml-auto flex items-center gap-2">
            <input type="date" aria-label="Send date" value={sendDate} onChange={(e) => setSendDate(e.target.value)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
            <button type="button" disabled={dirty || !items.length || generate.isPending} onClick={() => generate.mutate()} data-testid="issue-generate"
              className="rounded border border-brand-600 px-3 py-1.5 text-brand-700 disabled:opacity-50 dark:text-brand-300">Generate the issue</button>
          </span>
        </div>
        {dirty && <p className="text-xs text-amber-700">Unsaved changes. Save before generating.</p>}
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 font-semibold text-gray-700 dark:text-gray-200">Add posts</h3>
          {!posts.length && <p className="text-xs text-gray-500">Approved, scheduled and published posts of this edition appear here.</p>}
          <ul className="max-h-80 space-y-1 overflow-auto">
            {posts.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <button type="button" disabled={has('post', p.id)} onClick={() => add({ kind: 'post', id: p.id, title: p.title, note: `#${p.display_number} · ${STATE_LABEL[p.state] ?? p.state}` })}
                  className="rounded border border-gray-300 px-1.5 text-xs disabled:opacity-30 dark:border-gray-600" data-testid={`issue-add-post-${p.display_number}`}>Add</button>
                <span className="truncate">#{p.display_number} {p.title}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 font-semibold text-gray-700 dark:text-gray-200">Add slate topics (week of {slate.data?.data.week_of ?? '—'})</h3>
          <ul className="max-h-80 space-y-1 overflow-auto">
            {topics.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <button type="button" disabled={has('topic', t.id)} onClick={() => add({ kind: 'topic', id: t.id, title: t.title, note: `slate ${t.rank} · week of ${t.week_of}` })}
                  className="rounded border border-gray-300 px-1.5 text-xs disabled:opacity-30 dark:border-gray-600" data-testid={`issue-add-topic-${t.rank}`}>Add</button>
                <span className="truncate">{t.rank}. {t.title}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <StudioFeeds ctx={ctx} />
    </section>
  );
}

function StudioFeeds({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const feeds = useQuery({ queryKey: ['studio', ed, 'feeds'], queryFn: () => studioApi.feeds(ed) });
  const rotate = useMutation({ mutationFn: () => studioApi.rotateFeeds(ed), onSuccess: () => { void feeds.refetch(); ctx.notify('New feed URLs made; the old ones no longer work. Update Substack.'); } });
  const sentSlates = useQuery({ queryKey: ['studio', ed, 'digest-emails'], queryFn: () => studioApi.digestEmails(ed) });
  const emailDigest = useMutation({
    mutationFn: () => studioApi.emailDigest(ed, ctx.week),
    onSuccess: (r) => { ctx.notify(r.data.message); void sentSlates.refetch(); },
  });
  const f = feeds.data?.data;
  const lastSlate = sentSlates.data?.data?.[0];
  return (
    <div className="space-y-2 rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900" data-testid="studio-feeds">
      <h3 className="font-semibold text-gray-700 dark:text-gray-200">RSS feeds (Substack)</h3>
      <p className="text-xs text-gray-500">Public, read-only. Per post: every post that has gone out, without the subscribe call to action or hashtags. Weekly digest: one item per week with the whole slate. Anyone with a URL can read the feed.</p>
      {f && (
        <dl className="space-y-1">
          <div><dt className="text-xs text-gray-500">Per post</dt><dd><a href={f.items} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline" data-testid="feed-items-url">{f.items}</a></dd></div>
          <div><dt className="text-xs text-gray-500">Weekly digest</dt><dd><a href={f.digest} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline" data-testid="feed-digest-url">{f.digest}</a></dd></div>
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => { if (window.confirm('Make new feed URLs? The current ones stop working.')) rotate.mutate(); }} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600">New URLs</button>
        <button type="button" onClick={() => emailDigest.mutate()} disabled={emailDigest.isPending} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Email me the week’s slate</button>
      </div>
      {lastSlate && (
        <p className="text-xs text-gray-500" data-testid="slate-email-last">
          Last slate email: week of {lastSlate.week_of ?? '—'} to {lastSlate.to_email}, {new Date(lastSlate.sent_at).toLocaleString()}
          {lastSlate.postal_message_id ? <span className="font-mono"> · {lastSlate.postal_message_id}</span> : null}
        </p>
      )}
    </div>
  );
}
