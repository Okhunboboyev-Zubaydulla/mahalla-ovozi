import {
  ListTelegramGroupsResponse,
  ListTelegramGroupsResponseSchema,
  CreateTelegramGroupRequest,
  CreateTelegramGroupResponse,
  CreateTelegramGroupResponseSchema,
  UpdateTelegramGroupRequest,
  UpdateTelegramGroupResponse,
  UpdateTelegramGroupResponseSchema,
  DeleteTelegramGroupResponse,
  DeleteTelegramGroupResponseSchema,
  StartGroupTestResponse,
  StartGroupTestResponseSchema,
  GetGroupTestStatusResponse,
  GetGroupTestStatusResponseSchema,
  SimulateTestMessageRequest,
  SimulateTestMessageResponse,
  SimulateTestMessageResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const telegramGroupClient = {
  listGroups(districtId: string): Promise<ListTelegramGroupsResponse> {
    return request<ListTelegramGroupsResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups`,
      {
        method: 'GET',
      },
      ListTelegramGroupsResponseSchema,
    );
  },

  createGroup(
    districtId: string,
    payload: CreateTelegramGroupRequest,
  ): Promise<CreateTelegramGroupResponse> {
    return request<CreateTelegramGroupResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      CreateTelegramGroupResponseSchema,
    );
  },

  updateGroup(
    districtId: string,
    groupId: string,
    payload: UpdateTelegramGroupRequest,
  ): Promise<UpdateTelegramGroupResponse> {
    return request<UpdateTelegramGroupResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups/${encodeURIComponent(groupId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      UpdateTelegramGroupResponseSchema,
    );
  },

  deleteGroup(districtId: string, groupId: string): Promise<DeleteTelegramGroupResponse> {
    return request<DeleteTelegramGroupResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups/${encodeURIComponent(groupId)}`,
      {
        method: 'DELETE',
      },
      DeleteTelegramGroupResponseSchema,
    );
  },

  startTest(districtId: string, groupId: string): Promise<StartGroupTestResponse> {
    return request<StartGroupTestResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups/${encodeURIComponent(groupId)}/start-test`,
      {
        method: 'POST',
      },
      StartGroupTestResponseSchema,
    );
  },

  getTestStatus(districtId: string, groupId: string): Promise<GetGroupTestStatusResponse> {
    return request<GetGroupTestStatusResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups/${encodeURIComponent(groupId)}/test-status`,
      {
        method: 'GET',
      },
      GetGroupTestStatusResponseSchema,
    );
  },

  simulateTestMessage(
    districtId: string,
    groupId: string,
    payload: SimulateTestMessageRequest,
  ): Promise<SimulateTestMessageResponse> {
    return request<SimulateTestMessageResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/groups/${encodeURIComponent(groupId)}/simulate-test-message`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      SimulateTestMessageResponseSchema,
    );
  },
};
