import { useState, useEffect, type ReactNode } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ChatDrawer from '../chat/ChatDrawer';

interface AppShellProps {
  children: ReactNode;
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  );
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isDesktop;
}

export default function AppShell({ children }: AppShellProps) {
  const isDesktop = useIsDesktop();
  const [sidebarOpen, setSidebarOpen] = useState(isDesktop);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-gray-950">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`lg:relative lg:flex ${mobileOpen ? 'fixed inset-y-0 left-0 z-50 flex' : 'hidden lg:flex'}`}>
        <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />
      </div>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar onMenuClick={() => setMobileOpen(!mobileOpen)} onChatToggle={() => setChatOpen(!chatOpen)} />
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>

      {/* Chat drawer */}
      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}
