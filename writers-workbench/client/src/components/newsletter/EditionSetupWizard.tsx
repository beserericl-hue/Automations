/**
 * Edition Setup Wizard — runs immediately after creating a new edition.
 *
 * Three steps, each skippable:
 *   1. Add feeds — if the edition's genre has curated URLs in
 *      genre_config_v2, offer a one-click "Copy N feeds from <genre>"
 *      that hits POST /editions/:id/feeds/import-from-genre. If the
 *      genre has no feeds, fall through to the "open the full editor"
 *      link only.
 *   2. Confirm template — preview the active default for this edition;
 *      offer "Customize" (link to TemplateEditor) or "Use as-is".
 *   3. Add first subscriber — pre-fills with the user's own email so
 *      they can self-test the send flow end-to-end.
 *
 * Replaces the previous "create edition → drop on the list" dead-end.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../lib/api';
import { useUser } from '../../contexts/UserContext';
import HelpButton from './HelpButton';
import type {
  NewsletterEdition,
  NewsletterFeedSource,
  NewsletterTemplateListItem,
} from '../../types/database';

interface EditionsResponse { success: boolean; editions: NewsletterEdition[] }
interface FeedsResponse { success: boolean; feeds: NewsletterFeedSource[] }
interface TemplatesResponse { success: boolean; templates: NewsletterTemplateListItem[] }
interface PreviewResponse { success: boolean; html: string }

interface GenreSummary {
  genre_slug: string;
  genre_name: string;
  description: string | null;
  visibility: 'public' | 'private';
  feed_counts: { rss: number; sources: number; subreddits: number; total: number };
}
interface GenresResponse { success: boolean; genres: GenreSummary[] }
interface GenreImportResponse {
  success: boolean;
  genre: string;
  inserted: number;
  skipped_duplicate: number;
}

type Step = 'feeds' | 'template' | 'subscriber' | 'done';

export default function EditionSetupWizard() {
  const { id: editionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { profile } = useUser();
  const [step, setStep] = useState<Step>('feeds');

  const editionsQuery = useQuery({
    queryKey: ['newsletter-editions'],
    queryFn: () => apiFetch<EditionsResponse>('/api/newsletter/editions'),
    staleTime: 30_000,
  });
  const edition = editionsQuery.data?.editions.find((e) => e.id === editionId) ?? null;

  if (!editionId) return null;
  if (editionsQuery.isLoading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (!edition) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
        Newsletter not found.{' '}
        <Link to="/newsletter/editions" className="underline">My newsletters</Link>
      </div>
    );
  }

  const stepIdx = ['feeds', 'template', 'subscriber', 'done'].indexOf(step);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <Link to="/newsletter/editions" className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">← My newsletters</Link>
          <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Set up "{edition.display_name}"
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Three steps to a sendable newsletter. Skip any step and come back later.
          </p>
        </div>
        <HelpButton section="editions" />
      </header>

      {/* Stepper */}
      <ol className="flex items-center gap-2 text-xs">
        {(['Feeds', 'Template', 'Subscriber', 'Done'] as const).map((label, i) => (
          <li key={label} className={`flex items-center gap-2 rounded px-2 py-1 ${i === stepIdx ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : i < stepIdx ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-400'}`}>
            <span className="font-mono">{i + 1}</span>
            <span>{label}</span>
            {i < 3 && <span className="text-gray-300">→</span>}
          </li>
        ))}
      </ol>

      {step === 'feeds' && <FeedsStep editionId={editionId} editionGenre={edition.genre} onNext={() => setStep('template')} qc={qc} />}
      {step === 'template' && <TemplateStep editionId={editionId} onNext={() => setStep('subscriber')} />}
      {step === 'subscriber' && <SubscriberStep editionId={editionId} userEmail={profile?.email ?? null} userName={null} onNext={() => setStep('done')} qc={qc} />}
      {step === 'done' && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-6 text-sm dark:border-emerald-900/30 dark:bg-emerald-950/20">
          <h2 className="text-base font-semibold text-emerald-800 dark:text-emerald-300">All set</h2>
          <p className="mt-1 text-emerald-700 dark:text-emerald-200">
            Your newsletter is ready. Next: try a generation run to make sure the pipeline works end-to-end.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => navigate(`/newsletter/generate?edition=${encodeURIComponent(editionId)}`)}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Generate now →
            </button>
            <button
              type="button"
              onClick={() => navigate('/newsletter/editions')}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Back to my newsletters
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

interface StepProps { editionId: string; onNext: () => void; qc: ReturnType<typeof useQueryClient> }
interface FeedsStepProps extends StepProps { editionGenre: string }

function FeedsStep({ editionId, editionGenre, onNext, qc }: FeedsStepProps) {
  const feedsQuery = useQuery({
    queryKey: ['newsletter-feeds', editionId],
    queryFn: () => apiFetch<FeedsResponse>(`/api/newsletter/editions/${encodeURIComponent(editionId)}/feeds`),
    staleTime: 15_000,
  });
  const feeds = feedsQuery.data?.feeds ?? [];

  // Pull genre summaries so we can show "Copy N feeds from <genre>".
  const genresQuery = useQuery({
    queryKey: ['newsletter-genres'],
    queryFn: () => apiFetch<GenresResponse>('/api/genres'),
    staleTime: 60_000,
  });
  const matchedGenre = (genresQuery.data?.genres ?? []).find(
    (g) => g.genre_slug === editionGenre,
  ) ?? null;
  const totalGenreFeeds = matchedGenre?.feed_counts.total ?? 0;

  const [busy, setBusy] = useState(false);
  const [importBanner, setImportBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function importFromGenre() {
    if (!matchedGenre) return;
    setBusy(true);
    setError(null);
    setImportBanner(null);
    try {
      const r = await apiFetch<GenreImportResponse>(
        `/api/newsletter/editions/${encodeURIComponent(editionId)}/feeds/import-from-genre`,
        { method: 'POST', body: JSON.stringify({ genre_slug: matchedGenre.genre_slug }) },
      );
      setImportBanner(
        `Imported ${r.inserted} new feed${r.inserted === 1 ? '' : 's'} from ${matchedGenre.genre_name}. Skipped ${r.skipped_duplicate} duplicate.`,
      );
      await qc.invalidateQueries({ queryKey: ['newsletter-feeds', editionId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import feeds from genre');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <header>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">1. Add feeds</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Feeds are the RSS / Reddit / source URLs the cron worker polls every 30 minutes. Without feeds, the AI has no content to draft from.
        </p>
      </header>

      {feedsQuery.isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : (
        <>
          <div className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
            <strong>{feeds.length}</strong> feed{feeds.length === 1 ? '' : 's'} attached.
            {matchedGenre && totalGenreFeeds > 0 && (
              <button
                type="button"
                onClick={importFromGenre}
                disabled={busy}
                className="ml-3 rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy
                  ? 'Importing…'
                  : `Copy ${totalGenreFeeds} feed${totalGenreFeeds === 1 ? '' : 's'} from ${matchedGenre.genre_name}`}
              </button>
            )}
            {matchedGenre && totalGenreFeeds === 0 && (
              <span className="ml-3 text-xs text-gray-500 dark:text-gray-400">
                The "{matchedGenre.genre_name}" genre has no feeds configured yet.
              </span>
            )}
            {!matchedGenre && !genresQuery.isLoading && (
              <span className="ml-3 text-xs text-gray-500 dark:text-gray-400">
                No matching genre found. Add feeds manually below.
              </span>
            )}
          </div>

          {importBanner && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
              {importBanner}
              <button onClick={() => setImportBanner(null)} className="ml-2 underline">Dismiss</button>
            </div>
          )}

          <Link
            to={`/newsletter/editions/${encodeURIComponent(editionId)}/feeds`}
            className="inline-block text-sm text-brand-700 hover:underline dark:text-brand-300"
          >
            Open the full Feeds editor →
          </Link>

          {error && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">{error}</div>
          )}
        </>
      )}

      <div className="flex items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
        <button type="button" onClick={onNext} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Next: Template →</button>
        <button type="button" onClick={onNext} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">Skip</button>
      </div>
    </section>
  );
}

function TemplateStep({ editionId, onNext }: { editionId: string; onNext: () => void }) {
  const templatesQuery = useQuery({
    queryKey: ['newsletter-templates', editionId],
    queryFn: () => apiFetch<TemplatesResponse>(`/api/newsletter/templates?edition_id=${encodeURIComponent(editionId)}`),
    staleTime: 30_000,
  });
  const def = (templatesQuery.data?.templates ?? []).find((t) => t.is_default && t.active) ?? null;

  const previewQuery = useQuery({
    queryKey: ['newsletter-template-preview', def?.id],
    queryFn: () => apiFetch<PreviewResponse>(`/api/newsletter/templates/${encodeURIComponent(def!.id)}/preview`, { method: 'POST', body: JSON.stringify({ data: {} }) }),
    enabled: !!def?.id,
    staleTime: 60_000,
  });

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <header>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">2. Confirm template</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          This is what your subscribers will see. The AI fills in real headlines and stories at send time.
        </p>
      </header>

      {!def ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          No active default template for this edition yet. <Link to={`/newsletter/templates/new`} className="underline">Create one</Link> or skip — you can do it later.
        </div>
      ) : (
        <>
          <div className="text-sm text-gray-700 dark:text-gray-200">
            Default: <strong>{def.name}</strong>
          </div>
          <div className="rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
            <iframe
              title="Template preview"
              sandbox=""
              srcDoc={previewQuery.data?.html ?? ''}
              className="block h-[400px] w-full border-0"
            />
          </div>
          <Link to={`/newsletter/templates/${encodeURIComponent(def.id)}`} className="inline-block text-sm text-brand-700 hover:underline dark:text-brand-300">
            Customize this template →
          </Link>
        </>
      )}

      <div className="flex items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
        <button type="button" onClick={onNext} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Next: Subscriber →</button>
        <button type="button" onClick={onNext} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">Skip</button>
      </div>
    </section>
  );
}

interface SubStepProps { editionId: string; userEmail: string | null; userName: string | null; onNext: () => void; qc: ReturnType<typeof useQueryClient> }

function SubscriberStep({ editionId, userEmail, userName, onNext, qc }: SubStepProps) {
  const [email, setEmail] = useState(userEmail ?? '');
  const [name, setName] = useState(userName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/newsletter/editions/${encodeURIComponent(editionId)}/subscribers`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), display_name: name.trim() || null, source: 'self-signup' }),
      });
      await qc.invalidateQueries({ queryKey: ['newsletter-subscribers', editionId] });
      setAdded(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <header>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">3. Add the first subscriber</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          We pre-filled this with your own email so you can self-test the send flow end-to-end.
        </p>
      </header>

      <form onSubmit={add} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
        <button type="submit" disabled={busy || added} className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? 'Adding…' : added ? 'Added ✓' : 'Add'}
        </button>
      </form>

      {error && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">{error}</div>
      )}

      <div className="flex items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
        <button type="button" onClick={onNext} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Done →</button>
        <button type="button" onClick={onNext} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400">Skip</button>
      </div>
    </section>
  );
}
