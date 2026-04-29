import { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { UserProvider } from './contexts/UserContext';
import { ToastProvider } from './contexts/ToastContext';
import ErrorBoundary from './components/ErrorBoundary';
import { lazyRetry } from './lib/lazyRetry';
import LoginPage from './components/auth/LoginPage';
import SignupPage from './components/auth/SignupPage';
import ForgotPasswordPage from './components/auth/ForgotPasswordPage';
import ResetPasswordPage from './components/auth/ResetPasswordPage';
import OnboardingPage from './components/auth/OnboardingPage';
import AuthGuard from './components/auth/AuthGuard';
import AppShell from './components/layout/AppShell';
import Dashboard from './components/dashboard/Dashboard';
import ProjectList from './components/projects/ProjectList';
import ProjectDetail from './components/projects/ProjectDetail';
import ContentDetail from './components/content/ContentDetail';
import ResearchList from './components/research/ResearchList';
import ResearchDetail from './components/research/ResearchDetail';
import StoryBiblePanel from './components/story-bible/StoryBiblePanel';
import StoryArcBrowser from './components/story-arcs/StoryArcBrowser';
import OutlineList from './components/outlines/OutlineList';
import GenreList from './components/genres/GenreList';
import UserSettings from './components/settings/UserSettings';
import TrashView from './components/projects/TrashView';
import AdminPanel from './components/admin/AdminPanel';
import BrainstormForm from './components/brainstorm/BrainstormForm';
import ImageDetail from './components/images/ImageDetail';

const ContentLibrary = lazyRetry(() => import('./components/content/ContentLibrary'));
const CostDashboard = lazyRetry(() => import('./components/cost/CostDashboard'));
const SourceBrowser = lazyRetry(() => import('./components/content/SourceBrowser'));
const SuperuserPanel = lazyRetry(() => import('./components/superuser/SuperuserPanel'));
const CreditsPage = lazyRetry(() => import('./components/credits/CreditsPage'));

// Compose Newsletter 2a (S4) — newsletter route stubs. S6/S7/S8 fill in the
// Generate / Execution Status / Approvals real pages; the rest stay stubs
// until Phase 2b.
const NewsletterHome = lazyRetry(() => import('./components/newsletter/NewsletterHome'));
const NewsletterGenerate = lazyRetry(() => import('./components/newsletter/NewsletterGenerate'));
const ExecutionStatus = lazyRetry(() => import('./components/newsletter/ExecutionStatus'));
const PendingApprovals = lazyRetry(() => import('./components/newsletter/PendingApprovals'));
const ApprovalDetail = lazyRetry(() => import('./components/newsletter/ApprovalDetail'));
const ScheduledSends = lazyRetry(() => import('./components/newsletter/ScheduledSends'));
const NewsletterDetail = lazyRetry(() => import('./components/newsletter/NewsletterDetail'));
const IngestionBrowser = lazyRetry(() => import('./components/newsletter/IngestionBrowser'));

// Newsletter Templates Sprint (T3)
const TemplatesList = lazyRetry(() => import('./components/newsletter/TemplatesList'));
const TemplateEditor = lazyRetry(() => import('./components/newsletter/TemplateEditor'));

// Multi-User Newsletters Sprint — editions CRUD + per-edition feeds
const EditionsList = lazyRetry(() => import('./components/newsletter/EditionsList'));
const EditionEditor = lazyRetry(() => import('./components/newsletter/EditionEditor'));
const FeedsList = lazyRetry(() => import('./components/newsletter/FeedsList'));

export default function App() {
  return (
    <ErrorBoundary>
    <ToastProvider>
    <AuthProvider>
      <UserProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route
            path="/*"
            element={
              <AuthGuard>
                <AppShell>
                  <Suspense fallback={<div className="flex items-center justify-center h-64 text-sm text-gray-500">Loading...</div>}>
                  <Routes>
                    <Route index element={<Dashboard />} />
                    <Route path="projects" element={<ProjectList />} />
                    <Route path="projects/:id" element={<ProjectDetail />} />
                    <Route path="projects/:id/bible" element={<StoryBiblePanel />} />
                    <Route path="trash" element={<TrashView />} />
                    <Route path="library" element={<ContentLibrary />} />
                    {/* Legacy routes redirect to Content Library with filter */}
                    <Route path="chapters" element={<Navigate to="/library?type=chapter" replace />} />
                    <Route path="short-stories" element={<Navigate to="/library?type=short_story" replace />} />
                    <Route path="blog-posts" element={<Navigate to="/library?type=blog_post" replace />} />
                    <Route path="newsletters" element={<Navigate to="/library?type=newsletter" replace />} />
                    <Route path="content/:id" element={<ContentDetail />} />
                    <Route path="images/:id" element={<ImageDetail />} />
                    <Route path="research" element={<ResearchList />} />
                    <Route path="research/:id" element={<ResearchDetail />} />
                    <Route path="brainstorm" element={<BrainstormForm />} />
                    <Route path="outlines" element={<OutlineList />} />
                    <Route path="story-arcs" element={<StoryArcBrowser />} />
                    <Route path="genres" element={<GenreList />} />
                    <Route path="cost" element={<CostDashboard />} />
                    <Route path="sources" element={<SourceBrowser />} />
                    <Route path="settings" element={<UserSettings />} />
                    <Route path="admin/*" element={<AdminPanel />} />
                    <Route path="superuser/*" element={<SuperuserPanel />} />
                    <Route path="credits" element={<CreditsPage />} />
                    {/* Compose Newsletter 2a (S4) — singular /newsletter prefix.
                        Note: /newsletters (plural) above redirects to the legacy
                        Content Library filter; do not collapse the two. */}
                    <Route path="newsletter" element={<NewsletterHome />} />
                    <Route path="newsletter/generate" element={<NewsletterGenerate />} />
                    <Route path="newsletter/execution/:id" element={<ExecutionStatus />} />
                    <Route path="newsletter/approvals" element={<PendingApprovals />} />
                    <Route path="newsletter/approvals/:token" element={<ApprovalDetail />} />
                    <Route path="newsletter/sends" element={<ScheduledSends />} />
                    <Route path="newsletter/sends/:id" element={<NewsletterDetail />} />
                    <Route path="newsletter/ingestion" element={<IngestionBrowser />} />
                    {/* Newsletter Templates Sprint (T3) — list + editor.
                        Branding lives inside each template's HTML, AI content
                        is what's variable per send. /preview is what n8n
                        calls at send time (T4 wiring follow-up). */}
                    <Route path="newsletter/templates" element={<TemplatesList />} />
                    <Route path="newsletter/templates/new" element={<TemplateEditor />} />
                    <Route path="newsletter/templates/:id" element={<TemplateEditor />} />
                    {/* Multi-User Newsletters Sprint — editions CRUD + per-edition feeds */}
                    <Route path="newsletter/editions" element={<EditionsList />} />
                    <Route path="newsletter/editions/new" element={<EditionEditor />} />
                    <Route path="newsletter/editions/:id" element={<EditionEditor />} />
                    <Route path="newsletter/editions/:id/feeds" element={<FeedsList />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                  </Suspense>
                </AppShell>
              </AuthGuard>
            }
          />
        </Routes>
      </UserProvider>
    </AuthProvider>
    </ToastProvider>
    </ErrorBoundary>
  );
}

