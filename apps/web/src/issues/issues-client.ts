import {
  OperationalIssuesListResponse,
  OperationalIssuesListResponseSchema,
  OperationalIssueDetailResponse,
  OperationalIssueDetailResponseSchema,
  RetryOperationRequest,
  RetryOperationResponse,
  RetryOperationResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export interface GetIssuesParams {
  districtId?: string | null;
  status?: string;
  severity?: string;
  limit?: number;
  offset?: number;
}

export const issuesClient = {
  /**
   * Fetches operational issues with optional filters (Story 4.2 AC 1, AC 4).
   */
  getOperationalIssues(
    params: GetIssuesParams = {},
  ): Promise<OperationalIssuesListResponse> {
    const query = new URLSearchParams();
    if (params.districtId) {
      query.set('districtId', params.districtId);
    }
    if (params.status) {
      query.set('status', params.status);
    }
    if (params.severity) {
      query.set('severity', params.severity);
    }
    if (params.limit !== undefined) {
      query.set('limit', String(params.limit));
    }
    if (params.offset !== undefined) {
      query.set('offset', String(params.offset));
    }

    const queryString = query.toString();
    const url = queryString
      ? `/api/v1/issues?${queryString}`
      : '/api/v1/issues';

    return request<OperationalIssuesListResponse>(
      url,
      { method: 'GET' },
      OperationalIssuesListResponseSchema,
    );
  },

  /**
   * Fetches detailed issue diagnosis and audit event timeline (Story 4.2 AC 5).
   */
  getOperationalIssueDetail(
    issueId: string,
  ): Promise<OperationalIssueDetailResponse> {
    return request<OperationalIssueDetailResponse>(
      `/api/v1/issues/${encodeURIComponent(issueId)}`,
      { method: 'GET' },
      OperationalIssueDetailResponseSchema,
    );
  },

  /**
   * Triggers manual retry for an operational issue (Story 4.3 AC 1, AC 2, AC 3).
   */
  retryOperationalIssue(
    issueId: string,
    reason?: string,
  ): Promise<RetryOperationResponse> {
    return request<RetryOperationResponse>(
      `/api/v1/issues/${encodeURIComponent(issueId)}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
      RetryOperationResponseSchema,
    );
  },

  /**
   * Triggers manual retry for a background job directly (Story 4.3 AC 2, AC 3).
   */
  retryBackgroundJob(
    payload: RetryOperationRequest,
  ): Promise<RetryOperationResponse> {
    return request<RetryOperationResponse>(
      '/api/v1/retry/jobs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      RetryOperationResponseSchema,
    );
  },
};

