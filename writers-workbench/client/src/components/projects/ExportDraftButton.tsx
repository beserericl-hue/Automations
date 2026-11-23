/**
 * Export Draft: a hard copy of the outline or of the whole manuscript, as a Word document.
 *
 * Not a publishing export. The outline draft has the premise, characters, every chapter and every
 * chapter's outline. The manuscript draft lists the chapter titles, then every chapter in full,
 * whatever its status.
 */
import { useState } from 'react';
import { supabase } from '../../config/supabase';
import { useToast } from '../../contexts/ToastContext';

export type DraftPart = 'outline' | 'manuscript';

/** The file name the server sent, or a fallback. */
function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  return m ? m[1] : fallback;
}

export default function ExportDraftButton({ projectId, part }: { projectId: string; part: DraftPart }) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const what = part === 'outline' ? 'outline' : 'manuscript';

  const run = async () => {
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      const res = await fetch(`/api/export/project/${projectId}/draft/${part}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
        throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || 'Could not build the draft');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileNameOf(res.headers.get('Content-Disposition'), `${part}_draft.docx`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast(`The ${what} draft is downloading as a Word document.`, 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Could not build the draft', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid={`export-draft-${part}`}
      onClick={run}
      disabled={busy}
      title={
        part === 'outline'
          ? 'Download the complete outline and every chapter outline as a Word document'
          : 'Download the chapter titles and the complete manuscript as a Word document'
      }
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      {busy ? 'Building the document…' : 'Export Draft'}
    </button>
  );
}
