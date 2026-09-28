import {
  CreateDistrictRequest,
  CreateDistrictResponse,
  ListDistrictsResponse,
  GetDistrictResponse,
  GetDistrictReadinessResponse,
  ConfirmDisclosureResponse,
  ActivateDistrictResponse,
  UpdateDistrictRequest,
  UpdateDistrictResponse,
  CreateDistrictResponseSchema,
  ListDistrictsResponseSchema,
  GetDistrictResponseSchema,
  GetDistrictReadinessResponseSchema,
  ConfirmDisclosureResponseSchema,
  ActivateDistrictResponseSchema,
  UpdateDistrictResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const districtClient = {
  listDistricts(): Promise<ListDistrictsResponse> {
    return request<ListDistrictsResponse>(
      '/api/v1/districts',
      {
        method: 'GET',
      },
      ListDistrictsResponseSchema
    );
  },

  createDistrict(payload: CreateDistrictRequest): Promise<CreateDistrictResponse> {
    return request<CreateDistrictResponse>(
      '/api/v1/districts',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      CreateDistrictResponseSchema
    );
  },

  getDistrict(districtId: string): Promise<GetDistrictResponse> {
    return request<GetDistrictResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}`,
      {
        method: 'GET',
      },
      GetDistrictResponseSchema
    );
  },

  getDistrictReadiness(districtId: string): Promise<GetDistrictReadinessResponse> {
    return request<GetDistrictReadinessResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/readiness`,
      {
        method: 'GET',
      },
      GetDistrictReadinessResponseSchema
    );
  },

  confirmDisclosure(districtId: string): Promise<ConfirmDisclosureResponse> {
    return request<ConfirmDisclosureResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/disclosure-confirmation`,
      {
        method: 'POST',
      },
      ConfirmDisclosureResponseSchema
    );
  },

  activateDistrict(districtId: string): Promise<ActivateDistrictResponse> {
    return request<ActivateDistrictResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/activate`,
      {
        method: 'POST',
      },
      ActivateDistrictResponseSchema
    );
  },

  updateDistrict(
    districtId: string,
    payload: UpdateDistrictRequest
  ): Promise<UpdateDistrictResponse> {
    return request<UpdateDistrictResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      UpdateDistrictResponseSchema
    );
  },
};



