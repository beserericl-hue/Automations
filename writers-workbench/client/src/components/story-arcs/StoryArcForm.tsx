import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { StoryArc } from '../../types/database';

interface StoryArcFormProps {
  arc: StoryArc | null; // null = create
  onClose: () => void;
}

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

export default function StoryArcForm({ arc, onClose }: StoryArcFormProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();

  const [name, setName] = useState(arc?.name || '');
  const [description, setDescription] = useState(arc?.description || '');
  const [promptText, setPromptText] = useState(arc?.prompt_text || '');
  const [discoveryQuestion, setDiscoveryQuestion] = useState(arc?.discovery_question || '');
  const [error, setError] = useState('');

  const saveMutation = useMutation({
    mutationFn: async () => {
      const data = {
        user_id: userId!,
        name: name.trim(),
        description: description.trim(),
        prompt_text: promptText.trim(),
        discovery_question: discoveryQuestion.trim() || null,
        updated_at: new Date().toISOString(),
      };

      if (arc) {
        const { error } = await supabase
          .from('story_arcs_v2')
          .update(data)
          .eq('id', arc.id)
          .eq('user_id', userId!);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('story_arcs_v2')
          .insert(data);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['story-arcs'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to Story Arcs</button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {arc ? 'Edit Story Arc' : 'Create Custom Arc'}
        </h1>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className={inputClass}
            placeholder="e.g., Five-Act Tragedy"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description <span className="text-red-500">*</span>
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className={inputClass}
            placeholder="Brief description of this story arc structure..."
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Prompt Template <span className="text-red-500">*</span>
          </label>
          <textarea
            value={promptText}
            onChange={e => setPromptText(e.target.value)}
            rows={10}
            className={inputClass + ' font-mono text-xs'}
            placeholder="The prompt template used when brainstorming with this arc. Use [..] for placeholder fields..."
          />
          <p className="mt-1 text-xs text-gray-400">
            Use bracket placeholders like [genre], [premise], [themes] that will be filled in during brainstorming.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Discovery Question
          </label>
          <input
            value={discoveryQuestion}
            onChange={e => setDiscoveryQuestion(e.target.value)}
            className={inputClass}
            placeholder="Question Eve asks before brainstorming with this arc"
          />
          <p className="mt-1 text-xs text-gray-400">
            Optional. Eve will ask this question before starting a brainstorm session with this arc.
          </p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !name.trim() || !description.trim() || !promptText.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving...' : arc ? 'Update Arc' : 'Create Arc'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
