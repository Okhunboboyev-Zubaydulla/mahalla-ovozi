import {
  GetDistrictHokimAccountResponse,
  CreateHokimAccountRequest,
  CreateHokimAccountResponse,
  ResetHokimPasswordResponse,
  DisableHokimAccountResponse,
  ReplaceHokimAccountRequest,
  ReplaceHokimAccountResponse,
  UpdateHokimUsernameRequest,
  UpdateHokimUsernameResponse,
  GetDistrictHokimAccountResponseSchema,
  CreateHokimAccountResponseSchema,
  ResetHokimPasswordResponseSchema,
  DisableHokimAccountResponseSchema,
  ReplaceHokimAccountResponseSchema,
  UpdateHokimUsernameResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const hokimAccountClient = {
  getDistrictHokimAccount(districtId: string): Promise<GetDistrictHokimAccountResponse> {
    return request<GetDistrictHokimAccountResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/hokim-account`,
      {
        method: 'GET',
      },
      GetDistrictHokimAccountResponseSchema
    );
  },

  createDistrictHokimAccount(
    districtId: string,
    payload: CreateHokimAccountRequest
  ): Promise<CreateHokimAccountResponse> {
    return request<CreateHokimAccountResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/hokim-account`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      CreateHokimAccountResponseSchema
    );
  },

  resetDistrictHokimPassword(districtId: string): Promise<ResetHokimPasswordResponse> {
    return request<ResetHokimPasswordResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/hokim-account/reset-password`,
      {
        method: 'POST',
      },
      ResetHokimPasswordResponseSchema
    );
  },

  disableDistrictHokimAccount(districtId: string): Promise<DisableHokimAccountResponse> {
    return request<DisableHokimAccountResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/hokim-account/disable`,
      {
        method: 'POST',
      },
      DisableHokimAccountResponseSchema
    );
  },

  replaceDistrictHokimAccount(
    districtId: string,
    payload: ReplaceHokimAccountRequest
  ): Promise<ReplaceHokimAccountResponse> {
    return request<ReplaceHokimAccountResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/hokim-account/replace`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      ReplaceHokimAccountResponseSchema
    );
  },

  updateDistrictHokimUsername(
    districtId: string,
    payload: UpdateHokimUsernameRequest
  ): Promise<UpdateHokimUsernameResponse> {
    return request<UpdateHokimUsernameResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/hokim-account`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      UpdateHokimUsernameResponseSchema
    );
  },
};
