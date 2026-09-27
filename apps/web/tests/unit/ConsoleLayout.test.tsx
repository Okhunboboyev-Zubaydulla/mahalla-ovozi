import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConsoleLayout } from '../../src/components/ConsoleLayout.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { DistrictProvider } from '../../src/district/district-context.js';
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

function renderConsoleLayout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={mahallaTheme}>
        <AuthProvider>
          <BrowserRouter>
            <DistrictProvider>
              <ConsoleLayout />
            </DistrictProvider>
          </BrowserRouter>
        </AuthProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}

describe('ConsoleLayout Component Tests', () => {
  it('renders persistent Uzbek Cyrillic wordmark Маҳалла Овози (P5-H)', () => {
    renderConsoleLayout();
    expect(screen.getByText('Маҳалла Овози')).toBeTruthy();
  });

  it('renders all 8 approved persistent navigation sections in Uzbek Cyrillic', () => {
    renderConsoleLayout();

    expect(screen.getByText('Умумий кўриниш')).toBeTruthy();
    expect(screen.getByText('Тизим ҳолати')).toBeTruthy();
    expect(screen.getByText('Туманлар')).toBeTruthy();
    expect(screen.getByText('Телеграм созламалари')).toBeTruthy();
    expect(screen.getByText('Обуналар')).toBeTruthy();
    expect(screen.getByText('Ҳоким ҳисоблари')).toBeTruthy();
    expect(screen.getByText('АИ операциялари')).toBeTruthy();
    expect(screen.getByText('Аудит тарихи')).toBeTruthy();
  });

  it('renders sign-out button and district selector container', () => {
    renderConsoleLayout();

    expect(screen.getByRole('button', { name: /Чиқиш/i })).toBeTruthy();
    expect(screen.getByRole('combobox')).toBeTruthy();
  });
});

