import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTelegramBot } from '../../src/district/useTelegramBot.js';
import { telegramBotClient } from '../../src/district/telegram-bot-client.js';
import { districtQueryKeys } from '../../src/district/query-keys.js';
import { TelegramBotInfo } from '@mahalla-ovozi/api-contracts';

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
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe('useTelegramBot Hook Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('remains idle with null bot when districtId is null', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTelegramBot(null), { wrapper });

    expect(result.current.bot).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches and returns bot metadata when districtId is provided', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTelegramBot('dist_test_1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.bot).toEqual(mockBot);
    expect(telegramBotClient.getDistrictTelegramBot).toHaveBeenCalledWith('dist_test_1');
  });

  it('executes connectBot and invalidates telegram-bot and readiness query keys', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: null,
    });
    vi.spyOn(telegramBotClient, 'connectDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useTelegramBot('dist_test_1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.connectBot({ token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Valid1' });
    });

    expect(telegramBotClient.connectDistrictTelegramBot).toHaveBeenCalledWith('dist_test_1', {
      token: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_Valid1',
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.bot('dist_test_1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.readiness('dist_test_1'),
    });
  });

  it('executes disconnectBot and invalidates telegram-bot and readiness query keys', async () => {
    vi.spyOn(telegramBotClient, 'getDistrictTelegramBot').mockResolvedValueOnce({
      bot: mockBot,
    });
    vi.spyOn(telegramBotClient, 'disconnectDistrictTelegramBot').mockResolvedValueOnce({
      success: true,
      disconnectedBotId: '123456789',
    });

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useTelegramBot('dist_test_1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.disconnectBot();
    });

    expect(telegramBotClient.disconnectDistrictTelegramBot).toHaveBeenCalledWith('dist_test_1');

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.bot('dist_test_1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: districtQueryKeys.readiness('dist_test_1'),
    });
  });
});
