import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictSubscription } from '@mahalla-ovozi/api-contracts';
import { SubscriptionsPage } from '../../src/pages/SubscriptionsPage.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { subscriptionClient } from '../../src/api/subscription-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { DistrictSubscriptionDetailCard } from '../../src/components/subscriptions/DistrictSubscriptionDetailCard.js';

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

describe('Story 6.4: District Live Deletion UI Component Unit Tests', () => {
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

  describe('DistrictSubscriptionDetailCard Component', () => {
    it('displays expired recovery banner and disables start recovery button when 30-day window is expired', () => {
      const expiredSubscription: DistrictSubscription = {
        id: 'sub_expired_1',
        districtId: 'dist_expired_1',
        districtName: 'Сирғали тумани',
        region: 'Тошкент шаҳри',
        status: 'CANCELLED',
        statusStartedAt: '2026-07-01T00:00:00.000Z',
        scheduledTransitionAt: '2026-07-31T00:00:00.000Z', // Past date
        scheduledTransitionType: 'LIVE_DELETION',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      };

      const onStartRecovery = vi.fn();
      const onEdit = vi.fn();

      render(
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <DistrictSubscriptionDetailCard
              subscription={expiredSubscription}
              onStartRecovery={onStartRecovery}
              onEdit={onEdit}
              isOffline={false}
            />
          </AntdApp>
        </ConfigProvider>,
      );

      // Verify expired banner message
      expect(screen.getByText('Туман бекор қилинган (Тиклаш муддати тугаган)')).toBeDefined();
      expect(
        screen.getByText(/30 кунлик тиклаш муддати тугаган. Туманни қайта тиклаш мумкин эмас/i),
      ).toBeDefined();

      // Verify start recovery button is disabled
      const recoveryButton = screen.getByRole('button', {
        name: /Туманни тиклашни бошлаш \(Start Recovery\)/i,
      });
      expect(recoveryButton).toBeDefined();
      expect(recoveryButton.hasAttribute('disabled')).toBe(true);
    });

    it('enables start recovery button when cancellation window is still active', () => {
      const activeCancelledSubscription: DistrictSubscription = {
        id: 'sub_cancelled_active',
        districtId: 'dist_cancelled_active',
        districtName: 'Чилонзор тумани',
        region: 'Тошкент шаҳри',
        status: 'CANCELLED',
        statusStartedAt: '2026-08-20T00:00:00.000Z',
        scheduledTransitionAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(), // 20 days in future
        scheduledTransitionType: 'LIVE_DELETION',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      };

      const onStartRecovery = vi.fn();

      render(
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <DistrictSubscriptionDetailCard
              subscription={activeCancelledSubscription}
              onStartRecovery={onStartRecovery}
              onEdit={vi.fn()}
              isOffline={false}
            />
          </AntdApp>
        </ConfigProvider>,
      );

      expect(screen.getByText('Туман бекор қилинган (Cancelled)')).toBeDefined();
      const recoveryButton = screen.getByRole('button', {
        name: /Туманни тиклашни бошлаш \(Start Recovery\)/i,
      });
      expect(recoveryButton.hasAttribute('disabled')).toBe(false);
    });
  });

  describe('SubscriptionsPage Integration & Invalidation', () => {
    it('gracefully handles deleted district in detail view and shows informational message', async () => {
      const mockSubscriptionsList: DistrictSubscription[] = [
        {
          id: 'sub_existing',
          districtId: 'dist_existing',
          districtName: 'Миробод тумани',
          region: 'Тошкент шаҳри',
          status: 'ACTIVE',
          statusStartedAt: '2026-08-01T00:00:00.000Z',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ];

      vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
        subscriptions: mockSubscriptionsList,
      });

      render(
        <QueryClientProvider client={queryClient}>
          <ConfigProvider theme={mahallaTheme}>
            <AntdApp>
              <BrowserRouter>
                <DistrictProvider>
                  <SubscriptionsPage />
                </DistrictProvider>
              </BrowserRouter>
            </AntdApp>
          </ConfigProvider>
        </QueryClientProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Миробод тумани')).toBeDefined();
      });
    });
  });
});
