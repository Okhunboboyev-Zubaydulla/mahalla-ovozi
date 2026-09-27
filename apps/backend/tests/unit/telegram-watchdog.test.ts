import { describe, it, expect, vi } from 'vitest';
import {
  evaluateWebhookHealth,
  checkAndHealTelegramWebhooks,
  WebhookInfoResult,
} from '../../src/modules/telegram-intake/telegram-watchdog.js';
import type pg from 'pg';

describe('telegram-watchdog unit tests', () => {
  const expectedUrl = 'https://mahalla-ovozi.uz/api/v1/webhooks/telegram/8293431272';

  describe('evaluateWebhookHealth', () => {
    it('returns shouldHeal=false for a completely healthy webhook', () => {
      const healthyInfo: WebhookInfoResult = {
        url: expectedUrl,
        has_custom_certificate: false,
        pending_update_count: 0,
        max_connections: 100,
      };

      const result = evaluateWebhookHealth(expectedUrl, healthyInfo);
      expect(result.shouldHeal).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('returns shouldHeal=true if url does not match expected', () => {
      const mismatchedInfo: WebhookInfoResult = {
        url: 'https://old-domain.com/webhook',
        has_custom_certificate: false,
        pending_update_count: 0,
      };

      const result = evaluateWebhookHealth(expectedUrl, mismatchedInfo);
      expect(result.shouldHeal).toBe(true);
      expect(result.reason).toContain('URL mismatch');
    });

    it('returns shouldHeal=false when getWebhookInfo reports resolved ip_address', () => {
      const ipInfo: WebhookInfoResult = {
        url: expectedUrl,
        has_custom_certificate: false,
        pending_update_count: 0,
        ip_address: '95.182.118.3',
      };

      const result = evaluateWebhookHealth(expectedUrl, ipInfo);
      expect(result.shouldHeal).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('returns shouldHeal=true if updates are pending with last_error_date (stalled retry backoff)', () => {
      const stalledInfo: WebhookInfoResult = {
        url: expectedUrl,
        has_custom_certificate: false,
        pending_update_count: 3,
        last_error_date: 1773238600,
        last_error_message: 'SSL error {error:0A0000C6:SSL routines::packet length too long}',
      };

      const result = evaluateWebhookHealth(expectedUrl, stalledInfo);
      expect(result.shouldHeal).toBe(true);
      expect(result.reason).toContain('Stalled queue detected: 3 pending updates');
    });
  });

  describe('checkAndHealTelegramWebhooks', () => {
    it('re-registers webhook with correct domain payload when stalled queue is detected', async () => {
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              bot_id: '8293431272',
              // Valid mock encrypted token components
              encrypted_token: '0123456789abcdef',
              token_iv: '0123456789abcdef01234567',
              token_tag: '0123456789abcdef0123456789abcdef',
            },
          ],
        }),
      } as unknown as pg.Pool;

      // Mock decryptToken behavior
      vi.mock('../../src/adapters/crypto/token-cipher.js', () => ({
        decryptToken: vi.fn().mockReturnValue('mock-token-12345'),
        getEncryptionKey: vi.fn().mockReturnValue(Buffer.alloc(32, 'a')),
      }));

      const mockFetch = vi.fn()
        // 1. getWebhookInfo returns stalled state
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              url: expectedUrl,
              has_custom_certificate: false,
              pending_update_count: 5,
              last_error_date: 1773238600,
              last_error_message: 'Connection reset by peer',
            },
          }),
        })
        // 2. deleteWebhook call returns ok
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        })
        // 3. setWebhook call returns ok
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        });

      const outcome = await checkAndHealTelegramWebhooks(mockPool, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        baseUrl: 'https://mahalla-ovozi.uz',
      });

      expect(outcome.checkedCount).toBe(1);
      expect(outcome.healedCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Verify deleteWebhook call
      const delCall = mockFetch.mock.calls[1];
      expect(delCall).toBeDefined();
      expect(String(delCall?.[0])).toContain('deleteWebhook?drop_pending_updates=false');

      // Verify setWebhook payload does NOT have ip_address and drop_pending_updates is false
      const setCall = mockFetch.mock.calls[2];
      expect(setCall).toBeDefined();
      const setCallBody = JSON.parse(String((setCall?.[1] as { body?: unknown })?.body ?? '{}'));
      expect(setCallBody.url).toBe(expectedUrl);
      expect(setCallBody.ip_address).toBeUndefined();
      expect(setCallBody.drop_pending_updates).toBe(false);
      expect(setCallBody.max_connections).toBe(100);
    });
  });
});
