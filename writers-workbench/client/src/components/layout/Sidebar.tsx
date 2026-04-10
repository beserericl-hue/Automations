import { NavLink } from 'react-router-dom';
import { useUser } from '../../contexts/UserContext';

interface SidebarProps {
  open: boolean;
  onToggle: () => void;
}

const navItems = [
  { label: 'Dashboard', path: '/', icon: '~' },
  { label: 'Projects', path: '/projects', icon: '#' },
  { label: 'Chapters', path: '/chapters', icon: 'C' },
  { label: 'Short Stories', path: '/short-stories', icon: 'S' },
  { label: 'Blog Posts', path: '/blog-posts', icon: 'B' },
  { label: 'Newsletters', path: '/newsletters', icon: 'N' },
  { label: 'Research', path: '/research', icon: 'R' },
  { label: 'Social Posts', path: '/social', icon: '@' },
  { label: 'Cover Art', path: '/cover-art', icon: 'A' },
  { label: 'Outlines', path: '/outlines', icon: 'O' },
  { label: 'Story Arcs', path: '/story-arcs', icon: '^' },
  { label: 'Genres', path: '/genres', icon: 'G' },
];

const bottomItems = [
  { label: 'Settings', path: '/settings', icon: '*' },
];

export default function Sidebar({ open }: SidebarProps) {
  const { profile } = useUser();

  return (
    <aside
      className={`${
        open ? 'w-60' : 'w-0'
      } flex flex-col border-r border-gray-200 bg-gray-50 transition-all duration-200 dark:border-gray-800 dark:bg-gray-900 overflow-hidden`}
    >
      {/* Logo */}
      <div className="flex h-14 items-center px-4 border-b border-gray-200 dark:border-gray-800">
        <h1 className="text-sm font-bold text-brand-700 dark:text-brand-400 whitespace-nowrap">
          The Writers Workbench
        </h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 text-sm whitespace-nowrap ${
                isActive
                  ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`
            }
          >
            <span className="w-5 text-center font-mono text-xs opacity-60">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-gray-200 py-2 dark:border-gray-800">
        {bottomItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 text-sm whitespace-nowrap ${
                isActive
                  ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`
            }
          >
            <span className="w-5 text-center font-mono text-xs opacity-60">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
        {profile?.isAdmin && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 text-sm whitespace-nowrap ${
                isActive
                  ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`
            }
          >
            <span className="w-5 text-center font-mono text-xs opacity-60">!</span>
            Admin
          </NavLink>
        )}
      </div>
    </aside>
  );
}
