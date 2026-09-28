import {
  GetTelegramBotResponse,
  ConnectTelegramBotRequest,
  ConnectTelegramBotResponse,
  DisconnectTelegramBotResponse,
  GetTelegramBotResponseSchema,
  ConnectTelegramBotResponseSchema,
  DisconnectTelegramBotResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const telegramBotClient = {
  getDistrictTelegramBot(districtId: string): Promise<GetTelegramBotResponse> {
    return request<GetTelegramBotResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/telegram-bot`,
      {
        method: 'GET',
      },
      GetTelegramBotResponseSchema
    );
  },

  connectDistrictTelegramBot(
    districtId: string,
    payload: ConnectTelegramBotRequest
  ): Promise<ConnectTelegramBotResponse> {
    return request<ConnectTelegramBotResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/telegram-bot`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      ConnectTelegramBotResponseSchema
    );
  },

  disconnectDistrictTelegramBot(districtId: string): Promise<DisconnectTelegramBotResponse> {
    return request<DisconnectTelegramBotResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/telegram-bot`,
      {
        method: 'DELETE',
      },
      DisconnectTelegramBotResponseSchema
    );
  },
};
