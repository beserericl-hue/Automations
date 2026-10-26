/**
 * A blog post on the open web: publish it at /blog/<slug>, see it, take it down.
 *
 * Only an approved or published post can go up; a draft has not been checked yet. The address is
 * kept once chosen, so a link already shared keeps working after the title is edited.
 */

import { useState } from 'react';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface Props {
  contentId: string;
  status: string | null;
  web: { slug: string; published_at: string } | undefined;
  onChange: () => void;
}

export default function BlogWebPublish({ contentId, status, web, onChange }: Props) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const canPublish = status === 'approved' || status === 'published';
  const url = web ? `${window.location.origin}/blog/${web.slug}` : '';

  const act = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    try {
      const res = await apiFetch<ApiEnvelope<{ url: string } | null>>(`/api/content/${contentId}/web`, { method });
      addToast(method === 'POST' ? `On the web at ${res.data?.url ?? ''}` : 'Taken down from the web', 'success');
      onChange();
    } catch (err) {
      addToast(err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (web) {
    return (
      <>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg px-3 py-1.5 text-xs font-medium border border-green-300 text-green-700 hover:bg-green-50 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-950"
        >
          View on the web
        </a>
        <button
          onClick={() => void act('DELETE')}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          Take down
        </button>
      </>
    );
  }
  return (
    <button
      onClick={() => void act('POST')}
      disabled={busy || !canPublish}
      title={canPublish ? 'Publish this post at a public address anyone can read' : 'Approve the post first'}
      className="rounded-lg px-3 py-1.5 text-xs font-medium border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-950"
    >
      {busy ? 'Publishing…' : 'Publish to the web'}
    </button>
  );
}
