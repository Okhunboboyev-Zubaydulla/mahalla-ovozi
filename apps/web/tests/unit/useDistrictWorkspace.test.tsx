import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDistrictWorkspace, districtQueryKeys } from '../../src/district/useDistrictWorkspace.js';
import { DistrictProvider } from '../../src/district/district-context.js';
import { districtClient } from '../../src/district/district-client.js';
import { telegramBotClient } from '../../src/district/telegram-bot-client.js';
import { telegramGroupClient } from '../../src/district/telegram-group-client.js';
import { hokimAccountClient } from '../../src/district/hokim-account-client.js';
import {
  District,
  DistrictReadiness,
  TelegramBotInfo,
  TelegramGroupMapping,
  GetDistrictHokimAccountResponse,
} from '@mahalla-ovozi/api-contracts';

const mockDistrict: District = {
  id: 'dist_test_1',
  name: 'Чилонзор тумани',
  region: 'Тошкент шаҳри',
  status: 'SETUP_INCOMPLETE',
  createdAt: '2026-08-18T10:00:00.000Z',
  activatedAt: null,
  activatedById: null,
};

const mockReadiness: DistrictReadiness = {
  districtId: 'dist_test_1',
  districtName: 'Чилонзор тумани',
  status: 'SETUP_INCOMPLETE',
  isActivationReady: true,
  passedCount: 8,
  totalCount: 8,
  evaluatedAt: '2026-08-18T10:00:00.000Z',
  disclosureConfirmedAt: null,
  disclosureConfirmedById: null,
  items: [
    { key: 'district_identity', label: 'Туман маълумотлари', description: 'Туман яратилган', status: 'passed' },
    { key: 'access_eligibility', label: 'Кириш ҳуқуқи', description: 'Ҳуқуқ берилган', status: 'passed' },
    { key: 'analysis_configuration', label: 'Таҳлил созламаси', description: 'Созланган', status: 'passed' },
    { key: 'district_isolation', label: 'Туман изоляцияси', description: 'Изоляция қилинган', status: 'passed' },
    { key: 'disclosure_confirmation', label: 'Очиқлик тасдиғи', description: 'Тасдиқланган', status: 'passed' },
    { key: 'telegram_bot', label: 'Телеграм бот', description: 'Бот уланган', status: 'passed' },
    { key: 'group_mappings', label: 'Телеграм гуруҳлар', description: 'Гуруҳлар мавжуд', status: 'passed' },
    { key: 'hokim_account', label: 'Ҳоким аккаунти', description: 'Аккаунт яратилган', status: 'passed' },
  ],
};

const mockBot: TelegramBotInfo = {
  id: 'tg_bot_123',
  districtId: 'dist_test_1',
  botId: '123456789',
  botUsername: 'chilonzor_test_bot',
  botFirstName: 'Chilonzor Test Bot',
  tokenMasked: '123456789:••••••••••••',
  status: 'VALID',
  lastValidatedAt: '2026-08-18T10:00:00.000Z',
  createdAt: '2026-08-18T10:00:00.000Z',
  updatedAt: '2026-08-18T10:00:00.000Z',
};

const mockGroups: TelegramGroupMapping[] = [
  {
    id: 'grp_1',
    districtId: 'dist_test_1',
    mahallaName: 'Чилонзор-1',
    telegramChatId: '-1001234567890',
    telegramChatTitle: 'Chilonzor Mahalla Group',
    telegramChatUsername: 'chilonzor_mahalla',
    status: 'VALID',
    botMembershipStatus: 'MEMBER',
    privacyModeDisabled: true,
    transport: 'BOT_API',
    testMessageReceivedAt: '2026-08-18T10:00:00.000Z',
    lastValidatedAt: '2026-08-18T10:00:00.000Z',
    lastError: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  },
];

const mockHokim: GetDistrictHokimAccountResponse = {
  state: 'ACTIVE',
  account: {
    id: 'acc_1',
    username: 'hokim_chilonzor',
    role: 'DISTRICT_HOKIM',
    status: 'ACTIVE',
    districtId: 'dist_test_1',
    credentialVersion: 1,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  },
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <DistrictProvider>{children}</DistrictProvider>
      </QueryClientProvider>
    ),
  };
}

describe('useDistrictWorkspace Hook Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('remains idle with null/empty domain state when districtId is null', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDistrictWorkspace(null), { wrapper });

    expect(result.current.districtId).toBeNull();
    expect(result.current.district).toBeNull();
    expect(result.current.readiness).toBeNull();
    expect(result.current.bot).toBeNull();
    expect(result.current.groups).toEqual([]);
    expect(result.current.hokimState).toBe('NO_ACCOUNT');
    expect(result.current.hokimAccount).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isActivationReady).toBe(false);
  });

  it('fetches all sub-resources in parallel when districtId is provided', async () => {
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValueOnce({ district: mockDistrict });
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValueOnce({ readiness: mockReadiness });
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({ bot: mockBot });
    vi.spyOn(telegramGroupClient, 'listGroups').mockResolvedValueOnce({ groups: mockGroups });
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValueOnce(mockHokim);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDistrictWorkspace('dist_test_1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.district).toEqual(mockDistrict);
    expect(result.current.readiness).toEqual(mockReadiness);
    expect(result.current.bot).toEqual(mockBot);
    expect(result.current.groups).toEqual(mockGroups);
    expect(result.current.hokimState).toBe('ACTIVE');
    expect(result.current.hokimAccount).toEqual(mockHokim.account);

    // Derived states
    expect(result.current.isActivationReady).toBe(true);
    expect(result.current.isAlreadyActive).toBe(false);
    expect(result.current.passedCount).toBe(8);
    expect(result.current.totalCount).toBe(8);
  });

  it('executes confirmDisclosure and automatically invalidates readiness query key', async () => {
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValueOnce({ district: mockDistrict });
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValueOnce({ readiness: mockReadiness });
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({ bot: null });
    vi.spyOn(telegramGroupClient, 'listGroups').mockResolvedValueOnce({ groups: [] });
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValueOnce({
      state: 'NO_ACCOUNT',
      account: null,
    });

    vi.spyOn(districtClient, 'confirmDisclosure').mockResolvedValueOnce({
      districtId: 'dist_test_1',
      disclosureConfirmedAt: '2026-08-18T10:00:00.000Z',
      disclosureConfirmedById: 'user_1',
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDistrictWorkspace('dist_test_1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.confirmDisclosure();
    });

    expect(districtClient.confirmDisclosure).toHaveBeenCalledWith('dist_test_1');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.readiness('dist_test_1'),
    });
  });

  it('executes activateDistrict, updates cache data, and invalidates readiness + district list', async () => {
    const activeDistrict: District = { ...mockDistrict, status: 'ACTIVE', activatedAt: '2026-08-18T10:00:00.000Z', activatedById: 'user_1' };
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValueOnce({ district: mockDistrict });
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValueOnce({ readiness: mockReadiness });
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({ bot: mockBot });
    vi.spyOn(telegramGroupClient, 'listGroups').mockResolvedValueOnce({ groups: mockGroups });
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValueOnce(mockHokim);

    vi.spyOn(districtClient, 'activateDistrict').mockResolvedValueOnce({
      district: activeDistrict,
      activatedAt: '2026-08-18T10:00:00.000Z',
      activatedById: 'user_1',
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');

    const { result } = renderHook(() => useDistrictWorkspace('dist_test_1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.activateDistrict();
    });

    expect(districtClient.activateDistrict).toHaveBeenCalledWith('dist_test_1');
    expect(setQueryDataSpy).toHaveBeenCalledWith(
      districtQueryKeys.district('dist_test_1'),
      { district: activeDistrict }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.readiness('dist_test_1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.list(),
    });
  });

  it('executes bot, group, and hokim mutations with cross-resource invalidations', async () => {
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValueOnce({ district: mockDistrict });
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValueOnce({ readiness: mockReadiness });
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({ bot: null });
    vi.spyOn(telegramGroupClient, 'listGroups').mockResolvedValueOnce({ groups: [] });
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValueOnce({
      state: 'NO_ACCOUNT',
      account: null,
    });

    vi.spyOn(telegramBotClient, 'connectDistrictTelegramBot').mockResolvedValueOnce({ bot: mockBot });
    vi.spyOn(telegramGroupClient, 'createGroup').mockResolvedValueOnce({ group: mockGroups[0]! });
    vi.spyOn(hokimAccountClient, 'createDistrictHokimAccount').mockResolvedValueOnce({
      account: mockHokim.account!,
      temporaryPassword: 'TempPassword123!',
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDistrictWorkspace('dist_test_1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // 1. Connect bot
    await act(async () => {
      await result.current.connectBot('123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Valid1');
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.bot('dist_test_1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.readiness('dist_test_1') });

    // 2. Create group
    await act(async () => {
      await result.current.createGroup({ telegramChatId: '-1001234567890', mahallaName: 'Чилонзор-1' });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.groups('dist_test_1') });

    // 3. Create hokim
    await act(async () => {
      await result.current.createHokimAccount('hokim_chilonzor');
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.hokim('dist_test_1') });
  });

  it('provides invalidateWorkspace and refetchAll lifecycle helpers', async () => {
    vi.spyOn(districtClient, 'getDistrict').mockResolvedValue({ district: mockDistrict });
    vi.spyOn(districtClient, 'getDistrictReadiness').mockResolvedValue({ readiness: mockReadiness });
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValue({ bot: mockBot });
    vi.spyOn(telegramGroupClient, 'listGroups').mockResolvedValue({ groups: mockGroups });
    vi.spyOn(hokimAccountClient, 'getDistrictHokimAccount').mockResolvedValue(mockHokim);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDistrictWorkspace('dist_test_1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.invalidateWorkspace();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.district('dist_test_1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.readiness('dist_test_1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.bot('dist_test_1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.groups('dist_test_1') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: districtQueryKeys.hokim('dist_test_1') });
  });
});
