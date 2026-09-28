import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTopicStatistics } from '../../src/topics/useTopicStatistics.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { HokimTopicStatisticsResponse } from '@mahalla-ovozi/api-contracts';
import { DashboardFilterState } from '../../src/hooks/useDashboardFilterParams.js';

const mockActor = {
  id: 'acc_hokim_1',
  username: 'hokim_user',
  role: 'DISTRICT_HOKIM' as const,
  districtId: 'dist_test_1',
  mustChangePassword: false,
};

const mockStatisticsResponse: HokimTopicStatisticsResponse = {
  districtId: 'dist_test_1',
  districtName: 'Яккасарой тумани',
  calendarDay: '2026-08-24',
  evaluationId: '11111111-2222-4333-8444-555555555555',
  serverEvaluatedAt: '2026-08-24T10:00:00.000Z',
  totalUniqueTopics: 12,
  card1Comparison: {
    isAvailable: true,
    previousValue: 10,
    delta: 2,
    comparisonPeriodType: 'equivalent_same_time_yesterday',
    comparisonPeriodLabel: 'кечаги шу вақтга нисбатан',
  },
  hokimRelatedTopics: 3,
  hokimEvidenceCount: 8,
  activeMahallasCount: 4,
  totalAcceptedEvidenceCount: 25,
  card4: {
    mode: 'most_active_service_lane',
    leaderLane: 'WATER',
    leaderTopicCount: 6,
    isTie: false,
    tiedCount: 0,
    isZero: false,
  },
  card5: {
    mode: 'most_active_mahalla',
    leaderMahalla: 'Наврўз',
    leaderTopicCount: 5,
    isTie: false,
    tiedCount: 0,
    isZero: false,
  },
};

describe('useTopicStatistics Hook Unit Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    queryClient.setQueryData(['auth', 'session'], {
      actor: mockActor,
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });

    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: mockActor,
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });
  });

  const createWrapper = () => {
    return ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };

  it('fetches and returns topic statistics for default filters', async () => {
    const getStatsSpy = vi
      .spyOn(hokimTopicsClient, 'getStatistics')
      .mockResolvedValue(mockStatisticsResponse);

    const { result } = renderHook(() => useTopicStatistics(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.statistics).toEqual(mockStatisticsResponse);
    expect(getStatsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dateScope: 'today',
        lanes: ['HOKIM_RELATED', 'WATER', 'ELECTRICITY', 'GAS', 'WASTE'],
      }),
      expect.any(AbortSignal),
    );
  });

  it('passes customized date, mahalla, and lane filters to client', async () => {
    const getStatsSpy = vi
      .spyOn(hokimTopicsClient, 'getStatistics')
      .mockResolvedValue(mockStatisticsResponse);

    const customFilters: DashboardFilterState = {
      dateScope: 'yesterday',
      mahallaName: 'Боғбон',
      lanes: ['WATER', 'GAS'],
    };

    const { result } = renderHook(() => useTopicStatistics(customFilters), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(getStatsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dateScope: 'yesterday',
        mahallaName: 'Боғбон',
        lanes: ['WATER', 'GAS'],
      }),
      expect.any(AbortSignal),
    );
  });

  it('preserves previous statistics as placeholder data during filter transitions to prevent flickering (AC 4, AC 5)', async () => {
    vi.spyOn(hokimTopicsClient, 'getStatistics').mockResolvedValue(mockStatisticsResponse);

    let currentFilters: DashboardFilterState = {
      dateScope: 'today',
      lanes: ['WATER', 'GAS'],
    };

    const { result, rerender } = renderHook(
      ({ filters }) => useTopicStatistics(filters),
      {
        initialProps: { filters: currentFilters },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current.statistics).toBeDefined();
    });

    expect(result.current.statistics?.totalUniqueTopics).toBe(12);

    // Switch date scope / lanes
    currentFilters = {
      dateScope: 'yesterday',
      lanes: ['WATER', 'GAS'],
    };

    // Slow down next fetch to inspect in-flight transition state
    vi.spyOn(hokimTopicsClient, 'getStatistics').mockImplementation(
      () => new Promise(() => {}), // never resolving in-flight promise
    );

    rerender({ filters: currentFilters });

    // On filter transition, previous statistics remain available to prevent skeleton flicker
    expect(result.current.statistics).toBeDefined();
    expect(result.current.statistics?.totalUniqueTopics).toBe(12);
    expect(result.current.isFetching).toBe(true);
  });

  it('exposes evaluationId from statistics response (AC 1, AC 3)', async () => {
    const statsWithEvaluation: HokimTopicStatisticsResponse = {
      ...mockStatisticsResponse,
      evaluationId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    };
    vi.spyOn(hokimTopicsClient, 'getStatistics').mockResolvedValue(statsWithEvaluation);

    const { result } = renderHook(() => useTopicStatistics(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.evaluationId).toBe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  });

  it('handles query errors cleanly (AC 4)', async () => {
    vi.spyOn(hokimTopicsClient, 'getStatistics').mockRejectedValue(
      new Error('Статистикани юклаб бўлмади'),
    );

    const { result } = renderHook(() => useTopicStatistics(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
