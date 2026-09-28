import { useQuery } from '@tanstack/react-query';
import { hokimTopicsClient } from './hokim-topics-client.js';
import { useAuth } from '../auth/auth-context.js';

export function useDistrictMahallas() {
  const { actor } = useAuth();
  const districtId = actor?.districtId || '';

  const query = useQuery({
    queryKey: ['district-mahallas', districtId],
    queryFn: ({ signal }) => hokimTopicsClient.getDistrictMahallas(signal),
    enabled: Boolean(districtId && actor?.role === 'DISTRICT_HOKIM'),
    staleTime: 15 * 60 * 1000, // 15 minutes
    networkMode: 'online',
    retry: 2,
  });

  return {
    mahallas: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
