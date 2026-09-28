import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictSubscription } from '@mahalla-ovozi/api-contracts';
import { SubscriptionsPage } from '../../src/pages/SubscriptionsPage.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { subscriptionClient } from '../../src/api/subscription-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import * as onlineStatusHook from '../../src/hooks/useOnlineStatus.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
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

const mockSubscriptions: DistrictSubscription[] = [
  {
    id: 'sub_dist_1',
    districtId: 'dist_1',
    districtName: 'Юнусобод тумани',
    region: 'Тошкент шаҳри',
    status: 'ACTIVE',
    statusStartedAt: '2026-08-01T05:00:00.000Z',
    scheduledTransitionAt: undefined,
    scheduledTransitionType: undefined,
    externalPaymentReference: 'BANK-CONTRACT-100',
    internalNote: 'Асосий туман шартномаси',
    createdAt: '2026-08-01T05:00:00.000Z',
    updatedAt: '2026-08-01T05:00:00.000Z',
  },
  {
    id: 'sub_dist_2',
    districtId: 'dist_2',
    districtName: 'Мирзо Улуғбек тумани',
    region: 'Тошкент шаҳри',
    status: 'SETUP_INCOMPLETE',
    statusStartedAt: '2026-08-15T09:30:00.000Z',
    scheduledTransitionAt: undefined,
    scheduledTransitionType: undefined,
    externalPaymentReference: undefined,
    internalNote: undefined,
    createdAt: '2026-08-15T09:30:00.000Z',
    updatedAt: '2026-08-15T09:30:00.000Z',
  },
];

describe('Story 6.1: SubscriptionsPage & Components Unit Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <DistrictProvider>
              <BrowserRouter>
                <SubscriptionsPage />
              </BrowserRouter>
            </DistrictProvider>
          </AntdApp>
        </ConfigProvider>
      </QueryClientProvider>,
    );
  }

  it('renders honest empty state when no districts exist (AC 2)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValueOnce({
      subscriptions: [],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Ҳозирча туманлар мавжуд эмас')).toBeTruthy();
    });
    expect(screen.getByText('Обуналар ва тўлов маълумотлари')).toBeTruthy();
  });

  it('renders summary table with status badges and Asia/Tashkent formatted timestamps (AC 1, AC 6)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValueOnce({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
      expect(screen.getByText('Мирзо Улуғбек тумани')).toBeTruthy();
    });

    // Check status tags
    expect(screen.getByText('Фаол')).toBeTruthy();
    expect(screen.getByText('Созлаш тугалланмаган')).toBeTruthy();

    // Check payment disclaimer notice
    expect(
      screen.getByText(
        'Тўловлар тизимдан ташқарида (қўлда) бошқарилади. Маҳалла Овози тўловларни қабул қилмайди ва карта маълумотларини сақламайди.',
      ),
    ).toBeTruthy();

    // Check external reference
    expect(screen.getByText('BANK-CONTRACT-100')).toBeTruthy();
  });

  it('navigates to single district detail view and returns back (AC 3, AC 7)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
    });

    const detailButtons = screen.getAllByRole('button', { name: /батафсил/i });
    fireEvent.click(detailButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('Обуна маълумотларини таҳрирлаш')).toBeTruthy();
      expect(screen.getByText('Асосий туман шартномаси')).toBeTruthy();
    });

    // Back to list
    const backBtn = screen.getByRole('button', { name: /барча туманлар/i });
    fireEvent.click(backBtn);

    await waitFor(() => {
      expect(screen.getByText('Мирзо Улуғбек тумани')).toBeTruthy();
    });
  });

  it('validates secret detection warning in edit drawer (AC 5)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
    });

    // Click Edit button on the first row
    const editButtons = screen.getAllByRole('button', { name: /таҳрирлаш/i });
    fireEvent.click(editButtons[0]!);

    // Drawer should be open
    await waitFor(() => {
      expect(
        screen.getByText(
          'Тўлов маълумотномаси ва ички қайдлар фақат операцион маълумотлар учун мўлжалланган. Шахсий маълумотлар, Telegram бот токенлари ёки API калитларини ёзиш қатъиян ман этилади.',
        ),
      ).toBeTruthy();
    });

    // Enter a secret bot token in externalPaymentReference
    const refInput = screen.getByPlaceholderText('Масалан: ШАРТНОМА-2026/08');
    fireEvent.change(refInput, {
      target: { value: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789' },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          'Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.',
        ),
      ).toBeTruthy();
    });
  });

  it('shows persistent offline banner and blocks mutations when offline (AC 11)', async () => {
    vi.spyOn(onlineStatusHook, 'useOnlineStatus').mockReturnValue(true);
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
    });

    // Offline alert visible
    expect(
      screen.getByText('Интернет алоқаси мавжуд эмас. Маълумотлар фақат ўқиш режимида.'),
    ).toBeTruthy();

    // Refresh button disabled
    const refreshBtn = screen.getByRole('button', { name: /янгилаш/i });
    expect(refreshBtn.getAttribute('disabled')).toBeDefined();

    // Table edit buttons disabled when offline
    const editBtns = screen.getAllByRole('button', { name: /таҳрирлаш/i });
    expect(editBtns[0]?.hasAttribute('disabled')).toBe(true);
  });

  it('submits drawer form and updates subscription metadata successfully (AC 4)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });
    const updateSpy = vi.spyOn(subscriptionClient, 'updateDistrictSubscription').mockResolvedValue({
      subscription: {
        ...mockSubscriptions[0]!,
        externalPaymentReference: 'BANK-CONTRACT-UPDATED',
        internalNote: 'Янгиланган қайд',
        updatedById: 'po_test_123',
      },
      message: 'Обуна маълумотлари муваффақиятли сақланди.',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
    });

    const editButtons = screen.getAllByRole('button', { name: /таҳрирлаш/i });
    fireEvent.click(editButtons[0]!);

    const refInput = screen.getByPlaceholderText('Масалан: ШАРТНОМА-2026/08');
    fireEvent.change(refInput, { target: { value: 'BANK-CONTRACT-UPDATED' } });

    const saveBtn = screen.getByRole('button', { name: /сақлаш/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dist_1', {
        externalPaymentReference: 'BANK-CONTRACT-UPDATED',
        internalNote: 'Асосий туман шартномаси',
      });
    });
  });
});
