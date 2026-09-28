import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ConfigProvider } from 'antd';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { FilterBar } from '../../src/components/topics/FilterBar.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { DashboardFilterState } from '../../src/hooks/useDashboardFilterParams.js';

describe('FilterBar Component Tests', () => {
  let queryClient: QueryClient;

  const defaultFilters: DashboardFilterState = {
    dateScope: 'today',
    lanes: ['HOKIM_RELATED', 'WATER', 'ELECTRICITY', 'GAS', 'WASTE'],
  };

  const customFilters: DashboardFilterState = {
    dateScope: 'yesterday',
    mahallaName: 'Наврўз',
    lanes: ['WATER', 'GAS'],
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

  it('renders date scope segment options: Бугун, Кеча, Сана бўйича', () => {
    renderWithProviders(
      <FilterBar
        filters={defaultFilters}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
        isDefaultFilters={true}
      />,
    );

    expect(screen.getByText('Бугун')).toBeTruthy();
    expect(screen.getByText('Кеча')).toBeTruthy();
    expect(screen.getByText('Сана бўйича')).toBeTruthy();
  });

  it('hides clear filters button when default filters are active', () => {
    renderWithProviders(
      <FilterBar
        filters={defaultFilters}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
        isDefaultFilters={true}
      />,
    );

    expect(screen.queryByText('Фильтрларни тозалаш')).toBeNull();
  });

  it('shows clear filters button when non-default filters are active and calls onResetFilters', () => {
    const handleReset = vi.fn();
    renderWithProviders(
      <FilterBar
        filters={customFilters}
        onFilterChange={vi.fn()}
        onResetFilters={handleReset}
        isDefaultFilters={false}
      />,
    );

    const clearButton = screen.getByText('Фильтрларни тозалаш');
    expect(clearButton).toBeTruthy();

    fireEvent.click(clearButton);
    expect(handleReset).toHaveBeenCalledTimes(1);
  });

  it('renders loading spinner when isLoading is true', () => {
    renderWithProviders(
      <FilterBar
        filters={defaultFilters}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
        isDefaultFilters={true}
        isLoading={true}
      />,
    );

    expect(screen.getByText('Юкланмоқда...')).toBeTruthy();
  });
});
