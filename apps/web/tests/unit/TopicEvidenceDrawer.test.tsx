import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { ConfigProvider } from 'antd';
import { TopicEvidenceDrawer } from '../../src/components/topics/TopicEvidenceDrawer.js';
import { TopicReadStateProvider } from '../../src/hooks/useTopicReadState.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import {
  TopicCardItem,
  TopicEvidenceItem,
  TopicEvidenceResponse,
} from '@mahalla-ovozi/api-contracts';

let observerCallback: (entries: Array<{ isIntersecting: boolean }>) => void;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

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

function setupIntersectionObserver() {
  class MockIntersectionObserver {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observerCallback = cb;
    }
    observe = mockObserve;
    unobserve = vi.fn();
    disconnect = mockDisconnect;
  }
  window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
}

beforeAll(() => {
  setupMatchMedia();
  setupIntersectionObserver();
});

// Mock useAuth & useOptionalAuth
vi.mock('../../src/auth/auth-context.js', () => {
  const authState = {
    actor: {
      id: 'acc_hokim_1',
      districtId: 'dist_test_1',
      role: 'DISTRICT_HOKIM',
    },
  };
  return {
    useAuth: () => authState,
    useOptionalAuth: () => authState,
  };
});

const mockTopic1: TopicCardItem = {
  id: 'top_1',
  districtId: 'dist_test_1',
  mahallaName: 'Бобур маҳалласи',
  calendarDay: '2026-08-23',
  summary: 'Сув қувури ёрилиши сабабли кўчани сув босмоқда.',
  primaryLane: 'WATER',
  lanes: ['WATER'],
  additionalLanes: [],
  evidenceCount: 2,
  latestMeaningfulActivityTimestamp: '2026-08-23T10:00:00.000Z',
  isNew: true,
  isUpdated: false,
  createdAt: '2026-08-23T06:00:00.000Z',
  updatedAt: '2026-08-23T10:00:00.000Z',
};

const mockEvidence1: TopicEvidenceItem = {
  id: 'evi_1',
  topicId: 'top_1',
  verbatimText: '1-хабар: Сув босими пасайди.',
  contentType: 'TEXT',
  originalTimestamp: '2026-08-23T06:00:00.000Z',
  formattedTime: '23.08.2026 11:00',
  authorName: 'Anvar Qodirov',
  authorUsername: '@anvar_uz',
  isAnchor: false,
  isHokimRelated: false,
  telegramDeepLink: 'https://t.me/bobur_public/101',
};

const mockEvidence2: TopicEvidenceItem = {
  id: 'evi_2',
  topicId: 'top_1',
  verbatimText: '2-хабар: Қувур ёрилиб кўчани сув босди!',
  contentType: 'TEXT',
  originalTimestamp: '2026-08-23T07:00:00.000Z',
  formattedTime: '23.08.2026 12:00',
  authorName: 'Dilshod',
  authorUsername: null,
  isAnchor: true,
  isHokimRelated: false,
  telegramDeepLink: 'https://t.me/c/123456789/102',
};

const mockEvidenceResponse1: TopicEvidenceResponse = {
  topic: mockTopic1,
  anchorQuote: 'Қувур ёрилиб кўчани сув босди!',
  anchorEvidenceId: 'evi_2',
  evidence: [mockEvidence1, mockEvidence2],
  totalCount: 2,
  nextCursor: null,
  hasNextPage: false,
};

function renderWithProviders(ui: React.ReactElement, queryClient?: QueryClient) {
  const qc =
    queryClient ||
    new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

  return render(
    <QueryClientProvider client={qc}>
      <ConfigProvider theme={mahallaTheme}>{ui}</ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('TopicEvidenceDrawer Component Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    setupIntersectionObserver();
  });

  it('renders topic metadata, anchor quote callout, and evidence list (AC 2, 6, 7, 9)', async () => {
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse1);

    const onClose = vi.fn();
    renderWithProviders(<TopicEvidenceDrawer topicId="top_1" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
    });

    // Verify non-modal complementary landmark role (AC 7)
    expect(screen.getByRole('region', { name: 'Мавзу далиллари' })).toBeTruthy();

    // Verify summary
    expect(screen.getByText('Сув қувури ёрилиши сабабли кўчани сув босмоқда.')).toBeTruthy();
    // Verify standalone anchor quote callout was removed from drawer body (AC 9 updated)
    expect(screen.queryByText('Дастлабки хабар иқтибоси:')).toBeNull();

    // Verify order segmented control
    expect(screen.getByText('Эскилари олдин')).toBeTruthy();
    expect(screen.getByText('Янгилари олдин')).toBeTruthy();

    // Verify evidence items
    expect(screen.getByText('1-хабар: Сув босими пасайди.')).toBeTruthy();
    expect(screen.getByText('2-хабар: Қувур ёрилиб кўчани сув босди!')).toBeTruthy();

    // Verify in-situ anchor badge
    expect(screen.getByText('Дастлабки хабар')).toBeTruthy();

    // Verify Telegram link buttons
    const telegramLinks = screen.getAllByRole('link', { name: /Telegramда очиш/i });
    expect(telegramLinks.length).toBe(2);
    expect(telegramLinks[0]?.getAttribute('href')).toBe('https://t.me/bobur_public/101');
    expect(telegramLinks[1]?.getAttribute('href')).toBe('https://t.me/c/123456789/102');
  });

  it('calls onClose when close icon button is clicked (AC 7)', async () => {
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse1);

    const onClose = vi.fn();
    renderWithProviders(<TopicEvidenceDrawer topicId="top_1" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
    });

    const closeBtn = screen.getByRole('button', { name: /close|ёпиш/i });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed (AC 7)', async () => {
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse1);

    const onClose = vi.fn();
    renderWithProviders(<TopicEvidenceDrawer topicId="top_1" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches topic in-place from Topic 1 to Topic 2 without bleeding data (AC 7)', async () => {
    const mockTopic2: TopicCardItem = {
      ...mockTopic1,
      id: 'top_2',
      mahallaName: 'Чилонзор-9',
      summary: 'Электр таъминоти узилган.',
      primaryLane: 'ELECTRICITY',
      lanes: ['ELECTRICITY'],
    };

    const mockEvidenceResponse2: TopicEvidenceResponse = {
      topic: mockTopic2,
      anchorQuote: 'Сим узилиб тушган.',
      anchorEvidenceId: 'evi_elec_1',
      evidence: [
        {
          id: 'evi_elec_1',
          topicId: 'top_2',
          verbatimText: 'Сим узилиб тушган.',
          contentType: 'TEXT',
          originalTimestamp: '2026-08-23T08:00:00.000Z',
          formattedTime: '23.08.2026 13:00',
          authorName: 'Сардор',
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

    vi.spyOn(hokimTopicsClient, 'getTopicEvidence')
      .mockResolvedValueOnce(mockEvidenceResponse1)
      .mockResolvedValueOnce(mockEvidenceResponse2);

    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    const onClose = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <ConfigProvider theme={mahallaTheme}>
          <TopicEvidenceDrawer topicId="top_1" onClose={onClose} />
        </ConfigProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
    });

    // Re-render with Topic 2
    rerender(
      <QueryClientProvider client={qc}>
        <ConfigProvider theme={mahallaTheme}>
          <TopicEvidenceDrawer topicId="top_2" onClose={onClose} />
        </ConfigProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Чилонзор-9')).toBeTruthy();
    });

    expect(screen.getByText('Электр таъминоти узилган.')).toBeTruthy();
    expect(screen.queryByText('Дастлабки хабар иқтибоси:')).toBeNull();
  });

  it('synchronizes topic read status into localStorage when drawer opens and evidence loads', async () => {
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse1);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConfigProvider theme={mahallaTheme}>
          <TopicReadStateProvider districtId="dist_test_1" userId="acc_hokim_1">
            <TopicEvidenceDrawer topicId="top_1" onClose={vi.fn()} />
          </TopicReadStateProvider>
        </ConfigProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      const raw = window.localStorage.getItem('mahalla_ovozi_topic_reads_dist_test_1_acc_hokim_1');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed['top_1']).toEqual({
        lastReadCount: 2,
        isNewDismissed: true,
      });
    });
  });

  it('renders Hokim appeal badge and multi-match navigator toolbar when multiple Hokim messages exist', async () => {
    const mockHokimEvidenceResponse: TopicEvidenceResponse = {
      topic: {
        ...mockTopic1,
        id: 'top_hokim_multi',
        lanes: ['WATER', 'HOKIM_RELATED'],
      },
      anchorQuote: 'Ҳоким ёрдами керак!',
      anchorEvidenceId: 'evi_h_1',
      evidence: [
        {
          id: 'evi_h_1',
          topicId: 'top_hokim_multi',
          verbatimText: 'Ҳоким ёрдами керак! Сув қувури ёрилди.',
          contentType: 'TEXT',
          originalTimestamp: '2026-08-23T06:00:00.000Z',
          formattedTime: '23.08.2026 11:00',
          authorName: 'Фуқаро 1',
          authorUsername: null,
          isAnchor: true,
          isHokimRelated: true,
          telegramDeepLink: null,
        },
        {
          id: 'evi_h_2',
          topicId: 'top_hokim_multi',
          verbatimText: 'Ҳокимиятга ҳам хабар бердик, тезроқ келишсин.',
          contentType: 'TEXT',
          originalTimestamp: '2026-08-23T07:00:00.000Z',
          formattedTime: '23.08.2026 12:00',
          authorName: 'Фуқаро 2',
          authorUsername: null,
          isAnchor: false,
          isHokimRelated: true,
          telegramDeepLink: null,
        },
      ],
      totalCount: 2,
      nextCursor: null,
      hasNextPage: false,
    };

    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockHokimEvidenceResponse);

    renderWithProviders(
      <TopicEvidenceDrawer topicId="top_hokim_multi" focusHokim={true} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Ҳокимга мурожаат').length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByText(/Ҳокимга оид 2 та хабар мавжуд/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Олдинги ҳоким мурожаати' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Кейинги ҳоким мурожаати' })).toBeTruthy();
  });

  it('displays sticky evidence section header and toggles floating jump-to-latest button via IntersectionObserver', async () => {
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValueOnce(mockEvidenceResponse1);

    renderWithProviders(
      <TopicEvidenceDrawer topicId="top_1" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Сақланган далиллар рўйхати')).toBeTruthy();
    });

    const header = screen.getByTestId('evidence-sticky-header');
    expect(header.style.position).toBe('sticky');

    // The button is in the DOM but has opacity: 0 and pointerEvents: none initially
    const jumpBtn = screen.getByText('Сўнгги хабарга').closest('button')!;
    expect(jumpBtn).toBeTruthy();
    expect(jumpBtn.style.opacity).toBe('0');
    expect(jumpBtn.style.pointerEvents).toBe('none');

    // Simulate user scrolling up (bottom sentinel exits the viewport buffer -> isIntersecting = false)
    act(() => {
      observerCallback([{ isIntersecting: false }]);
    });

    await waitFor(() => {
      expect(jumpBtn.style.opacity).toBe('1');
      expect(jumpBtn.style.pointerEvents).toBe('auto');
    });

    // Mock scrollIntoView on sentinel and focus on the target item
    const sentinel = document.getElementById('evidence-bottom-sentinel');
    expect(sentinel).toBeTruthy();
    if (sentinel) {
      sentinel.scrollIntoView = vi.fn();
    }
    const targetItem = document.getElementById('evidence-item-evi_2');
    if (targetItem) {
      targetItem.focus = vi.fn();
    }

    fireEvent.click(jumpBtn);

    if (sentinel) {
      expect(sentinel.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'end',
      });
    }
    if (targetItem) {
      expect(targetItem.focus).toHaveBeenCalledWith({ preventScroll: true });
    }
  });

  it('toggles evidence order between ASC and DESC via segmented control', async () => {
    const getTopicEvidenceSpy = vi
      .spyOn(hokimTopicsClient, 'getTopicEvidence')
      .mockResolvedValue(mockEvidenceResponse1);

    const onClose = vi.fn();
    renderWithProviders(<TopicEvidenceDrawer topicId="top_1" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
    });

    expect(getTopicEvidenceSpy).toHaveBeenCalledWith(
      'top_1',
      expect.objectContaining({ order: 'ASC' }),
      expect.any(AbortSignal),
    );

    // Switch to descending (newest first)
    const newestFirstTab = screen.getByText('Янгилари олдин');
    fireEvent.click(newestFirstTab);

    await waitFor(() => {
      expect(getTopicEvidenceSpy).toHaveBeenCalledWith(
        'top_1',
        expect.objectContaining({ order: 'DESC' }),
        expect.any(AbortSignal),
      );
    });
  });
});
