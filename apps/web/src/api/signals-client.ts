import {
  type ListSignalsQuery,
  type ListSignalsResponse,
  type SignalDetailDto,
  type PromoteSignalRequest,
  type PromoteSignalResponse,
  type ReclassifyEvidenceRequest,
  type ReclassifyEvidenceResponse,
  type UpdateEvidenceTextRequest,
  type UpdateEvidenceTextResponse,
  type DeleteEvidenceRequest,
  type DeleteEvidenceResponse,
  type CreateManualSignalRequest,
  type CreateManualSignalResponse,
  type BatchDeleteSignalsRequest,
  type BatchDeleteSignalsResponse,
  ListSignalsResponseSchema,
  SignalDetailSchema,
  PromoteSignalResponseSchema,
  ReclassifyEvidenceResponseSchema,
  UpdateEvidenceTextResponseSchema,
  DeleteEvidenceResponseSchema,
  CreateManualSignalResponseSchema,
  BatchDeleteSignalsResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export async function listSignals(params?: ListSignalsQuery): Promise<ListSignalsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.districtId) searchParams.set('districtId', params.districtId);
  if (params?.mahallaName) searchParams.set('mahallaName', params.mahallaName);
  if (params?.calendarDay) searchParams.set('calendarDay', params.calendarDay);
  if (params?.isRelevant !== undefined) searchParams.set('isRelevant', String(params.isRelevant));
  if (params?.lane) searchParams.set('lane', params.lane);
  if (params?.search) searchParams.set('search', params.search);
  if (params?.startDate) searchParams.set('startDate', params.startDate);
  if (params?.endDate) searchParams.set('endDate', params.endDate);
  if (params?.cursor) searchParams.set('cursor', params.cursor);
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const url = `/api/v1/admin/signals${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  return request<ListSignalsResponse>(url, { method: 'GET' }, ListSignalsResponseSchema);
}

export async function getSignalDetail(id: string): Promise<SignalDetailDto> {
  return request<SignalDetailDto>(`/api/v1/admin/signals/${encodeURIComponent(id)}`, { method: 'GET' }, SignalDetailSchema);
}

export async function promoteSignal(id: string, payload: PromoteSignalRequest): Promise<PromoteSignalResponse> {
  return request<PromoteSignalResponse>(
    `/api/v1/admin/signals/${encodeURIComponent(id)}/promote`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    PromoteSignalResponseSchema,
  );
}

export async function reclassifyEvidence(
  id: string,
  payload: ReclassifyEvidenceRequest,
): Promise<ReclassifyEvidenceResponse> {
  return request<ReclassifyEvidenceResponse>(
    `/api/v1/admin/signals/${encodeURIComponent(id)}/reclassify`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    ReclassifyEvidenceResponseSchema,
  );
}

export async function updateEvidenceText(
  id: string,
  payload: UpdateEvidenceTextRequest,
): Promise<UpdateEvidenceTextResponse> {
  return request<UpdateEvidenceTextResponse>(
    `/api/v1/admin/signals/${encodeURIComponent(id)}/evidence`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
    UpdateEvidenceTextResponseSchema,
  );
}

export async function deleteEvidence(
  id: string,
  payload: DeleteEvidenceRequest,
): Promise<DeleteEvidenceResponse> {
  return request<DeleteEvidenceResponse>(
    `/api/v1/admin/signals/${encodeURIComponent(id)}/evidence`,
    {
      method: 'DELETE',
      body: JSON.stringify(payload),
    },
    DeleteEvidenceResponseSchema,
  );
}

export async function createManualSignal(
  payload: CreateManualSignalRequest,
): Promise<CreateManualSignalResponse> {
  return request<CreateManualSignalResponse>(
    '/api/v1/admin/signals/manual',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    CreateManualSignalResponseSchema,
  );
}

export async function batchDeleteSignals(
  payload: BatchDeleteSignalsRequest,
): Promise<BatchDeleteSignalsResponse> {
  return request<BatchDeleteSignalsResponse>(
    '/api/v1/admin/signals/batch-delete',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    BatchDeleteSignalsResponseSchema,
  );
}

