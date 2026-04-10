import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { WritingProject } from '../../types/database';

export default function OutlineList() {
  const { profile } = useUser();
  const userId = profile?.user_id;

  const { data: projects, isLoading } = useQuery({
    queryKey: ['outlines', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('*')
        .eq('user_id', userId!)
        .not('outline', 'is', null)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      // Filter out empty outlines ({})
      return (data as WritingProject[]).filter(p => p.outline && Object.keys(p.outline).length > 0);
    },
    enabled: !!userId,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Outlines</h1>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : !projects?.length ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-900">
          <p className="text-sm text-gray-500">No outlines yet. Use Eve or the chat to brainstorm a story.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(project => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm transition-all dark:border-gray-800 dark:bg-gray-900 dark:hover:border-brand-700"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{project.title}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    {project.genre_slug && <span className="capitalize">{project.genre_slug.replace(/-/g, ' ')}</span>}
                    {project.outline?.story_arc_name && <span>Arc: {project.outline.story_arc_name}</span>}
                    {project.outline?.chapters && <span>{project.outline.chapters.length} chapters outlined</span>}
                    {project.outline?.characters && <span>{project.outline.characters.length} characters</span>}
                  </div>
                  {project.outline?.premise && (
                    <p className="mt-2 text-xs text-gray-500 leading-relaxed line-clamp-2">{project.outline.premise}</p>
                  )}
                </div>
                <span className="text-xs text-gray-400 shrink-0">{new Date(project.updated_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {projects && projects.length > 0 && (
        <p className="text-xs text-gray-400">{projects.length} outline{projects.length !== 1 ? 's' : ''}</p>
      )}
    </div>
  );
}
