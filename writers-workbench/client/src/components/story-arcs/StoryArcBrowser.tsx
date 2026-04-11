import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { StoryArc } from '../../types/database';

export default function StoryArcBrowser() {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: arcs, isLoading, isError, error } = useQuery({
    queryKey: ['story-arcs', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('story_arcs_v2')
        .select('*')
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .order('name');
      if (error) throw error;
      return data as StoryArc[];
    },
    enabled: !!userId,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Story Arcs</h1>
        <span className="text-xs text-gray-400">{arcs?.length || 0} arcs available</span>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center dark:border-red-800 dark:bg-red-950">
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load story arcs: {error?.message || 'Unknown error'}</p>
        </div>
      ) : !arcs?.length ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-900">
          <p className="text-sm text-gray-500">No story arcs available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {arcs.map(arc => (
            <div
              key={arc.id}
              className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden"
            >
              <div
                onClick={() => setExpandedId(expandedId === arc.id ? null : arc.id)}
                className="cursor-pointer px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{arc.name}</h3>
                  <div className="flex items-center gap-2">
                    {arc.user_id ? (
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600 dark:bg-brand-950 dark:text-brand-400">Custom</span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">Public</span>
                    )}
                    <svg
                      className={`h-4 w-4 text-gray-400 transition-transform ${expandedId === arc.id ? 'rotate-180' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </div>
                </div>
                <p className="mt-1 text-xs text-gray-500 leading-relaxed">{arc.description}</p>
                {arc.discovery_question && (
                  <p className="mt-2 text-xs text-brand-600 dark:text-brand-400 italic">
                    Discovery: {arc.discovery_question}
                  </p>
                )}
              </div>

              {expandedId === arc.id && (
                <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                  <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Prompt Template</h4>
                  <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                    {arc.prompt_text}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
