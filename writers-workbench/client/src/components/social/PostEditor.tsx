/**
 * Create, edit, cancel or requeue one calendar post, and see what each channel did with it.
 */
import { useState } from 'react';
import { apiFetch, ApiError } from '../../lib/api';

export interface SocialDelivery {
  channel: string;
  status: 'submitted' | 'published' | 'failed' | 'dry_run';
  attempts: number;
  public_url: string | null;
  detail: string | null;
  updated_at: string;
}

export interface SocialPost {
  id: string;
  display_number: number;
  title: string;
  body_md: string;
  linkedin_content: string;
  seo_title: string;
  meta_description: string;
  category: string;
  include_image: boolean;
  post_status: 'published' | 'draft';
  channels: string[];
  scheduled_date: string;
  slot: 'morning' | 'afternoon';
  state: string;
  attempts: number;
  posted_at: string | null;
  last_error: string | null;
  source: string;
  item_type: string;
  source_url: string | null;
  deliveries?: SocialDelivery[];
}

export interface SocialChannel {
  channel: string;
  kind: 'website' | 'linkedin';
  label: string;
  enabled: boolean;
}

const DELIVERY_LABEL: Record<string, string> = {
  published: 'Posted',
  submitted: 'Sent to LinkedIn, waiting for confirmation',
  failed: 'Failed',
  dry_run: 'Dry run (not sent)',
};

interface Props {
  post: SocialPost | null;
  channels: SocialChannel[];
  defaultDate: string;
  defaultSlot: string;
  onClose: () => void;
  onSaved: () => void;
  onAction: (verb: 'cancel' | 'requeue') => void;
}

const EDITABLE = new Set(['pending', 'failed', 'partial', 'cancelled']);

export default function PostEditor({ post, channels, defaultDate, defaultSlot, onClose, onSaved, onAction }: Props) {
  const [title, setTitle] = useState(post?.title ?? '');
  const [bodyMd, setBodyMd] = useState(post?.body_md ?? '');
  const [linkedin, setLinkedin] = useState(post?.linkedin_content ?? '');
  const [date, setDate] = useState(post?.scheduled_date ?? defaultDate);
  const [slot, setSlot] = useState<string>(post?.slot ?? defaultSlot);
  const [chosen, setChosen] = useState<string[]>(post?.channels ?? channels.filter((c) => c.enabled).map((c) => c.channel));
  const [image, setImage] = useState(post?.include_image ?? false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const editable = !post || EDITABLE.has(post.state);
  const labelOf = (key: string) => channels.find((c) => c.channel === key)?.label ?? key;

  async function save() {
    setError('');
    setSaving(true);
    const body = {
      title, body_md: bodyMd, linkedin_content: linkedin, scheduled_date: date, slot, channels: chosen, include_image: image,
    };
    try {
      await apiFetch(post ? `/api/social/posts/${post.id}` : '/api/social/posts', {
        method: post ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the post');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={post ? `Post #${post.display_number}` : 'New post'}>
      <div className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl dark:bg-gray-900">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {post ? `Post #${post.display_number}` : 'New post'}
            {post && <span className="ml-2 text-sm font-normal text-gray-500">{post.state}</span>}
          </h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">✕</button>
        </div>

        {post?.deliveries && post.deliveries.length > 0 && (
          <ul className="mb-4 space-y-1 rounded border border-gray-200 p-3 text-sm dark:border-gray-700" data-testid="deliveries">
            {post.deliveries.map((d) => (
              <li key={d.channel}>
                <span className="font-medium">{labelOf(d.channel)}:</span> {DELIVERY_LABEL[d.status] ?? d.status}
                {d.public_url && (
                  <> — <a href={d.public_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">view</a></>
                )}
                {d.status === 'failed' && d.detail && <span className="block text-xs text-red-600">{d.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {post?.last_error && post.state !== 'posted' && (
          <p className="mb-3 text-xs text-red-600">{post.last_error}</p>
        )}

        <fieldset disabled={!editable} className="space-y-3">
          <label className="block text-sm">
            <span className="text-gray-700 dark:text-gray-300">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-800" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-gray-700 dark:text-gray-300">Day</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-800" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-700 dark:text-gray-300">Time (Eastern)</span>
              <select value={slot} onChange={(e) => setSlot(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-800">
                <option value="morning">9:00 AM</option>
                <option value="afternoon">2:00 PM</option>
              </select>
            </label>
          </div>
          <div className="text-sm">
            <span className="text-gray-700 dark:text-gray-300">Post to</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {channels.map((c) => (
                <label key={c.channel} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={chosen.includes(c.channel)} disabled={!c.enabled}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, c.channel] : chosen.filter((x) => x !== c.channel))} />
                  {c.label}
                </label>
              ))}
            </div>
          </div>
          <label className="block text-sm">
            <span className="text-gray-700 dark:text-gray-300">Blog post (markdown, for the website)</span>
            <textarea value={bodyMd} onChange={(e) => setBodyMd(e.target.value)} rows={6} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-800" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-700 dark:text-gray-300">LinkedIn post</span>
            <textarea value={linkedin} onChange={(e) => setLinkedin(e.target.value)} rows={6} maxLength={3000} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800" />
            <span className="text-xs text-gray-400">{linkedin.length} / 2,990</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={image} onChange={(e) => setImage(e.target.checked)} />
            Make a sketchnote image (leave off for link posts, so the link preview shows)
          </label>
        </fieldset>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {post && ['pending', 'failed', 'partial'].includes(post.state) && (
              <button type="button" onClick={() => onAction('cancel')} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-700 dark:text-red-300">Cancel post</button>
            )}
            {post && ['failed', 'partial', 'cancelled'].includes(post.state) && (
              <button type="button" onClick={() => onAction('requeue')} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">
                {post.state === 'cancelled' ? 'Put back on the calendar' : 'Try again'}
              </button>
            )}
          </div>
          {editable && (
            <button type="button" disabled={saving || !title.trim() || chosen.length === 0} onClick={save}
              className="rounded bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {saving ? 'Saving…' : post ? 'Save changes' : 'Schedule post'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
