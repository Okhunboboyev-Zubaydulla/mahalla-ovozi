import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { telegramGroupClient } from './telegram-group-client.js';
import { districtQueryKeys } from './query-keys.js';
import {
  TelegramGroupMapping,
  CreateTelegramGroupRequest,
  CreateTelegramGroupResponse,
  UpdateTelegramGroupRequest,
  UpdateTelegramGroupResponse,
  DeleteTelegramGroupResponse,
  StartGroupTestResponse,
  SimulateTestMessageRequest,
  SimulateTestMessageResponse,
  BulkTelegramGroupPauseStateResponse,
} from '@mahalla-ovozi/api-contracts';

/**
 * Merges the groups the server actually reported back into the cached list.
 *
 * Only rows present in the response are replaced, so a group whose transition was not
 * acknowledged keeps its previous state instead of inheriting an optimistic guess.
 */
function mergeServerReportedGroups(
  cached: TelegramGroupMapping[] | undefined,
  reported: TelegramGroupMapping[],
): TelegramGroupMapping[] | undefined {
  if (!cached) return cached;
  const reportedById = new Map(reported.map((group) => [group.id, group]));
  return cached.map((group) => reportedById.get(group.id) ?? group);
}

export function useTelegramGroups(districtId: string | null) {
  const queryClient = useQueryClient();

  /**
   * Applies one bulk pause-state response to the cached group list. Pause and resume report the
   * same shape and have the same cache consequence, so both mutations share this one callback.
   */
  const mergeBulkPauseStateResponse = (response: BulkTelegramGroupPauseStateResponse) => {
    if (!districtId) return;
    queryClient.setQueryData<TelegramGroupMapping[]>(
      districtQueryKeys.groups(districtId),
      (cached) => mergeServerReportedGroups(cached, response.groups),
    );
    queryClient.invalidateQueries({
      queryKey: districtQueryKeys.groups(districtId),
    });
  };

  const query = useQuery<TelegramGroupMapping[]>({
    queryKey: districtQueryKeys.groups(districtId),
    queryFn: async () => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      const response = await telegramGroupClient.listGroups(districtId);
      return response.groups;
    },
    enabled: !!districtId,
  });

  const createMutation = useMutation<
    CreateTelegramGroupResponse,
    Error,
    CreateTelegramGroupRequest
  >({
    mutationFn: async (payload) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.createGroup(districtId, payload);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.groups(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.mahallas(districtId),
        });
      }
    },
  });

  const updateMutation = useMutation<
    UpdateTelegramGroupResponse,
    Error,
    { groupId: string; payload: UpdateTelegramGroupRequest }
  >({
    mutationFn: async ({ groupId, payload }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.updateGroup(districtId, groupId, payload);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.groups(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.mahallas(districtId),
        });
      }
    },
  });

  const deleteMutation = useMutation<DeleteTelegramGroupResponse, Error, { groupId: string }>({
    mutationFn: async ({ groupId }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.deleteGroup(districtId, groupId);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.groups(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.mahallas(districtId),
        });
      }
    },
  });

  const startTestMutation = useMutation<StartGroupTestResponse, Error, { groupId: string }>({
    mutationFn: async ({ groupId }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.startTest(districtId, groupId);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.groups(districtId),
        });
      }
    },
  });

  const simulateMutation = useMutation<
    SimulateTestMessageResponse,
    Error,
    { groupId: string; payload: SimulateTestMessageRequest }
  >({
    mutationFn: async ({ groupId, payload }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.simulateTestMessage(districtId, groupId, payload);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.groups(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
      }
    },
  });

  const pauseMutation = useMutation<
    BulkTelegramGroupPauseStateResponse,
    Error,
    { groupIds: string[] }
  >({
    mutationFn: async ({ groupIds }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.pauseGroups(districtId, groupIds);
    },
    onSuccess: mergeBulkPauseStateResponse,
  });

  const resumeMutation = useMutation<
    BulkTelegramGroupPauseStateResponse,
    Error,
    { groupIds: string[] }
  >({
    mutationFn: async ({ groupIds }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramGroupClient.resumeGroups(districtId, groupIds);
    },
    onSuccess: mergeBulkPauseStateResponse,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    groups: query.data ?? [],
    createGroup: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    createError: createMutation.error,
    resetCreateError: createMutation.reset,
    updateGroup: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    updateError: updateMutation.error,
    resetUpdateError: updateMutation.reset,
    deleteGroup: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
    deleteError: deleteMutation.error,
    startTest: startTestMutation.mutateAsync,
    isStartingTest: startTestMutation.isPending,
    simulateMessage: simulateMutation.mutateAsync,
    isSimulating: simulateMutation.isPending,
    pauseGroups: pauseMutation.mutateAsync,
    isPausing: pauseMutation.isPending,
    pauseError: pauseMutation.error,
    resumeGroups: resumeMutation.mutateAsync,
    isResuming: resumeMutation.isPending,
    resumeError: resumeMutation.error,
  };
}
