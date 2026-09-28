import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HokimDashboardPage } from '../../src/pages/HokimDashboardPage.js';
import { TopicEvidencePage } from '../../src/pages/TopicEvidencePage.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { HokimTopicBoardResponse, TopicCardItem, TopicEvidenceResponse } from '@mahalla-ovozi/api-contracts';

const mockTopic: TopicCardItem = {
  id: 'top_1',
  districtId: 'dist_1',
  mahallaName: 'Боғсарой маҳалласи',
  calendarDay: '2026-08-23',
  summary: 'Сув босими пасайиши кузатилмоқда.',
  primaryLane: 'WATER',
  lanes: ['WATER', 'HOKIM_RELATED'],
  additionalLanes: ['HOKIM_RELATED'],
  evidenceCount: 4,
  latestMeaningfulActivityTimestamp: '2026-08-23T10:30:00.000Z',
  isNew: false,
  isUpdated: false,
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:30:00.000Z',
};

const mockBoardResponse: HokimTopicBoardResponse = {
  districtId: 'dist_1',
  districtName: 'Яккасарой тумани',
  calendarDay: '2026-08-23',
  evaluationId: '11111111-2222-4333-8444-555555555555',
  visitBaselineTimestamp: '2026-08-23T08:00:00.000Z',
  currentVisitTimestamp: '2026-08-23T10:30:00.000Z',
  serverEvaluatedAt: '2026-08-23T10:30:00.000Z',
  hasProcessingDelay: false,
  lanes: {
    HOKIM_RELATED: {
      lane: 'HOKIM_RELATED',
      topics: [mockTopic],
      totalCount: 1,
      nextCursor: null,
      hasNextPage: false,
    },
    WATER: {
      lane: 'WATER',
      topics: [mockTopic],
      totalCount: 1,
      nextCursor: null,
      hasNextPage: false,
    },
    ELECTRICITY: {
      lane: 'ELECTRICITY',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
    GAS: {
      lane: 'GAS',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
    WASTE: {
      lane: 'WASTE',
      topics: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    },
  },
};

const mockEvidenceResponse: TopicEvidenceResponse = {
  topic: mockTopic,
  anchorQuote: 'Сув босими пасайиши кузатилмоқда.',
  anchorEvidenceId: 'evi_1',
  evidence: [
    {
      id: 'evi_1',
      topicId: 'top_1',
      verbatimText: 'Сув босими пасайиши кузатилмоқда.',
      contentType: 'TEXT',
      originalTimestamp: '2026-08-23T10:00:00.000Z',
      formattedTime: '23.08.2026 15:00',
      authorName: 'Алишер',
      authorUsername: '@alisher',
      isAnchor: true,
      isHokimRelated: false,
      telegramDeepLink: 'https://t.me/c/123/1',
    },
  ],
  totalCount: 1,
  nextCursor: null,
  hasNextPage: false,
};

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeAll(() => {
  setupMatchMedia();
});

describe('Mobile Evidence Back Navigation Integration Test', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    setupMatchMedia();
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500, // Mobile screen width
    });

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_yakkasaroy',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: false,
      },
      session: {
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });

    let boardFetchCount = 0;
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async (params) => {
      boardFetchCount++;
      return {
        ...mockBoardResponse,
        evaluationId: `eval_${boardFetchCount}`,
        serverEvaluatedAt: new Date().toISOString(),
        currentVisitTimestamp: new Date().toISOString(),
        visitBaselineTimestamp:
          (typeof params === 'object' && params !== null ? params.baselineTimestamp : undefined) ??
          '2026-08-23T08:00:00.000Z',
        lanes: {
          ...mockBoardResponse.lanes,
          WATER: {
            ...mockBoardResponse.lanes.WATER!,
            topics: [
              {
                ...mockTopic,
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        },
      };
    });
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValue(mockEvidenceResponse);
  });

  it('navigating to evidence page on mobile and returning displays topic cards and does not sequester them into notification badge', async () => {
    render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AuthProvider>
              <MemoryRouter initialEntries={['/']}>
                <Routes>
                  <Route path="/" element={<HokimDashboardPage />} />
                  <Route path="/topics/:topicId/evidence" element={<TopicEvidencePage />} />
                </Routes>
              </MemoryRouter>
            </AuthProvider>
          </ConfigProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );

    // 1. Initial Dashboard Load: Topic is visible in WATER lane
    await waitFor(() => {
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    });

    // Verify 0 notification badge
    expect(screen.queryByText(/\+.*янги/)).toBeNull();

    // 2. Click topic card to navigate to evidence page on mobile
    const topicCard = screen.getAllByText('Сув босими пасайиши кузатилмоқда.')[0]!;
    fireEvent.click(topicCard);

    // 3. Evidence page is displayed
    await waitFor(() => {
      expect(screen.getByText('Мавзу далиллари')).toBeTruthy();
    });

    // 4. Click back button ("Бош саҳифага қайтиш")
    const backBtn = screen.getByRole('button', { name: /Бош саҳифага қайтиш/i });
    fireEvent.click(backBtn);

    // 5. Returned to dashboard
    await waitFor(() => {
      expect(screen.queryByText('Мавзу далиллари')).toBeNull();
    });

    // Check if topic cards are visible in lanes vs notification badge
    const badges = screen.queryAllByText(/\+.*янги/);
    const cards = screen.queryAllByText('Сув босими пасайиши кузатилмоқда.');

    expect(badges.length).toBe(0);
    expect(cards.length).toBeGreaterThan(0);
  });

  it('navigating back when a new topic arrived during evidence inspection keeps existing topic visible and buffers the new topic with a badge', async () => {
    let currentTopics = [mockTopic];

    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => ({
      ...mockBoardResponse,
      currentVisitTimestamp: new Date().toISOString(),
      lanes: {
        ...mockBoardResponse.lanes,
        WATER: {
          ...mockBoardResponse.lanes.WATER!,
          topics: currentTopics,
          totalCount: currentTopics.length,
        },
      },
    }));

    render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AuthProvider>
              <MemoryRouter initialEntries={['/']}>
                <Routes>
                  <Route path="/" element={<HokimDashboardPage />} />
                  <Route path="/topics/:topicId/evidence" element={<TopicEvidencePage />} />
                </Routes>
              </MemoryRouter>
            </AuthProvider>
          </ConfigProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );

    // Initial load: top_1 visible
    await waitFor(() => {
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    });

    // Navigate to evidence page
    const card = screen.getAllByText('Сув босими пасайиши кузатилмоқда.')[0]!;
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByText('Мавзу далиллари')).toBeTruthy();
    });

    // While user is inspecting evidence, a new topic arrives on server
    const newTopic: TopicCardItem = {
      ...mockTopic,
      id: 'top_new_2',
      summary: 'Янги сув қувури носозлиги.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isNew: true,
    };
    currentTopics = [newTopic, mockTopic];

    // Return to dashboard
    const backBtn = screen.getByRole('button', { name: /Бош саҳифага қайтиш/i });
    fireEvent.click(backBtn);

    await waitFor(() => {
      expect(screen.queryByText('Мавзу далиллари')).toBeNull();
    });

    // Invalidate query to trigger background refetch
    await queryClient.invalidateQueries({ queryKey: ['hokim-board'] });

    // Existing card top_1 remains visible in WATER lane
    await waitFor(() => {
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    });

    // Both existing and newly arrived topics are visible
    await waitFor(() => {
      expect(screen.getAllByText('Янги сув қувури носозлиги.').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    });
  });

  it('navigating back retains paginated topics loaded before viewing evidence', async () => {
    const page1Board: HokimTopicBoardResponse = {
      ...mockBoardResponse,
      lanes: {
        ...mockBoardResponse.lanes,
        WATER: {
          ...mockBoardResponse.lanes.WATER!,
          topics: [mockTopic],
          totalCount: 2,
          nextCursor: 'cursor_page_2',
          hasNextPage: true,
        },
      },
    };

    const paginatedTopic: TopicCardItem = {
      ...mockTopic,
      id: 'top_page_2',
      summary: 'Иккинчи саҳифадаги сув муаммоси.',
      createdAt: '2026-08-23T09:00:00.000Z',
      updatedAt: '2026-08-23T09:30:00.000Z',
    };

    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => page1Board);
    vi.spyOn(hokimTopicsClient, 'getLaneBatch').mockResolvedValue({
      lane: 'WATER',
      topics: [paginatedTopic],
      nextCursor: null,
      hasNextPage: false,
    });
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValue({
      ...mockEvidenceResponse,
      topic: paginatedTopic,
    });

    render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AuthProvider>
              <MemoryRouter initialEntries={['/']}>
                <Routes>
                  <Route path="/" element={<HokimDashboardPage />} />
                  <Route path="/topics/:topicId/evidence" element={<TopicEvidencePage />} />
                </Routes>
              </MemoryRouter>
            </AuthProvider>
          </ConfigProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );

    // Initial load: top_1 visible
    await waitFor(() => {
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    });

    // Click load more button on WATER lane
    const loadMoreBtn = screen.getByRole('button', {
      name: /Сув бўйича яна 20 та мавзуни юклаш/i,
    });
    fireEvent.click(loadMoreBtn);

    // Paginated topic is rendered
    await waitFor(() => {
      expect(screen.getAllByText('Иккинчи саҳифадаги сув муаммоси.').length).toBeGreaterThan(0);
    });

    // Select the paginated card on mobile to view evidence
    const paginatedCard = screen.getAllByText('Иккинчи саҳифадаги сув муаммоси.')[0]!;
    fireEvent.click(paginatedCard);

    // Evidence page is displayed
    await waitFor(() => {
      expect(screen.getByText('Мавзу далиллари')).toBeTruthy();
    });

    // Click back button to return to dashboard
    const backBtn = screen.getByRole('button', { name: /Бош саҳифага қайтиш/i });
    fireEvent.click(backBtn);

    await waitFor(() => {
      expect(screen.queryByText('Мавзу далиллари')).toBeNull();
    });

    // BOTH page 1 topic and paginated page 2 topic MUST remain visible
    expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Иккинчи саҳифадаги сув муаммоси.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\+.*янги/)).toBeNull();
  });

  it('navigating to evidence page on mobile with active filter query parameters preserves URL search params and retains cards on return', async () => {
    let capturedParams: Record<string, unknown> = {};
    vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async (params) => {
      if (typeof params === 'object' && params !== null) {
        capturedParams = params as Record<string, unknown>;
      }
      return {
        ...mockBoardResponse,
        lanes: {
          ...mockBoardResponse.lanes,
          WATER: {
            ...mockBoardResponse.lanes.WATER!,
            topics: [mockTopic],
            totalCount: 1,
            hasNextPage: false,
          },
        },
      };
    });

    render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AuthProvider>
              <MemoryRouter initialEntries={['/?dateScope=yesterday&lanes=WATER']}>
                <Routes>
                  <Route path="/" element={<HokimDashboardPage />} />
                  <Route path="/topics/:topicId/evidence" element={<TopicEvidencePage />} />
                </Routes>
              </MemoryRouter>
            </AuthProvider>
          </ConfigProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    );

    // Initial load: top_1 visible under filtered query
    await waitFor(() => {
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    });
    expect(capturedParams.dateScope).toBe('yesterday');

    // Click card to navigate to evidence page
    const card = screen.getAllByText('Сув босими пасайиши кузатилмоқда.')[0]!;
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByText('Мавзу далиллари')).toBeTruthy();
    });

    // Click back button to return to dashboard
    const backBtn = screen.getByRole('button', { name: /Бош саҳифага қайтиш/i });
    fireEvent.click(backBtn);

    await waitFor(() => {
      expect(screen.queryByText('Мавзу далиллари')).toBeNull();
    });

    // Cards remain visible under preserved filters with 0 sequestered badges
    expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\+.*янги/)).toBeNull();
  });
});
