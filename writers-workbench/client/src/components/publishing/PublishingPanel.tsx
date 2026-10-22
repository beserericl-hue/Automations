/**
 * Publish — everything between a finished manuscript and a book on Amazon.
 *
 * Four decisions, in the order they depend on each other:
 *
 *   1. Trim size. Not an aesthetic choice: it decides how many pages the book is, and the page cap
 *      decides how many books it becomes. Shown with that consequence beside each option rather
 *      than left to a default nobody chose.
 *   2. Volumes. Where to break a long book, chosen on where the story leaves the reader hanging and
 *      constrained by the page cap — not the other way round.
 *   3. The listing copy. Drafted from the manuscript, then reviewed: ask for a change in words, or
 *      edit any field by hand. Every previous draft is kept, so a revision can be undone.
 *   4. The upload package. One zip holding the interior, the cover wrap, the Kindle files, the
 *      listing text field by field, and a report of anything KDP would refuse.
 *
 * All of it is stored on the project. Nothing here lives only in this tab.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { supabase } from '../../config/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';

interface Settings {
  trim: string;
  paper: string;
  volume_count: number | null;
  why_this_book: string;
  publisher: string;
  isbns: Record<string, string>;
  dedication: string;
  epigraph: string;
  epigraph_attribution: string;
  authors_note: string;
  acknowledgements: string;
  body_size: number;
}

interface PlannedVolume {
  index: number;
  first_chapter: number;
  last_chapter: number;
  chapters: number[];
  words: number;
  estimated_pages: number;
  ending_score: number;
  ending_title?: string;
  ending_reason?: string;
}

interface TrimOption {
  trim: string;
  words_per_page: number;
  total_pages_if_one_volume: number;
  minimum_volumes: number;
  approx_pages_per_volume: number;
  fits_one_volume: boolean;
}

interface VolumePlan {
  trim: string;
  total_words: number;
  volume_count: number;
  volumes: PlannedVolume[];
  warnings: string[];
  trim_options?: TrimOption[];
  judged_candidates?: number;
}

interface Marketing {
  blurb?: string;
  back_cover?: string;
  hook?: string;
  keywords?: string[];
  categories?: string[];
  comparable_titles?: string[];
  author_bio?: string;
  source?: string;
  revised?: boolean;
  note?: string;
  changed?: string[];
  edited_at?: string;
}

interface HistoryEntry {
  volume_index: number;
  saved_at: string;
  replaced_by: string;
  instructions: string | null;
  draft: Marketing;
}

interface PublishingState {
  project: { id: string; title: string; genre_slug: string | null };
  settings: Settings;
  volume_plan: VolumePlan | null;
  marketing: Record<string, Marketing | null>;
  marketing_history: HistoryEntry[];
  author: { pen_name: string; bio: string; bio_source: string | null; profile_why_this_book: string };
  chapters: { total: number; approved: number };
  cover_art: { id: string; created_at: string } | null;
  trim_options: { trim: string; w: number; h: number }[];
  paper_options: string[];
}

interface Readiness {
  ready: boolean;
  blockers: string[];
  gaps: string[];
  volume_count: number;
  trim: string;
}

export default function PublishingPanel({ projectId, userId }: { projectId: string; userId?: string }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { trackJob, stateOf } = useEngineJobQueue(userId);

  const stateKey = useMemo(() => ['publishing', projectId] as const, [projectId]);
  const { data, isLoading } = useQuery({
    queryKey: stateKey,
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<PublishingState>>(`/api/publishing/project/${projectId}`);
      return res.data!;
    },
  });
  const { data: readiness } = useQuery({
    queryKey: ['publishing-readiness', projectId],
    queryFn: async () => {
      const res = await apiFetch<ApiEnvelope<Readiness>>(
        `/api/publishing/project/${projectId}/readiness`,
      );
      return res.data!;
    },
  });

  const [settings, setSettings] = useState<Settings | null>(null);
  const [volumeTab, setVolumeTab] = useState(1);
  const [instructions, setInstructions] = useState('');
  const [edit, setEdit] = useState<Marketing | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [lastPackage, setLastPackage] = useState<{ blocking: number; warnings: number; volumes: number } | null>(null);

  useEffect(() => {
    if (data?.settings && !settings) setSettings(data.settings);
  }, [data, settings]);

  const plan = data?.volume_plan ?? null;
  const volumeCount = Math.max(1, plan?.volume_count ?? 1);
  const marketing = data?.marketing?.[String(volumeTab)] ?? null;
  const history = (data?.marketing_history ?? []).filter((h) => h.volume_index === volumeTab);

  const planning = stateOf(`${projectId}:volumes`) === 'queued';
  const drafting = stateOf(`${projectId}:marketing`) === 'queued';

  const saveSettings = useMutation({
    mutationFn: async (patch: Partial<Settings>) => {
      const res = await apiFetch<ApiEnvelope<Settings>>(
        `/api/publishing/project/${projectId}/settings`,
        { method: 'PUT', body: JSON.stringify(patch) },
      );
      return res.data!;
    },
    onSuccess: (saved) => {
      setSettings(saved);
      void queryClient.invalidateQueries({ queryKey: stateKey });
      void queryClient.invalidateQueries({ queryKey: ['publishing-readiness', projectId] });
      addToast('Saved', 'success');
    },
    onError: (err: Error) => addToast(err.message || 'Could not save', 'error'),
  });

  const planVolumes = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ jobId?: string }>(
        `/api/publishing/project/${projectId}/volumes/plan`,
        {
          method: 'POST',
          body: JSON.stringify({
            trim: settings?.trim,
            volume_count: settings?.volume_count ?? null,
            judge_endings: true,
          }),
        },
      );
      return res.jobId;
    },
    onSuccess: (jobId) => {
      if (jobId) {
        trackJob(`${projectId}:volumes`, jobId, [stateKey, ['publishing-readiness', projectId]]);
        addToast('Reading the closing pages of each candidate break…', 'info');
      }
    },
    onError: (err: Error) => addToast(err.message || 'Could not start the planner', 'error'),
  });

  const draftMarketing = useMutation({
    mutationFn: async (vars: { revise: boolean }) => {
      const res = await apiFetch<{ jobId?: string }>(`/api/publishing/project/${projectId}/marketing`, {
        method: 'POST',
        body: JSON.stringify({
          volume_index: volumeCount > 1 ? volumeTab : null,
          instructions: vars.revise ? instructions.trim() : undefined,
        }),
      });
      return res.jobId;
    },
    onSuccess: (jobId) => {
      setInstructions('');
      if (jobId) {
        trackJob(`${projectId}:marketing`, jobId, [stateKey, ['publishing-readiness', projectId]]);
        addToast('Writing the listing copy…', 'info');
      }
    },
    onError: (err: Error) => addToast(err.message || 'Could not start the copywriter', 'error'),
  });

  const saveMarketing = useMutation({
    mutationFn: async (patch: Marketing) => {
      const res = await apiFetch<ApiEnvelope<Marketing>>(
        `/api/publishing/project/${projectId}/marketing`,
        {
          method: 'PUT',
          body: JSON.stringify({ volume_index: volumeCount > 1 ? volumeTab : null, ...patch }),
        },
      );
      return res.data!;
    },
    onSuccess: () => {
      setEdit(null);
      void queryClient.invalidateQueries({ queryKey: stateKey });
      void queryClient.invalidateQueries({ queryKey: ['publishing-readiness', projectId] });
      addToast('Listing copy saved', 'success');
    },
    onError: (err: Error) => addToast(err.message || 'Could not save', 'error'),
  });

  const restoreDraft = useMutation({
    mutationFn: async (index: number) => {
      await apiFetch(`/api/publishing/project/${projectId}/marketing/restore`, {
        method: 'POST',
        body: JSON.stringify({ index }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: stateKey });
      addToast('Earlier draft restored', 'success');
    },
    onError: (err: Error) => addToast(err.message || 'Could not restore', 'error'),
  });

  /**
   * Download the package.
   *
   * Not apiFetch: the response is a zip, and the findings come back in headers the UI needs to
   * read. So this is a plain fetch with the token attached by hand.
   */
  const downloadPackage = async (onlyVolume: number | null): Promise<void> => {
    setDownloading(true);
    setLastPackage(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      const res = await fetch('/api/export/kdp-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ project_id: projectId, volume_index: onlyVolume, only_approved: false }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        addToast(body?.error || `Could not build the package (${res.status})`, 'error');
        return;
      }
      const blocking = Number(res.headers.get('X-Kdp-Blocking') ?? 0);
      const warnings = Number(res.headers.get('X-Kdp-Warnings') ?? 0);
      const volumes = Number(res.headers.get('X-Kdp-Volumes') ?? 0);
      setLastPackage({ blocking, warnings, volumes });

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match?.[1] ?? 'kdp-package.zip';
      a.click();
      URL.revokeObjectURL(url);
      addToast(
        blocking
          ? `Built, but ${blocking} thing${blocking === 1 ? '' : 's'} would be refused — see pre-flight.txt`
          : 'Package downloaded',
        blocking ? 'error' : 'success',
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading || !data || !settings) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }

  const trimOptions = plan?.trim_options ?? [];

  return (
    <div className="space-y-6">
      {/* What is still missing, before anything else — it changes what to do next. */}
      {readiness ? (
        <div
          className={`rounded-lg border p-4 ${
            readiness.ready
              ? 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20'
              : 'border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20'
          }`}
        >
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {readiness.ready ? 'Ready to upload' : 'Not ready yet'}
          </h3>
          {readiness.blockers.length ? (
            <ul className="mt-2 list-disc pl-4 text-xs text-red-700 dark:text-red-400 space-y-0.5">
              {readiness.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
          {readiness.gaps.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-600 dark:text-gray-400">
                {readiness.gaps.length} thing{readiness.gaps.length === 1 ? '' : 's'} that would publish
                but publish worse
              </summary>
              <ul className="mt-1 list-disc pl-4 text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                {readiness.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {data.chapters.total} chapters · {data.chapters.approved} approved ·{' '}
            {data.cover_art ? 'cover art selected' : 'no cover art'} ·{' '}
            {data.author.pen_name || 'no author name'}
          </p>
        </div>
      ) : null}

      {/* 1. Trim and paper */}
      <Section title="Trim size" subtitle="It decides how many pages the book is, and so how many books it becomes.">
        <div className="flex flex-wrap gap-2">
          {data.trim_options.map((t) => {
            const detail = trimOptions.find((o) => o.trim === t.trim);
            const selected = settings.trim === t.trim;
            return (
              <button
                key={t.trim}
                onClick={() => setSettings({ ...settings, trim: t.trim })}
                className={`rounded-lg border px-3 py-2 text-left text-xs ${
                  selected
                    ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                <span className="block font-medium">{t.trim}″</span>
                {detail ? (
                  <span className="block text-[11px] opacity-80">
                    {detail.total_pages_if_one_volume.toLocaleString()} pp →{' '}
                    {detail.minimum_volumes} volume{detail.minimum_volumes === 1 ? '' : 's'}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {!trimOptions.length ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Run the planner to see what each trim costs in pages and volumes.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Paper" hint="Cream is conventional for fiction. It also changes the spine width.">
            <select
              value={settings.paper}
              onChange={(e) => setSettings({ ...settings, paper: e.target.value })}
              className={inputClass}
            >
              {data.paper_options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Body size" hint="Points. 11 is the usual for a novel.">
            <input
              type="number"
              min={9}
              max={14}
              step={0.5}
              value={settings.body_size}
              onChange={(e) => setSettings({ ...settings, body_size: Number(e.target.value) })}
              className={inputClass}
            />
          </Field>
          <Field label="Volumes" hint="Blank lets the planner decide from the page cap.">
            <input
              type="number"
              min={1}
              max={12}
              value={settings.volume_count ?? ''}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  volume_count: e.target.value === '' ? null : Number(e.target.value),
                })
              }
              className={inputClass}
            />
          </Field>
          <button
            onClick={() =>
              saveSettings.mutate({
                trim: settings.trim,
                paper: settings.paper,
                body_size: settings.body_size,
                volume_count: settings.volume_count,
              })
            }
            disabled={saveSettings.isPending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </Section>

      {/* 2. Volumes */}
      <Section
        title="Volumes"
        subtitle="Breaks are chosen where the story leaves the reader hanging; the page cap is the limit, not the reason."
      >
        <button
          onClick={() => planVolumes.mutate()}
          disabled={planning || planVolumes.isPending}
          className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40"
        >
          {planning ? 'Planning…' : plan ? 'Re-run the planner' : 'Plan the volumes'}
        </button>

        {plan ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {plan.volume_count} volume{plan.volume_count === 1 ? '' : 's'} at {plan.trim}″ ·{' '}
              {plan.total_words.toLocaleString()} words
              {plan.judged_candidates ? ` · ${plan.judged_candidates} endings read` : ''}
            </p>
            {plan.volumes.map((v) => (
              <div
                key={v.index}
                className="rounded-lg border border-gray-200 p-3 text-xs dark:border-gray-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-gray-900 dark:text-white">
                    Volume {v.index} — chapters {v.first_chapter}–{v.last_chapter}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    {v.words.toLocaleString()} words · ~{v.estimated_pages} pages
                  </span>
                </div>
                <p className="mt-1 text-gray-600 dark:text-gray-400">
                  Ends on{' '}
                  <span
                    className={
                      v.ending_score >= 0.6
                        ? 'font-medium text-green-700 dark:text-green-400'
                        : v.ending_score >= 0.4
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-gray-500'
                    }
                  >
                    {v.ending_score.toFixed(2)}
                  </span>
                  {v.ending_title ? ` · “${v.ending_title}”` : ''}
                </p>
                {v.ending_reason ? (
                  <p className="mt-1 italic text-gray-500 dark:text-gray-400">{v.ending_reason}</p>
                ) : null}
              </div>
            ))}
            {plan.warnings?.length ? (
              <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-400">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No plan yet. Until there is one this is treated as a single volume.
          </p>
        )}
      </Section>

      {/* 3. Listing copy */}
      <Section
        title="Amazon listing copy"
        subtitle="Written from the manuscript, then reviewed. Ask for a change in words, or edit any field yourself."
      >
        {volumeCount > 1 ? (
          <div className="flex gap-1">
            {Array.from({ length: volumeCount }, (_, i) => i + 1).map((i) => (
              <button
                key={i}
                onClick={() => {
                  setVolumeTab(i);
                  setEdit(null);
                }}
                className={`rounded-lg px-3 py-1 text-xs ${
                  volumeTab === i
                    ? 'bg-brand-600 text-white'
                    : 'border border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
                }`}
              >
                Volume {i}
                {data.marketing[String(i)] ? '' : ' ·'}
              </button>
            ))}
          </div>
        ) : null}

        {marketing && !edit ? (
          <div className="space-y-3">
            <Copy label="Description" value={marketing.blurb} />
            <Copy label="Back cover" value={marketing.back_cover} />
            <Copy label="Hook" value={marketing.hook} />
            <Chips label={`Keywords (${marketing.keywords?.length ?? 0} of 7)`} values={marketing.keywords} />
            <Chips label="Categories" values={marketing.categories} />
            <Chips label="Comparable titles" values={marketing.comparable_titles} />
            <Copy
              label="Author bio"
              value={data.author.bio || marketing.author_bio}
              note={
                data.author.bio
                  ? 'Your approved bio, from the Author Profile. This is what gets printed.'
                  : 'Suggested — set your own in Settings → Author Profile before publishing.'
              }
            />
            {marketing.note ? (
              <p className="rounded-lg bg-gray-50 p-2 text-xs italic text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {marketing.note}
                {marketing.changed?.length ? ` (changed: ${marketing.changed.join(', ')})` : ''}
              </p>
            ) : null}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {marketing.source === 'edited' ? 'Edited by you' : 'Generated'}
              {marketing.edited_at ? ` · ${new Date(marketing.edited_at).toLocaleString()}` : ''}
            </p>
          </div>
        ) : null}

        {edit ? (
          <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/30 p-3 dark:border-brand-800 dark:bg-brand-950/20">
            <Field label="Description">
              <textarea
                value={edit.blurb ?? ''}
                onChange={(e) => setEdit({ ...edit, blurb: e.target.value })}
                rows={8}
                className={inputClass}
              />
            </Field>
            <Field label="Back cover" hint="Shorter and harder — read standing up in a shop.">
              <textarea
                value={edit.back_cover ?? ''}
                onChange={(e) => setEdit({ ...edit, back_cover: e.target.value })}
                rows={4}
                className={inputClass}
              />
            </Field>
            <Field label="Hook" hint="One sentence.">
              <input
                value={edit.hook ?? ''}
                onChange={(e) => setEdit({ ...edit, hook: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Keywords" hint="One per line. KDP gives exactly 7 slots; unused ones are wasted reach.">
              <textarea
                value={(edit.keywords ?? []).join('\n')}
                onChange={(e) =>
                  setEdit({ ...edit, keywords: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
                }
                rows={7}
                className={inputClass}
              />
            </Field>
            <Field label="Categories" hint="One per line, up to 3, as Amazon words them.">
              <textarea
                value={(edit.categories ?? []).join('\n')}
                onChange={(e) =>
                  setEdit({ ...edit, categories: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
                }
                rows={3}
                className={inputClass}
              />
            </Field>
            <Field label="Comparable titles" hint="One per line.">
              <textarea
                value={(edit.comparable_titles ?? []).join('\n')}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    comparable_titles: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  })
                }
                rows={4}
                className={inputClass}
              />
            </Field>
            <div className="flex gap-2">
              <button
                onClick={() => saveMarketing.mutate(edit)}
                disabled={saveMarketing.isPending}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Save my version
              </button>
              <button
                onClick={() => setEdit(null)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {!edit ? (
          <div className="space-y-2">
            {marketing ? (
              <Field label="Ask for a change" hint="The rest comes back unchanged — you keep what you already approved.">
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={2}
                  placeholder="Lose the last paragraph of the blurb; make the keywords more specific to the period"
                  className={inputClass}
                />
              </Field>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => draftMarketing.mutate({ revise: Boolean(marketing && instructions.trim()) })}
                disabled={drafting || draftMarketing.isPending || (Boolean(marketing) && !instructions.trim())}
                className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950/40"
              >
                {drafting ? 'Writing…' : marketing ? 'Revise with these instructions' : 'Write the listing copy'}
              </button>
              {marketing ? (
                <>
                  <button
                    onClick={() => setEdit({ ...marketing })}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    Edit it myself
                  </button>
                  <button
                    onClick={() => draftMarketing.mutate({ revise: false })}
                    disabled={drafting}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    Start over
                  </button>
                </>
              ) : null}
              {history.length ? (
                <button
                  onClick={() => setShowHistory((s) => !s)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  {showHistory ? 'Hide' : `${history.length} earlier draft${history.length === 1 ? '' : 's'}`}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {showHistory
          ? history.map((h) => {
              const absolute = (data.marketing_history ?? []).indexOf(h);
              return (
                <div
                  key={h.saved_at}
                  className="rounded-lg border border-gray-200 p-3 text-xs dark:border-gray-800"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-gray-500 dark:text-gray-400">
                      {new Date(h.saved_at).toLocaleString()} · replaced by {h.replaced_by}
                    </span>
                    <button
                      onClick={() => restoreDraft.mutate(absolute)}
                      className="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400"
                    >
                      Restore
                    </button>
                  </div>
                  {h.instructions ? (
                    <p className="mt-1 italic text-gray-500 dark:text-gray-400">“{h.instructions}”</p>
                  ) : null}
                  <p className="mt-1 line-clamp-3 text-gray-700 dark:text-gray-300">{h.draft?.blurb}</p>
                </div>
              );
            })
          : null}
      </Section>

      {/* Front and back matter */}
      <Section
        title="Front and back matter"
        subtitle="The pages that make a manuscript a book. The copyright page is built for you; these are the rest."
      >
        <Field label="Publisher imprint" hint="Optional. Your own name is fine.">
          <input
            value={settings.publisher}
            onChange={(e) => setSettings({ ...settings, publisher: e.target.value })}
            className={inputClass}
          />
        </Field>
        {Array.from({ length: volumeCount }, (_, i) => i + 1).map((i) => (
          <Field
            key={i}
            label={volumeCount > 1 ? `ISBN — volume ${i}` : 'ISBN'}
            hint="KDP issues one free for the paperback. Ebooks need none."
          >
            <input
              value={settings.isbns?.[String(i)] ?? ''}
              onChange={(e) =>
                setSettings({ ...settings, isbns: { ...settings.isbns, [String(i)]: e.target.value } })
              }
              className={inputClass}
            />
          </Field>
        ))}
        <Field label="Dedication">
          <textarea
            value={settings.dedication}
            onChange={(e) => setSettings({ ...settings, dedication: e.target.value })}
            rows={2}
            className={inputClass}
          />
        </Field>
        <Field label="Epigraph">
          <textarea
            value={settings.epigraph}
            onChange={(e) => setSettings({ ...settings, epigraph: e.target.value })}
            rows={2}
            className={inputClass}
          />
        </Field>
        <Field label="Epigraph attribution">
          <input
            value={settings.epigraph_attribution}
            onChange={(e) => setSettings({ ...settings, epigraph_attribution: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field
          label="Author's note"
          hint="For a book built on documented history this is close to obligatory — it is where the record is separated from the invention."
        >
          <textarea
            value={settings.authors_note}
            onChange={(e) => setSettings({ ...settings, authors_note: e.target.value })}
            rows={6}
            className={inputClass}
          />
        </Field>
        <Field label="Acknowledgements">
          <textarea
            value={settings.acknowledgements}
            onChange={(e) => setSettings({ ...settings, acknowledgements: e.target.value })}
            rows={4}
            className={inputClass}
          />
        </Field>
        <Field label="Why this book" hint="Used by the bio for this project, in place of the one on your profile.">
          <textarea
            value={settings.why_this_book}
            onChange={(e) => setSettings({ ...settings, why_this_book: e.target.value })}
            rows={3}
            className={inputClass}
            placeholder={data.author.profile_why_this_book || undefined}
          />
        </Field>
        <button
          onClick={() => saveSettings.mutate(settings)}
          disabled={saveSettings.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveSettings.isPending ? 'Saving…' : 'Save matter'}
        </button>
      </Section>

      {/* 4. The package */}
      <Section
        title="KDP upload package"
        subtitle="There is no Amazon API — the upload is a form you fill in. This is everything it asks for."
      >
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void downloadPackage(null)}
            disabled={downloading}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {downloading ? 'Building…' : volumeCount > 1 ? `Download all ${volumeCount} volumes` : 'Download the package'}
          </button>
          {volumeCount > 1
            ? Array.from({ length: volumeCount }, (_, i) => i + 1).map((i) => (
                <button
                  key={i}
                  onClick={() => void downloadPackage(i)}
                  disabled={downloading}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Volume {i} only
                </button>
              ))
            : null}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Each volume folder: the paperback interior at {settings.trim}″, the cover wrap with the spine
          measured from that interior's real page count, the Kindle EPUB and its cover, the listing copy
          laid out field by field, and a pre-flight report.
        </p>
        {lastPackage ? (
          <p
            className={`text-xs ${
              lastPackage.blocking
                ? 'text-red-700 dark:text-red-400'
                : 'text-green-700 dark:text-green-400'
            }`}
          >
            {lastPackage.volumes} volume{lastPackage.volumes === 1 ? '' : 's'} built ·{' '}
            {lastPackage.blocking} blocking · {lastPackage.warnings} worth a look
          </p>
        ) : null}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          One thing is not checked here: <code>epubcheck</code>, which needs Java. Run it on the .epub
          before uploading — KDP runs its own and refuses the file rather than saying what is wrong.
        </p>
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
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 dark:border-gray-800 dark:bg-gray-900">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {hint ? <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : <div className="mb-1" />}
      {children}
    </div>
  );
}

function Copy({ label, value, note }: { label: string; value?: string; note?: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
        {label}
        {value ? <span className="ml-2 font-normal text-gray-400">{value.length} chars</span> : null}
      </p>
      <p className="mt-1 whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">
        {value?.trim() || <span className="text-gray-400">not written yet</span>}
      </p>
      {note ? <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{note}</p> : null}
    </div>
  );
}

function Chips({ label, values }: { label: string; values?: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {(values ?? []).length ? (
          values!.map((v) => (
            <span
              key={v}
              className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              {v}
            </span>
          ))
        ) : (
          <span className="text-xs text-gray-400">none yet</span>
        )}
      </div>
    </div>
  );
}
