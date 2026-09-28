import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TopicEvidencePage } from '../../src/pages/TopicEvidencePage.js';
import { hokimTopicsClient } from '../../src/topics/hokim-topics-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import {
  TopicCardItem,
  TopicEvidenceItem,
  TopicEvidenceResponse,
} from '@mahalla-ovozi/api-contracts';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ topicId: 'top_1' }),
    useNavigate: () => mockNavigate,
  };
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

beforeAll(() => {
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

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <ConfigProvider theme={mahallaTheme}>
        <MemoryRouter>{ui}</MemoryRouter>
      </ConfigProvider>
    </QueryClientProvider>,
  );
}

describe('TopicEvidencePage Component Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(hokimTopicsClient, 'getTopicEvidence').mockResolvedValue(mockEvidenceResponse1);
  });

  it('renders topic header, summary, anchor quote, and evidence items', async () => {
    renderWithProviders(<TopicEvidencePage />);

    expect(screen.getByText('Мавзу далиллари')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Бош саҳифага қайтиш/i })).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
      expect(screen.getByText('Сув қувури ёрилиши сабабли кўчани сув босмоқда.')).toBeTruthy();
      expect(screen.getByText(/Дастлабки хабар иқтибоси/i)).toBeTruthy();
      expect(screen.getByText(/1-хабар: Сув босими пасайди/i)).toBeTruthy();
      expect(screen.getByText(/2-хабар: Қувур ёрилиб кўчани сув босди/i)).toBeTruthy();
    });
  });

  it('navigates back when clicking the back button', async () => {
    renderWithProviders(<TopicEvidencePage />);

    const backButton = screen.getByRole('button', { name: /Бош саҳифага қайтиш/i });
    fireEvent.click(backButton);

    expect(mockNavigate).toHaveBeenCalled();
  });

  it('renders mobile layout with responsive breakpoints (<576px)', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 575px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderWithProviders(<TopicEvidencePage />);

    await waitFor(() => {
      expect(screen.getByText('Бобур маҳалласи')).toBeTruthy();
      expect(screen.getByText(/Сув қувури ёрилиши/i)).toBeTruthy();
    });
  });
});
