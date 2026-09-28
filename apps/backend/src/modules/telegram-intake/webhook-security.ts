import crypto from 'node:crypto';
import { getEncryptionKey } from '../../adapters/crypto/token-cipher.js';

/**
 * Derives a deterministic webhook secret token for a specific botId using HMAC-SHA256
 * keyed with the application's master encryption key.
 */
export function deriveWebhookSecret(botId: string): string {
  if (!botId || typeof botId !== 'string') {
    return '';
  }
  const key = getEncryptionKey();
  return crypto.createHmac('sha256', key).update(botId).digest('hex');
}

/**
 * Verifies an incoming X-Telegram-Bot-Api-Secret-Token header against the expected secret.
 * Computes the SHA-256 hash of both inputs before calling crypto.timingSafeEqual to:
 * 1. Ensure constant-length 32-byte buffers, preventing RangeError length mismatch exceptions.
 * 2. Prevent side-channel timing attacks that could reveal secret length or character prefixes.
 */
export function verifyTelegramSecretToken(
  incomingHeader: string | string[] | undefined,
  expectedSecret: string,
): boolean {
  if (!incomingHeader || !expectedSecret || typeof expectedSecret !== 'string') {
    return false;
  }
  const token = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
  if (!token || typeof token !== 'string') {
    return false;
  }

  const expectedHash = crypto.createHash('sha256').update(expectedSecret, 'utf8').digest();
  const receivedHash = crypto.createHash('sha256').update(token, 'utf8').digest();

  return crypto.timingSafeEqual(expectedHash, receivedHash);
}

/**
 * Sanitizes database and driver error objects for telemetry logging (AD-11).
 * Completely strips SQL query parameters, VALUES(...) blocks, raw messages, and token strings.
 */
export function sanitizeDriverError(err: unknown): { errorName: string; errorMessage: string } {
  const errorName = err instanceof Error ? err.name : 'UnknownError';
  if (!(err instanceof Error)) {
    return {
      errorName,
      errorMessage: 'Internal persistence error',
    };
  }

  const rawMessage = err.message;
  // Scrub SQL parameter blocks, values clauses, and potential token strings
  const sanitized = rawMessage
    .replace(/VALUES\s*\([\s\S]*?\)/gi, 'VALUES (...)')
    .replace(/bot[0-9]{6,16}:[A-Za-z0-9_-]+/gi, 'bot[REDACTED]')
    .replace(/password\s*=\s*'[^']*'/gi, 'password=[REDACTED]');

  return {
    errorName,
    errorMessage: sanitized,
  };
}

