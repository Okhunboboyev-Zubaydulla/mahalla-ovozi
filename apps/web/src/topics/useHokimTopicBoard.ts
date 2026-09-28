import { useState, useEffect, useCallback, useRef, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  QualifyingLane,
  TopicCardItem,
  HokimLaneBoardData,
  HokimTopicBoardResponse,
  CANONICAL_LANES,
} from '@mahalla-ovozi/api-contracts';
import { hokimTopicsClient } from './hokim-topics-client.js';
import { useAuth } from '../auth/auth-context.js';
import { LiveAnnouncerContext } from '../hooks/useLiveAnnouncer.js';
import { DashboardFilterState } from '../hooks/useDashboardFilterParams.js';
import { useTopicReadState } from '../hooks/useTopicReadState.js';
import { ApiError } from '../lib/api-client.js';

export interface LaneLocalState extends HokimLaneBoardData {
  isLoadingMore: boolean;
  loadMoreError: string | null;
}

function buildInitialLanesState(
  incomingLanes?: Partial<Record<QualifyingLane, HokimLaneBoardData>>,
): Record<QualifyingLane, LaneLocalState> {
  const result = {} as Record<QualifyingLane, LaneLocalState>;
  for (const k of CANONICAL_LANES) {
    const laneData = incomingLanes?.[k];
    result[k] = {
      lane: k,
      topics: laneData?.topics || [],
      totalCount: laneData?.totalCount || 0,
      nextCursor: laneData?.nextCursor ?? null,
      hasNextPage: Boolean(laneData?.hasNextPage),
      isLoadingMore: false,
      loadMoreError: null,
    };
  }
  return result;
}

function extractTopicIds(
  incomingLanes?: Partial<Record<QualifyingLane, HokimLaneBoardData>>,
): Set<string> {
  const ids = new Set<string>();
  if (incomingLanes) {
    for (const k of CANONICAL_LANES) {
      for (const t of incomingLanes[k]?.topics || []) {
        ids.add(t.id);
      }
    }
  }
  return ids;
}

function extractTopicTimestamps(
  incomingLanes?: Partial<Record<QualifyingLane, HokimLaneBoardData>>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (incomingLanes) {
    for (const k of CANONICAL_LANES) {
      for (const t of incomingLanes[k]?.topics || []) {
        map.set(t.id, t.updatedAt);
      }
    }
  }
  return map;
}

export interface UseHokimTopicBoardOptions {
  isPaused?: boolean;
}

export function useHokimTopicBoard(
  appliedFilters?: DashboardFilterState | string,
  searchQuery?: string,
  options?: UseHokimTopicBoardOptions,
) {
  const { actor } = useAuth();
  const districtId = actor?.districtId || '';
  const liveAnnouncer = useContext(LiveAnnouncerContext);
  const liveAnnouncerRef = useRef(liveAnnouncer);
  liveAnnouncerRef.current = liveAnnouncer;

  const { observeTopics } = useTopicReadState();
  const observeTopicsRef = useRef(observeTopics);
  observeTopicsRef.current = observeTopics;

  const queryClient = useQueryClient();

  const filterState: DashboardFilterState = useMemo(() => {
    if (typeof appliedFilters === 'string') {
      return { dateScope: 'today', lanes: [...CANONICAL_LANES] };
    }
    return (
      appliedFilters ?? {
        dateScope: 'today',
        lanes: [...CANONICAL_LANES],
      }
    );
  }, [appliedFilters]);

  const trimmedSearch = searchQuery?.trim() || '';

  const queryKey = [
    'hokim-board',
    districtId,
    filterState.dateScope,
    filterState.dateFrom ?? null,
    filterState.dateTo ?? null,
    filterState.mahallaName ?? null,
    filterState.lanes.join(','),
    trimmedSearch || null,
  ];

  // Reset baseline, known topic tracking, and in-flight requests when scope changes
  const currentScopeKey = `${districtId}:${filterState.dateScope}:${filterState.dateFrom || ''}:${filterState.dateTo || ''}:${filterState.mahallaName || ''}:${filterState.lanes.join(',')}:${trimmedSearch}`;
  const currentScopeKeyRef = useRef<string>(currentScopeKey);
  currentScopeKeyRef.current = currentScopeKey;

  const cachedBoard = queryClient.getQueryData<HokimTopicBoardResponse>(queryKey);

  const [lanesState, setLanesState] = useState<Record<QualifyingLane, LaneLocalState>>(() =>
    buildInitialLanesState(cachedBoard?.lanes),
  );

  const lanesStateRef = useRef(lanesState);
  lanesStateRef.current = lanesState;

  const baselineTimestampRef = useRef<string | null>(
    cachedBoard?.currentVisitTimestamp ?? null,
  );
  const activeCalendarDayRef = useRef<string | null>(cachedBoard?.calendarDay ?? null);
  const isInitialLoadRef = useRef<boolean>(!cachedBoard?.lanes);
  const previousKnownTopicIdsRef = useRef<Set<string>>(extractTopicIds(cachedBoard?.lanes));
  const previousTopicTimestampsRef = useRef<Map<string, string>>(extractTopicTimestamps(cachedBoard?.lanes));
  const laneAbortControllersRef = useRef<Map<QualifyingLane, AbortController>>(new Map());

  const prevScopeKeyRef = useRef<string>(currentScopeKey);
  if (prevScopeKeyRef.current !== currentScopeKey) {
    prevScopeKeyRef.current = currentScopeKey;
    const scopedCachedData = queryClient.getQueryData<HokimTopicBoardResponse>(queryKey);
    if (scopedCachedData?.lanes) {
      isInitialLoadRef.current = false;
      baselineTimestampRef.current = scopedCachedData.currentVisitTimestamp;
      activeCalendarDayRef.current = scopedCachedData.calendarDay ?? null;
      previousKnownTopicIdsRef.current = extractTopicIds(scopedCachedData.lanes);
      previousTopicTimestampsRef.current = extractTopicTimestamps(scopedCachedData.lanes);
      const cachedLanes = buildInitialLanesState(scopedCachedData.lanes);
      lanesStateRef.current = cachedLanes;
      setLanesState(cachedLanes);
    } else {
      isInitialLoadRef.current = true;
      baselineTimestampRef.current = null;
      activeCalendarDayRef.current = null;
      previousKnownTopicIdsRef.current.clear();
      previousTopicTimestampsRef.current.clear();
      // Keep existing displayed lanes via placeholderData while the new filter scope loads
      // to avoid flashing an empty board banner.
    }
    laneAbortControllersRef.current.forEach((ctrl) => ctrl.abort());
    laneAbortControllersRef.current.clear();
  }

  // Abort all in-flight requests on hook unmount
  useEffect(() => {
    return () => {
      laneAbortControllersRef.current.forEach((ctrl) => ctrl.abort());
      laneAbortControllersRef.current.clear();
    };
  }, []);

  const configuredRetry = queryClient.getDefaultOptions().queries?.retry;
  const effectiveRetry = configuredRetry !== undefined ? configuredRetry : 2;

  const boardQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (trimmedSearch) {
        return hokimTopicsClient.searchBoard(
          {
            search: trimmedSearch,
            dateScope: filterState.dateScope,
            dateFrom: filterState.dateFrom,
            dateTo: filterState.dateTo,
            mahallaName: filterState.mahallaName,
            lanes: filterState.lanes,
            baselineTimestamp: baselineTimestampRef.current ?? undefined,
          },
          signal,
        );
      }
      return hokimTopicsClient.getTodayBoard(
        {
          dateScope: filterState.dateScope,
          dateFrom: filterState.dateFrom,
          dateTo: filterState.dateTo,
          mahallaName: filterState.mahallaName,
          lanes: filterState.lanes,
          baselineTimestamp: baselineTimestampRef.current ?? undefined,
        },
        signal,
      );
    },
    enabled: Boolean(districtId && actor?.role === 'DISTRICT_HOKIM'),
    placeholderData: (previousData, previousQuery) => {
      if (!previousData || !previousQuery) return undefined;
      const prevDistrictId = previousQuery.queryKey[1];
      if (prevDistrictId !== districtId) {
        return undefined;
      }
      return previousData;
    },
    staleTime: 2_000,
    refetchInterval: options?.isPaused ? false : 4_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    networkMode: 'online',
    retry: effectiveRetry,
  });

  // Reconcile board data on initial load and subsequent background/manual refreshes (AC 1, 2, 3, 4)
  useEffect(() => {
    if (boardQuery.isPlaceholderData || !boardQuery.data?.lanes) {
      return;
    }

    const incomingLanes = boardQuery.data.lanes;
    const incomingCalendarDay = boardQuery.data.calendarDay;
    const isDayRollover = Boolean(
      activeCalendarDayRef.current &&
      incomingCalendarDay &&
      activeCalendarDayRef.current !== incomingCalendarDay,
    );

    if (isInitialLoadRef.current || isDayRollover) {
      // 1. Initial Cold Load or Midnight Day Rollover: Establish baseline and populate lanes directly
      isInitialLoadRef.current = false;
      activeCalendarDayRef.current = incomingCalendarDay ?? null;
      baselineTimestampRef.current = boardQuery.data.currentVisitTimestamp;

      const newLanes: Record<QualifyingLane, LaneLocalState> = {} as Record<QualifyingLane, LaneLocalState>;
      const initialIds = new Set<string>();
      const initialTimestamps = new Map<string, string>();
      const allInitialTopics: TopicCardItem[] = [];

      for (const k of CANONICAL_LANES) {
        const laneData = incomingLanes[k];
        const topics = laneData?.topics || [];
        for (const t of topics) {
          allInitialTopics.push(t);
          initialIds.add(t.id);
          initialTimestamps.set(t.id, t.updatedAt);
        }

        newLanes[k] = {
          lane: k,
          topics,
          totalCount: laneData?.totalCount || 0,
          nextCursor: laneData?.nextCursor ?? null,
          hasNextPage: Boolean(laneData?.hasNextPage),
          isLoadingMore: false,
          loadMoreError: null,
        };
      }

      previousKnownTopicIdsRef.current = initialIds;
      previousTopicTimestampsRef.current = initialTimestamps;
      lanesStateRef.current = newLanes;
      setLanesState(newLanes);
      observeTopicsRef.current(allInitialTopics);

      if (isDayRollover) {
        // Cancel in-flight lane pagination from yesterday
        laneAbortControllersRef.current.forEach((ctrl) => ctrl.abort());
        laneAbortControllersRef.current.clear();
        // Invalidate statistics query immediately in lockstep with day rollover
        void queryClient.invalidateQueries({ queryKey: ['hokim-statistics'] });
      }
    } else {
      activeCalendarDayRef.current = incomingCalendarDay ?? null;
      // 2. In-Session Reconciliation: Preserve existing card positions, directly prepend new topics at index 0
      const newCanonicalTopicIds = new Set<string>();
      const updatedCanonicalTopicIds = new Set<string>();
      const currentKnownIds = previousKnownTopicIdsRef.current;
      const currentTimestamps = previousTopicTimestampsRef.current;
      const prevLanes = lanesStateRef.current;

      const updatedLanes: Record<QualifyingLane, LaneLocalState> = {} as Record<QualifyingLane, LaneLocalState>;
      const allPrependedItems: TopicCardItem[] = [];

      for (const k of CANONICAL_LANES) {
        const prevLane = prevLanes[k];
        const incomingLane = incomingLanes[k];
        if (!incomingLane) {
          updatedLanes[k] = prevLane;
          continue;
        }

        // Build map of incoming topics by ID for this lane
        const incomingMap = new Map<string, TopicCardItem>();
        for (const item of incomingLane.topics) {
          incomingMap.set(item.id, item);
        }

        // Reconcile existing visible topics in-place (preserving exact indices & pagination pages)
        const existingVisibleIds = new Set<string>();
        const reconciledTopics: TopicCardItem[] = prevLane.topics.map((existingItem) => {
          existingVisibleIds.add(existingItem.id);
          const freshItem = incomingMap.get(existingItem.id);
          if (freshItem) {
            // Check if updated
            const prevTs = currentTimestamps.get(existingItem.id);
            if (freshItem.isUpdated || (prevTs && freshItem.updatedAt !== prevTs)) {
              updatedCanonicalTopicIds.add(existingItem.id);
            }
            return { ...existingItem, ...freshItem };
          }
          return existingItem;
        });

        // Identify newly incoming topics for this lane to prepend directly to the lane
        const itemsToPrepend: TopicCardItem[] = [];

        for (const item of incomingLane.topics) {
          if (!existingVisibleIds.has(item.id)) {
            // Not visible on screen yet -> new arrival
            if (!currentKnownIds.has(item.id)) {
              newCanonicalTopicIds.add(item.id);
            }
            itemsToPrepend.push(item);
            allPrependedItems.push(item);
            existingVisibleIds.add(item.id);
          }
        }

        const mergedTopics = [...itemsToPrepend, ...reconciledTopics];

        updatedLanes[k] = {
          ...prevLane,
          topics: mergedTopics,
          totalCount: incomingLane.totalCount,
          // Keep existing nextCursor/hasNextPage unless not paginated yet
          nextCursor: prevLane.nextCursor ?? incomingLane.nextCursor,
          hasNextPage: prevLane.hasNextPage || incomingLane.hasNextPage,
        };
      }

      lanesStateRef.current = updatedLanes;
      setLanesState(updatedLanes);
      if (allPrependedItems.length > 0) {
        observeTopicsRef.current(allPrependedItems);
      }

      // Deduplicate: remove any ID from updated if it is newly added (AC 4)
      for (const id of newCanonicalTopicIds) {
        updatedCanonicalTopicIds.delete(id);
      }

      // Emit atomic polite screen reader announcement if changes occurred (AC 4)
      const newCount = newCanonicalTopicIds.size;
      const updatedCount = updatedCanonicalTopicIds.size;
      if (newCount > 0 || updatedCount > 0) {
        liveAnnouncerRef.current?.announceTopicUpdate(newCount, updatedCount);
      }

      // Update known IDs and timestamps for subsequent diffs
      for (const id of newCanonicalTopicIds) {
        currentKnownIds.add(id);
      }
      for (const k of CANONICAL_LANES) {
        const lane = incomingLanes[k];
        if (lane?.topics) {
          for (const t of lane.topics) {
            currentTimestamps.set(t.id, t.updatedAt);
          }
        }
      }
    }
  }, [boardQuery.data, boardQuery.isPlaceholderData]);

  const loadMore = useCallback(
    async (lane: QualifyingLane) => {
      const currentLane = lanesStateRef.current[lane];
      if (
        !currentLane ||
        !currentLane.hasNextPage ||
        !currentLane.nextCursor ||
        currentLane.isLoadingMore ||
        (boardQuery.isFetching && boardQuery.isPlaceholderData)
      ) {
        return;
      }

      const existingCtrl = laneAbortControllersRef.current.get(lane);
      if (existingCtrl) {
        existingCtrl.abort();
      }
      const controller = new AbortController();
      laneAbortControllersRef.current.set(lane, controller);

      const scopeKeyAtInvocation = currentScopeKeyRef.current;

      setLanesState((prev) => {
        const nextState = {
          ...prev,
          [lane]: {
            ...prev[lane],
            isLoadingMore: true,
            loadMoreError: null,
          },
        };
        lanesStateRef.current = nextState;
        return nextState;
      });

      try {
        const response = trimmedSearch
          ? await hokimTopicsClient.searchLane(
              {
                lane,
                search: trimmedSearch,
                limit: 20,
                dateScope: filterState.dateScope,
                dateFrom: filterState.dateFrom,
                dateTo: filterState.dateTo,
                mahallaName: filterState.mahallaName,
                cursor: currentLane.nextCursor,
                baselineTimestamp: baselineTimestampRef.current ?? undefined,
              },
              controller.signal,
            )
          : await hokimTopicsClient.getLaneBatch(
              {
                lane,
                limit: 20,
                dateScope: filterState.dateScope,
                dateFrom: filterState.dateFrom,
                dateTo: filterState.dateTo,
                mahallaName: filterState.mahallaName,
                cursor: currentLane.nextCursor,
                baselineTimestamp: baselineTimestampRef.current ?? undefined,
              },
              controller.signal,
            );

        if (scopeKeyAtInvocation !== currentScopeKeyRef.current) {
          return;
        }

        setLanesState((prev) => {
          const prevLane = prev[lane];
          // Deduplicate by ID
          const existingIds = new Set(prevLane.topics.map((t) => t.id));
          const newTopics: TopicCardItem[] = [...prevLane.topics];
          for (const item of response.topics) {
            if (!existingIds.has(item.id)) {
              newTopics.push(item);
              existingIds.add(item.id);
              previousKnownTopicIdsRef.current.add(item.id);
              previousTopicTimestampsRef.current.set(item.id, item.updatedAt);
            }
          }

          const nextState = {
            ...prev,
            [lane]: {
              ...prevLane,
              topics: newTopics,
              nextCursor: response.nextCursor,
              hasNextPage: response.hasNextPage,
              isLoadingMore: false,
              loadMoreError: null,
            },
          };
          lanesStateRef.current = nextState;
          observeTopicsRef.current(response.topics);

          // Synchronize paginated topics to TanStack Query cache so back-navigation retains all loaded cards
          queryClient.setQueryData<HokimTopicBoardResponse>(queryKey, (oldBoard) => {
            if (!oldBoard?.lanes) return oldBoard;
            const oldLane = oldBoard.lanes[lane];
            if (!oldLane) return oldBoard;
            return {
              ...oldBoard,
              lanes: {
                ...oldBoard.lanes,
                [lane]: {
                  ...oldLane,
                  topics: newTopics,
                  nextCursor: response.nextCursor,
                  hasNextPage: response.hasNextPage,
                },
              },
            };
          });

          return nextState;
        });
      } catch (err: unknown) {
        if (
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err as { name?: string })?.name === 'AbortError'
        ) {
          return;
        }

        if (scopeKeyAtInvocation !== currentScopeKeyRef.current) {
          return;
        }

        if (
          err instanceof ApiError &&
          (err.code === 'INVALID_CURSOR' || err.code === 'STALE_CURSOR')
        ) {
          setLanesState((prev) => {
            const nextState = {
              ...prev,
              [lane]: {
                ...prev[lane],
                nextCursor: null,
                hasNextPage: false,
                isLoadingMore: false,
                loadMoreError: null,
              },
            };
            lanesStateRef.current = nextState;
            return nextState;
          });
          void boardQuery.refetch();
          return;
        }

        setLanesState((prev) => {
          const nextState = {
            ...prev,
            [lane]: {
              ...prev[lane],
              isLoadingMore: false,
              loadMoreError: 'Юклаб бўлмади. Қайта уриниш.',
            },
          };
          lanesStateRef.current = nextState;
          return nextState;
        });
      } finally {
        if (laneAbortControllersRef.current.get(lane) === controller) {
          laneAbortControllersRef.current.delete(lane);
        }
      }
    },
    [
      filterState,
      trimmedSearch,
      queryClient,
      queryKey,
      boardQuery.isFetching,
      boardQuery.isPlaceholderData,
      boardQuery.refetch,
    ],
  );

  const manualRefresh = useCallback(() => {
    return boardQuery.refetch();
  }, [boardQuery.refetch]);

  const isRefreshing = boardQuery.isFetching && !boardQuery.isLoading;
  const isFilterTransitioning = Boolean(boardQuery.isFetching && boardQuery.isPlaceholderData);
  const isBackgroundRefreshing = Boolean(
    boardQuery.isFetching && !boardQuery.isPlaceholderData && !boardQuery.isLoading,
  );

  return {
    board: boardQuery.data,
    evaluationId: boardQuery.data?.evaluationId ?? null,
    serverEvaluatedAt: boardQuery.data?.serverEvaluatedAt ?? null,
    isLoading: boardQuery.isLoading,
    isRefreshing,
    isFilterTransitioning,
    isBackgroundRefreshing,
    isError: boardQuery.isError,
    error: boardQuery.error,
    isStale: boardQuery.isStale,
    lastRefreshedAt: boardQuery.data?.serverEvaluatedAt ?? null,
    hasProcessingDelay: Boolean(boardQuery.data?.hasProcessingDelay),
    lanes: lanesState,
    activeLanes: filterState.lanes,
    loadMore,
    manualRefresh,
    refetch: boardQuery.refetch,
    retryFilter: boardQuery.refetch,
  };
}
