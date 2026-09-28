import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { App, message as staticMessage } from 'antd';
import {
  OperationalIssuesListResponse,
  OperationalIssueDetailResponse,
  RetryOperationResponse,
} from '@mahalla-ovozi/api-contracts';
import { issuesClient, GetIssuesParams } from './issues-client.js';

export const issueKeys = {
  all: ['issues'] as const,
  lists: () => [...issueKeys.all, 'list'] as const,
  list: (params?: GetIssuesParams) =>
    [...issueKeys.lists(), params ?? {}] as const,
  details: () => [...issueKeys.all, 'detail'] as const,
  detail: (id: string) => [...issueKeys.details(), id] as const,
};

/**
 * Custom TanStack Query hook for fetching operational issues list.
 * Features 30s background polling, cache preservation (0px CLS), and online-only error surfacing (Story 4.2 AC 15, AC 16).
 */
export function useOperationalIssues(params?: GetIssuesParams) {
  return useQuery<OperationalIssuesListResponse>({
    queryKey: issueKeys.list(params),
    queryFn: () => issuesClient.getOperationalIssues(params),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    networkMode: 'online',
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    gcTime: 600_000,
    retry: false,
  });
}

/**
 * Custom TanStack Query hook for fetching single operational issue diagnostic details.
 */
export function useOperationalIssueDetail(issueId: string | null) {
  return useQuery<OperationalIssueDetailResponse>({
    queryKey: issueKeys.detail(issueId || ''),
    queryFn: () => issuesClient.getOperationalIssueDetail(issueId!),
    enabled: Boolean(issueId),
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Custom TanStack Query mutation hook for triggering manual retry on an operational issue (Story 4.3 AC 1, AC 3, AC 10).
 */
export function useRetryOperationalIssue() {
  const queryClient = useQueryClient();
  const antdApp = App.useApp();
  const messageApi =
    typeof antdApp?.message?.error === 'function'
      ? antdApp.message
      : staticMessage;

  return useMutation<
    RetryOperationResponse,
    Error,
    { issueId: string; reason?: string }
  >({
    mutationFn: ({ issueId, reason }) =>
      issuesClient.retryOperationalIssue(issueId, reason),
    networkMode: 'online',
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: issueKeys.all });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      if (variables.issueId) {
        queryClient.invalidateQueries({
          queryKey: issueKeys.detail(variables.issueId),
        });
      }
      messageApi.success(
        data.message || 'Қайта ижро этиш навбатга муваффақиятли қўшилди.',
      );
    },
    onError: (err) => {
      messageApi.error(err.message || 'Қайта ижро этишда хатолик юз берди.');
    },
  });
}
