import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { StoryBibleEntry, WritingProject } from '../../types/database';

const ENTRY_TYPES = ['character', 'location', 'event', 'timeline', 'plot_thread', 'world_rule'] as const;

const typeLabels: Record<string, string> = {
  character: 'Characters',
  location: 'Locations',
  event: 'Events',
  timeline: 'Timeline',
  plot_thread: 'Plot Threads',
  world_rule: 'World Rules',
};

const typeIcons: Record<string, string> = {
  character: '\u{1F464}',
  location: '\u{1F3D4}',
  event: '\u{26A1}',
  timeline: '\u{23F3}',
  plot_thread: '\u{1F9F5}',
  world_rule: '\u{1F30D}',
};

export default function StoryBiblePanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useUser();
  const userId = profile?.user_id;

  const { data: project } = useQuery({
    queryKey: ['project-detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('id, title')
        .eq('id', id!)
        .eq('user_id', userId!)
        .single();
      if (error) throw error;
      return data as Pick<WritingProject, 'id' | 'title'>;
    },
    enabled: !!id && !!userId,
  });

  const { data: entries, isLoading } = useQuery({
    queryKey: ['story-bible', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('story_bible_v2')
        .select('*')
        .eq('project_id', id!)
        .eq('user_id', userId!)
        .order('entry_type')
        .order('name');
      if (error) throw error;
      return data as StoryBibleEntry[];
    },
    enabled: !!id && !!userId,
  });

  // Group entries by type
  const grouped = ENTRY_TYPES.reduce((acc, type) => {
    acc[type] = entries?.filter(e => e.entry_type === type) || [];
    return acc;
  }, {} as Record<string, StoryBibleEntry[]>);

  return (
    <div className="space-y-6">
      <div>
        <button onClick={() => navigate(`/projects/${id}`)} className="text-xs text-gray-400 hover:text-gray-600 mb-1">&larr; Back to {project?.title || 'Project'}</button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Story Bible</h1>
        {project && <p className="mt-1 text-sm text-gray-500">{project.title}</p>}
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : !entries?.length ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-900">
          <p className="text-sm text-gray-500">No story bible entries yet.</p>
          <p className="mt-1 text-xs text-gray-400">Write chapters to automatically build the story bible, or use Eve to manage entries.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {ENTRY_TYPES.map(type => {
            const typeEntries = grouped[type];
            if (!typeEntries.length) return null;
            return (
              <div key={type} className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                    {typeIcons[type]} {typeLabels[type]} ({typeEntries.length})
                  </h2>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {typeEntries.map(entry => (
                    <div key={entry.id} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{entry.name}</span>
                        {entry.chapter_introduced != null && (
                          <span className="text-xs text-gray-400">
                            Introduced Ch. {entry.chapter_introduced}
                            {entry.last_chapter_seen != null && entry.last_chapter_seen !== entry.chapter_introduced
                              ? ` \u2013 Last seen Ch. ${entry.last_chapter_seen}`
                              : ''}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-gray-500 leading-relaxed">{entry.description}</p>
                      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {Object.entries(entry.metadata).map(([key, val]) => (
                            <span key={key} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                              {key}: {String(val)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
