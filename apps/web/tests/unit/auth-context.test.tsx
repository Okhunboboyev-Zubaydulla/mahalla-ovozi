import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../../src/auth/auth-context.js';
import { ProtectedRoute } from '../../src/auth/ProtectedRoute.js';
import { authClient } from '../../src/auth/auth-client.js';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

function ConsumerComponent() {
  const { isAuthenticated, actor, isLoading } = useAuth();
  if (isLoading) return <div>Loading Auth State...</div>;
  return (
    <div>
      <div data-testid="auth-status">{isAuthenticated ? 'AUTHENTICATED' : 'UNAUTHENTICATED'}</div>
      <div data-testid="actor-username">{actor?.username || 'NONE'}</div>
    </div>
  );
}

describe('AuthContext & Session Hydration on Refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully restores session on page load when backend returns actor and session', async () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_po_123',
        role: 'PRODUCT_OWNER',
        username: 'admin_user',
        districtId: null,
        mustChangePassword: false,
      },
      session: {
        expiresAt,
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConsumerComponent />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status').textContent).toBe('AUTHENTICATED');
      expect(screen.getByTestId('actor-username').textContent).toBe('admin_user');
    });
  });

  it('marks unauthenticated when backend session returns 401 unauthenticated', async () => {
    vi.spyOn(authClient, 'fetchSession').mockRejectedValue(new Error('UNAUTHENTICATED'));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConsumerComponent />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status').textContent).toBe('UNAUTHENTICATED');
      expect(screen.getByTestId('actor-username').textContent).toBe('NONE');
    });
  });

  it('preserves protected page route on refresh when session is valid', async () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_po_123',
        role: 'PRODUCT_OWNER',
        username: 'admin_user',
        districtId: null,
        mustChangePassword: false,
      },
      session: {
        expiresAt,
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/districts']}>
            <Routes>
              <Route path="/sign-in" element={<div>Sign In Screen</div>} />
              <Route
                path="/districts"
                element={
                  <ProtectedRoute>
                    <div>Districts Management Screen</div>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Districts Management Screen')).toBeTruthy();
    });
  });

  it('redirects to sign-in on refresh when session is missing / unauthenticated', async () => {
    vi.spyOn(authClient, 'fetchSession').mockRejectedValue(new Error('UNAUTHENTICATED'));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/districts']}>
            <Routes>
              <Route path="/sign-in" element={<div>Sign In Screen</div>} />
              <Route
                path="/districts"
                element={
                  <ProtectedRoute>
                    <div>Districts Management Screen</div>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Sign In Screen')).toBeTruthy();
    });
  });

  it('configures periodic session refetch and advances expiresAt dynamically', async () => {
    const initialExpiresAt = new Date(Date.now() + 10000).toISOString();
    const fetchSessionSpy = vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_hokim_123',
        role: 'DISTRICT_HOKIM',
        username: 'hokim_user',
        districtId: 'dis_123',
        mustChangePassword: false,
      },
      session: {
        expiresAt: initialExpiresAt,
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConsumerComponent />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-status').textContent).toBe('AUTHENTICATED');
    });

    // Verify query options in queryClient
    const query = queryClient.getQueryCache().find({ queryKey: ['auth', 'session'] });
    expect(query).toBeDefined();
    const queryOptions = query?.options as Record<string, unknown> | undefined;
    expect(queryOptions?.refetchInterval).toBe(15 * 60 * 1000);
    expect(queryOptions?.refetchIntervalInBackground).toBe(true);

    // Simulate background refetch extending expiresAt by 12 hours
    const extendedExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    fetchSessionSpy.mockResolvedValueOnce({
      actor: {
        id: 'acc_hokim_123',
        role: 'DISTRICT_HOKIM',
        username: 'hokim_user',
        districtId: 'dis_123',
        mustChangePassword: false,
      },
      session: {
        expiresAt: extendedExpiresAt,
      },
    });

    await queryClient.refetchQueries({ queryKey: ['auth', 'session'] });
    const currentData = queryClient.getQueryData<{ session: { expiresAt: string } }>(['auth', 'session']);
    expect(currentData?.session.expiresAt).toBe(extendedExpiresAt);
  });
});
