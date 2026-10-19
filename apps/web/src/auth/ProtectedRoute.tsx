import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { ActorRole } from '@mahalla-ovozi/api-contracts';
import { useAuth } from './auth-context.js';
import { FullPageLoader } from '../components/FullPageLoader.js';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: readonly ActorRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { actor, isAuthenticated, isLoading, mustChangePassword } = useAuth();
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

  if (allowedRoles !== undefined && (actor === null || !allowedRoles.includes(actor.role))) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
