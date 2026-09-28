import { useMemo, useEffect, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  QualifyingLane,
  TopicCardItem,
  TopicEvidenceItem,
  TopicEvidenceResponse,
  HokimLaneBoardData,
} from '@mahalla-ovozi/api-contracts';
import { hokimTopicsClient } from './hokim-topics-client.js';
import { useAuth } from '../auth/auth-context.js';
import { ApiError } from '../lib/api-client.js';

export interface UseTopicEvidenceOptions {
  onInvalidated?: () => void;
  order?: 'ASC' | 'DESC';
  initialTopic?: TopicCardItem | null;
}

export interface UseTopicEvidenceResult {
  topic: TopicCardItem | null;
  anchorQuote: string;
  anchorEvidenceId: string;
  evidenceList: TopicEvidenceItem[];
  totalCount: number;
  isLoading: boolean;
  isError: boolean;
  isInvalidated: boolean;
  error: unknown;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
}

export function useTopicEvidence(
  topicId: string | null | undefined,
  options?: UseTopicEvidenceOptions,
): UseTopicEvidenceResult {
  const { actor } = useAuth();
  const districtId = actor?.districtId || '';
  const queryClient = useQueryClient();

  const order = options?.order ?? 'ASC';
  const queryKey = ['topic-evidence', districtId, topicId || '', order];
  const configuredRetry = queryClient.getDefaultOptions().queries?.retry;
  const effectiveRetry = typeof configuredRetry === 'number' ? configuredRetry : 2;

  const {
    data,
    isLoading,
    isError,
    error,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery<
    TopicEvidenceResponse,
    Error,
    { pages: TopicEvidenceResponse[]; pageParams: (string | undefined)[] },
    string[],
    string | undefined
  >({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      if (!topicId) {
        throw new Error('Мавзу идентификатори талаб қилинади.');
      }
      return hokimTopicsClient.getTopicEvidence(
        topicId,
        {
          cursor: pageParam,
          limit: 50,
          order,
        },
        signal,
      );
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasNextPage && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: Boolean(districtId && topicId && actor?.role === 'DISTRICT_HOKIM'),
    staleTime: 2_000,
    refetchInterval: (query) => {
      // Only auto-poll when on initial page; pause background polling during deep pagination
      return (query.state.data?.pages.length ?? 0) <= 1 ? 4_000 : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    networkMode: 'online',
    retry: (failureCount, err) => {
      // Do not retry terminal client/auth errors (4xx) or schema parsing mismatches
      if (err instanceof ApiError) {
        if (err.statusCode >= 400 && err.statusCode < 500) {
          return false;
        }
        if (err.code === 'INVALID_RESPONSE') {
          return false;
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('404') ||
        msg.includes('not found') ||
        msg.includes('топилмади') ||
        msg.includes('401') ||
        msg.includes('403')
      ) {
        return false;
      }
      return failureCount < effectiveRetry;
    },
    placeholderData: (previousData, previousQuery) => {
      // Retain topic metadata across order switches; clear strictly when topicId changes (AC 7)
      if (previousQuery?.queryKey[2] === (topicId || '')) {
        return previousData;
      }
      return undefined;
    },
  });

  const firstPage = data?.pages[0];

  // Immediately synchronize board card evidenceCount and activity timestamp in React Query cache
  useEffect(() => {
    if (firstPage?.topic && topicId && districtId) {
      queryClient.setQueriesData<{ lanes: Record<string, HokimLaneBoardData> }>(
        { queryKey: ['hokim-board', districtId] },
        (oldBoard) => {
          if (!oldBoard?.lanes) return oldBoard;
          let changed = false;
          const updatedLanes = { ...oldBoard.lanes };
          for (const laneKey of Object.keys(updatedLanes)) {
            const laneData = updatedLanes[laneKey as QualifyingLane];
            if (!laneData?.topics) continue;
            const idx = laneData.topics.findIndex((t) => t.id === topicId);
            if (idx !== -1) {
              const currentTopic = laneData.topics[idx]!;
              if (
                currentTopic.evidenceCount !== firstPage.totalCount ||
                currentTopic.latestMeaningfulActivityTimestamp !==
                  firstPage.topic.latestMeaningfulActivityTimestamp
              ) {
                const newTopics = [...laneData.topics];
                newTopics[idx] = {
                  ...currentTopic,
                  evidenceCount: firstPage.totalCount,
                  latestMeaningfulActivityTimestamp:
                    firstPage.topic.latestMeaningfulActivityTimestamp,
                  summary: firstPage.topic.summary || currentTopic.summary,
                };
                updatedLanes[laneKey as QualifyingLane] = {
                  ...laneData,
                  topics: newTopics,
                };
                changed = true;
              }
            }
          }
          return changed ? { ...oldBoard, lanes: updatedLanes } : oldBoard;
        },
      );
    }
  }, [firstPage, topicId, districtId, queryClient]);

  // Merge newly arrived evidence items and order oldest-to-newest (AC 5)
  const evidenceList = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) {
      return [];
    }

    const seenIds = new Set<string>();
    const list: TopicEvidenceItem[] = [];

    for (const page of data.pages) {
      for (const item of page.evidence) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          list.push(item);
        }
      }
    }

    // Sort matching order (ASC: oldest to newest, DESC: newest to oldest) with deterministic tie-breaker
    list.sort((a, b) => {
      const timeA = new Date(a.originalTimestamp).getTime();
      const timeB = new Date(b.originalTimestamp).getTime();
      if (timeA !== timeB) {
        return order === 'DESC' ? timeB - timeA : timeA - timeB;
      }
      return order === 'DESC' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
    });

    return list;
  }, [data?.pages, order]);

  // Intercept 404 (Topic deleted/superseded) or auth invalidation (AC 5)
  const isInvalidated = useMemo(() => {
    if (!isError || !error) return false;
    const msg = error instanceof Error ? error.message : String(error);
    return (
      msg.includes('404') ||
      msg.includes('not found') ||
      msg.includes('топилмади') ||
      msg.includes('401') ||
      msg.includes('403')
    );
  }, [isError, error]);

  const onInvalidatedRef = useRef(options?.onInvalidated);
  onInvalidatedRef.current = options?.onInvalidated;

  useEffect(() => {
    if (isInvalidated && topicId && districtId) {
      // Purge query cache across all orders for this topic and notify caller
      queryClient.removeQueries({
        queryKey: ['topic-evidence', districtId, topicId],
      });
      onInvalidatedRef.current?.();
    }
  }, [isInvalidated, topicId, districtId, queryClient]);

  const fallbackTopic =
    options?.initialTopic && options.initialTopic.id === topicId
      ? options.initialTopic
      : null;

  return {
    topic: firstPage?.topic ?? fallbackTopic,
    anchorQuote: firstPage?.anchorQuote ?? '',
    anchorEvidenceId: firstPage?.anchorEvidenceId ?? '',
    evidenceList,
    totalCount: firstPage?.totalCount ?? fallbackTopic?.evidenceCount ?? 0,
    isLoading,
    isError,
    isInvalidated,
    error,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage: Boolean(hasNextPage),
    fetchNextPage,
    refetch,
  };
}
