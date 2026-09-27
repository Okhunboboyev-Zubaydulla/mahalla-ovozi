import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mahallaTheme } from './theme/antd-theme.js';
import { AuthProvider } from './auth/auth-context.js';
import { DistrictProvider } from './district/district-context.js';
import { ProtectedRoute } from './auth/ProtectedRoute.js';
import { ConsoleLayout } from './components/ConsoleLayout.js';
import { LiveAnnouncerProvider } from './components/topics/LiveRegionAnnouncer.js';
import { TopicReadStateProvider } from './hooks/useTopicReadState.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { FullPageLoader } from './components/FullPageLoader.js';
import { useAuth } from './auth/auth-context.js';

// Route-level code splitting via dynamic imports (H-6)
const SignInPage = lazy(() =>
  import('./pages/SignInPage.js').then((m) => ({ default: m.SignInPage }))
);
const FirstSignInPasswordChangePage = lazy(() =>
  import('./pages/FirstSignInPasswordChangePage.js').then((m) => ({
    default: m.FirstSignInPasswordChangePage,
  }))
);
const OverviewPage = lazy(() =>
  import('./pages/OverviewPage.js').then((m) => ({ default: m.OverviewPage }))
);
const DistrictsPage = lazy(() =>
  import('./pages/DistrictsPage.js').then((m) => ({ default: m.DistrictsPage }))
);
const SystemHealthPage = lazy(() =>
  import('./pages/SystemHealthPage.js').then((m) => ({
    default: m.SystemHealthPage,
  }))
);
const TelegramSetupPage = lazy(() =>
  import('./pages/TelegramSetupPage.js').then((m) => ({
    default: m.TelegramSetupPage,
  }))
);
const SubscriptionsPage = lazy(() =>
  import('./pages/SubscriptionsPage.js').then((m) => ({
    default: m.SubscriptionsPage,
  }))
);
const HokimAccountsPage = lazy(() =>
  import('./pages/HokimAccountsPage.js').then((m) => ({
    default: m.HokimAccountsPage,
  }))
);
const AiOperationsPage = lazy(() =>
  import('./pages/AiOperationsPage.js').then((m) => ({
    default: m.AiOperationsPage,
  }))
);
const AuditHistoryPage = lazy(() =>
  import('./pages/AuditHistoryPage.js').then((m) => ({
    default: m.AuditHistoryPage,
  }))
);
const HokimDashboardPage = lazy(() =>
  import('./pages/HokimDashboardPage.js').then((m) => ({
    default: m.HokimDashboardPage,
  }))
);
const TopicEvidencePage = lazy(() =>
  import('./pages/TopicEvidencePage.js').then((m) => ({
    default: m.TopicEvidencePage,
  }))
);
const DashboardHelpPage = lazy(() =>
  import('./pages/DashboardHelpPage.js').then((m) => ({
    default: m.DashboardHelpPage,
  }))
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000, // 30 seconds fresh cache
      gcTime: 10 * 60 * 1000, // 10 minutes memory retention
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthenticatedRoot() {
  const { actor } = useAuth();
  if (actor?.role === 'DISTRICT_HOKIM') {
    return <HokimDashboardPage />;
  }
  return <ConsoleLayout />;
}

export function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <AuthProvider>
              {/* BrowserRouter wraps DistrictProvider to allow URL SearchParam synchronization */}
              <BrowserRouter>
                <DistrictProvider>
                  <LiveAnnouncerProvider>
                    <TopicReadStateProvider>
                      <Suspense fallback={<FullPageLoader />}>
                      <Routes>
                        <Route path="/sign-in" element={<SignInPage />} />
                        <Route
                          path="/first-login-password-change"
                          element={
                            <ProtectedRoute>
                              <FirstSignInPasswordChangePage />
                            </ProtectedRoute>
                          }
                        />

                        {/* Narrow-screen routed Topic Evidence Page for Hokim (AC 8) */}
                        <Route
                          path="/topics/:topicId/evidence"
                          element={
                            <ProtectedRoute>
                              <TopicEvidencePage />
                            </ProtectedRoute>
                          }
                        />

                        {/* Narrow-screen routed Help Page for Hokim (AC 4) */}
                        <Route
                          path="/help"
                          element={
                            <ProtectedRoute>
                              <DashboardHelpPage />
                            </ProtectedRoute>
                          }
                        />

                        {/* Role-discriminating root route: DISTRICT_HOKIM gets HokimDashboardPage directly; PRODUCT_OWNER gets ConsoleLayout */}
                        <Route
                          path="/"
                          element={
                            <ProtectedRoute>
                              <AuthenticatedRoot />
                            </ProtectedRoute>
                          }
                        >
                          <Route index element={<OverviewPage />} />
                          <Route path="districts" element={<DistrictsPage />} />
                          <Route path="system-health" element={<SystemHealthPage />} />
                          <Route path="telegram-setup" element={<TelegramSetupPage />} />
                          <Route path="subscriptions" element={<SubscriptionsPage />} />
                          <Route path="hokim-accounts" element={<HokimAccountsPage />} />
                          <Route path="ai-operations" element={<AiOperationsPage />} />
                          <Route path="audit-history" element={<AuditHistoryPage />} />
                        </Route>

                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </Suspense>
                  </TopicReadStateProvider>
                </LiveAnnouncerProvider>
                </DistrictProvider>
              </BrowserRouter>
            </AuthProvider>
          </AntdApp>
        </ConfigProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default App;

