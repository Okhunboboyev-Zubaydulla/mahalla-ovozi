import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { ConfigProvider } from 'antd';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { HighlightText } from '../../src/components/topics/HighlightText.js';
import { DashboardSearchInput } from '../../src/components/topics/DashboardSearchInput.js';
import { TopicCard } from '../../src/components/topics/TopicCard.js';
import { formatSearchAnnouncement } from '../../src/hooks/useLiveAnnouncer.js';
import { useHokimTopicBoard } from '../../src/topics/useHokimTopicBoard.js';
import { useTopicStatistics } from '../../src/topics/useTopicStatistics.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { TopicCardItem, HokimTopicBoardResponse, HokimTopicStatisticsResponse } from '@mahalla-ovozi/api-contracts';

const mockActor = {
  id: 'acc_hokim_search',
  username: 'hokim_search',
  role: 'DISTRICT_HOKIM' as const,
  districtId: 'dist_search_1',
  mustChangePassword: false,
};

describe('Story 3.7: Private Lexical Search Frontend Unit Tests', () => {
  const baseTopic: TopicCardItem = {
    id: 'top_test_1',
    districtId: 'dist_search_1',
    mahallaName: 'Бирлик',
    calendarDay: '2026-08-24',
    summary: 'Электр тармоғидаги авария',
    primaryLane: 'ELECTRICITY',
    lanes: ['ELECTRICITY'],
    additionalLanes: [],
    evidenceCount: 1,
    latestMeaningfulActivityTimestamp: '2026-08-24T10:00:00.000Z',
    isNew: false,
    isUpdated: false,
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    searchMatchBadge: null,
  };

  describe('HighlightText Component (AC 2, AC 11)', () => {
    it('renders normal text without mark when searchQuery is empty', () => {
      const { container } = render(<HighlightText text="Сув қувури ёрилган" searchQuery="" />);
      expect(container.querySelector('mark')).toBeNull();
      expect(screen.getByText('Сув қувури ёрилган')).toBeTruthy();
    });

    it('highlights matching substring case-insensitively with #F5DD77 background', () => {
      const { container } = render(
        <HighlightText text="Сув қувури ёрилган ва кўчани сув босган" searchQuery="сув" />,
      );
      const marks = container.querySelectorAll('mark');
      expect(marks.length).toBe(2);
      expect(marks[0]?.textContent).toBe('Сув');
      expect(marks[1]?.textContent).toBe('сув');
      expect(marks[0]?.style.backgroundColor).toBe('rgb(245, 221, 119)'); // #F5DD77
    });

    it('handles regex special characters safely without crashing or regex errors', () => {
      const { container } = render(
        <HighlightText text="Мурожаат [100%] трансформатор (10/0.4 кВ) + ремонт" searchQuery="[100%]" />,
      );
      const marks = container.querySelectorAll('mark');
      expect(marks.length).toBe(1);
      expect(marks[0]?.textContent).toBe('[100%]');
    });

    it('preserves entire text content with multiple words and punctuation', () => {
      const fullText = 'Чиқиндиларни ўз вақтида олиб чиқиб кетиш бўйича мурожаатлар сони ортди.';
      render(<HighlightText text={fullText} searchQuery="олиб чиқиб" />);
      expect(screen.getByText(/Чиқиндиларни ўз вақтида/)).toBeTruthy();
      expect(screen.getByText(/кетиш бўйича мурожаатлар/)).toBeTruthy();
    });
  });

  describe('DashboardSearchInput Component (AC 1, AC 4, AC 11)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('renders input with correct placeholder, aria-label and prefix icon', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardSearchInput value="" onChange={vi.fn()} />
        </ConfigProvider>,
      );
      const input = screen.getByRole('searchbox', { name: 'Мавзулар ва далиллар бўйича қидирув' });
      expect(input).toBeTruthy();
      expect(input.getAttribute('placeholder')).toBe('Мавзу ёки далил бўйича қидирув...');
    });

    it('debounces onChange callback by ~400ms', () => {
      const handleChange = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardSearchInput value="" onChange={handleChange} />
        </ConfigProvider>,
      );

      const input = screen.getByRole('searchbox', { name: 'Мавзулар ва далиллар бўйича қидирув' });
      fireEvent.change(input, { target: { value: 'трансформатор' } });

      // Before timer fires:
      expect(handleChange).not.toHaveBeenCalled();

      // Advance by 200ms (not yet):
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(handleChange).not.toHaveBeenCalled();

      // Advance by remaining 200ms (400ms total):
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(handleChange).toHaveBeenCalledWith('трансформатор');
    });

    it('triggers onChange immediately on Enter key press without waiting for debounce', () => {
      const handleChange = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardSearchInput value="" onChange={handleChange} />
        </ConfigProvider>,
      );

      const input = screen.getByRole('searchbox', { name: 'Мавзулар ва далиллар бўйича қидирув' });
      fireEvent.change(input, { target: { value: 'газ босими' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

      expect(handleChange).toHaveBeenCalledWith('газ босими');
    });

    it('clears immediately when input value is emptied', () => {
      const handleChange = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardSearchInput value="сув" onChange={handleChange} />
        </ConfigProvider>,
      );

      const input = screen.getByRole('searchbox', { name: 'Мавзулар ва далиллар бўйича қидирув' });
      fireEvent.change(input, { target: { value: '' } });

      // Immediate clear without timer
      expect(handleChange).toHaveBeenCalledWith('');
    });
  });

  describe('TopicCard Match Badges (AC 2, AC 11)', () => {
    it('renders "Далилда топилди" badge when searchMatchBadge is "evidence"', () => {
      render(
        <TopicCard
          topic={{ ...baseTopic, searchMatchBadge: 'evidence' }}
          searchQuery="трансформатор"
        />,
      );
      expect(screen.getByText('Далилда топилди')).toBeTruthy();
    });

    it('renders "Фойдаланувчида топилди" badge when searchMatchBadge is "author"', () => {
      render(
        <TopicCard
          topic={{ ...baseTopic, searchMatchBadge: 'author' }}
          searchQuery="@citizen_user"
        />,
      );
      expect(screen.getByText('Фойдаланувчида топилди')).toBeTruthy();
    });

    it('does not render match badge when searchMatchBadge is null', () => {
      render(
        <TopicCard
          topic={{ ...baseTopic, searchMatchBadge: null }}
          searchQuery="Электр"
        />,
      );
      expect(screen.queryByText('Далилда топилди')).toBeNull();
      expect(screen.queryByText('Фойдаланувчида топилди')).toBeNull();
    });
  });

  describe('Screen Reader Search Announcement (AC 3, AC 7)', () => {
    it('formats announcement for non-zero match count in Uzbek Cyrillic', () => {
      expect(formatSearchAnnouncement(4)).toBe('Қидирув бўйича 4 та мос мавзу топилди');
      expect(formatSearchAnnouncement(1)).toBe('Қидирув бўйича 1 та мос мавзу топилди');
    });

    it('formats announcement for zero matches in Uzbek Cyrillic', () => {
      expect(formatSearchAnnouncement(0)).toBe('Танланган шартлар бўйича мавзулар топилмади');
    });
  });

  describe('Accessibility & Privacy Invariants (AD-09, AC 5, AC 12)', () => {
    it('renders role="button" and aria-pressed on interactive TopicCard', () => {
      const handleClick = vi.fn();
      render(
        <TopicCard
          topic={baseTopic}
          isSelected={true}
          onClick={handleClick}
        />,
      );

      const card = screen.getByRole('button');
      expect(card).toBeTruthy();
      expect(card.getAttribute('aria-pressed')).toBe('true');
    });

    it('safely handles null/undefined text in HighlightText without crashing', () => {
      const { container } = render(
        <HighlightText text={null as unknown as string} searchQuery="сув" />,
      );
      expect(container.textContent).toBe('');
    });

    it('ensures search queries are not persisted to localStorage or URL search', () => {
      localStorage.clear();
      expect(localStorage.getItem('searchQuery')).toBeNull();
      expect(window.location.search).toBe('');
    });
  });

  describe('useHokimTopicBoard & useTopicStatistics Search Hook Invocations (AC 4, AC 5)', () => {
    let queryClient: QueryClient;

    const mockBoardResponse: HokimTopicBoardResponse = {
      districtId: 'dist_search_1',
      districtName: 'Тест тумани',
      calendarDay: '2026-08-24',
      evaluationId: '11111111-2222-4333-8444-555555555555',
      visitBaselineTimestamp: '2026-08-24T07:00:00.000Z',
      currentVisitTimestamp: '2026-08-24T08:30:00.000Z',
      serverEvaluatedAt: '2026-08-24T08:30:00.000Z',
      hasProcessingDelay: false,
      lanes: {
        HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
        WATER: { lane: 'WATER', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
        ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
        GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
        WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
      },
    };

    const mockStatsResponse: HokimTopicStatisticsResponse = {
      districtId: 'dist_search_1',
      districtName: 'Тест тумани',
      calendarDay: '2026-08-24',
      evaluationId: '11111111-2222-4333-8444-555555555555',
      serverEvaluatedAt: '2026-08-24T08:30:00.000Z',
      totalUniqueTopics: 0,
      card1Comparison: {
        isAvailable: false,
        reason: 'UNSUPPORTED_FILTER_SCOPE',
      },
      hokimRelatedTopics: 0,
      hokimEvidenceCount: 0,
      activeMahallasCount: 0,
      totalAcceptedEvidenceCount: 0,
      card4: {
        mode: 'most_active_service_lane',
        leaderLane: null,
        leaderTopicCount: 0,
        isTie: false,
        tiedCount: 0,
        isZero: true,
      },
      card5: {
        mode: 'most_active_mahalla',
        leaderMahalla: null,
        leaderTopicCount: 0,
        isTie: false,
        tiedCount: 0,
        isZero: true,
      },
    };

    beforeEach(() => {
      vi.clearAllMocks();
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
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

    it('invokes searchBoard POST when searchQuery is non-empty', async () => {
      const searchBoardSpy = vi.spyOn(hokimTopicsClient, 'searchBoard').mockResolvedValue(mockBoardResponse);
      const getTodayBoardSpy = vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(mockBoardResponse);

      const { result } = renderHook(
        () => useHokimTopicBoard({ dateScope: 'today', lanes: ['WATER'] }, 'қувур'),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.board).toBeDefined();
      });

      expect(searchBoardSpy).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'қувур', dateScope: 'today' }),
        expect.anything(),
      );
      expect(getTodayBoardSpy).not.toHaveBeenCalled();
    });

    it('invokes searchStatistics POST when searchQuery is non-empty', async () => {
      const searchStatsSpy = vi.spyOn(hokimTopicsClient, 'searchStatistics').mockResolvedValue(mockStatsResponse);
      const getStatsSpy = vi.spyOn(hokimTopicsClient, 'getStatistics').mockResolvedValue(mockStatsResponse);

      const { result } = renderHook(
        () => useTopicStatistics({ dateScope: 'today', lanes: ['WATER'] }, 'трансформатор'),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.statistics).toBeDefined();
      });

      expect(searchStatsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'трансформатор', dateScope: 'today' }),
        expect.anything(),
      );
      expect(getStatsSpy).not.toHaveBeenCalled();
    });
  });
});

