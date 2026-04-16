import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useUser } from '../../contexts/UserContext';
import EveOrb from '../eve/EveOrb';
import type { WritingProject } from '../../types/database';

interface SidebarProps {
  open: boolean;
  onToggle: () => void;
}

export default function Sidebar({ open, onToggle }: SidebarProps) {
  const { profile } = useUser();
  const userId = profile?.user_id;
  const location = useLocation();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [referenceExpanded, setReferenceExpanded] = useState(false);

  // Fetch projects for expandable sidebar section
  const { data: projects } = useQuery({
    queryKey: ['sidebar-projects', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('writing_projects_v2')
        .select('id, title, status, updated_at')
        .eq('user_id', userId!)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as Pick<WritingProject, 'id' | 'title' | 'status' | 'updated_at'>[];
    },
    enabled: !!userId,
    staleTime: 30_000,
  });

  const projectCount = projects?.length ?? 0;
  const isProjectRoute = location.pathname.startsWith('/projects');
  const isReferenceRoute = ['/genres', '/story-arcs', '/research', '/sources', '/cost'].some(p => location.pathname.startsWith(p));

  // Auto-expand sections when navigating into them
  if (isProjectRoute && !projectsExpanded) setProjectsExpanded(true);
  if (isReferenceRoute && !referenceExpanded) setReferenceExpanded(true);

  return (
    <aside
      className={`${
        open ? 'w-56' : 'w-14'
      } flex flex-col border-r border-gray-200 bg-gray-50 transition-all duration-200 dark:border-gray-800 dark:bg-gray-900 overflow-hidden shrink-0`}
    >
      {/* Logo + collapse toggle */}
      <div className="flex h-14 items-center justify-between border-b border-gray-200 dark:border-gray-800 px-3">
        {open ? (
          <div className="flex items-center gap-2 min-w-0">
            <img src="/assets/logo-blue.png" alt="Course Worx" className="h-8 shrink-0 dark:hidden" />
            <img src="/assets/logo-white.png" alt="Course Worx" className="h-8 shrink-0 hidden dark:block" />
          </div>
        ) : (
          <img src="/assets/favicon.png" alt="CW" className="h-6 shrink-0" />
        )}
        <button
          onClick={onToggle}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300 shrink-0"
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          title={open ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {open ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {/* Dashboard */}
        <SidebarLink to="/" icon={DashboardIcon} label="Dashboard" open={open} end />

        {/* My Projects — expandable */}
        <div>
          <button
            onClick={() => open ? setProjectsExpanded(!projectsExpanded) : undefined}
            className={`flex w-full items-center gap-3 px-3 py-2 text-sm whitespace-nowrap ${
              open ? '' : 'justify-center'
            } ${
              isProjectRoute
                ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
            title={!open ? `Projects (${projectCount})` : undefined}
          >
            <ProjectsIcon className="h-5 w-5 shrink-0" />
            {open && (
              <>
                <span className="flex-1 text-left truncate">My Projects</span>
                {projectCount > 0 && (
                  <span className="rounded-full bg-gray-200 px-1.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                    {projectCount}
                  </span>
                )}
                <ChevronIcon expanded={projectsExpanded} />
              </>
            )}
          </button>

          {/* Project sub-items */}
          {open && projectsExpanded && (
            <div className="ml-4 border-l border-gray-200 dark:border-gray-700">
              <NavLink
                to="/projects"
                end
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-brand-700 font-medium dark:text-brand-300'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`
                }
              >
                All Projects
              </NavLink>
              {projects?.map((project) => (
                <NavLink
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                      isActive
                        ? 'text-brand-700 font-medium dark:text-brand-300'
                        : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                    }`
                  }
                >
                  <span className="truncate">{project.title}</span>
                  <StatusDot status={project.status} />
                </NavLink>
              ))}
              {projectCount === 0 && (
                <div className="px-3 py-1.5 text-xs text-gray-400 italic">No projects yet</div>
              )}
            </div>
          )}
        </div>

        {/* Content Library */}
        <SidebarLink to="/library" icon={LibraryIcon} label="Content Library" open={open} />

        {/* Brainstorm */}
        <SidebarLink to="/brainstorm" icon={BrainstormIcon} label="Brainstorm" open={open} />

        {/* Outlines */}
        <SidebarLink to="/outlines" icon={OutlineIcon} label="Outlines" open={open} />

        {/* Divider */}
        <div className="my-2 mx-3 border-t border-gray-200 dark:border-gray-700" />

        {/* Reference — collapsible section */}
        <div>
          <button
            onClick={() => open ? setReferenceExpanded(!referenceExpanded) : undefined}
            className={`flex w-full items-center gap-3 px-3 py-2 text-sm whitespace-nowrap ${
              open ? '' : 'justify-center'
            } ${
              isReferenceRoute
                ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
            title={!open ? 'Reference' : undefined}
          >
            <ReferenceIcon className="h-5 w-5 shrink-0" />
            {open && (
              <>
                <span className="flex-1 text-left truncate">Reference</span>
                <ChevronIcon expanded={referenceExpanded} />
              </>
            )}
          </button>

          {open && referenceExpanded && (
            <div className="ml-4 border-l border-gray-200 dark:border-gray-700">
              <NavLink
                to="/genres"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-brand-700 font-medium dark:text-brand-300'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`
                }
              >
                Genres
              </NavLink>
              <NavLink
                to="/story-arcs"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-brand-700 font-medium dark:text-brand-300'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`
                }
              >
                Story Arcs
              </NavLink>
              <NavLink
                to="/research"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-brand-700 font-medium dark:text-brand-300'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`
                }
              >
                Research
              </NavLink>
              <NavLink
                to="/sources"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-brand-700 font-medium dark:text-brand-300'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`
                }
              >
                Sources
              </NavLink>
              <NavLink
                to="/cost"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap ${
                    isActive
                      ? 'text-brand-700 font-medium dark:text-brand-300'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                  }`
                }
              >
                Cost Tracking
              </NavLink>
            </div>
          )}
        </div>
      </nav>

      {/* Bottom section */}
      <div className="border-t border-gray-200 py-2 dark:border-gray-800">
        {open && <EveOrb />}
        {!open && (
          <div className="flex justify-center py-2" title="Talk to Eve">
            <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          </div>
        )}
        <SidebarLink to="/trash" icon={TrashIcon} label="Trash" open={open} />
        <SidebarLink to="/settings" icon={SettingsIcon} label="Settings" open={open} />
        {profile?.isAdmin && (
          <SidebarLink to="/admin" icon={AdminIcon} label="Admin" open={open} />
        )}
      </div>
    </aside>
  );
}

// ---- Reusable link component ----

function SidebarLink({
  to,
  icon: Icon,
  label,
  open,
  end,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  open: boolean;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={!open ? label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 text-sm whitespace-nowrap ${
          open ? '' : 'justify-center'
        } ${
          isActive
            ? 'bg-brand-50 text-brand-700 font-medium dark:bg-brand-950 dark:text-brand-300'
            : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
        }`
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      {open && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

// ---- Small components ----

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    published: 'bg-green-500',
    approved: 'bg-blue-500',
    draft: 'bg-gray-400',
    rejected: 'bg-red-500',
    scheduled: 'bg-yellow-500',
    in_progress: 'bg-brand-500',
  };
  return <span className={`ml-auto h-1.5 w-1.5 rounded-full shrink-0 ${colors[status] || 'bg-gray-400'}`} />;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

// ---- Icons ----

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  );
}

function ProjectsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

function LibraryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.331 0 4.472.89 6.064 2.346m0-14.304a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.346" />
    </svg>
  );
}

function BrainstormIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
    </svg>
  );
}

function OutlineIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  );
}

function ReferenceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function AdminIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}
