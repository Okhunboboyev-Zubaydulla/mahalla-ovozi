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
import { CancelDistrictModal } from '../../src/components/subscriptions/CancelDistrictModal.js';
import { StartRecoveryModal } from '../../src/components/subscriptions/StartRecoveryModal.js';

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
    id: 'sub_dist_cancelled',
    districtId: 'dist_cancelled',
    districtName: 'Яшнобод тумани',
    region: 'Тошкент шаҳри',
    status: 'CANCELLED',
    statusStartedAt: '2026-08-20T09:30:00.000Z',
    scheduledTransitionAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
    scheduledTransitionType: 'LIVE_DELETION',
    externalPaymentReference: undefined,
    internalNote: undefined,
    createdAt: '2026-08-15T09:30:00.000Z',
    updatedAt: '2026-08-20T09:30:00.000Z',
  },
];

describe('Story 6.3: District Cancellation & Recovery Component Unit Tests', () => {
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

  describe('CancelDistrictModal Component', () => {
    it('renders 7-point consequence alerts and keeps destructive button disabled until valid', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();

      render(
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <CancelDistrictModal
              open={true}
              districtId="dist_test_1"
              districtName="Шайхонтоҳур тумани"
              region="Тошкент шаҳри"
              isPending={false}
              onConfirm={onConfirm}
              onClose={onClose}
            />
          </AntdApp>
        </ConfigProvider>,
      );

      // Verify title and district details
      expect(screen.getByText('Туманни бекор қилиш (Cancel District)')).toBeTruthy();
      expect(screen.getAllByText('Шайхонтоҳур тумани').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/dist_test_1/)).toBeTruthy();

      // Verify 7-point consequence warnings
      expect(screen.getByText(/30 кунлик тиклаш муддати:/)).toBeTruthy();
      expect(screen.getByText(/Ҳимояланган захира нусхалари:/)).toBeTruthy();
      expect(screen.getByText(/Амаллар тўхтатилиши:/)).toBeTruthy();
      expect(screen.getByText(/Бот токени ўчирилиши:/)).toBeTruthy();
      expect(screen.getByText(/90 кунлик сақлаш/)).toBeTruthy();
      expect(screen.getByText(/Маълумотларни тиклаш чеклови:/)).toBeTruthy();
      expect(screen.getByText(/Ўтказиб юборилган хабарлар:/)).toBeTruthy();

      // Destructive button should be disabled initially
      const confirmButton = screen.getByRole('button', { name: 'Туманни бекор қилиш' });
      expect(confirmButton.hasAttribute('disabled')).toBe(true);

      // Input reason
      const reasonInput = screen.getByPlaceholderText(/Шартнома муддати тугаши муносабати билан/i);
      fireEvent.change(reasonInput, { target: { value: 'Муддати тугаган шартнома бекор қилинмоқда' } });

      // Still disabled because confirmation name is missing
      expect(confirmButton.hasAttribute('disabled')).toBe(true);

      // Input wrong name
      const nameInput = screen.getByPlaceholderText('Шайхонтоҳур тумани');
      fireEvent.change(nameInput, { target: { value: 'Бошқа туман' } });
      expect(confirmButton.hasAttribute('disabled')).toBe(true);

      // Input matching name
      fireEvent.change(nameInput, { target: { value: 'Шайхонтоҳур тумани' } });

      // Button is now enabled
      expect(confirmButton.hasAttribute('disabled')).toBe(false);

      // Click confirm
      fireEvent.click(confirmButton);
      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledWith({
          reason: 'Муддати тугаган шартнома бекор қилинмоқда',
          confirmationDistrictName: 'Шайхонтоҳур тумани',
        });
      });
    });

    it('rejects prohibited secrets entered in reason field and displays warning alert', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();

      render(
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <CancelDistrictModal
              open={true}
              districtId="dist_test_1"
              districtName="Шайхонтоҳур тумани"
              isPending={false}
              onConfirm={onConfirm}
              onClose={onClose}
            />
          </AntdApp>
        </ConfigProvider>,
      );

      const reasonInput = screen.getByPlaceholderText(/Шартнома муддати тугаши муносабати билан/i);
      const nameInput = screen.getByPlaceholderText('Шайхонтоҳур тумани');
      const confirmButton = screen.getByRole('button', { name: 'Туманни бекор қилиш' });

      // Enter bot token secret in reason
      fireEvent.change(reasonInput, {
        target: { value: 'Бекор қилиш сабаби: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789' },
      });
      fireEvent.change(nameInput, { target: { value: 'Шайхонтоҳур тумани' } });

      // Secret error alert should appear
      expect(screen.getByText('Махфий маълумотлар тақиқланган')).toBeTruthy();
      expect(confirmButton.hasAttribute('disabled')).toBe(true);
    });
  });

  describe('StartRecoveryModal Component', () => {
    it('renders recovery consequences and executes onConfirm with optional reason', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();

      render(
        <ConfigProvider theme={mahallaTheme}>
          <AntdApp>
            <StartRecoveryModal
              open={true}
              districtId="dist_cancelled"
              districtName="Яшнобод тумани"
              isPending={false}
              onConfirm={onConfirm}
              onClose={onClose}
            />
          </AntdApp>
        </ConfigProvider>,
      );

      expect(screen.getByText('Туманни тиклашни бошлаш (Start Recovery)')).toBeTruthy();
      expect(screen.getByText(/Созлаш тугалланмаган/)).toBeTruthy();
      expect(screen.getByText(/янги Telegram бот токени/)).toBeTruthy();

      const startButton = screen.getByRole('button', { name: 'Тиклашни бошлаш' });
      expect(startButton.hasAttribute('disabled')).toBe(false);

      const reasonInput = screen.getByPlaceholderText(/Янги шартнома тузилди/i);
      fireEvent.change(reasonInput, { target: { value: 'Янги шартнома тузилди' } });

      fireEvent.click(startButton);
      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledWith({
          reason: 'Янги шартнома тузилди',
        });
      });
    });
  });

  describe('SubscriptionsPage Integration with Cancel & Recovery', () => {
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

    it('renders cancellation and recovery buttons in table', async () => {
      vi.spyOn(subscriptionClient, 'listDistrictSubscriptions').mockResolvedValue({
        subscriptions: mockSubscriptions,
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Юнусобод тумани')).toBeTruthy();
        expect(screen.getByText('Яшнобод тумани')).toBeTruthy();
      });

      // Active district has "Бекор қилиш" button
      expect(screen.getByText('Бекор қилиш')).toBeTruthy();

      // Cancelled district has "Тиклаш" button
      expect(screen.getByText('Тиклаш')).toBeTruthy();
    });
  });
});
