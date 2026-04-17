import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useState } from 'react';
import type { WritingProject } from '../../types/database';

export default function TrashView() {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const queryClient = useQueryClient();
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const { data: deletedProjects, isLoading } = useQuery({
    queryKey: ['trash-projects', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('*')
        .eq('user_id', userId!)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
      if (error) throw error;
      return data as WritingProject[];
    },
    enabled: !!userId,
  });

  const restoreMutation = useMutation({
    mutationFn: async (projectId: string) => {
      const { error } = await supabase
        .from('writing_projects_v2')
        .update({ deleted_at: null })
        .eq('id', projectId)
        .eq('user_id', userId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash-projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
      setRestoringId(null);
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Trash</h1>
      <p className="text-sm text-gray-500">Deleted projects are kept here. Restore them to bring them back.</p>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : !deletedProjects?.length ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-900">
          <p className="text-sm text-gray-500">Trash is empty.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {deletedProjects.map(project => (
            <div
              key={project.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
            >
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{project.title}</h3>
                <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
                  {project.genre_slug && <span>{project.genre_slug}</span>}
                  <span>{project.project_type}</span>
                  {project.deleted_at && (
                    <span>Deleted {new Date(project.deleted_at).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setRestoringId(project.id)}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!restoringId}
        onClose={() => setRestoringId(null)}
        onConfirm={() => { if (restoringId) restoreMutation.mutate(restoringId); }}
        title="Restore Project"
        message="Are you sure you want to restore this project? It will reappear in your project list."
        confirmLabel="Restore"
        variant="default"
        loading={restoreMutation.isPending}
      />
    </div>
  );
}
