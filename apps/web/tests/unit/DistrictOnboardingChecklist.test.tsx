import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictOnboardingChecklist } from '../../src/components/DistrictOnboardingChecklist.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { DistrictReadiness } from '@mahalla-ovozi/api-contracts';

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

const mockReadiness: DistrictReadiness = {
  districtId: 'dist_test_1',
  districtName: 'Чилонзор',
  status: 'SETUP_INCOMPLETE',
  isActivationReady: false,
  passedCount: 4,
  totalCount: 8,
  evaluatedAt: new Date().toISOString(),
  disclosureConfirmedAt: null,
  disclosureConfirmedById: null,
  items: [
    {
      key: 'district_identity',
      label: 'Туман маълумотлари',
      description: 'Туман номи ва ҳудуди киритилган',
      status: 'passed',
    },
    {
      key: 'access_eligibility',
      label: 'Тизимга кириш ҳуқуқи',
      description: 'Туман тизимга кириш учун фаол ҳолатда',
      status: 'passed',
    },
    {
      key: 'analysis_configuration',
      label: 'Асосий таҳлил созламалари',
      description: 'Тасдиқланган базавий таҳлил профили бириктирилган',
      status: 'passed',
    },
    {
      key: 'district_isolation',
      label: 'Ҳудудий хавфсизлик чегараси',
      description: 'Туманнинг алоҳида хавфсизлик муҳити текширилди',
      status: 'passed',
    },
    {
      key: 'disclosure_confirmation',
      label: 'Операцион кириш очиқлигини тасдиқлаш',
      description: 'Ташқи операцион кириш бўйича расмий тасдиқлов қайд этилди',
      status: 'incomplete',
      blockerReason: 'Маҳсулот эгаси томонидан операцион кириш очиқлиги тасдиқланмаган.',
      actionRequired: true,
    },
    {
      key: 'telegram_bot',
      label: 'Telegram бот уланиши',
      description: 'Туманнинг расмий Telegram боти фаоллаштирилди',
      status: 'incomplete',
      blockerReason: 'Telegram бот ҳали уланмаган (1.4-босқич).',
      actionRequired: true,
      actionPath: '/telegram-setup',
    },
    {
      key: 'group_mappings',
      label: 'Гуруҳлар ва маҳаллалар харитаси',
      description: 'Telegram гуруҳлари тегишли маҳаллаларга бириктирилди',
      status: 'incomplete',
      blockerReason: 'Маҳалла гуруҳлари бириктирилмаган (1.5-босқич).',
      actionRequired: true,
      actionPath: '/group-mappings',
    },
    {
      key: 'hokim_account',
      label: 'Ҳоким аккаунти',
      description: 'Туман ҳокими учун хавфсиз аккаунт яратилди',
      status: 'incomplete',
      blockerReason: 'Ҳоким аккаунти яратилмаган (1.6-босқич).',
      actionRequired: true,
      actionPath: '/hokim-account',
    },
  ],
};

describe('DistrictOnboardingChecklist Component Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    setupMatchMedia();
    Object.defineProperty(window.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  function renderChecklist(districtId = 'dist_test_1') {
    return render(
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={mahallaTheme}>
          <DistrictProvider>
            <BrowserRouter>
              <DistrictOnboardingChecklist districtId={districtId} />
            </BrowserRouter>
          </DistrictProvider>
        </ConfigProvider>
      </QueryClientProvider>
    );
  }

  it('renders all 8 prerequisite items and progress bar (AC 1, 2)', async () => {
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: mockReadiness,
    });

    renderChecklist();

    expect(
      await screen.findByText('Туманни фаоллаштиришга тайёрлаш')
    ).toBeTruthy();
    expect(screen.getByText('4 / 8 та талаб бажарилди')).toBeTruthy();
    expect(screen.getByText('Туман маълумотлари')).toBeTruthy();
    expect(screen.getByText('Тизимга кириш ҳуқуқи')).toBeTruthy();
    expect(screen.getByText('Асосий таҳлил созламалари')).toBeTruthy();
    expect(screen.getByText('Ҳудудий хавфсизлик чегараси')).toBeTruthy();
    expect(
      screen.getByText('Операцион кириш очиқлигини тасдиқлаш')
    ).toBeTruthy();
    expect(screen.getByText('Telegram бот уланиши')).toBeTruthy();
    expect(screen.getByText('Гуруҳлар ва маҳаллалар харитаси')).toBeTruthy();
    expect(screen.getByText('Ҳоким аккаунти')).toBeTruthy();
  });

  it('renders disabled activation button when isActivationReady is false (AC 2, 7)', async () => {
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: mockReadiness,
    });

    renderChecklist();

    const activateBtn = await screen.findByRole('button', {
      name: 'Туманни фаоллаштириш',
    });
    expect(activateBtn.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText(/Фаоллаштириш учун барча талаблар бажарилиши керак/)
    ).toBeTruthy();
  });

  it('opens disclosure confirmation modal on clicking confirm button (AC 5)', async () => {
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: mockReadiness,
    });

    renderChecklist();

    const confirmBtn = await screen.findByRole('button', { name: 'Тасдиқлаш' });
    expect(confirmBtn).toBeTruthy();

    fireEvent.click(confirmBtn);

    expect(
      await screen.findByRole('dialog', {
        name: 'Операцион кириш очиқлигини тасдиқлаш',
      })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Тасдиқлаш ва сақлаш' })
    ).toBeTruthy();
  });

  it('disables confirmation submit and shows offline banner when offline (AC 11)', async () => {
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: mockReadiness,
    });

    // Mock navigator.onLine as false
    Object.defineProperty(window.navigator, 'onLine', {
      value: false,
      configurable: true,
    });

    renderChecklist();

    const confirmBtn = await screen.findByRole('button', { name: 'Тасдиқлаш' });
    fireEvent.click(confirmBtn);

    expect(
      await screen.findByText('Сервер билан алоқа мавжуд эмас. Тармоқни текширинг.')
    ).toBeTruthy();

    const submitBtn = screen.getByRole('button', { name: 'Тасдиқлаш ва сақлаш' });
    expect(submitBtn.hasAttribute('disabled')).toBe(true);

    // Restore onLine
    Object.defineProperty(window.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  it('renders action buttons for incomplete prerequisites and navigates correctly (AC 1, 11, 14)', async () => {
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: mockReadiness,
    });

    const { container } = renderChecklist();

    const actionBtns = await screen.findAllByRole('button', { name: 'Созлаш' });
    expect(actionBtns.length).toBeGreaterThanOrEqual(1);

    const tgActionBtn = container.querySelector('#action-button-telegram_bot');
    expect(tgActionBtn).toBeTruthy();
  });

  it('opens DistrictActivationModal when isActivationReady is true and confirms activation (AC 1, 7, 16)', async () => {
    const readyMockReadiness: DistrictReadiness = {
      ...mockReadiness,
      isActivationReady: true,
      passedCount: 8,
      status: 'SETUP_INCOMPLETE',
      items: mockReadiness.items.map((item) => ({ ...item, status: 'passed' })),
    };

    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: readyMockReadiness,
    });

    const activateSpy = vi.spyOn(districtClient, 'activateDistrict').mockResolvedValueOnce({
      district: {
        id: 'dist_test_1',
        name: 'Чилонзор',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
      },
      activatedAt: new Date().toISOString(),
      activatedById: 'acc_po',
    });

    renderChecklist();

    const activateBtn = await screen.findByRole('button', {
      name: 'Туманни фаоллаштириш',
    });
    expect(activateBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(activateBtn);

    // Modal should appear
    expect(
      await screen.findByRole('dialog', {
        name: 'Туманни фаоллаштиришни тасдиқлаш',
      })
    ).toBeTruthy();
    expect(screen.getByText('Тайёрлик талаблари текширилди')).toBeTruthy();

    const submitBtn = screen.getByRole('button', {
      name: 'Фаоллаштиришни тасдиқлаш',
    });

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(activateSpy).toHaveBeenCalledWith('dist_test_1');
    });
  });

  it('renders persistent active banner and disables activation when status is ACTIVE (AC 8, 17)', async () => {
    const activeMockReadiness: DistrictReadiness = {
      ...mockReadiness,
      status: 'ACTIVE',
      isActivationReady: true,
      passedCount: 8,
      items: mockReadiness.items.map((item) => ({
        ...item,
        status: 'passed',
        completedAt: '2026-08-20T10:00:00.000Z',
      })),
    };

    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({
      readiness: activeMockReadiness,
    });

    renderChecklist();

    expect(await screen.findByText('Туман расман фаоллаштирилган')).toBeTruthy();
    expect(screen.getByText('✓ Туман аллақачон фаоллаштирилган')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Туманни фаоллаштириш' })).toBeNull();
  });

  it('opens EditDistrictDrawer when clicking Таҳрирлаш in checklist header', async () => {
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValueOnce({
      readiness: mockReadiness,
    });
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValueOnce({
      district: {
        id: 'dist_test_1',
        name: 'Чилонзор',
        region: 'Тошкент шаҳри',
        status: 'SETUP_INCOMPLETE',
        createdAt: '2026-08-20T10:00:00.000Z',
      },
    });

    renderChecklist();

    const editBtn = await screen.findByRole('button', { name: /Таҳрирлаш/i });
    fireEvent.click(editBtn);

    expect(await screen.findByText('Туман маълумотларини таҳрирлаш')).toBeTruthy();
    const nameInput = document.getElementById('edit-district-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Чилонзор');
  });
});


