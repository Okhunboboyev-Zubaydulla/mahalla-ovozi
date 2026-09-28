import {
  OverallSystemHealthResponse,
  OverallSystemHealthResponseSchema,
  DistrictHealthResponse,
  DistrictHealthResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const healthClient = {
  /**
   * Fetches overall system health and district summaries.
   */
  getSystemHealth(): Promise<OverallSystemHealthResponse> {
    return request<OverallSystemHealthResponse>(
      '/api/v1/health/system',
      { method: 'GET' },
      OverallSystemHealthResponseSchema,
    );
  },

  /**
   * Fetches health for a specific district.
   */
  getDistrictHealth(districtId: string): Promise<DistrictHealthResponse> {
    return request<DistrictHealthResponse>(
      `/api/v1/districts/${encodeURIComponent(districtId)}/health`,
      { method: 'GET' },
      DistrictHealthResponseSchema,
    );
  },
};
