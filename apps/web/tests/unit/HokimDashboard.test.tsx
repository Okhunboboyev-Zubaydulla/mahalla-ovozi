import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HokimDashboardPage } from '../../src/pages/HokimDashboardPage.js';
import { FiveLaneBoard } from '../../src/components/topics/FiveLaneBoard.js';
import { TopicCard } from '../../src/components/topics/TopicCard.js';
import { LaneColumn } from '../../src/components/topics/LaneColumn.js';
import { BoardToolbar } from '../../src/components/topics/BoardToolbar.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { HokimTopicBoardResponse, TopicCardItem } from '@mahalla-ovozi/api-contracts';

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
  isNew: true,
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
      topics: [
        {
          ...mockTopic,
          id: 'top_1',
          additionalLanes: ['WATER'],
        },
      ],
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

describe('Hokim Dashboard Component & Integration Tests (Story 3.1)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    setupMatchMedia();
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
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AuthProvider>
            <BrowserRouter>
              <HokimDashboardPage />
            </BrowserRouter>
          </AuthProvider>
        </ConfigProvider>
      </QueryClientProvider>,
    );
  }

  describe('BoardToolbar Component (AC 2)', () => {
    it('renders wordmark, district name, formatted date, and sign out control', () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AuthProvider>
              <BrowserRouter>
                <BoardToolbar
                  districtName="Яккасарой тумани"
                  calendarDay="2026-08-23"
                />
              </BrowserRouter>
            </AuthProvider>
          </ConfigProvider>
        </QueryClientProvider>,
      );

      expect(screen.getByText('Маҳалла Овози')).toBeTruthy();
      expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
      const profileButton = screen.getByRole('button', { name: /Ҳоким профили/i });
      expect(profileButton).toBeTruthy();
      fireEvent.click(profileButton);
      expect(screen.getByRole('button', { name: /Тизимдан чиқиш/i })).toBeTruthy();
    });
  });

  describe('TopicCard Component (AC 4)', () => {
    it('renders complete summary, mahalla name, activity time, evidence count, and new tag', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <TopicCard topic={mockTopic} currentLane="WATER" />
        </ConfigProvider>,
      );

      expect(screen.getByText('Боғсарой маҳалласи')).toBeTruthy();
      expect(screen.getByText('Сув босими пасайиши кузатилмоқда.')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByText('Янги мавзу')).toBeTruthy();
      expect(screen.getByText('Ҳокимга мурожаат бор')).toBeTruthy();
    });

    it('renders unread delta badge in footer when isUpdated is true and isNew is false', () => {
      const updatedTopic: TopicCardItem = {
        ...mockTopic,
        isNew: false,
        isUpdated: true,
      };

      render(
        <ConfigProvider theme={mahallaTheme}>
          <TopicCard topic={updatedTopic} currentLane="WATER" />
        </ConfigProvider>,
      );

      expect(screen.getByText('+')).toBeTruthy();
      expect(screen.queryByText('Янги мавзу')).toBeNull();
      expect(screen.queryByText('Янги хабар')).toBeNull();
    });

    it('renders explicit numeric unread delta badge when provided and displays base count correctly', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <TopicCard topic={mockTopic} currentLane="WATER" unreadDelta={1} />
        </ConfigProvider>,
      );

      expect(screen.getByText('+1')).toBeTruthy();
      // mockTopic has evidenceCount: 4. With unreadDelta: 1, displayedEvidenceCount is 4 - 1 = 3.
      expect(screen.getByText('3')).toBeTruthy();
    });
  });

  describe('LaneColumn & FiveLaneBoard Component (AC 3, 6, 7)', () => {
    it('renders all 5 fixed canonical lanes in order', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <FiveLaneBoard
            lanes={{
              HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [mockTopic], totalCount: 1, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WATER: { lane: 'WATER', topics: [mockTopic], totalCount: 1, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
            }}
            onLoadMore={vi.fn()}
          />
        </ConfigProvider>,
      );

      expect(screen.getAllByText('Ҳокимга оид').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Сув').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Электр')).toBeTruthy();
      expect(screen.getByText('Газ')).toBeTruthy();
      expect(screen.getByText('Чиқинди')).toBeTruthy();
    });

    it('renders empty board state when all 5 lanes have 0 topics (AC 7)', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <FiveLaneBoard
            lanes={{
              HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WATER: { lane: 'WATER', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
            }}
            onLoadMore={vi.fn()}
          />
        </ConfigProvider>,
      );

      expect(screen.getByText('Бугун ҳозирча мавзулар йўқ')).toBeTruthy();
    });

    it('applies ergonomic maxWidth of 480px to lane columns when fewer than 5 lanes are active', () => {
      const { container } = render(
        <ConfigProvider theme={mahallaTheme}>
          <FiveLaneBoard
            lanes={{
              HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WATER: { lane: 'WATER', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
            }}
            activeLanes={['WATER', 'ELECTRICITY', 'GAS', 'WASTE']}
            onLoadMore={vi.fn()}
          />
        </ConfigProvider>,
      );

      const waterSection = container.querySelector<HTMLElement>('section[aria-labelledby="lane-header-WATER"]');
      expect(waterSection).toBeTruthy();
      expect(waterSection?.style.maxWidth).toBe('480px');

      const boardContainer = container.querySelector<HTMLElement>('div[aria-label="Йўналишлар панели"]');
      expect(boardContainer?.style.justifyContent).toBe('flex-start');
    });

    it('centers lanes with safe center when 3 or fewer lanes are active', () => {
      const { container } = render(
        <ConfigProvider theme={mahallaTheme}>
          <FiveLaneBoard
            lanes={{
              HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WATER: { lane: 'WATER', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
              WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false, isLoadingMore: false, loadMoreError: null },
            }}
            activeLanes={['WATER', 'GAS', 'WASTE']}
            onLoadMore={vi.fn()}
          />
        </ConfigProvider>,
      );

      const boardContainer = container.querySelector<HTMLElement>('div[aria-label="Йўналишлар панели"]');
      expect(boardContainer?.style.justifyContent).toBe('safe center');
    });

    it('shows load more button and handles click', () => {
      const handleLoadMore = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <LaneColumn
            lane="WATER"
            topics={[mockTopic]}
            totalCount={25}
            hasNextPage={true}
            isLoadingMore={false}
            loadMoreError={null}
            onLoadMore={handleLoadMore}
          />
        </ConfigProvider>,
      );

      const loadMoreBtn = screen.getByRole('button', { name: /Сув бўйича яна 20 та мавзуни юклаш/i });
      expect(loadMoreBtn).toBeTruthy();
      fireEvent.click(loadMoreBtn);
      expect(handleLoadMore).toHaveBeenCalledTimes(1);
    });

    it('shows retry banner on error and retains existing topic cards (AC 6)', () => {
      const handleRetry = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <LaneColumn
            lane="WATER"
            topics={[mockTopic]}
            totalCount={25}
            hasNextPage={true}
            isLoadingMore={false}
            loadMoreError="Юклаб бўлмади. Қайта уриниш."
            onLoadMore={handleRetry}
          />
        </ConfigProvider>,
      );

      // Existing topic card remains visible
      expect(screen.getByText('Сув босими пасайиши кузатилмоқда.')).toBeTruthy();
      // Retry action visible
      const retryBtn = screen.getByRole('button', { name: /Қайта уриниш/i });
      expect(retryBtn).toBeTruthy();
      fireEvent.click(retryBtn);
      expect(handleRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('HokimDashboardPage Integration (AC 1, 2, 3, 5)', () => {
    it('fetches board and renders complete 5-lane unified dashboard', async () => {
      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValueOnce(mockBoardResponse);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Маҳалла Овози')).toBeTruthy();
        expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
      });

      // Verify topic summary is rendered in both HOKIM_RELATED and WATER lanes
      const summaries = screen.getAllByText('Сув босими пасайиши кузатилмоқда.');
      expect(summaries.length).toBe(2);
    });

    it('renders stale error banner when background refresh fails but retains board (AC 8)', async () => {
      let shouldFail = false;
      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockImplementation(async () => {
        if (shouldFail) {
          throw new Error('Network timeout during refresh');
        }
        return mockBoardResponse;
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
      });

      // Trigger background refresh failure
      shouldFail = true;
      const refreshBtn = screen.getByRole('button', { name: 'Маълумотларни янгилаш' });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(screen.getByText(/Янги маълумотларни юклаб бўлмади/)).toBeTruthy();
      });

      // Board remains mounted and visible
      expect(screen.getAllByText('Сув босими пасайиши кузатилмоқда.').length).toBe(2);
    });

    it('isolates statistics failure to statistics strip without displaying global error banner (AC 4)', async () => {
      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(mockBoardResponse);
      vi.spyOn(hokimTopicsClient, 'getStatistics').mockRejectedValue(
        new Error('Statistics service temporary failure'),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
      });

      // Board is rendered and functional
      const summaries = screen.getAllByText('Сув босими пасайиши кузатилмоқда.');
      expect(summaries.length).toBe(2);

      // Scoped error container is rendered inside statistics region
      await waitFor(() => {
        expect(screen.getByText('Статистика маълумотларини юклаб бўлмади')).toBeTruthy();
      });

      // Global board error banners must NOT be rendered
      expect(screen.queryByText(/Янги маълумотларни юклаб бўлмади/)).toBeNull();
      expect(screen.queryByText(/Юклашда хатолик/)).toBeNull();
    });

    it('coordinated statistics retry triggers both board and statistics refresh (AC 6)', async () => {
      const getBoardSpy = vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(mockBoardResponse);
      let statsFailed = true;
      const getStatsSpy = vi.spyOn(hokimTopicsClient, 'getStatistics').mockImplementation(async () => {
        if (statsFailed) {
          throw new Error('Initial statistics error');
        }
        return {
          districtId: 'dist_1',
          districtName: 'Яккасарой тумани',
          calendarDay: '2026-08-23',
          evaluationId: '22222222-3333-4444-8555-666666666666',
          serverEvaluatedAt: '2026-08-23T10:35:00.000Z',
          totalUniqueTopics: 1,
          hokimRelatedTopics: 1,
          hokimEvidenceCount: 4,
          activeMahallasCount: 1,
          totalAcceptedEvidenceCount: 4,
          card1Comparison: {
            isAvailable: true,
            previousValue: 0,
            delta: 1,
            comparisonPeriodType: 'equivalent_same_time_yesterday',
            comparisonPeriodLabel: 'кечаги шу вақтга нисбатан',
          },
          card4: {
            mode: 'most_active_service_lane',
            leaderLane: 'WATER',
            leaderTopicCount: 1,
            isTie: false,
            tiedCount: 0,
            isZero: false,
          },
          card5: {
            mode: 'most_active_mahalla',
            leaderMahalla: 'Боғсарой маҳалласи',
            leaderTopicCount: 1,
            isTie: false,
            tiedCount: 0,
            isZero: false,
          },
        };
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Статистика маълумотларини юклаб бўлмади')).toBeTruthy();
      });

      // Clear call counts from initial mount
      getBoardSpy.mockClear();
      getStatsSpy.mockClear();

      // Next retry attempt will succeed
      statsFailed = false;

      const retryBtn = screen.getByRole('button', { name: /статистикани қайта юклаш/i });
      fireEvent.click(retryBtn);

      await waitFor(() => {
        // Coordinated retry refetches both board and statistics
        expect(getBoardSpy).toHaveBeenCalled();
        expect(getStatsSpy).toHaveBeenCalled();
        // Statistics strip recovers and renders 5 cards
        expect(screen.getByText('Жами мавзулар')).toBeTruthy();
      });

      // Error alert is removed
      expect(screen.queryByText('Статистика маълумотларини юклаб бўлмади')).toBeNull();
    });
  });
});
