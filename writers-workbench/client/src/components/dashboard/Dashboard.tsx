import { useNavigate } from 'react-router-dom';
import { useUser } from '../../contexts/UserContext';
import { useDashboardCounts, useRecentItems, type RecentItem } from '../../hooks/useDashboardData';

export default function Dashboard() {
  const { profile } = useUser();
  const { data: counts, isLoading: countsLoading } = useDashboardCounts();
  const { data: recentItems, isLoading: recentLoading } = useRecentItems();

  return (
    <div className="space-y-6">
      {/* Welcome header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Welcome back{profile?.display_name ? `, ${profile.display_name}` : ''}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Here's an overview of your writing workspace.
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Projects" value={countsLoading ? '...' : String(counts?.projects ?? 0)} icon={<FolderIcon />} />
        <StatCard label="Drafts" value={countsLoading ? '...' : String(counts?.drafts ?? 0)} icon={<PencilIcon />} />
        <StatCard label="Published" value={countsLoading ? '...' : String(counts?.published ?? 0)} icon={<CheckIcon />} />
        <StatCard label="Research" value={countsLoading ? '...' : String(counts?.research ?? 0)} icon={<SearchIcon />} />
      </div>

      {/* Recent activity table */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 overflow-hidden">
        <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
        </div>
        {recentLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading...</div>
        ) : !recentItems?.length ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            No content yet. Use the chat or Eve to start creating.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Title</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Project</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Genre</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Arc</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Words</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Modified</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {recentItems.map((item) => (
                  <RecentRow key={`${item.type}-${item.id}`} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RecentRow({ item }: { item: RecentItem }) {
  const navigate = useNavigate();

  const typeLabels: Record<string, string> = {
    project: 'Project',
    chapter: 'Chapter',
    short_story: 'Story',
    blog_post: 'Blog',
    newsletter: 'Newsletter',
    research: 'Research',
  };

  const statusColors: Record<string, string> = {
    published: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    draft: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    rejected: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    scheduled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  };

  const formatWords = (count: number | null): string => {
    if (count == null) return '—';
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return String(count);
  };

  const formatGenre = (slug: string | null): string => {
    if (!slug) return '—';
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  return (
    <tr
      onClick={() => navigate(item.path)}
      className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
    >
      <td className="px-4 py-3">
        <span className="text-xs font-medium text-gray-400 uppercase">{typeLabels[item.type] || item.type}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm font-medium text-gray-900 dark:text-white">{item.title}</span>
        {item.chapter_number != null && (
          <span className="ml-1.5 text-xs text-gray-400">Ch. {item.chapter_number}</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 max-w-[150px] truncate">
        {item.project_title || '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">{formatGenre(item.genre_slug)}</td>
      <td className="px-4 py-3 text-sm text-gray-500">{item.story_arc || '—'}</td>
      <td className="px-4 py-3 text-sm text-gray-500 text-right">{formatWords(item.word_count)}</td>
      <td className="px-4 py-3">
        {item.status && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[item.status] || ''}`}>
            {item.status}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">
        {new Date(item.updated_at).toLocaleDateString()}
      </td>
    </tr>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{label}</p>
        <span className="text-gray-400">{icon}</span>
      </div>
      <p className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  );
}
