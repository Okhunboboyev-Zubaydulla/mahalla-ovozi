import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateTelegramBot,
  TelegramInvalidTokenError,
  TelegramNetworkTimeoutError,
  TelegramRateLimitError,
  TelegramApiError,
  redactTokenFromUrl,
} from '../src/adapters/telegram/telegram-client.js';

describe('Telegram API Integration Adapter (telegram-client)', () => {
  const sampleToken = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Token Redaction Helper (redactTokenFromUrl)', () => {
    it('redacts token from Telegram API URLs in strings and logs', () => {
      const url = `https://api.telegram.org/bot${sampleToken}/getMe`;
      expect(redactTokenFromUrl(url)).toBe(
        'https://api.telegram.org/bot[REDACTED]/getMe',
      );
    });

    it('redacts token occurrences in arbitrary error messages', () => {
      const errorMsg = `Fetch failed for url https://api.telegram.org/bot${sampleToken}/getMe with token ${sampleToken}`;
      expect(redactTokenFromUrl(errorMsg, sampleToken)).toBe(
        'Fetch failed for url https://api.telegram.org/bot[REDACTED]/getMe with token [REDACTED]',
      );
    });
  });

  describe('validateTelegramBot', () => {
    it('successfully validates bot and returns normalized metadata with username', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: 'Mahalla Bot',
            username: 'mahalla_bot',
          },
        }),
      });

      const result = await validateTelegramBot(sampleToken, {
        customFetch: mockFetch as unknown as typeof fetch,
      });

      expect(result).toEqual({
        botId: '123456789',
        botFirstName: 'Mahalla Bot',
        botUsername: 'mahalla_bot',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('successfully validates bot and returns null username when not set by Telegram', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: 987654321,
            is_bot: true,
            first_name: 'Unnamed Bot',
          },
        }),
      });

      const result = await validateTelegramBot(sampleToken, {
        customFetch: mockFetch as unknown as typeof fetch,
      });

      expect(result).toEqual({
        botId: '987654321',
        botFirstName: 'Unnamed Bot',
        botUsername: null,
      });
    });

    it('rejects malformed token syntax immediately without making network call', async () => {
      const mockFetch = vi.fn();

      await expect(
        validateTelegramBot('invalid_token_syntax', {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramInvalidTokenError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws TelegramInvalidTokenError when is_bot is false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: 123456789,
            is_bot: false,
            first_name: 'Personal Account',
          },
        }),
      });

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramInvalidTokenError);
    });

    it('throws TelegramInvalidTokenError when Telegram returns 400 Bad Request', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          ok: false,
          error_code: 400,
          description: 'Bad Request: invalid token',
        }),
      });

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramInvalidTokenError);
    });

    it('throws TelegramInvalidTokenError when Telegram returns 401 Unauthorized', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }),
      });

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramInvalidTokenError);
    });

    it('throws TelegramInvalidTokenError when Telegram returns 404 Not Found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({
          ok: false,
          error_code: 404,
          description: 'Not Found',
        }),
      });

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramInvalidTokenError);
    });

    it('throws TelegramRateLimitError when Telegram returns 429 Too Many Requests', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 30',
        }),
      });

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramRateLimitError);
    });

    it('throws TelegramApiError when Telegram returns 500 or 502', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => ({
          ok: false,
          error_code: 502,
          description: 'Bad Gateway',
        }),
      });

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramApiError);
    });

    it('throws TelegramNetworkTimeoutError when network call aborts or times out', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'TimeoutError';

      const mockFetch = vi.fn().mockRejectedValue(abortError);

      await expect(
        validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(TelegramNetworkTimeoutError);
    });

    it('ensures raw token is never exposed in thrown error messages', async () => {
      const mockFetch = vi.fn().mockRejectedValue(
        new Error(`Connection failed to https://api.telegram.org/bot${sampleToken}/getMe`),
      );

      try {
        await validateTelegramBot(sampleToken, {
          customFetch: mockFetch as unknown as typeof fetch,
        });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toContain(sampleToken);
        expect(error.message).toContain('[REDACTED]');
      }
    });
  });
});
