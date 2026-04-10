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
                    <Route path="projects" element={<Placeholder name="Projects" />} />
                    <Route path="chapters" element={<Placeholder name="Chapters" />} />
                    <Route path="short-stories" element={<Placeholder name="Short Stories" />} />
                    <Route path="blog-posts" element={<Placeholder name="Blog Posts" />} />
                    <Route path="newsletters" element={<Placeholder name="Newsletters" />} />
                    <Route path="research" element={<Placeholder name="Research" />} />
                    <Route path="social" element={<Placeholder name="Social Posts" />} />
                    <Route path="cover-art" element={<Placeholder name="Cover Art" />} />
                    <Route path="outlines" element={<Placeholder name="Outlines" />} />
                    <Route path="story-arcs" element={<Placeholder name="Story Arcs" />} />
                    <Route path="genres" element={<Placeholder name="Genres" />} />
                    <Route path="settings" element={<Placeholder name="Settings" />} />
                    <Route path="admin/*" element={<Placeholder name="Admin" />} />
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
