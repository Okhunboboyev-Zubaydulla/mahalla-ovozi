import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HokimTopicStatisticsResponse,
  CANONICAL_LANES,
} from '@mahalla-ovozi/api-contracts';
import { hokimTopicsClient } from './hokim-topics-client.js';
import { useAuth } from '../auth/auth-context.js';
import { DashboardFilterState } from '../hooks/useDashboardFilterParams.js';

export interface UseTopicStatisticsResult {
  statistics: HokimTopicStatisticsResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  evaluationId?: string;
}

export interface UseTopicStatisticsOptions {
  isPaused?: boolean;
}

export function useTopicStatistics(
  appliedFilters?: DashboardFilterState | string,
  searchQuery?: string,
  options?: UseTopicStatisticsOptions,
): UseTopicStatisticsResult {
  const { actor } = useAuth();
  const districtId = actor?.districtId || '';

  const filterState: DashboardFilterState = useMemo(() => {
    if (typeof appliedFilters === 'string') {
      return { dateScope: 'today', lanes: [...CANONICAL_LANES] };
    }
    const lanes =
      appliedFilters?.lanes && Array.isArray(appliedFilters.lanes) && appliedFilters.lanes.length > 0
        ? appliedFilters.lanes
        : [...CANONICAL_LANES];
    return {
      dateScope: appliedFilters?.dateScope ?? 'today',
      dateFrom: appliedFilters?.dateFrom,
      dateTo: appliedFilters?.dateTo,
      mahallaName: appliedFilters?.mahallaName,
      lanes,
    };
  }, [appliedFilters]);

  const trimmedSearch = searchQuery?.trim() || '';

  const queryKey = [
    'hokim-statistics',
    districtId,
    filterState.dateScope,
    filterState.dateFrom ?? null,
    filterState.dateTo ?? null,
    filterState.mahallaName ?? null,
    filterState.lanes.join(','),
    trimmedSearch || null,
  ];

  const queryClient = useQueryClient();
  const configuredRetry = queryClient.getDefaultOptions().queries?.retry;
  const effectiveRetry = configuredRetry !== undefined ? configuredRetry : 2;

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (trimmedSearch) {
        return hokimTopicsClient.searchStatistics(
          {
            search: trimmedSearch,
            dateScope: filterState.dateScope,
            dateFrom: filterState.dateFrom,
            dateTo: filterState.dateTo,
            mahallaName: filterState.mahallaName,
            lanes: filterState.lanes,
          },
          signal,
        );
      }
      return hokimTopicsClient.getStatistics(
        {
          dateScope: filterState.dateScope,
          dateFrom: filterState.dateFrom,
          dateTo: filterState.dateTo,
          mahallaName: filterState.mahallaName,
          lanes: filterState.lanes,
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
    staleTime: 5_000,
    refetchInterval: options?.isPaused ? false : 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    networkMode: 'online',
    retry: effectiveRetry,
  });

  return {
    statistics: data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    evaluationId: data?.evaluationId,
  };
}
