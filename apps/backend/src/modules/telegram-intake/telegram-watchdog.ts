import type pg from 'pg';
import { decryptToken } from '../../adapters/crypto/token-cipher.js';
import { deriveWebhookSecret } from './webhook-security.js';

export interface WebhookInfoResult {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export interface WatchdogEvaluation {
  shouldHeal: boolean;
  reason: string | null;
}

/**
 * Evaluates whether Telegram webhook info indicates a stalled queue,
 * backoff lock, or misconfigured IP address override.
 */
export function evaluateWebhookHealth(
  expectedUrl: string,
  info: WebhookInfoResult,
): WatchdogEvaluation {
  if (!info.url || info.url !== expectedUrl) {
    return {
      shouldHeal: true,
      reason: `URL mismatch (actual: "${info.url}", expected: "${expectedUrl}")`,
    };
  }


  // Pending updates trapped behind a Telegram retry backoff
  if (info.pending_update_count > 0 && info.last_error_date && info.last_error_date > 0) {
    return {
      shouldHeal: true,
      reason: `Stalled queue detected: ${info.pending_update_count} pending updates, last error: "${info.last_error_message || 'unknown'}"`,
    };
  }

  return {
    shouldHeal: false,
    reason: null,
  };
}

export interface TelegramWatchdogDependencies {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Checks all active district Telegram bots and self-heals any stalled webhooks.
 */
export async function checkAndHealTelegramWebhooks(
  pool: pg.Pool,
  deps: TelegramWatchdogDependencies,
): Promise<{ checkedCount: number; healedCount: number }> {
  const fetchFn = deps.fetchImpl || fetch;
  const baseUrl = deps.baseUrl || process.env.APP_BASE_URL || 'https://mahalla-ovozi.uz';
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  const res = await pool.query(
    `SELECT bot_id, encrypted_token, token_iv, token_tag
     FROM district_telegram_bots
     WHERE status = 'VALID'`,
  );

  let checkedCount = 0;
  let healedCount = 0;

  for (const row of res.rows) {
    checkedCount += 1;
    const botId = row.bot_id as string;
    const expectedUrl = `${cleanBaseUrl}/api/v1/webhooks/telegram/${botId}`;

    let token: string;
    try {
      token = decryptToken({
        encryptedToken: row.encrypted_token,
        tokenIv: row.token_iv,
        tokenTag: row.token_tag,
      });
    } catch (err: unknown) {
      console.error('[watchdog:telegram] Failed to decrypt bot token', {
        botId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    try {
      const infoRes = await fetchFn(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!infoRes.ok) {
        console.warn('[watchdog:telegram] getWebhookInfo HTTP error', {
          botId,
          statusCode: infoRes.status,
        });
        continue;
      }

      const infoJson = (await infoRes.json()) as { ok: boolean; result?: WebhookInfoResult };
      if (!infoJson.ok || !infoJson.result) {
        continue;
      }

      const evalResult = evaluateWebhookHealth(expectedUrl, infoJson.result);
      if (!evalResult.shouldHeal) {
        continue;
      }

      console.warn('[watchdog:telegram] Self-healing webhook registration', {
        botId,
        expectedUrl,
        reason: evalResult.reason,
      });

      // Clear any previous IP override or retry backoff state without dropping citizen updates
      await fetchFn(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
        signal: AbortSignal.timeout(10000),
      });

      const secretToken = deriveWebhookSecret(botId);
      const setRes = await fetchFn(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: expectedUrl,
          secret_token: secretToken,
          allowed_updates: ['message', 'edited_message'],
          max_connections: 100,
          drop_pending_updates: false,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const setJson = (await setRes.json()) as { ok: boolean; description?: string };
      if (setJson.ok) {
        healedCount += 1;
        console.log('[watchdog:telegram] Webhook successfully healed', { botId });
      } else {
        console.error('[watchdog:telegram] Failed to self-heal webhook', {
          botId,
          description: setJson.description,
        });
      }
    } catch (err: unknown) {
      console.error('[watchdog:telegram] Watchdog poll error', {
        botId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checkedCount, healedCount };
}
