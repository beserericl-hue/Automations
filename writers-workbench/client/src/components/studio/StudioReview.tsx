/**
 * Review: drafts and approved posts. Each shows the blog (rendered, with SEO title, meta, category,
 * image) and the LinkedIn text with its character count; edit inline, revise with AI, regenerate,
 * undo, change or remove the image, email it, discard. Then the publish decision, per post or for the
 * ticked ones: channels, and Publish now / Schedule in the next free slots / Schedule at a day + slot or
 * an exact time — or keep it as a draft. Respects dry run: on DEV nothing leaves the engine.
 */
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { LINKEDIN_LIMIT, STATE_LABEL, studioApi, type StudioChannel, type StudioPost } from '../../lib/studio';
import type { StudioContext } from './ContentStudio';

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export default function StudioReview({ ctx }: { ctx: StudioContext }) {
  const ed = ctx.edition.edition_id;
  const posts = useQuery({
    queryKey: ['studio', ed, 'posts', 'review'],
    queryFn: () => studioApi.posts(ed, 'review'),
    refetchInterval: ctx.jobs.length ? 5000 : false,
  });
  const overview = useQuery({ queryKey: ['studio', ed, 'overview'], queryFn: () => studioApi.overview(ed) });
  const channels = overview.data?.data.channels ?? [];
  const list = useMemo(() => posts.data?.data ?? [], [posts.data]);
  const [ticked, setTicked] = useState<string[]>([]);
  useEffect(() => {
    setTicked((t) => {
      const kept = t.filter((id) => list.some((p) => p.id === id));
      return kept.length === t.length ? t : kept;
    });
  }, [list]);

  return (
    <section className="space-y-3" data-testid="studio-review">
      {list.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" onClick={() => setTicked(list.map((p) => p.id))} disabled={ticked.length === list.length} data-testid="review-select-all"
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 disabled:opacity-50">Select all {list.length}</button>
          <button type="button" onClick={() => setTicked(list.filter((p) => p.state === 'approved').map((p) => p.id))} disabled={!list.some((p) => p.state === 'approved')} data-testid="review-select-approved"
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 disabled:opacity-50">Select approved</button>
          <button type="button" onClick={() => setTicked([])} disabled={!ticked.length} className="rounded px-2 py-1 text-gray-500 disabled:opacity-50">Clear</button>
        </div>
      )}
      <PublishBar ctx={ctx} ids={ticked} channels={channels} defaultChannels={ctx.edition.channels} onDone={() => setTicked([])} />
      {posts.isSuccess && list.length === 0 && (
        <p className="text-sm text-gray-500">No drafts. Pick topics on the Slate tab and generate drafts; they wait here for review.</p>
      )}
      {list.map((p) => (
        <DraftCard key={p.id} ctx={ctx} post={p} channels={channels}
          ticked={ticked.includes(p.id)} onTick={(on) => setTicked(on ? [...ticked, p.id] : ticked.filter((x) => x !== p.id))} />
      ))}
    </section>
  );
}

export function PublishBar({ ctx, ids, channels, defaultChannels, onDone, compact }: {
  ctx: StudioContext;
  ids: string[];
  channels: StudioChannel[];
  defaultChannels: string[];
  onDone?: () => void;
  compact?: boolean;
}) {
  const ed = ctx.edition.edition_id;
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'next' | 'slot' | 'at'>('next');
  const [day, setDay] = useState('');
  const [slot, setSlot] = useState<'morning' | 'afternoon'>('morning');
  const [at, setAt] = useState('');
  const [error, setError] = useState('');
  const active = chosen ?? defaultChannels.filter((c) => channels.some((x) => x.channel === c));

  const act = useMutation({
    mutationFn: (action: string) => studioApi.action(ed, ids, action),
    onSuccess: (r) => { ctx.notify(r.data.message); ctx.refresh(); onDone?.(); },
    onError: (e) => setError(errText(e, 'Could not do that')),
  });
  const schedule = useMutation({
    mutationFn: (m: 'next' | 'slot' | 'at' | 'now') => studioApi.schedule(ed, {
      ids, mode: m,
      ...(m === 'slot' ? { day, slot } : {}),
      ...(m === 'at' ? { at: new Date(at).toISOString() } : {}),
      ...(chosen ? { channels: active } : {}),
    }),
    onSuccess: (r) => { ctx.notify(r.data.message); ctx.refresh(); onDone?.(); setError(''); },
    onError: (e) => setError(errText(e, 'Could not schedule')),
  });
  const disabled = !ids.length || schedule.isPending || act.isPending;

  return (
    <div className={`space-y-2 rounded border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900 ${compact ? '' : 'sticky top-0 z-10'}`} data-testid={compact ? undefined : 'publish-bar'}>
      <div className="flex flex-wrap items-center gap-2">
        {!compact && <span className="font-medium text-gray-700 dark:text-gray-200">{ids.length} selected</span>}
        <span className="text-gray-500">Channels:</span>
        {channels.map((c) => (
          <label key={c.channel} className="flex items-center gap-1">
            <input type="checkbox" checked={active.includes(c.channel)} aria-label={`Channel ${c.label}`}
              onChange={(e) => setChosen(e.target.checked ? [...active, c.channel] : active.filter((x) => x !== c.channel))} />
            {c.label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled} onClick={() => act.mutate('approve')} data-testid={compact ? undefined : 'bulk-approve'}
          className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Approve</button>
        <button type="button" disabled={disabled || !active.length} onClick={() => schedule.mutate('now')}
          className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Publish now</button>
        <select aria-label="When" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}
          className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" data-testid={compact ? undefined : 'schedule-mode'}>
          <option value="next">Next free slots</option>
          <option value="slot">A day and slot</option>
          <option value="at">An exact time</option>
        </select>
        {mode === 'slot' && (
          <>
            <input type="date" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
            <select aria-label="Slot" value={slot} onChange={(e) => setSlot(e.target.value as typeof slot)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800">
              <option value="morning">9:00 AM ET</option>
              <option value="afternoon">2:00 PM ET</option>
            </select>
          </>
        )}
        {mode === 'at' && (
          <input type="datetime-local" aria-label="Time" value={at} onChange={(e) => setAt(e.target.value)} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
        )}
        <button type="button" disabled={disabled || !active.length || (mode === 'slot' && !day) || (mode === 'at' && !at)}
          onClick={() => schedule.mutate(mode)} data-testid={compact ? undefined : 'bulk-schedule'}
          className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50">Schedule</button>
      </div>
      {error && <p className="text-red-600" role="alert">{error}</p>}
    </div>
  );
}

function DraftCard({ ctx, post, channels, ticked, onTick }: {
  ctx: StudioContext;
  post: StudioPost;
  channels: StudioChannel[];
  ticked: boolean;
  onTick: (on: boolean) => void;
}) {
  const ed = ctx.edition.edition_id;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post);
  const [instruction, setInstruction] = useState('');
  const [imageUrl, setImageUrl] = useState(post.image_url ?? '');
  const [error, setError] = useState('');
  useEffect(() => { if (!editing) setDraft(post); }, [post, editing]);
  const busy = ctx.jobs.some((j) => j.label.includes(`#${post.display_number}`));
  const isBlog = Boolean(post.body_md?.trim());
  const liCount = (editing ? draft.linkedin_content : post.linkedin_content)?.length ?? 0;
  const changed = useMemo(() => {
    const out: Partial<StudioPost> = {};
    for (const k of ['title', 'body_md', 'linkedin_content', 'seo_title', 'meta_description', 'category'] as const) {
      if ((draft[k] ?? '') !== (post[k] ?? '')) (out as Record<string, unknown>)[k] = draft[k];
    }
    return out;
  }, [draft, post]);

  const ok = (m: string) => { ctx.notify(m); ctx.refresh(); setError(''); };
  const save = useMutation({
    mutationFn: (c: Partial<StudioPost>) => studioApi.edit(ed, post.id, c),
    onSuccess: () => { setEditing(false); ok(`Saved #${post.display_number}.`); },
    onError: (e) => setError(errText(e, 'Could not save')),
  });
  const revise = useMutation({
    mutationFn: () => studioApi.revise(ed, post.id, instruction),
    onSuccess: (r) => { ctx.track(r.jobId, `Revising #${post.display_number}`); setInstruction(''); },
    onError: (e) => setError(errText(e, 'Could not start the revision')),
  });
  const regenerate = useMutation({
    mutationFn: () => studioApi.regenerate(ed, post.id),
    onSuccess: (r) => ctx.track(r.jobId, `Redrafting #${post.display_number}`),
    onError: (e) => setError(errText(e, 'Could not redraft')),
  });
  const undo = useMutation({ mutationFn: () => studioApi.undo(ed, post.id), onSuccess: (r) => ok(r.data.message), onError: (e) => setError(errText(e, 'Nothing to undo')) });
  const email = useMutation({ mutationFn: () => studioApi.email(ed, post.id), onSuccess: (r) => ok(r.data.message), onError: (e) => setError(errText(e, 'Could not email it')) });
  const act = useMutation({ mutationFn: (a: string) => studioApi.action(ed, [post.id], a), onSuccess: (r) => ok(r.data.message), onError: (e) => setError(errText(e, 'Could not do that')) });

  return (
    <article className="rounded border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={`draft-${post.display_number}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={ticked} onChange={(e) => onTick(e.target.checked)} aria-label={`Select #${post.display_number}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-gray-500">#{post.display_number}</span>
            <span className={`rounded px-1.5 py-0.5 ${post.state === 'approved' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`} data-testid={`draft-${post.display_number}-state`}>
              {STATE_LABEL[post.state] ?? post.state}
            </span>
            {post.studio?.rank != null && <span className="text-gray-400">slate #{post.studio.rank}</span>}
            {busy && <span className="text-amber-700">working…</span>}
            {post.humanize?.applied && <span className="text-gray-400">humanized</span>}
          </div>
          {editing ? (
            <input aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-medium dark:border-gray-600 dark:bg-gray-800" />
          ) : (
            <button type="button" onClick={() => setOpen(!open)} className="mt-1 block text-left font-medium text-gray-900 hover:underline dark:text-gray-100" data-testid={`draft-${post.display_number}-title`}>
              {post.title}
            </button>
          )}
          {post.source_url && <a href={post.source_url} target="_blank" rel="noreferrer" className="block truncate text-xs text-brand-700 hover:underline dark:text-brand-300">{post.source_url}</a>}
        </div>
      </div>

      {(open || editing) && (
        <div className="mt-3 space-y-3">
          {(isBlog || editing) && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Blog</h3>
              {editing ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  <input aria-label="SEO title" placeholder="SEO title" value={draft.seo_title} onChange={(e) => setDraft({ ...draft, seo_title: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" />
                  <input aria-label="Meta description" placeholder="Meta description" value={draft.meta_description} onChange={(e) => setDraft({ ...draft, meta_description: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" />
                  <input aria-label="Category" placeholder="Category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" />
                  <textarea aria-label="Blog markdown" rows={14} value={draft.body_md} onChange={(e) => setDraft({ ...draft, body_md: e.target.value })} className="font-mono sm:col-span-3 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800" />
                </div>
              ) : (
                <>
                  <p className="text-xs text-gray-500">SEO: {post.seo_title} · Meta: {post.meta_description} · Category: {post.category}</p>
                  <div className="prose prose-sm max-w-none dark:prose-invert" data-testid={`draft-${post.display_number}-blog`}><ReactMarkdown>{post.body_md}</ReactMarkdown></div>
                </>
              )}
            </div>
          )}
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              LinkedIn <span className={`font-normal ${liCount > LINKEDIN_LIMIT ? 'text-red-600' : 'text-gray-500'}`} data-testid={`draft-${post.display_number}-count`}>{liCount} / {LINKEDIN_LIMIT}</span>
            </h3>
            {editing ? (
              <textarea aria-label="LinkedIn text" rows={10} value={draft.linkedin_content} onChange={(e) => setDraft({ ...draft, linkedin_content: e.target.value })} className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800" />
            ) : (
              <p className="whitespace-pre-wrap border-l-2 border-brand-500 pl-3 text-sm text-gray-800 dark:text-gray-200" data-testid={`draft-${post.display_number}-linkedin`}>{post.linkedin_content}</p>
            )}
          </div>
          <div className="space-y-1 text-sm">
            <h3 className="font-semibold text-gray-700 dark:text-gray-200">Image</h3>
            <p className="text-gray-600 dark:text-gray-300">
              {post.image_url ? <>Chosen image: <a href={post.image_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{post.image_url}</a></>
                : post.include_image ? 'A sketchnote is generated when it is published.' : 'No image (a link post unfurls its own preview).'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => act.mutate(post.include_image || post.image_url ? 'image_off' : 'image_on')} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600">
                {post.include_image || post.image_url ? 'Remove image' : 'Add sketchnote'}
              </button>
              <input aria-label="Image URL" placeholder="https://… image URL" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="w-64 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" />
              <button type="button" disabled={!imageUrl.startsWith('https://')} onClick={() => save.mutate({ image_url: imageUrl, include_image: true })} className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 disabled:opacity-50">Use this image</button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input aria-label="Revise instruction" placeholder="Revise with AI: e.g. shorter, punchier hook" value={instruction} onChange={(e) => setInstruction(e.target.value)}
              className="min-w-[16rem] flex-1 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-800" data-testid={`draft-${post.display_number}-instruction`} />
            <button type="button" disabled={instruction.trim().length < 2 || revise.isPending || busy} onClick={() => revise.mutate()}
              className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50" data-testid={`draft-${post.display_number}-revise`}>Revise with AI</button>
            <button type="button" disabled={regenerate.isPending || busy || !post.radar_topic_id} onClick={() => regenerate.mutate()} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Regenerate</button>
            {post.studio?.previous && <button type="button" onClick={() => undo.mutate()} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600">Undo last change</button>}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {editing ? (
          <>
            <button type="button" disabled={!Object.keys(changed).length || save.isPending || liCount > LINKEDIN_LIMIT} onClick={() => save.mutate(changed)}
              className="rounded bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50" data-testid={`draft-${post.display_number}-save`}>Save</button>
            <button type="button" onClick={() => { setEditing(false); setDraft(post); }} className="rounded px-2 py-1.5 text-gray-500">Cancel</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setOpen(!open)} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600" data-testid={`draft-${post.display_number}-open`}>{open ? 'Hide' : 'Review'}</button>
            <button type="button" onClick={() => { setOpen(true); setEditing(true); }} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600" data-testid={`draft-${post.display_number}-edit`}>Edit</button>
            {post.state === 'draft'
              ? <button type="button" onClick={() => act.mutate('approve')} className="rounded border border-emerald-600 px-3 py-1.5 text-emerald-700 dark:text-emerald-300" data-testid={`draft-${post.display_number}-approve`}>Approve</button>
              : <button type="button" onClick={() => act.mutate('unapprove')} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600">Back to draft</button>}
            <button type="button" onClick={() => email.mutate()} disabled={email.isPending} className="rounded border border-gray-300 px-3 py-1.5 dark:border-gray-600 disabled:opacity-50">Email me</button>
            <button type="button" onClick={() => { if (window.confirm(`Discard #${post.display_number}?`)) act.mutate('discard'); }} className="rounded px-3 py-1.5 text-red-600" data-testid={`draft-${post.display_number}-discard`}>Discard</button>
          </>
        )}
      </div>
      {open && !editing && (
        <div className="mt-2"><PublishBar ctx={ctx} ids={[post.id]} channels={channels} defaultChannels={post.channels} compact /></div>
      )}
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
    </article>
  );
}
