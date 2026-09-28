import { createContext, useContext, ReactNode, useCallback, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ActorContext,
  SignInRequest,
  SignInResponse,
  FirstSignInPasswordChangeRequest,
  FirstSignInPasswordChangeResponse,
} from '@mahalla-ovozi/api-contracts';
import { authClient } from './auth-client.js';

interface AuthContextValue {
  actor: ActorContext | null;
  isAuthenticated: boolean;
  mustChangePassword: boolean;
  isLoading: boolean;
  signIn: (credentials: SignInRequest) => Promise<SignInResponse>;
  signOut: () => Promise<void>;
  changeFirstLoginPassword: (
    payload: FirstSignInPasswordChangeRequest
  ) => Promise<FirstSignInPasswordChangeResponse>;
  isSigningIn: boolean;
  isSigningOut: boolean;
  isChangingPassword: boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data: sessionData, isLoading } = useQuery({
    queryKey: ['auth', 'session'],
    queryFn: () => authClient.fetchSession(),
    retry: false,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
    refetchIntervalInBackground: true,
  });

  // Active offline session expiration checker (AC 8)
  useEffect(() => {
    if (!sessionData?.session?.expiresAt) {
      return;
    }

    const expiresAt = new Date(sessionData.session.expiresAt).getTime();

    const intervalId = setInterval(() => {
      if (Date.now() >= expiresAt) {
        queryClient.clear();
        queryClient.setQueryData(['auth', 'session'], null);
        if (typeof window !== 'undefined' && window.location.pathname !== '/sign-in') {
          window.location.href = '/sign-in';
        }
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [sessionData?.session?.expiresAt, queryClient]);

  const signInMutation = useMutation({
    mutationFn: (credentials: SignInRequest) => authClient.signIn(credentials),
    onSuccess: (data) => {
      queryClient.setQueryData(['auth', 'session'], data);
    },
    onError: (error) => {
      console.error('Auth mutation failed:', error);
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: () => {
      queryClient.setQueryData(['auth', 'session'], null);
      queryClient.removeQueries({ queryKey: ['auth', 'session'] });
    },
    onError: (error) => {
      console.error('Auth mutation failed:', error);
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (payload: FirstSignInPasswordChangeRequest) =>
      authClient.changeFirstLoginPassword(payload),
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['auth', 'session'],
        (old: { actor: ActorContext; session: { expiresAt: string } } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            actor: data.actor,
          };
        }
      );
      queryClient.invalidateQueries({ queryKey: ['auth', 'session'] });
    },
    onError: (error) => {
      console.error('Auth mutation failed:', error);
    },
  });

  const signIn = useCallback(
    async (credentials: SignInRequest) => {
      return await signInMutation.mutateAsync(credentials);
    },
    [signInMutation]
  );

  const signOut = useCallback(async () => {
    try {
      await queryClient.cancelQueries();
    } catch {
      // ignore
    }
    queryClient.clear();
    queryClient.setQueryData(['auth', 'session'], null);
    try {
      await signOutMutation.mutateAsync();
    } catch {
      // ignore
    }
  }, [queryClient, signOutMutation]);

  const changeFirstLoginPassword = useCallback(
    async (payload: FirstSignInPasswordChangeRequest) => {
      return await changePasswordMutation.mutateAsync(payload);
    },
    [changePasswordMutation]
  );

  const actor = sessionData?.actor || null;
  const isAuthenticated = !!actor;
  const mustChangePassword = Boolean(actor?.mustChangePassword);

  const contextValue = useMemo(
    () => ({
      actor,
      isAuthenticated,
      mustChangePassword,
      isLoading,
      signIn,
      signOut,
      changeFirstLoginPassword,
      isSigningIn: signInMutation.isPending,
      isSigningOut: signOutMutation.isPending,
      isChangingPassword: changePasswordMutation.isPending,
    }),
    [
      actor,
      isAuthenticated,
      mustChangePassword,
      isLoading,
      signIn,
      signOut,
      changeFirstLoginPassword,
      signInMutation.isPending,
      signOutMutation.isPending,
      changePasswordMutation.isPending,
    ]
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}


export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useOptionalAuth(): AuthContextValue | undefined {
  return useContext(AuthContext);
}
