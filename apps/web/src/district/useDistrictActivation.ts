import { useMutation, useQueryClient } from '@tanstack/react-query';
import { districtClient } from './district-client.js';
import { districtQueryKeys } from './query-keys.js';
import { ActivateDistrictResponse } from '@mahalla-ovozi/api-contracts';
import { ApiError } from '../lib/api-client.js';

export function useDistrictActivation(districtId: string | null) {
  const queryClient = useQueryClient();

  const mutation = useMutation<ActivateDistrictResponse, ApiError | Error, void>({
    mutationFn: async () => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return districtClient.activateDistrict(districtId);
    },
    onSuccess: (data) => {
      if (districtId) {
        queryClient.setQueryData(districtQueryKeys.district(districtId), { district: data.district });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.list(),
        });
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'DISTRICT_ALREADY_ACTIVE' && districtId) {
        queryClient.invalidateQueries({ queryKey: districtQueryKeys.district(districtId) });
        queryClient.invalidateQueries({ queryKey: districtQueryKeys.readiness(districtId) });
        queryClient.invalidateQueries({ queryKey: districtQueryKeys.list() });
      }
    },
  });

  return {
    activateDistrict: mutation.mutateAsync,
    isActivating: mutation.isPending,
    activationError: mutation.error,
    isSuccess: mutation.isSuccess,
    reset: mutation.reset,
  };
}
