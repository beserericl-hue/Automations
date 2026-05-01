/**
 * Edition editor — handles both create (route /newsletter/editions/new) and
 * edit (route /newsletter/editions/:id). Single component because the form
 * shape is identical; the only difference is the slug field is locked once
 * the row exists (slug doubles as the FK target on sends/approvals/feeds/
 * subscribers).
 *
 * Migration 017 adds:
 *   - stamp_url      (logo upload via base64 → /editions/:id/logo)
 *   - signature_name + signature_role  (overrides the seeded template's
 *     hardcoded "— Eric / Editor, The Workbench" signoff)
 *   - cadence + cadence_send_time      (recurring schedule — surfaced
 *     here, picked up by a separate cron in the next sprint)
 *   - newsletter_subscribers_v2        (recipient list, edited inline once
 *     the edition exists)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import HelpButton from './HelpButton';
import type {
  NewsletterEdition,
  NewsletterSubscriber,
} from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface SaveResponse { success: boolean; edition: NewsletterEdition }
interface SubscribersResponse { success: boolean; subscribers: NewsletterSubscriber[] }
interface LogoResponse { success: boolean; stamp_url: string; storage_path: string }

interface GenreSummary {
  genre_slug: string;
  genre_name: string;
  description: string | null;
  visibility: 'public' | 'private';
  feed_counts: { rss: number; sources: number; subreddits: number; total: number };
}
interface GenresResponse { success: boolean; genres: GenreSummary[] }

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CADENCE_OPTIONS: Array<{ value: NonNullable<NewsletterEdition['cadence']>; label: string }> = [
  { value: 'none',     label: 'None — only when I click Generate' },
  { value: 'daily',    label: 'Daily' },
  { value: 'weekly',   label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'monthly',  label: 'Monthly' },
];

interface FormState {
  id: string;
  display_name: string;
  newsletter_name: string;
  subheader: string;
  genre: string;
  description: string;
  primary_color: string;
  paper_color: string;
  signature_name: string;
  signature_role: string;
  cadence: NonNullable<NewsletterEdition['cadence']>;
  cadence_send_time: string;
}

const blank: FormState = {
  id: '',
  display_name: '',
  newsletter_name: '',
  subheader: '',
  genre: '',
  description: '',
  primary_color: '#14288c',
  paper_color: '#fbf8f2',
  signature_name: '',
  signature_role: '',
  cadence: 'none',
  cadence_send_time: '',
};

export default function EditionEditor() {
  const { id: routeId } = useParams<{ id: string }>();
  const isEdit = !!routeId;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [form, setForm] = useState<FormState>(blank);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 30_000,
    enabled: isEdit,
  });

  // Genre dropdown options. Public + own private genres, with feed counts.
  const genresQuery = useQuery({
    queryKey: ['newsletter-genres'],
    queryFn: () => apiFetch<GenresResponse>('/api/genres'),
    staleTime: 60_000,
  });
  const genres = genresQuery.data?.genres ?? [];

  const existing = useMemo(
    () => (isEdit ? editionsQuery.data?.editions.find((e) => e.id === routeId) ?? null : null),
    [isEdit, routeId, editionsQuery.data?.editions],
  );

  useEffect(() => {
    if (existing) {
      setForm({
        id: existing.id,
        display_name: existing.display_name,
        newsletter_name: existing.newsletter_name,
        subheader: existing.subheader,
        genre: existing.genre,
        description: existing.description ?? '',
        primary_color: existing.primary_color,
        paper_color: existing.paper_color,
        signature_name: existing.signature_name ?? '',
        signature_role: existing.signature_role ?? '',
        cadence: (existing.cadence ?? 'none') as FormState['cadence'],
        cadence_send_time: existing.cadence_send_time ?? '',
      });
    }
  }, [existing]);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  // Auto-suggest slug from display_name on create until the user types one.
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (isEdit || slugTouched) return;
    const auto = form.display_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    if (auto !== form.id) setForm((prev) => ({ ...prev, id: auto }));
  }, [form.display_name, isEdit, slugTouched, form.id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isEdit && !SLUG_RE.test(form.id)) {
      setError('Slug must be lowercase letters, digits, or hyphens (and must start with a letter or digit).');
      return;
    }
    if (!form.display_name.trim() || !form.newsletter_name.trim() || !form.subheader.trim() || !form.genre.trim()) {
      setError('Display name, newsletter name, subheader, and genre are required.');
      return;
    }

    setSaving(true);
    try {
      const fields: Record<string, unknown> = {
        display_name: form.display_name,
        newsletter_name: form.newsletter_name,
        subheader: form.subheader,
        genre: form.genre,
        description: form.description || null,
        primary_color: form.primary_color,
        paper_color: form.paper_color,
        signature_name: form.signature_name || null,
        signature_role: form.signature_role || null,
        cadence: form.cadence,
        cadence_send_time: form.cadence_send_time || null,
      };
      let saved: NewsletterEdition;
      if (isEdit) {
        const res = await apiFetch<SaveResponse>(`/api/newsletter/editions/${encodeURIComponent(routeId!)}`, {
          method: 'PUT',
          body: JSON.stringify(fields),
        });
        saved = res.edition;
      } else {
        const res = await apiFetch<SaveResponse>('/api/newsletter/editions', {
          method: 'POST',
          body: JSON.stringify({ id: form.id, ...fields }),
        });
        saved = res.edition;
      }
      await qc.invalidateQueries({ queryKey: ['newsletter-editions'] });
      // On create, kick the user into the onboarding wizard so feeds +
      // template + first subscriber flow logically. On edit, return to
      // the list (the inline subscribers panel below covers most edits).
      if (!isEdit) {
        navigate(`/newsletter/editions/${encodeURIComponent(saved.id)}/setup`);
      } else {
        navigate('/newsletter/editions');
      }
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Unexpected error');
    } finally {
      setSaving(false);
    }
  }

  if (isEdit && editionsQuery.isLoading) {
    return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  }
  if (isEdit && !editionsQuery.isLoading && !existing) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        Newsletter not found, or you don't have access.
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {isEdit ? `Edit "${existing?.display_name}"` : 'New newsletter'}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            The slug becomes the edition_id used by templates, feeds, and sends. It can't be changed once created.
          </p>
        </div>
        <HelpButton section="editions" />
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Identity ----------------------------------------------------- */}
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Identity</h2>

          <Field label="Display name *" hint="Shown on the masthead. e.g. 'The Workbench'">
            <input type="text" value={form.display_name} onChange={(ev) => set('display_name', ev.target.value)} className={inputCls} maxLength={120} required />
          </Field>

          <Field label="Slug *" hint="Lowercase, hyphens. Used as the edition_id everywhere.">
            <input
              type="text"
              value={form.id}
              onChange={(ev) => { set('id', ev.target.value.toLowerCase()); setSlugTouched(true); }}
              className={`${inputCls} font-mono ${isEdit ? 'cursor-not-allowed bg-gray-50 dark:bg-gray-800' : ''}`}
              maxLength={64}
              disabled={isEdit}
              required
            />
          </Field>

          <Field label="Newsletter name *" hint="Footer kicker text. e.g. 'A CourseworxAI Weekly'">
            <input type="text" value={form.newsletter_name} onChange={(ev) => set('newsletter_name', ev.target.value)} className={inputCls} maxLength={200} required />
          </Field>

          <Field label="Subheader *" hint="Tagline below the masthead. e.g. 'Dispatches from the Machine Room'">
            <input type="text" value={form.subheader} onChange={(ev) => set('subheader', ev.target.value)} className={inputCls} maxLength={200} required />
          </Field>

          <Field
            label="Genre *"
            hint={
              genresQuery.isLoading
                ? 'Loading genres…'
                : 'Pick from your configured genres. The genre\'s curated feeds can be auto-imported in the next step.'
            }
          >
            <select
              value={form.genre}
              onChange={(ev) => set('genre', ev.target.value)}
              className={inputCls}
              required
              disabled={genresQuery.isLoading}
            >
              <option value="" disabled>— Select a genre —</option>
              {genres.map((g) => (
                <option key={g.genre_slug} value={g.genre_slug}>
                  {g.genre_name} ({g.genre_slug})
                  {g.feed_counts.total > 0
                    ? ` — ${g.feed_counts.total} feed${g.feed_counts.total === 1 ? '' : 's'}`
                    : ''}
                  {g.visibility === 'private' ? ' · private' : ''}
                </option>
              ))}
              {/* Existing edition could have a stale genre value not in the
                  active list (deleted / inactive). Surface it as a fallback
                  option so the form doesn't visibly drop the value. */}
              {form.genre && !genres.some((g) => g.genre_slug === form.genre) && (
                <option value={form.genre}>{form.genre} (legacy)</option>
              )}
            </select>
          </Field>

          <Field label="Description" hint="Optional. What this newsletter is about; not shown to subscribers.">
            <textarea value={form.description} onChange={(ev) => set('description', ev.target.value)} className={inputCls} maxLength={2000} rows={3} />
          </Field>
        </section>

        {/* Branding ---------------------------------------------------- */}
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Branding</h2>

          {isEdit && existing ? (
            <LogoUploader
              edition={existing}
              onChanged={() => qc.invalidateQueries({ queryKey: ['newsletter-editions'] })}
            />
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">Save the newsletter first — you'll be able to upload a logo on the next step.</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Primary color" hint="Headlines, links, accents.">
              <ColorRow value={form.primary_color} onChange={(v) => set('primary_color', v)} />
            </Field>
            <Field label="Paper color" hint="Card background.">
              <ColorRow value={form.paper_color} onChange={(v) => set('paper_color', v)} />
            </Field>
          </div>
        </section>

        {/* Signoff ----------------------------------------------------- */}
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Signoff</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            These appear at the bottom of every send. Leave blank to use the template's defaults.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Signature name" hint="e.g. 'Eric'">
              <input type="text" value={form.signature_name} onChange={(ev) => set('signature_name', ev.target.value)} className={inputCls} maxLength={120} />
            </Field>
            <Field label="Signature role" hint="e.g. 'Editor, The Workbench'">
              <input type="text" value={form.signature_role} onChange={(ev) => set('signature_role', ev.target.value)} className={inputCls} maxLength={120} />
            </Field>
          </div>
        </section>

        {/* Cadence ----------------------------------------------------- */}
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Schedule</h2>
          <Field label="Cadence" hint="How often a draft should auto-generate. The send-day cron picks this up.">
            <select value={form.cadence} onChange={(ev) => set('cadence', ev.target.value as FormState['cadence'])} className={inputCls}>
              {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {form.cadence !== 'none' && (
            <Field label="Send time" hint="Free-form for now (e.g. '09:00 fri' for Fridays at 9 AM UTC).">
              <input type="text" value={form.cadence_send_time} onChange={(ev) => set('cadence_send_time', ev.target.value)} className={`${inputCls} font-mono`} maxLength={40} placeholder="09:00 fri" />
            </Field>
          )}
        </section>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create newsletter'}
          </button>
          <button type="button" onClick={() => navigate('/newsletter/editions')} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            Cancel
          </button>
        </div>
      </form>

      {/* Subscribers — inline section, shown only in edit mode. */}
      {isEdit && existing && (
        <SubscribersPanel editionId={existing.id} />
      )}
    </div>
  );
}

const inputCls =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</span>
      {hint && <span className="ml-2 text-xs text-gray-400">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={value} onChange={(ev) => onChange(ev.target.value)} className="h-9 w-12 rounded border border-gray-300 dark:border-gray-700" />
      <input type="text" value={value} onChange={(ev) => onChange(ev.target.value)} className={`${inputCls} font-mono`} maxLength={7} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogoUploader — file picker + preview + upload + remove
// ---------------------------------------------------------------------------

function LogoUploader({ edition, onChanged }: { edition: NewsletterEdition; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  const currentUrl = localUrl ?? edition.stamp_url ?? null;

  async function handlePick(file: File) {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('Please pick an image file (PNG, JPG, SVG, etc.).');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image is over 5 MB. Compress it first.');
      return;
    }
    setBusy(true);
    try {
      const base64 = await readAsBase64(file);
      const res = await apiFetch<LogoResponse>(`/api/newsletter/editions/${encodeURIComponent(edition.id)}/logo`, {
        method: 'POST',
        body: JSON.stringify({ base64, filename: file.name, content_type: file.type }),
      });
      setLocalUrl(res.stamp_url);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleRemove() {
    if (!confirm('Remove the logo from this newsletter? Future sends will use the template default.')) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/editions/${encodeURIComponent(edition.id)}/logo`, { method: 'DELETE' });
      setLocalUrl(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Field label="Logo / stamp" hint="Shown above the footer. ~84 px wide. PNG / SVG with transparent background work best.">
        <div className="mt-2 flex items-start gap-4">
          <div className="flex h-24 w-24 items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            {currentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={currentUrl} alt="Newsletter logo" className="max-h-full max-w-full" />
            ) : (
              <span className="text-center text-xs text-gray-400">No logo</span>
            )}
          </div>
          <div className="flex flex-col items-start gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(ev) => {
                const f = ev.target.files?.[0];
                if (f) void handlePick(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {busy ? 'Uploading…' : currentUrl ? 'Replace logo' : 'Upload logo'}
            </button>
            {currentUrl && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
              >
                Remove logo
              </button>
            )}
          </div>
        </div>
      </Field>
      {error && (
        <div role="alert" className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">{error}</div>
      )}
    </div>
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the "data:<mime>;base64," prefix
      const idx = result.indexOf(',');
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// SubscribersPanel — list + add + remove. Inline on the editor; the whole
// flow stays in one screen so users don't get lost.
// ---------------------------------------------------------------------------

interface CsvImportResponse {
  success: boolean;
  inserted: number;
  skipped_duplicate: number;
  invalid: number;
}

function SubscribersPanel({ editionId }: { editionId: string }) {
  const qc = useQueryClient();
  const subsQuery = useQuery({
    queryKey: ['newsletter-subscribers', editionId],
    queryFn: () => apiFetch<SubscribersResponse>(`/api/newsletter/editions/${encodeURIComponent(editionId)}/subscribers`),
    staleTime: 15_000,
  });
  const subs = subsQuery.data?.subscribers ?? [];

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // CSV import state
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [importBanner, setImportBanner] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function handleCsvPick(file: File) {
    setError(null);
    setImportBanner(null);
    if (file.size > 4 * 1024 * 1024) {
      setError('CSV file is over 4 MB. Split it into smaller files first.');
      return;
    }
    setImporting(true);
    try {
      const csv = await file.text();
      const res = await apiFetch<CsvImportResponse>(
        `/api/newsletter/editions/${encodeURIComponent(editionId)}/subscribers/import`,
        { method: 'POST', body: JSON.stringify({ csv, source: 'csv-import' }) },
      );
      setImportBanner(
        `Imported ${res.inserted} new ${res.inserted === 1 ? 'subscriber' : 'subscribers'}. ` +
        `Skipped ${res.skipped_duplicate} duplicate, ${res.invalid} invalid.`,
      );
      await qc.invalidateQueries({ queryKey: ['newsletter-subscribers', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'CSV import failed');
    } finally {
      setImporting(false);
      if (csvFileRef.current) csvFileRef.current.value = '';
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    setAdding(true);
    try {
      await apiFetch(`/api/newsletter/editions/${encodeURIComponent(editionId)}/subscribers`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), display_name: name.trim() || null }),
      });
      setEmail(''); setName('');
      await qc.invalidateQueries({ queryKey: ['newsletter-subscribers', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add subscriber');
    } finally {
      setAdding(false);
    }
  }

  async function handleStatus(s: NewsletterSubscriber, status: NewsletterSubscriber['status']) {
    setBusyId(s.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/subscribers/${encodeURIComponent(s.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      await qc.invalidateQueries({ queryKey: ['newsletter-subscribers', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(s: NewsletterSubscriber) {
    if (!confirm(`Remove ${s.email} from this newsletter?`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      await apiFetch(`/api/newsletter/subscribers/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['newsletter-subscribers', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Remove failed');
    } finally {
      setBusyId(null);
    }
  }

  const activeCount = subs.filter((s) => s.status === 'active').length;

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Subscribers</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {activeCount} active · {subs.length} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={csvFileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              if (f) void handleCsvPick(f);
            }}
          />
          <button
            type="button"
            onClick={() => csvFileRef.current?.click()}
            disabled={importing}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            title="Bulk import emails from a .csv (header: email[, display_name])"
          >
            {importing ? 'Importing…' : 'Import CSV'}
          </button>
        </div>
      </header>

      {importBanner && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
          {importBanner}
          <button onClick={() => setImportBanner(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <form onSubmit={handleAdd} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input type="email" required placeholder="someone@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        <input type="text" placeholder="Display name (optional)" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        <button type="submit" disabled={adding} className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>

      {error && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">{error}</div>
      )}

      {subsQuery.isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : subs.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 p-6 text-center text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No subscribers yet. Add yourself first to test the send flow end-to-end.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Subscribed</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.id} className="border-t border-gray-100 dark:border-gray-800">
                <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{s.email}</td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{s.display_name ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    s.status === 'active' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : s.status === 'unsubscribed' ? 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  }`}>{s.status}</span>
                </td>
                <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                  {new Date(s.subscribed_at).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {s.status !== 'active' && (
                      <button onClick={() => handleStatus(s, 'active')} disabled={busyId === s.id} className="text-xs font-medium text-emerald-700 hover:text-emerald-800 disabled:opacity-50 dark:text-emerald-300">Activate</button>
                    )}
                    {s.status === 'active' && (
                      <button onClick={() => handleStatus(s, 'unsubscribed')} disabled={busyId === s.id} className="text-xs font-medium text-gray-600 hover:text-gray-800 disabled:opacity-50 dark:text-gray-300">Unsubscribe</button>
                    )}
                    <button onClick={() => handleRemove(s)} disabled={busyId === s.id} className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400">Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
