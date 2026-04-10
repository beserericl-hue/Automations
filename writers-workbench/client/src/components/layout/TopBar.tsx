import { useState, useRef, useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useUser } from '../../contexts/UserContext';

interface TopBarProps {
  onMenuClick: () => void;
}

const breadcrumbLabels: Record<string, string> = {
  '': 'Dashboard',
  projects: 'Projects',
  chapters: 'Chapters',
  'short-stories': 'Short Stories',
  'blog-posts': 'Blog Posts',
  newsletters: 'Newsletters',
  research: 'Research',
  social: 'Social Posts',
  'cover-art': 'Cover Art',
  outlines: 'Outlines',
  'story-arcs': 'Story Arcs',
  genres: 'Genres',
  settings: 'Settings',
  admin: 'Admin',
};

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { signOut } = useAuth();
  const { profile } = useUser();
  const location = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [userMenuOpen]);

  // Build breadcrumb from path
  const segments = location.pathname.split('/').filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    label: breadcrumbLabels[seg] || seg,
    path: '/' + segments.slice(0, i + 1).join('/'),
    isLast: i === segments.length - 1,
  }));

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
                <span className="font-medium text-gray-700 dark:text-gray-200">{crumb.label}</span>
              ) : (
                <Link to={crumb.path} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  {crumb.label}
                </Link>
              )}
            </span>
          ))}
        </nav>
      </div>

      {/* Right: user menu */}
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
    </header>
  );
}
