import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { districtClient } from './district-client.js';
import { districtQueryKeys } from './query-keys.js';
import { DistrictReadiness, ConfirmDisclosureResponse } from '@mahalla-ovozi/api-contracts';

export function useDistrictReadiness(districtId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery<DistrictReadiness>({
    queryKey: districtQueryKeys.readiness(districtId),
    queryFn: async () => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      const response = await districtClient.getDistrictReadiness(districtId);
      return response.readiness;
    },
    enabled: !!districtId,
  });

  const confirmMutation = useMutation<ConfirmDisclosureResponse, Error, void>({
    mutationFn: async () => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return districtClient.confirmDisclosure(districtId);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
      }
    },
  });

  return {
    ...query,
    readiness: query.data,
    confirmDisclosure: confirmMutation.mutateAsync,
    isConfirming: confirmMutation.isPending,
    confirmError: confirmMutation.error,
  };
}
