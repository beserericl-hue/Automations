/**
 * Audiobook — narrate the book, one recording per chapter.
 *
 * What the author does, in the order they do it:
 *   1. Choose the narrator: a voice, a style of delivery (what keeps it from sounding flat), and
 *      whether the opening and closing credits are spoken. "Hear it" reads the opening of THEIR first
 *      chapter in that voice before anything is spent.
 *   2. Build. Each chapter is narrated by an engine job and shows up as its own recording with its own
 *      player and download as it finishes; the page keeps checking while anything is still running.
 *      Only what is missing, changed since it was recorded, or failed is built — and charged.
 *   3. Cut the retail sample from the first chapter, and take the square cover.
 *
 * Every number shown (length, loudness, whether a recording is in the retail spec) is MEASURED on the
 * stored file by the engine, not what it aimed for.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface Voice {
  id: string;
  label: string;
  note?: string;
}
interface Style {
  id: string;
  label: string;
  description: string;
}
interface Options {
  voices: Voice[];
  styles: Style[];
  max_custom_style: number;
  credits_per_unit: number;
  unit_words: number;
}
interface Pronunciation {
  word: string;
  say: string;
}
interface ElevenVoice {
  id: string;
  name: string;
  category: string;
  yours: boolean;
  labels: Record<string, string>;
}
interface ElevenVoices {
  connected: boolean;
  rejected?: boolean;
  voices: ElevenVoice[];
}
interface Settings {
  provider: 'openai' | 'elevenlabs';
  voice: string;
  style: string;
  custom_style: string;
  credits: boolean;
  pronunciations: Pronunciation[];
}
type Status = 'none' | 'queued' | 'building' | 'ready' | 'failed';
interface Item {
  id: string | null;
  kind: 'opening' | 'chapter' | 'closing';
  chapter_number: number;
  title: string;
  words: number;
  status: Status;
  error: string | null;
  stale: boolean;
  duration_s: number | null;
  size_bytes: number | null;
  rms_db: number | null;
  peak_db: number | null;
  spec_ok: boolean | null;
  url: string | null;
  download_url: string | null;
  filename: string;
}
interface Sample {
  id: string | null;
  status: Status;
  error: string | null;
  duration_s: number | null;
  spec_ok: boolean | null;
  url: string | null;
  download_url: string | null;
  can_build: boolean;
}
interface Audiobook {
  volume: number;
  volumes: number;
  title: string;
  author: string;
  buildable: boolean;
  settings: Settings;
  items: Item[];
  sample: Sample;
  summary: {
    total: number;
    ready: number;
    building: number;
    failed: number;
    stale: number;
    missing: number;
    duration_s: number;
    size_bytes: number;
    out_of_spec: number;
  };
  cost: { own_account?: boolean; credits_per_unit: number; unit_words: number; to_build_credits: number; total_credits: number };
  cover: { available: boolean; url: string | null };
}

function messageOf(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
}

/** 3,725 s -> "1:02:05"; 125 s -> "2:05". */
export function clock(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const mb = (bytes: number | null | undefined) => (bytes == null ? '—' : `${(bytes / 1048576).toFixed(1)} MB`);

const STATUS_LABEL: Record<Status, string> = {
  none: 'Not built',
  queued: 'Waiting',
  building: 'Narrating…',
  ready: 'Ready',
  failed: 'Failed',
};

const field =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const secondary =
  'rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';

function StatusBadge({ item }: { item: { status: Status; stale?: boolean; spec_ok?: boolean | null } }) {
  const tone =
    item.status === 'ready' && !item.stale
      ? 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300'
      : item.status === 'failed'
        ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300'
        : item.status === 'building' || item.status === 'queued' || item.stale
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
  const text = item.status === 'ready' && item.stale ? 'Changed since recorded' : STATUS_LABEL[item.status];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{text}</span>;
}

export default function AudiobookPanel({ projectId, volumeCount }: { projectId: string; volumeCount: number }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [volume, setVolume] = useState(1);
  const key = ['audiobook', projectId, volume] as const;

  const { data: options } = useQuery({
    queryKey: ['audiobook-options'],
    queryFn: async () => (await apiFetch<ApiEnvelope<Options>>('/api/audiobook/options')).data!,
  });
  const { data: suggested } = useQuery({
    queryKey: ['audiobook-names', projectId, volume],
    queryFn: async () =>
      (await apiFetch<ApiEnvelope<{ names: { word: string; count: number }[] }>>(`/api/audiobook/project/${projectId}/names?volume=${volume}`)).data?.names ?? [],
    staleTime: 60_000,
  });
  const { data: book, error: loadError } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const data = (await apiFetch<ApiEnvelope<Audiobook>>(`/api/audiobook/project/${projectId}?volume=${volume}`)).data;
      // A reply that is not an audiobook (an old server, a proxy page) is an error, not an empty book.
      if (!data?.summary || !Array.isArray(data.items)) throw new Error('The server sent an unreadable audiobook.');
      return data;
    },
    // Keep checking while anything is being narrated; stop when it is all at rest.
    refetchInterval: (q) => ((q.state.data?.summary?.building ?? 0) > 0 ? 4000 : false),
  });

  // The narrator form is the author's to edit; it follows the saved settings until they touch it.
  const [form, setForm] = useState<Settings | null>(null);
  const savedKey = book ? JSON.stringify(book.settings) : '';
  useEffect(() => {
    if (book) setForm(book.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, volume]);
  const dirty = Boolean(book && form && JSON.stringify(form) !== savedKey);

  // The author's own ElevenLabs account: their key (saved encrypted, never shown again) and their voices.
  const [elKey, setElKey] = useState('');
  const useEleven = form?.provider === 'elevenlabs';
  const { data: eleven, refetch: refetchEleven } = useQuery({
    queryKey: ['audiobook-eleven-voices'],
    queryFn: async () => (await apiFetch<ApiEnvelope<ElevenVoices>>('/api/audiobook/elevenlabs/voices')).data!,
    enabled: Boolean(useEleven),
    staleTime: 60_000,
  });
  const connect = useMutation({
    mutationFn: async (api_key: string) =>
      (await apiFetch<ApiEnvelope<{ ok: boolean; voices: number }>>('/api/integrations/elevenlabs', { method: 'PUT', body: JSON.stringify({ api_key }) })).data!,
    onSuccess: (r) => {
      setElKey('');
      addToast(`ElevenLabs connected · ${r.voices} voice${r.voices === 1 ? '' : 's'}`, 'success');
      void refetchEleven();
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });
  const disconnect = useMutation({
    mutationFn: async () => apiFetch('/api/integrations/elevenlabs/key', { method: 'DELETE' }),
    onSuccess: () => {
      addToast('ElevenLabs key removed', 'success');
      void refetchEleven();
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: async (s: Settings) =>
      apiFetch(`/api/audiobook/project/${projectId}/settings`, { method: 'PUT', body: JSON.stringify({ volume, ...s }) }),
    onSuccess: () => {
      addToast('Narrator saved', 'success');
      void refresh();
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const build = useMutation({
    mutationFn: async (itemIds?: string[]) => {
      return (
        await apiFetch<ApiEnvelope<{ queued: number; skipped_in_progress: number; credits_charged: number }>>(
          `/api/audiobook/project/${projectId}/build`,
          { method: 'POST', body: JSON.stringify({ volume, ...(itemIds ? { item_ids: itemIds } : {}) }) },
        )
      ).data!;
    },
    onSuccess: (r) => {
      addToast(
        r.queued
          ? `Narrating ${r.queued} recording${r.queued === 1 ? '' : 's'}${r.credits_charged ? ` · ${r.credits_charged} credits` : ''}`
          : 'Nothing needed building',
        r.queued ? 'success' : 'info',
      );
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ['credits'] });
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  // Save the new voice/delivery, then narrate everything that was recorded with the old one.
  const renarrate = useMutation({
    mutationFn: async (s: Settings) => {
      await apiFetch(`/api/audiobook/project/${projectId}/settings`, { method: 'PUT', body: JSON.stringify({ volume, ...s }) });
      return (
        await apiFetch<ApiEnvelope<{ queued: number; skipped_in_progress: number; credits_charged: number }>>(
          `/api/audiobook/project/${projectId}/build`,
          { method: 'POST', body: JSON.stringify({ volume }) },
        )
      ).data!;
    },
    onSuccess: (r) => {
      addToast(`Re-narrating ${r.queued} recording${r.queued === 1 ? '' : 's'}${r.credits_charged ? ` · ${r.credits_charged} credits` : ''}`, 'success');
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ['credits'] });
    },
    onError: (err) => {
      addToast(messageOf(err), 'error');
      void refresh();
    },
  });

  const sample = useMutation({
    mutationFn: async () =>
      apiFetch(`/api/audiobook/project/${projectId}/sample`, { method: 'POST', body: JSON.stringify({ volume }) }),
    onSuccess: () => void refresh(),
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  const cover = useMutation({
    mutationFn: async () =>
      apiFetch(`/api/audiobook/project/${projectId}/cover`, { method: 'POST', body: JSON.stringify({ volume }) }),
    onSuccess: () => void refresh(),
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  // "Hear it": the opening of the author's own first chapter, in the voice and style on screen.
  const audio = useRef<HTMLAudioElement | null>(null);
  const preview = useMutation({
    // `say`: one word from the guide, read with the whole guide applied; omitted = the book's opening.
    mutationFn: async (say?: string) =>
      (
        await apiFetch<ApiEnvelope<{ audio_b64: string; content_type: string }>>(
          `/api/audiobook/project/${projectId}/preview`,
          { method: 'POST', body: JSON.stringify({ volume, ...form, ...(say ? { say } : {}) }) },
        )
      ).data!,
    onSuccess: (r) => {
      const el = audio.current;
      if (!el) return;
      el.src = `data:${r.content_type};base64,${r.audio_b64}`;
      void el.play().catch(() => undefined);
    },
    onError: (err) => addToast(messageOf(err), 'error'),
  });

  if (loadError) {
    return (
      <Shell>
        <p className="text-xs text-red-700 dark:text-red-400">Could not load the audiobook: {messageOf(loadError)}</p>
      </Shell>
    );
  }
  if (!book || !options || !form) {
    return (
      <Shell>
        <p className="text-xs text-gray-500">Loading…</p>
      </Shell>
    );
  }

  const s = book.summary;
  const busy = s.building > 0;
  const toBuild = s.missing + s.failed + s.stale;
  const anyBuilt = s.ready + s.stale > 0;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });
  const guide = form.pronunciations ?? [];
  const setGuide = (next: Pronunciation[]) => set('pronunciations', next);
  const offered = (suggested ?? []).filter((n) => !guide.some((g) => g.word === n.word)).slice(0, 12);
  const costNote = (credits: number) =>
    credits > 0 ? ` · ${credits} credits` : '';

  return (
    <Shell>
      <p
        data-testid="audiobook-notice"
        className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
      >
        The narrator is a synthetic (A.I.) voice, and the opening credits say so. Audible’s standard ACX route
        accepts human narration unless a program authorizes otherwise, so check the store’s rules before you
        submit these files; they suit stores that take A.I. narration, your own site and direct delivery.
      </p>

      {volumeCount > 1 ? (
        <label className="block text-xs text-gray-600 dark:text-gray-400">
          Book{' '}
          <select
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            data-testid="audiobook-volume"
            className="ml-1 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          >
            {Array.from({ length: volumeCount }, (_, i) => i + 1).map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {!book.buildable ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          This book has no chapter text yet — write or approve some chapters, then come back to narrate them.
        </p>
      ) : (
        <>
          <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <legend className="px-1 text-xs font-semibold text-gray-700 dark:text-gray-200">Narrator</legend>
            <div className="flex flex-wrap gap-4 text-xs text-gray-700 dark:text-gray-300" role="radiogroup" aria-label="Narrator source">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="audiobook-provider"
                  data-testid="audiobook-provider-openai"
                  checked={!useEleven}
                  onChange={() => setForm({ ...form, provider: 'openai', voice: book.settings.provider === 'openai' ? book.settings.voice : 'marin' })}
                />
                Workbench voices
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="audiobook-provider"
                  data-testid="audiobook-provider-elevenlabs"
                  checked={useEleven}
                  onChange={() => setForm({ ...form, provider: 'elevenlabs', voice: book.settings.provider === 'elevenlabs' ? book.settings.voice : '' })}
                />
                My ElevenLabs voices (your own account, including a clone of your voice)
              </label>
            </div>

            {useEleven && eleven && !eleven.connected ? (
              <div data-testid="audiobook-eleven-connect" className="space-y-2 rounded-md bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                <p>
                  {eleven.rejected
                    ? 'ElevenLabs no longer accepts your saved key. Paste a new one.'
                    : 'Paste an ElevenLabs API key with Text to Speech and Voices (read) access. It is saved encrypted to your account, used only to narrate your books, and never shown again.'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    data-testid="audiobook-eleven-key"
                    value={elKey}
                    onChange={(e) => setElKey(e.target.value)}
                    placeholder="sk_…"
                    className={`${field} w-72`}
                  />
                  <button
                    type="button"
                    data-testid="audiobook-eleven-connect-btn"
                    onClick={() => connect.mutate(elKey.trim())}
                    disabled={connect.isPending || elKey.trim().length < 16}
                    className={primary}
                  >
                    {connect.isPending ? 'Checking…' : 'Connect ElevenLabs'}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-gray-600 dark:text-gray-400">
                {useEleven ? 'Voice (from your ElevenLabs account)' : 'Voice (American English)'}
                <select
                  data-testid="audiobook-voice"
                  value={form.voice}
                  onChange={(e) => set('voice', e.target.value)}
                  disabled={useEleven && !eleven?.connected}
                  className={`mt-1 ${field}`}
                >
                  {useEleven ? (
                    <>
                      {!form.voice ? <option value="">Choose a voice…</option> : null}
                      {(eleven?.voices ?? []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                          {v.yours ? ' — your voice' : ''}
                        </option>
                      ))}
                    </>
                  ) : (
                    options.voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                        {v.note ? ' — recommended' : ''}
                      </option>
                    ))
                  )}
                </select>
                {useEleven && eleven?.connected ? (
                  <button
                    type="button"
                    data-testid="audiobook-eleven-disconnect"
                    onClick={() => disconnect.mutate()}
                    className="mt-1 text-xs text-gray-400 underline hover:text-red-600"
                  >
                    Disconnect ElevenLabs
                  </button>
                ) : null}
              </label>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  data-testid="audiobook-preview"
                  onClick={() => preview.mutate(undefined)}
                  disabled={preview.isPending || (useEleven && !form.voice)}
                  className={secondary}
                >
                  {preview.isPending ? 'Reading…' : 'Hear it on my book'}
                </button>
                <audio ref={audio} data-testid="audiobook-preview-audio" controls className="h-8 max-w-full" />
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-600 dark:text-gray-400">Delivery</p>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {options.styles.map((st) => (
                  <label
                    key={st.id}
                    className={`cursor-pointer rounded-lg border p-2 text-xs ${
                      form.style === st.id
                        ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200'
                        : 'border-gray-200 text-gray-700 dark:border-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="audiobook-style"
                      data-testid={`audiobook-style-${st.id}`}
                      checked={form.style === st.id}
                      onChange={() => set('style', st.id)}
                      className="mr-2"
                    />
                    <span className="font-medium">{st.label}</span>
                    <span className="block pl-5 text-gray-500 dark:text-gray-400">{st.description}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="block text-xs text-gray-600 dark:text-gray-400">
              Your own direction (optional){useEleven ? ' — not used by ElevenLabs, which follows the delivery style above' : ''}
              <textarea
                data-testid="audiobook-custom-style"
                disabled={useEleven}
                value={form.custom_style}
                maxLength={options.max_custom_style}
                onChange={(e) => set('custom_style', e.target.value)}
                rows={2}
                placeholder="e.g. A touch slower, a dry sense of humor in the narration, never theatrical."
                className={`mt-1 ${field}`}
              />
            </label>

            <div data-testid="audiobook-guide" className="space-y-2">
              <p className="text-xs text-gray-600 dark:text-gray-400">
                Pronunciation guide — for names the voice gets wrong. Write the word as you hear it should sound, in
                plain letters (Siobhan → Shivawn). It changes the narration only, never your manuscript, and re-records
                just the chapters the word appears in.
              </p>
              {guide.map((g, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2" data-testid={`guide-row-${i}`}>
                  <input
                    aria-label={`Word ${i + 1}`}
                    data-testid={`guide-word-${i}`}
                    value={g.word}
                    maxLength={60}
                    onChange={(e) => setGuide(guide.map((x, j) => (j === i ? { ...x, word: e.target.value } : x)))}
                    placeholder="Name as written"
                    className={`${field} w-44`}
                  />
                  <span className="text-gray-400">→</span>
                  <input
                    aria-label={`Sounds like ${i + 1}`}
                    data-testid={`guide-say-${i}`}
                    value={g.say}
                    maxLength={80}
                    onChange={(e) => setGuide(guide.map((x, j) => (j === i ? { ...x, say: e.target.value } : x)))}
                    placeholder="Sounds like"
                    className={`${field} w-44`}
                  />
                  <button
                    type="button"
                    data-testid={`guide-hear-${i}`}
                    onClick={() => g.word.trim() && preview.mutate(g.word.trim())}
                    disabled={preview.isPending || !g.word.trim()}
                    className={secondary}
                  >
                    Hear it
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${g.word || 'entry'}`}
                    data-testid={`guide-remove-${i}`}
                    onClick={() => setGuide(guide.filter((_, j) => j !== i))}
                    className="text-xs text-gray-400 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" data-testid="guide-add" onClick={() => setGuide([...guide, { word: '', say: '' }])} className={secondary}>
                  Add a word
                </button>
                {offered.length ? <span className="text-xs text-gray-500">Names that appear often in your chapters:</span> : null}
                {offered.map((n) => (
                  <button
                    key={n.word}
                    type="button"
                    data-testid={`guide-suggest-${n.word}`}
                    onClick={() => setGuide([...guide, { word: n.word, say: '' }])}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300"
                    title={`${n.count} times`}
                  >
                    {n.word} <span className="text-gray-400">×{n.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                data-testid="audiobook-credits"
                checked={form.credits}
                onChange={(e) => set('credits', e.target.checked)}
              />
              Speak opening credits (title, author, narrator) and closing credits
            </label>

            {dirty ? (
              <div
                data-testid="audiobook-unsaved"
                className="flex flex-wrap items-center gap-2 rounded-md bg-brand-50 p-2 text-xs text-brand-900 dark:bg-brand-950/40 dark:text-brand-100"
              >
                <span className="flex-1">You changed the narrator. Nothing is re-recorded until you say so.</span>
                <button
                  type="button"
                  data-testid="audiobook-save"
                  onClick={() => save.mutate(form)}
                  disabled={save.isPending || renarrate.isPending}
                  className={secondary}
                >
                  {save.isPending ? 'Saving…' : 'Save narrator'}
                </button>
                {anyBuilt ? (
                  <button
                    type="button"
                    data-testid="audiobook-save-renarrate"
                    onClick={() => renarrate.mutate(form)}
                    disabled={save.isPending || renarrate.isPending}
                    className={primary}
                  >
                    {renarrate.isPending ? 'Starting…' : `Save and re-narrate what changed${book.cost.total_credits ? ` · up to ${book.cost.total_credits} credits` : ''}`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </fieldset>

          <div className="flex flex-wrap items-start gap-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            {book.cover.url ? (
              <img
                data-testid="audiobook-cover"
                src={book.cover.url}
                alt={`${book.title} audiobook cover`}
                className="h-28 w-28 rounded border border-gray-200 object-cover dark:border-gray-700"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded border border-dashed border-gray-300 text-center text-xs text-gray-400 dark:border-gray-700">
                {book.cover.available ? 'Not made yet' : 'No cover art'}
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-1 text-xs text-gray-600 dark:text-gray-400">
              <p className="font-medium text-gray-800 dark:text-gray-200">Audiobook cover</p>
              <p>
                Your book cover, centred whole on a soft extension of itself so it fits the square 2400 × 2400 px
                image audiobook stores take. Nothing is cropped or stretched.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  data-testid="audiobook-make-cover"
                  onClick={() => cover.mutate()}
                  disabled={cover.isPending || !book.cover.available}
                  className={secondary}
                >
                  {cover.isPending ? 'Making…' : book.cover.url ? 'Remake cover' : 'Make cover'}
                </button>
                {book.cover.url ? (
                  <a
                    data-testid="audiobook-cover-download"
                    href={`${book.cover.url}&download=${encodeURIComponent(`${book.title} - Audiobook Cover.jpg`)}`}
                    className={secondary}
                  >
                    Download JPEG
                  </a>
                ) : null}
              </div>
              {!book.cover.available ? <p>Choose cover art for the project first.</p> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="audiobook-build"
              onClick={() => build.mutate(undefined)}
              disabled={build.isPending || toBuild === 0 || dirty}
              title={dirty ? 'Save the narrator first' : undefined}
              className={primary}
            >
              {build.isPending
                ? 'Starting…'
                : toBuild === s.total
                  ? `Build the audiobook${costNote(book.cost.to_build_credits)}`
                  : toBuild > 0
                    ? `Build ${toBuild} recording${toBuild === 1 ? '' : 's'}${costNote(book.cost.to_build_credits)}`
                    : 'Everything is built'}
            </button>
            {dirty ? <span className="text-xs text-amber-700 dark:text-amber-400">Save the narrator first (above).</span> : null}
            <p data-testid="audiobook-summary" className="text-xs text-gray-600 dark:text-gray-400">
              {s.ready} of {s.total} recordings ready
              {s.ready ? ` · ${clock(s.duration_s)} · ${mb(s.size_bytes)}` : ''}
              {busy ? ` · ${s.building} narrating` : ''}
              {s.failed ? ` · ${s.failed} failed` : ''}
              {s.stale ? ` · ${s.stale} changed since recorded` : ''}
            </p>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="audiobook-price">
            {book.cost.own_account
              ? 'Narrated through your own ElevenLabs account: no Workbench credits. It uses characters from your ElevenLabs plan (a full novel is hundreds of thousands), so check your plan’s allowance first. '
              : `Narration is ${book.cost.credits_per_unit} credits per ${book.cost.unit_words.toLocaleString()} words of chapter text (the whole book: ${book.cost.total_credits} credits). Credits, the retail sample and previews are free. `}
            Changing the voice or delivery re-narrates every chapter.
          </p>
          {s.out_of_spec > 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {s.out_of_spec} recording{s.out_of_spec === 1 ? ' is' : 's are'} outside the loudness window — build{' '}
              {s.out_of_spec === 1 ? 'it' : 'them'} again.
            </p>
          ) : null}

          <ol data-testid="audiobook-recordings" className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
            {book.items.map((it) => (
              <li
                key={`${it.kind}-${it.chapter_number}`}
                data-testid={`recording-${it.kind}-${it.chapter_number}`}
                className="space-y-1.5 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">
                    {it.title}
                  </span>
                  <StatusBadge item={it} />
                  {it.status === 'ready' ? (
                    <span className="text-xs text-gray-500">
                      {clock(it.duration_s)} · {mb(it.size_bytes)}
                      {it.spec_ok === false ? ' · check level' : ''}
                    </span>
                  ) : it.kind === 'chapter' ? (
                    <span className="text-xs text-gray-400">{it.words.toLocaleString()} words</span>
                  ) : null}
                </div>
                {it.status === 'ready' && it.url ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <audio controls preload="none" src={it.url} className="h-8 max-w-full" data-testid={`player-${it.kind}-${it.chapter_number}`} />
                    <a href={it.download_url ?? it.url} className="text-xs text-brand-600 hover:underline" download>
                      Download
                    </a>
                  </div>
                ) : null}
                {it.error ? <p className="text-xs text-red-700 dark:text-red-400">{it.error}</p> : null}
                {it.id && it.status !== 'queued' && it.status !== 'building' && (it.status === 'failed' || it.status === 'ready') ? (
                  <button
                    type="button"
                    data-testid={`rebuild-${it.kind}-${it.chapter_number}`}
                    onClick={() => build.mutate([it.id!])}
                    disabled={build.isPending}
                    className="text-xs text-gray-500 underline hover:text-gray-800 dark:hover:text-gray-200"
                  >
                    {it.status === 'failed' ? 'Try again' : 'Narrate again'}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>

          <div data-testid="audiobook-sample" className="space-y-1.5 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">Retail sample</span>
              <StatusBadge item={book.sample} />
              {book.sample.status === 'ready' ? (
                <span className="text-xs text-gray-500">{clock(book.sample.duration_s)}</span>
              ) : null}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              The first three minutes of chapter one, faded out — what stores play before someone buys.
            </p>
            {book.sample.status === 'ready' && book.sample.url ? (
              <div className="flex flex-wrap items-center gap-3">
                <audio controls preload="none" src={book.sample.url} className="h-8 max-w-full" />
                <a href={book.sample.download_url ?? book.sample.url} className="text-xs text-brand-600 hover:underline" download>
                  Download
                </a>
              </div>
            ) : null}
            {book.sample.error ? <p className="text-xs text-red-700 dark:text-red-400">{book.sample.error}</p> : null}
            <button
              type="button"
              data-testid="audiobook-make-sample"
              onClick={() => sample.mutate()}
              disabled={sample.isPending || !book.sample.can_build || book.sample.status === 'queued' || book.sample.status === 'building'}
              className={secondary}
            >
              {book.sample.status === 'ready' ? 'Cut it again' : 'Cut the sample'}
            </button>
            {!book.sample.can_build ? (
              <p className="text-xs text-gray-400">Available once the first chapter is narrated.</p>
            ) : null}
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Every recording is mastered to the audiobook retail spec: MP3, 192 kbps constant bit rate, 44.1 kHz,
            mono; overall loudness −23 to −18 dB RMS, peaks no higher than −3 dB; room tone before the first word
            and after the last. The loudness shown is measured on the stored file.
          </p>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="audiobook-panel" className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 dark:border-gray-800 dark:bg-gray-900">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Audiobook</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          The book read aloud in an expressive American English voice, one recording per chapter.
        </p>
      </div>
      {children}
    </div>
  );
}
