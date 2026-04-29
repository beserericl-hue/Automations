/**
 * Edition editor — handles both create (route /newsletter/editions/new) and
 * edit (route /newsletter/editions/:id). Single component because the form
 * shape is identical; the only difference is the slug field is locked once
 * the row exists (slug doubles as the FK target on sends/approvals/feeds).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import type { NewsletterEdition } from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface SaveResponse { success: boolean; edition: NewsletterEdition }

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface FormState {
  id: string;
  display_name: string;
  newsletter_name: string;
  subheader: string;
  genre: string;
  description: string;
  primary_color: string;
  paper_color: string;
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
      if (isEdit) {
        const payload = {
          display_name: form.display_name,
          newsletter_name: form.newsletter_name,
          subheader: form.subheader,
          genre: form.genre,
          description: form.description || null,
          primary_color: form.primary_color,
          paper_color: form.paper_color,
        };
        await apiFetch<SaveResponse>(`/api/newsletter/editions/${encodeURIComponent(routeId!)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<SaveResponse>('/api/newsletter/editions', {
          method: 'POST',
          body: JSON.stringify({
            id: form.id,
            display_name: form.display_name,
            newsletter_name: form.newsletter_name,
            subheader: form.subheader,
            genre: form.genre,
            description: form.description || null,
            primary_color: form.primary_color,
            paper_color: form.paper_color,
          }),
        });
      }
      await qc.invalidateQueries({ queryKey: ['newsletter-editions'] });
      navigate('/newsletter/editions');
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
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          {isEdit ? `Edit "${existing?.display_name}"` : 'New newsletter'}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          The slug becomes the edition_id used by templates, feeds, and sends. It can't be changed once created.
        </p>
      </header>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <Field label="Display name *" hint="Shown on the masthead. e.g. 'The Workbench'">
          <input
            type="text"
            value={form.display_name}
            onChange={(ev) => set('display_name', ev.target.value)}
            className={inputCls}
            maxLength={120}
            required
          />
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
          <input
            type="text"
            value={form.newsletter_name}
            onChange={(ev) => set('newsletter_name', ev.target.value)}
            className={inputCls}
            maxLength={200}
            required
          />
        </Field>

        <Field label="Subheader *" hint="Tagline below the masthead. e.g. 'Dispatches from the Machine Room'">
          <input
            type="text"
            value={form.subheader}
            onChange={(ev) => set('subheader', ev.target.value)}
            className={inputCls}
            maxLength={200}
            required
          />
        </Field>

        <Field label="Genre *" hint="Free-form category. Editorial signal for AI tone.">
          <input
            type="text"
            value={form.genre}
            onChange={(ev) => set('genre', ev.target.value)}
            className={inputCls}
            maxLength={60}
            required
          />
        </Field>

        <Field label="Description" hint="Optional. What this newsletter is about; not shown to subscribers.">
          <textarea
            value={form.description}
            onChange={(ev) => set('description', ev.target.value)}
            className={inputCls}
            maxLength={2000}
            rows={3}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Primary color" hint="Headlines, links, accents.">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.primary_color}
                onChange={(ev) => set('primary_color', ev.target.value)}
                className="h-9 w-12 rounded border border-gray-300 dark:border-gray-700"
                aria-label="primary color"
              />
              <input
                type="text"
                value={form.primary_color}
                onChange={(ev) => set('primary_color', ev.target.value)}
                className={`${inputCls} font-mono`}
                maxLength={7}
              />
            </div>
          </Field>
          <Field label="Paper color" hint="Card background.">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.paper_color}
                onChange={(ev) => set('paper_color', ev.target.value)}
                className="h-9 w-12 rounded border border-gray-300 dark:border-gray-700"
                aria-label="paper color"
              />
              <input
                type="text"
                value={form.paper_color}
                onChange={(ev) => set('paper_color', ev.target.value)}
                className={`${inputCls} font-mono`}
                maxLength={7}
              />
            </div>
          </Field>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create newsletter'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/newsletter/editions')}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </form>
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
