import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { UserProvider } from './contexts/UserContext';
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
import ContentList from './components/content/ContentList';
import ContentDetail from './components/content/ContentDetail';
import ResearchList from './components/research/ResearchList';
import StoryBiblePanel from './components/story-bible/StoryBiblePanel';
import StoryArcBrowser from './components/story-arcs/StoryArcBrowser';
import OutlineList from './components/outlines/OutlineList';
import GenreList from './components/genres/GenreList';
import UserSettings from './components/settings/UserSettings';
import AdminPanel from './components/admin/AdminPanel';

export default function App() {
  return (
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
                  <Routes>
                    <Route index element={<Dashboard />} />
                    <Route path="projects" element={<ProjectList />} />
                    <Route path="projects/:id" element={<ProjectDetail />} />
                    <Route path="projects/:id/bible" element={<StoryBiblePanel />} />
                    <Route path="chapters" element={<ContentList contentType="chapter" title="Chapters" />} />
                    <Route path="short-stories" element={<ContentList contentType="short_story" title="Short Stories" />} />
                    <Route path="blog-posts" element={<ContentList contentType="blog_post" title="Blog Posts" />} />
                    <Route path="newsletters" element={<ContentList contentType="newsletter" title="Newsletters" />} />
                    <Route path="content/:id" element={<ContentDetail />} />
                    <Route path="research" element={<ResearchList />} />
                    <Route path="outlines" element={<OutlineList />} />
                    <Route path="story-arcs" element={<StoryArcBrowser />} />
                    <Route path="social" element={<Placeholder name="Social Posts" />} />
                    <Route path="cover-art" element={<Placeholder name="Cover Art" />} />
                    <Route path="genres" element={<GenreList />} />
                    <Route path="settings" element={<UserSettings />} />
                    <Route path="admin/*" element={<AdminPanel />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AppShell>
              </AuthGuard>
            }
          />
        </Routes>
      </UserProvider>
    </AuthProvider>
  );
}

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-300">{name}</h2>
        <p className="mt-2 text-gray-500">Coming soon</p>
      </div>
    </div>
  );
}
