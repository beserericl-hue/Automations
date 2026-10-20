import { useState } from 'react';
import { supabase } from '../../config/supabase';

const PAGE_SIZES = [
  { value: '5x8', label: '5 x 8 in', note: 'Compact fiction' },
  { value: '5.06x7.81', label: '5.06 x 7.81 in', note: 'Digest' },
  { value: '5.25x8', label: '5.25 x 8 in', note: 'Standard paperback' },
  { value: '5.5x8.5', label: '5.5 x 8.5 in', note: 'Popular fiction' },
  { value: '6x9', label: '6 x 9 in', note: 'Standard (default)' },
  { value: '6.14x9.21', label: '6.14 x 9.21 in', note: 'Royal' },
  { value: '6.69x9.61', label: '6.69 x 9.61 in', note: 'Crown quarto' },
  { value: '7x10', label: '7 x 10 in', note: 'Technical' },
  { value: '7.44x9.69', label: '7.44 x 9.69 in', note: 'Wide reference' },
  { value: '7.5x9.25', label: '7.5 x 9.25 in', note: 'Textbook' },
  { value: '8x10', label: '8 x 10 in', note: 'Large format' },
  { value: '8.25x11', label: '8.25 x 11 in', note: 'Full-size reference' },
  { value: '8.25x6', label: '8.25 x 6 in', note: 'Landscape' },
  { value: '8.25x8.25', label: '8.25 x 8.25 in', note: 'Square' },
  { value: '8.27x11.69', label: '8.27 x 11.69 in', note: 'A4' },
  { value: '8.5x11', label: '8.5 x 11 in', note: 'US Letter' },
  { value: '8.5x8.5', label: '8.5 x 8.5 in', note: 'Large square' },
];

interface ExportDialogProps {
  projectId: string;
  projectTitle: string;
  open: boolean;
  onClose: () => void;
}

// Two exports with genuinely different jobs, which is why they are one dialog with a format switch
// rather than two buttons that look alike:
//   .docx  — the KDP print deliverable. Approved chapters only; shipping a draft to a printer is a
//            mistake, so the server enforces that.
//   .epub  — the PRE-PUBLISH read. The point is to put the manuscript on a Kindle and read it as a
//            reader would BEFORE deciding to approve it, so it includes drafts by default and marks
//            them in the text. Restricting it to approved chapters would make it useless at exactly
//            the moment it exists for.
type ExportFormat = 'docx' | 'epub';

export default function ExportDialog({ projectId, projectTitle, open, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('docx');
  // The byline, and dc:creator. Books files a book with no creator under "Unknown Author", and the
  // composed cover has nowhere to put a name. Pre-filled from the account, editable because a pen
  // name is not the name on the account.
  const [authorName, setAuthorName] = useState('');
  const [pageSize, setPageSize] = useState('6x9');
  const [onlyApproved, setOnlyApproved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      // Get the current session JWT for authenticated request
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const response = await fetch(`/api/export/${format}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(
          format === 'docx'
            ? { project_id: projectId, page_size: pageSize }
            : {
                project_id: projectId,
                only_approved: onlyApproved,
                mark_drafts: true,
                ...(authorName.trim() ? { author: authorName.trim() } : {}),
              },
        ),
      });

      if (!response.ok) {
        const data = await response.json();
        // data.error may be a string or an object { code, message }
        const errMsg = typeof data.error === 'string'
          ? data.error
          : data.error?.message || data.message || 'Export failed';
        throw new Error(errMsg);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = projectTitle.replace(/[^a-zA-Z0-9]/g, '_');
      a.download = format === 'docx' ? `${safe}_KDP.docx` : `${safe}.epub`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900" onClick={e => e.stopPropagation()}>
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">Export "{projectTitle}"</h2>
          <p className="mt-1 text-sm text-gray-500">
            {format === 'docx'
              ? 'A KDP-formatted .docx for print. Approved chapters only.'
              : 'An .epub with your cover art, title and byline — to read on a Kindle or in Books before you approve.'}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {([
              { id: 'docx', label: 'Word (.docx)', note: 'For KDP print' },
              { id: 'epub', label: 'ePub', note: 'Read it as a book' },
            ] as const).map((f) => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                  format === f.id
                    ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                <span className="block font-medium">{f.label}</span>
                <span className="block text-xs opacity-70">{f.note}</span>
              </button>
            ))}
          </div>

          <div className={`mt-4 ${format === 'docx' ? '' : 'hidden'}`}>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Page Size</label>
            <select
              value={pageSize}
              onChange={e => setPageSize(e.target.value)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            >
              {PAGE_SIZES.map(s => (
                <option key={s.value} value={s.value}>{s.label} — {s.note}</option>
              ))}
            </select>
          </div>

          {format === 'epub' && (
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Author
              </label>
              <input
                type="text"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                placeholder="Your name as it should appear on the cover"
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
              <p className="mt-1 text-xs text-gray-500">
                Printed on the cover and filed under this name in your library. Leave blank to use
                your account name.
              </p>
            </div>
          )}

          {format === 'epub' && (
            <label className="mt-4 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={onlyApproved}
                onChange={(e) => setOnlyApproved(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Approved chapters only
                <span className="block text-xs text-gray-500">
                  Off by default — unapproved chapters are included and marked "Draft" in the text, so
                  you can read the whole book before approving any of it.
                </span>
              </span>
            </label>
          )}

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <div className="mt-6 flex justify-end gap-3">
            <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400">
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {exporting ? 'Generating...' : format === 'docx' ? 'Download .docx' : 'Download .epub'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
