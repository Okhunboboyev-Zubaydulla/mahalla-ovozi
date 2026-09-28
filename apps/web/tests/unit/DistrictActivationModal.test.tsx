import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictActivationModal } from '../../src/components/DistrictActivationModal.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
import { ApiError } from '../../src/lib/api-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';

function setupMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
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

describe('DistrictActivationModal Isolated Component Tests (AC 1, 7, 16)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    setupMatchMedia();
    Object.defineProperty(window.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  function renderModal(props: {
    open: boolean;
    onClose: () => void;
    districtId: string;
    districtName?: string;
  }) {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <DistrictProvider>
            <BrowserRouter>
              <DistrictActivationModal {...props} />
            </BrowserRouter>
          </DistrictProvider>
        </ConfigProvider>
      </QueryClientProvider>
    );
  }

  it('renders modal with prerequisite summary and district name when open (AC 1, 7)', async () => {
    renderModal({
      open: true,
      onClose: vi.fn(),
      districtId: 'dist_act_1',
      districtName: 'Миробод',
    });

    expect(await screen.findByRole('dialog', { name: 'Туманни фаоллаштиришни тасдиқлаш' })).toBeTruthy();
    expect(screen.getByText('Тайёрлик талаблари текширилди')).toBeTruthy();
    expect(screen.getByText('Миробод')).toBeTruthy();
    expect(screen.getByText(/туманини тизимда расман фаоллаштиришни тасдиқлайсизми/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Фаоллаштиришни тасдиқлаш' })).toBeTruthy();
  });

  it('renders inline error alert with dynamic blocker action links on 409 DISTRICT_NOT_READY failure (AC 16)', async () => {
    const errorWithBlockers = new ApiError(
      'Туманни фаоллаштириш учун барча талаблар бажарилмаган.',
      'DISTRICT_NOT_READY',
      409,
      false,
      [
        {
          key: 'hokim_account',
          label: 'Ҳоким аккаунти',
          description: 'Ҳоким аккаунти яратилмаган',
          status: 'incomplete',
          blockerReason: 'Ҳоким аккаунти ҳали яратилмаган.',
          actionRequired: true,
          actionPath: '/hokim-accounts',
        },
      ]
    );

    vi.spyOn(districtClient, 'activateDistrict').mockRejectedValueOnce(errorWithBlockers);

    renderModal({
      open: true,
      onClose: vi.fn(),
      districtId: 'dist_act_1',
      districtName: 'Миробод',
    });

    const submitBtn = await screen.findByRole('button', { name: 'Фаоллаштиришни тасдиқлаш' });

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('Туманни фаоллаштириш учун барча талаблар бажарилмаган.')).toBeTruthy();
    });

    expect(screen.getByText('Ҳоким аккаунти')).toBeTruthy();
    expect(screen.getByText('Ҳоким аккаунти ҳали яратилмаган.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Созлаш' })).toBeTruthy();
  });

  it('disables submit button and shows offline banner when offline (AC 11)', async () => {
    Object.defineProperty(window.navigator, 'onLine', {
      value: false,
      configurable: true,
    });

    renderModal({
      open: true,
      onClose: vi.fn(),
      districtId: 'dist_act_1',
      districtName: 'Миробод',
    });

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(await screen.findByText('Сервер билан алоқа мавжуд эмас. Тармоқни текширинг.')).toBeTruthy();
    const submitBtn = screen.getByRole('button', { name: 'Фаоллаштиришни тасдиқлаш' });
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
  });
});

