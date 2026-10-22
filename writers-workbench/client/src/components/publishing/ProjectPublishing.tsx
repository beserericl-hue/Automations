/**
 * The Publish page for one project — a thin wrapper that resolves the route and the user, so the
 * panel itself stays about publishing rather than about routing.
 */

import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import PublishingPanel from './PublishingPanel';

export default function ProjectPublishing() {
  const { id } = useParams<{ id: string }>();
  const { profile } = useUser();

  const { data: project } = useQuery({
    queryKey: ['project-title', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('writing_projects_v2')
        .select('id, title')
        .eq('id', id!)
        .maybeSingle();
      return data as { id: string; title: string } | null;
    },
    enabled: Boolean(id),
  });

  if (!id) return null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/projects/${id}`}
          className="text-xs text-gray-500 hover:text-brand-600 dark:text-gray-400"
        >
          ← {project?.title || 'Project'}
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">Publish</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Trim size, volumes, the Amazon listing copy, and the files KDP asks for. Everything here is
          saved to the project.
        </p>
      </div>
      <PublishingPanel projectId={id} userId={profile?.user_id} />
    </div>
  );
}
