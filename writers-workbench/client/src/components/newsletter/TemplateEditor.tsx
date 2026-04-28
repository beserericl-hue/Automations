/**
 * Newsletter Template editor (Templates Sprint — T3).
 *
 * One component handles both create (`/newsletter/templates/new`) and
 * edit (`/newsletter/templates/:id`) modes. Layout:
 *   - top: name + description + edition + is_default + active
 *   - middle (two columns):
 *       left  → HTML source <textarea> (monospace)
 *       right → live preview iframe via /preview endpoint
 *   - bottom: collapsible sample_data JSON editor
 *
 * Preview is debounced to avoid hammering the server on every keystroke.
 * For unsaved (new) templates we render the preview in-memory by POSTing
 * to the existing /preview endpoint of an *already saved* template — but
 * since /preview takes the persisted template's html, the preview iframe
 * stays empty until the user saves once. On the editor itself we offer a
 * "Render preview" button that the caller can hit any time.
 *
 * Sample data is a JSON document; we parse it on save and surface
 * parse errors inline so a typo doesn't 400 silently from the server.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import type { NewsletterEdition, NewsletterTemplate } from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface TemplateResponse { success: boolean; template: NewsletterTemplate }
interface PreviewResponse { success: boolean; html: string; warnings: string[] }

const STARTER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{{title}}</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;">
  <h1>{{lead.headline}}</h1>
  {{{lead.body_html}}}
  <p style="font-size:12px;color:#666;">
    Replace this with your branded HTML. Use {{double-stash}} for plain text and
    {{{triple-stash}}} for trusted HTML (e.g. lead.body_html, intro_html).
  </p>
</body>
</html>`;

const STARTER_SAMPLE_DATA = JSON.stringify(
  {
    title: 'Issue title',
    lead: {
      headline: 'Sample headline',
      body_html: '<p>Sample lead body. The AI pipeline replaces this at send time.</p>',
    },
  },
  null,
  2,
);

export default function TemplateEditor() {
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isCreate = !params.id || params.id === 'new';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editionId, setEditionId] = useState<string>('');
  const [isDefault, setIsDefault] = useState(false);
  const [active, setActive] = useState(true);
  const [html, setHtml] = useState<string>(isCreate ? STARTER_HTML : '');
  const [sampleDataText, setSampleDataText] = useState<string>(isCreate ? STARTER_SAMPLE_DATA : '{}');
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sampleDataError, setSampleDataError] = useState<string | null>(null);

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 60_000,
  });

  // Existing template (edit mode)
  const templateQuery = useQuery({
    queryKey: ['newsletter-template', params.id],
    queryFn: () => apiFetch<TemplateResponse>(`/api/newsletter/templates/${encodeURIComponent(params.id!)}`),
    enabled: !isCreate,
    staleTime: 0,
  });

  // Hydrate state from the loaded template once.
  const hydrated = useRef(false);
  useEffect(() => {
    if (isCreate || hydrated.current) return;
    const t = templateQuery.data?.template;
    if (!t) return;
    setName(t.name);
    setDescription(t.description ?? '');
    setEditionId(t.edition_id ?? '');
    setIsDefault(t.is_default);
    setActive(t.active);
    setHtml(t.html);
    setSampleDataText(JSON.stringify(t.sample_data ?? {}, null, 2));
    hydrated.current = true;
  }, [templateQuery.data, isCreate]);

  // Debounced preview render. Re-fires whenever html or sampleDataText
  // changes after a 500ms quiet window. For an unsaved template we
  // can't call /preview (it needs a saved row), so we skip in create mode
  // until first save.
  const sampleDataParsed = useMemo<{ value: Record<string, unknown> | null; error: string | null }>(() => {
    try {
      const v = JSON.parse(sampleDataText);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return { value: null, error: 'sample_data must be a JSON object' };
      }
      return { value: v as Record<string, unknown>, error: null };
    } catch (err) {
      return { value: null, error: (err as Error).message };
    }
  }, [sampleDataText]);
  useEffect(() => {
    setSampleDataError(sampleDataParsed.error);
  }, [sampleDataParsed.error]);

  async function runPreview() {
    if (isCreate) {
      setPreviewError('Save the template first, then Render preview will work.');
      return;
    }
    setPreviewError(null);
    try {
      const res = await apiFetch<PreviewResponse>(
        `/api/newsletter/templates/${encodeURIComponent(params.id!)}/preview`,
        { method: 'POST', body: JSON.stringify({ data: {} }) },
      );
      setPreviewHtml(res.html);
      setPreviewWarnings(res.warnings ?? []);
    } catch (err) {
      if (err instanceof ApiError) setPreviewError(`${err.code}: ${err.message}`);
      else setPreviewError('Unexpected preview error');
    }
  }

  // Auto-fire preview on mount in edit mode (after hydration).
  useEffect(() => {
    if (!isCreate && hydrated.current && templateQuery.data) {
      void runPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateQuery.data]);

  async function handleSave(stayOnPage: boolean) {
    setSaveError(null);
    if (sampleDataParsed.error) {
      setSaveError(`Fix sample_data JSON first: ${sampleDataParsed.error}`);
      return;
    }
    if (!name.trim() || !html.trim()) {
      setSaveError('Name and HTML are required.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        edition_id: editionId || null,
        html,
        sample_data: sampleDataParsed.value ?? {},
        is_default: isDefault,
        active,
      };
      let saved: NewsletterTemplate;
      if (isCreate) {
        const res = await apiFetch<TemplateResponse>('/api/newsletter/templates', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        saved = res.template;
      } else {
        const res = await apiFetch<TemplateResponse>(
          `/api/newsletter/templates/${encodeURIComponent(params.id!)}`,
          { method: 'PUT', body: JSON.stringify(body) },
        );
        saved = res.template;
      }
      await queryClient.invalidateQueries({ queryKey: ['newsletter-templates'] });
      if (isCreate || !stayOnPage) {
        navigate(`/newsletter/templates/${encodeURIComponent(saved.id)}`);
      } else {
        // Stay on edit page — re-fire preview to reflect saved html.
        await queryClient.invalidateQueries({ queryKey: ['newsletter-template', saved.id] });
        await runPreview();
      }
    } catch (err) {
      if (err instanceof ApiError) setSaveError(err.message || `Save failed (${err.status})`);
      else setSaveError('Unexpected error during save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div>
          <Link to="/newsletter/templates" className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">
            ← All templates
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {isCreate ? 'New template' : (name || 'Untitled template')}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runPreview()}
            disabled={isCreate || saving}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Render preview
          </button>
          <button
            onClick={() => handleSave(true)}
            disabled={saving}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {saveError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {saveError}
        </div>
      )}

      {/* Meta fields */}
      <div className="grid grid-cols-1 gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 md:grid-cols-2">
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-200">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            placeholder="The Workbench (default)"
          />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-200">Edition</span>
          <select
            value={editionId}
            onChange={(e) => setEditionId(e.target.value)}
            disabled={saving}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">(any edition)</option>
            {(editionsQuery.data?.editions ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.display_name} ({e.id})</option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="block font-medium text-gray-700 dark:text-gray-200">Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={saving}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            placeholder="What's special about this template?"
          />
        </label>
        <div className="flex items-center gap-6 text-sm md:col-span-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={saving} className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
            <span className="text-gray-700 dark:text-gray-200">Default for this edition</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={saving} className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
            <span className="text-gray-700 dark:text-gray-200">Active</span>
          </label>
        </div>
      </div>

      {/* HTML editor + preview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <header className="flex items-center justify-between border-b border-gray-100 px-4 py-2 dark:border-gray-800">
            <h2 className="text-sm font-medium">HTML source</h2>
            <span className="text-xs text-gray-400">Handlebars — {`{{x}}`} escapes, {`{{{x}}}`} trusts</span>
          </header>
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            disabled={saving}
            spellCheck={false}
            className="block min-h-[600px] w-full resize-y border-0 bg-transparent p-4 font-mono text-xs text-gray-900 focus:outline-none focus:ring-0 dark:text-gray-100"
            aria-label="Template HTML source"
          />
        </div>

        <div className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <header className="flex items-center justify-between border-b border-gray-100 px-4 py-2 dark:border-gray-800">
            <h2 className="text-sm font-medium">Preview</h2>
            <span className="text-xs text-gray-400">
              {isCreate ? 'Save first to enable preview' : 'Renders against sample_data'}
            </span>
          </header>
          {previewError && (
            <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
              {previewError}
            </div>
          )}
          {previewWarnings.length > 0 && (
            <div className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
              <strong>Warnings:</strong> {previewWarnings.join('; ')}
            </div>
          )}
          <iframe
            title="Template preview"
            sandbox=""
            srcDoc={previewHtml}
            className="block min-h-[600px] w-full border-0"
          />
        </div>
      </div>

      {/* Sample data */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <header className="border-b border-gray-100 px-4 py-2 dark:border-gray-800">
          <h2 className="text-sm font-medium">Sample data (JSON)</h2>
          <p className="text-xs text-gray-400">
            Used by the preview endpoint when the runtime data is missing fields. AI payload values override these at send time.
          </p>
        </header>
        <textarea
          value={sampleDataText}
          onChange={(e) => setSampleDataText(e.target.value)}
          disabled={saving}
          spellCheck={false}
          className="block min-h-[200px] w-full resize-y border-0 bg-transparent p-4 font-mono text-xs text-gray-900 focus:outline-none focus:ring-0 dark:text-gray-100"
          aria-label="Sample data JSON"
        />
        {sampleDataError && (
          <div role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            {sampleDataError}
          </div>
        )}
      </div>
    </div>
  );
}
