import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  OverallSystemHealthResponse,
  DistrictHealthResponse,
} from '@mahalla-ovozi/api-contracts';
import { healthClient } from './health-client.js';

export const healthKeys = {
  all: ['health'] as const,
  system: () => [...healthKeys.all, 'system'] as const,
  districts: () => [...healthKeys.all, 'district'] as const,
  district: (id: string) => [...healthKeys.districts(), id] as const,
};

/**
 * Custom TanStack Query hook for hierarchical system or district health.
 * Features 30s background polling, cache preservation (0px CLS), and online-only error surfacing.
 */
export function useSystemHealth(selectedDistrictId?: string | null) {
  const isDistrictScoped = Boolean(selectedDistrictId && selectedDistrictId.trim().length > 0);

  return useQuery<OverallSystemHealthResponse | DistrictHealthResponse>({
    queryKey:
      isDistrictScoped && selectedDistrictId
        ? healthKeys.district(selectedDistrictId)
        : healthKeys.system(),
    queryFn: () => {
      if (isDistrictScoped && selectedDistrictId) {
        return healthClient.getDistrictHealth(selectedDistrictId);
      }
      return healthClient.getSystemHealth();
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    networkMode: 'online',
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    gcTime: 600_000, // 10 minutes cache
    retry: false,
  });
}
