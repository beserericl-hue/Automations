import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { WritingProject } from '../../types/database';

export default function ProjectList() {
  const navigate = useNavigate();
  const { profile } = useUser();
  const userId = profile?.user_id;

  const { data: projects, isLoading, isError, error } = useQuery({
    queryKey: ['projects', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('*')
        .eq('user_id', userId!)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as WritingProject[];
    },
    enabled: !!userId,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Projects</h1>

      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading...</div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-red-600 dark:text-red-400">
            Failed to load projects: {error?.message || 'Unknown error'}
          </div>
        ) : !projects?.length ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No projects yet. Use the chat or Eve to brainstorm a story.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Title</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Genre</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Chapters</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {projects.map((project) => (
                <tr key={project.id} onClick={() => navigate(`/projects/${project.id}`)} className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors">
                  <td className="px-6 py-3">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{project.title}</span>
                    {project.outline?.story_arc_name && (
                      <span className="ml-2 text-xs text-gray-400">({project.outline.story_arc_name})</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.genre_slug || '—'}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.project_type}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.chapter_count}</td>
                  <td className="px-6 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      {project.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-400">
                    {new Date(project.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {projects && projects.length > 0 && (
        <p className="text-xs text-gray-400">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
      )}
    </div>
  );
}
