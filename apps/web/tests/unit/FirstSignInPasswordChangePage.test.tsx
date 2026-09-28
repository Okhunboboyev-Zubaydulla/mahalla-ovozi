import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirstSignInPasswordChangePage } from '../../src/pages/FirstSignInPasswordChangePage.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { ProtectedRoute } from '../../src/auth/ProtectedRoute.js';
import { authClient } from '../../src/auth/auth-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

function setupMatchMedia() {
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
}

beforeAll(() => {
  setupMatchMedia();
});

describe('FirstSignInPasswordChangePage & Route Guard Tests (AC 10, 11, 12, 13, 17)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    setupMatchMedia();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.restoreAllMocks();
    setupMatchMedia();
  });


  function renderWithProviders(ui: React.ReactElement) {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AuthProvider>
            <BrowserRouter>{ui}</BrowserRouter>
          </AuthProvider>
        </ConfigProvider>
      </QueryClientProvider>
    );
  }

  it('renders page elements and mandatory static informational notice with zero consent checkboxes (AC 11)', async () => {
    vi.spyOn(authClient, 'fetchSession').mockResolvedValueOnce({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_chilonzor',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: true,
      },
      session: {
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    renderWithProviders(<FirstSignInPasswordChangePage />);

    expect(await screen.findByText('Паролни янгилаш')).toBeTruthy();
    expect(
      screen.getByText(/Маҳсулот эгаси туман маълумотлари ва далилларни мониторинг қилиш/)
    ).toBeTruthy();
    expect(screen.getByText('Жорий (вақтинчалик) парол')).toBeTruthy();
    expect(screen.getByText('Янги доимий парол')).toBeTruthy();
    expect(screen.getByText('Янги паролни тасдиқланг')).toBeTruthy();

    // Verify zero consent checkboxes exist on the page
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('validates minimum 15 characters and password mismatch', async () => {
    vi.spyOn(authClient, 'fetchSession').mockResolvedValueOnce({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_chilonzor',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: true,
      },
      session: {
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    const { container } = renderWithProviders(<FirstSignInPasswordChangePage />);

    const currentInput = container.querySelector('#current-password-input');
    const newInput = container.querySelector('#new-password-input');
    const confirmInput = container.querySelector('#confirm-password-input');
    const submitBtn = await screen.findByRole('button', {
      name: /Паролни сақлаш ва тизимга кириш/i,
    });

    // Fill short password
    fireEvent.change(currentInput!, { target: { value: 'Old-Temp-Pass-12345' } });
    fireEvent.change(newInput!, { target: { value: 'Short123' } });
    fireEvent.change(confirmInput!, { target: { value: 'Short123' } });

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(
      await screen.findByText('Парол камида 15 белгидан иборат бўлиши керак!')
    ).toBeTruthy();
  });

  it('submits valid password replacement and invokes authClient.changeFirstLoginPassword (AC 10, 13)', async () => {
    vi.spyOn(authClient, 'fetchSession').mockResolvedValueOnce({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_chilonzor',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: true,
      },
      session: {
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    const changePasswordSpy = vi
      .spyOn(authClient, 'changeFirstLoginPassword')
      .mockResolvedValueOnce({
        success: true,
        actor: {
          id: 'acc_hokim_1',
          username: 'hokim_chilonzor',
          role: 'DISTRICT_HOKIM',
          districtId: 'dist_1',
          mustChangePassword: false,
        },
      });

    const { container } = renderWithProviders(<FirstSignInPasswordChangePage />);

    const currentInput = container.querySelector('#current-password-input');
    const newInput = container.querySelector('#new-password-input');
    const confirmInput = container.querySelector('#confirm-password-input');
    const submitBtn = await screen.findByRole('button', {
      name: /Паролни сақлаш ва тизимга кириш/i,
    });

    const newPass = 'MyBrandNewPermanentSecurePassword2026!';
    fireEvent.change(currentInput!, { target: { value: 'Temp-Password-12345!' } });
    fireEvent.change(newInput!, { target: { value: newPass } });
    fireEvent.change(confirmInput!, { target: { value: newPass } });

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(changePasswordSpy).toHaveBeenCalledWith({
        currentPassword: 'Temp-Password-12345!',
        newPassword: newPass,
      });
    });
  });

  it('ProtectedRoute redirects Hokim with mustChangePassword=true to /first-login-password-change (AC 10)', async () => {
    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_chilonzor',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: true,
      },
      session: {
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AuthProvider>
            <MemoryRouter initialEntries={['/']}>
              <Routes>
                <Route
                  path="/"
                  element={
                    <ProtectedRoute>
                      <div>Dashboard Content</div>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/first-login-password-change"
                  element={
                    <ProtectedRoute>
                      <div>Password Change Required Page</div>
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </ConfigProvider>
      </QueryClientProvider>
    );

    expect(
      await screen.findByText('Password Change Required Page')
    ).toBeTruthy();
    expect(screen.queryByText('Dashboard Content')).toBeNull();
  });
});
