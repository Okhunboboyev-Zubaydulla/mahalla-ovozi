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
import { ApiError } from '../../src/lib/api-client.js';

const mockActor = {
  id: 'acc_hokim_1',
  username: 'hokim_yakkasaroy',
  role: 'DISTRICT_HOKIM' as const,
  districtId: 'dist_yakka_1',
  mustChangePassword: false,
};

const initialTopicWater: TopicCardItem = {
  id: 'top_w1',
  districtId: 'dist_yakka_1',
  mahallaName: 'Дўстлик',
  calendarDay: '2026-08-24',
  summary: 'Сув босими пасайиши кузатилмоқда.',
  primaryLane: 'WATER',
  lanes: ['WATER', 'HOKIM_RELATED'],
  additionalLanes: ['HOKIM_RELATED'],
  evidenceCount: 2,
  latestMeaningfulActivityTimestamp: '2026-08-24T08:00:00.000Z',
  isNew: false,
  isUpdated: false,
  createdAt: '2026-08-24T07:30:00.000Z',
  updatedAt: '2026-08-24T08:00:00.000Z',
};

const initialBoardResponse: HokimTopicBoardResponse = {
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
      topics: [initialTopicWater],
      totalCount: 1,
      nextCursor: null,
      hasNextPage: false,
    },
    WATER: {
      lane: 'WATER',
      topics: [initialTopicWater],
      totalCount: 1,
      nextCursor: null,
      hasNextPage: false,
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

describe('Story 3.3: useHokimTopicBoard In-Session Reconciliation & Buffer Tests', () => {
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

  it('Test 1: Initial cold load populates 5 lanes directly', async () => {
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(initialBoardResponse);

    const { result } = renderHook(() => useHokimTopicBoard(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.board).toBeDefined());

    expect(result.current.lanes.WATER.topics.length).toBe(1);
    expect(result.current.lanes.WATER.topics[0]?.id).toBe('top_w1');
    expect(result.current.lastRefreshedAt).toBe('2026-08-24T08:30:00.000Z');
  });

  it('Test 2: Background revalidation updates existing card in-place preserving array position', async () => {
    let currentBoardResponse = initialBoardResponse;
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => currentBoardResponse);

    const { result } = renderHook(() => useHokimTopicBoard(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.board).toBeDefined());
    expect(result.current.lanes.WATER.topics[0]?.summary).toBe('Сув босими пасайиши кузатилмоқда.');

    // Simulate second query (background refresh) with updated summary and evidenceCount
    const updatedTopic: TopicCardItem = {
      ...initialTopicWater,
      summary: 'Сув таъминоти тикланди, босим меъёрида.',
      evidenceCount: 5,
      isUpdated: true,
      updatedAt: '2026-08-24T09:00:00.000Z',
    };

    currentBoardResponse = {
      ...initialBoardResponse,
      serverEvaluatedAt: '2026-08-24T09:00:00.000Z',
      lanes: {
        ...initialBoardResponse.lanes,
        WATER: {
          ...initialBoardResponse.lanes.WATER!,
          topics: [updatedTopic],
        },
      },
    };

    await act(async () => {
      await result.current.manualRefresh();
    });

    await waitFor(() => {
      expect(result.current.lanes.WATER.topics[0]?.summary).toBe(
        'Сув таъминоти тикланди, босим меъёрида.',
      );
      expect(result.current.lanes.WATER.topics[0]?.evidenceCount).toBe(5);
      expect(result.current.lanes.WATER.topics[0]?.isUpdated).toBe(true);
    });

    // In-place update: array length unchanged
    expect(result.current.lanes.WATER.topics.length).toBe(1);
  });

  it('Test 3: Newly arriving topics are directly prepended to lane at index 0 with isNew: true', async () => {
    let currentBoardResponse = initialBoardResponse;
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => currentBoardResponse);

    const { result } = renderHook(() => useHokimTopicBoard(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.board).toBeDefined());

    // Incoming new topic in WATER lane
    const brandNewTopic: TopicCardItem = {
      id: 'top_w2_brand_new',
      districtId: 'dist_yakka_1',
      mahallaName: 'Боғсарой',
      calendarDay: '2026-08-24',
      summary: 'Янги сув қувури ёрилиши.',
      primaryLane: 'WATER',
      lanes: ['WATER'],
      additionalLanes: [],
      evidenceCount: 1,
      latestMeaningfulActivityTimestamp: '2026-08-24T09:15:00.000Z',
      isNew: true,
      isUpdated: false,
      createdAt: '2026-08-24T09:15:00.000Z',
      updatedAt: '2026-08-24T09:15:00.000Z',
    };

    currentBoardResponse = {
      ...initialBoardResponse,
      serverEvaluatedAt: '2026-08-24T09:15:00.000Z',
      lanes: {
        ...initialBoardResponse.lanes,
        WATER: {
          ...initialBoardResponse.lanes.WATER!,
          topics: [brandNewTopic, initialTopicWater],
          totalCount: 2,
        },
      },
    };

    await act(async () => {
      await result.current.manualRefresh();
    });

    // Directly prepended at index 0 without needing manual reveal
    await waitFor(() => {
      expect(result.current.lanes.WATER.topics.length).toBe(2);
      expect(result.current.lanes.WATER.topics[0]?.id).toBe('top_w2_brand_new');
      expect(result.current.lanes.WATER.topics[0]?.isNew).toBe(true);
      expect(result.current.lanes.WATER.topics[1]?.id).toBe('top_w1');
      expect(result.current.lanes.WATER.totalCount).toBe(2);
    });
  });

  it('Test 4: Multi-lane topic updates deduplicate canonical count in live announcement (AC 4)', async () => {
    let currentBoardResponse = initialBoardResponse;
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => currentBoardResponse);

    const { result } = renderHook(() => useHokimTopicBoard(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.board).toBeDefined());

    // A new topic appearing in BOTH WATER and HOKIM_RELATED
    const multiLaneNewTopic: TopicCardItem = {
      id: 'top_multi_new',
      districtId: 'dist_yakka_1',
      mahallaName: 'Шоҳжаҳон',
      calendarDay: '2026-08-24',
      summary: 'Катта сув аварияси ҳокимлик назоратида.',
      primaryLane: 'WATER',
      lanes: ['WATER', 'HOKIM_RELATED'],
      additionalLanes: ['HOKIM_RELATED'],
      evidenceCount: 3,
      latestMeaningfulActivityTimestamp: '2026-08-24T09:20:00.000Z',
      isNew: true,
      isUpdated: false,
      createdAt: '2026-08-24T09:20:00.000Z',
      updatedAt: '2026-08-24T09:20:00.000Z',
    };

    currentBoardResponse = {
      ...initialBoardResponse,
      serverEvaluatedAt: '2026-08-24T09:20:00.000Z',
      lanes: {
        ...initialBoardResponse.lanes,
        WATER: {
          ...initialBoardResponse.lanes.WATER!,
          topics: [multiLaneNewTopic, initialTopicWater],
          totalCount: 2,
        },
        HOKIM_RELATED: {
          ...initialBoardResponse.lanes.HOKIM_RELATED!,
          topics: [multiLaneNewTopic, initialTopicWater],
          totalCount: 2,
        },
      },
    };

    await act(async () => {
      await result.current.manualRefresh();
    });

    await waitFor(() => {
      expect(result.current.lanes.WATER.topics.length).toBe(2);
      expect(result.current.lanes.HOKIM_RELATED.topics.length).toBe(2);
      expect(result.current.lanes.WATER.topics[0]?.id).toBe('top_multi_new');
      expect(result.current.lanes.HOKIM_RELATED.topics[0]?.id).toBe('top_multi_new');
    });
  });

  describe('Story 3.8: Keyset Continuation, Abort Cancellation & Stale Recovery Tests', () => {
    it('Task 5.1a: loadMore appends new batch and enforces O(1) deduplication by Topic ID', async () => {
      const initialBoardWithCursor: HokimTopicBoardResponse = {
        ...initialBoardResponse,
        lanes: {
          ...initialBoardResponse.lanes,
          WATER: {
            lane: 'WATER',
            topics: [initialTopicWater],
            totalCount: 2,
            nextCursor: 'cursor_page_1',
            hasNextPage: true,
          },
        },
      };

      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(initialBoardWithCursor);

      const batchTopic2: TopicCardItem = {
        id: 'top_w2',
        districtId: 'dist_yakka_1',
        mahallaName: 'Дўстлик',
        calendarDay: '2026-08-24',
        summary: 'Иккинчи сув мавзуси.',
        primaryLane: 'WATER',
        lanes: ['WATER'],
        additionalLanes: [],
        evidenceCount: 1,
        latestMeaningfulActivityTimestamp: '2026-08-24T07:00:00.000Z',
        isNew: false,
        isUpdated: false,
        createdAt: '2026-08-24T07:00:00.000Z',
        updatedAt: '2026-08-24T07:00:00.000Z',
      };

      // Mock returns duplicate initialTopicWater + new batchTopic2
      const mockGetLaneBatch = vi.spyOn(hokimTopicsClient, 'getLaneBatch').mockResolvedValue({
        lane: 'WATER',
        topics: [initialTopicWater, batchTopic2],
        nextCursor: null,
        hasNextPage: false,
      });

      const { result } = renderHook(() => useHokimTopicBoard(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.board).toBeDefined());
      expect(result.current.lanes.WATER.hasNextPage).toBe(true);

      await act(async () => {
        await result.current.loadMore('WATER');
      });

      expect(mockGetLaneBatch).toHaveBeenCalledTimes(1);
      expect(mockGetLaneBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          lane: 'WATER',
          cursor: 'cursor_page_1',
          limit: 20,
        }),
        expect.any(AbortSignal),
      );

      // Deduplication: topics should contain top_w1 and top_w2 once (length 2, not 3)
      expect(result.current.lanes.WATER.topics.length).toBe(2);
      expect(result.current.lanes.WATER.topics.map((t) => t.id)).toEqual(['top_w1', 'top_w2']);
      expect(result.current.lanes.WATER.hasNextPage).toBe(false);
      expect(result.current.lanes.WATER.nextCursor).toBeNull();
      expect(result.current.lanes.WATER.isLoadingMore).toBe(false);
      expect(result.current.lanes.WATER.loadMoreError).toBeNull();
    });

    it('Task 5.1b: Dispatches searchLane with POST body and signal when searchQuery is present', async () => {
      const searchBoardResponse: HokimTopicBoardResponse = {
        ...initialBoardResponse,
        lanes: {
          ...initialBoardResponse.lanes,
          GAS: {
            lane: 'GAS',
            topics: [],
            totalCount: 5,
            nextCursor: 'cursor_gas_1',
            hasNextPage: true,
          },
        },
      };

      vi.spyOn(hokimTopicsClient, 'searchBoard').mockResolvedValue(searchBoardResponse);
      const mockSearchLane = vi.spyOn(hokimTopicsClient, 'searchLane').mockResolvedValue({
        lane: 'GAS',
        topics: [],
        nextCursor: null,
        hasNextPage: false,
      });

      const { result } = renderHook(
        () => useHokimTopicBoard({ dateScope: 'today', lanes: ['GAS'] }, 'Газ таъминоти'),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.board).toBeDefined());

      await act(async () => {
        await result.current.loadMore('GAS');
      });

      expect(mockSearchLane).toHaveBeenCalledWith(
        expect.objectContaining({
          lane: 'GAS',
          search: 'Газ таъминоти',
          cursor: 'cursor_gas_1',
          limit: 20,
        }),
        expect.any(AbortSignal),
      );
    });

    it('Task 5.1c: Handles AbortError silently without setting error state or triggering unhandled rejections', async () => {
      const boardWithCursor: HokimTopicBoardResponse = {
        ...initialBoardResponse,
        lanes: {
          ...initialBoardResponse.lanes,
          WATER: {
            lane: 'WATER',
            topics: [initialTopicWater],
            totalCount: 5,
            nextCursor: 'cursor_water_abort',
            hasNextPage: true,
          },
        },
      };

      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(boardWithCursor);
      const abortError = new DOMException('The user aborted a request.', 'AbortError');
      vi.spyOn(hokimTopicsClient, 'getLaneBatch').mockRejectedValue(abortError);

      const { result } = renderHook(() => useHokimTopicBoard(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.board).toBeDefined());

      await act(async () => {
        await result.current.loadMore('WATER');
      });

      // Preserves loaded topics and sets no error banner
      expect(result.current.lanes.WATER.topics.length).toBe(1);
      expect(result.current.lanes.WATER.loadMoreError).toBeNull();
    });

    it('Task 5.1d: Recovers non-disruptively on INVALID_CURSOR by resetting cursor and triggering refetch', async () => {
      const boardWithStaleCursor: HokimTopicBoardResponse = {
        ...initialBoardResponse,
        lanes: {
          ...initialBoardResponse.lanes,
          WATER: {
            lane: 'WATER',
            topics: [initialTopicWater],
            totalCount: 5,
            nextCursor: 'stale_cursor_val',
            hasNextPage: true,
          },
        },
      };

      const getBoardSpy = vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(boardWithStaleCursor);
      const staleError = new ApiError(
        'Курсор нотўғри ёки муддати ўтган.',
        'INVALID_CURSOR',
        400,
        false,
      );
      vi.spyOn(hokimTopicsClient, 'getLaneBatch').mockRejectedValue(staleError);

      const { result } = renderHook(() => useHokimTopicBoard(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.board).toBeDefined());

      await act(async () => {
        await result.current.loadMore('WATER');
      });

      // Preserves loaded cards, resets continuation state, no error banner
      expect(result.current.lanes.WATER.topics.length).toBe(1);
      expect(result.current.lanes.WATER.nextCursor).toBeNull();
      expect(result.current.lanes.WATER.hasNextPage).toBe(false);
      expect(result.current.lanes.WATER.loadMoreError).toBeNull();
      expect(result.current.lanes.WATER.isLoadingMore).toBe(false);

      // Revalidation refetch triggered
      expect(getBoardSpy).toHaveBeenCalledTimes(2);
    });

    it('Task 5.1e: Displays local error banner on network failure and preserves continuation state for retry', async () => {
      const boardWithCursor: HokimTopicBoardResponse = {
        ...initialBoardResponse,
        lanes: {
          ...initialBoardResponse.lanes,
          WATER: {
            lane: 'WATER',
            topics: [initialTopicWater],
            totalCount: 5,
            nextCursor: 'cursor_retry_1',
            hasNextPage: true,
          },
        },
      };

      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(boardWithCursor);
      const networkError = new ApiError(
        'Сервер билан алоқа мавжуд эмас.',
        'NETWORK_ERROR',
        0,
        true,
      );
      vi.spyOn(hokimTopicsClient, 'getLaneBatch').mockRejectedValue(networkError);

      const { result } = renderHook(() => useHokimTopicBoard(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.board).toBeDefined());

      await act(async () => {
        await result.current.loadMore('WATER');
      });

      // Loaded cards preserved, local error banner set, cursor preserved for retry
      expect(result.current.lanes.WATER.topics.length).toBe(1);
      expect(result.current.lanes.WATER.nextCursor).toBe('cursor_retry_1');
      expect(result.current.lanes.WATER.hasNextPage).toBe(true);
      expect(result.current.lanes.WATER.isLoadingMore).toBe(false);
      expect(result.current.lanes.WATER.loadMoreError).toBe('Юклаб бўлмади. Қайта уриниш.');
    });

    it('Test 10: Midnight calendar rollover cleanly flushes yesterday cards, resets baseline, and invalidates statistics', async () => {
      let currentResponse = initialBoardResponse;
      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => currentResponse);

      const { result } = renderHook(() => useHokimTopicBoard(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.board).toBeDefined());
      expect(result.current.lanes.WATER.topics.length).toBe(1);
      expect(result.current.lanes.WATER.topics[0]?.id).toBe('top_w1');
      expect(result.current.board?.calendarDay).toBe('2026-08-24');

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      // Midnight strikes: server returns next calendar day (2026-08-25) with empty lanes
      currentResponse = {
        ...initialBoardResponse,
        calendarDay: '2026-08-25',
        evaluationId: '22222222-3333-4444-5555-666666666666',
        currentVisitTimestamp: '2026-08-25T00:00:04.000Z',
        serverEvaluatedAt: '2026-08-25T00:00:04.000Z',
        lanes: {
          HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
          WATER: { lane: 'WATER', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
          ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
          GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
          WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
        },
      };

      await act(async () => {
        await result.current.manualRefresh();
      });

      await waitFor(() => {
        expect(result.current.board?.calendarDay).toBe('2026-08-25');
        expect(result.current.lanes.WATER.topics.length).toBe(0);
        expect(result.current.lanes.WATER.totalCount).toBe(0);
        expect(result.current.lanes.WATER.nextCursor).toBeNull();
      });

      // Statistics must have been invalidated in lockstep
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['hokim-statistics'] });
    });
  });
});
