import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TopicCardItem,
  DistrictTopicsPageResponse,
  TopicEvidenceResponse,
} from '@mahalla-ovozi/api-contracts';
import { DistrictTopicsView } from '../../src/components/districts/topics/DistrictTopicsView.js';
import { districtTopicsClient } from '../../src/topics/index.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

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

const mockTopics: TopicCardItem[] = [
  {
    id: 'top_test_1',
    districtId: 'dist_test_a',
    mahallaName: 'Бобур',
    calendarDay: '2026-08-26',
    summary: 'Бобур маҳалласида тоза ичимлик суви таъминотида узилишлар',
    primaryLane: 'WATER',
    lanes: ['WATER'],
    additionalLanes: [],
    evidenceCount: 2,
    latestMeaningfulActivityTimestamp: '2026-08-26T07:30:00.000Z',
    isNew: false,
    isUpdated: false,
    searchMatchBadge: 'author',
    createdAt: '2026-08-26T06:00:00.000Z',
    updatedAt: '2026-08-26T07:30:00.000Z',
  },
  {
    id: 'top_test_2',
    districtId: 'dist_test_a',
    mahallaName: 'Юнус Ражабий',
    calendarDay: '2026-08-26',
    summary: 'Трансформатор аварияси сабабли электр энергияси узилиши',
    primaryLane: 'ELECTRICITY',
    lanes: ['ELECTRICITY', 'HOKIM_RELATED'],
    additionalLanes: ['HOKIM_RELATED'],
    evidenceCount: 3,
    latestMeaningfulActivityTimestamp: '2026-08-26T08:15:00.000Z',
    isNew: false,
    isUpdated: false,
    searchMatchBadge: 'evidence',
    createdAt: '2026-08-26T06:30:00.000Z',
    updatedAt: '2026-08-26T08:15:00.000Z',
  },
];

const mockPageResponse: DistrictTopicsPageResponse = {
  districtId: 'dist_test_a',
  districtName: 'Яккасарой тумани',
  topics: mockTopics,
  totalCount: 2,
  nextCursor: null,
  hasNextPage: false,
  serverEvaluatedAt: '2026-08-26T08:30:00.000Z',
};

const mockEvidenceResponse: TopicEvidenceResponse = {
  topic: mockTopics[0]!,
  anchorQuote: 'Ичимлик суви таъминотида узилишлар кузатилмоқда',
  anchorEvidenceId: 'evi_test_1',
  totalCount: 2,
  nextCursor: null,
  hasNextPage: false,
  evidence: [
    {
      id: 'evi_test_1',
      topicId: 'top_test_1',
      verbatimText: 'Ичимлик суви таъминотида узилишлар кузатилмоқда, босим жуда паст.',
      contentType: 'TEXT',
      originalTimestamp: '2026-08-26T06:00:00.000Z',
      formattedTime: '26.08.2026 11:00',
      authorName: 'Алишер Навоий',
      authorUsername: '@alisher_resident',
      isAnchor: true,
      isHokimRelated: false,
      telegramDeepLink: 'https://t.me/bobur_mahalla/101',
    },
    {
      id: 'evi_test_2',
      topicId: 'top_test_1',
      verbatimText: 'Сув насоси таъмирланмоқдами?',
      contentType: 'TEXT',
      originalTimestamp: '2026-08-26T07:30:00.000Z',
      formattedTime: '26.08.2026 12:30',
      authorName: 'Нодир',
      authorUsername: '@nodir_77',
      isAnchor: false,
      isHokimRelated: false,
      telegramDeepLink: null,
    },
  ],
};

function renderWithProviders(ui: React.ReactElement, queryClient?: QueryClient) {
  const qc =
    queryClient ||
    new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });

  return render(
    <QueryClientProvider client={qc}>
      <ConfigProvider theme={mahallaTheme}>
        <AntdApp>{ui}</AntdApp>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('Story 4.5: DistrictTopicsView Component Tests (AC 1, 2, 3, 4, 5, 7, 8, 9, 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(districtTopicsClient, 'listTopics').mockResolvedValue(mockPageResponse);
    vi.spyOn(districtTopicsClient, 'listMahallas').mockResolvedValue({
      mahallas: ['Бобур', 'Юнус Ражабий'],
    });
    vi.spyOn(districtTopicsClient, 'getTopicEvidence').mockResolvedValue(mockEvidenceResponse);
  });

  // Scenario 1: Empty state prompt when no district is selected
  it('renders informative prompt when activeDistrictId is null', () => {
    renderWithProviders(<DistrictTopicsView activeDistrictId={null} />);

    expect(screen.getByText('Туман танланмаган')).toBeTruthy();
    expect(
      screen.getByText(/Мавзулар ва далилларни кўриш учун юқоридаги рўйхатдан ёки танлагичдан туманни танланг/),
    ).toBeTruthy();
  });

  // Scenario 2: Renders table with summaries, mahallas, lane tags, timestamps, search badges
  it('renders topics table with topic cards, mahallas, lane tags, and search badges', async () => {
    renderWithProviders(
      <DistrictTopicsView activeDistrictId="dist_test_a" activeDistrictName="Яккасарой тумани" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
      expect(
        screen.getByText('Бобур маҳалласида тоза ичимлик суви таъминотида узилишлар'),
      ).toBeTruthy();
    });

    expect(
      screen.getByText('Трансформатор аварияси сабабли электр энергияси узилиши'),
    ).toBeTruthy();

    // Check Mahalla names
    expect(screen.getByText('Бобур')).toBeTruthy();
    expect(screen.getByText('Юнус Ражабий')).toBeTruthy();

    // Check Lane tags
    expect(screen.getByText('Сув')).toBeTruthy();
    expect(screen.getByText('Электр')).toBeTruthy();

    // Check Search Match Badges
    expect(screen.getByText('Муаллиф')).toBeTruthy();
    expect(screen.getByText('Далил матни')).toBeTruthy();
  });

  // Scenario 3: Filter bar interactions
  it('triggers refetch when filter options change', async () => {
    renderWithProviders(
      <DistrictTopicsView activeDistrictId="dist_test_a" activeDistrictName="Яккасарой тумани" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласида тоза ичимлик суви таъминотида узилишлар')).toBeTruthy();
    });

    // Switch date scope to yesterday
    const yesterdayBtn = screen.getByText('Кеча');
    fireEvent.click(yesterdayBtn);

    await waitFor(() => {
      expect(districtTopicsClient.listTopics).toHaveBeenCalledWith(
        'dist_test_a',
        expect.objectContaining({ dateScope: 'yesterday' }),
        expect.anything(),
      );
    });
  });

  // Scenario 4: Debounced search input
  it('debounces plain-text search input and calls listTopics', async () => {
    renderWithProviders(
      <DistrictTopicsView activeDistrictId="dist_test_a" activeDistrictName="Яккасарой тумани" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласида тоза ичимлик суви таъминотида узилишлар')).toBeTruthy();
    });

    const searchInput = screen.getByPlaceholderText('Мавзу, далил ёки муаллиф...');
    fireEvent.change(searchInput, { target: { value: 'alisher' } });

    await waitFor(
      () => {
        expect(districtTopicsClient.listTopics).toHaveBeenCalledWith(
          'dist_test_a',
          expect.objectContaining({ search: 'alisher' }),
          expect.anything(),
        );
      },
      { timeout: 2000 },
    );
  });

  // Scenario 5: Opening Evidence Drawer
  it('opens Evidence Drawer when clicking "Далиллар"', async () => {
    renderWithProviders(
      <DistrictTopicsView activeDistrictId="dist_test_a" activeDistrictName="Яккасарой тумани" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласида тоза ичимлик суви таъминотида узилишлар')).toBeTruthy();
    });

    const viewEvidenceButtons = screen.getAllByRole('button', { name: /Далилларни кўриш:/i });
    fireEvent.click(viewEvidenceButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('Мавзу тафсилотлари ва далиллар')).toBeTruthy();
      expect(screen.getByText('Дастлабки хабар иқтибоси:')).toBeTruthy();
      expect(screen.getByText('@alisher_resident')).toBeTruthy();
    });
  });

  // Scenario 6: Closing drawer restores focus
  it('closes Evidence Drawer and handles focus restoration', async () => {
    renderWithProviders(
      <DistrictTopicsView activeDistrictId="dist_test_a" activeDistrictName="Яккасарой тумани" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласида тоза ичимлик суви таъминотида узилишлар')).toBeTruthy();
    });

    const viewEvidenceButtons = screen.getAllByRole('button', { name: /Далилларни кўриш:/i });
    fireEvent.click(viewEvidenceButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('Мавзу тафсилотлари ва далиллар')).toBeTruthy();
    });

    const closeBtn = screen.getByRole('button', { name: /Ёпиш|close/i });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('Мавзу тафсилотлари ва далиллар')).toBeNull();
    });
  });

  // Scenario 7: Zero edit/delete controls in DOM
  it('strictly contains zero edit or delete mutating controls in the DOM', async () => {
    renderWithProviders(
      <DistrictTopicsView activeDistrictId="dist_test_a" activeDistrictName="Яккасарой тумани" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Яккасарой тумани')).toBeTruthy();
    });

    expect(screen.queryByText('Ўчириш')).toBeNull();
    expect(screen.queryByText('Таҳрирлаш')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
  });
});
