import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth-context.js';
import { FullPageLoader } from '../components/FullPageLoader.js';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, mustChangePassword } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <FullPageLoader />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/sign-in" replace />;
  }

  if (mustChangePassword && location.pathname !== '/first-login-password-change') {
    return <Navigate to="/first-login-password-change" replace />;
  }

  if (!mustChangePassword && location.pathname === '/first-login-password-change') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

