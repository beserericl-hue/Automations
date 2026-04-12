import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import type { PublishedContent } from '../../types/database';

interface ContentListProps {
  contentType: 'short_story' | 'blog_post' | 'newsletter' | 'chapter';
  title: string;
}

type SortField = 'updated_at' | 'title' | 'status';

export default function ContentList({ contentType, title }: ContentListProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const [sortField, setSortField] = useState<SortField>('updated_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data: items, isLoading, isError, error } = useQuery({
    queryKey: ['content-list', contentType, userId, sortField, sortAsc, statusFilter],
    queryFn: async () => {
      let query = supabase
        .from('published_content_v2')
        .select('*')
        .eq('user_id', userId!)
        .eq('content_type', contentType)
        .is('deleted_at', null)
        .order(sortField, { ascending: sortAsc });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as PublishedContent[];
    },
    enabled: !!userId,
  });

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortIndicator = (field: SortField) => {
    if (field !== sortField) return null;
    return sortAsc ? ' \u2191' : ' \u2193';
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h1>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="approved">Approved</option>
            <option value="published">Published</option>
            <option value="rejected">Rejected</option>
            <option value="scheduled">Scheduled</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading...</div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-red-600 dark:text-red-400">
            Failed to load {title.toLowerCase()}: {error?.message || 'Unknown error'}
          </div>
        ) : !items?.length ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No {title.toLowerCase()} found.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                <th
                  onClick={() => handleSort('title')}
                  className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Title{sortIndicator('title')}
                </th>
                <th
                  onClick={() => handleSort('status')}
                  className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Status{sortIndicator('status')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Genre
                </th>
                <th
                  onClick={() => handleSort('updated_at')}
                  className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  Updated{sortIndicator('updated_at')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((item) => (
                <ContentRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Count */}
      {items && items.length > 0 && (
        <p className="text-xs text-gray-400">{items.length} item{items.length !== 1 ? 's' : ''}</p>
      )}
    </div>
  );
}

function ContentRow({ item }: { item: PublishedContent }) {
  const navigate = useNavigate();
  const statusColors: Record<string, string> = {
    published: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    draft: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    rejected: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    scheduled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  };

  return (
    <tr
      onClick={() => navigate(`/content/${item.id}`)}
      className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
    >
      <td className="px-6 py-3">
        <span className="text-sm font-medium text-gray-900 dark:text-white">{item.title}</span>
        {item.chapter_number != null && (
          <span className="ml-2 text-xs text-gray-400">Ch. {item.chapter_number}</span>
        )}
      </td>
      <td className="px-6 py-3">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[item.status] || ''}`}>
          {item.status}
        </span>
      </td>
      <td className="px-6 py-3 text-sm text-gray-500">{item.genre_slug || '—'}</td>
      <td className="px-6 py-3 text-sm text-gray-400">
        {new Date(item.updated_at).toLocaleDateString()}
      </td>
    </tr>
  );
}
