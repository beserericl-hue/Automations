/**
 * Import Draft: bring an editor's Word file back into the project, chapter by chapter.
 *
 * Chapters are matched by number and the book divisions are left alone. A draft chapter is replaced;
 * an approved or published one is kept in version history and the edited text becomes the newer
 * version (the chapter goes back to draft). Chapters the project lacks are added. A Q/A run follows
 * for every imported chapter. Nothing changes until the author has seen the preview and confirmed.
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useToast } from '../../contexts/ToastContext';

interface PlanItem {
  chapter_number: number;
  title: string;
  words: number;
  action: 'replace' | 'new_version' | 'add';
  status: string | null;
  existing_words: number;
  has_blocks: boolean;
}
interface Preview {
  items: PlanItem[];
  counts: { replace: number; new_version: number; add: number; untouched: number };
  qa_cost_each: number;
  qa_cost_total: number;
  credits_remaining: number | null;
}
interface Applied {
  imported: number;
  failed: number;
  qa_started: number;
  qa_failed: number;
  results: Array<PlanItem & { error?: string; qa_error?: string }>;
}

const labelOf = (n: number) => (n === 0 ? 'Prologue' : n === 999 ? 'Epilogue' : `Chapter ${n}`);
const ACTION: Record<PlanItem['action'], string> = {
  replace: 'Replace draft',
  new_version: 'Keep old, add new version',
  add: 'Add chapter',
};

async function post<T>(path: string, file: File, runQa?: boolean): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const form = new FormData();
  form.append('file', file);
  if (runQa !== undefined) form.append('run_qa', String(runQa));
  const res = await fetch(path, { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } | string; message?: string };
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || body.message || 'The import failed');
  return body.data as T;
}

export default function ImportDraftButton({ projectId }: { projectId: string }) {
  const { addToast } = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const [runQa, setRunQa] = useState(true);
  const [error, setError] = useState('');

  const close = () => {
    setFile(null);
    setPreview(null);
    setApplied(null);
    setError('');
    setBusy(null);
    if (input.current) input.current.value = '';
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setApplied(null);
    setError('');
    setBusy('reading');
    try {
      setPreview(await post<Preview>(`/api/draft-import/project/${projectId}/preview`, f));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file) return;
    setBusy('importing');
    setError('');
    try {
      const out = await post<Applied>(`/api/draft-import/project/${projectId}/apply`, file, runQa);
      setApplied(out);
      setPreview(null);
      await qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(projectId) });
      addToast(`Imported ${out.imported} chapter${out.imported === 1 ? '' : 's'}.`, out.failed ? 'error' : 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed');
    } finally {
      setBusy(null);
    }
  };

  const open = file !== null || busy !== null || error !== '';
  const short = preview && preview.credits_remaining != null && runQa && preview.credits_remaining < preview.qa_cost_total;
  const btn =
    'rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        data-testid="import-draft-file"
        className="hidden"
        onChange={(e) => void choose(e.target.files?.[0])}
      />
      <button type="button" data-testid="import-draft" onClick={() => input.current?.click()} className={btn} title="Bring an edited Word file back in, chapter by chapter">
        Import Draft
      </button>
      {open && (
        <div role="dialog" aria-label="Import draft" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Import edited draft{file ? `: ${file.name}` : ''}</h2>

            {busy === 'reading' && <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Reading the file…</p>}
            {error && (
              <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                {error}
              </p>
            )}

            {preview && (
              <div className="mt-3 flex min-h-0 flex-1 flex-col">
                <p data-testid="import-draft-summary" className="text-sm text-gray-700 dark:text-gray-300">
                  {preview.items.length} chapters in the file: {preview.counts.replace} draft{preview.counts.replace === 1 ? '' : 's'} replaced,{' '}
                  {preview.counts.new_version} approved or published kept in history with the new text as a newer version, {preview.counts.add} added.{' '}
                  {preview.counts.untouched} chapters in the project are not in the file and stay as they are. Book divisions are not changed.
                </p>
                <ul className="mt-3 min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 text-xs dark:divide-gray-800 dark:border-gray-700">
                  {preview.items.map((i) => (
                    <li key={i.chapter_number} className="flex items-start justify-between gap-3 px-3 py-1.5">
                      <span className="min-w-0 text-gray-800 dark:text-gray-200">
                        <span className="font-medium">{labelOf(i.chapter_number)}</span>
                        {i.title ? `: ${i.title}` : ''}
                        {i.has_blocks && <span className="block text-amber-700 dark:text-amber-400">Has formatted blocks (letters or poems) that Word cannot carry back; they become plain paragraphs. The old text stays in history.</span>}
                      </span>
                      <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {ACTION[i.action]}
                        {i.status && i.status !== 'draft' ? ` (${i.status})` : ''} · {i.words.toLocaleString()} words
                      </span>
                    </li>
                  ))}
                </ul>
                <label className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" data-testid="import-draft-qa" checked={runQa} onChange={(e) => setRunQa(e.target.checked)} />
                  Run Q/A on every imported chapter ({preview.items.length} × {preview.qa_cost_each} = {preview.qa_cost_total} credits)
                </label>
                {short && <p className="mt-1 text-xs text-red-600">You have {preview.credits_remaining} credits, not enough for the Q/A. Untick it or add credits.</p>}
              </div>
            )}

            {applied && (
              <div data-testid="import-draft-done" className="mt-3 min-h-0 flex-1 overflow-y-auto text-sm text-gray-700 dark:text-gray-300">
                <p>
                  Imported {applied.imported} chapters. Q/A started for {applied.qa_started}; results appear in the QA column as each finishes.
                </p>
                {applied.failed > 0 && <p className="mt-2 text-red-600">{applied.failed} chapters failed:</p>}
                <ul className="list-disc pl-5 text-xs">
                  {applied.results.filter((r) => r.error).map((r) => (
                    <li key={r.chapter_number}>
                      {labelOf(r.chapter_number)}: {r.error}
                    </li>
                  ))}
                  {applied.results.filter((r) => r.qa_error).map((r) => (
                    <li key={`q${r.chapter_number}`}>
                      {labelOf(r.chapter_number)}: imported, but Q/A did not start ({r.qa_error}). Run it from the chapter.
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={close} disabled={busy === 'importing'} className={btn}>
                {applied ? 'Close' : 'Cancel'}
              </button>
              {preview && (
                <button
                  type="button"
                  data-testid="import-draft-apply"
                  onClick={() => void apply()}
                  disabled={busy !== null || Boolean(short)}
                  className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
                >
                  {busy === 'importing' ? 'Importing…' : `Import ${preview.items.length} chapters`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
