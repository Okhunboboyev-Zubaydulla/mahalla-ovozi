import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignInPage } from '../../src/pages/SignInPage.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

// Setup window.matchMedia mock for Ant Design
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

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

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

describe('SignInPage Component Tests', () => {
  it('renders all required Uzbek Cyrillic elements', async () => {
    renderWithProviders(<SignInPage />);

    expect(await screen.findByText('Тизимга кириш')).toBeTruthy();
    expect(screen.getByText('Фойдаланувчи номи')).toBeTruthy();
    expect(screen.getByText('Парол')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Кириш/i })).toBeTruthy();
  });

  it('contains zero public registration or social login links', async () => {
    renderWithProviders(<SignInPage />);
    await screen.findByRole('button', { name: /Кириш/i });

    expect(screen.queryByText(/Рўйхатдан ўтиш/i)).toBeNull();
    expect(screen.queryByText(/Sign up/i)).toBeNull();
    expect(screen.queryByText(/Google/i)).toBeNull();
    expect(screen.queryByText(/Telegram orqali/i)).toBeNull();
    expect(screen.queryByText(/Паролни тиклаш/i)).toBeNull();
  });

  it('validates required fields on empty submit', async () => {
    renderWithProviders(<SignInPage />);

    const submitBtn = await screen.findByRole('button', { name: /Кириш/i });
    fireEvent.click(submitBtn);

    expect(await screen.findByText('Фойдаланувчи номини киритинг!')).toBeTruthy();
    expect(screen.getByText('Паролингизни киритинг!')).toBeTruthy();
  });
});
