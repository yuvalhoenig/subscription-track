/** Router and route guards. */

import { Suspense, lazy } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { ThemeProvider } from './lib/theme.jsx';
import { ToastProvider } from './lib/toast.jsx';
import { Loading } from './components/ui.jsx';
import { ChatWidget } from './components/ChatWidget.jsx';
import { DesktopBridge } from './components/DesktopBridge.jsx';
import {
  LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage,
} from './pages/Auth.jsx';
import { CancelLinkPage } from './pages/CancelLink.jsx';

// Route-level code splitting: the dashboard's chart bundle is large, and
// someone landing on /login should not download it.
const DashboardPage = lazy(() => import('./pages/Dashboard.jsx'));
const SubscriptionsPage = lazy(() => import('./pages/Subscriptions.jsx'));
const CalendarPage = lazy(() => import('./pages/Calendar.jsx'));
const InsightsPage = lazy(() => import('./pages/Insights.jsx'));
const AssistantPage = lazy(() => import('./pages/Assistant.jsx'));
const SettingsPage = lazy(() => import('./pages/Settings.jsx'));
const AdminPage = lazy(() => import('./pages/Admin.jsx'));

/**
 * Electron loads the app over file://, where the History API cannot
 * rewrite paths — so the desktop build uses hash routing and the web build
 * uses clean URLs.
 */
const Router = typeof window !== 'undefined' && window.location.protocol === 'file:'
  ? HashRouter
  : BrowserRouter;

function RequireAuth({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  // Hold the route until the initial session check finishes, or a
  // signed-in user would flash the login page on every reload.
  if (loading) return <Loading label="Signing you in…" />;
  if (!isAuthenticated) {
    // Remember where they were headed so login can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

function RedirectIfAuthenticated({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <Loading label="" />;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return children;
}

/** Signed-in but not an admin: sent home rather than shown a 403 page. */
function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="" />;
  if (!user?.is_admin) return <Navigate to="/" replace />;
  return children;
}

/** The authenticated shell: routes plus the floating assistant. */
function AppRoutes() {
  return (
    <Suspense fallback={<Loading label="Loading…" />}>
      <Routes>
        <Route path="/login" element={<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>} />
        <Route path="/register" element={<RedirectIfAuthenticated><RegisterPage /></RedirectIfAuthenticated>} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/cancel/:token" element={<CancelLinkPage />} />

        <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
        <Route path="/subscriptions" element={<RequireAuth><SubscriptionsPage /></RequireAuth>} />
        <Route path="/subscriptions/:id" element={<RequireAuth><SubscriptionsPage /></RequireAuth>} />
        <Route path="/calendar" element={<RequireAuth><CalendarPage /></RequireAuth>} />
        <Route path="/insights" element={<RequireAuth><InsightsPage /></RequireAuth>} />
        <Route path="/assistant" element={<RequireAuth><AssistantPage /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        <Route
          path="/admin"
          element={(
            <RequireAuth>
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            </RequireAuth>
          )}
        />

        {/* Anything else goes home rather than showing a dead end. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

/** The widget is hidden on the full-page assistant, which would duplicate it. */
function FloatingAssistant() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated || location.pathname === '/assistant') return null;
  return <ChatWidget />;
}

export function App() {
  return (
    <ThemeProvider>
      <Router>
        <AuthProvider>
          <ToastProvider>
            <AppRoutes />
            <FloatingAssistant />
            {/* Inert in a browser; wires up the Electron integrations. */}
            <DesktopBridge />
          </ToastProvider>
        </AuthProvider>
      </Router>
    </ThemeProvider>
  );
}

export default App;
