import {
  type GetDistrictAnalysisSettingsResponse,
  type SaveDistrictAnalysisSettingsDraftRequest,
  type SaveDistrictAnalysisSettingsDraftResponse,
  type ActivateDistrictAnalysisSettingsRequest,
  type ActivateDistrictAnalysisSettingsResponse,
  type DistrictAnalysisSettingsHistoryResponse,
  type RollbackDistrictAnalysisSettingsRequest,
  type RollbackDistrictAnalysisSettingsResponse,
  GetDistrictAnalysisSettingsResponseSchema,
  SaveDistrictAnalysisSettingsDraftResponseSchema,
  ActivateDistrictAnalysisSettingsResponseSchema,
  DistrictAnalysisSettingsHistoryResponseSchema,
  RollbackDistrictAnalysisSettingsResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export async function getDistrictAnalysisSettings(
  districtId: string,
  signal?: AbortSignal,
): Promise<GetDistrictAnalysisSettingsResponse> {
  return request<GetDistrictAnalysisSettingsResponse>(
    `/api/v1/ai/settings/districts/${encodeURIComponent(districtId)}`,
    { method: 'GET', signal },
    GetDistrictAnalysisSettingsResponseSchema,
  );
}

export async function saveDistrictAnalysisSettingsDraft(
  districtId: string,
  payload: SaveDistrictAnalysisSettingsDraftRequest,
): Promise<SaveDistrictAnalysisSettingsDraftResponse> {
  return request<SaveDistrictAnalysisSettingsDraftResponse>(
    `/api/v1/ai/settings/districts/${encodeURIComponent(districtId)}/draft`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    SaveDistrictAnalysisSettingsDraftResponseSchema,
  );
}

export async function activateDistrictSettings(
  districtId: string,
  payload: ActivateDistrictAnalysisSettingsRequest,
): Promise<ActivateDistrictAnalysisSettingsResponse> {
  return request<ActivateDistrictAnalysisSettingsResponse>(
    `/api/v1/ai/settings/districts/${encodeURIComponent(districtId)}/activate`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    ActivateDistrictAnalysisSettingsResponseSchema,
  );
}

export async function getDistrictSettingsHistory(
  districtId: string,
  signal?: AbortSignal,
): Promise<DistrictAnalysisSettingsHistoryResponse> {
  return request<DistrictAnalysisSettingsHistoryResponse>(
    `/api/v1/ai/settings/districts/${encodeURIComponent(districtId)}/history`,
    { method: 'GET', signal },
    DistrictAnalysisSettingsHistoryResponseSchema,
  );
}

export async function rollbackDistrictSettings(
  districtId: string,
  payload: RollbackDistrictAnalysisSettingsRequest,
): Promise<RollbackDistrictAnalysisSettingsResponse> {
  return request<RollbackDistrictAnalysisSettingsResponse>(
    `/api/v1/ai/settings/districts/${encodeURIComponent(districtId)}/rollback`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    RollbackDistrictAnalysisSettingsResponseSchema,
  );
}

export const districtSettingsClient = {
  getDistrictAnalysisSettings,
  saveDistrictAnalysisSettingsDraft,
  activateDistrictSettings,
  getDistrictSettingsHistory,
  rollbackDistrictSettings,
};



