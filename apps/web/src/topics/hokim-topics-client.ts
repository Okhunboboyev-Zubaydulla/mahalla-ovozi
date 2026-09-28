import {
  HokimTopicBoardQuery,
  HokimTopicBoardResponse,
  HokimTopicBoardResponseSchema,
  HokimLaneQuery,
  HokimLaneResponse,
  HokimLaneResponseSchema,
  TopicEvidenceQuery,
  TopicEvidenceResponse,
  TopicEvidenceResponseSchema,
  HokimMahallasResponseSchema,
  HokimTopicStatisticsQuery,
  HokimTopicStatisticsResponse,
  HokimTopicStatisticsResponseSchema,
  HokimTopicBoardSearchBody,
  HokimLaneSearchBody,
  HokimTopicStatisticsSearchBody,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';

export const hokimTopicsClient = {
  getTodayBoard(
    params?: HokimTopicBoardQuery | string,
    signal?: AbortSignal,
  ): Promise<HokimTopicBoardResponse> {
    const searchParams = new URLSearchParams();
    if (typeof params === 'string') {
      searchParams.set('calendarDay', params);
    } else if (params) {
      if (params.dateScope) {
        searchParams.set('dateScope', params.dateScope);
      }
      if (params.dateFrom) {
        searchParams.set('dateFrom', params.dateFrom);
      }
      if (params.dateTo) {
        searchParams.set('dateTo', params.dateTo);
      }
      if (params.mahallaName) {
        searchParams.set('mahallaName', params.mahallaName);
      }
      if (params.lanes) {
        const lanesStr = Array.isArray(params.lanes) ? params.lanes.join(',') : String(params.lanes);
        if (lanesStr) {
          searchParams.set('lanes', lanesStr);
        }
      }
      if (params.calendarDay) {
        searchParams.set('calendarDay', params.calendarDay);
      }
      if (params.baselineTimestamp) {
        searchParams.set('baselineTimestamp', params.baselineTimestamp);
      }
    }
    const queryString = searchParams.toString() ? `?${searchParams.toString()}` : '';

    return request<HokimTopicBoardResponse>(
      `/api/v1/hokim/topics/board${queryString}`,
      {
        method: 'GET',
        signal,
      },
      HokimTopicBoardResponseSchema,
    );
  },

  getLaneBatch(params: HokimLaneQuery, signal?: AbortSignal): Promise<HokimLaneResponse> {
    const searchParams = new URLSearchParams();
    searchParams.set('lane', params.lane);
    if (params.dateScope) {
      searchParams.set('dateScope', params.dateScope);
    }
    if (params.dateFrom) {
      searchParams.set('dateFrom', params.dateFrom);
    }
    if (params.dateTo) {
      searchParams.set('dateTo', params.dateTo);
    }
    if (params.mahallaName) {
      searchParams.set('mahallaName', params.mahallaName);
    }
    if (params.calendarDay) {
      searchParams.set('calendarDay', params.calendarDay);
    }
    if (params.cursor) {
      searchParams.set('cursor', params.cursor);
    }
    if (params.limit) {
      searchParams.set('limit', String(params.limit));
    }
    if (params.baselineTimestamp) {
      searchParams.set('baselineTimestamp', params.baselineTimestamp);
    }

    return request<HokimLaneResponse>(
      `/api/v1/hokim/topics/lane?${searchParams.toString()}`,
      {
        method: 'GET',
        signal,
      },
      HokimLaneResponseSchema,
    );
  },

  async getDistrictMahallas(signal?: AbortSignal): Promise<string[]> {
    const response = await request<{ mahallas: string[] }>(
      '/api/v1/hokim/topics/mahallas',
      {
        method: 'GET',
        signal,
      },
      HokimMahallasResponseSchema,
    );
    return response.mahallas;
  },

  getTopicEvidence(
    topicId: string,
    query?: TopicEvidenceQuery,
    signal?: AbortSignal,
  ): Promise<TopicEvidenceResponse> {
    const searchParams = new URLSearchParams();
    if (query?.cursor) {
      searchParams.set('cursor', query.cursor);
    }
    if (query?.limit) {
      searchParams.set('limit', String(query.limit));
    }
    if (query?.order) {
      searchParams.set('order', query.order);
    }
    const queryString = searchParams.toString() ? `?${searchParams.toString()}` : '';

    return request<TopicEvidenceResponse>(
      `/api/v1/hokim/topics/${encodeURIComponent(topicId)}/evidence${queryString}`,
      {
        method: 'GET',
        signal,
      },
      TopicEvidenceResponseSchema,
    );
  },

  getStatistics(
    params?: HokimTopicStatisticsQuery,
    signal?: AbortSignal,
  ): Promise<HokimTopicStatisticsResponse> {
    const searchParams = new URLSearchParams();
    if (params) {
      if (params.dateScope) {
        searchParams.set('dateScope', params.dateScope);
      }
      if (params.dateFrom) {
        searchParams.set('dateFrom', params.dateFrom);
      }
      if (params.dateTo) {
        searchParams.set('dateTo', params.dateTo);
      }
      if (params.mahallaName) {
        searchParams.set('mahallaName', params.mahallaName);
      }
      if (params.lanes) {
        const lanesStr = Array.isArray(params.lanes) ? params.lanes.join(',') : String(params.lanes);
        if (lanesStr) {
          searchParams.set('lanes', lanesStr);
        }
      }
      if (params.calendarDay) {
        searchParams.set('calendarDay', params.calendarDay);
      }
    }
    const queryString = searchParams.toString() ? `?${searchParams.toString()}` : '';

    return request<HokimTopicStatisticsResponse>(
      `/api/v1/hokim/topics/statistics${queryString}`,
      {
        method: 'GET',
        signal,
      },
      HokimTopicStatisticsResponseSchema,
    );
  },

  searchBoard(
    body: HokimTopicBoardSearchBody,
    signal?: AbortSignal,
  ): Promise<HokimTopicBoardResponse> {
    return request<HokimTopicBoardResponse>(
      '/api/v1/hokim/topics/board/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
      HokimTopicBoardResponseSchema,
    );
  },

  searchLane(
    body: HokimLaneSearchBody,
    signal?: AbortSignal,
  ): Promise<HokimLaneResponse> {
    return request<HokimLaneResponse>(
      '/api/v1/hokim/topics/lane/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
      HokimLaneResponseSchema,
    );
  },

  searchStatistics(
    body: HokimTopicStatisticsSearchBody,
    signal?: AbortSignal,
  ): Promise<HokimTopicStatisticsResponse> {
    return request<HokimTopicStatisticsResponse>(
      '/api/v1/hokim/topics/statistics/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
      HokimTopicStatisticsResponseSchema,
    );
  },
};

