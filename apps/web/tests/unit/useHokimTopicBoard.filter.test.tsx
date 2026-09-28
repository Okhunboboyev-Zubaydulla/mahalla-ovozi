import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHokimTopicBoard } from '../../src/topics/useHokimTopicBoard.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { LiveAnnouncerContext, LiveAnnouncerContextValue } from '../../src/hooks/useLiveAnnouncer.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { TopicCardItem, HokimTopicBoardResponse } from '@mahalla-ovozi/api-contracts';
import { DashboardFilterState } from '../../src/hooks/useDashboardFilterParams.js';

const mockActor = {
  id: 'acc_hokim_1',
  username: 'hokim_yakkasaroy',
  role: 'DISTRICT_HOKIM' as const,
  districtId: 'dist_yakka_1',
  mustChangePassword: false,
};

const mockTopic: TopicCardItem = {
  id: 'top_1',
  districtId: 'dist_yakka_1',
  mahallaName: 'Наврўз',
  calendarDay: '2026-08-24',
  summary: 'Сув босими пастлиги бўйича мурожаатлар',
  primaryLane: 'WATER',
  lanes: ['WATER'],
  additionalLanes: [],
  evidenceCount: 3,
  latestMeaningfulActivityTimestamp: '2026-08-24T08:00:00.000Z',
  isNew: false,
  isUpdated: false,
  createdAt: '2026-08-24T07:30:00.000Z',
  updatedAt: '2026-08-24T08:00:00.000Z',
};

const mockBoardResponse: HokimTopicBoardResponse = {
  districtId: 'dist_yakka_1',
  districtName: 'Яккасарой тумани',
  calendarDay: '2026-08-24',
  evaluationId: '11111111-2222-4333-8444-555555555555',
  visitBaselineTimestamp: '2026-08-24T07:00:00.000Z',
  currentVisitTimestamp: '2026-08-24T08:30:00.000Z',
  serverEvaluatedAt: '2026-08-24T08:30:00.000Z',
  hasProcessingDelay: false,
  lanes: {
    HOKIM_RELATED: {
      lane: 'HOKIM_RELATED',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
    WATER: {
      lane: 'WATER',
      topics: [mockTopic],
      totalCount: 1,
      nextCursor: 'cursor_w2',
      hasNextPage: true,
    },
    ELECTRICITY: {
      lane: 'ELECTRICITY',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
    GAS: {
      lane: 'GAS',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
    WASTE: {
      lane: 'WASTE',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
  },
};

describe('Story 3.4: useHokimTopicBoard Filter Synchronization Tests', () => {
  let queryClient: QueryClient;
  const mockAnnounce = vi.fn();
  const mockAnnounceTopicUpdate = vi.fn();

  const mockAnnouncerValue: LiveAnnouncerContextValue = {
    message: '',
    announce: mockAnnounce,
    announceTopicUpdate: mockAnnounceTopicUpdate,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
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
        <AuthProvider>
          <LiveAnnouncerContext.Provider value={mockAnnouncerValue}>
            {children}
          </LiveAnnouncerContext.Provider>
        </AuthProvider>
      </QueryClientProvider>
    );
  };

  it('forwards filter parameters to hokimTopicsClient.getTodayBoard', async () => {
    const getTodayBoardSpy = vi
      .spyOn(hokimTopicsClient, 'getTodayBoard')
      .mockResolvedValue(mockBoardResponse);

    const customFilters: DashboardFilterState = {
      dateScope: 'custom',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-15',
      mahallaName: 'Наврўз',
      lanes: ['WATER', 'GAS'],
    };

    const { result } = renderHook(() => useHokimTopicBoard(customFilters), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.board).toBeDefined());

    expect(getTodayBoardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dateScope: 'custom',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-15',
        mahallaName: 'Наврўз',
        lanes: ['WATER', 'GAS'],
      }),
      expect.anything(),
    );

    expect(result.current.activeLanes).toEqual(['WATER', 'GAS']);
  });

  it('loadMore forwards applied filters to hokimTopicsClient.getLaneBatch', async () => {
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(mockBoardResponse);
    const getLaneBatchSpy = vi.spyOn(hokimTopicsClient, 'getLaneBatch').mockResolvedValue({
      lane: 'WATER',
      topics: [
        {
          ...mockTopic,
          id: 'top_w2',
          summary: 'Қўшимча сув муаммоси',
        },
      ],
      nextCursor: null,
      hasNextPage: false,
    });

    const customFilters: DashboardFilterState = {
      dateScope: 'yesterday',
      mahallaName: 'Наврўз',
      lanes: ['WATER'],
    };

    const { result } = renderHook(() => useHokimTopicBoard(customFilters), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.board).toBeDefined());

    await act(async () => {
      await result.current.loadMore('WATER');
    });

    expect(getLaneBatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: 'WATER',
        dateScope: 'yesterday',
        mahallaName: 'Наврўз',
        cursor: 'cursor_w2',
      }),
      expect.any(AbortSignal),
    );
  });
});
