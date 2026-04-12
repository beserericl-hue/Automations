import { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useUser } from '../../contexts/UserContext';
import { supabase } from '../../config/supabase';

interface TopBarProps {
  onMenuClick: () => void;
  onChatToggle?: () => void;
}

const breadcrumbLabels: Record<string, string> = {
  '': 'Dashboard',
  projects: 'Projects',
  library: 'Content Library',
  research: 'Research',
  outlines: 'Outlines',
  'story-arcs': 'Story Arcs',
  genres: 'Genres',
  trash: 'Trash',
  settings: 'Settings',
  admin: 'Admin',
  content: 'Content',
  bible: 'Story Bible',
};

export default function TopBar({ onMenuClick, onChatToggle }: TopBarProps) {
  const { signOut } = useAuth();
  const { profile } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const userId = profile?.user_id;

  // Close menu on outside click
  useEffect(() => {
    if (!userMenuOpen && !searchOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [userMenuOpen, searchOpen]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Keyboard shortcut: Cmd/Ctrl+K to open search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Build breadcrumb from path
  const segments = location.pathname.split('/').filter(Boolean);

  // Resolve entity titles for UUIDs in breadcrumb (content/:id, projects/:id)
  const entityId = useMemo(() => {
    if (segments[0] === 'content' && segments[1]) return { type: 'content' as const, id: segments[1] };
    if (segments[0] === 'projects' && segments[1]) return { type: 'project' as const, id: segments[1] };
    return null;
  }, [segments[0], segments[1]]);

  const { data: entityTitle } = useQuery({
    queryKey: ['breadcrumb-title', entityId?.type, entityId?.id],
    queryFn: async () => {
      if (!entityId || !userId) return null;
      if (entityId.type === 'content') {
        const { data } = await supabase
          .from('published_content_v2')
          .select('title')
          .eq('id', entityId.id)
          .eq('user_id', userId)
          .single();
        return data?.title || null;
      }
      if (entityId.type === 'project') {
        const { data } = await supabase
          .from('writing_projects_v2')
          .select('title')
          .eq('id', entityId.id)
          .eq('user_id', userId)
          .single();
        return data?.title || null;
      }
      return null;
    },
    enabled: !!entityId && !!userId,
    staleTime: 60_000,
  });

  const crumbs = segments.map((seg, i) => {
    let label = breadcrumbLabels[seg] || seg;
    // Replace UUID with entity title
    if (entityId && i === 1 && seg === entityId.id && entityTitle) {
      label = entityTitle;
    }
    return {
      label,
      path: '/' + segments.slice(0, i + 1).join('/'),
      isLast: i === segments.length - 1,
    };
  });

  // Global search
  const { data: searchResults } = useQuery({
    queryKey: ['global-search', searchQuery, userId],
    queryFn: async () => {
      if (!searchQuery.trim() || !userId) return [];
      const q = `%${searchQuery.trim()}%`;
      const [projects, content, research] = await Promise.all([
        supabase
          .from('writing_projects_v2')
          .select('id, title')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .ilike('title', q)
          .limit(5),
        supabase
          .from('published_content_v2')
          .select('id, title, content_type')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .ilike('title', q)
          .limit(5),
        supabase
          .from('research_reports_v2')
          .select('id, topic')
          .eq('user_id', userId)
          .is('deleted_at', null)
          .ilike('topic', q)
          .limit(3),
      ]);

      const results: SearchResult[] = [];
      if (projects.data) {
        for (const p of projects.data) {
          results.push({ id: p.id, title: p.title, type: 'project', path: `/projects/${p.id}` });
        }
      }
      if (content.data) {
        for (const c of content.data) {
          results.push({ id: c.id, title: c.title, type: c.content_type, path: `/content/${c.id}` });
        }
      }
      if (research.data) {
        for (const r of research.data) {
          results.push({ id: r.id, title: r.topic, type: 'research', path: `/research` });
        }
      }
      return results;
    },
    enabled: !!searchQuery.trim() && searchOpen && !!userId,
    staleTime: 5_000,
  });

  const handleSearchSelect = (path: string) => {
    navigate(path);
    setSearchOpen(false);
    setSearchQuery('');
  };

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-gray-800 dark:bg-gray-950">
      {/* Left: hamburger + breadcrumb */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 lg:hidden"
          aria-label="Toggle sidebar"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Breadcrumb */}
        <nav className="flex items-center text-sm">
          <Link to="/" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            Home
          </Link>
          {crumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center">
              <svg className="h-4 w-4 mx-1 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
              {crumb.isLast ? (
                <span className="font-medium text-gray-700 dark:text-gray-200 truncate max-w-[200px]">{crumb.label}</span>
              ) : (
                <Link to={crumb.path} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 truncate max-w-[200px]">
                  {crumb.label}
                </Link>
              )}
            </span>
          ))}
        </nav>
      </div>

      {/* Right: search + chat + user menu */}
      <div className="flex items-center gap-2">
        {/* Search */}
        <div className="relative" ref={searchRef}>
          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Search (Cmd+K)"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </button>

          {searchOpen && (
            <div className="absolute right-0 mt-1 w-80 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900 z-50">
              <div className="p-2">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects, content, research..."
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                />
              </div>
              {searchResults && searchResults.length > 0 && (
                <div className="max-h-64 overflow-y-auto border-t border-gray-100 dark:border-gray-800">
                  {searchResults.map((result) => (
                    <button
                      key={`${result.type}-${result.id}`}
                      onClick={() => handleSearchSelect(result.path)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      <TypeIcon type={result.type} />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-gray-900 dark:text-white">{result.title}</span>
                        <span className="text-xs text-gray-400 capitalize">{result.type.replace(/_/g, ' ')}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {searchQuery.trim() && searchResults?.length === 0 && (
                <div className="border-t border-gray-100 px-3 py-3 text-center text-xs text-gray-400 dark:border-gray-800">
                  No results found
                </div>
              )}
            </div>
          )}
        </div>

        {onChatToggle && (
          <button
            onClick={onChatToggle}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Chat with Author Agent"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </button>
        )}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-700 dark:bg-brand-900 dark:text-brand-300">
              {profile?.display_name?.[0]?.toUpperCase() || '?'}
            </span>
            <span className="hidden sm:inline">{profile?.display_name || 'User'}</span>
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-1 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900 z-50">
              <Link
                to="/settings"
                onClick={() => setUserMenuOpen(false)}
                className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Settings
              </Link>
              <button
                onClick={() => { signOut(); setUserMenuOpen(false); }}
                className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// Search result types
interface SearchResult {
  id: string;
  title: string;
  type: string;
  path: string;
}

function TypeIcon({ type }: { type: string }) {
  const iconClass = "h-4 w-4 text-gray-400 shrink-0";
  switch (type) {
    case 'project':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
      );
    case 'research':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
      );
    default:
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      );
  }
}
