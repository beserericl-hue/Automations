/**
 * The post calendar: blog and LinkedIn posts queued for a day and a slot (09:00 / 14:00 US Eastern),
 * posted by the engine. Week view, each slot listing its posts with every channel's result.
 *
 * Replaces the n8n `scheduled_blogs` queue and its chat-only "list / edit N / remove N" commands.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import PostEditor, { type SocialChannel, type SocialPost } from './PostEditor';

interface ListResponse<T> { success: boolean; data: T }

export const SLOTS = [
  { key: 'morning', label: '9:00 AM ET' },
  { key: 'afternoon', label: '2:00 PM ET' },
] as const;

const STATE_STYLE: Record<string, string> = {
  pending: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
  posting: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
  posted: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
  partial: 'border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-100',
  failed: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100',
  cancelled: 'border-gray-200 bg-gray-50 text-gray-500 line-through dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400',
};

export const STATE_LABEL: Record<string, string> = {
  pending: 'Scheduled',
  posting: 'Posting now',
  posted: 'Posted',
  partial: 'Partly posted',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Monday of the week containing `d`, as yyyy-mm-dd (calendar dates, no time zone involved). */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayEastern(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function PostCalendar() {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  // ?week=yyyy-mm-dd opens the week containing that day (a link to "the week of #358").
  const [weekStart, setWeekStart] = useState(() => {
    const w = params.get('week');
    return mondayOf(w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : todayEastern());
  });
  const [editing, setEditing] = useState<SocialPost | 'new' | null>(null);
  const [newSlot, setNewSlot] = useState<{ date: string; slot: string } | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const to = days[6];

  const postsQuery = useQuery({
    queryKey: ['social-calendar', weekStart],
    queryFn: () => apiFetch<ListResponse<SocialPost[]>>(`/api/social/calendar?from=${weekStart}&to=${to}`),
    refetchInterval: 60_000,
  });
  const channelsQuery = useQuery({
    queryKey: ['social-channels'],
    queryFn: () => apiFetch<ListResponse<SocialChannel[]>>('/api/social/channels'),
    staleTime: 300_000,
  });
  const posts = postsQuery.data?.data ?? [];
  const channels = channelsQuery.data?.data ?? [];
  const dryRun = posts.some((p) => p.deliveries?.some((d) => d.status === 'dry_run'));

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'cancel' | 'requeue' }) =>
      apiFetch(`/api/social/posts/${id}/${verb}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['social-calendar'] }),
  });

  const bySlot = new Map<string, SocialPost[]>();
  for (const p of posts) {
    const key = `${p.scheduled_date}|${p.slot}`;
    bySlot.set(key, [...(bySlot.get(key) ?? []), p]);
  }

  return (
    <div className="space-y-4" data-testid="post-calendar">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Post calendar</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Blog and LinkedIn posts go out at 9:00 AM and 2:00 PM Eastern. Fill a week from a{' '}
            <Link to="/newsletter/radar" className="text-brand-700 hover:underline dark:text-brand-300">radar slate</Link>, or add one by hand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))}
            className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600" aria-label="Previous week">←</button>
          <button type="button" onClick={() => setWeekStart(mondayOf(todayEastern()))}
            className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600">This week</button>
          <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))}
            className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600" aria-label="Next week">→</button>
          <button type="button" onClick={() => { setNewSlot(null); setEditing('new'); }}
            className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">New post</button>
        </div>
      </header>

      {dryRun && (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" data-testid="dry-run-banner">
          Dry run: posts this week were recorded but not sent. Posting goes live when the engine's
          SOCIAL_POSTING_MODE is set to <code>live</code>.
        </p>
      )}
      {channels.length === 0 && channelsQuery.isSuccess && (
        <p className="rounded border border-gray-200 px-3 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
          No channels are set up for your account yet, so posts have nowhere to go.
        </p>
      )}
      {postsQuery.isError && <p className="text-sm text-red-600">Could not load the calendar.</p>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
        {days.map((day) => (
          <section key={day} className="min-w-0 rounded border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900" data-testid={`day-${day}`}>
            <h2 className={`mb-2 text-xs font-semibold uppercase tracking-wide ${day === todayEastern() ? 'text-brand-700 dark:text-brand-300' : 'text-gray-500 dark:text-gray-400'}`}>
              {dayLabel(day)}
            </h2>
            {SLOTS.map((slot) => {
              const here = bySlot.get(`${day}|${slot.key}`) ?? [];
              return (
                <div key={slot.key} className="mb-2">
                  <div className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>{slot.label}</span>
                    <button type="button" className="hover:text-brand-600" aria-label={`Add a post ${day} ${slot.label}`}
                      onClick={() => { setNewSlot({ date: day, slot: slot.key }); setEditing('new'); }}>+</button>
                  </div>
                  {here.map((p) => (
                    <button key={p.id} type="button" onClick={() => setEditing(p)} data-testid={`post-${p.display_number}`}
                      className={`mt-1 block w-full rounded border px-2 py-1 text-left text-xs ${STATE_STYLE[p.state] ?? ''}`}>
                      <span className="font-semibold">#{p.display_number}</span> {p.title}
                      <span className="mt-0.5 block text-[10px] opacity-80">
                        {STATE_LABEL[p.state] ?? p.state} · {p.channels.join(', ')}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {editing && (
        <PostEditor
          post={editing === 'new' ? null : editing}
          channels={channels}
          defaultDate={newSlot?.date ?? days[0]}
          defaultSlot={newSlot?.slot ?? 'morning'}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); queryClient.invalidateQueries({ queryKey: ['social-calendar'] }); }}
          onAction={(verb) => editing !== 'new' && action.mutate({ id: editing.id, verb }, { onSuccess: () => setEditing(null) })}
        />
      )}
    </div>
  );
}
