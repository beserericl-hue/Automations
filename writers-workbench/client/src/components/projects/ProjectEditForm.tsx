import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { WritingProject, GenreConfig } from '../../types/database';

interface ProjectEditFormProps {
  project: WritingProject;
  onClose: () => void;
}

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

const PROJECT_STATUSES = ['planning', 'in_progress', 'complete', 'on_hold', 'abandoned'] as const;
const PROJECT_TYPES = ['book', 'novella', 'short_story_collection', 'serial'] as const;

export default function ProjectEditForm({ project, onClose }: ProjectEditFormProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(project.title);
  const [genreSlug, setGenreSlug] = useState(project.genre_slug || '');
  const [status, setStatus] = useState(project.status);
  const [projectType, setProjectType] = useState(project.project_type);
  const [error, setError] = useState('');

  // Load genres for dropdown
  const { data: genres } = useQuery({
    queryKey: ['genres-dropdown', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('genre_config_v2')
        .select('genre_slug, genre_name, user_id')
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .eq('active', true)
        .order('genre_name');
      if (error) throw error;
      return data as Pick<GenreConfig, 'genre_slug' | 'genre_name' | 'user_id'>[];
    },
    enabled: !!userId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('writing_projects_v2')
        .update({
          title: title.trim(),
          genre_slug: genreSlug || null,
          status,
          project_type: projectType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', project.id)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-detail', project.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['sidebar-projects'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900 space-y-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Edit Project</h3>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Title <span className="text-red-500">*</span>
        </label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className={inputClass}
          placeholder="Project title"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Genre</label>
        <select
          value={genreSlug}
          onChange={e => setGenreSlug(e.target.value)}
          className={inputClass}
        >
          <option value="">No genre</option>
          {genres?.map(g => (
            <option key={g.genre_slug} value={g.genre_slug}>
              {g.genre_name} {g.user_id ? '(Custom)' : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          className={inputClass}
        >
          {PROJECT_STATUSES.map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project Type</label>
        <select
          value={projectType}
          onChange={e => setProjectType(e.target.value)}
          className={inputClass}
        >
          {PROJECT_TYPES.map(t => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !title.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
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
