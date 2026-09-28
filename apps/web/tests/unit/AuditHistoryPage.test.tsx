import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuditHistoryItem,
  AuditEvent,
  AuditHistoryPage as AuditHistoryPageType,
} from '@mahalla-ovozi/api-contracts';
import { AuditHistoryPage } from '../../src/pages/AuditHistoryPage.js';
import { auditClient } from '../../src/api/audit-client.js';
import { districtClient } from '../../src/district/district-client.js';
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

const mockAuditEvents: AuditEvent[] = [
  {
    id: 'aud_evt_101',
    recordType: 'AUDIT_EVENT',
    districtId: null,
    districtName: null,
    actorId: 'acc_po_1',
    actorRole: 'PRODUCT_OWNER',
    action: 'AUTH_SIGN_IN_SUCCESS',
    category: 'AUTH_SECURITY',
    outcome: 'SUCCESS',
    ipAddress: '127.0.0.1',
    userAgent: 'Mozilla/5.0 Chrome',
    reason: 'Авторизация амали',
    previousValues: null,
    newValues: null,
    metadata: { reason: 'Авторизация амали' },
    createdAt: '2026-08-26T08:30:00.000Z',
  },
  {
    id: 'aud_evt_102',
    recordType: 'AUDIT_EVENT',
    districtId: 'dist_yunusobod',
    districtName: 'Юнусобод тумани',
    actorId: 'acc_po_1',
    actorRole: 'PRODUCT_OWNER',
    action: 'DISTRICT_CREATED',
    category: 'DISTRICT_ADMINISTRATION',
    outcome: 'SUCCESS',
    ipAddress: '127.0.0.1',
    userAgent: 'Mozilla/5.0 Chrome',
    reason: null,
    previousValues: { status: 'NONE' },
    newValues: { status: 'SETUP_INCOMPLETE', name: 'Юнусобод тумани' },
    metadata: {},
    createdAt: '2026-08-26T08:35:00.000Z',
  },
  {
    id: 'aud_evt_103',
    recordType: 'AUDIT_EVENT',
    districtId: 'dist_yunusobod',
    districtName: 'Юнусобод тумани',
    actorId: 'system:evaluator',
    actorRole: 'SYSTEM',
    action: 'OPERATIONAL_ISSUE_DETECTED',
    category: 'OPERATIONAL_LIFECYCLE',
    outcome: 'FAILURE',
    ipAddress: null,
    userAgent: null,
    reason: 'Бот уланишида хатолик',
    previousValues: null,
    newValues: null,
    metadata: { reason: 'Бот уланишида хатолик' },
    createdAt: '2026-08-26T08:40:00.000Z',
  },
];

const mockPageResponse: AuditHistoryPageType = {
  items: mockAuditEvents,
  pagination: {
    limit: 25,
    hasNextPage: true,
    hasPrevPage: false,
    nextCursor: 'cursor_next_123',
    prevCursor: null,
  },
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

describe('Story 4.4: AuditHistoryPage Component Tests (AC 1, 2, 4, 6, 10, 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({
      districts: [
        {
          id: 'dist_yunusobod',
          name: 'Юнусобод тумани',
          region: 'Тошкент ш.',
          status: 'ACTIVE',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    vi.spyOn(auditClient, 'fetchAuditEvents').mockResolvedValue(mockPageResponse);
  });

  it('renders page header, title, refresh button, and audit event rows', async () => {
    renderWithProviders(<AuditHistoryPage />);

    expect(screen.getByText('Аудит тарихи')).toBeTruthy();
    expect(
      screen.getByText(
        'Тизимдаги барча маъмурий амаллар, хавфсизлик ҳодисалари, ҳолат ўзгаришлари ва қайта уринишларнинг ўзгармас тарихи',
      ),
    ).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Тизимга муваффақиятли кириш')).toBeTruthy();
      expect(screen.getByText('Янги туман яратилди')).toBeTruthy();
      expect(screen.getByText('Операцион муаммо аниқланди')).toBeTruthy();
    });

    // Check tags
    expect(screen.getAllByText('Маҳсулот эгаси').length).toBeGreaterThan(0);
    expect(screen.getByText('Тизим')).toBeTruthy();
    expect(screen.getAllByText('Муваффақиятли').length).toBeGreaterThan(0);
    expect(screen.getByText('Хатолик')).toBeTruthy();
    expect(screen.getByText('Глобал')).toBeTruthy();
    expect(screen.getAllByText('Юнусобод тумани').length).toBeGreaterThan(0);
  });

  it('renders filter bar controls properly', async () => {
    renderWithProviders(<AuditHistoryPage />);

    expect(screen.getByRole('combobox', { name: 'Туман танлаш' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Ҳаракат тоифаси' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Бажарувчи роли' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Натижа' })).toBeTruthy();
    expect(screen.getByLabelText('Аудит қидируви')).toBeTruthy();
  });

  it('debounces and triggers search input queries', async () => {
    renderWithProviders(<AuditHistoryPage />);

    const searchInput = screen.getByLabelText('Аудит қидируви');
    fireEvent.change(searchInput, { target: { value: 'TELEGRAM_BOT' } });

    await waitFor(
      () => {
        expect(auditClient.fetchAuditEvents).toHaveBeenCalledWith(
          expect.objectContaining({ search: 'TELEGRAM_BOT' }),
        );
      },
      { timeout: 1000 },
    );
  });

  it('opens detail drawer with event information and diff table when clicking "Тафсилот"', async () => {
    renderWithProviders(<AuditHistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('Янги туман яратилди')).toBeTruthy();
    });

    const detailButtons = screen.getAllByRole('button', { name: /Тафсилот:/i });
    expect(detailButtons.length).toBeGreaterThan(0);

    // Click on the second event detail (aud_evt_102 with diffs)
    fireEvent.click(detailButtons[1]!);

    await waitFor(() => {
      expect(screen.getByText('Аудит ёзуви тафсилоти')).toBeTruthy();
      expect(screen.getByText('ID: aud_evt_102')).toBeTruthy();
      expect(screen.getByText('Ҳолат ва қийматлар ўзгариши')).toBeTruthy();
      expect(screen.getByText('status')).toBeTruthy();
    });
  });

  it('closes detail drawer and preserves view state', async () => {
    renderWithProviders(<AuditHistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('Янги туман яратилди')).toBeTruthy();
    });

    const detailButtons = screen.getAllByRole('button', { name: /Тафсилот:/i });
    fireEvent.click(detailButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('Аудит ёзуви тафсилоти')).toBeTruthy();
    });

    // Close button
    const closeBtn = screen.getByRole('button', { name: /Close/i });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('Аудит ёзуви тафсилоти')).toBeNull();
    });
  });

  it('handles keyset pagination buttons correctly', async () => {
    renderWithProviders(<AuditHistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('Кўрсатилмоқда: 3 та ёзув')).toBeTruthy();
    });

    const prevButton = screen.getByRole('button', { name: 'Олдинги саҳифа' });
    const nextButton = screen.getByRole('button', { name: 'Кейинги саҳифа' });

    // hasPrevPage is false in mock, hasNextPage is true
    expect((prevButton as HTMLButtonElement).disabled).toBe(true);
    expect((nextButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(nextButton);

    await waitFor(() => {
      expect(auditClient.fetchAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: 'cursor_next_123',
          direction: 'forward',
        }),
      );
    });
  });

  it('strictly verifies NO edit or delete buttons exist in the DOM (Immutability guarantee)', async () => {
    renderWithProviders(<AuditHistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('Тизимга муваффақиятли кириш')).toBeTruthy();
    });

    expect(screen.queryByRole('button', { name: /Таҳрирлаш|Ўчириш|Edit|Delete/i })).toBeNull();
  });

  it('displays offline/stale banner when background refetch fails with cached data', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });

    // Prime cache with mockPageResponse
    queryClient.setQueryData(
      [
        'audit-history',
        {
          limit: 25,
          cursor: undefined,
          direction: 'forward',
          recordType: 'ALL',
          districtId: undefined,
          startDate: undefined,
          endDate: undefined,
          category: undefined,
          actorRole: undefined,
          outcome: undefined,
          action: undefined,
          search: undefined,
        },
      ],
      mockPageResponse,
    );

    // Mock subsequent fetch to fail
    vi.spyOn(auditClient, 'fetchAuditEvents').mockRejectedValue(
      new Error('Network disconnected'),
    );

    renderWithProviders(<AuditHistoryPage />, queryClient);

    const refreshButton = screen.getByRole('button', { name: 'Маълумотларни янгилаш' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(
        screen.getByText('Тармоқ алоқасида узилиш ёки сўровда хатолик юз берди'),
      ).toBeTruthy();
      expect(
        screen.getByText(/Кўрсатилаётган маълумотлар кэшдан олинган/),
      ).toBeTruthy();
    });
  });

  it('renders 3-milestone lifecycle steps and privacy guarantee for PermanentDeletionProof items (AC 5, AC 6)', async () => {
    const mockDeletionProof: AuditHistoryItem = {
      id: 'del_rec_test_proof_1',
      recordType: 'PERMANENT_DELETION_PROOF',
      districtId: 'dist_proof_1',
      districtName: 'Мирзо Улуғбек тумани',
      cancelledAt: '2026-08-26T08:00:00.000Z',
      cancelledById: 'acc_po_1',
      cancellationReason: 'Синов ўчириш',
      scheduledLiveDeletionAt: '2026-08-26T08:30:00.000Z',
      actualLiveDeletionAt: '2026-08-26T08:30:00.000Z',
      liveDeletionStatus: 'COMPLETED',
      protectedBackupExpiryDeadline: '2026-09-25T08:30:00.000Z',
      backupExpiryStatus: 'PENDING',
      backupExpiryVerifiedAt: null,
      restoreReconciliationStatus: 'RECONCILED',
      restoreReconciliationVerifiedAt: '2026-08-26T08:30:00.000Z',
      lifecycleComplete: false,
      createdAt: '2026-08-26T08:30:00.000Z',
    };

    vi.spyOn(auditClient, 'fetchAuditEvents').mockResolvedValue({
      items: [mockDeletionProof],
      pagination: {
        limit: 25,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    });

    renderWithProviders(<AuditHistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('Ўчирилганлик маълумотномаси')).toBeTruthy();
      expect(screen.getByText('Мирзо Улуғбек тумани')).toBeTruthy();
    });

    // Open detail drawer
    const detailButton = screen.getByRole('button', { name: 'Тафсилот: del_rec_test_proof_1' });
    fireEvent.click(detailButton);

    await waitFor(() => {
      expect(screen.getByText('Ўчирилганлик маълумотномаси тафсилоти')).toBeTruthy();
      expect(screen.getByText(/Ўчириш жараёни босқичлари/)).toBeTruthy();
      expect(screen.getByText(/1-босқич: Жонли тизимдан ўчириш/)).toBeTruthy();
      expect(screen.getByText(/2-босқич: Ҳимояланган заҳира нусхалари муддати/)).toBeTruthy();
      expect(screen.getByText(/3-босқич: Фалокатдан сўнг тикланишни мувофиқлаштириш/)).toBeTruthy();
      expect(screen.getByText('Шахсий маълумотлар дахлсизлиги кафолати')).toBeTruthy();
    });
  });
});
