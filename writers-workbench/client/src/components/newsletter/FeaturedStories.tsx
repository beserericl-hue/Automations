/**
 * Featured stories for an edition's next issue — on EVERY edition, not only a radar-fed one.
 *
 * Eric, 2026-11-05: "Newsletters are getting the scraped posts from the different blog sites, but since
 * we have radar blog posts, I want to use any one or more of those posts to be featured in any one of
 * my newsletters." The picker draws from the user's library: every radar post (any edition) and
 * recent slate topic (any radar). While the selection has items, the next run of this edition uses
 * exactly them, in this order, instead of the scraped pool and the AI pick.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { STATE_LABEL, studioApi, type IssueItem } from '../../lib/studio';

interface Item {
  kind: 'post' | 'topic';
  id: string;
  title: string;
  note: string;
}

function toItem(i: IssueItem): Item {
  const note = i.kind === 'post' ? `#${i.display_number ?? '?'} · ${STATE_LABEL[i.state ?? ''] ?? i.state ?? ''}` : `slate ${i.rank ?? '?'} · week of ${i.week_of ?? ''}`;
  return { kind: i.kind, id: i.id, title: i.title ?? '(gone)', note };
}

export default function FeaturedStories({ editionId }: { editionId: string }) {
  const qc = useQueryClient();
  const issue = useQuery({ queryKey: ['studio', editionId, 'issue'], queryFn: () => studioApi.issue(editionId) });
  const library = useQuery({ queryKey: ['studio', 'library'], queryFn: () => studioApi.library() });
  const [items, setItems] = useState<Item[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!dirty && issue.data) setItems(issue.data.data.items.map(toItem));
  }, [issue.data, dirty]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['studio', editionId, 'issue'] });
  const save = useMutation({
    mutationFn: () => studioApi.setIssue(editionId, items.map(({ kind, id }) => ({ kind, id }))),
    onSuccess: (r) => { setDirty(false); setError(''); setNotice(r.data.message ?? 'Saved: the next issue uses these stories.'); refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the selection'),
  });
  const fresh = useMutation({
    mutationFn: () => studioApi.newIssue(editionId),
    onSuccess: () => { setDirty(false); setError(''); setNotice('Started a new, empty selection.'); refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start a new selection'),
  });

  const has = (kind: string, id: string) => items.some((i) => i.kind === kind && i.id === id);
  const add = (i: Item) => { if (!has(i.kind, i.id)) { setItems([...items, i]); setDirty(true); } };
  const move = (n: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(n, 1);
    next.splice(Math.max(0, Math.min(next.length, n + d)), 0, x);
    setItems(next); setDirty(true);
  };
  const q = filter.trim().toLowerCase();
  const posts = (library.data?.data.posts ?? []).filter((p) => !q || p.title.toLowerCase().includes(q));
  const topics = (library.data?.data.topics ?? []).filter((t) => !q || t.title.toLowerCase().includes(q));
  const last = issue.data?.data.last_issue;

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900" data-testid="featured-stories">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Featured stories for the next issue</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {items.length
            ? 'The next issue of this edition uses exactly these stories, in this order — not the scraped feeds and no automatic pick.'
            : 'Nothing chosen: the next issue is built from this edition’s feeds as usual. Pick radar posts or slate topics below to feature them instead.'}
          {' '}Nothing reaches subscribers until you approve the final “Send to subscribers” step.
          {last?.send_date ? ` Last chosen issue: ${last.send_date}.` : ''}
        </p>
      </div>
      <ol className="space-y-1" data-testid="featured-items">
        {items.map((i, n) => (
          <li key={`${i.kind}-${i.id}`} className="flex items-center gap-2 text-sm" data-testid={`featured-item-${n + 1}`}>
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
        <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="featured-save"
          className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">Save selection</button>
        <button type="button" onClick={() => fresh.mutate()} disabled={fresh.isPending} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600">Start a new selection</button>
        {dirty && <span className="text-xs text-amber-700">Unsaved changes.</span>}
      </div>
      {notice && <p className="text-xs text-green-700 dark:text-green-300" role="status">{notice}</p>}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title" aria-label="Filter the library" data-testid="featured-filter"
          className="mb-2 w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" />
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded border border-gray-200 p-3 text-sm dark:border-gray-700">
            <h3 className="mb-2 font-semibold text-gray-700 dark:text-gray-200">Radar posts (all editions)</h3>
            {library.isSuccess && !posts.length && <p className="text-xs text-gray-500">Approved, scheduled and published radar posts appear here, whichever edition drafted them.</p>}
            <ul className="max-h-80 space-y-1 overflow-auto">
              {posts.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <button type="button" disabled={has('post', p.id)} onClick={() => add({ kind: 'post', id: p.id, title: p.title, note: `#${p.display_number} · ${STATE_LABEL[p.state] ?? p.state}` })}
                    className="rounded border border-gray-300 px-1.5 text-xs disabled:opacity-30 dark:border-gray-600" data-testid={`featured-add-post-${p.display_number}`}>Add</button>
                  <span className="min-w-0 truncate">#{p.display_number} {p.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-gray-400">{p.edition_id ?? ''}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded border border-gray-200 p-3 text-sm dark:border-gray-700">
            <h3 className="mb-2 font-semibold text-gray-700 dark:text-gray-200">Slate topics (all radars, recent weeks)</h3>
            {library.isSuccess && !topics.length && <p className="text-xs text-gray-500">Run a radar to get a slate.</p>}
            <ul className="max-h-80 space-y-1 overflow-auto">
              {topics.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <button type="button" disabled={has('topic', t.id)} onClick={() => add({ kind: 'topic', id: t.id, title: t.title, note: `slate ${t.rank} · week of ${t.week_of}` })}
                    className="rounded border border-gray-300 px-1.5 text-xs disabled:opacity-30 dark:border-gray-600" data-testid={`featured-add-topic-${t.radar}-${t.week_of}-${t.rank}`}>Add</button>
                  <span className="min-w-0 truncate">{t.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-gray-400">{t.radar} · {t.week_of}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
