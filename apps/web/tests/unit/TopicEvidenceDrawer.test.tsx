import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { ConfigProvider } from 'antd';
import { TopicEvidenceDrawer } from '../../src/components/topics/TopicEvidenceDrawer.js';
import { TopicReadStateProvider } from '../../src/hooks/useTopicReadState.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { ApiError } from '../../src/lib/api-client.js';
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

// Mock useAuth & useOptionalAuth through a mutable holder so individual tests
// can simulate a session without a district (query disabled).
const authMock = vi.hoisted(() => ({
  current: {
    actor: {
      id: 'acc_hokim_1',
      districtId: 'dist_test_1' as string | null,
      role: 'DISTRICT_HOKIM',
    },
  },
}));

vi.mock('../../src/auth/auth-context.js', () => ({
  useAuth: () => authMock.current,
  useOptionalAuth: () => authMock.current,
}));

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
    authMock.current = {
      actor: {
        id: 'acc_hokim_1',
        districtId: 'dist_test_1',
        role: 'DISTRICT_HOKIM',
      },
    };
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

    // Verify order segmented control: newest-first is listed first (left) and is the default
    const newestFirstOption = screen.getByText('Янгилари олдин');
    const oldestFirstOption = screen.getByText('Эскилари олдин');
    expect(newestFirstOption).toBeTruthy();
    expect(oldestFirstOption).toBeTruthy();
    expect(
      newestFirstOption.compareDocumentPosition(oldestFirstOption) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Verify evidence items
    expect(screen.getByText('1-хабар: Сув босими пасайди.')).toBeTruthy();
    expect(screen.getByText('2-хабар: Қувур ёрилиб кўчани сув босди!')).toBeTruthy();

    // Verify in-situ anchor badge
    expect(screen.getByText('Дастлабки хабар')).toBeTruthy();

    // Verify Telegram link buttons
    const telegramLinks = screen.getAllByRole('link', { name: /Telegramда очиш/i });
    expect(telegramLinks.length).toBe(2);
    // Default newest-first order renders evi_2 before evi_1
    expect(telegramLinks[0]?.getAttribute('href')).toBe('https://t.me/c/123456789/102');
    expect(telegramLinks[1]?.getAttribute('href')).toBe('https://t.me/bobur_public/101');
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
    // Resolves for both the default DESC query and the ASC query the toggle triggers
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValue(mockEvidenceResponse1);

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

    // Default order is DESC: the button scrolls the container back to the top
    const scrollContainer = header.parentElement as HTMLDivElement;
    expect(scrollContainer).toBeTruthy();
    const scrollToSpy = vi.fn();
    scrollContainer.scrollTo = scrollToSpy;

    const latestItem = document.getElementById('evidence-item-evi_2');
    expect(latestItem).toBeTruthy();
    const focusSpy = vi.fn();
    latestItem!.focus = focusSpy;

    fireEvent.click(jumpBtn);

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    // Explicit ASC: the same button glides down to the bottom sentinel instead
    fireEvent.click(screen.getByText('Эскилари олдин'));

    const sentinel = document.getElementById('evidence-bottom-sentinel');
    expect(sentinel).toBeTruthy();
    const scrollIntoViewSpy = vi.fn();
    sentinel!.scrollIntoView = scrollIntoViewSpy;

    // In ASC the latest message sits at the bottom, so evi_2 is the focus target
    const latestAscItem = document.getElementById('evidence-item-evi_2');
    expect(latestAscItem).toBeTruthy();
    const ascFocusSpy = vi.fn();
    latestAscItem!.focus = ascFocusSpy;

    fireEvent.click(jumpBtn);

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'end',
    });
    expect(ascFocusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('defaults to DESC and toggles evidence order to ASC via segmented control', async () => {
    const getTopicEvidenceSpy = vi
      .spyOn(hokimTopicsClient, 'getTopicEvidence')
      .mockResolvedValue(mockEvidenceResponse1);

    const onClose = vi.fn();
    renderWithProviders(<TopicEvidenceDrawer topicId="top_1" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
    });

    // Newest-first is the default
    expect(getTopicEvidenceSpy).toHaveBeenCalledWith(
      'top_1',
      expect.objectContaining({ order: 'DESC' }),
      expect.any(AbortSignal),
    );

    // Switch to ascending (oldest first)
    fireEvent.click(screen.getByText('Эскилари олдин'));

    await waitFor(() => {
      expect(getTopicEvidenceSpy).toHaveBeenCalledWith(
        'top_1',
        expect.objectContaining({ order: 'ASC' }),
        expect.any(AbortSignal),
      );
    });

    // ASC renders oldest first: evi_1 before evi_2
    await waitFor(() => {
      const ascRows = Array.from(document.querySelectorAll('[id^="evidence-item-"]'));
      expect(ascRows.map((row) => row.id)).toEqual(['evidence-item-evi_1', 'evidence-item-evi_2']);
    });

    // Switching back restores newest-first rendering (React Query may serve the cached
    // DESC page, so the contract is the rendered order, not a third network call)
    fireEvent.click(screen.getByText('Янгилари олдин'));

    await waitFor(() => {
      const descRows = Array.from(document.querySelectorAll('[id^="evidence-item-"]'));
      expect(descRows.map((row) => row.id)).toEqual(['evidence-item-evi_2', 'evidence-item-evi_1']);
    });
  });

  it('shows the evidence error alert with a working retry button when the topic is present (regression)', async () => {
    const getTopicEvidenceSpy = vi
      .spyOn(hokimTopicsClient, 'getTopicEvidence')
      // 4xx is terminal under the hook's retry policy, so the error surfaces immediately
      .mockRejectedValue(new ApiError('Сўров нотўғри.', 'BAD_REQUEST', 400, false));

    renderWithProviders(
      <TopicEvidenceDrawer topicId="top_1" initialTopic={mockTopic1} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Далилларни юклашда хатолик')).toBeTruthy();
    });

    // The error state replaces the skeleton entirely
    expect(screen.queryByTestId('evidence-timeline-skeleton')).toBeNull();
    expect(screen.queryByText('Далиллар топилмади')).toBeNull();

    const callsBeforeRetry = getTopicEvidenceSpy.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Қайта уриниш/ }));

    await waitFor(() => {
      expect(getTopicEvidenceSpy.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  it('renders the empty state instead of the skeleton when the query succeeds with no evidence', async () => {
    const emptyResponse: TopicEvidenceResponse = {
      topic: mockTopic1,
      anchorQuote: '',
      anchorEvidenceId: '',
      evidence: [],
      totalCount: 0,
      nextCursor: null,
      hasNextPage: false,
    };

    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValue(emptyResponse);

    renderWithProviders(<TopicEvidenceDrawer topicId="top_1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Далиллар топилмади')).toBeTruthy();
    });

    expect(screen.queryByTestId('evidence-timeline-skeleton')).toBeNull();
    expect(screen.queryByText('Далилларни юклашда хатолик')).toBeNull();
  });

  it('does not flash the skeleton for a fast response and renders rows once data arrives', async () => {
    let resolveEvidence: (value: TopicEvidenceResponse) => void = () => {};
    const pendingEvidence = new Promise<TopicEvidenceResponse>((resolve) => {
      resolveEvidence = resolve;
    });

    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockReturnValueOnce(pendingEvidence);

    renderWithProviders(
      <TopicEvidenceDrawer topicId="top_1" initialTopic={mockTopic1} onClose={vi.fn()} />,
    );

    // Loading, but well under the 200ms skeleton delay: neither the skeleton nor the
    // "no evidence" empty state may be visible, so a fast response shows no flash.
    expect(screen.queryByTestId('evidence-timeline-skeleton')).toBeNull();
    expect(screen.queryByText('Далиллар топилмади')).toBeNull();

    await act(async () => {
      resolveEvidence(mockEvidenceResponse1);
    });

    await waitFor(() => {
      expect(screen.getByText('1-хабар: Сув босими пасайди.')).toBeTruthy();
    });

    expect(screen.getByText('2-хабар: Қувур ёрилиб кўчани сув босди!')).toBeTruthy();
    expect(screen.queryByTestId('evidence-timeline-skeleton')).toBeNull();
    expect(screen.queryByText('Далиллар топилмади')).toBeNull();
  });

  it('shows the skeleton only after 200ms of continuous loading', async () => {
    vi.useFakeTimers();

    try {
      vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockReturnValue(
        new Promise<TopicEvidenceResponse>(() => {}),
      );

      renderWithProviders(
        <TopicEvidenceDrawer topicId="top_1" initialTopic={mockTopic1} onClose={vi.fn()} />,
      );

      expect(screen.queryByTestId('evidence-timeline-skeleton')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(250);
      });

      expect(screen.getByTestId('evidence-timeline-skeleton')).toBeTruthy();
      expect(screen.queryByText('Далиллар топилмади')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the selection-required info message when the query is not enabled', async () => {
    authMock.current = {
      actor: {
        id: 'acc_hokim_1',
        districtId: null,
        role: 'DISTRICT_HOKIM',
      },
    };

    const getTopicEvidenceSpy = vi.spyOn(hokimTopicsClient, 'getTopicEvidence');

    renderWithProviders(
      <TopicEvidenceDrawer topicId="top_1" initialTopic={mockTopic1} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText('Далилларни юклаш учун туман ва мавзу танланган бўлиши керак.'),
      ).toBeTruthy();
    });

    expect(screen.queryByTestId('evidence-timeline-skeleton')).toBeNull();
    expect(screen.queryByText('Далилларни юклашда хатолик')).toBeNull();
    expect(getTopicEvidenceSpy).not.toHaveBeenCalled();
  });
});
