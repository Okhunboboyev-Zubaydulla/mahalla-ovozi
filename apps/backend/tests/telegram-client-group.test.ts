import { describe, it, expect, vi } from 'vitest';
import {
  getTelegramChat,
  verifyBotGroupMembership,
  checkGroupPrivacyMode,
  TelegramChatNotFoundError,
  TelegramBotNotMemberError,
  TelegramBotIsAdminError,
} from '../src/adapters/telegram/telegram-client.js';

describe('Telegram Client Group Verification & Privacy Adapters', () => {
  const token = '123456789:ABCdefGHIjklmnOPQRstuvWXYZ_12345678';
  const botId = '123456789';
  const chatId = '-1001234567890';

  describe('getTelegramChat', () => {
    it('returns parsed chat info for a valid group', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: -1001234567890,
            title: 'Navbahor Mahalla Guruhi',
            type: 'supergroup',
            username: 'navbahor_chat',
          },
        }),
      } as unknown as Response);

      const result = await getTelegramChat(token, chatId, { customFetch: customFetch as unknown as typeof fetch });
      expect(result.chatId).toBe('-1001234567890');
      expect(result.chatTitle).toBe('Navbahor Mahalla Guruhi');
      expect(result.chatType).toBe('supergroup');
      expect(result.chatUsername).toBe('navbahor_chat');
    });

    it('throws TelegramChatNotFoundError when chat not found (400 / 404)', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
      } as unknown as Response);

      await expect(
        getTelegramChat(token, chatId, { customFetch: customFetch as unknown as typeof fetch })
      ).rejects.toThrow(TelegramChatNotFoundError);
    });
  });

  describe('verifyBotGroupMembership', () => {
    it('succeeds when bot status is ordinary "member"', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            status: 'member',
            user: { id: 123456789, is_bot: true, first_name: 'District Bot' },
          },
        }),
      } as unknown as Response);

      const result = await verifyBotGroupMembership(token, chatId, botId, {
        customFetch: customFetch as unknown as typeof fetch,
      });
      expect(result.status).toBe('member');
    });

    it('throws TelegramBotIsAdminError when bot is "administrator" (AC 4)', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            status: 'administrator',
            user: { id: 123456789, is_bot: true, first_name: 'District Bot' },
            can_be_edited: false,
          },
        }),
      } as unknown as Response);

      await expect(
        verifyBotGroupMembership(token, chatId, botId, {
          customFetch: customFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow(TelegramBotIsAdminError);
    });

    it('throws TelegramBotIsAdminError when bot is "creator" (AC 4)', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            status: 'creator',
            user: { id: 123456789, is_bot: true, first_name: 'District Bot' },
          },
        }),
      } as unknown as Response);

      await expect(
        verifyBotGroupMembership(token, chatId, botId, {
          customFetch: customFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow(TelegramBotIsAdminError);
    });

    it('throws TelegramBotNotMemberError when bot is "left" or "kicked"', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            status: 'left',
            user: { id: 123456789, is_bot: true, first_name: 'District Bot' },
          },
        }),
      } as unknown as Response);

      await expect(
        verifyBotGroupMembership(token, chatId, botId, {
          customFetch: customFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow(TelegramBotNotMemberError);
    });
  });

  describe('checkGroupPrivacyMode', () => {
    it('returns true when can_read_all_group_messages is true (Privacy Mode disabled)', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: 'District Bot',
            can_read_all_group_messages: true,
          },
        }),
      } as unknown as Response);

      const isPrivacyDisabled = await checkGroupPrivacyMode(token, {
        customFetch: customFetch as unknown as typeof fetch,
      });
      expect(isPrivacyDisabled).toBe(true);
    });

    it('returns false when can_read_all_group_messages is false or omitted (Privacy Mode active)', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: 'District Bot',
            can_read_all_group_messages: false,
          },
        }),
      } as unknown as Response);

      const isPrivacyDisabled = await checkGroupPrivacyMode(token, {
        customFetch: customFetch as unknown as typeof fetch,
      });
      expect(isPrivacyDisabled).toBe(false);
    });
  });
});
