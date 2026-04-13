import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';

interface ProvenancePanelProps {
  contentId: string;
}

interface ProvenanceSource {
  id: string;
  content_id: string;
  output_type: string;
  output_title: string;
  created_at: string;
  // Joined from content_index
  source_title: string | null;
  source_type: string | null;
  source_url: string | null;
  scraped_at: string | null;
}

export default function ProvenancePanel({ contentId }: ProvenancePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const { profile } = useUser();
  const userId = profile?.user_id;

  const { data: sources, isLoading } = useQuery({
    queryKey: ['provenance', contentId, userId],
    queryFn: async () => {
      // Join content_usage_v2 with content_index to get source details
      const { data, error } = await supabase
        .from('content_usage_v2')
        .select(`
          id,
          content_id,
          output_type,
          output_title,
          created_at,
          content_index (
            title,
            source_type,
            source_url,
            scraped_at
          )
        `)
        .eq('user_id', userId!)
        .or(`output_title.eq.${contentId},content_id.eq.${contentId}`);

      if (error) throw error;

      // Flatten the join
      return (data || []).map((row: Record<string, unknown>) => {
        const ci = row.content_index as Record<string, unknown> | null;
        return {
          id: row.id,
          content_id: row.content_id,
          output_type: row.output_type,
          output_title: row.output_title,
          created_at: row.created_at,
          source_title: ci?.title || null,
          source_type: ci?.source_type || null,
          source_url: ci?.source_url || null,
          scraped_at: ci?.scraped_at || null,
        } as ProvenanceSource;
      });
    },
    enabled: !!contentId && !!userId,
  });

  const hasData = sources && sources.length > 0;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
      >
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-3.032a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
          </svg>
          <span className="text-sm font-medium text-gray-900 dark:text-white">Sources</span>
          {hasData && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {sources.length}
            </span>
          )}
        </div>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          {isLoading ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">Loading sources...</div>
          ) : !hasData ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">No sources tracked</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {sources.map((src) => (
                <div key={src.id} className="flex items-start gap-3 px-4 py-2.5">
                  <SourceTypeIcon type={src.source_type} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
                      {src.source_title || 'Unknown source'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {src.source_type && (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          {src.source_type}
                        </span>
                      )}
                      {src.scraped_at && (
                        <span className="text-[10px] text-gray-400">
                          {new Date(src.scraped_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  {src.source_url && (
                    <a
                      href={src.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-brand-600 hover:text-brand-700"
                      title="Open source"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceTypeIcon({ type }: { type: string | null }) {
  const iconClass = 'h-4 w-4 mt-0.5 shrink-0 text-gray-400';
  switch (type) {
    case 'RSS':
    case 'rss':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12.75 19.5v-.75a7.5 7.5 0 00-7.5-7.5H4.5m0-6.75h.75c10.036 0 18.17 8.134 18.17 18.17v.58H18.75M4.5 4.5v.75A3.75 3.75 0 008.25 9h.75" />
        </svg>
      );
    case 'Reddit':
    case 'reddit':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
        </svg>
      );
    default:
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      );
  }
}
