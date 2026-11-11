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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { supabase } from '../../config/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useEngineJobQueue } from '../../hooks/useEngineJobQueue';
import PrintCopies from './PrintCopies';
import AudiobookPanel from './AudiobookPanel';
import SeriesPanel, { type SeriesView } from './SeriesPanel';
import CoverChooser, { type CoverOption } from './CoverChooser';
import AiField, { assistErrorMessage, useFieldHistory, useSavedCopy, type AssistResult } from './AiField';
import { ApiError } from '../../lib/api';

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
  breaks: number[] | null;
  cover_image_id: string | null;
  cover_image_ids: Record<string, string>;
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
  /** Roles the copy gives someone that the cast list does not, left after one correction. */
  role_warnings?: string[];
}

/**
 * The listing copy as it is being edited: every field a string, lists one item per line (blank lines
 * are dropped only on save, so typing a new line works), plus the book's subtitle and inside flap,
 * which are saved on book_copy_v2 rather than with the listing.
 */
interface EditCopy {
  blurb: string;
  back_cover: string;
  hook: string;
  keywords: string;
  categories: string;
  comparable_titles: string;
  subtitle: string;
  inside_flap: string;
}
type EditKey = keyof EditCopy;
const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean);

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
  series?: SeriesView;
  marketing: Record<string, Marketing | null>;
  marketing_history: HistoryEntry[];
  author: { pen_name: string; bio: string; bio_source: string | null; profile_why_this_book: string };
  chapters: { total: number; approved: number };
  cover_art: { id: string; created_at: string; chosen?: boolean } | null;
  cover_options?: CoverOption[];
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
  const [edit, setEdit] = useState<EditCopy | null>(null);
  // The editor as it is now, for a batch draft that returns after the author kept typing.
  const editRef = useRef(edit);
  editRef.current = edit;
  const history = useFieldHistory();
  const { data: saved } = useSavedCopy(projectId);
  const assist = saved?.assist;
  // The last AI draft put in each field, so a save can record which were kept exactly as drafted.
  const [aiValues, setAiValues] = useState<Record<string, string>>({});
  const noteAi = (r: AssistResult) => setAiValues((v) => ({ ...v, [r.field]: r.value }));
  const [confirmAll, setConfirmAll] = useState<EditKey[] | null>(null);
  const [draftingAll, setDraftingAll] = useState(false);
  const [batchWarnings, setBatchWarnings] = useState<string[]>([]);
  const [bio, setBio] = useState<string | null>(null);
  const [alsoBy, setAlsoBy] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [lastPackage, setLastPackage] = useState<{ blocking: number; warnings: number; volumes: number } | null>(null);

  useEffect(() => {
    if (data?.settings && !settings) setSettings(data.settings);
  }, [data, settings]);

  const plan = data?.volume_plan ?? null;
  const volumeCount = Math.max(1, plan?.volume_count ?? 1);
  const marketing = data?.marketing?.[String(volumeTab)] ?? null;
  const draftHistory = (data?.marketing_history ?? []).filter((h) => h.volume_index === volumeTab);
  const volumeIndex = volumeCount > 1 ? volumeTab : null;
  const bookCopy = saved?.books?.[String(volumeTab)] ?? { subtitle: '', inside_flap: '' };
  const bioValue = bio ?? data?.author.bio ?? '';
  const alsoByValue = alsoBy ?? (saved?.also_by ?? []).join('\n');

  /** The editor's starting point: the saved listing copy and the book's saved subtitle / flap. */
  const editFrom = (m: Marketing | null): EditCopy => ({
    blurb: m?.blurb ?? '',
    back_cover: m?.back_cover ?? '',
    hook: m?.hook ?? '',
    keywords: (m?.keywords ?? []).join('\n'),
    categories: (m?.categories ?? []).join('\n'),
    comparable_titles: (m?.comparable_titles ?? []).join('\n'),
    subtitle: bookCopy.subtitle,
    inside_flap: bookCopy.inside_flap,
  });

  const planning = stateOf(`${projectId}:volumes`) === 'queued';
  const drafting = stateOf(`${projectId}:marketing`) === 'queued';

  const saveSettings = useMutation({
    // A null in cover_image_ids clears that book's own cover.
    mutationFn: async (patch: Partial<Omit<Settings, 'cover_image_ids'>> & { cover_image_ids?: Record<string, string | null> }) => {
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

  // With `breaks` the books end where the author put them; null hands the choice back to the
  // planner; absent re-uses whatever was saved.
  const planVolumes = useMutation({
    mutationFn: async (vars?: { breaks: number[] | null }) => {
      const res = await apiFetch<{ jobId?: string }>(
        `/api/publishing/project/${projectId}/volumes/plan`,
        {
          method: 'POST',
          body: JSON.stringify({
            trim: settings?.trim,
            volume_count: settings?.volume_count ?? null,
            judge_endings: true,
            ...(vars ? { breaks: vars.breaks } : {}),
          }),
        },
      );
      return res.jobId;
    },
    onSuccess: (jobId, vars) => {
      if (vars && settings) {
        setSettings({ ...settings, breaks: vars.breaks, volume_count: vars.breaks ? vars.breaks.length + 1 : settings.volume_count });
      }
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
    mutationFn: async (e: EditCopy) => {
      const res = await apiFetch<ApiEnvelope<Marketing>>(
        `/api/publishing/project/${projectId}/marketing`,
        {
          method: 'PUT',
          body: JSON.stringify({
            volume_index: volumeIndex,
            blurb: e.blurb,
            back_cover: e.back_cover,
            hook: e.hook,
            keywords: lines(e.keywords),
            categories: lines(e.categories),
            comparable_titles: lines(e.comparable_titles),
          }),
        },
      );
      // The subtitle and inside flap live on book_copy_v2.
      await apiFetch(`/api/copy-assist/project/${projectId}/copy`, {
        method: 'PUT',
        body: JSON.stringify({
          volume_index: volumeIndex,
          subtitle: e.subtitle,
          inside_flap: e.inside_flap,
          generated: (['subtitle', 'inside_flap'] as const).filter((k) => e[k].trim() && aiValues[k] === e[k]),
        }),
      });
      return res.data!;
    },
    onSuccess: () => {
      setEdit(null);
      void queryClient.invalidateQueries({ queryKey: stateKey });
      void queryClient.invalidateQueries({ queryKey: ['copy-assist', projectId] });
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

  /** "Draft all missing": only the package fields that are empty in the editor, at a total shown first. */
  const askDraftAll = () => {
    const start = edit ?? editFrom(marketing);
    if (!edit) setEdit(start);
    const empty = ((assist?.package_fields ?? []) as EditKey[]).filter((k) => k in start && !start[k].trim());
    if (!empty.length) {
      addToast('Every field already has text. Use Revise with AI on the one you want to change.', 'info');
      return;
    }
    setConfirmAll(empty);
  };

  const draftAll = async (fields: EditKey[]) => {
    setDraftingAll(true);
    setBatchWarnings([]);
    try {
      const res = await apiFetch<ApiEnvelope<{ results: Record<string, AssistResult>; errors: Record<string, string>; credits_charged: number; credits_remaining: number }>>(
        `/api/copy-assist/project/${projectId}/assist/all`,
        { method: 'POST', body: JSON.stringify({ volume_index: volumeIndex, fields, expected_cost: assist?.charged ? (assist.price * fields.length) : 0 }) },
      );
      const { results, errors, credits_charged } = res.data!;
      const warnings: string[] = [];
      const next = { ...(editRef.current ?? editFrom(marketing)) };
      for (const [f, r] of Object.entries(results)) {
        const k = f as EditKey;
        // Only fields still empty: the author may have typed in one while this ran.
        if (!r.value.trim() || next[k].trim()) continue;
        history.push(k, next[k]);
        next[k] = r.value;
        for (const w of r.warnings) warnings.push(`${assist?.fields[k]?.label ?? k}: ${w}`);
      }
      setEdit(next);
      setAiValues((v) => ({ ...v, ...Object.fromEntries(Object.entries(results).map(([f, r]) => [f, r.value])) }));
      setBatchWarnings(warnings);
      const failed = Object.keys(errors);
      addToast(
        `Drafted ${Object.keys(results).length} field${Object.keys(results).length === 1 ? '' : 's'} · ${credits_charged} credits${failed.length ? ` · failed (not charged): ${failed.join(', ')}` : ''}. Review, then save.`,
        failed.length ? 'error' : 'success',
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') void queryClient.invalidateQueries({ queryKey: ['copy-assist', projectId] });
      addToast(assistErrorMessage(err), 'error');
    } finally {
      setDraftingAll(false);
      setConfirmAll(null);
    }
  };

  const saveBio = useMutation({
    mutationFn: async (text: string) =>
      apiFetch(`/api/author/bio`, {
        method: 'PUT',
        body: JSON.stringify({ bio: text, source: aiValues.author_bio === text ? 'generated' : 'edited' }),
      }),
    onSuccess: () => {
      setBio(null);
      void queryClient.invalidateQueries({ queryKey: stateKey });
      void queryClient.invalidateQueries({ queryKey: ['publishing-readiness', projectId] });
      addToast('Bio saved to your Author Profile', 'success');
    },
    onError: (err: Error) => addToast(err.message || 'Could not save the bio', 'error'),
  });

  const saveMatter = async () => {
    if (!settings) return;
    saveSettings.mutate(settings);
    if (alsoBy !== null) {
      try {
        await apiFetch(`/api/copy-assist/project/${projectId}/copy`, { method: 'PUT', body: JSON.stringify({ also_by: lines(alsoBy) }) });
        setAlsoBy(null);
        void queryClient.invalidateQueries({ queryKey: ['copy-assist', projectId] });
      } catch (err) {
        addToast(assistErrorMessage(err), 'error');
      }
    }
  };

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
                    {detail.minimum_volumes} book{detail.minimum_volumes === 1 ? '' : 's'}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {!trimOptions.length ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Run the planner to see what each trim costs in pages and books.
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
          <Field label="Books" hint="Blank lets the planner decide from the page cap.">
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

      {/* 2. Series */}
      <SeriesPanel
        projectId={projectId}
        series={data.series}
        planned={Boolean(plan)}
        planning={planning || planVolumes.isPending}
        onPlan={() => planVolumes.mutate(undefined)}
        onPlanWithBreaks={(breaks) => planVolumes.mutate({ breaks })}
        breaksByAuthor={Boolean(data.settings.breaks?.length)}
        warnings={plan?.warnings}
        summary={
          plan
            ? `${plan.volume_count} book${plan.volume_count === 1 ? '' : 's'} at ${plan.trim}″ · ${plan.total_words.toLocaleString()} words${
                plan.judged_candidates ? ` · ${plan.judged_candidates} endings read` : ''
              }`
            : undefined
        }
        stateKey={stateKey}
      />

      {/* Cover: which picture, for the whole book and for each book of a series */}
      <Section
        title="Cover"
        subtitle="Which picture the book is printed with. Every picture you generate lands in the Art gallery; choose the one that is the cover."
      >
        <CoverChooser
          projectId={projectId}
          options={data.cover_options ?? []}
          chosen={data.settings.cover_image_id ?? null}
          chosenByBook={data.settings.cover_image_ids ?? {}}
          books={(data.series?.books ?? []).map((b) => ({ index: b.index, title: b.title }))}
          saving={saveSettings.isPending}
          onChoose={(patch) => saveSettings.mutate(patch)}
        />
      </Section>

      {/* 3. Listing copy */}
      {/* Named for what it is rather than where it goes. "Amazon listing copy" is precise and it is
          not what anyone searches a page for; "marketing" is the word people arrive with. */}
      <Section
        title="Marketing copy"
        subtitle="The book's description, back cover, hook, keywords and categories — what Amazon shows a buyer. Written from the manuscript, then reviewed: ask for a change in words, or edit any field yourself."
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
                Book {i}
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
            {bookCopy.subtitle ? <Copy label="Subtitle" value={bookCopy.subtitle} /> : null}
            {bookCopy.inside_flap ? <Copy label="Inside flap" value={bookCopy.inside_flap} /> : null}
            <Chips label={`Keywords (${marketing.keywords?.length ?? 0} of 7)`} values={marketing.keywords} />
            <Chips label="Categories" values={marketing.categories} />
            <Chips label="Comparable titles" values={marketing.comparable_titles} />
            <Copy
              label="Author bio"
              value={data.author.bio || marketing.author_bio}
              note={
                // The approved bio is the profile's, shared by every book, and the copywriter returns
                // it word for word — so a revise below cannot change it. Say where it can be changed.
                data.author.bio ? (
                  <>
                    Your approved bio, from the Author Profile. This is what gets printed, in every one of your books —
                    asking for a change below does not touch it.{' '}
                    <Link to="/settings/author" className="text-brand-600 underline">
                      Change the bio in your Author Profile
                    </Link>
                  </>
                ) : (
                  <>
                    Suggested —{' '}
                    <Link to="/settings/author" className="text-brand-600 underline">
                      set your own in your Author Profile
                    </Link>{' '}
                    before publishing.
                  </>
                )
              }
            />
            {marketing.role_warnings?.length ? (
              <ul data-testid="role-warnings" className="list-disc rounded-lg bg-amber-50 p-2 pl-6 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {marketing.role_warnings.map((w) => (
                  <li key={w}>{w}. Fix it in the copy before publishing.</li>
                ))}
              </ul>
            ) : null}
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
          <div data-testid="listing-editor" className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/30 p-3 dark:border-brand-800 dark:bg-brand-950/20">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Write each field yourself or ask the assistant. A draft goes into the field (or beside your text, for you to
              choose) and nothing is saved until you press Save. It writes from this book only and never invents reviews,
              awards or sales claims.
            </p>
            {LISTING_FIELDS.map(({ key, label, hint, rows }) => (
              <AiField
                key={key}
                projectId={projectId}
                volumeIndex={volumeIndex}
                field={key}
                label={label}
                hint={hint}
                rows={rows}
                value={edit[key]}
                onChange={(v) => setEdit((e) => (e ? { ...e, [key]: v } : e))}
                onApplied={noteAi}
                assist={assist}
                history={history}
              />
            ))}
            {batchWarnings.length ? (
              <ul data-testid="batch-warnings" className="list-disc rounded bg-amber-50 py-1 pl-5 pr-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {batchWarnings.map((w) => (
                  <li key={w}>Check: {w}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex gap-2">
              <button
                onClick={() => saveMarketing.mutate(edit)}
                disabled={saveMarketing.isPending}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Save my version
              </button>
              <button
                data-testid="draft-all-missing-edit"
                onClick={askDraftAll}
                disabled={!assist || draftingAll || Boolean(confirmAll)}
                className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300"
              >
                Draft all missing
              </button>
              <button
                onClick={() => {
                  setEdit(null);
                  setBatchWarnings([]);
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {/* Draft all missing: the total is shown and agreed before anything runs. */}
        {confirmAll ? (
          <div data-testid="draft-all-confirm" className="rounded-lg border border-brand-300 bg-white p-3 text-xs dark:border-brand-700 dark:bg-gray-900">
            <p className="text-gray-800 dark:text-gray-200">
              Draft {confirmAll.length} empty field{confirmAll.length === 1 ? '' : 's'} (
              {confirmAll.map((k) => assist?.fields[k]?.label ?? k).join(', ')})
              {assist?.charged ? (
                <>
                  {' '}for <strong data-testid="draft-all-total">{assist.price * confirmAll.length} credits</strong> ({assist.price} each, charged
                  only for the fields that come back)
                </>
              ) : (
                ' (no charge for your account)'
              )}
              ? Fields you have written are not touched.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                data-testid="draft-all-go"
                onClick={() => void draftAll(confirmAll)}
                disabled={draftingAll}
                className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {draftingAll ? 'Drafting…' : 'Draft them'}
              </button>
              <button onClick={() => setConfirmAll(null)} disabled={draftingAll} className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-600 dark:border-gray-600 dark:text-gray-400">
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
            {marketing && data.author.bio && /\bbio\b|biography/i.test(instructions) ? (
              <p data-testid="bio-not-revised" className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                The author bio is not part of this copy — it is your approved bio, printed exactly as you wrote it.{' '}
                <Link to="/settings/author" className="underline">
                  Change it in your Author Profile
                </Link>
                ; it updates every book.
              </p>
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
                    onClick={() => setEdit(editFrom(marketing))}
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
              ) : (
                <button
                  data-testid="write-field-by-field"
                  onClick={() => setEdit(editFrom(null))}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Write it field by field (with the assistant)
                </button>
              )}
              <button
                data-testid="draft-all-missing"
                onClick={askDraftAll}
                disabled={!assist || draftingAll}
                className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300"
              >
                Draft all missing
              </button>
              {draftHistory.length ? (
                <button
                  onClick={() => setShowHistory((s) => !s)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  {showHistory ? 'Hide' : `${draftHistory.length} earlier draft${draftHistory.length === 1 ? '' : 's'}`}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {showHistory
          ? draftHistory.map((h) => {
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
        {MATTER_FIELDS.map(({ key, label, hint, rows }) => (
          <div key={key} className="space-y-3">
            <AiField
              projectId={projectId}
              field={key}
              label={label}
              hint={hint}
              rows={rows}
              value={settings[key]}
              onChange={(v) => setSettings((st) => (st ? { ...st, [key]: v } : st))}
              onApplied={(r) => {
                noteAi(r);
                // The epigraph's speaker comes with it, into an empty attribution only.
                if (key === 'epigraph' && r.attribution) {
                  setSettings((st) => (st && !st.epigraph_attribution.trim() ? { ...st, epigraph_attribution: r.attribution! } : st));
                }
              }}
              assist={assist}
              history={history}
              placeholder={key === 'why_this_book' ? data.author.profile_why_this_book || undefined : undefined}
            />
            {key === 'epigraph' ? (
              <Field label="Epigraph attribution">
                <input
                  aria-label="Epigraph attribution"
                  value={settings.epigraph_attribution}
                  onChange={(e) => setSettings({ ...settings, epigraph_attribution: e.target.value })}
                  className={inputClass}
                />
              </Field>
            ) : null}
          </div>
        ))}
        <AiField
          projectId={projectId}
          field="also_by"
          label="Also by"
          hint="Your other books, one per line, for the Also-by page at the back of every book. A series' own books are listed for you."
          rows={3}
          value={alsoByValue}
          onChange={(v) => setAlsoBy(v)}
          assist={assist}
          history={history}
        />
        <button
          data-testid="save-matter"
          onClick={() => void saveMatter()}
          disabled={saveSettings.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveSettings.isPending ? 'Saving…' : 'Save matter'}
        </button>

        <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
          <AiField
            projectId={projectId}
            field="author_bio"
            label="About the author"
            hint="Printed at the back of every one of your books and used on Author Central. Written only from your Author Profile; anything it does not know is left as a [placeholder]."
            rows={4}
            value={bioValue}
            onChange={(v) => setBio(v)}
            onApplied={noteAi}
            assist={assist}
            history={history}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              data-testid="save-bio"
              onClick={() => saveBio.mutate(bioValue)}
              disabled={saveBio.isPending || bio === null || !bioValue.trim() || PLACEHOLDER.test(bioValue)}
              className="rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300"
            >
              Save as my bio
            </button>
            {PLACEHOLDER.test(bioValue) ? (
              <span className="text-xs text-amber-700 dark:text-amber-400">Fill in or remove the [placeholders] first.</span>
            ) : null}
            <Link to="/settings/author" className="text-xs text-brand-600 underline">
              Add facts in your Author Profile
            </Link>
          </div>
        </div>
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
            {downloading ? 'Building…' : volumeCount > 1 ? `Download all ${volumeCount} books` : 'Download the package'}
          </button>
          {volumeCount > 1
            ? Array.from({ length: volumeCount }, (_, i) => i + 1).map((i) => (
                <button
                  key={i}
                  onClick={() => void downloadPackage(i)}
                  disabled={downloading}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  Book {i} only
                </button>
              ))
            : null}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Each book’s folder: the paperback interior at {settings.trim}″, the cover wrap with the spine
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
            {lastPackage.volumes} book{lastPackage.volumes === 1 ? '' : 's'} built ·{' '}
            {lastPackage.blocking} blocking · {lastPackage.warnings} worth a look
          </p>
        ) : null}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          One thing is not checked here: <code>epubcheck</code>, which needs Java. Run it on the .epub
          before uploading — KDP runs its own and refuses the file rather than saying what is wrong.
        </p>
      </Section>

      {/* 5. Printed copies */}
      <PrintCopies projectId={projectId} volumeCount={volumeCount} />

      {/* 6. The audiobook */}
      <AudiobookPanel projectId={projectId} volumeCount={volumeCount} />
    </div>
  );
}

/** A [placeholder] the assistant left for the author to fill. */
const PLACEHOLDER = /\[[^\]]+\]/;

/** The front and back matter the author writes (stored with the publishing settings). */
const MATTER_FIELDS: { key: 'dedication' | 'epigraph' | 'authors_note' | 'acknowledgements' | 'why_this_book'; label: string; hint?: string; rows: number }[] = [
  { key: 'dedication', label: 'Dedication', hint: 'Personal: the assistant leaves the name as a [placeholder].', rows: 2 },
  { key: 'epigraph', label: 'Epigraph', hint: 'The assistant picks a line from your own manuscript, word for word.', rows: 2 },
  { key: 'authors_note', label: "Author's note", hint: 'For a book built on documented history this is close to obligatory — it is where the record is separated from the invention.', rows: 6 },
  { key: 'acknowledgements', label: 'Acknowledgements', hint: 'The assistant writes [placeholders] for the people to thank; it never guesses a name.', rows: 4 },
  { key: 'why_this_book', label: 'Why this book', hint: 'Used by the bio for this project, in place of the one on your profile.', rows: 3 },
];

/** The listing editor's fields, in the order the KDP form asks for them. */
const LISTING_FIELDS: { key: EditKey; label: string; hint?: string; rows: number }[] = [
  { key: 'subtitle', label: 'Subtitle', hint: 'Optional. Printed on the title page; KDP allows 200 characters for title and subtitle together.', rows: 1 },
  { key: 'blurb', label: 'Description', hint: 'What Amazon shows a buyer. KDP allows 4,000 characters.', rows: 8 },
  { key: 'back_cover', label: 'Back cover', hint: 'Shorter and harder — read standing up in a shop.', rows: 4 },
  { key: 'inside_flap', label: 'Inside flap', hint: 'The hardcover jacket’s front flap: fuller than the back cover. In the listing file.', rows: 6 },
  { key: 'hook', label: 'Hook', hint: 'One sentence, for ads, posts and the landing page.', rows: 1 },
  { key: 'keywords', label: 'Keywords', hint: 'One per line. KDP gives exactly 7 slots of 50 characters; unused ones are wasted reach.', rows: 7 },
  { key: 'categories', label: 'Categories', hint: 'One per line, up to 3, as Amazon words them.', rows: 3 },
  { key: 'comparable_titles', label: 'Comparable titles', hint: 'One per line. Check each one exists.', rows: 4 },
];

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

function Copy({ label, value, note }: { label: string; value?: string; note?: ReactNode }) {
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
