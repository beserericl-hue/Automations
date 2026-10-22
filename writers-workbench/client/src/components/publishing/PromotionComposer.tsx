/**
 * Writing ABOUT the book: social posts and blog posts.
 *
 * Both of these already worked. Neither had a way in. The Social tab listed results and told you to
 * "use the chat"; the blog writer had no screen at all, so the only way to reach it was to phrase a
 * sentence that made a router pick the right tool. That is a reasonable second way in and a hopeless
 * only one — and it is the same gap as the bio having a schema but no form.
 *
 * The box starts full. Social posts default to the book's own hook and back-cover copy, so what the
 * post promises is what the listing promises; blog topics are offered as a short list drawn from the
 * book rather than an empty field and good luck. A blank prompt is the thing people abandon.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';

const PLATFORMS = [
  { id: 'twitter', label: 'X / Twitter', note: '280 characters, hard limit' },
  { id: 'linkedin', label: 'LinkedIn', note: 'longer, professional register' },
  { id: 'facebook', label: 'Facebook', note: 'conversational' },
  { id: 'instagram', label: 'Instagram', note: 'caption for an image' },
] as const;

type PlatformId = (typeof PLATFORMS)[number]['id'];

interface Props {
  projectId: string;
  projectTitle: string;
  userId?: string;
  /** The book's hook and back cover, when the listing copy has been written. */
  defaultAbout?: string;
}

export default function PromotionComposer({ projectId, projectTitle, userId, defaultAbout }: Props) {
  const { addToast } = useToast();
  const { trackJob, stateOf } = useEngineJobQueue(userId);

  const [platforms, setPlatforms] = useState<PlatformId[]>(['twitter', 'linkedin']);
  const [about, setAbout] = useState('');
  const [topic, setTopic] = useState('');
  const [keywords, setKeywords] = useState('');
  const [length, setLength] = useState(1500);

  const socialRunning = stateOf(`${projectId}:social`) === 'queued';
  const blogRunning = stateOf(`${projectId}:blog`) === 'queued';

  const writeSocial = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ jobId?: string }>(`/api/publishing/project/${projectId}/social`, {
        method: 'POST',
        body: JSON.stringify({ platforms, about: about.trim() || undefined }),
      });
      return res.jobId;
    },
    onSuccess: (jobId) => {
      if (!jobId) return;
      trackJob(`${projectId}:social`, jobId, [['social-posts', projectId]]);
      addToast('Writing the posts — they appear below when they land', 'info');
    },
    onError: (err: Error) => addToast(err.message || 'Could not start', 'error'),
  });

  const writeBlog = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ jobId?: string }>(`/api/publishing/project/${projectId}/blog`, {
        method: 'POST',
        body: JSON.stringify({
          topic: topic.trim(),
          keywords: keywords.trim() || undefined,
          target_length: length,
        }),
      });
      return res.jobId;
    },
    onSuccess: (jobId) => {
      if (!jobId) return;
      trackJob(`${projectId}:blog`, jobId, [['content-list']]);
      setTopic('');
      addToast('Writing the post — it lands in Content Library → Blog Posts', 'info');
    },
    onError: (err: Error) => addToast(err.message || 'Could not start', 'error'),
  });

  // Starting points drawn from the book, because a blank topic field is where this stops being used.
  const topicIdeas = [
    `The research behind ${projectTitle}`,
    `Why I wrote ${projectTitle}`,
    `What the historical record gets wrong about the subject of ${projectTitle}`,
  ];

  return (
    <div className="space-y-4">
      <Section
        title="Social posts"
        subtitle={
          defaultAbout
            ? "Written from this book's hook and back cover unless you say otherwise, so the posts promise what the listing promises."
            : 'No marketing copy yet, so say what the posts should be about — or write it first on the Publish tab, and these will follow from it.'
        }
      >
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => {
            const on = platforms.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() =>
                  setPlatforms((cur) =>
                    on ? cur.filter((x) => x !== p.id) : [...cur, p.id],
                  )
                }
                aria-pressed={on}
                title={p.note}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  on
                    ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <Field
          label="What the posts are about"
          hint={
            defaultAbout
              ? 'Leave blank to use the book itself. Fill it in for an angle — a launch date, a theme, a quotation.'
              : 'One or two sentences.'
          }
        >
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            rows={3}
            placeholder={defaultAbout ? defaultAbout.slice(0, 180) : 'Announcing the paperback…'}
            className={inputClass}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => writeSocial.mutate()}
            disabled={socialRunning || writeSocial.isPending || platforms.length === 0}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {socialRunning ? 'Writing…' : `Write ${platforms.length} post${platforms.length === 1 ? '' : 's'}`}
          </button>
          {!defaultAbout && !about.trim() ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Say what it is about — a post written from a title alone is filler.
            </span>
          ) : null}
        </div>
      </Section>

      <Section
        title="Blog post"
        subtitle="Researched and structured for search, in this project's genre. Lands in Content Library → Blog Posts."
      >
        <Field label="Topic" hint="What the post argues or explains. A sentence beats a phrase.">
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={2}
            placeholder={topicIdeas[0]}
            className={inputClass}
          />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {topicIdeas.map((t) => (
            <button
              key={t}
              onClick={() => setTopic(t)}
              className="rounded-full border border-gray-300 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Search keywords" hint="Optional, comma separated.">
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className={inputClass}
              placeholder="piscataway history, repatriation, nagpra"
            />
          </Field>
          <Field label="Length" hint="Words.">
            <input
              type="number"
              min={300}
              max={5000}
              step={100}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>
        <button
          onClick={() => writeBlog.mutate()}
          disabled={blogRunning || writeBlog.isPending || topic.trim().length < 8}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {blogRunning ? 'Writing…' : 'Write the blog post'}
        </button>
      </Section>
    </div>
  );
}

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 dark:border-gray-800 dark:bg-gray-900">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[14rem] flex-1">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {hint ? <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : <div className="mb-1" />}
      {children}
    </div>
  );
}
