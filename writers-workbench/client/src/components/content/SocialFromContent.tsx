/**
 * "Generate posts" on a piece of content: social posts written from THIS piece's own text, saved
 * against its project and the piece itself. The project's Promotion tab writes posts about the
 * book; this writes them about a chapter or a blog post, which before was reachable only by asking
 * the chat and hoping the title was enough.
 */

import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';

const PLATFORMS = [
  { id: 'twitter', label: 'X' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
] as const;
type PlatformId = (typeof PLATFORMS)[number]['id'];

interface Props {
  contentId: string;
  projectId?: string | null;
  userId?: string;
}

export default function SocialFromContent({ contentId, projectId, userId }: Props) {
  const [open, setOpen] = useState(false);
  const [platforms, setPlatforms] = useState<PlatformId[]>(['twitter', 'linkedin']);
  const jobQueue = useEngineJobQueue(userId, projectId ?? 'social');
  const key = `${contentId}:social`;
  const state = jobQueue.stateOf(key);
  const running = state === 'queued';

  const toggle = (p: PlatformId) =>
    setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const start = () => {
    if (!platforms.length) return;
    void jobQueue.run(
      key,
      async () =>
        (
          await apiFetch<{ jobId?: string }>(`/api/content/${contentId}/social`, {
            method: 'POST',
            body: JSON.stringify({ platforms }),
          })
        ).jobId,
      [['social-posts']],
    );
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={running}
        data-testid="social-from-content"
        title="Write social posts from this piece"
        className="rounded-lg px-3 py-1.5 text-xs font-medium border border-sky-300 text-sky-700 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-700 dark:text-sky-400 dark:hover:bg-sky-950"
      >
        {running ? 'Writing posts…' : 'Generate posts'}
      </button>
    );
  }
  return (
    <div data-testid="social-from-content-picker" className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 px-2 py-1 dark:border-sky-800">
      {PLATFORMS.map((p) => (
        <label key={p.id} className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={platforms.includes(p.id)} onChange={() => toggle(p.id)} />
          {p.label}
        </label>
      ))}
      <button
        onClick={start}
        disabled={!platforms.length}
        className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
      >
        Write {platforms.length} post{platforms.length === 1 ? '' : 's'}
      </button>
      <button onClick={() => setOpen(false)} className="text-xs text-gray-500 underline">
        Cancel
      </button>
      {state === 'error' ? <span className="text-xs text-red-600">Could not start. Try again.</span> : null}
    </div>
  );
}
