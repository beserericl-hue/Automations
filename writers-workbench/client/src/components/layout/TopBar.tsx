import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useUser } from '../../contexts/UserContext';

interface TopBarProps {
  onMenuClick: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { signOut } = useAuth();
  const { profile } = useUser();
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

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-gray-800 dark:bg-gray-950">
      {/* Left: hamburger */}
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
