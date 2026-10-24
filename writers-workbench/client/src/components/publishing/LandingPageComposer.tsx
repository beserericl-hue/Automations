/**
 * The book's sales landing page, as a script for GoHighLevel's "Build with AI".
 *
 * Nothing on this form is a place to type copy. The page is built from what the project already
 * holds: the listing copy, the approved bio, the cover, the author's photo, and a few history facts
 * the server picks from the book's research and checks against the sentence each one quotes. The
 * one input is a sales page the author likes, whose layout is followed and whose words are not.
 *
 * GHL's builder may still reword what it is given, so the last step is a check: paste the URL of
 * the page GHL published and every passage that changed is named.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiEnvelope } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';

interface Finding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  fix?: string;
}

interface CheckResult {
  ok: boolean;
  findings: Finding[];
  facts: Record<string, string | number | boolean>;
}

interface FactAudit {
  text: string;
  quote: string;
  report_id: string;
  report_topic: string;
}

interface SavedScript {
  id: string;
  created_at: string;
  sample_url: string | null;
  plan: { kind: string; cta: boolean }[];
  skipped: string[];
  warnings: string[];
  prompt: string;
  preview_html: string;
  facts_audit: FactAudit[];
  rejected_facts: { text: string; reasons: string[] }[];
  last_check?: { url: string; checked_at: string; result: CheckResult };
}

interface ReferencePhoto {
  id: string;
  title: string;
  license: string;
  url: string;
  credit: string;
}

interface LandingState {
  current: SavedScript | null;
  history: { id: string; created_at: string; sample_url: string | null; prompt: string }[];
  inputs: {
    missing: string[];
    author_photo_url: string | null;
    cover_url: string | null;
    volumes: number;
    research_reports: number;
    reference_photos: ReferencePhoto[];
  };
}

const SECTION_LABELS: Record<string, string> = {
  hero: 'Hero',
  story: 'The novel',
  proof: 'History',
  lineup: 'Volumes',
  offer: 'Pre-order form',
  author: 'Author',
  closing: 'Closing',
};

const inputClass =
  'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function LandingPageComposer({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [sampleUrl, setSampleUrl] = useState('');
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [publishedUrl, setPublishedUrl] = useState('');
  const queryKey = ['landing-page', projectId];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await apiFetch<ApiEnvelope<LandingState>>(`/api/landing-page/project/${projectId}`)).data!,
  });

  const generate = useMutation({
    mutationFn: async () =>
      apiFetch<ApiEnvelope<SavedScript>>(`/api/landing-page/project/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ sample_url: sampleUrl.trim() || null, reference_photo_ids: photoIds }),
      }),
    onSuccess: (res) => {
      // The response is the saved script. Show it now: waiting for the refetch leaves the old
      // script on screen under a button that already says it is done.
      queryClient.setQueryData<LandingState>(queryKey, (old) =>
        old && res.data
          ? {
              ...old,
              current: res.data,
              history: old.current
                ? [{ id: old.current.id, created_at: old.current.created_at, sample_url: old.current.sample_url, prompt: old.current.prompt }, ...old.history]
                : old.history,
            }
          : old,
      );
      queryClient.invalidateQueries({ queryKey });
      addToast('Landing page script saved', 'success');
    },
    onError: (err) => addToast((err as Error).message || 'Could not generate the script', 'error'),
  });

  const check = useMutation({
    mutationFn: async () =>
      apiFetch<ApiEnvelope<CheckResult>>(`/api/landing-page/project/${projectId}/check`, {
        method: 'POST',
        body: JSON.stringify({ url: publishedUrl.trim() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (err) => addToast((err as Error).message || 'Could not check the page', 'error'),
  });

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast('Copied', 'success');
    } catch {
      addToast('Copy failed; select the text and copy it by hand', 'error');
    }
  };

  const download = (text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'landing-page-script.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading || !data) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  const { current, inputs, history } = data;
  const lastCheck = current?.last_check;

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Landing page</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          A script for GoHighLevel's <strong>Build with AI</strong>, built from this project's listing copy, approved bio,
          cover, author photo and research. Nothing is written for it that the project does not already hold.
        </p>
      </div>

      {inputs.missing.length ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
          <p className="font-medium">Still needed before a page can be built:</p>
          <ul className="mt-1 list-disc pl-5">
            {inputs.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <label htmlFor="lp-sample" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Sample page URL <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            A sales page you like. Its section order and button placement are followed; none of its words are used.
            Ad-tracking parameters are removed before it is read.
          </p>
          <input
            id="lp-sample"
            value={sampleUrl}
            onChange={(e) => setSampleUrl(e.target.value)}
            className={inputClass}
            placeholder="https://…"
          />
        </div>

        <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
          {inputs.author_photo_url ? (
            <>
              <img src={inputs.author_photo_url} alt="Author photo" className="h-10 w-10 rounded-full object-cover" />
              <span>Author photo will be used beside the bio.</span>
            </>
          ) : (
            <span>
              No author photo.{' '}
              <Link to="/settings/author" className="text-brand-600 underline dark:text-brand-400">
                Add one in Author Profile
              </Link>{' '}
              to show it beside the bio.
            </span>
          )}
        </div>

        {inputs.reference_photos.length ? (
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Archival photographs</legend>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
              Left out unless you tick them. A real person's photograph on a sales page can read as an endorsement.
              Each one is credited on the page.
            </p>
            {inputs.reference_photos.map((p) => (
              <label key={p.id} className="flex items-start gap-2 py-1 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={photoIds.includes(p.id)}
                  onChange={(e) =>
                    setPhotoIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id)))
                  }
                />
                <img src={p.url} alt="" className="h-12 w-12 rounded object-cover" />
                <span>
                  {p.title}
                  <span className="block text-xs text-gray-500">{p.credit}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending || inputs.missing.length > 0}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {generate.isPending ? 'Building the script…' : current ? 'Generate a new script' : 'Generate the script'}
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Takes up to a minute. Reads {inputs.research_reports} research reports for the history section.
          </span>
        </div>
      </div>

      {current ? (
        <div className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Saved {when(current.created_at)}
            {current.sample_url ? <> · layout from {current.sample_url}</> : <> · default layout</>}
          </div>

          {current.warnings.length ? (
            <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
              {current.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}

          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Sections, in order</p>
            <ol className="mt-1 flex flex-wrap gap-2 text-xs">
              {current.plan.map((p, i) => (
                <li key={p.kind} className="rounded bg-gray-100 px-2 py-1 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {i + 1}. {SECTION_LABELS[p.kind] ?? p.kind}
                  {p.cta ? ' · button' : ''}
                </li>
              ))}
            </ol>
          </div>

          {current.skipped.length ? (
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">From the sample, left out</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-gray-600 dark:text-gray-400">
                {current.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">The script</p>
              <div className="flex gap-2">
                <button
                  onClick={() => copyText(current.prompt)}
                  className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Copy
                </button>
                <button
                  onClick={() => download(current.prompt)}
                  className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Download
                </button>
              </div>
            </div>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
              In GoHighLevel: Sites, then Build with AI. Paste this as the description
              {current.sample_url ? ', and give it the sample URL as its reference' : ''}.
            </p>
            <textarea
              readOnly
              value={current.prompt}
              rows={12}
              aria-label="Landing page script"
              className={`${inputClass} font-mono text-xs`}
            />
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
              Where each history fact comes from ({current.facts_audit.length})
            </summary>
            <ul className="mt-2 space-y-3">
              {current.facts_audit.map((f) => (
                <li key={f.text} className="text-sm">
                  <p className="text-gray-900 dark:text-white">{f.text}</p>
                  <p className="mt-1 border-l-2 border-gray-300 pl-2 text-xs italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
                    “{f.quote}”
                  </p>
                  <p className="text-xs text-gray-500">{f.report_topic}</p>
                </li>
              ))}
            </ul>
            {current.rejected_facts.length ? (
              <p className="mt-2 text-xs text-gray-500">
                {current.rejected_facts.length} proposed fact{current.rejected_facts.length === 1 ? '' : 's'} failed
                verification and {current.rejected_facts.length === 1 ? 'was' : 'were'} left out.
              </p>
            ) : null}
          </details>

          <details>
            <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">Preview</summary>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The page as intended. GHL will lay it out its own way; the words should be these.
            </p>
            <iframe
              title="Landing page preview"
              srcDoc={current.preview_html}
              sandbox=""
              className="mt-2 h-[600px] w-full rounded border border-gray-200 dark:border-gray-700"
            />
          </details>

          <div className="space-y-2 border-t border-gray-200 pt-4 dark:border-gray-700">
            <label htmlFor="lp-published" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Check the page GHL published
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Build with AI may reword what it is given. Paste the published page's URL to see every passage it changed.
            </p>
            <div className="flex gap-2">
              <input
                id="lp-published"
                value={publishedUrl}
                onChange={(e) => setPublishedUrl(e.target.value)}
                className={inputClass}
                placeholder="https://…"
              />
              <button
                onClick={() => check.mutate()}
                disabled={check.isPending || !publishedUrl.trim()}
                className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {check.isPending ? 'Checking…' : 'Check'}
              </button>
            </div>
            {lastCheck ? (
              <div className="text-sm" data-testid="landing-check-result">
                <p className={lastCheck.result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
                  {lastCheck.result.ok ? 'Matches the script' : 'Does not match the script'}
                  {typeof lastCheck.result.facts.verbatim_blocks === 'string'
                    ? ` · ${lastCheck.result.facts.verbatim_blocks} passages unchanged`
                    : ''}{' '}
                  <span className="text-xs text-gray-500">({when(lastCheck.checked_at)})</span>
                </p>
                <ul className="mt-1 space-y-1">
                  {lastCheck.result.findings.map((f, i) => (
                    <li key={i} className={f.severity === 'error' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-300'}>
                      {f.message}
                      {f.fix ? <span className="block text-xs text-gray-500">{f.fix}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {history.length ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
                Earlier scripts ({history.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
                    <span>
                      {when(h.created_at)} · {h.sample_url ?? 'default layout'}
                    </span>
                    <button onClick={() => copyText(h.prompt)} className="text-brand-600 underline dark:text-brand-400">
                      Copy
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
