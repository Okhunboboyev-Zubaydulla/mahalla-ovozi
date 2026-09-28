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
    status: 'GRACE',
    statusStartedAt: '2026-08-20T09:30:00.000Z',
    scheduledTransitionAt: '2026-08-27T09:30:00.000Z',
    scheduledTransitionType: 'AUTOMATIC_SUSPENSION',
    externalPaymentReference: undefined,
    internalNote: undefined,
    createdAt: '2026-08-15T09:30:00.000Z',
    updatedAt: '2026-08-20T09:30:00.000Z',
  },
  {
    id: 'sub_dist_3',
    districtId: 'dist_3',
    districtName: 'Чилонзор тумани',
    region: 'Тошкент шаҳри',
    status: 'SUSPENDED',
    statusStartedAt: '2026-08-27T10:00:00.000Z',
    scheduledTransitionAt: undefined,
    scheduledTransitionType: undefined,
    externalPaymentReference: undefined,
    internalNote: undefined,
    createdAt: '2026-08-01T09:30:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
  },
];

describe('Story 6.2: Subscriptions Lifecycle & Consequence Modals Unit Tests', () => {
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

  it('renders quick lifecycle action buttons in summary table (AC 1, AC 5)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValueOnce({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
      expect(screen.getByText('Мирзо Улуғбек тумани')).toBeTruthy();
      expect(screen.getByText('Чилонзор тумани')).toBeTruthy();
    });

    // ACTIVE row has Start Grace button
    const graceButtons = screen.getAllByRole('button', { name: /имтиёзли давр/i });
    expect(graceButtons.length).toBeGreaterThanOrEqual(1);

    // GRACE and SUSPENDED rows have Restore Active buttons
    const restoreButtons = screen.getAllByRole('button', { name: /фаоллаштириш/i });
    expect(restoreButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('opens StartGraceModal with 7-day consequence warnings and executes mutation on confirm (AC 1, AC 2, AC 10)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });
    const startGraceSpy = vi.spyOn(subscriptionClient, 'startDistrictGrace').mockResolvedValue({
      subscription: {
        ...mockSubscriptions[0]!,
        status: 'GRACE',
        scheduledTransitionType: 'AUTOMATIC_SUSPENSION',
        scheduledTransitionAt: '2026-09-03T05:00:00.000Z',
      },
      message: 'Туман учун 7 кунлик имтиёзли давр (Grace) бошланди.',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
    });

    // Click Start Grace button
    const graceButton = screen.getByRole('button', { name: /имтиёзли давр \(grace\)/i });
    fireEvent.click(graceButton);

    // Verify modal content and consequence warnings
    await waitFor(() => {
      expect(screen.getByText('Имтиёзли давр (Grace) оқибатлари:')).toBeTruthy();
      expect(screen.getByText(/telegram хабарларини қабул қилиш ва ai таҳлили тўхтатилмайди/i)).toBeTruthy();
      expect(screen.getByText(/аниқ 7 кундан \(168 соат\) сўнг туман автоматик равишда тўхтатилади/i)).toBeTruthy();
    });

    // Enter reason and submit
    const reasonInput = screen.getByPlaceholderText(/масалан: обуна тўлови бўйича музокаралар/i);
    fireEvent.change(reasonInput, { target: { value: 'Шартномани узайтириш кутилмоқда' } });

    const confirmBtn = screen.getByRole('button', { name: 'Имтиёзли даврни бошлаш' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(startGraceSpy).toHaveBeenCalledWith('dist_1', {
        reason: 'Шартномани узайтириш кутилмоқда',
      });
    });
  });

  it('prevents secret tokens in StartGraceModal reason (AC 10)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
    });

    const graceButton = screen.getByRole('button', { name: /имтиёзли давр \(grace\)/i });
    fireEvent.click(graceButton);

    await waitFor(() => {
      expect(screen.getByText('Имтиёзли давр (Grace) оқибатлари:')).toBeTruthy();
    });

    const reasonInput = screen.getByPlaceholderText(/масалан: обуна тўлови бўйича музокаралар/i);
    fireEvent.change(reasonInput, { target: { value: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789' } });

    const confirmBtn = screen.getByRole('button', { name: 'Имтиёзли даврни бошлаш' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText('Махфий маълумотлар тақиқланган')).toBeTruthy();
    });
  });

  it('opens RestoreActiveModal with prospective resumption warnings and executes mutation on confirm (AC 5, AC 11)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });
    const restoreSpy = vi.spyOn(subscriptionClient, 'restoreDistrictActive').mockResolvedValue({
      subscription: {
        ...mockSubscriptions[1]!,
        status: 'ACTIVE',
        scheduledTransitionType: undefined,
        scheduledTransitionAt: undefined,
      },
      message: 'Туман фаолияти (Active) муваффақиятли тикланди.',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Мирзо Улуғбек тумани')).toBeTruthy();
    });

    // Click Restore button on the second row (GRACE)
    const restoreButtons = screen.getAllByRole('button', { name: /фаоллаштириш/i });
    fireEvent.click(restoreButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText('Тиклаш шартлари ва оқибатлари:')).toBeTruthy();
      expect(screen.getByText(/фақат ҳозирдан бошлаб келадиган янги хабарлар учун/i)).toBeTruthy();
    });

    const confirmBtn = screen.getByRole('button', { name: 'Фаол ҳолатни тиклаш' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith('dist_2', {
        reason: undefined,
      });
    });
  });

  it('renders Grace warning banner and countdown in single district detail card (AC 2, AC 7)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Мирзо Улуғбек тумани')).toBeTruthy();
    });

    // Navigate to detail view of GRACE district (dist_2)
    const detailButtons = screen.getAllByRole('button', { name: /батафсил/i });
    fireEvent.click(detailButtons[1]!);

    await waitFor(() => {
      expect(screen.getByText('Туман ҳозир 7 кунлик имтиёзли даврда (Grace)')).toBeTruthy();
      expect(screen.getByText(/автоматик тўхтатилиш вақти/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /фаол ҳолатни тиклаш \(restore active\)/i })).toBeTruthy();
    });
  });

  it('renders Suspended error banner in single district detail card (AC 4, AC 7)', async () => {
    vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
      subscriptions: mockSubscriptions,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Чилонзор тумани')).toBeTruthy();
    });

    // Navigate to detail view of SUSPENDED district (dist_3)
    const detailButtons = screen.getAllByRole('button', { name: /батафсил/i });
    fireEvent.click(detailButtons[2]!);

    await waitFor(() => {
      expect(screen.getByText('Туман фаолияти вақтинча тўхтатилган (Suspended)')).toBeTruthy();
      expect(screen.getByRole('button', { name: /фаол ҳолатни тиклаш \(restore active\)/i })).toBeTruthy();
    });
  });
});
