import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HelpContent } from '../../src/components/topics/HelpContent.js';
import { DashboardHelpDrawer } from '../../src/components/topics/DashboardHelpDrawer.js';
import { DashboardHelpPage } from '../../src/pages/DashboardHelpPage.js';
import { HokimDashboardPage } from '../../src/pages/HokimDashboardPage.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { authClient } from '../../src/auth/auth-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { HokimTopicBoardResponse, TopicCardItem, TopicEvidenceResponse } from '@mahalla-ovozi/api-contracts';

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
  id: 'top_help_1',
  districtId: 'dist_1',
  mahallaName: 'Яккасарой маҳалласи',
  calendarDay: '2026-08-24',
  summary: 'Сув босими бўйича мурожаатлар келиб тушди.',
  primaryLane: 'WATER',
  lanes: ['WATER'],
  additionalLanes: [],
  evidenceCount: 3,
  latestMeaningfulActivityTimestamp: '2026-08-24T10:00:00.000Z',
  isNew: true,
  isUpdated: false,
  createdAt: '2026-08-24T06:00:00.000Z',
  updatedAt: '2026-08-24T10:00:00.000Z',
};

const mockBoardResponse: HokimTopicBoardResponse = {
  districtId: 'dist_1',
  districtName: 'Яккасарой тумани',
  calendarDay: '2026-08-24',
  evaluationId: '11111111-2222-4333-8444-555555555555',
  visitBaselineTimestamp: '2026-08-24T08:00:00.000Z',
  currentVisitTimestamp: '2026-08-24T10:00:00.000Z',
  serverEvaluatedAt: '2026-08-24T10:00:00.000Z',
  hasProcessingDelay: false,
  lanes: {
    HOKIM_RELATED: { lane: 'HOKIM_RELATED', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
    WATER: { lane: 'WATER', topics: [mockTopic], totalCount: 1, nextCursor: null, hasNextPage: false },
    ELECTRICITY: { lane: 'ELECTRICITY', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
    GAS: { lane: 'GAS', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
    WASTE: { lane: 'WASTE', topics: [], totalCount: 0, nextCursor: null, hasNextPage: false },
  },
};

const mockEvidenceResponse: TopicEvidenceResponse = {
  topic: mockTopic,
  anchorQuote: 'Сув босими жуда паст.',
  anchorEvidenceId: 'evi_1',
  evidence: [
    {
      id: 'evi_1',
      topicId: 'top_help_1',
      verbatimText: 'Сув босими жуда паст.',
      contentType: 'TEXT',
      originalTimestamp: '2026-08-24T06:00:00.000Z',
      formattedTime: '24.08.2026 11:00',
      authorName: 'Фуқаро',
      authorUsername: null,
      isAnchor: true,
      isHokimRelated: false,
      telegramDeepLink: null,
    },
  ],
  totalCount: 1,
  nextCursor: null,
  hasNextPage: false,
};

describe('Story 3.6: Dashboard Help & Factual Guidance Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    vi.spyOn(authClient, 'fetchSession').mockResolvedValue({
      actor: {
        id: 'acc_hokim_1',
        username: 'hokim_user',
        role: 'DISTRICT_HOKIM',
        districtId: 'dist_1',
        mustChangePassword: false,
      },
      session: { expiresAt: new Date(Date.now() + 86400000).toISOString() },
    });
  });

  describe('HelpContent Component (AC 2, AC 8)', () => {
    it('renders all 9 mandatory factual Uzbek Cyrillic guidance sections', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <HelpContent />
        </ConfigProvider>,
      );

      // Section 1: Хабарлар ва далиллар табиати
      expect(screen.getByText('Хабарлар ва далиллар табиати')).toBeTruthy();
      expect(
        screen.getByText(/расмий тасдиқланган далил, жамоатчиликнинг умумий фикри ёки якуний маъмурий хулоса ҳисобланмайди/),
      ).toBeTruthy();

      // Section 2: Йўналишлар ва кўп йўналишли мавзулар
      expect(screen.getByText('Йўналишлар ва кўп йўналишли мавзулар')).toBeTruthy();
      expect(screen.getByText(/Ҳокимга оид, Сув, Электр, Газ ва Чиқинди/)).toBeTruthy();

      // Section 3: «Янги мавзу» ва «+ [N]» хабарлар белгилари
      expect(screen.getByText('«Янги мавзу» ва «+ [N]» хабарлар белгилари')).toBeTruthy();
      expect(screen.getByText(/мавзу очилганда ўчирилади/)).toBeTruthy();

      // Section 4: Далиллар кетма-кетлиги ва асл матн
      expect(screen.getByText('Далиллар кетма-кетлиги ва асл матн')).toBeTruthy();
      expect(screen.getByText(/эскисидан янгисига қараб қатъий кетма-кетликда/)).toBeTruthy();

      // Section 5: Маълумотлар янгиланиши ва кечикишлар
      expect(screen.getByText('Маълумотлар янгиланиши ва кечикишлар')).toBeTruthy();
      expect(screen.getByText(/Хабарлар фон режимида мунтазам қайта ишланади/)).toBeTruthy();

      // Section 6: Telegram ҳаволалари
      expect(screen.getByText('Telegram ҳаволалари')).toBeTruthy();
      expect(screen.getByText(/«Telegramда очиш» тугмаси асл хабарга тўғридан-тўғри ўтиш имконини беради/)).toBeTruthy();

      // Section 7: Қарор қабул қилиш масъулияти
      expect(screen.getByText('Қарор қабул қилиш масъулияти')).toBeTruthy();
      expect(screen.getByText(/Тизим автоматлаштирилган қарорлар, тавсиялар ёки устуворлик балларини ишлаб чиқмайди/)).toBeTruthy();

      // Section 8: 90 кунлик ягона сақлаш муддати
      expect(screen.getByText('90 кунлик ягона сақлаш муддати')).toBeTruthy();
      expect(screen.getByText(/90 кун давомида сақланади/)).toBeTruthy();

      // Section 9: Қатъий бетарафлик ва тақиқланган функциялар
      expect(screen.getByText('Қатъий бетарафлик ва тақиқланган функциялар')).toBeTruthy();
      expect(screen.getByText(/сунъий интеллект ёрдамида суҳбат қуриш \(чат\)/)).toBeTruthy();
    });

    it('strictly avoids prohibited interactive elements (no chat input, tickets, feedback forms, scoring)', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <HelpContent />
        </ConfigProvider>,
      );

      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByPlaceholderText(/савол беринг|чат|фикр/i)).toBeNull();
      expect(screen.queryByRole('slider')).toBeNull();
    });
  });

  describe('DashboardHelpDrawer Component (AC 3, AC 8)', () => {
    it('renders as non-modal complementary region with heading and close button', async () => {
      const handleClose = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardHelpDrawer open={true} onClose={handleClose} />
        </ConfigProvider>,
      );

      // Verify non-modal complementary region role and aria-label
      const region = screen.getByRole('region', { name: 'Тизим ёрдами ва тушунтиришлар' });
      expect(region).toBeTruthy();

      // Verify title heading id
      const heading = screen.getByText('Тизим ёрдами ва тушунтиришлар');
      expect(heading).toBeTruthy();

      // Verify close button
      const closeBtn = screen.getByRole('button', { name: /close|ёпиш/i });
      expect(closeBtn).toBeTruthy();
      fireEvent.click(closeBtn);
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape key press', () => {
      const handleClose = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardHelpDrawer open={true} onClose={handleClose} />
        </ConfigProvider>,
      );

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('respects prefers-reduced-motion with immediate transitions (AC 8, AC 9 Test 7)', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const handleClose = vi.fn();
      render(
        <ConfigProvider theme={mahallaTheme}>
          <DashboardHelpDrawer open={true} onClose={handleClose} />
        </ConfigProvider>,
      );

      const region = screen.getByRole('region', { name: 'Тизим ёрдами ва тушунтиришлар' });
      expect(region).toBeTruthy();
    });
  });

  describe('DashboardHelpPage Component (AC 4, AC 8)', () => {
    it('renders full-screen help page with back button and heading', () => {
      render(
        <ConfigProvider theme={mahallaTheme}>
          <MemoryRouter initialEntries={['/help?dateScope=TODAY']}>
            <DashboardHelpPage />
          </MemoryRouter>
        </ConfigProvider>,
      );

      expect(screen.getByText('Тизим ёрдами')).toBeTruthy();
      const backButton = screen.getByRole('button', { name: 'Бош саҳифага қайтиш' });
      expect(backButton).toBeTruthy();
      expect(screen.getByText('Хабарлар ва далиллар табиати')).toBeTruthy();
    });
  });

  describe('HokimDashboardPage Mutual Exclusion & Focus Management (AC 3, AC 5)', () => {
    it('opening Help Drawer closes Topic Evidence Drawer, and selecting a topic card closes Help Drawer', async () => {
      vi.spyOn(hokimTopicsClient, 'getTodayBoard').mockResolvedValue(mockBoardResponse);
      vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValue(mockEvidenceResponse);

      render(
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

      await waitFor(() => {
        expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
      });

      // 1. Open Topic Evidence Drawer first
      const topicCard = screen.getByText('Сув босими бўйича мурожаатлар келиб тушди.');
      fireEvent.click(topicCard);

      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Мавзу далиллари' })).toBeTruthy();
      });

      // 2. Open Help Drawer via Help button -> Topic Evidence Drawer should close
      const helpButton = screen.getByRole('button', { name: 'Тизим ёрдами' });
      fireEvent.click(helpButton);

      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Тизим ёрдами ва тушунтиришлар' })).toBeTruthy();
        expect(screen.queryByRole('region', { name: 'Мавзу далиллари' })).toBeNull();
      });

      // 3. Select Topic Card again -> Help Drawer should close and Topic Evidence Drawer opens
      fireEvent.click(topicCard);

      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Мавзу далиллари' })).toBeTruthy();
        expect(screen.queryByRole('region', { name: 'Тизим ёрдами ва тушунтиришлар' })).toBeNull();
      });
    });
  });
});
