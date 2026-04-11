import { useState } from 'react';
import { useUser } from '../../contexts/UserContext';

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

export default function ExportDialog({ projectId, projectTitle, open, onClose }: ExportDialogProps) {
  const { profile } = useUser();
  const [pageSize, setPageSize] = useState('6x9');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleExport = async () => {
    setExporting(true);
    setError('');
    try {
      const response = await fetch('/api/export/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          page_size: pageSize,
          user_id: profile?.user_id,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Export failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectTitle.replace(/[^a-zA-Z0-9]/g, '_')}_KDP.docx`;
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
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">Export to Word</h2>
          <p className="mt-1 text-sm text-gray-500">Generate a KDP-formatted .docx for "{projectTitle}"</p>

          <div className="mt-4">
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
              {exporting ? 'Generating...' : 'Download .docx'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
