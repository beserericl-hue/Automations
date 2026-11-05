/**
 * The edition's queue (the n8n "list / edit N / cancel N"): scheduled, posting and failed posts, and
 * what has gone out with each channel's result. Cancel, requeue, take back to approved, or move to
 * another time. The same posts are on the Post calendar.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { STATE_LABEL, studioApi, whenLabel, type StudioPost } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';
import { PublishBar } from './StudioReview';

const DELIVERY: Record<string, string> = { published: 'posted', submitted: 'sent, awaiting LinkedIn', failed: 'failed', dry_run: 'dry run (not sent)' };

export default function StudioQueue({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const queue = useQuery({ queryKey: ['studio', ed, 'posts', 'queue'], queryFn: () => studioApi.posts(ed, 'queue'), refetchInterval: 30_000 });
  const done = useQuery({ queryKey: ['studio', ed, 'posts', 'published'], queryFn: () => studioApi.posts(ed, 'published') });
  const overview = useQuery({ queryKey: ['studio', ed, 'overview'], queryFn: () => studioApi.overview(ed) });
  const channels = overview.data?.data.channels ?? [];
  const pending = [...(queue.data?.data ?? [])].sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));

  return (
    <section className="space-y-4" data-testid="studio-queue">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Scheduled and needing attention</h2>
        {queue.isSuccess && !pending.length && <p className="text-sm text-gray-500">Nothing scheduled.</p>}
        {pending.map((p) => <QueueRow key={p.id} ctx={ctx} post={p} channels={channels} />)}
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Published</h2>
        {done.isSuccess && !(done.data?.data ?? []).length && <p className="text-sm text-gray-500">Nothing published from this edition yet.</p>}
        {(done.data?.data ?? []).slice(0, 30).map((p) => <QueueRow key={p.id} ctx={ctx} post={p} channels={channels} />)}
      </div>
    </section>
  );
}

function QueueRow({ ctx, post, channels }: { ctx: StudioContext; post: StudioPost; channels: Array<{ channel: string; kind: string; label: string; enabled: boolean }> }) {
  const ed = ctx.edition.edition_id;
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState('');
  const act = useMutation({
    mutationFn: (a: string) => studioApi.action(ed, [post.id], a),
    onSuccess: (r) => { ctx.notify(r.data.message); ctx.refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not do that'),
  });
  return (
    <div className="rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900" data-testid={`queue-${post.display_number}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-gray-500">#{post.display_number}</span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800" data-testid={`queue-${post.display_number}-state`}>{STATE_LABEL[post.state] ?? post.state}</span>
        <span className="text-gray-600 dark:text-gray-300">{whenLabel(post)}</span>
        <span className="text-xs text-gray-400">{post.channels.join(', ')}</span>
      </div>
      <p className="mt-1 font-medium text-gray-900 dark:text-gray-100">{post.title}</p>
      {post.last_error && <p className="text-xs text-red-600">{post.last_error}</p>}
      {(post.deliveries ?? []).length > 0 && (
        <ul className="mt-1 text-xs text-gray-500" data-testid={`queue-${post.display_number}-deliveries`}>
          {(post.deliveries ?? []).map((d) => (
            <li key={d.channel}>{d.channel}: {DELIVERY[d.status] ?? d.status}{d.public_url ? <> · <a href={d.public_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{d.public_url}</a></> : null}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {post.state === 'pending' && <>
          <button type="button" onClick={() => setMoving(!moving)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600">Move</button>
          <button type="button" onClick={() => act.mutate('unschedule')} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600">Back to review</button>
          <button type="button" onClick={() => act.mutate('cancel')} className="rounded px-2 py-1 text-red-600" data-testid={`queue-${post.display_number}-cancel`}>Cancel</button>
        </>}
        {['failed', 'partial'].includes(post.state) && <>
          <button type="button" onClick={() => act.mutate('requeue')} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600">Retry failed channels</button>
          <button type="button" onClick={() => act.mutate('cancel')} className="rounded px-2 py-1 text-red-600">Cancel</button>
        </>}
      </div>
      {moving && <div className="mt-2"><PublishBar ctx={ctx} ids={[post.id]} channels={channels} defaultChannels={post.channels} compact onDone={() => setMoving(false)} /></div>}
      {error && <p className="mt-1 text-red-600" role="alert">{error}</p>}
    </div>
  );
}
