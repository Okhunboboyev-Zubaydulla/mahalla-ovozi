import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ConfigProvider } from 'antd';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { FilterModalSheet } from '../../src/components/topics/FilterModalSheet.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { DashboardFilterState } from '../../src/hooks/useDashboardFilterParams.js';

describe('FilterModalSheet Component Tests', () => {
  let queryClient: QueryClient;

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

  const defaultFilters: DashboardFilterState = {
    dateScope: 'today',
    lanes: ['HOKIM_RELATED', 'WATER', 'ELECTRICITY', 'GAS', 'WASTE'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    queryClient.setQueryData(['auth', 'session'], {
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_user',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: false,
      },
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });

    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_user',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: false,
      },
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });

    vi.spyOn(hokimTopicsClient, 'getDistrictMahallas').mockResolvedValue(['Боғбон', 'Наврўз']);
  });

  const renderWithProviders = (ui: React.ReactElement) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AuthProvider>{ui}</AuthProvider>
        </ConfigProvider>
      </QueryClientProvider>,
    );
  };

  it('renders modal sheet title and action buttons when open', () => {
    renderWithProviders(
      <FilterModalSheet
        open={true}
        onClose={vi.fn()}
        filters={defaultFilters}
        onApplyFilters={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(screen.getByText('Фильтрлар')).toBeTruthy();
    expect(screen.getByText('Сана оралиғи')).toBeTruthy();
    expect(screen.getByText('Маҳалла')).toBeTruthy();
    expect(screen.getByText(/Йўналишлар/)).toBeTruthy();
    expect(screen.getByText('Тозалаш')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Барча фильтрларни тозалаш/ })).toBeTruthy();
    expect(screen.getByText('Бекор қилиш')).toBeTruthy();
    expect(screen.getByText('Қўллаш')).toBeTruthy();
  });

  it('clicking Apply calls onApplyFilters with pending filter state', () => {
    const handleApply = vi.fn();
    renderWithProviders(
      <FilterModalSheet
        open={true}
        onClose={vi.fn()}
        filters={defaultFilters}
        onApplyFilters={handleApply}
        onResetFilters={vi.fn()}
      />,
    );

    const applyButton = screen.getByText('Қўллаш');
    fireEvent.click(applyButton);

    expect(handleApply).toHaveBeenCalledTimes(1);
    expect(handleApply).toHaveBeenCalledWith(defaultFilters);
  });

  it('clicking Reset calls onResetFilters', () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <FilterModalSheet
        open={true}
        onClose={vi.fn()}
        filters={defaultFilters}
        onApplyFilters={vi.fn()}
        onResetFilters={handleReset}
      />,
    );

    const resetButton = screen.getByText('Тозалаш');
    fireEvent.click(resetButton);

    expect(handleReset).toHaveBeenCalledTimes(1);
  });

  it('renders 2-tier footer on mobile phones (<576px) without overflow', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 575px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderWithProviders(
      <FilterModalSheet
        open={true}
        onClose={vi.fn()}
        filters={defaultFilters}
        onApplyFilters={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(screen.getByText('Бекор қилиш')).toBeTruthy();
    expect(screen.getByText('Қўллаш')).toBeTruthy();
    expect(screen.getByText('Тозалаш')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Барча фильтрларни тозалаш/ })).toBeTruthy();
  });
});
