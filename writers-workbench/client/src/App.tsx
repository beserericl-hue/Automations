import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { UserProvider } from './contexts/UserContext';
import { ToastProvider } from './contexts/ToastContext';
import ErrorBoundary from './components/ErrorBoundary';
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

const ContentLibrary = lazy(() => import('./components/content/ContentLibrary'));
const CostDashboard = lazy(() => import('./components/cost/CostDashboard'));
const SourceBrowser = lazy(() => import('./components/content/SourceBrowser'));

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

