import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type GetDistrictAnalysisSettingsResponse,
  type SaveDistrictAnalysisSettingsDraftResponse,
  type SaveDistrictAnalysisSettingsDraftRequest,
  type ActivateDistrictAnalysisSettingsResponse,
  type ActivateDistrictAnalysisSettingsRequest,
  type DistrictAnalysisSettingsHistoryResponse,
  type RollbackDistrictAnalysisSettingsRequest,
  type RollbackDistrictAnalysisSettingsResponse,
} from '@mahalla-ovozi/api-contracts';
import { districtSettingsClient } from '../api/district-settings-client.js';

export const districtSettingsKeys = {
  all: ['district-settings'] as const,
  detail: (districtId: string) => ['district-settings', districtId] as const,
  history: (districtId: string) =>
    ['district-settings-history', districtId] as const,
};

export function useDistrictAnalysisSettings(districtId: string | null) {
  return useQuery<GetDistrictAnalysisSettingsResponse>({
    queryKey: districtSettingsKeys.detail(districtId || ''),
    queryFn: ({ signal }) =>
      districtSettingsClient.getDistrictAnalysisSettings(districtId!, signal),
    enabled: Boolean(districtId),
    staleTime: 30_000,
  });
}

export function useSaveDistrictSettingsDraft(districtId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    SaveDistrictAnalysisSettingsDraftResponse,
    Error,
    SaveDistrictAnalysisSettingsDraftRequest
  >({
    mutationFn: (payload: SaveDistrictAnalysisSettingsDraftRequest) =>
      districtSettingsClient.saveDistrictAnalysisSettingsDraft(
        districtId,
        payload,
      ),
    onSuccess: (data) => {
      // Invalidate and set updated data in query cache
      queryClient.setQueryData<GetDistrictAnalysisSettingsResponse>(
        districtSettingsKeys.detail(districtId),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            draft: data.draft,
          };
        },
      );
      void queryClient.invalidateQueries({
        queryKey: districtSettingsKeys.detail(districtId),
      });
    },
  });
}

export function useActivateDistrictSettings(districtId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    ActivateDistrictAnalysisSettingsResponse,
    Error,
    ActivateDistrictAnalysisSettingsRequest
  >({
    mutationFn: (payload: ActivateDistrictAnalysisSettingsRequest) =>
      districtSettingsClient.activateDistrictSettings(districtId, payload),
    onSuccess: (data) => {
      // Set updated active configuration and clear draft in query cache
      queryClient.setQueryData<GetDistrictAnalysisSettingsResponse>(
        districtSettingsKeys.detail(districtId),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeConfiguration: data.activeConfiguration,
            draft: null,
          };
        },
      );
      void queryClient.invalidateQueries({
        queryKey: districtSettingsKeys.detail(districtId),
      });
      void queryClient.invalidateQueries({
        queryKey: districtSettingsKeys.history(districtId),
      });
    },
  });
}

export function useDistrictAnalysisSettingsHistory(districtId: string | null) {
  return useQuery<DistrictAnalysisSettingsHistoryResponse>({
    queryKey: districtSettingsKeys.history(districtId || ''),
    queryFn: ({ signal }) =>
      districtSettingsClient.getDistrictSettingsHistory(districtId!, signal),
    enabled: Boolean(districtId),
    staleTime: 30_000,
  });
}

export function useRollbackDistrictSettings(districtId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    RollbackDistrictAnalysisSettingsResponse,
    Error,
    RollbackDistrictAnalysisSettingsRequest
  >({
    mutationFn: (payload: RollbackDistrictAnalysisSettingsRequest) =>
      districtSettingsClient.rollbackDistrictSettings(districtId, payload),
    onSuccess: (data) => {
      // Update active configuration in query cache
      queryClient.setQueryData<GetDistrictAnalysisSettingsResponse>(
        districtSettingsKeys.detail(districtId),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeConfiguration: data.activeConfiguration,
          };
        },
      );
      void queryClient.invalidateQueries({
        queryKey: districtSettingsKeys.detail(districtId),
      });
      void queryClient.invalidateQueries({
        queryKey: districtSettingsKeys.history(districtId),
      });
    },
  });
}


