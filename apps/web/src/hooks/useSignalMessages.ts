import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type {
  ListSignalsQuery,
  ListSignalsResponse,
  SignalDetailDto,
  PromoteSignalRequest,
  ReclassifyEvidenceRequest,
  UpdateEvidenceTextRequest,
  DeleteEvidenceRequest,
  CreateManualSignalRequest,
  BatchDeleteSignalsRequest,
  BatchDeleteSignalsResponse,
} from '@mahalla-ovozi/api-contracts';
import {
  listSignals,
  getSignalDetail,
  promoteSignal,
  reclassifyEvidence,
  updateEvidenceText,
  deleteEvidence,
  createManualSignal,
  batchDeleteSignals,
} from '../api/signals-client.js';

export const signalQueryKeys = {
  all: ['signals'] as const,
  lists: () => [...signalQueryKeys.all, 'list'] as const,
  list: (filters: ListSignalsQuery) => [...signalQueryKeys.lists(), filters] as const,
  details: () => [...signalQueryKeys.all, 'detail'] as const,
  detail: (id: string | null) => [...signalQueryKeys.details(), id] as const,
};

export const SIGNALS_QUERY_KEY = signalQueryKeys.lists();
export const SIGNAL_DETAIL_QUERY_KEY = signalQueryKeys.details();

export function useSignalMessages(
  filters: ListSignalsQuery,
  options?: {
    refetchInterval?: number | false | ((query: any) => number | false | undefined);
  },
) {
  return useQuery<ListSignalsResponse>({
    queryKey: signalQueryKeys.list(filters),
    queryFn: () => listSignals(filters),
    networkMode: 'online',
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useSignalDetail(id: string | null) {
  return useQuery<SignalDetailDto>({
    queryKey: signalQueryKeys.detail(id),
    queryFn: () => {
      if (!id) throw new Error('ID talab qilinadi');
      return getSignalDetail(id);
    },
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function usePromoteSignal() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean; intakeId: string }, Error, { id: string; payload: PromoteSignalRequest }>({
    mutationFn: ({ id, payload }) => promoteSignal(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ['district-topics'] });
      queryClient.invalidateQueries({ queryKey: ['hokim-board'] });
      queryClient.invalidateQueries({ queryKey: ['hokim-statistics'] });
    },
    onError: (error) => {
      console.error('Signal mutation failed:', error);
    },
  });
}

export function useReclassifyEvidence() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean; evidenceId: string; newTopicId: string },
    Error,
    { id: string; payload: ReclassifyEvidenceRequest }
  >({
    mutationFn: ({ id, payload }) => reclassifyEvidence(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ['district-topics'] });
      queryClient.invalidateQueries({ queryKey: ['district-topic-evidence'] });
      queryClient.invalidateQueries({ queryKey: ['topic-evidence'] });
      queryClient.invalidateQueries({ queryKey: ['hokim-board'] });
      queryClient.invalidateQueries({ queryKey: ['hokim-statistics'] });
    },
    onError: (error) => {
      console.error('Signal mutation failed:', error);
    },
  });
}

export function useUpdateEvidenceText() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean; evidenceId: string }, Error, { id: string; payload: UpdateEvidenceTextRequest }>({
    mutationFn: ({ id, payload }) => updateEvidenceText(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ['district-topic-evidence'] });
      queryClient.invalidateQueries({ queryKey: ['topic-evidence'] });
    },
    onError: (error) => {
      console.error('Signal mutation failed:', error);
    },
  });
}

export function useDeleteEvidence() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean; deletedEvidenceId: string; topicDeleted: boolean },
    Error,
    { id: string; payload: DeleteEvidenceRequest }
  >({
    mutationFn: ({ id, payload }) => deleteEvidence(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ['district-topics'] });
      queryClient.invalidateQueries({ queryKey: ['district-topic-evidence'] });
      queryClient.invalidateQueries({ queryKey: ['topic-evidence'] });
      queryClient.invalidateQueries({ queryKey: ['hokim-board'] });
      queryClient.invalidateQueries({ queryKey: ['hokim-statistics'] });
    },
    onError: (error) => {
      console.error('Signal mutation failed:', error);
    },
  });
}

export function useCreateManualSignal() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean; intakeId: string }, Error, CreateManualSignalRequest>({
    mutationFn: (payload) => createManualSignal(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signalQueryKeys.all });
    },
    onError: (error) => {
      console.error('Signal mutation failed:', error);
    },
  });
}

export function useBatchDeleteSignals() {
  const queryClient = useQueryClient();
  return useMutation<
    BatchDeleteSignalsResponse,
    Error,
    BatchDeleteSignalsRequest
  >({
    mutationFn: (payload) => batchDeleteSignals(payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: signalQueryKeys.all }),
      ]);
    },
    onError: (error) => {
      console.error('Signal mutation failed:', error);
    },
  });
}

