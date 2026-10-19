import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../src/auth/auth-context.js';
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
      dispatchEvent: vi.fn(),
    })),
  });
});

function mockSession(role: 'PRODUCT_OWNER' | 'DISTRICT_HOKIM') {
  vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
    actor: {
      id: role === 'PRODUCT_OWNER' ? 'acc_po_1' : 'acc_hokim_1',
      username: role === 'PRODUCT_OWNER' ? 'admin_user' : 'hokim_chilonzor',
      role,
      districtId: role === 'PRODUCT_OWNER' ? null : 'dist_1',
      mustChangePassword: false,
    },
    session: {
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  });
}

function renderAt(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/sign-in" element={<div>Sign In Screen</div>} />
            <Route path="/" element={<div>Root Home Screen</div>} />
            <Route
              path="/districts"
              element={
                <ProtectedRoute>
                  <div>Districts Screen</div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/audit-history"
              element={
                <ProtectedRoute allowedRoles={['PRODUCT_OWNER']}>
                  <div>Audit History Console Screen</div>
                </ProtectedRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

describe('ProtectedRoute role guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets PRODUCT_OWNER reach a Console route guarded by allowedRoles', async () => {
    mockSession('PRODUCT_OWNER');
    renderAt('/audit-history');

    expect(await screen.findByText('Audit History Console Screen')).toBeTruthy();
  });

  it('redirects DISTRICT_HOKIM away from a Console route to /', async () => {
    mockSession('DISTRICT_HOKIM');
    renderAt('/audit-history');

    expect(await screen.findByText('Root Home Screen')).toBeTruthy();
    expect(screen.queryByText('Audit History Console Screen')).toBeNull();
  });

  it('keeps routes without allowedRoles reachable for DISTRICT_HOKIM', async () => {
    mockSession('DISTRICT_HOKIM');
    renderAt('/districts');

    expect(await screen.findByText('Districts Screen')).toBeTruthy();
  });

  it('still redirects unauthenticated users to /sign-in', async () => {
    vi.spyOn(authClient, 'fetchSession').mockRejectedValue(new Error('UNAUTHENTICATED'));
    renderAt('/audit-history');

    expect(await screen.findByText('Sign In Screen')).toBeTruthy();
  });
});
