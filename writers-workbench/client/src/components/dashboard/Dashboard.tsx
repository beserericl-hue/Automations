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
        <StatCard
          label="Projects"
          value={countsLoading ? '...' : String(counts?.projects ?? 0)}
          icon={<FolderIcon />}
        />
        <StatCard
          label="Drafts"
          value={countsLoading ? '...' : String(counts?.drafts ?? 0)}
          icon={<PencilIcon />}
        />
        <StatCard
          label="Published"
          value={countsLoading ? '...' : String(counts?.published ?? 0)}
          icon={<CheckIcon />}
        />
        <StatCard
          label="Research"
          value={countsLoading ? '...' : String(counts?.research ?? 0)}
          icon={<SearchIcon />}
        />
      </div>

      {/* Recent activity */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
        </div>
        {recentLoading ? (
          <div className="px-6 py-8 text-center text-sm text-gray-500">Loading...</div>
        ) : !recentItems?.length ? (
          <div className="px-6 py-8 text-center text-sm text-gray-500">
            No content yet. Use the chat or Eve to start creating.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {recentItems.map((item) => (
              <RecentItemRow key={`${item.type}-${item.id}`} item={item} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RecentItemRow({ item }: { item: RecentItem }) {
  const navigate = useNavigate();

  const getPath = (item: RecentItem): string => {
    switch (item.type) {
      case 'project': return `/projects`;
      case 'chapter': return `/chapters`;
      case 'short_story': return `/short-stories`;
      case 'blog_post': return `/blog-posts`;
      case 'newsletter': return `/newsletters`;
      case 'research': return `/research`;
      default: return '/';
    }
  };

  const getTypeLabel = (type: RecentItem['type']): string => {
    switch (type) {
      case 'project': return 'Project';
      case 'chapter': return 'Chapter';
      case 'short_story': return 'Short Story';
      case 'blog_post': return 'Blog Post';
      case 'newsletter': return 'Newsletter';
      case 'research': return 'Research';
      default: return type;
    }
  };

  const getStatusColor = (status: string | null): string => {
    switch (status) {
      case 'published': return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
      case 'approved': return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
      case 'draft': return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
      case 'rejected': return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
      case 'scheduled': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300';
      default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
    }
  };

  const timeAgo = (dateStr: string): string => {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <li
      onClick={() => navigate(getPath(item))}
      className="flex items-center justify-between px-6 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs font-medium text-gray-400 uppercase w-20 shrink-0">
          {getTypeLabel(item.type)}
        </span>
        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
          {item.title}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {item.status && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(item.status)}`}>
            {item.status}
          </span>
        )}
        <span className="text-xs text-gray-400 w-16 text-right">
          {timeAgo(item.updated_at)}
        </span>
      </div>
    </li>
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
