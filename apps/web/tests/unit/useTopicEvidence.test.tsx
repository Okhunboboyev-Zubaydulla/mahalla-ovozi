import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTopicEvidence } from '../../src/topics/useTopicEvidence.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { TopicEvidenceResponse, TopicCardItem, TopicEvidenceItem } from '@mahalla-ovozi/api-contracts';

const mockActor = {
  id: 'acc_hokim_1',
  username: 'hokim_yakkasaroy',
  role: 'DISTRICT_HOKIM' as const,
  districtId: 'dist_yakka_1',
  mustChangePassword: false,
};

const mockTopic: TopicCardItem = {
  id: 'top_100',
  districtId: 'dist_yakka_1',
  mahallaName: 'Дўстлик',
  calendarDay: '2026-08-24',
  summary: 'Сув таъминоти муаммоси.',
  primaryLane: 'WATER',
  lanes: ['WATER'],
  additionalLanes: [],
  evidenceCount: 2,
  latestMeaningfulActivityTimestamp: '2026-08-24T09:00:00.000Z',
  isNew: false,
  isUpdated: false,
  createdAt: '2026-08-24T08:00:00.000Z',
  updatedAt: '2026-08-24T09:00:00.000Z',
};

describe('Story 3.3: useTopicEvidence Synchronization & Invalidation Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    queryClient.setQueryData(['auth', 'session'], {
      actor: mockActor,
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });

    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: mockActor,
      session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
    });
  });

  const createWrapper = () => {
    return ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };

  it('Test 1: Merges newly arrived evidence items and orders oldest-to-newest (AC 5)', async () => {
    const evidenceOlder: TopicEvidenceItem = {
      id: 'evi_1',
      topicId: 'top_100',
      originalTimestamp: '2026-08-24T08:10:00.000Z',
      formattedTime: '08:10',
      verbatimText: 'Сув соат 8 да ўчди.',
      contentType: 'TEXT',
      authorName: 'Алишер',
      authorUsername: 'alisher',
      isAnchor: true,
      isHokimRelated: false,
      telegramDeepLink: null,
    };

    const evidenceNewer: TopicEvidenceItem = {
      id: 'evi_2',
      topicId: 'top_100',
      originalTimestamp: '2026-08-24T08:50:00.000Z',
      formattedTime: '08:50',
      verbatimText: 'Ҳали ҳам сув йўқ.',
      contentType: 'TEXT',
      authorName: 'Бобур',
      authorUsername: 'bobur',
      isAnchor: false,
      isHokimRelated: false,
      telegramDeepLink: null,
    };

    // Return newer first from API to verify frontend sorting chronologically
    const mockEvidenceResponse: TopicEvidenceResponse = {
      topic: mockTopic,
      anchorQuote: 'Сув соат 8 да ўчди.',
      anchorEvidenceId: 'evi_1',
      evidence: [evidenceNewer, evidenceOlder],
      totalCount: 2,
      nextCursor: null,
      hasNextPage: false,
    };

    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse);

    const { result } = renderHook(() => useTopicEvidence('top_100'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.evidenceList.length).toBe(2);
    // Oldest first
    expect(result.current.evidenceList[0]?.id).toBe('evi_1');
    expect(result.current.evidenceList[1]?.id).toBe('evi_2');
  });

  it('Test 2: Intercepts 404 TopicNotFoundError, sets isInvalidated and triggers onInvalidated callback (AC 5)', async () => {
    const onInvalidatedMock = vi.fn();
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockRejectedValueOnce(
      new Error('Topic not found (404)'),
    );

    const { result } = renderHook(
      () => useTopicEvidence('top_deleted_404', { onInvalidated: onInvalidatedMock }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.isInvalidated).toBe(true);
    expect(onInvalidatedMock).toHaveBeenCalledTimes(1);
  });

  it('Test 3: Synchronizes active board query evidenceCount immediately in React Query cache', async () => {
    // Seed existing board data with old evidenceCount = 1
    queryClient.setQueryData(['hokim-board', 'dist_yakka_1', 'today', null, null, null, 'WATER,ELECTRICITY,GAS,WASTE,HOKIM_RELATED', null], {
      districtId: 'dist_yakka_1',
      districtName: 'Яккасарой',
      calendarDay: '2026-08-24',
      evaluationId: 'eval_1',
      visitBaselineTimestamp: '2026-08-24T08:00:00.000Z',
      currentVisitTimestamp: '2026-08-24T09:00:00.000Z',
      serverEvaluatedAt: '2026-08-24T09:00:00.000Z',
      hasProcessingDelay: false,
      lanes: {
        WATER: {
          lane: 'WATER',
          topics: [
            {
              ...mockTopic,
              evidenceCount: 1, // Old count
            },
          ],
          totalCount: 1,
          nextCursor: null,
          hasNextPage: false,
        },
      },
    });

    const mockEvidenceResponse: TopicEvidenceResponse = {
      topic: {
        ...mockTopic,
        evidenceCount: 3, // New count
        latestMeaningfulActivityTimestamp: '2026-08-24T09:15:00.000Z',
      },
      anchorQuote: 'Сув соат 8 да ўчди.',
      anchorEvidenceId: 'evi_1',
      evidence: [],
      totalCount: 3,
      nextCursor: null,
      hasNextPage: false,
    };

    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse);

    const { result } = renderHook(() => useTopicEvidence('top_100'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Verify cache was immediately updated
    const boardCache = queryClient.getQueryData<any>([
      'hokim-board',
      'dist_yakka_1',
      'today',
      null,
      null,
      null,
      'WATER,ELECTRICITY,GAS,WASTE,HOKIM_RELATED',
      null,
    ]);

    expect(boardCache?.lanes?.WATER?.topics[0]?.evidenceCount).toBe(3);
    expect(boardCache?.lanes?.WATER?.topics[0]?.latestMeaningfulActivityTimestamp).toBe('2026-08-24T09:15:00.000Z');
  });

  it('passes order DESC to getTopicEvidence and sorts evidenceList descending', async () => {
    const itemOld: TopicEvidenceItem = {
      id: 'evi_1',
      topicId: 'top_100',
      verbatimText: 'Эски хабар',
      contentType: 'TEXT',
      originalTimestamp: '2026-08-24T08:00:00.000Z',
      formattedTime: '24.08.2026 13:00',
      authorName: 'Алишер',
      authorUsername: '@alisher',
      isAnchor: true,
      isHokimRelated: false,
      telegramDeepLink: null,
    };

    const itemNew: TopicEvidenceItem = {
      id: 'evi_2',
      topicId: 'top_100',
      verbatimText: 'Янги хабар',
      contentType: 'TEXT',
      originalTimestamp: '2026-08-24T09:00:00.000Z',
      formattedTime: '24.08.2026 14:00',
      authorName: 'Ботир',
      authorUsername: '@botir',
      isAnchor: false,
      isHokimRelated: false,
      telegramDeepLink: null,
    };

    const mockEvidenceResponse: TopicEvidenceResponse = {
      topic: mockTopic,
      anchorQuote: 'Эски хабар',
      anchorEvidenceId: 'evi_1',
      evidence: [itemNew, itemOld],
      totalCount: 2,
      nextCursor: null,
      hasNextPage: false,
    };

    const getSpy = vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse);

    const { result } = renderHook(() => useTopicEvidence('top_100', { order: 'DESC' }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getSpy).toHaveBeenCalledWith(
      'top_100',
      expect.objectContaining({ order: 'DESC' }),
      expect.any(AbortSignal),
    );

    expect(result.current.evidenceList[0]?.id).toBe('evi_2');
    expect(result.current.evidenceList[1]?.id).toBe('evi_1');
  });
});
