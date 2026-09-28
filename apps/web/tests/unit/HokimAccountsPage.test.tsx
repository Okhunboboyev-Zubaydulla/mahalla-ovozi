import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HokimAccountsPage } from '../../src/pages/HokimAccountsPage.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
import { hokimAccountClient } from '../../src/district/hokim-account-client.js';
import { mahallaTheme } from '../../src/theme/antd-theme.js';
import { District, DistrictHokimAccount } from '@mahalla-ovozi/api-contracts';

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

const mockDistricts: District[] = [
  {
    id: 'dist_test_1',
    name: 'Чилонзор',
    region: 'Тошкент ш.',
    status: 'SETUP_INCOMPLETE',
    createdAt: '2026-08-18T10:00:00.000Z',
  },
];

const mockActiveAccount: DistrictHokimAccount = {
  id: 'acc_hokim_1',
  username: 'hokim_chilonzor',
  role: 'DISTRICT_HOKIM',
  status: 'ACTIVE',
  districtId: 'dist_test_1',
  credentialVersion: 1,
  createdAt: '2026-08-18T10:00:00.000Z',
  updatedAt: '2026-08-18T10:00:00.000Z',
};

const mockDisabledAccount: DistrictHokimAccount = {
  id: 'acc_hokim_2',
  username: 'hokim_disabled',
  role: 'DISTRICT_HOKIM',
  status: 'DISABLED',
  districtId: 'dist_test_1',
  credentialVersion: 2,
  createdAt: '2026-08-18T10:00:00.000Z',
  updatedAt: '2026-08-18T11:00:00.000Z',
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={mahallaTheme}>
        <DistrictProvider>
          <BrowserRouter>{ui}</BrowserRouter>
        </DistrictProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}

describe('HokimAccountsPage Component Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(districtClient, 'listDistricts').mockResolvedValue({
      districts: mockDistricts,
    });

    vi.spyOn(districtClient, 'getDistrict').mockResolvedValue({
      district: mockDistricts[0]!,
    });
  });

  it('renders NO_ACCOUNT state with creation CTA when district has no Hokim account (AC 1)', async () => {
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValue({
      state: 'NO_ACCOUNT',
      account: null,
    });

    renderWithProviders(<HokimAccountsPage districtId="dist_test_1" />);

    expect(await screen.findByText('Ҳоким аккаунти яратилмаган')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ҳоким аккаунтини яратиш/i })).toBeTruthy();
  });

  it('opens create modal, submits, and displays OneTimeCredentialModal on creation (AC 2, 3)', async () => {
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValue({
      state: 'NO_ACCOUNT',
      account: null,
    });

    vi.spyOn(hokimAccountClient, 'createDistrictHokimAccount').mockResolvedValue({
      account: mockActiveAccount,
      temporaryPassword: 'GeneratedTempPassword123!',
    });

    renderWithProviders(<HokimAccountsPage districtId="dist_test_1" />);

    expect(await screen.findByText('Ҳоким аккаунти яратилмаган')).toBeTruthy();

    // Click CTA to open modal
    fireEvent.click(screen.getByRole('button', { name: /Ҳоким аккаунтини яратиш/i }));

    expect(await screen.findByLabelText(/Фойдаланувчи номи/i)).toBeTruthy();

    // Enter username
    const usernameInput = screen.getByLabelText(/Фойдаланувчи номи/i);
    fireEvent.change(usernameInput, { target: { value: 'hokim_chilonzor' } });

    // Submit form
    const submitBtn = screen.getAllByRole('button', { name: /Аккаунт яратиш/i })[0];
    fireEvent.click(submitBtn!);

    // Expect one-time credential modal to open with the temporary password
    expect(await screen.findByText('GeneratedTempPassword123!')).toBeTruthy();
    expect(screen.getByText(/Ушбу вақтинчалик парол фақат бир марта кўрсатилади/i)).toBeTruthy();

    // Dismiss one-time modal
    const closeBtn = screen.getByRole('button', { name: 'Тушундим, ойнани ёпиш' });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('GeneratedTempPassword123!')).toBeNull();
    });
  });

  it('renders ACTIVE state with badges, metadata, and action buttons (AC 1, 9, 10, 11)', async () => {
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValue({
      state: 'ACTIVE',
      account: mockActiveAccount,
    });

    renderWithProviders(<HokimAccountsPage districtId="dist_test_1" />);

    expect(await screen.findByText(/hokim_chilonzor/i)).toBeTruthy();
    expect(screen.getAllByText('Фаол').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Туман ҳокими')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Исмни таҳрирлаш/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Паролни янгилаш/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Аккаунтни алмаштириш/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Фаолсизлантириш/i })).toBeTruthy();
  });

  it('opens edit modal and updates Hokim name in-place', async () => {
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValue({
      state: 'ACTIVE',
      account: mockActiveAccount,
    });

    const updateSpy = vi.spyOn(hokimAccountClient, 'updateDistrictHokimUsername').mockResolvedValue({
      account: {
        ...mockActiveAccount,
        username: 'Botir Zoirov',
      },
    });

    renderWithProviders(<HokimAccountsPage districtId="dist_test_1" />);

    expect(await screen.findByText(/hokim_chilonzor/i)).toBeTruthy();

    // Click edit button
    fireEvent.click(screen.getByRole('button', { name: /Исмни таҳрирлаш/i }));

    // Input should be prefilled or present
    const input = await screen.findByDisplayValue('hokim_chilonzor');
    expect(input).toBeTruthy();

    // Change to natural name with spaces
    fireEvent.change(input, { target: { value: 'Botir Zoirov' } });

    // Submit form
    const saveBtn = screen.getByRole('button', { name: 'Сақлаш' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('dist_test_1', { username: 'Botir Zoirov' });
    });
  });

  it('renders DISABLED state with disabled badge and action buttons (AC 1)', async () => {
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValue({
      state: 'DISABLED',
      account: mockDisabledAccount,
    });

    renderWithProviders(<HokimAccountsPage districtId="dist_test_1" />);

    expect(await screen.findByText(/hokim_disabled/i)).toBeTruthy();
    expect(screen.getAllByText('Фаолсизлантирилган').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Аккаунтни алмаштириш/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Янги аккаунт яратиш/i })).toBeTruthy();
  });

  it('renders prompt when no district is selected', async () => {
    renderWithProviders(<HokimAccountsPage districtId={undefined} />);

    expect(
      screen.getByText(/Ҳоким аккаунтини бошқариш учун аввал юқоридаги менюдан туманни танланг/i)
    ).toBeTruthy();
  });
});
