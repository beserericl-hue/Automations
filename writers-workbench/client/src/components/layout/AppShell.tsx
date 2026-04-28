import { useState, useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ChatDrawer from '../chat/ChatDrawer';
import OnboardingTutorial from '../onboarding/OnboardingTutorial';
import ImpersonationBanner from '../superuser/ImpersonationBanner';
import TrialBanner from '../credits/TrialBanner';
import { useUser } from '../../contexts/UserContext';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../config/supabase';

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
  const queryClient = useQueryClient();
  const { profile } = useUser();
  const { addToast } = useToast();

  // SSE listener for content-ready callbacks from n8n
  useEffect(() => {
    if (!profile?.user_id) return;

    let eventSource: EventSource | null = null;

    async function connect() {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;

      // EventSource doesn't support custom headers, so we pass token as query param
      // The server will validate it
      eventSource = new EventSource(`/api/callback/events?token=${encodeURIComponent(token)}`);

      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'content-ready') {
            addToast(`Eve has loaded "${payload.content_title}"`, 'success');
            // Refresh dashboard and content list
            queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard-recent'] });
            queryClient.invalidateQueries({ queryKey: ['content-list'] });
          } else if (payload.type === 'job-status') {
            window.dispatchEvent(new CustomEvent('chat-job-status', { detail: payload }));
            if (payload.status === 'completed' || payload.status === 'failed') {
              queryClient.invalidateQueries({ queryKey: ['dashboard-counts'] });
              queryClient.invalidateQueries({ queryKey: ['dashboard-recent'] });
              queryClient.invalidateQueries({ queryKey: ['content-list'] });
            }
          } else if (payload.event === 'newsletter.stage') {
            // Compose Newsletter 2a (S4): re-emit on the window so
            // useNewsletterEvents() consumers can subscribe without opening a
            // second EventSource. Same pattern as chat-job-status above.
            window.dispatchEvent(new CustomEvent('newsletter-stage', { detail: payload.data }));
          } else if (payload.event === 'newsletter.approval.created') {
            window.dispatchEvent(new CustomEvent('newsletter-approval-created', { detail: payload.data }));
          } else if (payload.event === 'newsletter.approval.resolved') {
            window.dispatchEvent(new CustomEvent('newsletter-approval-resolved', { detail: payload.data }));
          }
        } catch {
          // Ignore malformed events
        }
      };

      eventSource.onerror = () => {
        // EventSource auto-reconnects on error
      };
    }

    connect();

    return () => {
      eventSource?.close();
    };
  }, [profile?.user_id, queryClient, addToast]);

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
        <ImpersonationBanner />
        <TrialBanner />
        <TopBar onMenuClick={() => setMobileOpen(!mobileOpen)} onChatToggle={() => setChatOpen(!chatOpen)} />
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>

      {/* Chat drawer */}
      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />

      {/* Onboarding tutorial overlay (first visit) */}
      <OnboardingTutorial />
    </div>
  );
}
