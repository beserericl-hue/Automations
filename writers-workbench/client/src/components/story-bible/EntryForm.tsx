import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { StoryBibleEntry } from '../../types/database';

const ENTRY_TYPES = ['character', 'location', 'event', 'timeline', 'plot_thread', 'world_rule'] as const;

const typeLabels: Record<string, string> = {
  character: 'Character',
  location: 'Location',
  event: 'Event',
  timeline: 'Timeline',
  plot_thread: 'Plot Thread',
  world_rule: 'World Rule',
};

interface EntryFormProps {
  projectId: string;
  entry: StoryBibleEntry | null; // null = create
  onClose: () => void;
}

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

export default function EntryForm({ projectId, entry, onClose }: EntryFormProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();

  const [entryType, setEntryType] = useState<string>(entry?.entry_type || 'character');
  const [name, setName] = useState(entry?.name || '');
  const [description, setDescription] = useState(entry?.description || '');
  const [chapterIntroduced, setChapterIntroduced] = useState(entry?.chapter_introduced?.toString() || '');
  const [metadataEntries, setMetadataEntries] = useState<{ key: string; value: string }[]>(
    entry?.metadata && Object.keys(entry.metadata).length > 0
      ? Object.entries(entry.metadata).map(([key, val]) => ({ key, value: String(val) }))
      : [{ key: '', value: '' }]
  );
  const [error, setError] = useState('');

  const addMetadata = () => setMetadataEntries([...metadataEntries, { key: '', value: '' }]);
  const removeMetadata = (i: number) => setMetadataEntries(metadataEntries.filter((_, idx) => idx !== i));
  const updateMetadata = (i: number, field: 'key' | 'value', val: string) => {
    const next = [...metadataEntries];
    next[i] = { ...next[i], [field]: val };
    setMetadataEntries(next);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const metadata: Record<string, string> = {};
      metadataEntries.forEach(({ key, value }) => {
        if (key.trim()) metadata[key.trim()] = value.trim();
      });

      const data = {
        user_id: userId!,
        project_id: projectId,
        entry_type: entryType,
        name: name.trim(),
        description: description.trim(),
        chapter_introduced: chapterIntroduced ? parseInt(chapterIntroduced, 10) : null,
        metadata,
        updated_at: new Date().toISOString(),
      };

      if (entry) {
        const { error } = await supabase
          .from('story_bible_v2')
          .update(data)
          .eq('id', entry.id)
          .eq('user_id', userId!);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('story_bible_v2')
          .insert(data);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['story-bible', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-bible', projectId] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900 space-y-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
        {entry ? 'Edit Entry' : 'Add Entry'}
      </h3>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Entry Type <span className="text-red-500">*</span>
        </label>
        <select
          value={entryType}
          onChange={e => setEntryType(e.target.value)}
          className={inputClass}
          disabled={!!entry}
        >
          {ENTRY_TYPES.map(t => (
            <option key={t} value={t}>{typeLabels[t]}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Name <span className="text-red-500">*</span>
        </label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          className={inputClass}
          placeholder="e.g., Marcus Chen"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Description <span className="text-red-500">*</span>
        </label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={4}
          className={inputClass}
          placeholder="Detailed description..."
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Chapter Introduced
        </label>
        <input
          type="number"
          value={chapterIntroduced}
          onChange={e => setChapterIntroduced(e.target.value)}
          className={inputClass}
          placeholder="e.g., 1"
          min={0}
        />
      </div>

      {/* Key-Value Metadata */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Metadata
        </label>
        <div className="space-y-2">
          {metadataEntries.map((entry, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={entry.key}
                onChange={e => updateMetadata(i, 'key', e.target.value)}
                className={inputClass + ' flex-1'}
                placeholder="Key (e.g., age)"
              />
              <input
                value={entry.value}
                onChange={e => updateMetadata(i, 'value', e.target.value)}
                className={inputClass + ' flex-1'}
                placeholder="Value (e.g., 34)"
              />
              <button
                onClick={() => removeMetadata(i)}
                className="text-xs text-red-500 hover:text-red-600 px-2"
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
          <button onClick={addMetadata} className="text-xs text-brand-600 hover:text-brand-700">
            + Add metadata
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !name.trim() || !description.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving...' : entry ? 'Update Entry' : 'Add Entry'}
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
