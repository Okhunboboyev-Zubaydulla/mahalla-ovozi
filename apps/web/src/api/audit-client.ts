import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AuditHistoryItem,
  AuditEventDetailSchema,
  AuditHistoryPage,
  AuditHistoryPageSchema,
  AuditHistoryQuery,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export async function fetchAuditEvents(
  query?: Partial<AuditHistoryQuery>,
): Promise<AuditHistoryPage> {
  const searchParams = new URLSearchParams();

  if (query) {
    if (query.limit) {
      searchParams.set('limit', String(query.limit));
    }
    if (query.cursor) {
      searchParams.set('cursor', query.cursor);
    }
    if (query.direction) {
      searchParams.set('direction', query.direction);
    }
    if (query.recordType) {
      searchParams.set('recordType', query.recordType);
    }
    if (query.districtId) {
      searchParams.set('districtId', query.districtId);
    }
    if (query.startDate) {
      searchParams.set('startDate', query.startDate);
    }
    if (query.endDate) {
      searchParams.set('endDate', query.endDate);
    }
    if (query.category) {
      searchParams.set('category', query.category);
    }
    if (query.actorRole) {
      searchParams.set('actorRole', query.actorRole);
    }
    if (query.outcome) {
      searchParams.set('outcome', query.outcome);
    }
    if (query.action) {
      searchParams.set('action', query.action);
    }
    if (query.search && query.search.trim().length > 0) {
      searchParams.set('search', query.search.trim());
    }
  }

  const queryString = searchParams.toString();
  const url = queryString
    ? `/api/v1/audit/events?${queryString}`
    : '/api/v1/audit/events';

  return request<AuditHistoryPage>(
    url,
    { method: 'GET' },
    AuditHistoryPageSchema,
  );
}

export async function fetchAuditEventDetail(id: string): Promise<AuditHistoryItem> {
  return request<AuditHistoryItem>(
    `/api/v1/audit/events/${encodeURIComponent(id)}`,
    { method: 'GET' },
    AuditEventDetailSchema,
  );
}

export const auditClient = {
  fetchAuditEvents,
  fetchAuditEventDetail,
};

export function useAuditHistory(query: Partial<AuditHistoryQuery>) {
  return useQuery({
    queryKey: ['audit-history', query],
    queryFn: () => auditClient.fetchAuditEvents(query),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useAuditEventDetail(id: string | null) {
  return useQuery({
    queryKey: ['audit-event', id],
    queryFn: () => auditClient.fetchAuditEventDetail(id!),
    enabled: Boolean(id),
  });
}
