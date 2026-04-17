import { useState, useEffect, useRef } from 'react';

interface CommandDialogProps {
  open: boolean;
  onClose: () => void;
  onSend: (notes: string) => void;
  title: string;
  description: string;
  placeholder?: string;
  sendLabel?: string;
  loading?: boolean;
}

export default function CommandDialog({
  open,
  onClose,
  onSend,
  title,
  description,
  placeholder = 'e.g. "Research the constitutional cases Lucia argues about so the facts are correct" or "Follow the outline explicitly"',
  sendLabel = 'Send',
  loading = false,
}: CommandDialogProps) {
  const [notes, setNotes] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setNotes('');
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSend(notes.trim());
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, notes, onClose, onSend]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        </div>

        <div className="px-5 py-4">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            Additional instructions for the AI (optional)
          </label>
          <textarea
            ref={textareaRef}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={placeholder}
            rows={4}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
          />
          <p className="mt-1 text-[10px] text-gray-400">
            Ctrl+Enter to send / Esc to cancel
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={() => onSend(notes.trim())}
            disabled={loading}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? 'Sending...' : sendLabel}
          </button>
          <button
            onClick={() => onSend('')}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Send without notes
          </button>
        </div>
      </div>
    </div>
  );
}
