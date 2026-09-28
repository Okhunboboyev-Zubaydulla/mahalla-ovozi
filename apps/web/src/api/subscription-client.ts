import {
  ListDistrictSubscriptionsResponse,
  ListDistrictSubscriptionsResponseSchema,
  GetDistrictSubscriptionResponse,
  GetDistrictSubscriptionResponseSchema,
  UpdateDistrictSubscriptionRequest,
  UpdateDistrictSubscriptionResponse,
  UpdateDistrictSubscriptionResponseSchema,
  StartGraceRequest,
  StartGraceResponse,
  StartGraceResponseSchema,
  RestoreActiveRequest,
  RestoreActiveResponse,
  RestoreActiveResponseSchema,
  CancelDistrictRequest,
  CancelDistrictResponse,
  CancelDistrictResponseSchema,
  StartRecoveryRequest,
  StartRecoveryResponse,
  StartRecoveryResponseSchema,
  ExecuteLiveDeletionResponse,
  ExecuteLiveDeletionResponseSchema,
  GetDistrictDeletionRecordResponse,
  GetDistrictDeletionRecordResponseSchema,
  VerifyBackupExpiryResponse,
  VerifyBackupExpiryResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const subscriptionClient = {
  listDistrictSubscriptions(): Promise<ListDistrictSubscriptionsResponse> {
    return request<ListDistrictSubscriptionsResponse>(
      '/api/v1/subscriptions',
      {
        method: 'GET',
      },
      ListDistrictSubscriptionsResponseSchema,
    );
  },

  getDistrictSubscription(districtId: string): Promise<GetDistrictSubscriptionResponse> {
    return request<GetDistrictSubscriptionResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription`,
      {
        method: 'GET',
      },
      GetDistrictSubscriptionResponseSchema,
    );
  },

  updateDistrictSubscription(
    districtId: string,
    payload: UpdateDistrictSubscriptionRequest,
  ): Promise<UpdateDistrictSubscriptionResponse> {
    return request<UpdateDistrictSubscriptionResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      UpdateDistrictSubscriptionResponseSchema,
    );
  },

  startDistrictGrace(
    districtId: string,
    payload?: StartGraceRequest,
  ): Promise<StartGraceResponse> {
    return request<StartGraceResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription/start-grace`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      },
      StartGraceResponseSchema,
    );
  },

  restoreDistrictActive(
    districtId: string,
    payload?: RestoreActiveRequest,
  ): Promise<RestoreActiveResponse> {
    return request<RestoreActiveResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription/restore-active`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      },
      RestoreActiveResponseSchema,
    );
  },

  cancelDistrict(
    districtId: string,
    payload: CancelDistrictRequest,
  ): Promise<CancelDistrictResponse> {
    return request<CancelDistrictResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription/cancel`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      CancelDistrictResponseSchema,
    );
  },

  startDistrictRecovery(
    districtId: string,
    payload?: StartRecoveryRequest,
  ): Promise<StartRecoveryResponse> {
    return request<StartRecoveryResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription/start-recovery`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      },
      StartRecoveryResponseSchema,
    );
  },

  executeDistrictLiveDeletion(
    districtId: string,
  ): Promise<ExecuteLiveDeletionResponse> {
    return request<ExecuteLiveDeletionResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/subscription/execute-live-deletion`,
      {
        method: 'POST',
      },
      ExecuteLiveDeletionResponseSchema,
    );
  },

  getDistrictDeletionRecord(
    districtId: string,
  ): Promise<GetDistrictDeletionRecordResponse> {
    return request<GetDistrictDeletionRecordResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/deletion-record`,
      {
        method: 'GET',
      },
      GetDistrictDeletionRecordResponseSchema,
    );
  },

  verifyDistrictBackupExpiry(
    districtId: string,
  ): Promise<VerifyBackupExpiryResponse> {
    return request<VerifyBackupExpiryResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/deletion-record/verify-backup-expiry`,
      {
        method: 'POST',
      },
      VerifyBackupExpiryResponseSchema,
    );
  },
};

